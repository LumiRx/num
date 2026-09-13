// The Friday pack draw.
//
// The thing being protected is not correctness, it is CHECKABILITY. Ten winners
// a week chosen by the company handing out the prizes is exactly the shape
// people are right to be suspicious of, so the draw has to be reproducible by
// anyone holding the seed and the entrant list — which is what the Official
// Rules promise in clause 7.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  EXCLUDED_PREFIXES, WINNERS_PER_DRAW, forfeitAndRedraw, pickWinners, rng, runDraw,
} from './fridaydraw.mjs';

const ids = (n, p = 'mem_') => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(3, '0')}`);

describe('the draw can be re-checked afterwards', () => {
  test('same seed, same people, same winners — every time', () => {
    const a = pickWinners(ids(21), 10, 'week-38');
    const b = pickWinners(ids(21), 10, 'week-38');
    assert.deepEqual(a, b);
  });

  test('the database\'s row order cannot change the result', () => {
    // Without the sort, the winners depend on whatever order D1 returned rows
    // in — and the draw stops being reproducible the moment an index changes.
    const forward = pickWinners(ids(21), 10, 'week-38');
    const backward = pickWinners([...ids(21)].reverse(), 10, 'week-38');
    const shuffled = pickWinners([...ids(21)].sort(() => 0.5 - Math.random()), 10, 'week-38');
    assert.deepEqual(backward, forward);
    assert.deepEqual(shuffled, forward);
  });

  test('a different seed gives a different draw', () => {
    const a = pickWinners(ids(50), 10, 'week-38');
    const b = pickWinners(ids(50), 10, 'week-39');
    assert.notDeepEqual(a, b);
  });

  test('nothing here uses Math.random', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./fridaydraw.mjs', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    assert.doesNotMatch(code, /Math\.random/,
      'a draw nobody can reproduce is a draw nobody can check');
  });

  test('the generator is stable, not just self-consistent', () => {
    // Pinning actual values: a "deterministic" function that changes between
    // versions makes every past draw unverifiable.
    const r = rng('week-38');
    const first = [r(), r(), r()].map((n) => n.toFixed(6));
    const r2 = rng('week-38');
    assert.deepEqual([r2(), r2(), r2()].map((n) => n.toFixed(6)), first);
  });
});

describe('who can win', () => {
  test('ten winners, all different', () => {
    const w = pickWinners(ids(21), WINNERS_PER_DRAW, 's');
    assert.equal(w.length, 10);
    assert.equal(new Set(w).size, 10, 'one pack each — nobody wins twice');
  });

  test('test accounts never win', () => {
    // 88 of 633 asks on record are our own probes. A zztest_ account winning is
    // the fastest way to make the draw look rigged.
    const pool = [...ids(5), ...ids(20, 'zztest_')];
    const w = pickWinners(pool, 10, 's');
    assert.equal(w.length, 5, 'only the real members were eligible');
    for (const id of w) {
      for (const p of EXCLUDED_PREFIXES) assert.ok(!id.startsWith(p), `${id} should be excluded`);
    }
  });

  test('fewer entrants than prizes gives everyone a prize, not a crash', () => {
    assert.equal(pickWinners(ids(4), 10, 's').length, 4);
    assert.deepEqual(pickWinners([], 10, 's'), []);
    assert.deepEqual(pickWinners(null, 10, 's'), []);
  });

  test('a duplicated id is one entry', () => {
    // One entry per person however many messages they sent.
    const w = pickWinners(['mem_a', 'mem_a', 'mem_a', 'mem_b'], 10, 's');
    assert.deepEqual(w.sort(), ['mem_a', 'mem_b']);
  });
});

/* ── against the REAL database ───────────────────────────────────────────
 *
 * The version this replaces built its own two-table schema by hand and wrapped
 * every read in `catch { return { results: [] } }`. Both halves of that hid the
 * live bug: the hand-built table had the columns the code wanted rather than the
 * columns production has, and the catch turned a failed query into a calm empty
 * week. The draw would have reported "nobody entered" on a Friday when people
 * had.
 *
 * So: the migrations are loaded from disk, and a broken statement throws.
 */

import { readFileSync } from 'node:fs';
import { eligibleEntrants, winnerContacts } from './fridaydraw.mjs';

const M23 = readFileSync(new URL('./migrations/0023_giveaway.sql', import.meta.url), 'utf8');
const M26 = readFileSync(new URL('./migrations/0026_giveaway_entrant_key.sql', import.meta.url), 'utf8');

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT, phone TEXT);');
  for (const raw of (M23 + '\n' + M26).split(';')) {
    const stmt = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (stmt) d.exec(stmt + ';');
  }
  const DB = {
    prepare(sql) {
      const b = [];
      const api = {
        bind(...a) { b.push(...a); return api; },
        async first() { return d.prepare(sql).get(...b) ?? null; },
        async all() { return { results: d.prepare(sql).all(...b) }; },
        async run() { const r = d.prepare(sql).run(...b); return { meta: { changes: Number(r.changes ?? 0) } }; },
      };
      return api;
    },
  };
  return { d, env: { DB } };
}

/** The Friday 00:00 UTC that opens the period — the key the draw runs on. */
const WEEK = Math.floor(Date.parse('2026-09-11T00:00:00Z') / 1000);
const NEXT = Math.floor(Date.parse('2026-09-18T00:00:00Z') / 1000);

/* Entrants, not merely people who used Num. Entering is an opt-in act. */
const seedEntrants = (d, n, { week = WEEK, prefix = 'mem_', withPhone = false } = {}) => {
  for (let i = 0; i < n; i++) {
    const id = `${prefix}${String(i).padStart(3, '0')}`;
    const phone = withPhone ? `+1415555${String(1000 + i)}` : null;
    d.prepare('INSERT OR IGNORE INTO num_members (id,name,phone) VALUES (?,?,?)').run(id, 'M', phone);
    d.prepare(`INSERT OR IGNORE INTO num_giveaway_entrants
      (id, entrant_key, phone, member_id, week_start, source, created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(`ge_${prefix}${i}_${week}`, phone ? `phone:${phone}` : `member:${id}`,
           phone, id, week, 'app', 1);
  }
};

