// The endpoints, exercised. Not "was a function called" — what is in the
// database afterwards, and what a host is told when it refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  hostAssets, hostAssetPhoto, hostAssetHolds, offerableAssets, assetImage,
  clientView, rateMinor, sqlTime, KINDS,
} from './hostassets.mjs';

const SQL = readFileSync(new URL('../worker/migrations/0021_luxury_assets.sql', import.meta.url), 'utf8');
const SUP = readFileSync(new URL('../worker/migrations/0019_suppliers.sql', import.meta.url), 'utf8');
// 0022 is loaded too. It puts phone on num_suppliers, and resolveSupplier
// selects that column — a harness without it is a different database from
// production, which is the whole failure this file exists to catch.
const SUP2 = readFileSync(new URL('../worker/migrations/0022_supplier_contact.sql', import.meta.url), 'utf8');
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_members (id TEXT PRIMARY KEY, phone TEXT, phone_verified INTEGER DEFAULT 0);`);
  db.exec(`CREATE TABLE num_hosts (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active', console_key TEXT, currency TEXT DEFAULT 'GBP');`);
  for (const raw of (SUP + '\n' + SQL + '\n' + SUP2).split(';')) {
    const stmt = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (!stmt) continue;
    try { db.exec(stmt + ';'); } catch { /* not for this test's tables */ }
  }
  db.prepare(`INSERT INTO num_hosts (id,name,console_key) VALUES ('h1','Host One','key-one')`).run();
  db.prepare(`INSERT INTO num_hosts (id,name,console_key) VALUES ('h2','Host Two','key-two')`).run();
  return db;
}

const nz = (v) => (v === undefined ? null : v);

// D1 in the shape the Worker code calls it, including NUMBERED parameters.
//
// A naive stub that just does sql.replace(/\?\d+/g,'?') is wrong and silently
// so: SQLite lets ?1 appear twice and bind once, and a statement that reuses a
// timestamp (every UPDATE in this codebase does) then gets the wrong number of
// binds and throws. A harness that cannot run the real statements would have
// let a broken UPDATE ship — which is exactly what it caught.
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
      // D1 reports changes as result.meta.changes; node:sqlite reports
      // result.changes. The retire handler checks meta.changes to tell "nothing
      // of yours has that id" from "done", so a stub that does not reshape this
      // leaves that branch permanently untested.
      async run() { const r = go('run'); return { ...r, meta: { changes: Number(r.changes ?? 0) } }; },
    };
    return api;
  },
});

// The deps, the same shape growth/worker.js hands over.
//
// `clean` drops control characters and NOTHING else. It must not touch hyphens:
// every registration, date and id in these tests contains one, and a stub that
// quietly reshaped them would mean the assertions were testing the stub instead
// of the handler.
const stripControl = (s) => String(s).split('')
  .filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127).join('');

function deps(db, { hostId = 'h1' } = {}) {
  return {
    J: (obj, status = 200) => new Response(JSON.stringify(obj), {
      status, headers: { 'content-type': 'application/json' },
    }),
    clean: (s, max = 200) => (s === null || s === undefined ? '' : stripControl(s).trim().slice(0, max)),
    readJSON: async (req) => req.json(),
    badOrigin: () => false,
    hostAuth: async () => (hostId ? db.prepare(`SELECT * FROM num_hosts WHERE id=?`).get(hostId) : null),
  };
}

