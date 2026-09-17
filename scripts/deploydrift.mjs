/**
 * NUM · which workers are running code older than the repo.
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * 15 Sep 2026. A guest asked for dinner in Hollywood and Num said "Hollywood
 * is a blank for me" while 3,082 Hollywood places sat in the directory. The
 * cause was one condition in `ai/places.js`. It was fixed, tested, and
 * deployed — to num-ai.
 *
 * `ai/places.js` is SHARED SOURCE, NOT A SHARED SERVICE. Every worker that
 * imports it compiles its OWN COPY at build time. num-app — the brain behind
 * the phone app, which is where the bug was reported — bundles the same file
 * and was never redeployed. So the fix was live on the texting side and absent
 * on the app side, and nothing anywhere failed: no error, no alarm, no red
 * test. Half the traffic simply kept running the old code.
 *
 * That is the whole category this file closes. It is the quietest kind of
 * outage there is, because every signal you would normally trust says success.
 *
 * ── WHY CONTENT HASHES AND NOT GIT ───────────────────────────────────────
 *
 * Two reasons, and the second is the real one.
 *
 * Git is not reachable from the mounted worktree these sessions run in, so a
 * `git diff` approach would simply not run here. But even with git available
 * this would be the better instrument: git tells you a COMMIT moved, and what
 * actually matters is whether the BYTES a worker bundles are the bytes it last
 * shipped. A commit that only touched a README is not drift. A file edited,
 * shipped, and reverted is not drift either, and a commit count would call
 * both of them drift and train everyone to ignore the warning.
 *
 * ── THE LEDGER IS PER-MACHINE, AND THAT IS DELIBERATE ─────────────────────
 *
 * `.deploy-shipped.json` records what THIS machine last pushed, exactly like
 * `.release-staged.json` next to it. It is git-ignored. Committing it would
 * make one developer's deploy look like everyone's, which is a worse lie than
 * the one this file is here to stop.
 *
 * A worker with no ledger entry is reported as UNKNOWN, never as clean. "We
 * have no idea" and "it is up to date" must never render the same.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, normalize, relative } from 'node:path';

const LEDGER = '.deploy-shipped.json';

/**
 * Every worker that ships CODE, and the command that ships it.
 *
 * num-console was assets-only until 17 Sep 2026, when `worker/site.mjs`
 * gave it a `main` (the site in nine languages). It is a code worker now, so
 * it is in the map like the other eight.
 */
export const WORKERS = Object.freeze({
  'num-console': { config: 'wrangler.jsonc', main: 'worker/site.mjs', ship: 'npx wrangler deploy --config wrangler.jsonc' },
  'num-app': { config: 'wrangler.app.jsonc', main: 'worker/index.mjs', ship: 'npm run release:stage "<what changed>" && npm run release:ship' },
  'num-growth': { config: 'growth/wrangler.jsonc', main: 'growth/worker.js', ship: 'npx wrangler deploy --config growth/wrangler.jsonc' },
  'num-ai': { config: 'ai/wrangler.jsonc', main: 'ai/worker.js', ship: 'npx wrangler deploy --config ai/wrangler.jsonc' },
  'num-accounts': { config: 'accounts/wrangler.jsonc', main: 'accounts/worker.js', ship: 'npx wrangler deploy --config accounts/wrangler.jsonc' },
  'num-payouts': { config: 'payouts/wrangler.jsonc', main: 'payouts/index.mjs', ship: 'npx wrangler deploy --config payouts/wrangler.jsonc' },
  'num-claim': { config: 'claim/wrangler.jsonc', main: 'claim/worker.js', ship: 'npx wrangler deploy --config claim/wrangler.jsonc' },
  'num-agents': { config: 'agents/wrangler.jsonc', main: 'agents/worker.js', ship: 'npx wrangler deploy --config agents/wrangler.jsonc' },
  'num-scout': { config: 'scout/wrangler.jsonc', main: 'scout/worker.js', ship: 'npx wrangler deploy --config scout/wrangler.jsonc' },
});

/**
 * Both import forms, because the one that caused the outage is the second.
 *
 * `worker/index.mjs` reaches most of its routes through `await import('./x')`
 * rather than a top-level import — lazily, so a cold start does not parse the
 * whole worker. A static-only scan would have declared num-app's bundle to be
 * about six files and missed `ai/places.js` entirely, which is to say it would
 * have missed the exact drift it was written to catch.
 */
const STATIC = /(?:^|[\s;}])(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]/g;
const DYNAMIC = /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

const EXTS = ['', '.mjs', '.js', '.ts', '/index.mjs', '/index.js'];

