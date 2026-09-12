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
    const body = SRC.slice(i, i + 1200);
    assert.match(body, /\$\{lock\}/, 'the operator should not have to work out which file');
    assert.match(body, /rm -f/, 'and should not have to work out the command');
    assert.match(body, /NO_AUTOCOMMIT=1/, 'the escape hatch belongs in the message');
    assert.match(body, /process\.exit\(1\)/, 'it must stop, not warn and continue');
  });
});

describe('what it deliberately does NOT do', () => {
  test('it never deletes the lock itself', () => {
    const i = SRC.indexOf('function refuseOnStaleLock');
    const body = SRC.slice(i, i + 1200);
    assert.ok(!/unlinkSync|rmSync|rm -f "\$\{lock\}"\s*\)/.test(body.replace(/console\.error[^\n]*/g, '')),
      'the lock also exists when git IS running — removing it under a live writer corrupts the repo');
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
