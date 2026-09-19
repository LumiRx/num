// Milestones, and the promise they are not allowed to make.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  TIERS, MYSTERY_LINE, tiersReached, nextTier,
  recordMilestones, milestonesFor, openMilestones,
} from './milestones.mjs';

const load = (f) => readFileSync(new URL('../worker/migrations/' + f, import.meta.url), 'utf8');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_ambassadors (id TEXT PRIMARY KEY, name TEXT, email TEXT, city TEXT,
            country TEXT, code TEXT, member_id TEXT, status TEXT DEFAULT 'active');`);
  const sql = load('0053_ambassador_milestones.sql').split('\n')
    .map((l) => l.replace(/--.*$/, '')).join('\n');
  for (const stmt of sql.split(';').map((x) => x.trim()).filter(Boolean)) db.exec(stmt + ';');
  db.prepare("INSERT INTO num_ambassadors (id,name,email,code) VALUES ('a1','Rae','rae@x.com','RAE1')").run();
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

/* ── THE COPY RULE ──────────────────────────────────────────────────────
   Dre's call: the bonus is a mystery and nothing is guaranteed. That makes
   the wording load-bearing — a discretionary reward described in the
   language of a guarantee is a guarantee nobody funded. */

test('the mystery line never promises anything', () => {
  const banned = [/\bguarantee/i, /\byou will receive\b/i, /\byou'll get\b/i,
    /\bwe will send you\b/i, /\bpromise/i, /\bentitled\b/i];
  for (const re of banned) {
    assert.equal(re.test(MYSTERY_LINE), false,
      `the milestone copy says "${MYSTERY_LINE.match(re)}" — that is a guarantee, and nothing is guaranteed`);
  }
});

test('the mystery line says who decides, and that nothing is owed in advance', () => {
  assert.match(MYSTERY_LINE, /we decide/i);
  assert.match(MYSTERY_LINE, /nothing is committed in advance/i);
  // The honest half nobody enjoys writing: a rung can pass with nothing on
  // it. Said here so that when it happens it is not news.
  assert.match(MYSTERY_LINE, /may pass without one/i);
});

test('the one thing that IS true is said at the same time', () => {
  // Somebody who never receives a bonus must still not have been lied to.
  // The 20% share is the programme and the copy has to keep saying so.
  assert.match(MYSTERY_LINE, /20% share is the programme/i);
});

test('no rung names a prize', () => {
  for (const t of TIERS) {
    const text = t.name + ' ' + t.blurb;
    for (const re of [/\btrip\b/i, /\bflight/i, /\bhotel/i, /\bcar\b/i, /\bwatch\b/i, /\$\d/]) {
      assert.equal(re.test(text), false, `rung ${t.tier} names a prize: ${text}`);
    }
  }
});

/* ── the ladder ────────────────────────────────────────────────────────── */

test('the first rung is one, because the first person is the hard one', () => {
  assert.equal(TIERS[0].tier, 1);
});

test('rungs only ever go up', () => {
  for (let i = 1; i < TIERS.length; i++) {
    assert.ok(TIERS[i].tier > TIERS[i - 1].tier, 'the ladder is out of order');
  }
});

test('tiersReached counts what has actually been passed', () => {
  assert.deepEqual(tiersReached(0), []);
  assert.deepEqual(tiersReached(1), [1]);
  assert.deepEqual(tiersReached(26), [1, 5, 10, 25]);
});

test('progress is measured from the last rung, not from zero', () => {
  // At 26 of 50, a bar drawn from zero reads as half done. It is not: they
  // are one person into a climb of twenty-five.
  const n = nextTier(26);
  assert.equal(n.tier, 50);
  assert.equal(n.to_go, 24);
  assert.equal(n.pct, 4);
});

test('the top of the ladder is not a bug', () => {
  assert.equal(nextTier(9999), null);
});

/* ── recording ─────────────────────────────────────────────────────────── */

test('passing several rungs at once records each of them', async () => {
  const db = freshDb();
  const fresh = await recordMilestones(env(db), { ambassadorId: 'a1', count: 12 });
  assert.deepEqual(fresh.map((t) => t.tier), [1, 5, 10]);
});

test('a recount tells nobody anything twice', async () => {
  // The whole reason for the unique index. Without it, every read of the
  // console would announce every milestone the person has ever passed.
  const db = freshDb();
  await recordMilestones(env(db), { ambassadorId: 'a1', count: 12 });
  const again = await recordMilestones(env(db), { ambassadorId: 'a1', count: 12 });
  assert.deepEqual(again, []);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM num_ambassador_milestones').get().n, 3);
});

test('a rung records what was true on the day, not what the ladder says now', async () => {
  const db = freshDb();
  await recordMilestones(env(db), { ambassadorId: 'a1', count: 7 });
  const row = db.prepare('SELECT * FROM num_ambassador_milestones WHERE tier=5').get();
  assert.equal(row.referred_count, 7);
});

test('a new rung fires later without re-firing the old ones', async () => {
  const db = freshDb();
  await recordMilestones(env(db), { ambassadorId: 'a1', count: 4 });
  const fresh = await recordMilestones(env(db), { ambassadorId: 'a1', count: 5 });
  assert.deepEqual(fresh.map((t) => t.tier), [5]);
});

test('a milestone starts owed, not done', async () => {
  const db = freshDb();
  await recordMilestones(env(db), { ambassadorId: 'a1', count: 1 });
  const mine = await milestonesFor(env(db), 'a1');
  assert.equal(mine[0].state, 'reached');
  assert.equal(mine[0].reward_kind, null, 'it is a mystery until a person decides');
});

/* ── the queue that makes discretion honest ────────────────────────────── */

test('what NUM owes is one query, with how long they have waited', async () => {
  const db = freshDb();
  await recordMilestones(env(db), { ambassadorId: 'a1', count: 5 });
  db.prepare("UPDATE num_ambassador_milestones SET reached_at = '2026-09-01T00:00:00Z' WHERE tier=1").run();
  const open = await openMilestones(env(db));
  assert.equal(open.length, 2);
  assert.equal(open[0].tier, 1, 'the longest wait comes first');
  assert.ok(open[0].days_waiting >= 1);
  assert.equal(open[0].name, 'Rae');
});

test('a sent milestone leaves the queue, and so does a declined one', async () => {
  const db = freshDb();
  await recordMilestones(env(db), { ambassadorId: 'a1', count: 5 });
  db.prepare("UPDATE num_ambassador_milestones SET state='sent' WHERE tier=1").run();
  db.prepare("UPDATE num_ambassador_milestones SET state='declined' WHERE tier=5").run();
  assert.deepEqual(await openMilestones(env(db)), []);
});

test('the ladder in code matches the CHECK the table allows', () => {
  const sql = load('0053_ambassador_milestones.sql');
  for (const st of ['reached', 'chosen', 'sent', 'declined']) {
    assert.ok(sql.includes(`'${st}'`), st + ' is not a state the table allows');
  }
});

test('a database that cannot take the write does not throw at a signup', async () => {
  const bad = { DB: { prepare() { throw new Error('D1 is having a day'); } } };
  assert.deepEqual(await recordMilestones(bad, { ambassadorId: 'a1', count: 5 }), []);
  assert.deepEqual(await milestonesFor(bad, 'a1'), []);
  assert.deepEqual(await openMilestones(bad), []);
});
