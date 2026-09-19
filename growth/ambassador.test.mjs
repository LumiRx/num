// Ambassadors: the door, and the one hop that decides whether anybody is paid.
//
// The test this file exists for is `an ambassador code actually writes a
// payment edge`. Everything else here is ordinary coverage; that one is the
// reason the feature is not a lie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  ambSummary, ambProfile, ambSocial, ambOffers, ambClaim, ambDirectory,
  connectMember, publicAmbassador, mintAmbCode, PLATFORMS, OFFER_STATES, BENEFITS,
} from './ambassador.mjs';
import { linkReferral, __resetSchema } from '../worker/memberreferral.mjs';

const load = (f) => readFileSync(new URL('../worker/migrations/' + f, import.meta.url), 'utf8');
const T = '2026-09-01 00:00:00';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE num_referral_codes (code TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT,
      university_id TEXT, reward_cs INTEGER, reward_referee_cs INTEGER, max_conversions INTEGER,
      max_reward_total_cs INTEGER, active INTEGER DEFAULT 1, expires_at INTEGER, created_at INTEGER);
    CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT, email TEXT, email_verified INTEGER DEFAULT 0,
      created_at TEXT, referred_by TEXT, referred_pct INTEGER, referred_at TEXT);
    CREATE TABLE num_star_moves (id TEXT PRIMARY KEY, member_id TEXT, delta INTEGER, kind TEXT,
      note TEXT, counterparty TEXT);
    CREATE TABLE num_hosts (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active', console_key TEXT);
  `);
  // Comments are stripped BEFORE the split, never after: a '--' line that
  // happens to contain a semicolon tears the statement either side of it.
  const sql = load('0051_ambassadors.sql').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  for (const stmt of sql.split(';').map((x) => x.trim()).filter(Boolean)) db.exec(stmt + ';');
  return db;
}

function addAmb(db, { id = 'a1', name = 'Rae Wilder', email = 'rae@example.com', code = 'RAEK7M2Q',
  status = 'active', listed = 0, key = 'k'.repeat(30), member = null, city = 'Lisbon' } = {}) {
  db.prepare(`INSERT INTO num_referral_codes (code,owner_type,owner_id,active,created_at)
              VALUES (?,'ambassador',?,1,0)`).run(code, id);
  db.prepare(`INSERT INTO num_ambassadors (id,name,email,code,member_id,city,status,listed,console_key,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, name, email, code, member, city, status, listed, key, T);
  return id;
}
const addMember = (db, { id = 'm1', email = 'rae@example.com', verified = 1 } = {}) =>
  db.prepare('INSERT INTO num_members (id,email,email_verified,created_at) VALUES (?,?,?,?)')
    .run(id, email, verified, T) && id;

