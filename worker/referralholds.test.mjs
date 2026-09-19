// One person paying themselves, versus a husband referring his wife.
//
// These look identical from the outside — two accounts, one sofa, one router,
// sometimes one tablet — and only one of them should be paid. Getting this
// wrong in either direction costs real money to a real person, so both
// directions are asserted here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  creditMemberReferral, sameHumanRisk, decideHold, openHolds, __resetSchema,
} from './memberreferral.mjs';

const load = (f) => readFileSync(new URL('./migrations/' + f, import.meta.url), 'utf8');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT, phone TEXT,
      phone_verified INTEGER DEFAULT 0, identity_verified INTEGER DEFAULT 0, bio TEXT,
      referred_by TEXT, referred_pct INTEGER, referred_at TEXT);
    CREATE TABLE num_identity_signals (member_id TEXT PRIMARY KEY, device_id TEXT,
      ip_hash TEXT, ua_hash TEXT, country TEXT);
    CREATE TABLE num_star_moves (id TEXT PRIMARY KEY, member_id TEXT, delta INTEGER,
      kind TEXT, note TEXT, counterparty TEXT);
    CREATE TABLE num_star_balances (member_id TEXT PRIMARY KEY, stars INTEGER DEFAULT 0);
    CREATE TABLE num_notifications (id TEXT PRIMARY KEY, member_id TEXT, kind TEXT,
      title TEXT, subtitle TEXT, body TEXT, url TEXT, tag TEXT);
  `);
  const sql = load('0060_referral_holds.sql').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  for (const stmt of sql.split(';').map((x) => x.trim()).filter(Boolean)) db.exec(stmt + ';');
  return db;
}
const nz = (v) => (v === undefined ? null : v);
function expand(sql, binds) {
  if (!/\?\d/.test(sql)) return { sql, args: binds.map(nz) };
  const args = [];
  const out = sql.replace(/\?(\d+)/g, (_, n) => { args.push(nz(binds[Number(n) - 1])); return '?'; });
  return { sql: out, args };
}
/** A D1-shaped fake whose `batch` is a REAL transaction, because the whole
 *  point of the change under test is atomicity. */
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
        __run: () => go('run'),
      };
      return api;
    },
    async batch(list) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of list) out.push(s.__run());
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  },
});

function member(db, id, over = {}) {
  db.prepare(`INSERT INTO num_members (id,phone,phone_verified,identity_verified,bio,referred_by,referred_pct)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, over.phone ?? null, over.phone_verified ?? 0, over.identity_verified ?? 0,
      over.bio ?? null, over.referred_by ?? null, over.referred_pct ?? null);
  if (over.device) {
    db.prepare('INSERT INTO num_identity_signals (member_id,device_id) VALUES (?,?)').run(id, over.device);
  }
}
const five = (id) => JSON.stringify({ '5arz_id': id });
const balance = (db, id) => db.prepare('SELECT stars FROM num_star_balances WHERE member_id=?').get(id)?.stars ?? 0;

/* ══ THE COUPLE MUST BE PAID ══════════════════════════════════════════ */

test('two 5arz-verified people are two people, even on one device', async () => {
  // The rule that makes the whole hold acceptable. /verify/5arz refuses to
  // link one identity to two accounts, so if both verified they are two.
  const db = freshDb(); __resetSchema();
  member(db, 'm_him', { identity_verified: 1, bio: five('mem_him'), device: 'one_tablet' });
  member(db, 'm_her', { identity_verified: 1, bio: five('mem_her'), device: 'one_tablet',
    referred_by: 'm_him', referred_pct: 20 });

  assert.equal(await sameHumanRisk(env(db), { memberId: 'm_her', referrerId: 'm_him' }), null);
  const r = await creditMemberReferral(env(db), { memberId: 'm_her', stars: 500, ref: 'c1' });
  assert.equal(r.credited, 100);
  assert.equal(balance(db, 'm_him'), 100);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM num_referral_holds').get().n, 0);
});

test('two ordinary people who share nothing are paid without a second thought', async () => {
  const db = freshDb(); __resetSchema();
  member(db, 'm_a', { device: 'his_phone' });
  member(db, 'm_b', { device: 'her_phone', referred_by: 'm_a', referred_pct: 20 });
  const r = await creditMemberReferral(env(db), { memberId: 'm_b', stars: 500, ref: 'c1' });
  assert.equal(r.credited, 100);
});

