// The behaviour of a photo texted in, asserted against the REAL schema.
//
// Every CHECK in 0021 is asserted from the outside — by trying to write the row
// it should refuse — because a constraint that exists in a file and not in the
// database is the exact failure that cost us the requests endpoint for weeks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  last4, mediaKey, senderHash, sha256Hex, askWhichAsset, ALLOWED, MAX_BYTES, MAX_MEDIA,
  attachToAsset, ingestMedia,
} from './inboundmedia.mjs';

const SQL = readFileSync(new URL('./migrations/0021_luxury_assets.sql', import.meta.url), 'utf8');
const SUP = readFileSync(new URL('./migrations/0019_suppliers.sql', import.meta.url), 'utf8');
// 0022 is loaded too. It puts phone on num_suppliers, and resolveSupplier
// selects that column — a harness without it is a different database from
// production, which is the whole failure this file exists to catch.
const SUP2 = readFileSync(new URL('./migrations/0022_supplier_contact.sql', import.meta.url), 'utf8');

/* A database that is the real schema, minus the ALTERs that need base tables
   this test does not care about. Statements that fail for a missing base table
   are skipped rather than silently swallowed wholesale — a skipped CREATE would
   make every assertion below meaningless. */
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_members (id TEXT PRIMARY KEY, phone TEXT, phone_verified INTEGER DEFAULT 0, name TEXT);`);
  db.exec(`CREATE TABLE num_hosts (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active');`);
  let created = 0;
  // ALTERs are applied, not skipped. A test schema missing the ALTERs is a
  // DIFFERENT database from production, and the whole reason this file exists is
  // that a column which reached one database and not another cost us weeks.
  for (const raw of (SUP + '\n' + SQL + '\n' + SUP2).split(';')) {
    const stmt = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (!stmt) continue;
    try { db.exec(stmt + ';'); if (/^CREATE TABLE/i.test(stmt)) created++; } catch { /* statement for a table this test does not build */ }
  }
  assert.ok(created >= 12, `expected the migrations to create the tables, got ${created}`);
  return db;
}

/** env.DB, in the shape the Worker code calls — numbered parameters included.
 *
 * A stub that merely does sql.replace(/\?\d+/g,'?') is wrong: SQLite lets ?1
 * appear twice and bind once, and every UPDATE in this codebase reuses its
 * timestamp that way. A harness that cannot run the real statements will pass a
 * broken one. */
function expand(sql, binds) {
  if (!/\?\d/.test(sql)) return { sql, args: binds.map(nz) };
  const args = [];
  const out = sql.replace(/\?(\d+)/g, (_, n) => { args.push(nz(binds[Number(n) - 1])); return '?'; });
  return { sql: out, args };
}

function d1(db) {
  return {
    prepare(sql) {
      const binds = [];
      const go = (fn) => { const e = expand(sql, binds); return db.prepare(e.sql)[fn](...e.args); };
      const api = {
        bind(...a) { binds.push(...a); return api; },
        async first() { return go('all')[0] ?? null; },
        async all() { return { results: go('all') }; },
        async run() { return go('run'); },
      };
      return api;
    },
  };
}
const nz = (v) => (v === undefined ? null : v);

/** R2, in the shape the Worker code calls. */
function bucket() {
  const store = new Map();
  return {
    store,
    async put(k, v, o) { store.set(k, { v, o }); },
    async get(k) { return store.has(k) ? { body: store.get(k).v } : null; },
  };
}

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/* ───────────────────────────── the small parts ───────────────────────── */

test('last4 keeps four digits and never more', () => {
  assert.equal(last4('+66812345678'), '5678');
  assert.equal(last4('+1 (415) 555-0199'), '0199');
  assert.equal(last4('123'), null);
  assert.equal(last4(null), null);
});

test('the sender hash is stable, keyed, and not the phone number', async () => {
  const env = { MEDIA_SALT: 'salt-one' };
  const a = await senderHash(env, '+66812345678');
  const b = await senderHash(env, '+66812345678');
  assert.equal(a, b, 'the same number must hash the same way or nothing groups');
  assert.equal(a.length, 64);
  assert.ok(!a.includes('8123'), 'the hash must not contain the number');
  const other = await senderHash({ MEDIA_SALT: 'salt-two' }, '+66812345678');
  assert.notEqual(a, other, 'a different key must give a different hash');
});