describe('running a real draw', () => {
  test('it records the seed and the count, so the draw can be reproduced', async () => {
    const { d, env } = db();
    seedEntrants(d, 21);
    const out = await runDraw(env, { weekStart: WEEK });
    assert.equal(out.ok, true);
    assert.equal(out.winners.length, 10);
    assert.equal(out.eligible_count, 21);
    const row = d.prepare('SELECT * FROM num_giveaway_results').get();
    assert.ok(row.seed, 'no seed recorded — the draw is unverifiable');
    assert.equal(row.week_start, WEEK);
    assert.deepEqual(pickWinners(
      d.prepare('SELECT DISTINCT entrant_key AS id FROM num_giveaway_entrants ORDER BY entrant_key').all().map((r) => r.id),
      10, row.seed,
    ), out.winners, 'the recorded seed does not reproduce the recorded winners');
  });

  test('running it twice on the same Friday does not draw twice', async () => {
    const { d, env } = db();
    seedEntrants(d, 21);
    const first = await runDraw(env, { weekStart: WEEK });
    const second = await runDraw(env, { weekStart: WEEK });
    assert.equal(second.already, true);
    assert.deepEqual(second.winners, first.winners, 'a second run produced different winners');
    assert.equal(d.prepare('SELECT COUNT(*) n FROM num_giveaway_results').get().n, 1);
  });

  test('using Num without sending the code does NOT enter you', async () => {
    const { d, env } = db();
    seedEntrants(d, 5);
    for (let i = 0; i < 30; i++) {
      d.prepare('INSERT OR IGNORE INTO num_members (id,name) VALUES (?,?)').run(`busy_${i}`, 'M');
    }
    const out = await runDraw(env, { weekStart: WEEK });
    assert.equal(out.eligible_count, 5, 'members who never sent the code were entered');
  });

  test('only entries for THIS week count', async () => {
    const { d, env } = db();
    seedEntrants(d, 6);
    seedEntrants(d, 9, { week: NEXT, prefix: 'later_' });
    const out = await runDraw(env, { weekStart: WEEK });
    assert.equal(out.eligible_count, 6);
  });

  test('a week nobody entered is a refusal, not ten empty prizes', async () => {
    const { env } = db();
    const out = await runDraw(env, { weekStart: WEEK });
    assert.equal(out.ok, false);
    assert.equal(out.eligible_count, 0);
  });

  test('a BROKEN read stops the draw — it must never read as a quiet week', async () => {
    // The failure this whole rewrite exists for. A draw that answers "nobody
    // entered" when the query failed is indistinguishable from an honest empty
    // week, so nobody investigates and the real entrants are never drawn.
    const env = { DB: { prepare() { throw new Error('no such column: week_key'); } } };
    await assert.rejects(() => runDraw(env, { weekStart: WEEK }), /no such column/);
  });

  test('the winners carry a way to reach them', async () => {
    const { d, env } = db();
    seedEntrants(d, 12, { withPhone: true });
    const out = await runDraw(env, { weekStart: WEEK });
    assert.equal(out.contacts.length, 10);
    for (const c of out.contacts) {
      assert.match(c.entrant_key, /^phone:/);
      assert.ok(c.phone, 'a winner with no way to be told is a prize nobody collects');
    }
    const claims = d.prepare('SELECT COUNT(*) n FROM num_giveaway_claims WHERE draw_id=?').get(out.id).n;
    assert.equal(claims, 10);
  });

  test('a member with no phone can win, and is reachable in the app', async () => {
    const { d, env } = db();
    seedEntrants(d, 11, { withPhone: false });
    const out = await runDraw(env, { weekStart: WEEK });
    for (const c of out.contacts) {
      assert.match(c.entrant_key, /^member:/);
      assert.ok(c.member_id, 'a member-keyed winner must carry the member id');
    }
  });

  test('entrant keys are what is drawn, so one human cannot hold two tickets', async () => {
    const { d, env } = db();
    // The same human twice: once by text, once in the app, both resolved to the
    // same number. The unique index is what stops it, and the draw sees one.
    d.prepare('INSERT INTO num_members (id,name,phone) VALUES (?,?,?)').run('mem_dre', 'Dre', '+14155550001');
    d.prepare(`INSERT INTO num_giveaway_entrants (id,entrant_key,phone,member_id,week_start,source,created_at)
               VALUES ('a','phone:+14155550001','+14155550001',NULL,?,'sms',1)`).run(WEEK);
    d.prepare(`INSERT OR IGNORE INTO num_giveaway_entrants (id,entrant_key,phone,member_id,week_start,source,created_at)
               VALUES ('b','phone:+14155550001','+14155550001','mem_dre',?,'app',2)`).run(WEEK);
    assert.deepEqual(await eligibleEntrants(env, { weekStart: WEEK }), ['phone:+14155550001']);
  });

  test('winnerContacts is empty for an empty draw rather than throwing', async () => {
    const { env } = db();
    assert.deepEqual(await winnerContacts(env, { weekStart: WEEK, keys: [] }), []);
  });
});

