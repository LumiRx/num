// The chain from notify() to a phone, and the two routes that did not exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { notifyAll, pushNative, handlePush } from './push.mjs';
import { _resetTokenCache } from './apns.mjs';

// Every migration that touches the notification tables, in order, found rather
// than listed: a hard-coded '0024' went stale the day 0027 added the subtitle
// column, and the test failed for a reason that had nothing to do with the code
// under test.
const MIGDIR = new URL('./migrations/', import.meta.url);
const MIG = readdirSync(MIGDIR)
  .filter((n) => n.endsWith('.sql')).sort()
  .map((n) => readFileSync(new URL(n, MIGDIR), 'utf8'))
  .filter((sql) => /num_notifications|num_push_|num_notify_/.test(sql))
  .join(';\n');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  // The two tables push.mjs creates for itself, as they exist in production.
  db.exec(`CREATE TABLE num_push_subs (endpoint TEXT PRIMARY KEY, member_id TEXT, ua TEXT,
    created_at TEXT DEFAULT (datetime('now')), last_ok TEXT, fails INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`CREATE TABLE num_notifications (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, kind TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT, url TEXT, tag TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT, read_at TEXT)`);
  for (const raw of MIG.split(';')) {
    const stmt = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (!stmt) continue;
    try { db.exec(stmt + ';'); } catch (e) { throw new Error('notification migration failed: ' + e.message + ' :: ' + stmt.slice(0, 60)); }
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
const d1 = (db) => ({
  prepare(sql) {
    const binds = [];
    const go = (fn) => { const e = expand(sql, binds); return db.prepare(e.sql)[fn](...e.args); };
    const api = {
      bind(...a) { binds.push(...a); return api; },
      async first() { return go('all')[0] ?? null; },
      async all() { return { results: go('all') }; },
      async run() { const r = go('run'); return { ...r, meta: { changes: Number(r.changes ?? 0) } }; },
      _run: () => go('run'),
    };
    return api;
  },
  async batch(stmts) { return stmts.map((s) => s._run()); },
});

async function p8() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))));
  return '-----BEGIN PRIVATE KEY-----\n' + b64.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
}
const apnsEnv = (pem) => ({
  APNS_KEY_P8: pem, APNS_KEY_ID: 'ABC1234567', APNS_TEAM_ID: 'TEAM123456', APNS_BUNDLE_ID: 'com.itsnum.app',
});

function fakeApns(reply = { status: 200 }) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers });
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  };
  return calls;
}

const tok = (db, over = {}) => {
  const r = { id: 'pt1', member_id: 'm1', token: 'a'.repeat(64), platform: 'ios', environment: 'production', bundle_id: 'com.itsnum.app', ...over };
  db.prepare(`INSERT INTO num_push_tokens (id,member_id,token,platform,environment,bundle_id,created_at)
              VALUES (?,?,?,?,?,?,datetime('now'))`)
    .run(r.id, r.member_id, r.token, r.platform, r.environment, r.bundle_id);
  return r;
};

/* ── the fan-out ───────────────────────────────────────────────────────── */

test('a notification reaches an iPhone through the token the app registered', async () => {
  _resetTokenCache();
  const db = freshDb();
  tok(db);
  const calls = fakeApns();
  const out = await pushNative({ DB: d1(db), ...apnsEnv(await p8()) }, {
    memberId: 'm1', title: 'A boat is free Saturday', body: 'Out of Royal Phuket', url: '/?go=charter', kind: 'suggestion',
  });
  assert.equal(out.sent, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/3\/device\/a{64}$/);
  assert.equal(db.prepare(`SELECT fails, last_ok FROM num_push_tokens`).get().fails, 0);
  assert.ok(db.prepare(`SELECT last_ok FROM num_push_tokens`).get().last_ok, 'a success must be recorded');
});

test('notifyAll writes the row AND reports how many devices it actually reached', async () => {
  _resetTokenCache();
  const db = freshDb();
  tok(db);
  fakeApns();
  const out = await notifyAll({ DB: d1(db), ...apnsEnv(await p8()) }, {
    memberId: 'm1', kind: 'suggestion', title: 'A boat', body: 'Saturday',
  });
  assert.equal(out.reached, 1, 'reached is the number that matters — queued is what let 116 of 117 look fine');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM num_notifications`).get().n, 1);
});

