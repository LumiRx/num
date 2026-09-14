// The release path, checked in source.
//
// Two things went wrong this week that this file exists to stop repeating:
//
//   1. Migration 0022 was written, registered, and never applied — while the
//      code that needed it went live. Every write that touched the missing
//      column vanished into a .catch().
//   2. The app worker was deployed with a raw `wrangler deploy`, which skips
//      release.mjs entirely: no tests, no version stamp, no staged preview, no
//      rollback point. Production answered /api/version with "unknown"
//      afterwards — it could not say what it was running.
//
// Neither is caught by a test of the product. Both are caught here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const REL = read('scripts/release.mjs');
const PKG = JSON.parse(read('package.json'));

test('stage applies pending migrations, and does it after the tests', () => {
  assert.match(REL, /function applyPendingMigrations\(\)/);
  assert.match(REL, /applyPendingMigrations\(\);/);
  const tests = REL.indexOf("sh('npm test')");
  const schema = REL.indexOf('applyPendingMigrations();');
  const upload = REL.indexOf('versions upload');
  assert.ok(tests > 0 && schema > tests, 'schema must land only after the tests pass');
  assert.ok(upload > schema, 'schema must land before anything is uploaded');
});

test('a migration that will not apply stops the release before it uploads', () => {
  const fn = REL.slice(REL.indexOf('function applyPendingMigrations'), REL.indexOf('const gitSha'));
  assert.match(fn, /process\.exit\(1\)/, 'a still-pending migration has to be fatal');
  assert.doesNotMatch(fn, /catch\s*\{\s*\}/, 'a swallowed failure here is the bug this guards');
});

test('the app worker has a named way to ship that is not raw wrangler', () => {
  const s = PKG.scripts;
  assert.equal(s.ship, 'node scripts/release.mjs stage');
  assert.equal(s['ship:live'], 'node scripts/release.mjs ship');
  assert.equal(s['ship:back'], 'node scripts/release.mjs rollback');
  // Anything shipping wrangler.app.jsonc directly bypasses the version stamp,
  // the staged preview and the rollback point.
  const raw = Object.entries(s).filter(([, v]) => /wrangler deploy.*wrangler\.app\.jsonc/.test(v));
  assert.deepEqual(raw, [], 'the app worker must go through release.mjs');
});

test('every registered migration is in exactly one list', () => {
  const m = JSON.parse(read('worker/migrations/APPLIED.json'));
  const both = Object.keys(m.sealed).filter((f) => (m.pending ?? []).includes(f));
  assert.deepEqual(both, [], 'a migration cannot be both sealed and pending');
});