test('the hash falls back rather than storing a raw number or dropping the photo', async () => {
  const h = await senderHash({ TWILIO_TOKEN: 'tok' }, '+447700900000');
  assert.equal(h.length, 64);
  const none = await senderHash({}, '+447700900000');
  assert.equal(none.length, 64);
});

test('the R2 key is supplier-scoped and carries a real extension', () => {
  assert.equal(mediaKey('sup_1', 'med_9', 'image/jpeg'), 'inbound/sup_1/med_9.jpg');
  assert.equal(mediaKey(null, 'med_9', 'image/png'), 'inbound/unknown/med_9.png');
  assert.equal(mediaKey('sup_1', 'med_9', 'video/quicktime'), 'inbound/sup_1/med_9.mov');
});

test('the allowlist admits photos and video and nothing that executes', () => {
  assert.ok(ALLOWED.has('image/jpeg'));
  assert.ok(ALLOWED.has('video/mp4'));
  for (const bad of ['text/html', 'image/svg+xml', 'application/pdf', 'text/javascript', 'application/octet-stream']) {
    assert.ok(!ALLOWED.has(bad), `${bad} must never be storable — it is served from our own domain`);
  }
});

test('the caps are real numbers a phone photo fits inside', () => {
  assert.equal(MAX_MEDIA, 10);
  assert.ok(MAX_BYTES >= 8 * 1024 * 1024 && MAX_BYTES <= 32 * 1024 * 1024);
});

/* ─────────────────────────────── the reply ───────────────────────────── */

test('a supplier with one asset is told where it went, not asked a question', () => {
  const r = askWhichAsset({ stored: 1, skipped: 0, supplier: { supplier_id: 's1' }, assets: [{ id: 'a1', name: 'Serenity II' }] });
  assert.match(r, /Serenity II/);
  assert.ok(!r.includes('Reply with a number'));
});

test('a supplier with several assets is asked, and only their own are named', () => {
  const r = askWhichAsset({
    stored: 1, skipped: 0, supplier: { supplier_id: 's1' },
    assets: [{ id: 'a1', name: 'Serenity II' }, { id: 'a2', name: 'Blue Pearl' }],
  });
  assert.match(r, /1\. Serenity II/);
  assert.match(r, /2\. Blue Pearl/);
});

test('an unknown number is told how to become known, not ignored', () => {
  const r = askWhichAsset({ stored: 1, skipped: 0, supplier: null, assets: [] });
  assert.match(r, /do not recognise/i);
  assert.match(r, /host/i);
});

test('a supplier with nothing listed is told we kept it', () => {
  const r = askWhichAsset({ stored: 2, skipped: 0, supplier: { supplier_id: 's1' }, assets: [] });
  assert.match(r, /holding/i);
  assert.match(r, /2 photos/);
});

test('a rejected file earns an explanation, never silence', () => {
  const r = askWhichAsset({ stored: 0, skipped: 1, supplier: { supplier_id: 's1' }, assets: [] });
  assert.match(r, /too large|not a photo/i);
  assert.match(r, /12MB/);
});

test('nothing sent means nothing said — no reply to a message with no media', () => {
  assert.equal(askWhichAsset({ stored: 0, skipped: 0, supplier: null, assets: [] }), null);
});

/* ──────────────────────── the schema holds the line ──────────────────── */

test('a photo row cannot say attached without saying what to', () => {
  const db = freshDb();
  assert.throws(() => db.prepare(
    `INSERT INTO num_inbound_media (id,from_hash,r2_key,content_type,status,created_at)
     VALUES ('m1','h','k','image/jpeg','attached',?)`).run(ts()),
    /CHECK|constraint/i,
    'attached with no asset_id is a row that says a photo is filed nowhere');
});