test('sharing a router is never a reason to hold money', async () => {
  // 156 members behind 61 addresses. Holding on IP would hold most honest
  // referrals in the product.
  const db = freshDb(); __resetSchema();
  member(db, 'm_a', { device: 'his_phone' });
  member(db, 'm_b', { device: 'her_phone', referred_by: 'm_a', referred_pct: 20 });
  db.prepare("UPDATE num_identity_signals SET ip_hash='same_home'").run();
  assert.equal(await sameHumanRisk(env(db), { memberId: 'm_b', referrerId: 'm_a' }), null);
});

/* ══ THE REBATE MUST NOT BE PAID ══════════════════════════════════════ */

test('one person with two accounts on one device is held, not paid', async () => {
  const db = freshDb(); __resetSchema();
  member(db, 'm_main', { device: 'my_phone' });
  member(db, 'm_alt', { device: 'my_phone', referred_by: 'm_main', referred_pct: 20 });

  const r = await creditMemberReferral(env(db), { memberId: 'm_alt', stars: 500, ref: 'c1' });
  assert.equal(r.credited, 0);
  assert.equal(r.held, 100);
  assert.match(r.why, /same device/);
  assert.equal(balance(db, 'm_main'), 0, 'the rebate was paid');
  const hold = db.prepare('SELECT * FROM num_referral_holds').get();
  assert.equal(hold.stars, 100);
  assert.equal(hold.state, 'held');
});

test('one 5arz identity on both accounts is held whatever else looks fine', async () => {
  const db = freshDb(); __resetSchema();
  member(db, 'm_a', { identity_verified: 1, bio: five('mem_same'), device: 'd1' });
  member(db, 'm_b', { identity_verified: 1, bio: five('mem_same'), device: 'd2',
    referred_by: 'm_a', referred_pct: 20 });
  const r = await creditMemberReferral(env(db), { memberId: 'm_b', stars: 500, ref: 'c1' });
  assert.equal(r.credited, 0);
  assert.match(r.why, /one 5arz identity/);
});

test('the same verified phone on both accounts is held', async () => {
  const db = freshDb(); __resetSchema();
  member(db, 'm_a', { phone: '+447700900000', phone_verified: 1 });
  member(db, 'm_b', { phone: '+447700900000', phone_verified: 1, referred_by: 'm_a', referred_pct: 20 });
  const r = await creditMemberReferral(env(db), { memberId: 'm_b', stars: 500, ref: 'c1' });
  assert.match(r.why, /same phone number/);
});

test('an unreadable signal holds the money rather than paying it', async () => {
  // A held payment is recoverable; a paid one is not.
  const bad = { DB: { prepare() { throw new Error('D1 is having a day'); } } };
  assert.match(await sameHumanRisk(bad, { memberId: 'a', referrerId: 'b' }),
    /could not check/);
});

/* ══ RELEASING, WHICH IS WHAT MAKES A HOLD HONEST ═════════════════════ */

test('releasing a hold pays exactly the amount that was held', async () => {
  const db = freshDb(); __resetSchema();
  member(db, 'm_main', { device: 'my_phone' });
  member(db, 'm_alt', { device: 'my_phone', referred_by: 'm_main', referred_pct: 20 });
  await creditMemberReferral(env(db), { memberId: 'm_alt', stars: 500, ref: 'c1' });

  const out = await decideHold(env(db), { ref: 'c1', release: true, by: 'dre' });
  assert.equal(out.credited, 100);
  assert.equal(balance(db, 'm_main'), 100);
  const row = db.prepare('SELECT * FROM num_referral_holds').get();
  assert.equal(row.state, 'released');
  assert.equal(row.decided_by, 'dre');
});

test('releasing twice pays once', async () => {
  const db = freshDb(); __resetSchema();
  member(db, 'm_main', { device: 'p' });
  member(db, 'm_alt', { device: 'p', referred_by: 'm_main', referred_pct: 20 });
  await creditMemberReferral(env(db), { memberId: 'm_alt', stars: 500, ref: 'c1' });
  await decideHold(env(db), { ref: 'c1', release: true });
  await decideHold(env(db), { ref: 'c1', release: true });
  assert.equal(balance(db, 'm_main'), 100);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM num_star_moves").get().n, 1);
});