const nz = (v) => (v === undefined ? null : v);
function expand(sql, binds) {
  if (!/\?\d/.test(sql)) return { sql, args: binds.map(nz) };
  const args = [];
  const out = sql.replace(/\?(\d+)/g, (_, n) => { args.push(nz(binds[Number(n) - 1])); return '?'; });
  return { sql: out, args };
}
const d1 = (db) => ({
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
  async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; },
});
const env = (db) => ({ DB: d1(db), SITE: 'https://itsnum.com' });
const deps = (db, { host = null, biz = null } = {}) => ({
  J: (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } }),
  /* THE FAKE MUST BITE LIKE THE REAL ONE.
     This used to be a trim-and-slice, so every test passed while the live
     endpoint refused valid post URLs: the real `clean` is a NAME whitelist
     and strips ':' and '/', which turned "https://instagram.com/p/x" into
     "https //instagram.com p x". A stub gentler than production tests a
     function that does not exist. Both of these mirror growth/worker.js. */
  clean: (s, max = 200) => (s === null || s === undefined ? '' : String(s)
    .replace(/[^\p{L}\p{M}\p{N} '&.,()/+@_-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max)),
  cleanUrl: (s, max = 200) => {
    let u = String(s === null || s === undefined ? '' : s).trim();
    if (!u) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) { if (!/^https?:\/\//i.test(u)) return ''; } else u = 'https://' + u;
    try { return new URL(u).toString().slice(0, max); } catch { return ''; }
  },
  readJSON: async (r) => r.json(),
  badOrigin: () => false,
  sameSecret: (a, b) => String(a) === String(b),
  hostAuth: async () => host,
  bizAuth: async () => biz,
  sendBatch: async () => ({ ok: true }),
});

const KEY = 'k'.repeat(30);
const get = async (fn, db, qs = '', o) => {
  const url = new URL('https://itsnum.com/api/amb/x?k=' + KEY + qs);
  return (await fn(new Request(url), env(db), url, deps(db, o))).json();
};
const post = async (fn, db, body, o) => {
  const url = new URL('https://itsnum.com/api/amb/x?k=' + KEY);
  const req = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await fn(req, env(db), url, deps(db, o))).json();
};

/* ── THE ONE THAT MATTERS ───────────────────────────────────────────────
   Before 19 Sep an ambassador code redirected, logged the arrival and
   carried ?ref= into signup, and then wrote nothing. These four tests are
   the difference between a programme and a screensaver. */

test('an ambassador code writes the payment edge, pointing at the MEMBER', async () => {
  const db = freshDb();
  __resetSchema();
  addMember(db, { id: 'm_rae' });
  addAmb(db, { member: 'm_rae' });
  db.prepare("INSERT INTO num_members (id,email,created_at) VALUES ('m_new','new@x.com',?)").run(T);

  const r = await linkReferral(env(db), { memberId: 'm_new', code: 'RAEK7M2Q' });
  assert.equal(r.ok, true);
  // NOT 'a1'. The ambassador row's id in referred_by matches no member, so
  // creditMemberReferral would find nobody and pay nothing.
  assert.equal(r.referrer, 'm_rae');
  const row = db.prepare('SELECT referred_by, referred_pct FROM num_members WHERE id=?').get('m_new');
  assert.equal(row.referred_by, 'm_rae');
  assert.equal(row.referred_pct, 20);
});

test('an ambassador with no NUM account links nobody, and says why', async () => {
  const db = freshDb();
  __resetSchema();
  addAmb(db, { member: null });
  db.prepare("INSERT INTO num_members (id,email,created_at) VALUES ('m_new','new@x.com',?)").run(T);

  const r = await linkReferral(env(db), { memberId: 'm_new', code: 'RAEK7M2Q' });
  assert.equal(r.ok, false);
  assert.match(r.why, /no NUM account/);
  assert.equal(db.prepare('SELECT referred_by FROM num_members WHERE id=?').get('m_new').referred_by, null);
});

test('an ended ambassador stops earning', async () => {
  const db = freshDb();
  __resetSchema();
  addMember(db, { id: 'm_rae' });
  addAmb(db, { member: 'm_rae', status: 'ended' });
  db.prepare("INSERT INTO num_members (id,email,created_at) VALUES ('m_new','new@x.com',?)").run(T);
  const r = await linkReferral(env(db), { memberId: 'm_new', code: 'RAEK7M2Q' });
  assert.equal(r.ok, false);
});

test('an ambassador cannot refer themselves through their own code', async () => {
  const db = freshDb();
  __resetSchema();
  addMember(db, { id: 'm_rae' });
  addAmb(db, { member: 'm_rae' });
  const r = await linkReferral(env(db), { memberId: 'm_rae', code: 'RAEK7M2Q' });
  assert.equal(r.why, 'self-referral');
});

test('member codes still work exactly as they did', async () => {
  const db = freshDb();
  __resetSchema();
  addMember(db, { id: 'm_a', email: 'a@x.com' });
  db.prepare("INSERT INTO num_members (id,email,created_at) VALUES ('m_b','b@x.com',?)").run(T);
  db.prepare(`INSERT INTO num_referral_codes (code,owner_type,owner_id,active,created_at)
              VALUES ('PLAIN1','member','m_a',1,0)`).run();
  const r = await linkReferral(env(db), { memberId: 'm_b', code: 'PLAIN1' });
  assert.equal(r.ok, true);
  assert.equal(r.referrer, 'm_a');
});

/* ── connecting a member account ───────────────────────────────────────── */

test('a verified email on both sides connects the account', async () => {
  const db = freshDb();
  addAmb(db, { member: null });
  addMember(db, { id: 'm_rae', email: 'RAE@example.com', verified: 1 });
  const got = await connectMember(env(db), db.prepare('SELECT * FROM num_ambassadors WHERE id=?').get('a1'));
  assert.equal(got, 'm_rae');
});

test('an UNVERIFIED member email connects nothing — a typed string must not move money', async () => {
  const db = freshDb();
  addAmb(db, { member: null });
  addMember(db, { id: 'm_rae', verified: 0 });
  const got = await connectMember(env(db), db.prepare('SELECT * FROM num_ambassadors WHERE id=?').get('a1'));
  assert.equal(got, null);
});

test('a member account already claimed by another ambassador is not taken over', async () => {
  const db = freshDb();
  addAmb(db, { id: 'a1', code: 'ONEXK4P2', key: 'a'.repeat(30), member: 'm_rae' });
  addAmb(db, { id: 'a2', code: 'TWOXM9R3', key: 'b'.repeat(30), member: null, name: 'Impostor' });
  addMember(db, { id: 'm_rae', verified: 1 });
  const got = await connectMember(env(db), db.prepare('SELECT * FROM num_ambassadors WHERE id=?').get('a2'));
  assert.equal(got, null);
  assert.equal(db.prepare('SELECT member_id FROM num_ambassadors WHERE id=?').get('a1').member_id, 'm_rae');
});

test('a minted code survives the normalisation linkReferral does to it', async () => {
  const db = freshDb();
  for (let i = 0; i < 40; i++) {
    const code = await mintAmbCode(env(db), 'Rae Wilder');
    // This IS the bug the first version of this file shipped with, asserted.
    assert.equal(code, code.toUpperCase().replace(/[^A-Z0-9]/g, ''),
      `minted ${code}, which linkReferral would strip and then fail to find`);
    assert.ok(code.length >= 6 && code.length <= 10);
    assert.ok(!/[IO01]/.test(code.slice(4)), 'the random part must be readable off a screen');
  }
});

/* ── what the console says about money it cannot pay ────────────────────── */

test('an unconnected ambassador is told their link cannot pay, not shown a zero', async () => {
  const db = freshDb();
  addAmb(db, { member: null, email: 'nobody@example.com' });
  const j = await get(ambSummary, db);
  assert.equal(j.ok, true);
  assert.equal(j.payable, false);
  assert.match(j.payable_note, /cannot pay you yet/);
  assert.match(j.payable_note, /verify this same email/);
});

test('a connected ambassador is payable and the note goes away', async () => {
  const db = freshDb();
  addAmb(db, { member: 'm_rae' });
  addMember(db, { id: 'm_rae' });
  const j = await get(ambSummary, db);
  assert.equal(j.payable, true);
  assert.equal(j.payable_note, null);
  assert.equal(j.money.pct, 20);
});

test('opening the console connects a member account that has since appeared', async () => {
  const db = freshDb();
  addAmb(db, { member: null });
  addMember(db, { id: 'm_rae', verified: 1 });
  const j = await get(ambSummary, db);
  assert.equal(j.payable, true);
  assert.equal(db.prepare('SELECT member_id FROM num_ambassadors WHERE id=?').get('a1').member_id, 'm_rae');
});

test('the summary carries the link, the code and nothing that is not theirs', async () => {
  const db = freshDb();
  addAmb(db, {});
  const j = await get(ambSummary, db);
  assert.equal(j.link, 'https://itsnum.com/r/RAEK7M2Q');
  assert.equal(j.you.id, 'a1');
  assert.ok(!('console_key' in j.you), 'the key must never be echoed back into a page');
});

test('a bad key is 401 and not a hint', async () => {
  const db = freshDb();
  addAmb(db, {});
  const url = new URL('https://itsnum.com/api/amb/summary?k=' + 'z'.repeat(30));
  const res = await ambSummary(new Request(url), env(db), url, deps(db));
  assert.equal(res.status, 401);
});

/* ── what we say we offer ──────────────────────────────────────────────── */

test('hotels, cars and VIP services are listed as NOT live, by name', async () => {
  const keys = BENEFITS.soon.map((b) => b.key);
  for (const k of ['stays', 'cars', 'vip']) assert.ok(keys.includes(k), k + ' must be named as not-yet');
  const live = BENEFITS.live.map((b) => b.key);
  for (const k of ['stays', 'cars', 'vip']) assert.ok(!live.includes(k), k + ' is not live and must not be promised');
  // Every not-yet entry says WHY. "Coming soon" with no reason is how a
  // person ends up promising it anyway.
  for (const b of BENEFITS.soon) assert.ok(b.why && b.why.length > 20, b.key + ' needs a reason');
});

test('the concierge and the share are what is actually promised', async () => {
  const live = BENEFITS.live.map((b) => b.key);
  for (const k of ['concierge', 'referral', 'perks', 'activities', 'luggage', 'draw']) {
    assert.ok(live.includes(k), k);
  }
});

/* ── follower counts: two facts, never one ─────────────────────────────── */

test('a saved follower count lands in claimed and NEVER in verified', async () => {
  const db = freshDb();
  addAmb(db, {});
  const j = await post(ambSocial, db, { platform: 'instagram', handle: '@rae', followers: '128,400' });
  assert.equal(j.ok, true);
  const row = db.prepare('SELECT * FROM num_ambassador_socials WHERE id=?').get(j.id);
  assert.equal(row.followers_claimed, 128400);
  assert.equal(row.followers_verified, null);
  assert.equal(row.handle, 'rae', 'the @ is stripped so the unique index can see a duplicate');
});

test('followers_verified cannot be written from the endpoint a person can reach', async () => {
  const db = freshDb();
  addAmb(db, {});
  await post(ambSocial, db, {
    platform: 'tiktok', handle: 'rae', followers: 10,
    followers_verified: 9_000_000, verified_by: 'oauth',
  });
  const row = db.prepare("SELECT * FROM num_ambassador_socials WHERE platform='tiktok'").get();
  assert.equal(row.followers_verified, null);
  assert.equal(row.verified_by, null);
});

test('an empty follower box is "I did not say", not zero', async () => {
  const db = freshDb();
  addAmb(db, {});
  const j = await post(ambSocial, db, { platform: 'blog', handle: 'rae.dev', followers: '' });
  const row = db.prepare('SELECT * FROM num_ambassador_socials WHERE id=?').get(j.id);
  assert.equal(row.followers_claimed, null);
});

test('every rendered channel carries the basis of its number in words', async () => {
  const out = publicAmbassador({ id: 'a1', name: 'Rae' }, [
    { platform: 'instagram', handle: 'rae', followers_claimed: 100, followers_verified: null },
    { platform: 'youtube', handle: 'rae', followers_claimed: 100, followers_verified: 80 },
  ]);
  assert.equal(out.channels[0].basis, 'self-declared');
  assert.equal(out.channels[1].basis, 'confirmed by the platform');
  assert.equal(out.reach_claimed, 200);
  assert.equal(out.reach_verified, 80);
});

test('saving the same handle twice updates it rather than doubling their reach', async () => {
  const db = freshDb();
  addAmb(db, {});
  await post(ambSocial, db, { platform: 'instagram', handle: 'rae', followers: 100 });
  await post(ambSocial, db, { platform: 'instagram', handle: '@rae', followers: 150 });
  const all = db.prepare("SELECT * FROM num_ambassador_socials WHERE platform='instagram'").all();
  assert.equal(all.length, 1);
  assert.equal(all[0].followers_claimed, 150);
});

test('a platform we do not know is refused with the list, not stored as other', async () => {
  const db = freshDb();
  addAmb(db, {});
  const j = await post(ambSocial, db, { platform: 'myspace', handle: 'rae' });
  assert.equal(j.ok, false);
  assert.deepEqual(j.allowed, PLATFORMS);
});

test('nonsense follower counts are refused rather than clamped', async () => {
  const db = freshDb();
  addAmb(db, {});
  for (const n of ['-5', 'lots', '9999999999999']) {
    const j = await post(ambSocial, db, { platform: 'x', handle: 'rae', followers: n });
    assert.equal(j.ok, false, String(n));
  }
});

/* ── the directory ─────────────────────────────────────────────────────── */

test('the directory is off by default — listing is opted into, never defaulted', async () => {
  const db = freshDb();
  addAmb(db, { listed: 0 });
  const url = new URL('https://itsnum.com/api/amb/directory?k=hostkey');
  const j = await (await ambDirectory(new Request(url), env(db), url, deps(db, { host: { id: 'h1' } }))).json();
  assert.equal(j.ambassadors.length, 0);
  assert.match(j.note, /off by default/);
});

test('the directory refuses anybody who is not a host or a business', async () => {
  const db = freshDb();
  addAmb(db, { listed: 1 });
  const url = new URL('https://itsnum.com/api/amb/directory');
  const res = await ambDirectory(new Request(url), env(db), url, deps(db));
  assert.equal(res.status, 401);
});

test('a business sees the listed ambassador and NEVER their email or phone', async () => {
  const db = freshDb();
  addAmb(db, { listed: 1 });
  db.prepare("UPDATE num_ambassadors SET phone='+447700900000' WHERE id='a1'").run();
  await post(ambSocial, db, { platform: 'instagram', handle: 'rae', followers: 5000 });
  const url = new URL('https://itsnum.com/api/amb/directory?k=bizkey');
  const j = await (await ambDirectory(new Request(url), env(db), url, deps(db, { biz: { id: 'b1' } }))).json();
  assert.equal(j.ambassadors.length, 1);
  const a = j.ambassadors[0];
  assert.equal(a.reach_claimed, 5000);
  assert.ok(!('email' in a) && !('phone' in a), 'contact details are never in a directory row');
  assert.match(j.follower_counts, /Self-declared/);
});

test('an ambassador who has applied but not been accepted is not in the directory', async () => {
  const db = freshDb();
  addAmb(db, { listed: 1, status: 'applied' });
  const url = new URL('https://itsnum.com/api/amb/directory?k=hostkey');
  const j = await (await ambDirectory(new Request(url), env(db), url, deps(db, { host: { id: 'h1' } }))).json();
  assert.equal(j.ambassadors.length, 0);
});

/* ── offers and claims ─────────────────────────────────────────────────── */

function addOffer(db, { id = 'o1', title = 'Lisbon rooftop dinner', slots = null, status = 'open', ends = null } = {}) {
  db.prepare(`INSERT INTO num_ambassador_offers (id,posted_by_kind,title,they_get,we_ask,slots,status,ends_at,created_at)
              VALUES (?,'num',?, 'Dinner for two, on the house', 'One post and one story, tagging NUM', ?, ?, ?, ?)`)
    .run(id, title, slots, status, ends, T);
  return id;
}

test('an applicant who has not been accepted cannot claim', async () => {
  const db = freshDb();
  addAmb(db, { status: 'applied' });
  addOffer(db, {});
  const j = await post(ambClaim, db, { action: 'claim', offer_id: 'o1' });
  assert.equal(j.ok, false);
  assert.equal(j.error, 'not_active');
});

test('claiming twice is not an error and does not make two claims', async () => {
  const db = freshDb();
  addAmb(db, {});
  addOffer(db, {});
  assert.equal((await post(ambClaim, db, { action: 'claim', offer_id: 'o1' })).ok, true);
  const again = await post(ambClaim, db, { action: 'claim', offer_id: 'o1' });
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM num_ambassador_claims').get().n, 1);
});

test('the last slot goes to one person, and the other is told before they post', async () => {
  const db = freshDb();
  addAmb(db, { id: 'a1', code: 'ONEXK4P2', key: 'a'.repeat(30) });
  addAmb(db, { id: 'a2', code: 'TWOXM9R3', key: 'b'.repeat(30), email: 'two@example.com' });
  addOffer(db, { slots: 1 });
  const url1 = new URL('https://itsnum.com/api/amb/claim?k=' + 'a'.repeat(30));
  const url2 = new URL('https://itsnum.com/api/amb/claim?k=' + 'b'.repeat(30));
  const body = () => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'claim', offer_id: 'o1' }) });
  const a = await (await ambClaim(new Request(url1, body()), env(db), url1, deps(db))).json();
  const b = await (await ambClaim(new Request(url2, body()), env(db), url2, deps(db))).json();
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.error, 'full');
  assert.match(b.why, /Nothing was promised to your audience/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM num_ambassador_claims WHERE state<>'withdrawn'").get().n, 1);
});

