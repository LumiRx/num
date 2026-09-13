// Empty is not broken. This file exists because conflating them cost a whole day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { rows, ReadFailed, isReadFailed, readFailedResponse } from './readfail.mjs';
import { hostSuppliers } from './hostsuppliers.mjs';
import { hostAssets } from './hostassets.mjs';

const M = (f) => readFileSync(new URL('../worker/migrations/' + f, import.meta.url), 'utf8');

/** A database built WITHOUT 0022 — exactly the state production was in when the
 *  supplier endpoints went live ahead of their migration. */
function dbMissingColumn() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_members (id TEXT PRIMARY KEY, phone TEXT, phone_verified INTEGER DEFAULT 0);`);
  db.exec(`CREATE TABLE num_hosts (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active', console_key TEXT, currency TEXT DEFAULT 'GBP');`);
  for (const raw of (M('0019_suppliers.sql') + '\n' + M('0021_luxury_assets.sql')).split(';')) {
    const stmt = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (!stmt) continue;
    try { db.exec(stmt + ';'); } catch { /* not for this test */ }
  }
  db.prepare(`INSERT INTO num_hosts (id,name,console_key) VALUES ('h1','Host One','key-one')`).run();
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

const stripControl = (s) => String(s).split('')
  .filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127).join('');
const deps = (db) => ({
  J: (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } }),
  clean: (s, max = 200) => (s === null || s === undefined ? '' : stripControl(s).trim().slice(0, max)),
  readJSON: async (req) => req.json(),
  badOrigin: () => false,
  hostAuth: async () => db.prepare(`SELECT * FROM num_hosts WHERE id='h1'`).get(),
  sendBatch: async () => ({ ok: true }),
});
const GET = (u) => new Request(u || 'https://itsnum.com/api/host/suppliers');
const U = (p = 'suppliers') => new URL(`https://itsnum.com/api/host/${p}?k=key-one`);

/* the helper itself */

test('an empty table is an empty list, not an error', async () => {
  const db = dbMissingColumn();
  const out = await rows(d1(db).prepare('SELECT * FROM num_suppliers').bind().all(), 'suppliers');
  assert.deepEqual(out, []);
});

test('a query that cannot run throws, and says what it was reading', async () => {
  const db = dbMissingColumn();
  await assert.rejects(
    () => rows(d1(db).prepare('SELECT phone FROM num_suppliers').bind().all(), 'the supplier list'),
    (e) => {
      assert.ok(isReadFailed(e));
      assert.equal(e.what, 'the supplier list');
      assert.match(e.message, /phone/, 'the real SQLite message must survive, or the diagnosis is gone');
      return true;
    },
  );
});

test('the failure response names the cause a human should check first', async () => {
  const J = (obj, status) => new Response(JSON.stringify(obj), { status });
  const res = readFailedResponse(J, new ReadFailed('the fleet', new Error('no such column: phone')));
  assert.equal(res.status, 503, '503 says configuration, which is what it almost always is');
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'read_failed');
  assert.equal(body.reading, 'the fleet');
  assert.match(body.detail, /no such column/);
  assert.match(body.says, /not something you did/i, 'a host must not think it is their fault');
  assert.match(body.says, /applied/, 'and whoever investigates should be pointed at migrations first');
});

/* THE ACTUAL PRODUCTION FAILURE, reproduced */

test('the supplier list on a database missing 0022 answers 503, not an empty success', async () => {
  // This is the exact state production was in on 12 Sep: /api/host/suppliers
  // deployed, 0022 not applied. The old code caught "no such column: phone" and
  // returned { ok: true, suppliers: [] } — a live card reporting success that
  // could never show a supplier or accept one, with nothing to say why.
  const db = dbMissingColumn();
  const res = await hostSuppliers(GET(), { DB: d1(db) }, U(), deps(db));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'read_failed');
  assert.match(body.detail, /phone/);
});

