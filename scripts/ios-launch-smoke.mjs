#!/usr/bin/env node
/**
 * How many times does the page load? It should be exactly once.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * iOS 1.0 (6) was rejected on 12 Sep 2026 under guideline 2.1.0 — "the app
 * crashed after the initial launch". It did not crash. The auto-updater ran in
 * the App Store build, compared the version frozen inside the IPA against
 * whatever the Worker was serving, found a difference it could never resolve,
 * and called location.reload() two and a half seconds in. A blank screen and a
 * re-render is indistinguishable from a crash, to a reviewer and to Apple's
 * automated pre-check alike.
 *
 * Every human check passed it: it worked in a browser, it worked in the
 * simulator against a dev server, it built, signed, validated and uploaded
 * without a warning. It was "verified" with a single screenshot taken eight
 * seconds after launch — by which time the reload had long finished.
 *
 * ── WHY IT COUNTS LOADS AND NOT PIXELS ─────────────────────────────────────
 *
 * The first version of this script sampled screenshots and looked for the
 * screen going blank. Two measurements killed that approach:
 *
 *   · A simulator screenshot is the whole screen. The iPad HOME screen
 *     compresses to ~3.9 MB; this app's flat UI to ~550 KB. Richer pixels, not
 *     more content — so any absolute threshold judges a healthy app to be blank.
 *
 *   · A screenshot costs about a second on this hardware, and the blank moment
 *     during a reload lasts a few hundred milliseconds. Sampling raced it and
 *     lost: the same rejected build was caught on one run and passed on the
 *     next. A flaky gate is worse than no gate, because people learn to rerun
 *     it until it goes green.
 *
 * WebKit says it plainly instead. Every page commit is logged, and the counts
 * separate the two builds with no ambiguity at all:
 *
 *     1.0 (7) fixed     didCommitLoad = 1
 *     1.0 (6) rejected  didCommitLoad = 2     ← the reload
 *
 * One commit per launch. Anything more is a navigation nobody asked for.
 *
 * Usage:  node scripts/ios-launch-smoke.mjs <path-to-.app> [simulator-udid]
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.argv[2];
const UDID = process.argv[3] || process.env.SMOKE_SIM || 'booted';
const BUNDLE = 'com.itsnum.app';
// Long enough to cover the 2.5s auto-update tick and any late boot work.
const WATCH_MS = 14_000;

if (!APP) {
  console.error('usage: node scripts/ios-launch-smoke.mjs <path-to-.app> [udid]');
  process.exit(2);
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = () => {
  try { return sh('xcrun', ['simctl', 'spawn', UDID, 'launchctl', 'list']).includes(BUNDLE); }
  catch { return false; }
};

const dir = mkdtempSync(join(tmpdir(), 'num-smoke-'));
const logPath = join(dir, 'app.log');
let stream = null;
let failed = null;

try {
  console.log(`── launch smoke: ${APP}`);
  try { sh('xcrun', ['simctl', 'terminate', UDID, BUNDLE]); } catch { /* not running */ }
  try { sh('xcrun', ['simctl', 'uninstall', UDID, BUNDLE]); } catch { /* not installed */ }

  // Start listening BEFORE the app exists, so the very first load is counted.
  writeFileSync(logPath, ''); // exist even if the stream never writes a byte
  // Redirect in a shell rather than piping the child's stdout through Node.
  // `xcrun simctl spawn ... log stream` writes nothing down a piped stdout here
  // — it produces output only to a file or a terminal. Measured both ways on
  // 14 Sep 2026: shell redirection captured 1111 lines, the Node pipe captured
  // zero, and a gate that silently captures nothing passes everything.
  stream = spawn('/bin/sh', ['-c',
    `exec xcrun simctl spawn ${UDID} log stream --style compact ` +
    `--predicate 'processImagePath CONTAINS "App.app"' > ${JSON.stringify(logPath)} 2>&1`,
  ], { stdio: 'ignore', detached: true });
  sleep(2500);

  sh('xcrun', ['simctl', 'install', UDID, APP]);
  sh('xcrun', ['simctl', 'launch', UDID, BUNDLE]);
  if (!alive()) {
    failed = 'the app was not running immediately after launch — it failed to start at all.';
  } else {
    sleep(WATCH_MS);
    const stillUp = alive();
    try { process.kill(-stream.pid, 'SIGTERM'); } catch { stream.kill(); }
    stream = null;
    sleep(600);

    const log = readFileSync(logPath, 'utf8');
    const commits = (log.match(/didCommitLoad/g) ?? []).length;
    const provisional = (log.match(/didStartProvisionalLoad/g) ?? []).length;
    console.log(`   page commits: ${commits} · provisional loads: ${provisional} · still running: ${stillUp}`);

    if (!log.trim()) {
      failed = 'captured no log output at all — the simulator may not be booted. This run proves nothing.';
    } else if (commits === 0) {
      failed = 'the web view never committed a page load. The app launched and showed nothing.';
    } else if (commits > 1) {
      failed =
        `the page loaded ${commits} times in ${WATCH_MS / 1000}s. It should load exactly once.\n` +
        '   Something is navigating or reloading after launch — an auto-updater, a service\n' +
        '   worker serving a stale index.html, or a redirect. A reviewer sees a blank screen\n' +
        '   and a re-render, and Apple reads that as a crash under 2.1.0. This is precisely\n' +
        '   what happened to 1.0 (6).';
    } else if (!stillUp) {
      failed = 'the app stopped running before the end of the window — it crashed.';
    }
  }
} catch (err) {
  failed = `could not run: ${err?.message ?? err}`;
} finally {
  try { if (stream) { try { process.kill(-stream.pid, 'SIGTERM'); } catch { stream.kill(); } } } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n✘ LAUNCH SMOKE FAILED\n   ${failed}\n`);
  process.exit(1);
}
console.log('\n✓ launch smoke passed — one page load, still running.\n');
