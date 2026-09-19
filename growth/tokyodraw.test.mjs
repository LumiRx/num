// The Tokyo draw: is the weighting real, and can a stranger check the result?
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  CAMPAIGN, LADDER, entriesFor, toNextEntry, ticketsFor, memberOfTicket,
  standings, standingFor, runTokyoDraw,
} from './tokyodraw.mjs';
import { pickWinners } from '../worker/fridaydraw.mjs';

const load = (f) => readFileSync(new URL('../worker/migrations/' + f, import.meta.url), 'utf8');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT, referred_by TEXT);
    CREATE TABLE num_giveaway_results (id TEXT PRIMARY KEY, week_start INTEGER NOT NULL,
      drawn_at TEXT NOT NULL, seed TEXT NOT NULL, eligible_count INTEGER NOT NULL,
      winners TEXT NOT NULL, note TEXT, campaign TEXT);
    CREATE TABLE num_giveaway_claims (draw_id TEXT NOT NULL, entrant_key TEXT NOT NULL,
      phone TEXT, member_id TEXT, state TEXT DEFAULT 'won', claimed_at TEXT,
      forfeited_at TEXT, reason TEXT, campaign TEXT, PRIMARY KEY (draw_id, entrant_key));
  `);
  // The free-entry table comes from the real migration, so its uniqueness
  // rules are the ones production will actually enforce.
  const sql = load('0055_niches_and_tokyo.sql').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  for (const stmt of sql.split(';').map((x) => x.trim()).filter(Boolean)) {
    try { db.exec(stmt + ';'); } catch { /* the ALTERs target tables this fixture already shaped */ }
  }
  return db;
}
const nz = (v) => (v === undefined ? null : v);
function expand(sql, binds) {
  if (!/\?\d/.test(sql)) return { sql, args: binds.map(nz) };
  const args = [];
  const out = sql.replace(/\?(\d+)/g, (_, n) => { args.push(nz(binds[Number(n) - 1])); return '?'; });
  return { sql: out, args };
}
const env = (db) => ({
  DB: {
    prepare(sql) {
      const binds = [];
      const go = (fn) => { const e = expand(sql, binds); return db.prepare(e.sql)[fn](...e.args); };
      const api = {
        bind(...a) { binds.push(...a); return api; },
        async first() { return go('all')[0] ?? null; },
        async all() { return { results: go('all') }; },
        async run() { const r = go('run'); return { ...r, meta: { changes: Number(r.changes ?? 0) } }; },
      };
      return api;
    },
  },
});
function bring(db, referrer, n, from = 0) {
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO num_members (id,referred_by) VALUES (?,?)').run(`${referrer}_f${from + i}`, referrer);
  }
}

/* ── the ladder ────────────────────────────────────────────────────────── */

test('the ladder is the shape Dre asked for, sized to the product', () => {
  assert.equal(entriesFor(0), 0);
  assert.equal(entriesFor(LADDER.first - 1), 0);
  assert.equal(entriesFor(LADDER.first), 1);
  assert.equal(entriesFor(LADDER.second - 1), 1);
  assert.equal(entriesFor(LADDER.second), 2);
  assert.equal(entriesFor(LADDER.second + LADDER.step), 3);
  assert.equal(entriesFor(LADDER.second + LADDER.step * 4), 6);
});

test('entries never go down as somebody brings more people', () => {
  let last = 0;
  for (let n = 0; n < 500; n++) {
    const e = entriesFor(n);
    assert.ok(e >= last, `entries fell at ${n}`);
    last = e;
  }
});

test('the card can always say how many more people until the next entry', () => {
  assert.equal(toNextEntry(0), LADDER.first);
  assert.equal(toNextEntry(LADDER.first), LADDER.second - LADDER.first);
  assert.equal(toNextEntry(LADDER.second), LADDER.step);
  // Never zero, never negative: "0 more to go" on a card that has not moved
  // reads as a bug.
  for (let n = 0; n < 400; n++) assert.ok(toNextEntry(n) > 0, `to_next was ${toNextEntry(n)} at ${n}`);
});

test('nonsense in is zero out, not a crash or a free entry', () => {
  for (const bad of [null, undefined, -5, 'lots', NaN, Infinity]) {
    assert.equal(entriesFor(bad), 0, String(bad));
  }
});

/* ── THE BUG THIS DESIGN EXISTS TO AVOID ───────────────────────────────── */

test('weighting is REAL — pickWinners de-duplicates ids, so repeats would flatten it', () => {
  // Proof of the hazard, kept as a test so nobody "simplifies" tickets back
  // into repeated ids: three copies of one id collapse to one.
  assert.deepEqual(pickWinners(['a', 'a', 'a'], 3, 'seed'), ['a']);
  // Tickets survive, because they are genuinely different strings.
  assert.equal(pickWinners(ticketsFor('a', 3), 3, 'seed').length, 3);
});

test('ten entries really is ten times the tickets of one', () => {
  assert.equal(ticketsFor('m1', 10).length, 10);
  assert.equal(new Set(ticketsFor('m1', 10)).size, 10);
  assert.equal(memberOfTicket('m1#7'), 'm1');
});

test('a weighted field is actually won more often by the heavier entrant', () => {
  // Not a fairness proof — a distribution check. With 10 tickets against 1,
  // the heavy entrant should win the clear majority over many seeds.
  let heavy = 0;
  for (let i = 0; i < 300; i++) {
    const tickets = [...ticketsFor('big', 10), ...ticketsFor('small', 1)];
    const order = pickWinners(tickets, tickets.length, 'seed-' + i);
    if (memberOfTicket(order[0]) === 'big') heavy++;
  }
  assert.ok(heavy > 230, `heavier entrant won ${heavy}/300 — the weighting is not biting`);
  assert.ok(heavy < 300, 'the lighter entrant never won once, which is not a draw');
});

/* ── reproducibility: the property the rules promise ───────────────────── */

test('the same seed and the same tickets give the same winner, always', async () => {
  const db = freshDb();
  bring(db, 'm_a', 60); bring(db, 'm_b', 30); bring(db, 'm_c', 25);
  const first = await runTokyoDraw(env(db), { seed: 'fixed-seed-1' });
  assert.equal(first.ok, true);

  const db2 = freshDb();
  bring(db2, 'm_a', 60); bring(db2, 'm_b', 30); bring(db2, 'm_c', 25);
  const second = await runTokyoDraw(env(db2), { seed: 'fixed-seed-1' });
  assert.deepEqual(second.winners, first.winners, 'the draw is not reproducible');
});

test('the seed and the whole ticket list are handed back so it can be checked', async () => {
  const db = freshDb();
  bring(db, 'm_a', 50);
  const r = await runTokyoDraw(env(db), { seed: 'check-me' });
  assert.equal(r.verify.seed, 'check-me');
  assert.equal(r.verify.tickets.length, 2, 'fifty people is two entries');
  // And the recorded row carries the seed, which is what makes it checkable
  // after everyone has forgotten the API response.
  const row = db.prepare('SELECT * FROM num_giveaway_results').get();
  assert.equal(row.seed, 'check-me');
  assert.equal(row.campaign, CAMPAIGN);
  assert.equal(row.eligible_count, 2);
});

test('one person cannot win the same trip twice', async () => {
  const db = freshDb();
  bring(db, 'm_solo', 200);
  const r = await runTokyoDraw(env(db), { seed: 's', winners: 3 });
  assert.deepEqual(r.winners, ['m_solo'], 'the only entrant should win once, not three times');
});

test('an empty draw is refused loudly, not reported as a calm week', async () => {
  const db = freshDb();
  bring(db, 'm_a', 3); // below the first rung
  const r = await runTokyoDraw(env(db), { seed: 's' });
  assert.equal(r.ok, false);
  assert.match(r.why, /nobody has an entry/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM num_giveaway_results').get().n, 0);
});

/* ── the free route, which is what keeps it lawful ─────────────────────── */

test('a free entry counts, without anybody being referred', async () => {
  const db = freshDb();
  db.prepare('INSERT INTO num_members (id) VALUES (?)').run('m_free');
  db.prepare(`INSERT INTO num_draw_free_entries (id,campaign,member_id,entries,source,created_at)
              VALUES ('f1',?,'m_free',1,'form','2026-09-19')`).run(CAMPAIGN);
  const s = await standingFor(env(db), 'm_free');
  assert.equal(s.referred, 0);
  assert.equal(s.earned, 0);
  assert.equal(s.free, 1);
  assert.equal(s.entries, 1, 'the free route did not actually put them in the draw');
  const all = await standings(env(db));
  assert.deepEqual(all.map((r) => r.member_id), ['m_free']);
});

test('free and earned entries stack — the free door is not a trap', async () => {
  const db = freshDb();
  bring(db, 'm_x', 50);
  db.prepare(`INSERT INTO num_draw_free_entries (id,campaign,member_id,entries,source,created_at)
              VALUES ('f1',?,'m_x',1,'form','2026-09-19')`).run(CAMPAIGN);
  const s = await standingFor(env(db), 'm_x');
  assert.equal(s.earned, 2);
  assert.equal(s.entries, 3, 'using the free route cost them an earned entry');
});

test('the same person cannot take the free entry twice', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_draw_free_entries (id,campaign,member_id,entries,source,created_at)
              VALUES ('f1',?,'m_x',1,'form','2026-09-19')`).run(CAMPAIGN);
  assert.throws(() => {
    db.prepare(`INSERT INTO num_draw_free_entries (id,campaign,member_id,entries,source,created_at)
                VALUES ('f2',?,'m_x',1,'form','2026-09-19')`).run(CAMPAIGN);
  }, 'the free route is unlimited, which makes the ladder meaningless');
});

test('standings rank by entries and are computed, never stored', async () => {
  const db = freshDb();
  bring(db, 'm_big', 100); bring(db, 'm_mid', 50); bring(db, 'm_small', 25);
  const s = await standings(env(db));
  assert.deepEqual(s.map((r) => r.member_id), ['m_big', 'm_mid', 'm_small']);
  assert.deepEqual(s.map((r) => r.entries), [4, 2, 1]);
  // Nothing was written to get that answer.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM num_draw_free_entries').get().n, 0);
});
