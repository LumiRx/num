/**
 * The shared ledger.
 *
 * The property that matters is the one in the first describe block: two people
 * working at the same time must not overwrite each other. Everything else is
 * in service of that.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STATES, WHO, slugArea, readAll, add, current, render, build, check,
} from './ledger.mjs';

function dir() {
  const d = mkdtempSync(join(tmpdir(), 'ledger-'));
  mkdirSync(join(d, 'entries'), { recursive: true });
  return join(d, 'entries');
}
const at = (s) => new Date(`2026-09-15T${s}:00Z`);

/* ── the whole point ───────────────────────────────────────────────────── */

describe('nobody overwrites anybody', () => {
  test('THE PROPERTY: two people writing at once touch two different files', () => {
    const d = dir();
    add({ who: 'dre', area: 'host console', state: 'in-flight', dir: d, now: at('09:00') });
    add({ who: 'viv', area: 'outreach', state: 'in-flight', dir: d, now: at('09:00') });
    // Same second, both recorded, neither file touched by the other person.
    assert.ok(existsSync(join(d, 'dre.ndjson')));
    assert.ok(existsSync(join(d, 'viv.ndjson')));
    assert.equal(readAll({ dir: d }).length, 2);
  });

  test('a person only ever appends — earlier entries survive verbatim', () => {
    const d = dir();
    add({ who: 'dre', area: 'host console', state: 'in-flight', note: 'first', dir: d, now: at('09:00') });
    const after = readFileSync(join(d, 'dre.ndjson'), 'utf8');
    add({ who: 'dre', area: 'host console', state: 'done', note: 'second', dir: d, now: at('10:00') });
    const now = readFileSync(join(d, 'dre.ndjson'), 'utf8');
    assert.ok(now.startsWith(after), 'an earlier entry was rewritten');
    assert.equal(readAll({ dir: d }).length, 2, 'history was lost');
  });

  test('authorship comes from the FILENAME, so an entry cannot be forged', () => {
    // Otherwise one person can append a line claiming to be another, and an
    // attributed ledger that can be forged is worse than an anonymous one.
    const d = dir();
    writeFileSync(join(d, 'viv.ndjson'),
      JSON.stringify({ id: 'x', at: at('09:00').toISOString(), area: 'a', title: 'A', state: 'live', who: 'dre' }) + '\n');
    assert.equal(readAll({ dir: d })[0].who, 'viv');
  });
});

/* ── disagreement ──────────────────────────────────────────────────────── */

describe('a disagreement is shown, never resolved', () => {
  function disputed() {
    const d = dir();
    add({ who: 'dre', area: 'host console', state: 'done', note: 'shipped it', dir: d, now: at('09:00') });
    add({ who: 'viv', area: 'host console', state: 'blocked', note: 'it 500s for me', dir: d, now: at('11:00') });
    return d;
  }

  test('two people, one area, different states — flagged', () => {
    const { conflicts } = current(readAll({ dir: disputed() }));
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].area, 'host-console');
  });

  test('the NEWER entry does NOT silently win', () => {
    // "Most recent" is not "correct". A tool that quietly picks one teaches
    // people the board is lying to them.
    const d = disputed();
    const board = render({ entries: readAll({ dir: d }) });
    assert.match(board, /THE LEDGERS DISAGREE/);
    assert.match(board, /`dre` says \*\*done\*\*/);
    assert.match(board, /`viv` says \*\*blocked\*\*/);
    assert.match(board, /not automatically the correct one/);
  });

  test('both notes survive to the board, so the argument is legible', () => {
    const board = render({ entries: readAll({ dir: disputed() }) });
    assert.match(board, /shipped it/);
    assert.match(board, /it 500s for me/);
  });

  test('agreeing resolves it — by ADDING, never by editing', () => {
    const d = disputed();
    add({ who: 'dre', area: 'host console', state: 'blocked', note: 'viv is right', dir: d, now: at('12:00') });
    const { conflicts } = current(readAll({ dir: d }));
    assert.deepEqual(conflicts, []);
    assert.equal(readAll({ dir: d }).length, 3, 'the wrong entry was deleted rather than superseded');
  });

  test('the same person changing their mind is not a conflict', () => {
    const d = dir();
    add({ who: 'dre', area: 'x', state: 'done', dir: d, now: at('09:00') });
    add({ who: 'dre', area: 'x', state: 'live', dir: d, now: at('10:00') });
    const { rows, conflicts } = current(readAll({ dir: d }));
    assert.deepEqual(conflicts, []);
    assert.equal(rows[0].newest.state, 'live');
  });
});

/* ── the board is derived ──────────────────────────────────────────────── */

