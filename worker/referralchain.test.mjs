// The whole chain, run end to end against the real schema.
//
// Every piece of this was individually correct and individually tested on
// 19 Sep 2026, and the chain still paid nobody: attribution died at the
// domain boundary, and the function that pays had no caller. Unit tests
// cannot see either of those. This one walks the whole thing:
//
//     a code        →  linkReferral      →  referred_by written
//                   →  announceReferral  →  the referrer is told
//                   →  a milestone row   →  somebody owes them a bonus
//     a commission  →  markPaid          →  creditMemberReferral
//                   →  Stars in a wallet
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { linkReferral, creditMemberReferral, referralSummary, __resetSchema } from './memberreferral.mjs';

const load = (f) => readFileSync(new URL('./migrations/' + f, import.meta.url), 'utf8');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE num_referral_codes (code TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT,
      university_id TEXT, reward_cs INTEGER, reward_referee_cs INTEGER, max_conversions INTEGER,
      max_reward_total_cs INTEGER, active INTEGER DEFAULT 1, expires_at INTEGER, created_at INTEGER);
    CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT, email TEXT, email_verified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT '2026-09-01', referred_by TEXT, referred_pct INTEGER, referred_at TEXT);
    CREATE TABLE num_star_moves (id TEXT PRIMARY KEY, member_id TEXT, delta INTEGER, kind TEXT,
      note TEXT, counterparty TEXT);
    CREATE TABLE num_star_balances (member_id TEXT PRIMARY KEY, stars INTEGER DEFAULT 0);
    CREATE TABLE num_notifications (id TEXT PRIMARY KEY, member_id TEXT, kind TEXT, title TEXT,
      subtitle TEXT, body TEXT, url TEXT, tag TEXT);
  `);
  for (const f of ['0051_ambassadors.sql', '0053_ambassador_milestones.sql']) {
    const sql = load(f).split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
    for (const stmt of sql.split(';').map((x) => x.trim()).filter(Boolean)) {
      try { db.exec(stmt + ';'); } catch { /* DROP of a table this fixture never made */ }
    }
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
const env = (db, extra = {}) => ({
  SITE: 'https://itsnum.com',
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
    async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; },
  },
  ...extra,
});

function seedAmbassador(db, { id = 'a1', code = 'RAEK7M2Q', member = 'm_rae' } = {}) {
  db.prepare("INSERT INTO num_members (id,name,email,email_verified) VALUES (?,'Rae Wilder','rae@x.com',1)").run(member);
  db.prepare("INSERT INTO num_referral_codes (code,owner_type,owner_id,active,created_at) VALUES (?,'ambassador',?,1,0)").run(code, id);
  db.prepare(`INSERT INTO num_ambassadors (id,name,email,code,member_id,status,listed,created_at)
              VALUES (?,'Rae Wilder','rae@x.com',?,?,'active',0,'2026-09-01')`).run(id, code, member);
  return { id, code, member };
}
const joiner = (db, id, name) =>
  db.prepare('INSERT INTO num_members (id,name) VALUES (?,?)').run(id, name) && id;

/* ── the chain ─────────────────────────────────────────────────────────── */

test('a code brings a person in, and the referrer is told the same moment', async () => {
  const db = freshDb(); __resetSchema();
  const amb = seedAmbassador(db);
  joiner(db, 'm_new', 'Jamie Doe');

  const r = await linkReferral(env(db), { memberId: 'm_new', code: amb.code });
  assert.equal(r.ok, true);
  assert.equal(r.referrer, 'm_rae');

  // THE NOTIFICATION IS THE POINT. Before this, the only thing that ever
  // reached a referrer fired when their person SPENT — weeks later, maybe
  // never. Posting a link and hearing nothing for a month is how somebody
  // decides the programme is fake.
  const n = db.prepare("SELECT * FROM num_notifications WHERE member_id='m_rae'").get();
  assert.ok(n, 'the referrer was told nothing');
  assert.match(n.title, /your link/i);
  assert.match(n.body, /^J\./, 'an initial, never the new member\'s full name');
  assert.equal(/Jamie/.test(n.body + n.title), false, 'the new member was named to somebody else');
});

test('the first join records the first milestone, owed to a person', async () => {
  const db = freshDb(); __resetSchema();
  const amb = seedAmbassador(db);
  joiner(db, 'm_new', 'Jamie Doe');
  await linkReferral(env(db), { memberId: 'm_new', code: amb.code });

  const ms = db.prepare('SELECT * FROM num_ambassador_milestones').all();
  assert.equal(ms.length, 1);
  assert.equal(ms[0].tier, 1);
  assert.equal(ms[0].state, 'reached', 'a milestone starts owed, not done');
  assert.equal(ms[0].reward_kind, null, 'it is a mystery until a person decides');
});

test('five joins cross two rungs and announce each exactly once', async () => {
  const db = freshDb(); __resetSchema();
  const amb = seedAmbassador(db);
  for (let i = 0; i < 5; i++) {
    joiner(db, 'm_' + i, 'Person ' + i);
    await linkReferral(env(db), { memberId: 'm_' + i, code: amb.code });
  }
  const tiers = db.prepare('SELECT tier FROM num_ambassador_milestones ORDER BY tier').all().map((r) => r.tier);
  assert.deepEqual(tiers, [1, 5]);
  // Five joins, five notifications — not one collapsed into another.
  const notes = db.prepare("SELECT COUNT(*) n FROM num_notifications WHERE member_id='m_rae'").get();
  assert.equal(notes.n, 5, 'notifications collapsed — the referrer saw fewer people than joined');
});

test('a second attempt at the same person announces nothing', async () => {
  const db = freshDb(); __resetSchema();
  const amb = seedAmbassador(db);
  joiner(db, 'm_new', 'Jamie');
  await linkReferral(env(db), { memberId: 'm_new', code: amb.code });
  await linkReferral(env(db), { memberId: 'm_new', code: amb.code });
  const n = db.prepare("SELECT COUNT(*) n FROM num_notifications WHERE member_id='m_rae'").get();
  assert.equal(n.n, 1, 'somebody was told twice that they gained one person');
});

/* ── and then the money ────────────────────────────────────────────────── */

test('a commission NUM collected pays the referrer 20% of it', async () => {
  const db = freshDb(); __resetSchema();
  const amb = seedAmbassador(db);
  joiner(db, 'm_new', 'Jamie');
  await linkReferral(env(db), { memberId: 'm_new', code: amb.code });

  // NUM collected ★500 of commission from this member's booking.
  const out = await creditMemberReferral(env(db), { memberId: 'm_new', stars: 500, ref: 'comm:b1:50000' });
  assert.equal(out.credited, 100, '20% of 500');

  const bal = db.prepare("SELECT stars FROM num_star_balances WHERE member_id='m_rae'").get();
  assert.equal(bal.stars, 100);
  const move = db.prepare("SELECT * FROM num_star_moves WHERE member_id='m_rae'").get();
  assert.equal(move.kind, 'referral', 'kind must stay in cashout.mjs EARNED_KINDS or it is not cashable');
  assert.equal(move.counterparty, 'm_new', 'the console reads this to show per-person earnings');
});

test('the same commission settled twice pays once', async () => {
  const db = freshDb(); __resetSchema();
  const amb = seedAmbassador(db);
  joiner(db, 'm_new', 'Jamie');
  await linkReferral(env(db), { memberId: 'm_new', code: amb.code });
  await creditMemberReferral(env(db), { memberId: 'm_new', stars: 500, ref: 'comm:b1:50000' });
  const again = await creditMemberReferral(env(db), { memberId: 'm_new', stars: 500, ref: 'comm:b1:50000' });
  assert.equal(again.duplicate, true);
  assert.equal(db.prepare("SELECT stars FROM num_star_balances WHERE member_id='m_rae'").get().stars, 100);
});

test('what the console reads adds up to what was actually paid', async () => {
  const db = freshDb(); __resetSchema();
  const amb = seedAmbassador(db);
  for (const [id, stars] of [['m_a', 500], ['m_b', 250]]) {
    joiner(db, id, 'Person');
    await linkReferral(env(db), { memberId: id, code: amb.code });
    await creditMemberReferral(env(db), { memberId: id, stars, ref: `comm:${id}:1` });
  }
  const sum = await referralSummary(env(db), 'm_rae');
  assert.equal(sum.referred, 2);
  assert.equal(sum.earned, 150, '100 + 50');
});

test('an ambassador with no NUM account is attributed nothing and told nothing', async () => {
  // The honest refusal. Their link still logs arrivals; it cannot pay, and
  // nothing pretends otherwise.
  const db = freshDb(); __resetSchema();
  db.prepare("INSERT INTO num_referral_codes (code,owner_type,owner_id,active,created_at) VALUES ('NOACC1','ambassador','a9',1,0)").run();
  db.prepare(`INSERT INTO num_ambassadors (id,name,email,code,status,listed,created_at)
              VALUES ('a9','No Account','x@x.com','NOACC1','active',0,'2026-09-01')`).run();
  joiner(db, 'm_new', 'Jamie');

  const r = await linkReferral(env(db), { memberId: 'm_new', code: 'NOACC1' });
  assert.equal(r.ok, false);
  assert.match(r.why, /no NUM account/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM num_notifications').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM num_ambassador_milestones').get().n, 0);
});

test('a plain member referrer is told too — this is not only for ambassadors', async () => {
  const db = freshDb(); __resetSchema();
  db.prepare("INSERT INTO num_members (id,name) VALUES ('m_ana','Ana')").run();
  db.prepare("INSERT INTO num_referral_codes (code,owner_type,owner_id,active,created_at) VALUES ('ANA123','member','m_ana',1,0)").run();
  joiner(db, 'm_new', 'Jamie');

  await linkReferral(env(db), { memberId: 'm_new', code: 'ANA123' });
  const n = db.prepare("SELECT * FROM num_notifications WHERE member_id='m_ana'").get();
  assert.ok(n, 'an ordinary member who refers a friend hears nothing');
  // No ambassador row, so no milestone — and no crash looking for one.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM num_ambassador_milestones').get().n, 0);
});