test('reaching nobody is reported as nobody, not as success', async () => {
  _resetTokenCache();
  const db = freshDb();
  const out = await notifyAll({ DB: d1(db) }, { memberId: 'm1', kind: 'suggestion', title: 'A boat' });
  assert.equal(out.reached, 0, 'this is the whole bug: 117 written, 1 delivered, every call returning ok');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM num_notifications`).get().n, 1,
    'the row is still written, so it shows next time they open the app');
});

test('a dead token is disabled with Apple reason on it, and never tried again', async () => {
  _resetTokenCache();
  const db = freshDb();
  tok(db);
  fakeApns({ status: 410, body: { reason: 'Unregistered' } });
  const out = await pushNative({ DB: d1(db), ...apnsEnv(await p8()) }, { memberId: 'm1', title: 'x' });
  assert.equal(out.sent, 0);
  const row = db.prepare(`SELECT disabled_at, disabled_reason FROM num_push_tokens`).get();
  assert.ok(row.disabled_at);
  assert.equal(row.disabled_reason, 'apns:Unregistered', 'months later, "why did we stop" must still be answerable');

  // And the next send must skip it entirely.
  const calls = fakeApns();
  const again = await pushNative({ DB: d1(db), ...apnsEnv(await p8()) }, { memberId: 'm1', title: 'x' });
  assert.equal(again.tokens, 0);
  assert.equal(calls.length, 0, 'retrying a dead token forever is what gets a provider throttled');
});

test('a busy server increments fails but keeps the token alive', async () => {
  _resetTokenCache();
  const db = freshDb();
  tok(db);
  fakeApns({ status: 503, body: { reason: 'ServiceUnavailable' } });
  await pushNative({ DB: d1(db), ...apnsEnv(await p8()) }, { memberId: 'm1', title: 'x' });
  const row = db.prepare(`SELECT fails, disabled_at FROM num_push_tokens`).get();
  assert.equal(row.fails, 1);
  assert.equal(row.disabled_at, null, "Apple being busy says nothing about whether the phone exists");
});

test('an unconfigured APNs says which secrets are missing instead of failing quietly', async () => {
  const db = freshDb();
  tok(db);
  const out = await pushNative({ DB: d1(db) }, { memberId: 'm1', title: 'x' });
  assert.equal(out.sent, 0);
  assert.match(out.note, /APNS_KEY_P8/);
});

test('an Android token is skipped rather than sent to Apple', async () => {
  _resetTokenCache();
  const db = freshDb();
  tok(db, { id: 'pt2', token: 'b'.repeat(64), platform: 'android' });
  const calls = fakeApns();
  const out = await pushNative({ DB: d1(db), ...apnsEnv(await p8()) }, { memberId: 'm1', title: 'x' });
  assert.equal(calls.length, 0, 'an FCM token is not an APNs token and sending it is a guaranteed BadDeviceToken');
  assert.equal(out.sent, 0);
});

test('one member cannot be reached through another member device', async () => {
  _resetTokenCache();
  const db = freshDb();
  tok(db, { member_id: 'someone-else' });
  const calls = fakeApns();
  const out = await pushNative({ DB: d1(db), ...apnsEnv(await p8()) }, { memberId: 'm1', title: 'x' });
  assert.equal(out.tokens, 0);
  assert.equal(calls.length, 0);
});

/* ── the route the app has been POSTing into a void ───────────────────── */

const POST = (path, body) => new Request(`https://app.itsnum.com/api/push${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('registering a token stores it, so a granted permission is not thrown away', async () => {
  const db = freshDb();
  const res = await handlePush(POST('/native', {
    token: 'c'.repeat(64), me: 'm1', platform: 'ios', app_version: '1.0.5', device_model: 'iPhone15,2',
  }), { DB: d1(db), ...apnsEnv(await p8()) }, '/native');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.sendable, true);
  const row = db.prepare(`SELECT * FROM num_push_tokens`).get();
  assert.equal(row.member_id, 'm1');
  assert.equal(row.platform, 'ios');
  assert.equal(row.environment, 'production');
  assert.equal(row.app_version, '1.0.5');
});

test('it says plainly when a token is stored but cannot yet be used', async () => {
  const db = freshDb();
  const body = await (await handlePush(POST('/native', { token: 'c'.repeat(64), me: 'm1', platform: 'ios' }), { DB: d1(db) }, '/native')).json();
  assert.equal(body.ok, true);
  assert.equal(body.sendable, false, 'a bare ok here would mean "stored and unusable"');
  assert.match(body.note, /APNS_KEY_P8/);
});