describe('the board cannot drift from the entries', () => {
  test('render is pure — same entries, same file', () => {
    const d = dir();
    add({ who: 'dre', area: 'a', state: 'live', dir: d, now: at('09:00') });
    const e = readAll({ dir: d });
    assert.equal(render({ entries: e, now: at('12:00') }), render({ entries: e, now: at('12:00') }));
  });

  test('the board says out loud that it is generated', () => {
    assert.match(render({ entries: [] }), /GENERATED FILE\. Do not edit/);
  });

  test('check notices a hand-edited board', () => {
    const d = dir();
    const board = join(d, '..', 'LEDGER.md');
    add({ who: 'dre', area: 'a', state: 'live', dir: d, now: at('09:00') });
    build({ dir: d, board, now: at('12:00') });
    assert.equal(check({ dir: d, board, now: at('12:30') }).ok, true);
    writeFileSync(board, readFileSync(board, 'utf8') + '\nsomebody typed here\n');
    const r = check({ dir: d, board, now: at('12:30') });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => /out of date/.test(p)));
  });

  test('the build timestamp alone never counts as drift', () => {
    // Otherwise every check after a minute reports a false problem, and the
    // daily check becomes noise people skip.
    const d = dir();
    const board = join(d, '..', 'LEDGER.md');
    add({ who: 'dre', area: 'a', state: 'live', dir: d, now: at('09:00') });
    build({ dir: d, board, now: at('12:00') });
    assert.equal(check({ dir: d, board, now: at('23:00') }).ok, true);
  });
});

/* ── guards ────────────────────────────────────────────────────────────── */

describe('guards', () => {
  test('an unknown person or state is refused, with the list', () => {
    const d = dir();
    assert.throws(() => add({ who: 'nobody', area: 'a', state: 'live', dir: d }), /who must be one of/);
    assert.throws(() => add({ who: 'dre', area: 'a', state: 'shipped', dir: d }), /state must be one of/);
    assert.throws(() => add({ who: 'dre', area: '  ', state: 'live', dir: d }), /needs an area/);
  });

  test('area names normalise, or the same thing lands twice on the board', () => {
    assert.equal(slugArea('Host Console'), 'host-console');
    assert.equal(slugArea('  host   console!! '), 'host-console');
    const d = dir();
    add({ who: 'dre', area: 'Host Console', state: 'done', dir: d, now: at('09:00') });
    add({ who: 'viv', area: 'host console', state: 'done', dir: d, now: at('10:00') });
    assert.equal(current(readAll({ dir: d })).rows.length, 1, 'one area split into two');
  });

  test('a corrupt line surfaces as a problem instead of vanishing', () => {
    const d = dir();
    writeFileSync(join(d, 'dre.ndjson'), '{not json\n');
    const e = readAll({ dir: d });
    assert.equal(e.length, 1);
    assert.equal(e[0].state, 'blocked');
    assert.match(e[0].note, /unreadable line 1/);
  });

  test('a corrupt line does not take the other entries down with it', () => {
    const d = dir();
    add({ who: 'viv', area: 'good', state: 'live', dir: d, now: at('09:00') });
    writeFileSync(join(d, 'dre.ndjson'), '{broken\n');
    assert.equal(readAll({ dir: d }).length, 2);
  });

  test('control characters cannot break the file format', () => {
    // One stray newline in a note would otherwise split one entry into two
    // lines and corrupt everything after it.
    const d = dir();
    add({ who: 'dre', area: 'a', state: 'live', note: 'one\ntwo\rthree', dir: d, now: at('09:00') });
    assert.equal(readFileSync(join(d, 'dre.ndjson'), 'utf8').trim().split('\n').length, 1);
    assert.equal(readAll({ dir: d }).length, 1);
  });

  test('every state has a plain-language meaning', () => {
    for (const [k, v] of Object.entries(STATES)) {
      assert.ok(v.length > 15, `${k} has no real explanation`);
    }
    assert.ok(WHO.includes('dre') && WHO.includes('viv'));
  });

  test('live and done stay separate — that distinction is load-bearing', () => {
    // Built-and-merged is not deployed-and-serving. Conflating them is how the
    // Hollywood fix spent a session marked shipped while the app ran old code.
    assert.match(STATES.live, /Deployed/);
    assert.match(STATES.done, /NOT necessarily deployed/);
  });
});

/* ── deploy state folds in ─────────────────────────────────────────────── */

describe('deploy state is read, not typed', () => {
  const DEPLOY = [
    { name: 'num-app', state: 'current', at: '2026-09-15T16:27:00Z' },
    { name: 'num-growth', state: 'stale', at: '2026-09-14T10:00:00Z', changed: ['worker/scoutpage.mjs'] },
  ];

  test('the board shows what is actually deployed', () => {
    const b = render({ entries: [], deploy: DEPLOY });
    assert.match(b, /Deployed right now/);
    assert.match(b, /num-growth \| 🔴 \*\*STALE\*\*/);
  });

  test('a stale worker fails the daily check', () => {
    const d = dir();
    const board = join(d, '..', 'LEDGER.md');
    build({ dir: d, board, deploy: DEPLOY, now: at('12:00') });
    const r = check({ dir: d, board, deploy: DEPLOY, now: at('12:00') });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => /older code/.test(p)));
  });

  test('the board still builds with no deploy data at all', () => {
    assert.ok(render({ entries: [], deploy: null }).includes('MASTER LEDGER'));
  });
});
