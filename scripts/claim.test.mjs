// The claim file, tested against the incident that caused it.
//
// On 3 Sep 2026 two Cowork sessions edited this worktree at the same time.
// Both sets of work survived by luck. The property under test is the one that
// would have saved them: a second session asking "is anyone in here" gets a
// truthful answer, and a deploy started mid-edit is refused.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Point the module at a scratch directory BEFORE importing it: a test that
// wrote into the real .claims/ would take the edit lock away from whichever
// session is running the suite.
const SCRATCH = mkdtempSync(join(tmpdir(), 'num-claims-'));
process.env.NUM_CLAIM_DIR = SCRATCH;
const { take, renew, release, read, held, status, isStale, CLAIM_DIR, STALE_MINUTES } = await import('./claim.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const wipe = () => rmSync(CLAIM_DIR, { recursive: true, force: true });

beforeEach(wipe);
after(wipe);

describe('the edit claim', () => {
  test('a second session is told who is in here, and does not get in', () => {
    assert.equal(take('edit', 'biz pages', 'cowork-A').ok, true);
    const second = take('edit', 'mail delivery', 'cowork-B');
    assert.equal(second.ok, false);
    assert.equal(second.code, 1);
    // The message has to carry WHO and WHAT — "locked" tells the second
    // session nothing it can act on, and it will just delete the file.
    assert.match(second.error, /cowork-A/);
    assert.match(second.error, /biz pages/);
  });

  test('the same session re-taking its own claim is fine', () => {
    take('edit', 'first', 'cowork-A');
    assert.equal(take('edit', 'still going', 'cowork-A').ok, true);
    assert.equal(read('edit').note, 'still going');
  });

  test('a crashed session never blocks the tree forever', () => {
    take('edit', 'died halfway', 'cowork-A');
    const held = read('edit');
    const old = new Date(Date.now() - (STALE_MINUTES + 1) * 60000).toISOString();
    mkdirSync(CLAIM_DIR, { recursive: true });
    writeFileSync(join(CLAIM_DIR, 'edit.json'), JSON.stringify({ ...held, renewed_at: old }));
    assert.equal(isStale(read('edit')), true);
    assert.equal(take('edit', 'taking over', 'cowork-B').ok, true,
      'a stale claim must not need a human to clear it');
  });

  test('renewing keeps it alive and only the holder can', () => {
    take('edit', 'long job', 'cowork-A');
    const before = read('edit').renewed_at;
    assert.equal(renew('edit', 'cowork-B').ok, false, 'anyone could renew somebody else claim');
    const out = renew('edit', 'cowork-A');
    assert.equal(out.ok, true);
    assert.ok(read('edit').renewed_at >= before);
  });

  test('releasing somebody else claim needs an explicit force', () => {
    take('edit', 'mine', 'cowork-A');
    assert.equal(release('edit', 'cowork-B').ok, false);
    assert.equal(release('edit', 'cowork-B', { force: true }).ok, true);
    // Released, not deleted — a Cowork session cannot delete inside a connected
    // folder at all, so a delete-based release would take the lock and never
    // give it back. The record survives as the audit trail the incident wanted.
    assert.equal(held('edit'), null, 'the claim is still holding after release');
    assert.ok(read('edit').released_at, 'the release left no trace of who held it');
    assert.equal(read('edit').released_by, 'cowork-B');
  });

  test('forcing records who was forced over — a silent break is the bug again', () => {
    take('edit', 'mine', 'cowork-A');
    take('edit', 'taking it', 'cowork-B', { force: true });
    assert.equal(read('edit').forced_over.who, 'cowork-A');
  });

  test('a claim without a name is refused', () => {
    const out = take('edit', 'anonymous', null);
    assert.equal(out.ok, false);
    assert.equal(out.code, 2, 'an unnamed claim tells the next session nothing');
  });
});

describe('the deploy claim', () => {
  test('a deploy while somebody is editing is refused — that is the one that reaches production', () => {
    take('edit', 'mid-rewrite of bizconsole', 'cowork-A');
    const dep = take('deploy', 'ship it', 'dre');
    assert.equal(dep.ok, false);
    assert.match(dep.error, /half-written/);
    assert.match(dep.error, /cowork-A/);
  });

  test('the session doing the editing can deploy its own work', () => {
    take('edit', 'my change', 'cowork-A');
    assert.equal(take('deploy', 'ship my change', 'cowork-A').ok, true);
  });

  test('two deploys do not overlap', () => {
    assert.equal(take('deploy', 'ship 0.8.233', 'dre').ok, true);
    assert.equal(take('deploy', 'ship something else', 'cowork-B').ok, false);
  });

  test('a stale edit claim does not block a deploy forever', () => {
    take('edit', 'crashed', 'cowork-A');
    const held = read('edit');
    writeFileSync(join(CLAIM_DIR, 'edit.json'), JSON.stringify({
      ...held, renewed_at: new Date(Date.now() - (STALE_MINUTES + 1) * 60000).toISOString(),
    }));
    assert.equal(take('deploy', 'ship', 'dre').ok, true);
  });
});

describe('it is findable', () => {
  test('status answers "is anyone in here" without arguments', () => {
    take('edit', 'working', 'cowork-A');
    const s = status();
    assert.equal(s.find((x) => x.kind === 'edit').held, true);
    assert.equal(s.find((x) => x.kind === 'deploy').held, false);
  });

  test('a released claim reads as free, and the next session can take it', () => {
    take('edit', 'done now', 'cowork-A');
    release('edit', 'cowork-A');
    assert.equal(status().find((x) => x.kind === 'edit').held, false);
    assert.equal(take('edit', 'my turn', 'cowork-B').ok, true,
      'a released claim still blocked the next session — the lock would be worse than none');
  });

  test('CLAUDE.md tells the next session to check, because AGENTS.md did not get read', () => {
    // This file exists at all because a rule sitting in AGENTS.md went unread
    // for an hour while a session walked toward destroying 89 commits.
    // Knowledge that is not loaded is not knowledge.
    const md = readFileSync(join(HERE, '..', 'CLAUDE.md'), 'utf8');
    assert.match(md, /scripts\/claim\.mjs/, 'the claim is not mentioned where sessions actually read');
    assert.match(md, /take edit/, 'CLAUDE.md does not give the command');
    assert.match(md, /branch does not fix this/i,
      'CLAUDE.md does not say why a branch is not the answer — and it is the first thing anyone tries');
  });

  test('claims are never committed — one machine lock is not everyone else problem', () => {
    const gi = readFileSync(join(HERE, '..', '.gitignore'), 'utf8');
    assert.match(gi, /^\.claims\/$/m);
    assert.match(gi, /^\.secrets\/$/m);
  });
});