const POST = (body) => new Request('https://itsnum.com/api/host/assets', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const GET = () => new Request('https://itsnum.com/api/host/assets');
const U = (qs = '') => new URL('https://itsnum.com/api/host/assets?k=key-one' + qs);
const jsonOf = async (res) => res.json();
const photoPost = (body) => new Request('https://itsnum.com/api/host/asset-photo', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const holdPost = (body) => new Request('https://itsnum.com/api/host/asset-holds', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

async function withAsset(db, extra = {}) {
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,created_at)
              VALUES ('a1','supplier','h1','h1','yacht','Serenity II','quote',?)`).run(ts());
  if (extra.photo) {
    // reject_note is not optional for a rejected photo — there is a CHECK, and
    // it is right: a photo turned away with no reason is a decision the host
    // cannot explain to the supplier who sent it.
    // Two CHECKs apply to a photo that is no longer 'new', and both are right:
    // a rejection must carry a reason (the host has to be able to tell the
    // supplier why) and any decision must carry its timestamp (an undated
    // decision cannot be audited or undone).
    db.prepare(`INSERT INTO num_asset_photos
                  (id,asset_id,r2_key,content_type,source,sha256,moderation,reject_note,decided_at,decided_by,position,created_at)
                VALUES ('p1','a1','k','image/jpeg','mms','s1',?,?,?,?,1,?)`)
      .run(
        extra.photo,
        extra.photo === 'rejected' ? 'too dark' : null,
        extra.photo === 'new' ? null : ts(),
        extra.photo === 'new' ? null : 'host:h1',
        ts(),
      );
  }
}

const r2 = (objects = {}) => ({
  async get(k) { return objects[k] ? { body: objects[k] } : null; },
});

/* the small parts */

test('a rate typed the way a host types it becomes the right integer', () => {
  assert.equal(rateMinor('1250'), 125000);
  assert.equal(rateMinor('1,250'), 125000);
  assert.equal(rateMinor('1250.00'), 125000);
  assert.equal(rateMinor('1250.5'), 125050);
  assert.equal(rateMinor(''), 0);
  assert.equal(rateMinor(null), 0);
  assert.equal(rateMinor('-5'), 500, 'a minus sign is stripped, never negated into a credit');
});

test('dates land in one shape, so string comparison is not quietly wrong', () => {
  assert.equal(sqlTime('2026-09-20'), '2026-09-20 00:00:00');
  assert.equal(sqlTime('2026-09-20T14:30'), '2026-09-20 14:30:00');
  assert.equal(sqlTime('2026-09-20 14:30:00'), '2026-09-20 14:30:00');
  assert.equal(sqlTime('nonsense'), null);
  assert.equal(sqlTime(''), null);
  assert.ok('2026-09-20 00:00:00' < '2026-09-21 00:00:00');
});

test('the client view carries the boat and not the hull identity', () => {
  const v = clientView({
    id: 'a1', kind: 'yacht', name: 'Serenity II', registration: 'SSR-8891',
    notes: 'owner is difficult about shoes', owner_id: 's1', host_id: 'h1',
    verify_note: 'checked the papers', settle_mode: 'num_collects', rate_minor: 500000,
  });
  assert.equal(v.name, 'Serenity II');
  assert.equal(v.rate_minor, 500000);
  const flat = JSON.stringify(v);
  assert.ok(!flat.includes('SSR-8891'), 'a registration reached a client');
  assert.ok(!flat.includes('shoes'), 'a private note reached a client');
  assert.ok(!flat.includes('num_collects'));
});

/* creating */

test('saving a boat stores it against the host and starts it NOT live', async () => {
  const db = freshDb();
  const out = await jsonOf(await hostAssets(POST({
    kind: 'yacht', name: 'Serenity II', make: 'Sunseeker', model: 'Manhattan 68',
    year: '2019', registration: 'SSR-8891', home_port: 'Royal Phuket Marina',
    home_city: 'Phuket', guests: '8', crew: '3', rate_minor: '4500', rate_unit: 'day',
  }), { DB: d1(db) }, U(), deps(db)));
  assert.equal(out.ok, true);

  const a = db.prepare(`SELECT * FROM num_assets`).get();
  assert.equal(a.host_id, 'h1');
  assert.equal(a.name, 'Serenity II');
  assert.equal(a.rate_minor, 450000, '4500 a day is 450000 minor units');
  assert.equal(a.rate_unit, 'day');
  assert.equal(a.guests, 8);
  assert.equal(a.listable, 0, 'nothing is live the moment it is typed in');
  assert.equal(a.owner_id, 'h1', 'a host who owns the boat is their own supplier');
  assert.equal(a.registration, 'SSR-8891', 'we keep it; we just never send it');
});

test('a day rate with no number is refused in words, not by a constraint', async () => {
  const db = freshDb();
  const out = await jsonOf(await hostAssets(
    POST({ kind: 'boat', name: 'Free Boat', rate_unit: 'day' }), { DB: d1(db) }, U(), deps(db),
  ));
  assert.equal(out.ok, false);
  assert.equal(out.error, 'no_rate');
  assert.match(out.says, /quote/i, 'the refusal must say what to do instead');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM num_assets`).get().n, 0);
});