test('an unverified member cannot list a yacht', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_hosts (id,name) VALUES ('h1','Host')`).run();
  assert.throws(() => db.prepare(
    `INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,listable,created_at)
     VALUES ('a1','member','m1','h1','yacht','Unvetted','quote',1,?)`).run(ts()),
    /CHECK|constraint/i,
    'a member listing a yacht without verification is the charter-fraud shape');
});

test('nothing can be listable without a host behind it', () => {
  const db = freshDb();
  assert.throws(() => db.prepare(
    `INSERT INTO num_assets (id,owner_kind,owner_id,kind,name,rate_unit,listable,created_at)
     VALUES ('a1','supplier','s1','boat','Orphan','quote',1,?)`).run(ts()),
    /CHECK|constraint/i);
});

test('a priced unit cannot carry a zero price', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_hosts (id,name) VALUES ('h1','Host')`).run();
  assert.throws(() => db.prepare(
    `INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,rate_minor,created_at)
     VALUES ('a1','supplier','s1','h1','boat','Free Boat','day',0,?)`).run(ts()),
    /CHECK|constraint/i,
    'a day rate of nothing is a quote, and calling it a rate prices a charter at zero');
});

test('a hold cannot end before it starts', () => {
  const db = freshDb();
  assert.throws(() => db.prepare(
    `INSERT INTO num_asset_holds (id,asset_id,kind,starts_at,ends_at,created_at)
     VALUES ('h1','a1','booked','2026-09-20 10:00:00','2026-09-19 10:00:00',?)`).run(ts()),
    /CHECK|constraint/i);
});

test('a pencilled hold cannot be immortal', () => {
  const db = freshDb();
  assert.throws(() => db.prepare(
    `INSERT INTO num_asset_holds (id,asset_id,kind,starts_at,ends_at,created_at)
     VALUES ('h1','a1','provisional','2026-09-20 10:00:00','2026-09-21 10:00:00',?)`).run(ts()),
    /CHECK|constraint/i,
    'a provisional hold with no expiry blocks a boat forever over an enquiry nobody chased');
});

test('the same photo cannot be filed twice against one asset', () => {
  const db = freshDb();
  const ins = (id) => db.prepare(
    `INSERT INTO num_asset_photos (id,asset_id,r2_key,content_type,source,sha256,moderation,position,created_at)
     VALUES (?,'a1','k','image/jpeg','mms','abc123','new',1,?)`).run(id, ts());
  ins('p1');
  assert.throws(() => ins('p2'), /UNIQUE/i);
});

/* ──────────────────────── the ingest, end to end ─────────────────────── */