test('a released hold cannot be paid again by a retried settlement', async () => {
  // The release replays the ORIGINAL ref, so the star move id is the one the
  // settle would have written.
  const db = freshDb(); __resetSchema();
  member(db, 'm_main', { device: 'p' });
  member(db, 'm_alt', { device: 'p', referred_by: 'm_main', referred_pct: 20 });
  await creditMemberReferral(env(db), { memberId: 'm_alt', stars: 500, ref: 'c1' });
  await decideHold(env(db), { ref: 'c1', release: true });
  const retry = await creditMemberReferral(env(db), { memberId: 'm_alt', stars: 500, ref: 'c1' });
  assert.equal(retry.credited, 0);
  assert.equal(balance(db, 'm_main'), 100);
});

test('refusing records the decision and pays nothing', async () => {
  const db = freshDb(); __resetSchema();
  member(db, 'm_main', { device: 'p' });
  member(db, 'm_alt', { device: 'p', referred_by: 'm_main', referred_pct: 20 });
  await creditMemberReferral(env(db), { memberId: 'm_alt', stars: 500, ref: 'c1' });
  const out = await decideHold(env(db), { ref: 'c1', release: false, by: 'dre' });
  assert.equal(out.state, 'refused');
  assert.equal(balance(db, 'm_main'), 0);
});

test('the queue shows who is waiting, how long, and whether both verified', async () => {
  const db = freshDb(); __resetSchema();
  member(db, 'm_main', { device: 'p', identity_verified: 1, bio: five('mem_one') });
  member(db, 'm_alt', { device: 'p', referred_by: 'm_main', referred_pct: 20 });
  await creditMemberReferral(env(db), { memberId: 'm_alt', stars: 500, ref: 'c1' });
  const open = await openHolds(env(db));
  assert.equal(open.length, 1);
  assert.equal(open[0].referrer_verified, 1);
  assert.equal(open[0].member_verified, 0);
  assert.ok(open[0].days_waiting >= 0);
});

/* ══ THE PAYMENT IS ATOMIC ════════════════════════════════════════════ */

test('a duplicate settlement leaves the balance exactly where it was', async () => {
  // The bug: balance was incremented, the ledger insert then threw on the
  // duplicate key, the catch swallowed it, and the caller was told nothing
  // was paid — cashable Stars with no ledger row to explain them.
  const db = freshDb(); __resetSchema();
  member(db, 'm_a', { device: 'd1' });
  member(db, 'm_b', { device: 'd2', referred_by: 'm_a', referred_pct: 20 });

  await creditMemberReferral(env(db), { memberId: 'm_b', stars: 500, ref: 'c1' });
  assert.equal(balance(db, 'm_a'), 100);

  // Force the pre-check to miss, exactly as a read hiccup would.
  const e = env(db);
  const realPrepare = e.DB.prepare.bind(e.DB);
  e.DB.prepare = (sql) => (sql.includes('SELECT id FROM num_star_moves')
    ? { bind: () => ({ first: async () => null }) }
    : realPrepare(sql));

  const again = await creditMemberReferral(e, { memberId: 'm_b', stars: 500, ref: 'c1' });
  assert.equal(again.duplicate, true);
  assert.equal(balance(db, 'm_a'), 100, 'the balance moved without a ledger row');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM num_star_moves').get().n, 1);
});

test('the ledger and the balance always agree', async () => {
  const db = freshDb(); __resetSchema();
  member(db, 'm_a', { device: 'd1' });
  for (let i = 0; i < 5; i++) {
    member(db, 'm_' + i, { device: 'dev' + i, referred_by: 'm_a', referred_pct: 20 });
    await creditMemberReferral(env(db), { memberId: 'm_' + i, stars: 500, ref: 'c' + i });
    await creditMemberReferral(env(db), { memberId: 'm_' + i, stars: 500, ref: 'c' + i });
  }
  const ledger = db.prepare("SELECT COALESCE(SUM(delta),0) n FROM num_star_moves WHERE member_id='m_a'").get().n;
  assert.equal(balance(db, 'm_a'), ledger);
  assert.equal(ledger, 500);
});