test('a kind we do not handle is refused with the list of ones we do', async () => {
  const db = freshDb();
  const out = await jsonOf(await hostAssets(
    POST({ kind: 'submarine', name: 'Nautilus' }), { DB: d1(db) }, U(), deps(db),
  ));
  assert.equal(out.ok, false);
  assert.deepEqual(out.allowed, KINDS);
});

test('no name is refused — a nameless boat is unbookable', async () => {
  const db = freshDb();
  const out = await jsonOf(await hostAssets(POST({ kind: 'boat' }), { DB: d1(db) }, U(), deps(db)));
  assert.equal(out.error, 'no_name');
});

test('no console key means no fleet', async () => {
  const db = freshDb();
  const res = await hostAssets(GET(), { DB: d1(db) }, U(), deps(db, { hostId: null }));
  assert.equal(res.status, 401);
});

test('a host sees their own fleet and not another hosts', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,created_at)
              VALUES ('mine','supplier','h1','h1','boat','Mine','quote',?)`).run(ts());
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,created_at)
              VALUES ('theirs','supplier','h2','h2','boat','Theirs','quote',?)`).run(ts());
  const out = await jsonOf(await hostAssets(GET(), { DB: d1(db) }, U(), deps(db)));
  assert.equal(out.assets.length, 1);
  assert.equal(out.assets[0].id, 'mine');
});

test('retiring sets retired_at and takes it off the shelf', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,listable,created_at)
              VALUES ('a1','supplier','h1','h1','boat','Old','quote',0,?)`).run(ts());
  await hostAssets(POST({ action: 'retire', id: 'a1' }), { DB: d1(db) }, U(), deps(db));
  const a = db.prepare(`SELECT * FROM num_assets WHERE id='a1'`).get();
  assert.equal(a.status, 'retired');
  assert.ok(a.retired_at, 'the CHECK refuses a retired row with no date');
  assert.equal(a.listable, 0);
});

/* going live, and the guard */

test('going live is refused without an approved photo, and says why', async () => {
  const db = freshDb();
  await withAsset(db, { photo: 'new' });
  const out = await jsonOf(await hostAssetPhoto(
    photoPost({ action: 'listable', asset_id: 'a1', listable: 1 }), { DB: d1(db) }, U(), deps(db),
  ));
  assert.equal(out.ok, false);
  assert.equal(out.error, 'no_approved_photo');
  assert.match(out.says, /approved photo/i);
  assert.equal(db.prepare(`SELECT listable FROM num_assets WHERE id='a1'`).get().listable, 0);
});

test('the thing the refusal asks for actually works, and then going live works', async () => {
  const db = freshDb();
  await withAsset(db, { photo: 'new' });
  const env = { DB: d1(db) };
  const mod = await jsonOf(await hostAssetPhoto(
    photoPost({ action: 'moderate', photo_id: 'p1', moderation: 'ok' }), env, U(), deps(db),
  ));
  assert.equal(mod.ok, true);
  const live = await jsonOf(await hostAssetPhoto(
    photoPost({ action: 'listable', asset_id: 'a1', listable: 1 }), env, U(), deps(db),
  ));
  assert.equal(live.ok, true);
  assert.equal(db.prepare(`SELECT listable FROM num_assets WHERE id='a1'`).get().listable, 1);
});

test('a rejected photo does not count towards going live', async () => {
  const db = freshDb();
  await withAsset(db, { photo: 'rejected' });
  const out = await jsonOf(await hostAssetPhoto(
    photoPost({ action: 'listable', asset_id: 'a1', listable: 1 }), { DB: d1(db) }, U(), deps(db),
  ));
  assert.equal(out.error, 'no_approved_photo');
});

test('a host cannot moderate a photo on somebody elses asset', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,created_at)
              VALUES ('a2','supplier','h2','h2','boat','Theirs','quote',?)`).run(ts());
  db.prepare(`INSERT INTO num_asset_photos (id,asset_id,r2_key,content_type,source,sha256,moderation,position,created_at)
              VALUES ('p9','a2','k','image/jpeg','mms','s9','new',1,?)`).run(ts());
  const out = await jsonOf(await hostAssetPhoto(
    photoPost({ action: 'moderate', photo_id: 'p9', moderation: 'ok' }), { DB: d1(db) }, U(), deps(db),
  ));
  assert.equal(out.error, 'not_your_photo');
  assert.equal(db.prepare(`SELECT moderation FROM num_asset_photos WHERE id='p9'`).get().moderation, 'new');
});