test('"posted" without a link is refused with a sentence, not a 500', async () => {
  const db = freshDb();
  addAmb(db, {});
  addOffer(db, {});
  await post(ambClaim, db, { action: 'claim', offer_id: 'o1' });
  const j = await post(ambClaim, db, { action: 'posted', offer_id: 'o1', post_url: 'not a url' });
  assert.equal(j.ok, false);
  assert.equal(j.error, 'post_url');
});

test('a post URL cannot be filed against an offer that was never claimed', async () => {
  const db = freshDb();
  addAmb(db, {});
  addOffer(db, {});
  const j = await post(ambClaim, db, { action: 'posted', offer_id: 'o1', post_url: 'https://instagram.com/p/x' });
  assert.equal(j.error, 'not_claimed');
});

test('claiming, posting and withdrawing walk the states the table allows', async () => {
  const db = freshDb();
  addAmb(db, {});
  addOffer(db, {});
  await post(ambClaim, db, { action: 'claim', offer_id: 'o1' });
  await post(ambClaim, db, { action: 'posted', offer_id: 'o1', post_url: 'https://instagram.com/p/x' });
  let row = db.prepare('SELECT * FROM num_ambassador_claims').get();
  assert.equal(row.state, 'posted');
  assert.equal(row.post_url, 'https://instagram.com/p/x');
  await post(ambClaim, db, { action: 'withdraw', offer_id: 'o1' });
  row = db.prepare('SELECT * FROM num_ambassador_claims').get();
  assert.equal(row.state, 'withdrawn');
  for (const s of OFFER_STATES) assert.ok(typeof s === 'string');
});