function resolveLocal(fromFile, spec) {
  const base = join(dirname(fromFile), spec);
  for (const ext of EXTS) {
    const p = normalize(base + ext);
    try { if (statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

/**
 * Every local file a worker compiles into its bundle, entry included.
 *
 * Test files are excluded — they are never bundled, and letting an edited test
 * report a worker as drifted would cry wolf on every run and make the warning
 * worthless. That is the failure mode of every drift detector: not missing
 * things, but flagging so much that people stop reading it.
 */
export function bundleFiles(entry, seen = new Set()) {
  if (!entry || seen.has(entry) || !existsSync(entry)) return seen;
  if (/\.test\.(mjs|js|ts)$/.test(entry)) return seen;
  seen.add(entry);
  let src = '';
  try { src = readFileSync(entry, 'utf8'); } catch { return seen; }
  for (const re of [STATIC, DYNAMIC]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const next = resolveLocal(entry, m[1]);
      if (next) bundleFiles(next, seen);
    }
  }
  return seen;
}

/** One hash over the exact bytes a worker would ship. Order-stable. */
export function digestOf(entry) {
  const files = [...bundleFiles(entry)].sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return { digest: h.digest('hex').slice(0, 16), files };
}

/** Per-file hashes, so a drift report can NAME what changed rather than say "something". */
export function fileHashes(files) {
  const out = {};
  for (const f of files) {
    try { out[f] = createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 12); } catch { /* gone */ }
  }
  return out;
}

export const readLedger = () => {
  try { return JSON.parse(readFileSync(LEDGER, 'utf8')); } catch { return {}; }
};
const writeLedger = (l) => writeFileSync(LEDGER, JSON.stringify(l, null, 2) + '\n');

/** Stamp a worker as shipped at its current contents. */
export function record(name, { now = new Date() } = {}) {
  const w = WORKERS[name];
  if (!w) throw new Error(`unknown worker: ${name}`);
  const { digest, files } = digestOf(w.main);
  const ledger = readLedger();
  ledger[name] = { digest, at: now.toISOString(), files: fileHashes(files) };
  writeLedger(ledger);
  return { name, digest, count: files.length };
}

/**
 * What is out of date, and because of which files.
 *
 * `changed` is the point. "num-app has drifted" gets skimmed past; "num-app is
 * running an older ai/places.js" is a sentence somebody acts on.
 */
export function check({ only = null } = {}) {
  const ledger = readLedger();
  const report = [];
  for (const [name, w] of Object.entries(WORKERS)) {
    if (only && !only.includes(name)) continue;
    if (!existsSync(w.main)) continue;
    const { digest, files } = digestOf(w.main);
    const prev = ledger[name];
    if (!prev) { report.push({ name, state: 'unknown', ship: w.ship }); continue; }
    if (prev.digest === digest) { report.push({ name, state: 'current', at: prev.at }); continue; }
    const now = fileHashes(files);
    const changed = [
      ...Object.keys(now).filter((f) => prev.files?.[f] !== now[f]),
      ...Object.keys(prev.files || {}).filter((f) => !(f in now)),
    ].sort();
    report.push({ name, state: 'stale', at: prev.at, changed, ship: w.ship });
  }
  return report;
}

/**
 * The line printed after a deploy: who ELSE now needs one.
 *
 * Returns null when nothing is stale, so a caller can stay silent. A guard that
 * prints something reassuring after every single deploy teaches people to scroll
 * past it, and then it is not a guard.
 */
export function siblingWarning(justShipped = null) {
  const stale = check().filter((r) => r.state === 'stale' && r.name !== justShipped);
  if (!stale.length) return null;
  const lines = [
    '',
    '⚠  OTHER WORKERS ARE NOW BEHIND THE REPO.',
    '   Shared files are compiled into each worker separately, so a fix is not',
    '   live anywhere until every worker that bundles it has shipped.',
    '',
  ];
  for (const s of stale) {
    lines.push(`   ${s.name} — last shipped ${s.at ? s.at.slice(0, 16).replace('T', ' ') : 'unknown'}`);
    for (const f of s.changed.slice(0, 6)) lines.push(`     · ${f}`);
    if (s.changed.length > 6) lines.push(`     · …and ${s.changed.length - 6} more`);
    lines.push(`     ${s.ship}`);
    lines.push('');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ cli */

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'record') {
    if (!arg) { console.error('usage: node scripts/deploydrift.mjs record <worker>'); process.exit(1); }
    const r = record(arg);
    console.log(`recorded ${r.name} @ ${r.digest} (${r.count} files)`);
  } else if (cmd === 'files') {
    const w = WORKERS[arg];
    if (!w) { console.error(`unknown worker: ${arg}`); process.exit(1); }
    console.log([...bundleFiles(w.main)].sort().join('\n'));
  } else {
    const report = check();
    const stale = report.filter((r) => r.state === 'stale');
    const unknown = report.filter((r) => r.state === 'unknown');
    for (const r of report) {
      if (r.state === 'current') console.log(`  ✓ ${r.name.padEnd(13)} up to date  (${r.at.slice(0, 16).replace('T', ' ')})`);
      else if (r.state === 'unknown') console.log(`  ? ${r.name.padEnd(13)} never recorded from this machine`);
      else console.log(`  ✘ ${r.name.padEnd(13)} STALE — ${r.changed.length} file${r.changed.length === 1 ? '' : 's'} changed since it shipped`);
    }
    if (stale.length) {
      console.log(siblingWarning(null));
      // Non-zero so this can gate a script. Deliberately NOT non-zero for
      // 'unknown': a fresh clone has no ledger, and failing there would mean
      // the first thing a new machine does is hit a wall it cannot clear.
      process.exit(1);
    }
    if (unknown.length) console.log('\n  Record a worker after you deploy it:  node scripts/deploydrift.mjs record <worker>\n');
  }
}
