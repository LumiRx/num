// The release tool must not be able to roll production backwards by accident.
//
// ── WHAT HAPPENED, 2 SEPTEMBER 2026 ──────────────────────────────────────
//
// `stage` writes `.release-staged.json` only on a SUCCESSFUL upload, and never
// clears it. Two stages failed before that line. The file kept pointing at
// 0.8.229 from 31 August while package.json — bumped at the TOP of stage,
// before anything could fail — had climbed to 0.8.231.
//
// `ship` read the stale file and asked Cloudflare to put the August version on
// 100% of traffic. That is a rollback of a week of live work: the chain
// booking engines, commission attribution, the verified-number lockout fix.
//
// It was stopped by luck, not by design. Cloudflare happened to notice that a
// secret (MAIL_CF_FROM) had changed since that version was last active and
// refused — and the message it prints helpfully suggests `?force=true`, which
// would have completed the rollback.
//
// Two invariants, both asserted on the source because the alternative is
// deploying to Cloudflare from a test:
//   1. ship refuses when the staged version is not the current version
//   2. the version bump happens AFTER the tests, so a failed stage does not
//      move the number the guard depends on
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Comments stripped: a regex that matches the prose explaining a rule rather
 *  than the code enforcing it has passed on broken code here before. */
const src = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');

const shipCase = src.slice(src.indexOf("case 'ship'"), src.indexOf("case 'rollback'") + 1 || undefined);
const stageCase = src.slice(src.indexOf("case 'stage'"), src.indexOf("case 'ship'"));

/* ── 1 · ship cannot deploy a stale upload ──────────────────────────────── */

test('ship compares the staged version against package.json', () => {
  assert.ok(
    /staged\.version\s*!==\s*pkg\.version/.test(shipCase),
    'ship does not check that the staged upload IS the current version — '
    + 'a failed stage leaves a stale id and shipping it rolls production back',
  );
});

test('the mismatch exits non-zero rather than warning', () => {
  const guard = shipCase.slice(shipCase.indexOf('staged.version !== pkg.version'));
  const stop = guard.indexOf('process.exit(1)');
  const deploy = guard.indexOf('versions deploy');
  assert.ok(stop > 0, 'the version mismatch does not stop the release');
  assert.ok(stop < deploy || deploy === -1,
    'the deploy runs even when the staged version does not match');
});

test('the guard fires before wrangler is called at all', () => {
  // Catching this downstream is what "a secret has changed" was — a real
  // guard, but one that only exists by luck and whose own error message
  // recommends the destructive way out.
  const check = shipCase.indexOf('staged.version !== pkg.version');
  const deploy = shipCase.indexOf('versions deploy');
  assert.ok(check > 0 && deploy > 0 && check < deploy,
    'the staleness check runs after the deploy command is issued');
});

test('the operator is told what shipping it would actually do', () => {
  const guard = shipCase.slice(shipCase.indexOf('staged.version !== pkg.version'));
  assert.match(guard, /ROLL PRODUCTION BACK/,
    'the error does not say that shipping a stale version is a rollback');
  assert.match(guard, /force/i,
    'the error does not warn against the --force that wrangler will suggest');
});

/* ── 2 · a failed stage must not move the version ───────────────────────── */

test('stage runs the tests before it bumps the version', () => {
  const tests = stageCase.indexOf("sh('npm test')");
  const bumped = stageCase.indexOf('bump(');
  assert.ok(tests > 0 && bumped > 0, 'stage no longer both tests and bumps');
  assert.ok(
    tests < bumped,
    'the version is bumped before the tests run, so every failed stage moves '
    + 'package.json with nothing released — which is what made the two files '
    + 'disagree in the first place',
  );
});

test('the build still runs after the bump, so the version is stamped in', () => {
  // The bump must not simply move to the end: the build reads
  // VITE_NUM_VERSION, and a build that stamps the previous version is how
  // /api/version starts lying.
  const bumped = stageCase.indexOf('bump(');
  const env = stageCase.indexOf('VITE_NUM_VERSION');
  const build = stageCase.indexOf("sh('npm run build')");
  assert.ok(bumped < env && env < build,
    'the build no longer receives the freshly bumped version');
});

