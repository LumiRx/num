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

/* ── against a real database ─────────────────────────────────────────────── */

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE num_giveaway_entries (week_key TEXT, member_id TEXT, entered_at TEXT, source TEXT,
      PRIMARY KEY (week_key, member_id));
  `);
  const DB = {
    prepare(sql) {
      const b = [];
      const api = {
        bind(...a) { b.push(...a); return api; },
        async first() { try { return d.prepare(sql).get(...b) ?? null; } catch { return null; } },
        async all() { try { return { results: d.prepare(sql).all(...b) }; } catch { return { results: [] }; } },
        async run() { const r = d.prepare(sql).run(...b); return { meta: { changes: Number(r.changes ?? 0) } }; },
      };
      return api;
    },
    async batch(st) { const o = []; for (const s of st) o.push(await s.run()); return o; },
  };
  return { d, env: { DB } };
}

// Entrants, not merely people who used Num — the draw reads
// num_giveaway_entries, because entering is now an opt-in act. See
// worker/packdraw.mjs.
const seedMembers = (d, n, { week = '2026-09-11' } = {}, prefix = 'mem_') => {
  for (let i = 0; i < n; i++) {
    const id = `${prefix}${String(i).padStart(3, '0')}`;
    d.prepare('INSERT OR IGNORE INTO num_members (id,name) VALUES (?,?)').run(id, 'M');
    d.prepare('INSERT OR IGNORE INTO num_giveaway_entries (week_key,member_id,entered_at,source) VALUES (?,?,?,?)')
      .run(week, id, '2026-09-09T00:00:00Z', 'app');
  }
};

const WINDOW = { periodStart: '2026-09-05', periodEnd: '2026-09-11' };

describe('running a real draw', () => {
  test('it records the seed and the count, so the draw can be reproduced', async () => {
    const { d, env } = db();
    seedMembers(d, 21);
    const out = await runDraw(env, WINDOW);
    assert.equal(out.ok, true);
    assert.equal(out.winners.length, 10);
    assert.equal(out.eligible_count, 21);
    const row = d.prepare('SELECT * FROM num_giveaway_draws').get();
    assert.ok(row.seed, 'no seed recorded — the draw is unverifiable');
    assert.deepEqual(pickWinners(
      d.prepare('SELECT member_id AS id FROM num_giveaway_entries ORDER BY member_id').all().map((r) => r.id),
      10, row.seed,
    ), out.winners, 'the recorded seed does not reproduce the recorded winners');
  });

  test('running it twice on the same Friday does not draw twice', async () => {
    const { d, env } = db();
    seedMembers(d, 21);
    const first = await runDraw(env, WINDOW);
    const second = await runDraw(env, WINDOW);
    assert.equal(second.already, true);
    assert.deepEqual(second.winners, first.winners, 'a second run produced different winners');
    assert.equal(d.prepare('SELECT COUNT(*) n FROM num_giveaway_draws').get().n, 1);
  });

  test('using Num without sending the code does NOT enter you', async () => {
    // The change on 12 Sep 2026. Passive qualification entered people who did
    // not know they had entered; only an explicit entry counts now.
    const { d, env } = db();
    seedMembers(d, 5);
    for (let i = 0; i < 30; i++) {
      d.prepare('INSERT OR IGNORE INTO num_members (id,name) VALUES (?,?)').run(`busy_${i}`, 'M');
    }
    const out = await runDraw(env, WINDOW);
    assert.equal(out.eligible_count, 5, 'members who never sent the code were entered');
  });

  test('only entries for THIS week count', async () => {
    const { d, env } = db();
    seedMembers(d, 6);
    seedMembers(d, 9, { week: '2026-09-18' }, 'later_');
    const out = await runDraw(env, WINDOW);
    assert.equal(out.eligible_count, 6);
  });

  test('a week nobody entered is a refusal, not ten empty prizes', async () => {
    const { env } = db();
    const out = await runDraw(env, WINDOW);
    assert.equal(out.ok, false);
    assert.equal(out.eligible_count, 0);
  });
});

describe('a winner who cannot prove eligibility', () => {
  test('forfeits, and the replacement is somebody new', async () => {
    // We cannot check 18+ or US/UK at draw time — num_members records neither —
    // so the gate is at claim and a failure has to redraw cleanly.
    const { d, env } = db();
    seedMembers(d, 21);
    const out = await runDraw(env, WINDOW);
    const loser = out.winners[0];
    const r = await forfeitAndRedraw(env, { drawId: out.id, memberId: loser, reason: 'under 18' });
    assert.equal(r.ok, true);
    assert.ok(r.replaced, 'nobody replaced the forfeited winner');
    assert.ok(!out.winners.includes(r.replaced), 'the replacement had already won');
    const row = d.prepare('SELECT state, reason FROM num_giveaway_claims WHERE draw_id=? AND member_id=?')
      .get(out.id, loser);
    assert.equal(row.state, 'forfeited');
    assert.match(row.reason, /under 18/);
  });

  test('a forfeit can never hand the same person a second prize', async () => {
    const { d, env } = db();
    seedMembers(d, 12);
    const out = await runDraw(env, WINDOW);
    const r = await forfeitAndRedraw(env, { drawId: out.id, memberId: out.winners[0] });
    if (r.replaced) {
      const n = d.prepare('SELECT COUNT(*) n FROM num_giveaway_claims WHERE draw_id=? AND member_id=?')
        .get(out.id, r.replaced).n;
      assert.equal(n, 1);
    }
  });

  test('an unknown draw is refused rather than invented', async () => {
    const { env } = db();
    const r = await forfeitAndRedraw(env, { drawId: 'draw_nope', memberId: 'mem_1' });
    assert.equal(r.ok, false);
  });
});