test('a photo texted in by a known supplier lands in R2 and in the queue', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_members (id,phone,phone_verified) VALUES ('m1','+66812345678',1)`).run();
  db.prepare(`INSERT INTO num_suppliers (id,member_id,display_name,created_at) VALUES ('s1','m1','Marco',?)`).run(ts());

  const bkt = bucket();
  const env = { DB: d1(db), MEDIA_SALT: 'k', TWILIO_SID: 'AC', TWILIO_TOKEN: 't' };
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  globalThis.fetch = async () => new Response(bytes, { headers: { 'content-type': 'image/jpeg' } });

  const params = new URLSearchParams({
    NumMedia: '1', MediaUrl0: 'https://api.twilio.com/x', MediaContentType0: 'image/jpeg',
    Body: 'the boat', MessageSid: 'SM1',
  });
  const out = await ingestMedia(env, { params, from: '+66812345678', bucket: bkt });

  assert.equal(out.stored, 1);
  assert.equal(out.skipped, 0);
  assert.equal(out.supplier.supplier_id, 's1');
  assert.equal(bkt.store.size, 1, 'the bytes must be in the bucket');

  const row = db.prepare(`SELECT * FROM num_inbound_media`).get();
  assert.equal(row.supplier_id, 's1');
  assert.equal(row.status, 'new', 'nothing texted in starts approved');
  assert.equal(row.from_last4, '5678');
  assert.ok(!String(row.from_hash).includes('8123'), 'the raw number must never be stored');
  assert.equal(row.bytes, 5);
  assert.equal(row.sha256, await sha256Hex(bytes.buffer));
});

test('a photo from a number we do not know is kept and flagged, not thrown away', async () => {
  const db = freshDb();
  const bkt = bucket();
  globalThis.fetch = async () => new Response(new Uint8Array([9]), { headers: { 'content-type': 'image/png' } });
  const out = await ingestMedia(
    { DB: d1(db), MEDIA_SALT: 'k' },
    { params: new URLSearchParams({ NumMedia: '1', MediaUrl0: 'https://x/1' }), from: '+15550001111', bucket: bkt },
  );
  assert.equal(out.stored, 1);
  assert.equal(out.supplier, null);
  assert.equal(db.prepare(`SELECT status FROM num_inbound_media`).get().status, 'unknown_sender');
});

test('an HTML file dressed as a photo is refused', async () => {
  const db = freshDb();
  const bkt = bucket();
  globalThis.fetch = async () => new Response('<script>alert(1)</script>', { headers: { 'content-type': 'text/html' } });
  const out = await ingestMedia(
    { DB: d1(db), MEDIA_SALT: 'k' },
    // It LIES about the type in the webhook param. The served type is what counts.
    { params: new URLSearchParams({ NumMedia: '1', MediaUrl0: 'https://x/1', MediaContentType0: 'image/jpeg' }), from: '+1555', bucket: bkt },
  );
  assert.equal(out.stored, 0);
  assert.equal(out.skipped, 1);
  assert.equal(bkt.store.size, 0, 'nothing executable may reach the bucket');
});

test('an oversized file is refused rather than stored', async () => {
  const db = freshDb();
  const bkt = bucket();
  globalThis.fetch = async () => new Response(new Uint8Array(MAX_BYTES + 1), { headers: { 'content-type': 'image/jpeg' } });
  const out = await ingestMedia(
    { DB: d1(db), MEDIA_SALT: 'k' },
    { params: new URLSearchParams({ NumMedia: '1', MediaUrl0: 'https://x/1' }), from: '+1555', bucket: bkt },
  );
  assert.equal(out.stored, 0);
  assert.equal(out.skipped, 1);
});

test('a photo sent twice is acknowledged once and stored once', async () => {
  const db = freshDb();
  const bkt = bucket();
  const env = { DB: d1(db), MEDIA_SALT: 'k' };
  globalThis.fetch = async () => new Response(new Uint8Array([7, 7, 7]), { headers: { 'content-type': 'image/jpeg' } });
  const p = () => new URLSearchParams({ NumMedia: '1', MediaUrl0: 'https://x/1' });

  const a = await ingestMedia(env, { params: p(), from: '+1555', bucket: bkt });
  const b = await ingestMedia(env, { params: p(), from: '+1555', bucket: bkt });
  assert.equal(a.stored, 1);
  assert.equal(b.stored, 1, 'a re-send gets a reassuring answer');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM num_inbound_media`).get().n, 1, 'but only one row');
});

test('with no bucket bound, the photo is counted as skipped and shouted about', async () => {
  const db = freshDb();
  globalThis.fetch = async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } });
  const out = await ingestMedia(
    { DB: d1(db), MEDIA_SALT: 'k' },
    { params: new URLSearchParams({ NumMedia: '1', MediaUrl0: 'https://x/1' }), from: '+1555', bucket: null },
  );
  assert.equal(out.stored, 0);
  assert.equal(out.skipped, 1, 'a missing binding must never look like success');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM num_inbound_media`).get().n, 0, 'no row may point at bytes we never wrote');
});

test('NumMedia is capped, so a forged webhook cannot make us fetch hundreds of files', async () => {
  const db = freshDb();
  const bkt = bucket();
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response(new Uint8Array([fetches]), { headers: { 'content-type': 'image/jpeg' } }); };
  const params = new URLSearchParams({ NumMedia: '400' });
  for (let i = 0; i < 400; i++) params.set(`MediaUrl${i}`, `https://x/${i}`);
  await ingestMedia({ DB: d1(db), MEDIA_SALT: 'k' }, { params, from: '+1555', bucket: bkt });
  assert.ok(fetches <= MAX_MEDIA, `fetched ${fetches} times, cap is ${MAX_MEDIA}`);
});