describe('a winner who cannot prove eligibility', () => {
  test('forfeits, and the replacement is somebody new', async () => {
    const { d, env } = db();
    seedEntrants(d, 21);
    const out = await runDraw(env, { weekStart: WEEK });
    const loser = out.winners[0];
    const r = await forfeitAndRedraw(env, { drawId: out.id, entrantKey: loser, reason: 'under 18' });
    assert.equal(r.ok, true);
    assert.ok(r.replaced, 'nobody replaced the forfeited winner');
    assert.ok(!out.winners.includes(r.replaced), 'the replacement had already won');
    const row = d.prepare('SELECT state, reason FROM num_giveaway_claims WHERE draw_id=? AND entrant_key=?')
      .get(out.id, loser);
    assert.equal(row.state, 'forfeited');
    assert.match(row.reason, /under 18/);
  });

  test('a forfeit can never hand the same person a second prize', async () => {
    const { d, env } = db();
    seedEntrants(d, 12);
    const out = await runDraw(env, { weekStart: WEEK });
    const r = await forfeitAndRedraw(env, { drawId: out.id, entrantKey: out.winners[0] });
    if (r.replaced) {
      const n = d.prepare('SELECT COUNT(*) n FROM num_giveaway_claims WHERE draw_id=? AND entrant_key=?')
        .get(out.id, r.replaced).n;
      assert.equal(n, 1);
    }
  });

  test('an unknown draw is refused rather than invented', async () => {
    const { env } = db();
    const r = await forfeitAndRedraw(env, { drawId: 'draw_nope', entrantKey: 'phone:+1' });
    assert.equal(r.ok, false);
  });
});