test('the staged record is only written after a successful upload', () => {
  // The whole reason a stale file is possible. Keep it that way — writing it
  // earlier would mean shipping something that was never uploaded — and rely
  // on the version guard above instead.
  const upload = stageCase.indexOf('versions upload');
  const write = stageCase.indexOf('writeFileSync(STAGED');
  assert.ok(upload > 0 && write > upload,
    'the staged record is written before the upload has succeeded');
});

/* ── 3 · a release is always recoverable ────────────────────────────────────
 *
 * ── WHAT HAPPENED, 7 SEPTEMBER 2026 ──────────────────────────────────────
 *
 * `stage` printed "Working tree has uncommitted changes — staging them anyway"
 * and deployed regardless. A warning that never blocks is a warning nobody
 * reads: 163 files and ~18,000 lines had gone live unrecorded, and under the
 * noise a stale git lock from 4 August had been failing every write for a
 * month without anyone noticing. Every version shipped in that window was a
 * version production could not be returned to.
 *
 * Committing is now part of releasing. These pin the ordering that makes it
 * trustworthy, because a commit taken at the wrong moment is worse than none:
 * it records something that was never tested, or a version that never shipped.
 */

test('stage commits only after the tests have passed', () => {
  const test_ = stageCase.indexOf("sh('npm test')");
  const commit = stageCase.indexOf('commitWork(');
  assert.ok(test_ !== -1, 'stage must still run the tests');
  assert.ok(commit !== -1, 'stage must commit the working tree');
  assert.ok(
    test_ < commit,
    'commitWork must run AFTER npm test — otherwise a failing tree gets committed',
  );
});

test('stage commits before the version bump, so the changelog names the work', () => {
  const commit = stageCase.indexOf('commitWork(');
  const bumped = stageCase.indexOf('bump(process.env.BUMP');
  assert.ok(bumped !== -1, 'stage must still bump the version');
  assert.ok(
    commit < bumped,
    'commitWork must run BEFORE bump — the changelog records gitSha() and it must point at the work',
  );
});

test('stage no longer warns-and-continues on an uncommitted tree', () => {
  assert.ok(
    !/staging them anyway/i.test(src),
    'the warn-and-continue path is what let unrecorded versions ship; it must not come back',
  );
});

test('ship commits the release metadata only after production is verified', () => {
  const verified = shipCase.indexOf('verified: production is serving');
  const commit = shipCase.indexOf('commitRelease(');
  assert.ok(commit !== -1, 'ship must commit the bump and changelog');
  assert.ok(
    verified !== -1 && verified < commit,
    'commitRelease must run AFTER the serving check — a version that never shipped must not be recorded as released',
  );
});

test('auto-commit refuses to sweep up anything that looks like a secret', () => {
  assert.ok(/const RISKY =/.test(src), 'the secret guard must exist');
  const risky = /const RISKY =\s*([\s\S]*?);\n/.exec(src)?.[1] ?? '';
  const rx = new RegExp(
    risky.replace(/^\s*\/|\/i\s*$/g, ''),
    'i',
  );
  for (const path of [
    '.env',
    '.env.production',
    '.dev.vars',
    'ios/App/dist.mobileprovision',
    'certs/private.pem',
    'keys/server.key',
    'config/client_secret.json',
    'home/.ssh/id_rsa',
  ]) {
    assert.ok(rx.test(path), `${path} must be caught by the secret guard`);
  }
  for (const path of ['worker/index.mjs', 'src/lib/social.ts', 'package.json', 'CHANGELOG.md']) {
    assert.ok(!rx.test(path), `${path} is ordinary source and must not trip the guard`);
  }
});

test('there is an escape hatch for a deliberate uncommitted deploy', () => {
  assert.ok(
    /NO_AUTOCOMMIT/.test(src),
    'a guard with no override gets worked around in worse ways',
  );
});