test('a host cannot file a photo against somebody elses asset', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,created_at)
              VALUES ('a2','supplier','h2','h2','boat','Theirs','quote',?)`).run(ts());
  db.prepare(`INSERT INTO num_inbound_media (id,from_hash,r2_key,content_type,sha256,status,created_at)
              VALUES ('m1','h','k','image/jpeg','s1','new',?)`).run(ts());
  const out = await jsonOf(await hostAssetPhoto(
    photoPost({ action: 'attach', media_id: 'm1', asset_id: 'a2' }), { DB: d1(db) }, U(), deps(db),
  ));
  assert.equal(out.error, 'not_your_asset');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM num_asset_photos`).get().n, 0);
});

test('binning a photo marks it discarded and leaves it out of the queue', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_inbound_media (id,from_hash,r2_key,content_type,sha256,status,created_at)
              VALUES ('m1','h','k','image/jpeg','s1','new',?)`).run(ts());
  await hostAssetPhoto(photoPost({ action: 'discard', media_id: 'm1' }), { DB: d1(db) }, U(), deps(db));
  assert.equal(db.prepare(`SELECT status FROM num_inbound_media WHERE id='m1'`).get().status, 'discarded');
  const out = await jsonOf(await hostAssets(GET(), { DB: d1(db) }, U(), deps(db)));
  assert.equal(out.queue.length, 0);
});

test('an unknown action is refused rather than quietly doing nothing', async () => {
  const db = freshDb();
  const out = await jsonOf(await hostAssetPhoto(
    photoPost({ action: 'delete_everything' }), { DB: d1(db) }, U(), deps(db),
  ));
  assert.equal(out.error, 'unknown_action');
});

/* the calendar, and the clash */

test('a hold is stored and read back', async () => {
  const db = freshDb();
  await withAsset(db);
  const out = await jsonOf(await hostAssetHolds(
    holdPost({ asset_id: 'a1', kind: 'booked', starts_at: '2026-09-20', ends_at: '2026-09-24' }),
    { DB: d1(db) }, U(), deps(db),
  ));
  assert.equal(out.ok, true);
  const h = db.prepare(`SELECT * FROM num_asset_holds`).get();
  assert.equal(h.kind, 'booked');
  assert.equal(h.starts_at, '2026-09-20 00:00:00');
});

test('THE ONE THAT MATTERS: a second booking over the first is refused', async () => {
  const db = freshDb();
  await withAsset(db);
  const env = { DB: d1(db) };
  await hostAssetHolds(holdPost({ asset_id: 'a1', kind: 'booked', starts_at: '2026-09-20', ends_at: '2026-09-24' }), env, U(), deps(db));
  const clash = await jsonOf(await hostAssetHolds(
    holdPost({ asset_id: 'a1', kind: 'booked', starts_at: '2026-09-22', ends_at: '2026-09-26' }), env, U(), deps(db),
  ));
  assert.equal(clash.ok, false);
  assert.equal(clash.error, 'clash');
  assert.match(clash.says, /Serenity II/, 'the refusal must name the boat');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM num_asset_holds`).get().n, 1);
});