test('a supplier with exactly one boat has the photo filed automatically', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_members (id,phone,phone_verified) VALUES ('m1','+447700900123',1)`).run();
  db.prepare(`INSERT INTO num_suppliers (id,member_id,display_name,created_at) VALUES ('s1','m1','Marco',?)`).run(ts());
  db.prepare(`INSERT INTO num_hosts (id,name) VALUES ('h1','Host')`).run();
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,created_at)
              VALUES ('a1','supplier','s1','h1','boat','Serenity II','quote',?)`).run(ts());

  const bkt = bucket();
  globalThis.fetch = async () => new Response(new Uint8Array([3, 3]), { headers: { 'content-type': 'image/jpeg' } });
  const out = await ingestMedia(
    { DB: d1(db), MEDIA_SALT: 'k' },
    { params: new URLSearchParams({ NumMedia: '1', MediaUrl0: 'https://x/1' }), bucket: bkt, from: '+447700900123' },
  );
  assert.equal(out.stored, 1);
  assert.equal(out.assets.length, 1);

  const ph = db.prepare(`SELECT * FROM num_asset_photos`).get();
  assert.ok(ph, 'the sole-asset case should file itself rather than asking a question with one answer');
  assert.equal(ph.asset_id, 'a1');
  assert.equal(ph.moderation, 'new', 'auto-filed is not auto-approved');
  assert.equal(db.prepare(`SELECT status FROM num_inbound_media`).get().status, 'attached');
});

/* ───────────────────────────── attaching ─────────────────────────────── */

test('attaching a photo leaves it pending and records where it went', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_hosts (id,name) VALUES ('h1','Host')`).run();
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,created_at)
              VALUES ('a1','supplier','s1','h1','yacht','Blue Pearl','quote',?)`).run(ts());
  db.prepare(`INSERT INTO num_inbound_media (id,from_hash,r2_key,content_type,bytes,sha256,status,created_at)
              VALUES ('m1','h','inbound/s1/m1.jpg','image/jpeg',120,'sha1','new',?)`).run(ts());

  const r = await attachToAsset({ DB: d1(db) }, { mediaId: 'm1', assetId: 'a1', by: 'host:h1' });
  assert.equal(r.ok, true);
  const ph = db.prepare(`SELECT * FROM num_asset_photos`).get();
  assert.equal(ph.moderation, 'new', 'a booker must not see it before a human does');
  assert.equal(ph.source, 'mms');
  assert.equal(ph.position, 1);
  const med = db.prepare(`SELECT * FROM num_inbound_media`).get();
  assert.equal(med.status, 'attached');
  assert.equal(med.asset_id, 'a1');
});

test('attaching the same photo to the same asset twice is a no-op, not an error', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_hosts (id,name) VALUES ('h1','Host')`).run();
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,created_at)
              VALUES ('a1','supplier','s1','h1','boat','B','quote',?)`).run(ts());
  const env = { DB: d1(db) };
  for (const id of ['m1', 'm2']) {
    db.prepare(`INSERT INTO num_inbound_media (id,from_hash,r2_key,content_type,sha256,status,created_at)
                VALUES (?,'h','k','image/jpeg','samehash','new',?)`).run(id, ts());
  }
  assert.equal((await attachToAsset(env, { mediaId: 'm1', assetId: 'a1' })).ok, true);
  const second = await attachToAsset(env, { mediaId: 'm2', assetId: 'a1' });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM num_asset_photos`).get().n, 1);
  assert.equal(db.prepare(`SELECT status FROM num_inbound_media WHERE id='m2'`).get().status, 'attached');
});

test('attaching to an asset that does not exist refuses rather than orphans', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_inbound_media (id,from_hash,r2_key,content_type,status,created_at)
              VALUES ('m1','h','k','image/jpeg','new',?)`).run(ts());
  const r = await attachToAsset({ DB: d1(db) }, { mediaId: 'm1', assetId: 'nope' });
  assert.equal(r.ok, false);
  assert.match(r.error, /no such asset/);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM num_asset_photos`).get().n, 0);
});

test('the second photo on an asset goes second', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_hosts (id,name) VALUES ('h1','Host')`).run();
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,created_at)
              VALUES ('a1','supplier','s1','h1','car','Defender','quote',?)`).run(ts());
  const env = { DB: d1(db) };
  db.prepare(`INSERT INTO num_inbound_media (id,from_hash,r2_key,content_type,sha256,status,created_at)
              VALUES ('m1','h','k1','image/jpeg','s1','new',?)`).run(ts());
  db.prepare(`INSERT INTO num_inbound_media (id,from_hash,r2_key,content_type,sha256,status,created_at)
              VALUES ('m2','h','k2','image/jpeg','s2','new',?)`).run(ts());
  const a = await attachToAsset(env, { mediaId: 'm1', assetId: 'a1' });
  const b = await attachToAsset(env, { mediaId: 'm2', assetId: 'a1' });
  assert.equal(a.position, 1);
  assert.equal(b.position, 2);
});
