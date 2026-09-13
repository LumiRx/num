/**
 * A LEFTOVER GIT LOCK COST TWO RELEASES.
 *
 * 9 Sep and 12 Sep 2026, three days apart, the same thing: a killed git
 * process left `index.lock` behind, `git add -A` refused, and because that
 * refusal came out of `execSync` inside `stage` it surfaced as an unhandled
 * Node exception — forty lines of internal frames ending in "Node.js
 * v24.14.0", with the one useful sentence buried in the middle.
 *
 * On the second occasion the whole test suite had already passed. The run was
 * discarded at the final step because of a stale file.
 *
 * These tests pin the three properties of the fix.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8');

describe('the lock is named, not crashed on', () => {
  test('the check exists and runs before anything writes to the index', () => {
    assert.match(SRC, /function refuseOnStaleLock\(\)/);
    const inCommit = SRC.indexOf('function gitCommit');
    const add = SRC.indexOf("sh(paths === null ? 'git add -A'");
    const call = SRC.indexOf('refuseOnStaleLock();', inCommit);
    assert.ok(call > inCommit && call < add, 'it must fire before the git add that would throw');
  });

  test('and before the test suite, so minutes are not thrown away', () => {
    const stage = SRC.indexOf("case 'stage':");
    const check = SRC.indexOf('refuseOnStaleLock();', stage);
    const tests = SRC.indexOf("sh('npm test')", stage);
    assert.ok(check > stage && check < tests,
      'discovering the lock after the suite throws away work for something true before it started');
  });

  test('it prints the exact path and the exact command', () => {
    const i = SRC.indexOf('function refuseOnStaleLock');
    const body = SRC.slice(i, i + 3000);
    assert.match(body, /\$\{lock\}/, 'the operator should not have to work out which file');
    assert.match(body, /rm -f/, 'and should not have to work out the command');
    assert.match(body, /NO_AUTOCOMMIT=1/, 'the escape hatch belongs in the message');
    assert.match(body, /process\.exit\(1\)/, 'it must stop, not warn and continue');
  });
});

describe('what it deliberately does NOT do', () => {
  // CHANGED 12 Sep 2026. This used to assert the lock was NEVER deleted. That
  // rule was protecting something real — the lock also exists when git IS
  // running, and removing it under a live writer corrupts the repository — but
  // applied to every lock it cost three releases, two of them after the tests
  // had already passed.
  //
  // The rule is now narrower, not gone: a lock is cleared only when the FILE
  // ITSELF proves nothing holds it. Both conditions are required, and these
  // tests exist to stop either being relaxed.

  test('a lock with ANY content is never touched, however old', () => {
    // Git writes the new index into index.lock as it works, so bytes mean a
    // writer. This is the case the original rule was protecting.
    const i = SRC.indexOf('function deadLock');
    const body = SRC.slice(i, i + 900);
    assert.match(body, /st\.size !== 0/, 'the emptiness check is gone — any lock could now be deleted');
    assert.match(body, /return false/);
  });

  test('an empty lock must ALSO be old before it is cleared', () => {
    const i = SRC.indexOf('function deadLock');
    const body = SRC.slice(i, i + 900);
    assert.match(body, /DEAD_LOCK_AFTER_MS/, 'the age check is gone — a lock a second old could be deleted');
    assert.match(SRC, /const DEAD_LOCK_AFTER_MS = 10 \* 60 \* 1000/,
      'ten minutes is far longer than any git add here and far shorter than the locks we have found');
  });

  test('an unreadable lock is left alone rather than guessed at', () => {
    const i = SRC.indexOf('function deadLock');
    const body = SRC.slice(i, i + 900);
    assert.match(body, /catch \{\s*\n?\s*return false;/,
      'cannot read it, cannot judge it, must not delete it');
  });

  test('the sweep can be switched off entirely', () => {
    assert.match(SRC, /NO_LOCK_SWEEP/, 'there must be a way to opt out of any automatic deletion');
  });

  test('clearing a lock is announced, never silent', () => {
    // A release tool that quietly deletes files inside .git is not one to trust.
    const i = SRC.indexOf('function refuseOnStaleLock');
    const body = SRC.slice(i, i + 3000);
    assert.match(body, /Cleared an abandoned git lock/);
    assert.match(body, /0 bytes/, 'it must say WHY it judged the lock dead');
  });

  test('a lock it will not clear still stops the run', () => {
    const i = SRC.indexOf('function refuseOnStaleLock');
    const body = SRC.slice(i, i + 3000);
    assert.match(body, /process\.exit\(1\)/);
    assert.match(body, /it has bytes in it, or it is less/,
      'the refusal must say why THIS lock was not cleared automatically');
  });

  test('it reads the real git dir, which for a worktree is not .git', () => {
    // `.git` here is a FILE containing "gitdir: /…/NUM/.git/worktrees/app-main".
    // Looking for ./.git/index.lock would have found nothing, every time.
    assert.match(SRC, /git rev-parse --absolute-git-dir/);
  });

  test('a repo with no lock is untouched', () => {
    const i = SRC.indexOf('function staleLock');
    assert.match(SRC.slice(i, i + 600), /existsSync\(lock\) \? lock : null/);
  });

  test('it stays quiet when there is no repository at all', () => {
    const i = SRC.indexOf('function staleLock');
    assert.match(SRC.slice(i, i + 200), /if \(!inRepo\(\)\) return null;/);
  });
});