test('a closed offer is not on the list and cannot be claimed', async () => {
  const db = freshDb();
  addAmb(db, {});
  addOffer(db, { id: 'o1', status: 'closed' });
  const list = await get(ambOffers, db);
  assert.equal(list.offers.length, 0);
  assert.match(list.note, /Your link and your share work regardless/);
  const j = await post(ambClaim, db, { action: 'claim', offer_id: 'o1' });
  assert.equal(j.error, 'closed');
});

test('an offer that has ended is gone from the list', async () => {
  const db = freshDb();
  addAmb(db, {});
  addOffer(db, { id: 'o1', ends: '2020-01-01' });
  addOffer(db, { id: 'o2', ends: '2099-01-01' });
  const list = await get(ambOffers, db);
  assert.deepEqual(list.offers.map((o) => o.id), ['o2']);
});

test('a full offer stays visible to the person who already took it', async () => {
  const db = freshDb();
  addAmb(db, {});
  addOffer(db, { slots: 1 });
  await post(ambClaim, db, { action: 'claim', offer_id: 'o1' });
  const list = await get(ambOffers, db);
  assert.equal(list.offers[0].full, true);
  assert.equal(list.offers[0].mine, 'claimed');
});

/* ── the profile and the switch ────────────────────────────────────────── */

