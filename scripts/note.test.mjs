// A COMMAND NOBODY CAN RUN IS WORSE THAN NO COMMAND.
//
// scripts/note.mjs shipped without a test and its argument parsing was broken
// on the ordinary call. `argv.indexOf('--who')` is -1 when the flag is absent,
// and the filter excluded index `whoFlag + 1` — which is 0. A message passed
// as one quoted argument IS index 0, so every normal invocation dropped the
// whole message and printed the usage text instead.
//
// That matters more than a broken helper usually would: CLAUDE.md now tells
// every session to run this after each commit. A convention that silently
// does nothing is worse than an absent one, because the next session reads
// RUNS.log, sees no entry, and concludes nothing happened.
//
// These drive the real CLI as a subprocess, because what failed was the CLI,
// not a function. NOTE_LOG points it at a scratch file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'note.mjs');
let dir; let LOG;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'note-'));
  LOG = join(dir, 'RUNS.log');
});
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } });

/** Run the CLI exactly as a session would, and hand back stdout + the log. */
function run(args, { seed = 'existing line\n' } = {}) {
  writeFileSync(LOG, seed);
  let stdout = ''; let failed = false;
  try {
    stdout = execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf8', env: { ...process.env, NOTE_LOG: LOG },
    });
  } catch (e) {
    failed = true;
    stdout = String(e.stdout ?? '') + String(e.stderr ?? '');
  }
  return { stdout, failed, log: readFileSync(LOG, 'utf8') };
}

test('a message as one quoted argument is written — the bug this file exists for', () => {
  const msg = 'price facts corrected; location ceiling enforced';
  const { failed, log } = run([msg]);
  assert.equal(failed, false, 'the ordinary call must not exit non-zero');
  assert.ok(log.includes(msg), `the message never reached RUNS.log:\n${log}`);
});

test('several bare words are joined rather than dropped', () => {
  const { log } = run(['fixed', 'the', 'thing']);
  assert.ok(log.includes('fixed the thing'), log);
});

test('--who is honoured and does not eat the message', () => {
  const { log } = run(['--who', 'some-session', 'a real message']);
  assert.ok(log.includes('a real message'), 'message lost alongside --who');
  assert.ok(log.includes('some-session'), 'the name was not recorded');
});

test('--who after the message works too', () => {
  const { log } = run(['a real message', '--who', 'other-session']);
  assert.ok(log.includes('a real message'));
  assert.ok(log.includes('other-session'));
  assert.doesNotMatch(log, /--who/, 'the flag itself must not land in the log');
});

test('an empty call explains itself and writes nothing', () => {
  const { failed, stdout, log } = run([]);
  assert.equal(failed, true, 'an empty note should exit non-zero');
  assert.match(stdout, /Say what changed/);
  assert.equal(log, 'existing line\n', 'nothing should have been appended');
});

test('the existing log is appended to, never replaced', () => {
  const { log } = run(['second entry']);
  assert.ok(log.startsWith('existing line\n'), 'the ledger was overwritten');
  assert.ok(log.includes('second entry'));
});

test('a log not ending in a newline still gets its own line', () => {
  const { log } = run(['after a truncated line'], { seed: 'no trailing newline' });
  const lines = log.split('\n').filter(Boolean);
  assert.equal(lines.length, 2, `entries ran together:\n${log}`);
  assert.equal(lines[0], 'no trailing newline');
});

test('the line carries a timestamp and a commit, so it can be read against git', () => {
  const { log } = run(['something']);
  const line = log.split('\n').filter(Boolean).pop();
  assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s/, `no leading timestamp: ${line}`);
  assert.match(line, /\s[0-9a-f]{7,}\s/, `no commit sha: ${line}`);
});