test('a booking that merely touches the end of another is allowed', async () => {
  const db = freshDb();
  await withAsset(db);
  const env = { DB: d1(db) };
  await hostAssetHolds(holdPost({ asset_id: 'a1', kind: 'booked', starts_at: '2026-09-20', ends_at: '2026-09-24' }), env, U(), deps(db));
  const out = await jsonOf(await hostAssetHolds(
    holdPost({ asset_id: 'a1', kind: 'booked', starts_at: '2026-09-24', ends_at: '2026-09-28' }), env, U(), deps(db),
  ));
  assert.equal(out.ok, true, 'back-to-back charters are normal business, not a clash');
});

test('a booking entirely inside another is refused', async () => {
  const db = freshDb();
  await withAsset(db);
  const env = { DB: d1(db) };
  await hostAssetHolds(holdPost({ asset_id: 'a1', kind: 'booked', starts_at: '2026-09-20', ends_at: '2026-09-30' }), env, U(), deps(db));
  const out = await jsonOf(await hostAssetHolds(
    holdPost({ asset_id: 'a1', kind: 'booked', starts_at: '2026-09-22', ends_at: '2026-09-23' }), env, U(), deps(db),
  ));
  assert.equal(out.error, 'clash');
});

test('a pencilled hold also blocks the hull', async () => {
  const db = freshDb();
  await withAsset(db);
  const env = { DB: d1(db) };
  await hostAssetHolds(holdPost({ asset_id: 'a1', kind: 'provisional', starts_at: '2026-10-01', ends_at: '2026-10-05' }), env, U(), deps(db));
  const out = await jsonOf(await hostAssetHolds(
    holdPost({ asset_id: 'a1', kind: 'booked', starts_at: '2026-10-02', ends_at: '2026-10-03' }), env, U(), deps(db),
  ));
  assert.equal(out.error, 'clash');
});

test('a pencilled hold gets an expiry even when nobody supplies one', async () => {
  const db = freshDb();
  await withAsset(db);
  await hostAssetHolds(holdPost({ asset_id: 'a1', kind: 'provisional', starts_at: '2026-10-01', ends_at: '2026-10-05' }), { DB: d1(db) }, U(), deps(db));
  const h = db.prepare(`SELECT * FROM num_asset_holds`).get();
  assert.ok(h.expires_at, 'an immortal pencil blocks a boat forever over an enquiry nobody chased');
});

test('maintenance and a block may overlap each other', async () => {
  const db = freshDb();
  await withAsset(db);
  const env = { DB: d1(db) };
  await hostAssetHolds(holdPost({ asset_id: 'a1', kind: 'maintenance', starts_at: '2026-11-01', ends_at: '2026-11-10' }), env, U(), deps(db));
  const out = await jsonOf(await hostAssetHolds(
    holdPost({ asset_id: 'a1', kind: 'blocked', starts_at: '2026-11-05', ends_at: '2026-11-06' }), env, U(), deps(db),
  ));
  assert.equal(out.ok, true);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM num_asset_holds`).get().n, 2);
});

test('a released hold frees the dates', async () => {
  const db = freshDb();
  await withAsset(db);
  const env = { DB: d1(db) };
  await hostAssetHolds(holdPost({ asset_id: 'a1', kind: 'booked', starts_at: '2026-12-01', ends_at: '2026-12-05' }), env, U(), deps(db));
  const id = db.prepare(`SELECT id FROM num_asset_holds`).get().id;
  await hostAssetHolds(holdPost({ action: 'release', id }), env, U(), deps(db));
  const again = await jsonOf(await hostAssetHolds(
    holdPost({ asset_id: 'a1', kind: 'booked', starts_at: '2026-12-02', ends_at: '2026-12-04' }), env, U(), deps(db),
  ));
  assert.equal(again.ok, true, 'a released hold must not keep blocking');
});

test('backwards dates are refused with a sentence', async () => {
  const db = freshDb();
  await withAsset(db);
  const out = await jsonOf(await hostAssetHolds(
    holdPost({ asset_id: 'a1', kind: 'booked', starts_at: '2026-09-24', ends_at: '2026-09-20' }), { DB: d1(db) }, U(), deps(db),
  ));
  assert.equal(out.error, 'ends_before_starts');
  assert.match(out.says, /after/);
});

test('a host cannot put a hold on another hosts boat', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,created_at)
              VALUES ('a2','supplier','h2','h2','boat','Theirs','quote',?)`).run(ts());
  const out = await jsonOf(await hostAssetHolds(
    holdPost({ asset_id: 'a2', kind: 'booked', starts_at: '2026-09-20', ends_at: '2026-09-21' }), { DB: d1(db) }, U(), deps(db),
  ));
  assert.equal(out.error, 'not_your_asset');
});

