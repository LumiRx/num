/**
 * The guard against half-deployed fixes.
 *
 * 15 Sep 2026: `ai/places.js` was fixed and deployed to num-ai. num-app
 * bundles the same file and was not redeployed, so the Hollywood bug stayed
 * live in the phone app while every signal said the fix had shipped. No error,
 * no failing test, no alarm — the quietest kind of outage there is.
 *
 * The first test below is that exact scenario.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKERS, bundleFiles, digestOf, check, record, siblingWarning, readLedger } from './deploydrift.mjs';

/* ── the real repo ─────────────────────────────────────────────────────── */

describe('the real worker map', () => {
  test('every worker in the map has the entry file it claims', () => {
    for (const [name, w] of Object.entries(WORKERS)) {
      assert.ok(existsSync(w.main), `${name}: ${w.main} does not exist`);
      assert.ok(existsSync(w.config), `${name}: ${w.config} does not exist`);
    }
  });

  test('every code worker in the repo is in the map', () => {
    // A worker missing from here is invisible to the guard, which is the same
    // as not having the guard for that worker.
    const configs = ['wrangler.jsonc', 'wrangler.app.jsonc', 'ai/wrangler.jsonc', 'growth/wrangler.jsonc',
      'accounts/wrangler.jsonc', 'payouts/wrangler.jsonc', 'claim/wrangler.jsonc',
      'agents/wrangler.jsonc', 'scout/wrangler.jsonc'];
    const mapped = new Set(Object.values(WORKERS).map((w) => w.config));
    for (const c of configs) {
      const src = readFileSync(c, 'utf8');
      const hasMain = /"main"\s*:/.test(src);
      if (hasMain) assert.ok(mapped.has(c), `${c} ships code but is not in WORKERS`);
    }
  });

  test('num-console ships code since site.mjs, so it is in the map', () => {
    const src = readFileSync('wrangler.jsonc', 'utf8');
    assert.ok(/"main"\s*:/.test(src), 'wrangler.jsonc lost its main; num-console is assets-only again and should leave WORKERS');
    assert.equal(WORKERS['num-console']?.main, 'worker/site.mjs');
  });

  test('THE HOLLYWOOD DRIFT: num-app and num-ai both compile ai/places.js', () => {
    // The two workers that diverged. If this ever stops being true the shared
    // brain has been split, and the fix that caused all this needs re-reading.
    const app = bundleFiles(WORKERS['num-app'].main);
    const ai = bundleFiles(WORKERS['num-ai'].main);
    assert.ok(app.has('ai/places.js'), 'num-app no longer bundles the shared brain');
    assert.ok(ai.has('ai/places.js'), 'num-ai no longer bundles the shared brain');
  });

  test('the walk follows DYNAMIC imports, which is where the shared brain lives', () => {
    // worker/index.mjs reaches most routes through `await import('./x')`. A
    // static-only scan would report a handful of files and miss ai/places.js
    // entirely — that is, it would miss the drift it exists to catch.
    const app = bundleFiles(WORKERS['num-app'].main);
    assert.ok(app.size > 50, `only ${app.size} files — the dynamic-import walk is broken`);
    assert.ok(app.has('worker/grounding.mjs'));
    assert.ok(app.has('worker/prompt.mjs'));
  });

  test('a test file is never counted as part of a bundle', () => {
    // Otherwise every edited test reports a worker as needing a deploy, the
    // warning cries wolf, and people stop reading it — which is how a drift
    // detector dies.
    for (const name of Object.keys(WORKERS)) {
      const files = [...bundleFiles(WORKERS[name].main)];
      const tests = files.filter((f) => /\.test\./.test(f));
      assert.deepEqual(tests, [], `${name} counts test files: ${tests.join(', ')}`);
    }
  });

  test('the ledger is git-ignored — one machine\'s deploy is not everyone\'s', () => {
    assert.match(readFileSync('.gitignore', 'utf8'), /^\.deploy-shipped\.json$/m);
  });

  test('release.mjs records num-app and warns about the others after a ship', () => {
    const src = readFileSync('scripts/release.mjs', 'utf8');
    assert.match(src, /deploydrift\.mjs/);
    assert.match(src, /record\('num-app'\)/);
    assert.match(src, /siblingWarning/);
  });

  test('the sibling deploys record themselves, so the ledger cannot rot', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    assert.match(pkg.scripts['deploy:growth'], /deploydrift\.mjs record num-growth/);
    assert.match(pkg.scripts['deploy:ai'], /deploydrift\.mjs record num-ai/);
    assert.ok(pkg.scripts['deploy:check'], 'no way to ask the question by hand');
  });
});

/* ── the mechanism, on a scratch tree ──────────────────────────────────── */