test('the directory switch is the one field here with a consequence, and it saves', async () => {
  const db = freshDb();
  addAmb(db, { listed: 0 });
  const j = await post(ambProfile, db, { name: 'Rae W', city: 'Porto', bio: 'Slow travel, small places.', listed: true });
  assert.equal(j.listed, true);
  const row = db.prepare('SELECT * FROM num_ambassadors WHERE id=?').get('a1');
  assert.equal(row.city, 'Porto');
  assert.equal(row.listed, 1);
});

test('leaving listed out of the body does not silently turn it on or off', async () => {
  const db = freshDb();
  addAmb(db, { listed: 1 });
  await post(ambProfile, db, { city: 'Porto' });
  assert.equal(db.prepare('SELECT listed FROM num_ambassadors WHERE id=?').get('a1').listed, 1);
});

test('the platform list and the claim states match the CHECK constraints', async () => {
  const sql = readFileSync(new URL('../worker/migrations/0051_ambassadors.sql', import.meta.url), 'utf8');
  for (const p of PLATFORMS) assert.ok(sql.includes(`'${p}'`), p + ' is not in the migration CHECK');
  for (const s of OFFER_STATES) assert.ok(sql.includes(`'${s}'`), s + ' is not in the migration CHECK');
});

test('a real post URL survives sanitising — the bug the live console found', async () => {
  // Shipped 19 Sep and caught by pasting a link into the deployed console,
  // not by any test here: post_url went through `clean`, the NAME whitelist,
  // which strips ':' and '/'. "https://instagram.com/p/x" became
  // "https //instagram.com p x" and was then refused for not being a URL, so
  // an ambassador who had done exactly what was asked was told their link was
  // not a link.
  const db = freshDb();
  addAmb(db, {});
  addOffer(db, {});
  await post(ambClaim, db, { action: 'claim', offer_id: 'o1' });
  for (const u of ['https://instagram.com/p/abc123',
    'https://www.tiktok.com/@someone/video/7412345678901234567',
    'https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s']) {
    const j = await post(ambClaim, db, { action: 'posted', offer_id: 'o1', post_url: u });
    assert.equal(j.ok, true, u + ' was refused');
    const row = db.prepare('SELECT post_url FROM num_ambassador_claims').get();
    assert.ok(row.post_url.startsWith('https://'), 'stored as ' + row.post_url);
    assert.ok(row.post_url.includes('/'), 'the path was stripped: ' + row.post_url);
  }
});

test('a javascript: or data: URL is never stored as a post', async () => {
  const db = freshDb();
  addAmb(db, {});
  addOffer(db, {});
  await post(ambClaim, db, { action: 'claim', offer_id: 'o1' });
  for (const u of ['javascript:alert(1)', 'data:text/html,<script>x</script>']) {
    const j = await post(ambClaim, db, { action: 'posted', offer_id: 'o1', post_url: u });
    assert.equal(j.ok, false, u + ' was accepted');
  }
});