test('a hold on one boat does not block a different boat', async () => {
  const db = freshDb();
  await withAsset(db);
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,created_at)
              VALUES ('a9','supplier','h1','h1','boat','Second Boat','quote',?)`).run(ts());
  const env = { DB: d1(db) };
  await hostAssetHolds(holdPost({ asset_id: 'a1', kind: 'booked', starts_at: '2026-09-20', ends_at: '2026-09-24' }), env, U(), deps(db));
  const out = await jsonOf(await hostAssetHolds(
    holdPost({ asset_id: 'a9', kind: 'booked', starts_at: '2026-09-20', ends_at: '2026-09-24' }), env, U(), deps(db),
  ));
  assert.equal(out.ok, true, 'the clash check must be per hull, not per host');
});

/* what a booker sees */

test('the offerable list excludes anything without an approved photo', async () => {
  const db = freshDb();
  const mk = (id, name, listable) => db.prepare(
    `INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,home_city,listable,created_at)
     VALUES (?,'supplier','h1','h1','yacht',?,'quote','Phuket',?,?)`).run(id, name, listable, ts());
  const ph = (id, asset, mod) => db.prepare(
    `INSERT INTO num_asset_photos (id,asset_id,r2_key,content_type,source,sha256,moderation,decided_at,position,created_at)
     VALUES (?,?,'k','image/jpeg','mms',?,?,?,1,?)`
  ).run(id, asset, 'sha-' + id, mod, mod === 'new' ? null : ts(), ts());

  mk('a1', 'Pending', 1); ph('p1', 'a1', 'new');
  mk('a2', 'Ready', 1); ph('p2', 'a2', 'ok');
  mk('a3', 'Hidden', 0); ph('p3', 'a3', 'ok');

  const out = await jsonOf(await offerableAssets(
    GET(), { DB: d1(db) }, new URL('https://itsnum.com/api/host/offerable?near=Phuket'), deps(db),
  ));
  assert.equal(out.assets.length, 1, 'only the live one with an approved photo may be offered');
  assert.equal(out.assets[0].name, 'Ready');
  assert.equal(out.assets[0].photos.length, 1);
  assert.match(out.assets[0].photos[0].url, /^\/p\/asset\//);
});

test('an empty offerable list says so instead of looking broken', async () => {
  const db = freshDb();
  const out = await jsonOf(await offerableAssets(
    GET(), { DB: d1(db) }, new URL('https://itsnum.com/api/host/offerable?near=Nowhere'), deps(db),
  ));
  assert.equal(out.assets.length, 0);
  assert.match(out.note, /Nothing listed/);
});

test('nothing a booker receives carries a registration or a private note', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,registration,notes,rate_unit,home_city,listable,created_at)
              VALUES ('a1','supplier','h1','h1','yacht','Serenity II','SSR-8891','owner hates dogs','quote','Phuket',1,?)`).run(ts());
  db.prepare(`INSERT INTO num_asset_photos (id,asset_id,r2_key,content_type,source,sha256,moderation,decided_at,position,created_at)
              VALUES ('p1','a1','k','image/jpeg','mms','s1','ok',?,1,?)`).run(ts(), ts());
  const body = await (await offerableAssets(
    GET(), { DB: d1(db) }, new URL('https://itsnum.com/api/host/offerable'), deps(db),
  )).text();
  assert.ok(body.includes('Serenity II'), 'the boat itself should be offerable');
  assert.ok(!body.includes('SSR-8891'), 'a registration reached a public endpoint');
  assert.ok(!body.includes('hates dogs'), 'a private note reached a public endpoint');
});

