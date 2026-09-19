// Upload, intake, confirm, list-as-product — against the real migrations.
//
// The harness loads 0021 and 0037 from disk rather than hand-writing the
// tables, because the failure this file most needs to catch is a statement
// that is valid SQL and wrong about a column — the exact way booking_fee_minor
// went missing for weeks while every test passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fleetUpload, fleetIntake, fleetDraft, fleetDrafts, toBase64, sha256Hex } from './fleetintake.mjs';

const load = (f) => readFileSync(new URL('../worker/migrations/' + f, import.meta.url), 'utf8');
const SQL = [load('0019_suppliers.sql'), load('0021_luxury_assets.sql'),
  load('0014_host_clients.sql'), load('0037_fleet_intake.sql')].join('\n');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_hosts (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active',
            console_key TEXT, currency TEXT DEFAULT 'GBP');`);
  db.exec(`CREATE TABLE num_jobs (id TEXT PRIMARY KEY);`);
  // Comments are stripped BEFORE the split, exactly as
  // scripts/apply-host-migrations.mjs does it. The obvious version — split on
  // ';' first, then drop lines beginning '--' — tears a comment containing a
  // semicolon in half and leaves its tail masquerading as SQL, which is how
  // this harness silently ran a migration with two of its ALTERs missing and
  // then reported the endpoints broken.
  for (const stmt of SQL.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
    .split(';').map((x) => x.trim()).filter(Boolean)) {
    try { db.exec(stmt + ';'); } catch { /* a statement for a table this test does not need */ }
  }
  db.prepare(`INSERT INTO num_hosts (id,name,console_key) VALUES ('h1','Host One','key-one')`).run();
  db.prepare(`INSERT INTO num_hosts (id,name,console_key) VALUES ('h2','Host Two','key-two')`).run();
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
    };
    return api;
  },
});

// An R2 stand-in that actually holds bytes, so "the row points at bytes that
// are not there" is a state this harness can reach and assert on.
function bucket() {
  const m = new Map();
  return {
    map: m,
    async put(k, v) { m.set(k, v); },
    async get(k) {
      if (!m.has(k)) return null;
      const v = m.get(k);
      return { async arrayBuffer() { return v; } };
    },
  };
}

const stripControl = (s) => String(s).split('')
  .filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127).join('');

function deps(db, { hostId = 'h1' } = {}) {
  return {
    J: (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } }),
    clean: (s, max = 200) => (s === null || s === undefined ? '' : stripControl(s).trim().slice(0, max)),
    readJSON: async (req) => req.json(),
    badOrigin: () => false,
    hostAuth: async () => (hostId ? db.prepare(`SELECT * FROM num_hosts WHERE id=?`).get(hostId) : null),
  };
}

const PNG = () => {
  // Not a real PNG, and it does not need to be: nothing in these paths decodes
  // an image. What matters is that the bytes are stable so sha256 dedupe is
  // testable.
  const b = new Uint8Array(64);
  for (let i = 0; i < b.length; i += 1) b[i] = i;
  return b.buffer;
};

const upReq = (body, type = 'image/png') => new Request('https://itsnum.com/api/host/fleet-upload?k=key-one', {
  method: 'POST', headers: { 'content-type': type, 'x-num-filename': 'boat.png' }, body,
});
const jsonReq = (path, body) => new Request('https://itsnum.com/api/host/' + path + '?k=key-one', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const U = (p) => new URL('https://itsnum.com/api/host/' + p + '?k=key-one');

function env(db, { bucketOn = true, key = null } = {}) {
  return { DB: d1(db), PHOTOS: bucketOn ? bucket() : null, ANTHROPIC_API_KEY: key };
}

/* ── upload ────────────────────────────────────────────────────────────── */

test('an uploaded photograph lands in R2 and in the media table', async () => {
  const db = freshDb(); const e = env(db);
  const r = await (await fleetUpload(upReq(PNG()), e, U('fleet-upload'), deps(db))).json();
  assert.equal(r.ok, true);
  const row = db.prepare('SELECT * FROM num_inbound_media WHERE id=?').get(r.media_id);
  assert.equal(row.provider, 'upload');
  assert.equal(row.status, 'new');
  assert.equal(row.content_type, 'image/png');
  // The sending number column is not a phone number here and does not pretend
  // to be one.
  assert.equal(row.from_hash, 'host:h1');
  assert.equal(row.from_last4, null);
  assert.ok(e.PHOTOS.map.has(row.r2_key));
});

test('the same photograph twice is the same row, not two', async () => {
  const db = freshDb(); const e = env(db);
  const a = await (await fleetUpload(upReq(PNG()), e, U('fleet-upload'), deps(db))).json();
  const b = await (await fleetUpload(upReq(PNG()), e, U('fleet-upload'), deps(db))).json();
  assert.equal(a.media_id, b.media_id);
  assert.equal(b.already, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM num_inbound_media').get().n, 1);
});

test('a file that is not a photograph is refused, and says why', async () => {
  const db = freshDb();
  const res = await fleetUpload(upReq(PNG(), 'application/pdf'), env(db), U('fleet-upload'), deps(db));
  assert.equal(res.status, 415);
  assert.match((await res.json()).says, /photograph/);
});

test('no bucket bound: refused rather than a row pointing at nothing', async () => {
  const db = freshDb();
  const res = await fleetUpload(upReq(PNG()), env(db, { bucketOn: false }), U('fleet-upload'), deps(db));
  assert.equal(res.status, 503);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM num_inbound_media').get().n, 0);
});

test('an unknown key gets nothing', async () => {
  const db = freshDb();
  const res = await fleetUpload(upReq(PNG()), env(db), U('fleet-upload'), deps(db, { hostId: null }));
  assert.equal(res.status, 401);
});

/* ── intake ────────────────────────────────────────────────────────────── */

async function twoUploads(db, e) {
  const one = await (await fleetUpload(upReq(PNG()), e, U('fleet-upload'), deps(db))).json();
  const other = new Uint8Array(32).fill(7).buffer;
  const two = await (await fleetUpload(upReq(other), e, U('fleet-upload'), deps(db))).json();
  return [one.media_id, two.media_id];
}

const modelSays = (text) => async () => new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });

test('with no key, uploads still become drafts — one per photograph', async () => {
  const db = freshDb(); const e = env(db);
  const ids = await twoUploads(db, e);
  const r = await (await fleetIntake(jsonReq('fleet-intake', { media_ids: ids }), e, U('fleet-intake'), deps(db))).json();
  assert.equal(r.ok, true);
  assert.equal(r.drafts.length, 2);
  assert.equal(r.identified, false);
  assert.match(r.says, /not switched on/);
});

test('every draft is a draft, unlistable and unpriced', async () => {
  const db = freshDb(); const e = env(db);
  const ids = await twoUploads(db, e);
  await fleetIntake(jsonReq('fleet-intake', { media_ids: ids }), e, U('fleet-intake'), deps(db));
  for (const a of db.prepare('SELECT * FROM num_assets').all()) {
    assert.equal(a.draft, 1, 'draft');
    assert.equal(a.listable, 0, 'listable');
    assert.equal(a.rate_minor, 0, 'no invented price');
    assert.equal(a.rate_unit, 'quote');
    assert.equal(a.host_id, 'h1');
  }
});

test('photographs the host uploaded are attached and already approved', async () => {
  // The host chose these files off their own device. Holding them in a queue
  // for the same host to approve teaches people to click approve blind.
  const db = freshDb(); const e = env(db);
  const ids = await twoUploads(db, e);
  await fleetIntake(jsonReq('fleet-intake', { media_ids: ids }), e, U('fleet-intake'), deps(db));
  const photos = db.prepare('SELECT * FROM num_asset_photos').all();
  assert.equal(photos.length, 2);
  for (const p of photos) {
    assert.equal(p.moderation, 'ok');
    assert.equal(p.source, 'upload');
    assert.ok(p.decided_at, 'an approved photo carries when it was decided');
    assert.ok(p.batch_id, 'and which upload it came from');
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM num_inbound_media WHERE status='attached'").get().n, 2);
});

test('two photographs of one boat become ONE asset with two photographs', async () => {
  const db = freshDb(); const e = env(db, { key: 'k' });
  const ids = await twoUploads(db, e);
  const D = deps(db);
  // The model groups them together.
  const origFetch = globalThis.fetch;
  globalThis.fetch = modelSays('{"groups":[{"photos":[1,2],"kind":"yacht","name":"M/Y Serenity","make":"Sunseeker","year":2019,"guests":8,"crew":2,"listing":"A 68ft Sunseeker out of Phuket."}]}');
  try {
    const r = await (await fleetIntake(jsonReq('fleet-intake', { media_ids: ids }), e, U('fleet-intake'), D)).json();
    assert.equal(r.drafts.length, 1);
    assert.equal(r.drafts[0].photo_count, 2);
    assert.equal(r.identified, true);
    const a = db.prepare('SELECT * FROM num_assets').get();
    assert.equal(a.kind, 'yacht');
    assert.equal(a.make, 'Sunseeker');
    assert.equal(a.guests, 8);
    assert.ok(a.identified_json, 'what we were told is kept as evidence');
  } finally { globalThis.fetch = origFetch; }
});

test('a plate read off a photograph is stored privately and kept out of the copy', async () => {
  const db = freshDb(); const e = env(db, { key: 'k' });
  const ids = await twoUploads(db, e);
  const origFetch = globalThis.fetch;
  globalThis.fetch = modelSays('{"groups":[{"photos":[1],"kind":"car","name":"Ferrari 296 GTB AB12 CDE","registration":"AB12CDE","listing":"Red, plate AB12 CDE."},{"photos":[2],"kind":"car","name":"Bentley"}]}');
  try {
    await fleetIntake(jsonReq('fleet-intake', { media_ids: ids }), e, U('fleet-intake'), deps(db));
    const a = db.prepare("SELECT * FROM num_assets WHERE registration IS NOT NULL").get();
    assert.equal(a.registration, 'AB12CDE');
    assert.ok(!a.name.includes('AB12'), a.name);
    assert.ok(!String(a.notes || '').includes('AB12'), a.notes);
  } finally { globalThis.fetch = origFetch; }
});

test("another host's media cannot be swept into your fleet", async () => {
  const db = freshDb(); const e = env(db);
  const mine = await twoUploads(db, e);
  // h2 uploads one of their own.
  const theirs = await (await fleetUpload(
    new Request('https://itsnum.com/api/host/fleet-upload?k=key-two', {
      method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array(16).fill(3).buffer,
    }), e, new URL('https://itsnum.com/api/host/fleet-upload?k=key-two'), deps(db, { hostId: 'h2' }),
  )).json();

  const r = await (await fleetIntake(
    jsonReq('fleet-intake', { media_ids: [...mine, theirs.media_id] }), e, U('fleet-intake'), deps(db),
  )).json();
  const total = r.drafts.reduce((n, d) => n + d.photo_count, 0);
  assert.equal(total, 2, 'only the two that are h1’s');
  const stolen = db.prepare('SELECT * FROM num_inbound_media WHERE id=?').get(theirs.media_id);
  assert.equal(stolen.status, 'new');
  assert.equal(stolen.asset_id, null);
});

test('naming a supplier you do not have is refused', async () => {
  const db = freshDb(); const e = env(db);
  const ids = await twoUploads(db, e);
  const res = await fleetIntake(jsonReq('fleet-intake', { media_ids: ids, owner_id: 'sup_someone_else' }), e, U('fleet-intake'), deps(db));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'not_your_supplier');
});

/* ── confirm, discard, publish ─────────────────────────────────────────── */

async function oneDraft(db, e) {
  const ids = await twoUploads(db, e);
  const r = await (await fleetIntake(jsonReq('fleet-intake', { media_ids: ids }), e, U('fleet-intake'), deps(db))).json();
  return r.drafts[0].id;
}

test('confirm is what takes it out of draft, and it is a separate call', async () => {
  const db = freshDb(); const e = env(db);
  const id = await oneDraft(db, e);
  assert.equal(db.prepare('SELECT draft FROM num_assets WHERE id=?').get(id).draft, 1);
  const r = await (await fleetDraft(jsonReq('fleet-draft', { action: 'confirm', id }), e, U('fleet-draft'), deps(db))).json();
  assert.equal(r.ok, true);
  assert.equal(db.prepare('SELECT draft FROM num_assets WHERE id=?').get(id).draft, 0);
});

test('a draft cannot go on the shelf before a human has checked it', async () => {
  const db = freshDb(); const e = env(db);
  const id = await oneDraft(db, e);
  const res = await fleetDraft(jsonReq('fleet-draft', { action: 'product', id }), e, U('fleet-draft'), deps(db));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'still_a_draft');
});

test('listing one as a product links it to the hull and leaves it switched off', async () => {
  const db = freshDb(); const e = env(db);
  const id = await oneDraft(db, e);
  await fleetDraft(jsonReq('fleet-draft', { action: 'confirm', id }), e, U('fleet-draft'), deps(db));
  const r = await (await fleetDraft(jsonReq('fleet-draft', { action: 'product', id }), e, U('fleet-draft'), deps(db))).json();
  assert.equal(r.ok, true);
  const p = db.prepare('SELECT * FROM num_host_products WHERE id=?').get(r.product_id);
  assert.equal(p.asset_id, id, 'a product knows which boat it is');
  assert.equal(p.active, 0, 'nothing switches itself on');
  assert.equal(p.host_id, 'h1');
  assert.ok(String(p.photo_url).startsWith('/p/asset/'), p.photo_url);
});

test('listing it twice updates the one product rather than making a second', async () => {
  const db = freshDb(); const e = env(db);
  const id = await oneDraft(db, e);
  await fleetDraft(jsonReq('fleet-draft', { action: 'confirm', id }), e, U('fleet-draft'), deps(db));
  const a = await (await fleetDraft(jsonReq('fleet-draft', { action: 'product', id }), e, U('fleet-draft'), deps(db))).json();
  const b = await (await fleetDraft(jsonReq('fleet-draft', { action: 'product', id }), e, U('fleet-draft'), deps(db))).json();
  assert.equal(a.product_id, b.product_id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM num_host_products').get().n, 1);
});

test('discard retires rather than deletes, and records when', async () => {
  const db = freshDb(); const e = env(db);
  const id = await oneDraft(db, e);
  await fleetDraft(jsonReq('fleet-draft', { action: 'discard', id }), e, U('fleet-draft'), deps(db));
  const a = db.prepare('SELECT * FROM num_assets WHERE id=?').get(id);
  assert.equal(a.status, 'retired');
  assert.ok(a.retired_at, '0021 requires it');
});

test("you cannot confirm, discard or shelve another host's asset", async () => {
  const db = freshDb(); const e = env(db);
  const id = await oneDraft(db, e);
  for (const action of ['confirm', 'discard', 'product']) {
    const res = await fleetDraft(jsonReq('fleet-draft', { action, id }), e, U('fleet-draft'), deps(db, { hostId: 'h2' }));
    assert.equal(res.status, 403, action);
  }
});

test('the drafts list shows only your own, and says whether reading photos is on', async () => {
  const db = freshDb(); const e = env(db);
  await oneDraft(db, e);
  const mine = await (await fleetDrafts(new Request(U('fleet-drafts')), e, U('fleet-drafts'), deps(db))).json();
  assert.equal(mine.ok, true);
  assert.equal(mine.vision, false);
  assert.ok(mine.drafts.length >= 1);
  const theirs = await (await fleetDrafts(new Request(U('fleet-drafts')), e, U('fleet-drafts'), deps(db, { hostId: 'h2' }))).json();
  assert.equal(theirs.drafts.length, 0);
});

/* ── the helpers ───────────────────────────────────────────────────────── */

test('base64 survives a photograph-sized buffer', () => {
  // 4MB through String.fromCharCode(...bytes) throws. This is the reason the
  // chunking exists, so it is the reason there is a test.
  const big = new Uint8Array(4 * 1024 * 1024).fill(65);
  const out = toBase64(big);
  assert.ok(out.length > 5_000_000);
  assert.equal(out.slice(0, 4), 'QUFB');
});

test('the same bytes hash the same, different bytes do not', async () => {
  const a = await sha256Hex(new Uint8Array([1, 2, 3]).buffer);
  const b = await sha256Hex(new Uint8Array([1, 2, 3]).buffer);
  const c = await sha256Hex(new Uint8Array([1, 2, 4]).buffer);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64);
});

/* ── THE TWO HOLES THIS FEATURE OPENED, PINNED SHUT ───────────────────────
   Both were found on 18 Sep 2026 by reading the existing endpoints back
   against the new one rather than by a test failing. Both are the same kind
   of bug: a new path made an old assumption untrue. */

test('A DRAFT CANNOT BE MADE LIVE — the human check is not bypassable', async () => {
  // Intake attaches the host's own uploads already approved, which satisfied
  // hostAssetPhoto's "has an approved photo" check the instant the upload
  // finished. Without a draft gate, "Go live" would have put a model's guess
  // about somebody's boat in front of a booker with nobody having read it.
  const { hostAssetPhoto } = await import('./hostassets.mjs');
  const db = freshDb(); const e = env(db);
  const id = await oneDraft(db, e);

  const live = new Request('https://itsnum.com/api/host/asset-photo?k=key-one', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'listable', asset_id: id, listable: 1 }),
  });
  const res = await hostAssetPhoto(live, e, U('asset-photo'), deps(db));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'still_a_draft');
  assert.equal(db.prepare('SELECT listable FROM num_assets WHERE id=?').get(id).listable, 0);
});

test('...and can be made live the moment a person has confirmed it', async () => {
  const { hostAssetPhoto } = await import('./hostassets.mjs');
  const db = freshDb(); const e = env(db);
  const id = await oneDraft(db, e);
  await fleetDraft(jsonReq('fleet-draft', { action: 'confirm', id }), e, U('fleet-draft'), deps(db));

  const live = new Request('https://itsnum.com/api/host/asset-photo?k=key-one', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'listable', asset_id: id, listable: 1 }),
  });
  const res = await hostAssetPhoto(live, e, U('asset-photo'), deps(db));
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT listable FROM num_assets WHERE id=?').get(id).listable, 1);
});

test("ONE HOST'S UNFILED UPLOADS ARE NOT IN ANOTHER HOST'S PHOTO QUEUE", async () => {
  // The queue's "or nobody we can place" arm was written when a text from a
  // stranger was the only way in. Console uploads also carry no supplier, so
  // for a few hours every host could see — and attach to their own boat —
  // every other host's unfiled photographs.
  const { hostAssets } = await import('./hostassets.mjs');
  const db = freshDb(); const e = env(db);
  await fleetUpload(upReq(PNG()), e, U('fleet-upload'), deps(db));

  const mine = await (await hostAssets(new Request(U('assets')), e, U('assets'), deps(db))).json();
  assert.equal(mine.queue.length, 1, 'my own unfiled upload is mine to see');

  const theirs = await (await hostAssets(
    new Request(U('assets')), e, U('assets'), deps(db, { hostId: 'h2' }),
  )).json();
  assert.equal(theirs.queue.length, 0, "and is not in another host's queue");
});

test('a text from a number nobody could place is still triaged, as before', async () => {
  // The fix must not quietly delete the behaviour it was narrowing.
  const { hostAssets } = await import('./hostassets.mjs');
  const db = freshDb(); const e = env(db);
  db.prepare(`INSERT INTO num_inbound_media
      (id,from_hash,from_last4,r2_key,content_type,sha256,provider,status,created_at)
    VALUES ('med_txt','abc','5678','k/x','image/jpeg','s1','twilio','unknown_sender','2026-09-18')`).run();
  const out = await (await hostAssets(new Request(U('assets')), e, U('assets'), deps(db))).json();
  assert.deepEqual(out.queue.map((q) => q.id), ['med_txt']);
});