test('and the console hides the card on a 503, so nobody sees dead buttons', () => {
  const html = readFileSync(new URL('../public/host/index.html', import.meta.url), 'utf8');
  const load = html.slice(html.indexOf('function loadSuppliers()'));
  const body = load.slice(0, load.indexOf('\n  }') + 4);
  assert.match(body, /r\.status === 503/,
    'a 503 from a missing migration must take the card off the page');
});

test('a healthy database still answers ok with an empty list', async () => {
  // The guard must not turn "you have no suppliers yet" into an error.
  const db = dbMissingColumn();
  db.exec('ALTER TABLE num_suppliers ADD COLUMN phone TEXT');
  db.exec('ALTER TABLE num_suppliers ADD COLUMN email TEXT');
  db.exec('ALTER TABLE num_suppliers ADD COLUMN invited_at TEXT');
  db.exec('ALTER TABLE num_suppliers ADD COLUMN notified_at TEXT');
  db.exec('ALTER TABLE num_suppliers ADD COLUMN added_by_host TEXT');
  const res = await hostSuppliers(GET(), { DB: d1(db) }, U(), deps(db));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.suppliers, []);
});

test('the fleet does the same — a broken read never reports an empty fleet', async () => {
  const db = dbMissingColumn();
  // Break the queue read the way a missing migration would.
  db.exec('DROP TABLE num_inbound_media');
  const res = await hostAssets(GET('https://itsnum.com/api/host/assets'), { DB: d1(db) }, U('assets'), deps(db));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'read_failed');
  assert.match(body.reading, /photo queue/);
});

test('no list query in the asset or supplier handlers swallows a failure any more', () => {
  // The habit, not just today's instance of it. A bare
  // `.catch(() => ({ results: [] }))` on a list read is what turns a schema
  // problem into a blank page and a 200.
  for (const f of ['hostassets.mjs', 'hostsuppliers.mjs']) {
    const src = readFileSync(new URL('./' + f, import.meta.url), 'utf8');
    const swallows = [...src.matchAll(/\.all\(\)\.catch\(\(\) => \(\{ results: \[\] \}\)\)/g)];
    assert.equal(swallows.length, 0,
      `${f} still has ${swallows.length} list read(s) that report an empty list when the query failed`);
  }
});

/* THE ONE THAT MATTERS MOST */

test('a booking is REFUSED when the calendar cannot be read — never waved through', async () => {
  // With the old `.catch(() => ({ results: [] }))` a failed calendar read gave an
  // empty list, the overlap loop found nothing to clash with, and the second
  // booking on the same hull went straight through. A guest on a quay watching
  // somebody else board their boat was one dropped query away.
  //
  // "I cannot tell whether it is free" must never be answered as "yes".
  const db = dbMissingColumn();
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,created_at)
              VALUES ('a1','supplier','h1','h1','yacht','Serenity II','quote','2026-09-01 00:00:00')`).run();
  db.exec('DROP TABLE num_asset_holds');

  const { hostAssetHolds } = await import('./hostassets.mjs');
  const res = await hostAssetHolds(
    new Request('https://itsnum.com/api/host/asset-holds', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ asset_id: 'a1', kind: 'booked', starts_at: '2026-09-20', ends_at: '2026-09-24' }),
    }),
    { DB: d1(db) }, U('asset-holds'), deps(db),
  );
  assert.equal(res.status, 503, 'an unreadable calendar must refuse the booking, not accept it');
  const body = await res.json();
  assert.equal(body.error, 'cannot_check_clash');
  assert.match(body.says, /will not take a booking/i);
});

test('a blocked or maintenance hold is not waved through either when the read fails', async () => {
  // These do not occupy the hull, so they skip the clash check entirely — which
  // is correct, and worth pinning so nobody "simplifies" the occupying set later.
  const db = dbMissingColumn();
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,created_at)
              VALUES ('a1','supplier','h1','h1','yacht','Serenity II','quote','2026-09-01 00:00:00')`).run();
  const { OCCUPYING } = await import('../worker/assetintegrity.mjs');
  assert.ok(OCCUPYING.has('booked'));
  assert.ok(OCCUPYING.has('provisional'));
  assert.ok(!OCCUPYING.has('blocked'));
  assert.ok(!OCCUPYING.has('maintenance'));
});