test('re-registering the same device updates its row instead of adding a second', async () => {
  const db = freshDb();
  const env = { DB: d1(db), ...apnsEnv(await p8()) };
  const t = 'd'.repeat(64);
  await handlePush(POST('/native', { token: t, me: 'm1', platform: 'ios', app_version: '1.0.4' }), env, '/native');
  await handlePush(POST('/native', { token: t, me: 'm1', platform: 'ios', app_version: '1.0.5' }), env, '/native');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM num_push_tokens`).get().n, 1,
    'two rows for one device means every notification arrives twice, which is worse than not arriving');
  assert.equal(db.prepare(`SELECT app_version FROM num_push_tokens`).get().app_version, '1.0.5');
});

test('a reinstalled app revives a token we had disabled', async () => {
  const db = freshDb();
  const env = { DB: d1(db), ...apnsEnv(await p8()) };
  const t = 'e'.repeat(64);
  tok(db, { token: t });
  db.prepare(`UPDATE num_push_tokens SET disabled_at=datetime('now'), disabled_reason='apns:Unregistered', fails=9`).run();
  await handlePush(POST('/native', { token: t, me: 'm1', platform: 'ios' }), env, '/native');
  const row = db.prepare(`SELECT disabled_at, fails FROM num_push_tokens`).get();
  assert.equal(row.disabled_at, null, 'Apple says a token can come back — and then we must use it again');
  assert.equal(row.fails, 0);
});

test('junk is refused rather than stored in a table whose job is to be dialled', async () => {
  const db = freshDb();
  const env = { DB: d1(db), ...apnsEnv(await p8()) };
  for (const bad of [
    { me: 'm1', platform: 'ios' },
    { token: 'x'.repeat(64), platform: 'ios' },
    { token: 'x'.repeat(64), me: 'm1', platform: 'windows' },
    { token: 'not-hex-at-all!!', me: 'm1', platform: 'ios' },
  ]) {
    const res = await handlePush(POST('/native', bad), env, '/native');
    assert.equal(res.status, 400, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM num_push_tokens`).get().n, 0);
});

test('a sandbox build is recorded as sandbox', async () => {
  const db = freshDb();
  await handlePush(POST('/native', { token: 'f'.repeat(64), me: 'm1', platform: 'ios', environment: 'sandbox' }),
    { DB: d1(db), ...apnsEnv(await p8()) }, '/native');
  assert.equal(db.prepare(`SELECT environment FROM num_push_tokens`).get().environment, 'sandbox');
});

/* ── making reading measurable ─────────────────────────────────────────── */

const notif = (db, id = 'n1', member = 'm1') =>
  db.prepare(`INSERT INTO num_notifications (id, member_id, kind, title) VALUES (?,?,'suggestion','A boat')`).run(id, member);

test('marking read writes read_at — which nothing has ever done before', async () => {
  const db = freshDb();
  notif(db);
  const body = await (await handlePush(POST('/read', { me: 'm1', id: 'n1' }), { DB: d1(db) }, '/read')).json();
  assert.equal(body.ok, true);
  assert.equal(body.marked, 1);
  assert.ok(db.prepare(`SELECT read_at FROM num_notifications WHERE id='n1'`).get().read_at,
    'without this there is no way to tell a welcome suggestion from noise');
});

test('tapping through records acted, and a tapped notification counts as read', async () => {
  const db = freshDb();
  notif(db);
  const body = await (await handlePush(POST('/read', { me: 'm1', id: 'n1', acted: true }), { DB: d1(db) }, '/read')).json();
  assert.equal(body.acted, true);
  const row = db.prepare(`SELECT read_at, acted_at FROM num_notifications WHERE id='n1'`).get();
  assert.ok(row.acted_at, 'acted is the only number that says a notification earned its interruption');
  assert.ok(row.read_at, 'setting only acted_at would leave a tapped notification looking unseen');
});

test('one person cannot mark another persons notifications read', async () => {
  const db = freshDb();
  notif(db, 'n1', 'someone-else');
  const body = await (await handlePush(POST('/read', { me: 'm1', id: 'n1' }), { DB: d1(db) }, '/read')).json();
  assert.equal(body.marked, 0);
  assert.equal(db.prepare(`SELECT read_at FROM num_notifications WHERE id='n1'`).get().read_at, null);
});

test('reading twice keeps the FIRST time, not the latest', async () => {
  const db = freshDb();
  notif(db);
  db.prepare(`UPDATE num_notifications SET read_at='2026-01-01 00:00:00' WHERE id='n1'`).run();
  await handlePush(POST('/read', { me: 'm1', id: 'n1' }), { DB: d1(db) }, '/read');
  assert.equal(db.prepare(`SELECT read_at FROM num_notifications WHERE id='n1'`).get().read_at, '2026-01-01 00:00:00',
    'when they first saw it is the fact worth keeping');
});

test('a batch marks many at once and is capped', async () => {
  const db = freshDb();
  for (let i = 0; i < 60; i++) notif(db, 'n' + i);
  const body = await (await handlePush(
    POST('/read', { me: 'm1', ids: Array.from({ length: 60 }, (_, i) => 'n' + i) }), { DB: d1(db) }, '/read',
  )).json();
  assert.equal(body.marked, 50, 'a cap keeps one request from rewriting the whole table');
});

test('a read call with nothing to mark is refused, not silently ok', async () => {
  const db = freshDb();
  assert.equal((await handlePush(POST('/read', { me: 'm1' }), { DB: d1(db) }, '/read')).status, 400);
  assert.equal((await handlePush(POST('/read', { id: 'n1' }), { DB: d1(db) }, '/read')).status, 400);
});