/* serving the image */

test('a pending photo is a 404 to the public and visible to its host', async () => {
  const db = freshDb();
  await withAsset(db, { photo: 'new' });
  const env = { DB: d1(db), PHOTOS: r2({ k: 'bytes' }) };
  const pub = await assetImage(GET(), env, new URL('https://itsnum.com/p/asset/p1'), deps(db), { publicOnly: true });
  assert.equal(pub.status, 404, 'an unapproved photo must never be publicly readable');
  const mine = await assetImage(GET(), env, U('&id=p1'), deps(db));
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get('cache-control'), 'private, no-store');
  assert.equal(mine.headers.get('x-content-type-options'), 'nosniff');
});

test('an approved photo is public and cacheable', async () => {
  const db = freshDb();
  await withAsset(db, { photo: 'ok' });
  const res = await assetImage(GET(), { DB: d1(db), PHOTOS: r2({ k: 'bytes' }) },
    new URL('https://itsnum.com/p/asset/p1'), deps(db), { publicOnly: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /public/);
});

test('a rejected photo is gone for the public and still visible to its host', async () => {
  const db = freshDb();
  await withAsset(db, { photo: 'rejected' });
  const env = { DB: d1(db), PHOTOS: r2({ k: 'bytes' }) };
  assert.equal((await assetImage(GET(), env, new URL('https://itsnum.com/p/asset/p1'), deps(db), { publicOnly: true })).status, 404);
  assert.equal((await assetImage(GET(), env, U('&id=p1'), deps(db))).status, 200, 'the host may want to undo a rejection');
});

test('another host cannot read a pending photo by guessing its id', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,created_at)
              VALUES ('a2','supplier','h2','h2','boat','Theirs','quote',?)`).run(ts());
  db.prepare(`INSERT INTO num_asset_photos (id,asset_id,r2_key,content_type,source,sha256,moderation,position,created_at)
              VALUES ('p9','a2','k','image/jpeg','mms','s9','new',1,?)`).run(ts());
  const res = await assetImage(GET(), { DB: d1(db), PHOTOS: r2({ k: 'bytes' }) }, U('&id=p9'), deps(db));
  assert.equal(res.status, 404);
});

test('with no bucket bound, serving says unavailable rather than 404ing a photo that exists', async () => {
  const db = freshDb();
  await withAsset(db, { photo: 'ok' });
  const res = await assetImage(GET(), { DB: d1(db) }, new URL('https://itsnum.com/p/asset/p1'), deps(db), { publicOnly: true });
  assert.equal(res.status, 503, '503 is a configuration problem; a 404 would send us hunting the wrong thing');
});

test('a row pointing at a missing object 404s rather than throwing', async () => {
  const db = freshDb();
  await withAsset(db, { photo: 'ok' });
  const res = await assetImage(GET(), { DB: d1(db), PHOTOS: r2({}) },
    new URL('https://itsnum.com/p/asset/p1'), deps(db), { publicOnly: true });
  assert.equal(res.status, 404);
});

test('an id that does not exist is a 404, not a crash', async () => {
  const db = freshDb();
  const res = await assetImage(GET(), { DB: d1(db), PHOTOS: r2({}) },
    new URL('https://itsnum.com/p/asset/nope'), deps(db), { publicOnly: true });
  assert.equal(res.status, 404);
});

/* the photo queue a host actually sees */

test('the queue shows a photo from a linked supplier and hides one from a stranger', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_suppliers (id,member_id,display_name,created_at) VALUES ('sMine','m1','Marco',?)`).run(ts());
  db.prepare(`INSERT INTO num_suppliers (id,member_id,display_name,created_at) VALUES ('sOther','m2','Stranger',?)`).run(ts());
  // asked_by is NOT NULL — a link nobody asked for is a link nobody can
  // account for, which is the right rule for who may see whose photos.
  db.prepare(`INSERT INTO num_supplier_links (id,host_id,supplier_id,asked_by,status,created_at,decided_at)
              VALUES ('l1','h1','sMine','host','accepted',?,?)`).run(ts(), ts());
  db.prepare(`INSERT INTO num_supplier_links (id,host_id,supplier_id,asked_by,status,created_at,decided_at)
              VALUES ('l2','h2','sOther','host','accepted',?,?)`).run(ts(), ts());

  const med = (id, sup) => db.prepare(
    `INSERT INTO num_inbound_media (id,from_hash,from_last4,supplier_id,r2_key,content_type,sha256,status,created_at)
     VALUES (?,'h','1234',?,'k','image/jpeg',?,'new',?)`).run(id, sup, 'sha-' + id, ts());
  med('mMine', 'sMine');
  med('mOther', 'sOther');

  const out = await jsonOf(await hostAssets(GET(), { DB: d1(db) }, U(), deps(db)));
  const ids = out.queue.map((q) => q.id);
  assert.ok(ids.includes('mMine'), 'a linked suppliers photo must reach the host who can file it');
  assert.ok(!ids.includes('mOther'), 'another hosts suppliers photo must never appear here');
});