describe('the mechanism', () => {
  function tree() {
    const dir = mkdtempSync(join(tmpdir(), 'drift-'));
    mkdirSync(join(dir, 'a'));
    mkdirSync(join(dir, 'shared'));
    writeFileSync(join(dir, 'shared', 'brain.mjs'), 'export const v = 1;\n');
    writeFileSync(join(dir, 'a', 'entry.mjs'), "import { v } from '../shared/brain.mjs';\nexport default v;\n");
    writeFileSync(join(dir, 'a', 'lazy.mjs'), "export async function go() { const m = await import('../shared/brain.mjs'); return m.v; }\n");
    return dir;
  }

  test('a static import is followed', () => {
    const d = tree();
    const cwd = process.cwd();
    try {
      process.chdir(d);
      const files = [...bundleFiles('a/entry.mjs')];
      assert.ok(files.includes('shared/brain.mjs'), files.join(','));
    } finally { process.chdir(cwd); rmSync(d, { recursive: true, force: true }); }
  });

  test('a dynamic import is followed too', () => {
    const d = tree();
    const cwd = process.cwd();
    try {
      process.chdir(d);
      const files = [...bundleFiles('a/lazy.mjs')];
      assert.ok(files.includes('shared/brain.mjs'), files.join(','));
    } finally { process.chdir(cwd); rmSync(d, { recursive: true, force: true }); }
  });

  test('the digest changes when a SHARED file changes, not only the entry', () => {
    const d = tree();
    const cwd = process.cwd();
    try {
      process.chdir(d);
      const before = digestOf('a/entry.mjs').digest;
      writeFileSync(join(d, 'shared', 'brain.mjs'), 'export const v = 2;\n');
      assert.notEqual(digestOf('a/entry.mjs').digest, before, 'a shared-file edit was invisible');
    } finally { process.chdir(cwd); rmSync(d, { recursive: true, force: true }); }
  });

  test('a comment-only edit to an UNRELATED file does not move the digest', () => {
    const d = tree();
    const cwd = process.cwd();
    try {
      process.chdir(d);
      const before = digestOf('a/entry.mjs').digest;
      writeFileSync(join(d, 'a', 'lazy.mjs'), '// nothing to do with entry\n');
      assert.equal(digestOf('a/entry.mjs').digest, before, 'flagged a file it does not bundle');
    } finally { process.chdir(cwd); rmSync(d, { recursive: true, force: true }); }
  });

  test('an unrecorded worker reads UNKNOWN, never CURRENT', () => {
    // "We have no idea" and "it is up to date" must never render the same, or
    // a fresh clone looks fully deployed.
    const d = mkdtempSync(join(tmpdir(), 'drift-empty-'));
    const cwd = process.cwd();
    try {
      process.chdir(d);
      const r = check();
      for (const row of r) assert.notEqual(row.state, 'current');
    } finally { process.chdir(cwd); rmSync(d, { recursive: true, force: true }); }
  });

  test('a worker nobody has ever recorded is NAMED after a deploy, not skipped', () => {
    // 19 Sep 2026, the second time this bug happened and the first time it was
    // caught. `ai/places.js` gained the expired-mobile-venue guard, num-app
    // shipped, and the warning listed num-growth and num-console. num-ai —
    // last deployed four days earlier, bundling that same file, serving
    // /api/places to the public — was not mentioned at all, because it had no
    // ledger entry and this function only ever listed 'stale'.
    //
    // Unknown is the WORSE case: for a stale worker we can name the files, for
    // an unknown one we can say nothing. It must not read as silence.
    const d = mkdtempSync(join(tmpdir(), 'drift-unknown-'));
    const cwd = process.cwd();
    try {
      process.chdir(d);
      mkdirSync('worker', { recursive: true });
      mkdirSync('ai', { recursive: true });
      mkdirSync('scout', { recursive: true });
      writeFileSync('ai/places.js', 'export const nearbyPlaces = () => [];\n');
      // num-app and num-ai both compile ai/places.js; num-scout compiles none of it.
      writeFileSync('worker/index.mjs', "import './../ai/places.js';\n");
      writeFileSync('ai/worker.js', "import './places.js';\n");
      writeFileSync('scout/worker.js', 'export default {};\n');

      record('num-app');                       // num-ai is deliberately never recorded
      const warn = siblingWarning('num-app');

      assert.ok(warn, 'a deploy with an unrecorded sibling must say something');
      assert.match(warn, /num-ai/, 'the worker sharing the shipped file has to be named');
      assert.match(warn, /never recorded/i, 'and it must say we do not know what it runs');
      assert.match(warn, /ai\/wrangler\.jsonc/, 'with the command that fixes it');
      assert.doesNotMatch(warn, /num-scout/,
        'a worker that compiles none of the changed code is not this deploy\u2019s problem');
    } finally { process.chdir(cwd); rmSync(d, { recursive: true, force: true }); }
  });

  test('siblingWarning stays silent when nothing is stale', () => {
    const d = mkdtempSync(join(tmpdir(), 'drift-quiet-'));
    const cwd = process.cwd();
    try {
      process.chdir(d);
      assert.equal(siblingWarning('num-app'), null, 'a guard that always prints is not read');
    } finally { process.chdir(cwd); rmSync(d, { recursive: true, force: true }); }
  });
});

// ── EVERY DEPLOY MUST RECORD ─────────────────────────────────────────────
//
// This whole file exists to answer "is the code that is in the repo actually
// running". It answers that from `.deploy-shipped.json`, and a deploy that
// does not write to that ledger is invisible to it.
//
// On 19 Sep 2026 `deploy:site` was the only deploy script with no
// `deploydrift record` on the end. num-console is the worker that ships most
// often — the marketing site — and the drift report had it last shipped at
// 01:37 that morning after a day of deploys, so it was reporting the site
// stale when it was current, and would have reported it current when it was
// stale. A tool that is wrong in both directions is worse than no tool,
// because it trains everyone to ignore the warning it exists to give.
test('every deploy script records what it shipped', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const missing = [];
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    if (!/wrangler\s+deploy/.test(cmd)) continue;
    if (!/deploydrift\.mjs\s+record\s+\S/.test(cmd)) missing.push(name);
  }
  assert.deepEqual(missing, [], `these deploys are invisible to the drift check: ${missing.join(', ')}`);
});