test('a pending link does not yet let a supplier into the queue', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_suppliers (id,member_id,display_name,created_at) VALUES ('s1','m1','Marco',?)`).run(ts());
  db.prepare(`INSERT INTO num_supplier_links (id,host_id,supplier_id,asked_by,status,created_at) VALUES ('l1','h1','s1','host','pending',?)`).run(ts());
  db.prepare(`INSERT INTO num_inbound_media (id,from_hash,supplier_id,r2_key,content_type,sha256,status,created_at)
              VALUES ('m1','h','s1','k','image/jpeg','s1','new',?)`).run(ts());
  const out = await jsonOf(await hostAssets(GET(), { DB: d1(db) }, U(), deps(db)));
  assert.equal(out.queue.length, 0, 'an unaccepted invitation is not a relationship');
});

test('an unknown sender reaches every host queue, so somebody can claim it', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_inbound_media (id,from_hash,from_last4,r2_key,content_type,sha256,status,created_at)
              VALUES ('m1','h','5678','k','image/jpeg','s1','unknown_sender',?)`).run(ts());
  const out = await jsonOf(await hostAssets(GET(), { DB: d1(db) }, U(), deps(db)));
  assert.equal(out.queue.length, 1);
  assert.equal(out.queue[0].from_last4, '5678', 'the last four is how a human recognises the sender');
});

test('the fleet response counts approved and pending photos separately', async () => {
  const db = freshDb();
  await withAsset(db, { photo: 'ok' });
  db.prepare(`INSERT INTO num_asset_photos (id,asset_id,r2_key,content_type,source,sha256,moderation,position,created_at)
              VALUES ('p2','a1','k2','image/jpeg','mms','s2','new',2,?)`).run(ts());
  const out = await jsonOf(await hostAssets(GET(), { DB: d1(db) }, U(), deps(db)));
  assert.equal(out.assets[0].photos_ok, 1);
  assert.equal(out.assets[0].photos_pending, 1);
});

test('retiring an id that is not yours says so rather than reporting success', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,created_at)
              VALUES ('a2','supplier','h2','h2','boat','Theirs','quote',?)`).run(ts());
  const res = await hostAssets(POST({ action: 'retire', id: 'a2' }), { DB: d1(db) }, U(), deps(db));
  const out = await jsonOf(res);
  assert.equal(res.status, 404);
  assert.equal(out.error, 'not_found');
  assert.equal(db.prepare(`SELECT status FROM num_assets WHERE id='a2'`).get().status, 'active',
    'another hosts boat must not be retired out from under them');
});

test('retiring nothing at all says so', async () => {
  const db = freshDb();
  const out = await jsonOf(await hostAssets(
    POST({ action: 'retire', id: 'ast_doesnotexist' }), { DB: d1(db) }, U(), deps(db),
  ));
  assert.equal(out.error, 'not_found');
  assert.match(out.says, /Nothing of yours/);
});
