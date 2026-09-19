// The search a host runs when their client wants something they cannot do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { hostFind, likeTerm, rankHost } from './hostfind.mjs';

const load = (f) => readFileSync(new URL('../worker/migrations/' + f, import.meta.url), 'utf8');
const SQL = [load('0019_suppliers.sql'), load('0021_luxury_assets.sql'),
  load('0014_host_clients.sql'), load('0037_fleet_intake.sql')].join('\n');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_hosts (id TEXT PRIMARY KEY, name TEXT, company TEXT, blurb TEXT,
            status TEXT DEFAULT 'active', console_key TEXT, currency TEXT DEFAULT 'GBP',
            in_network INTEGER DEFAULT 0, services_json TEXT DEFAULT '[]', created_at TEXT DEFAULT '2026-01-01');`);
  db.exec(`CREATE TABLE num_jobs (id TEXT PRIMARY KEY);`);
  for (const stmt of SQL.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
    .split(';').map((x) => x.trim()).filter(Boolean)) {
    try { db.exec(stmt + ';'); } catch { /* not for this test */ }
  }
  db.prepare(`INSERT INTO num_hosts (id,name,company,blurb,console_key,in_network,services_json)
    VALUES ('h1','Me','Mine','',' key-one',1,'["car"]')`).run();
  db.prepare(`INSERT INTO num_hosts (id,name,company,blurb,console_key,in_network,services_json)
    VALUES ('h2','Bangkok Bob','BKK Cars','Drivers and airport runs across Bangkok','key-two',1,'["car","delivery"]')`).run();
  db.prepare(`INSERT INTO num_hosts (id,name,company,blurb,console_key,in_network,services_json)
    VALUES ('h3','Phuket Pearl','Pearl Charters','Boats out of Phuket','key-three',1,'["yacht"]')`).run();
  db.prepare(`INSERT INTO num_hosts (id,name,company,blurb,console_key,in_network,services_json)
    VALUES ('h4','Hidden Hank','Quiet Co','Not listed','key-four',0,'["car"]')`).run();
  const t = '2026-09-01 00:00:00';
  db.prepare(`INSERT INTO num_host_areas (id,host_id,city,country,radius_km,created_at) VALUES ('ar1','h2','Bangkok','Thailand',50,?)`).run(t);
  db.prepare(`INSERT INTO num_host_areas (id,host_id,city,country,radius_km,created_at) VALUES ('ar2','h3','Phuket','Thailand',50,?)`).run(t);
  return db;
}

function addAsset(db, { id, host, kind = 'yacht', name = 'M/Y Serenity', city = 'Phuket',
  listable = 1, photo = true, reg = 'HULL-999' } = {}) {
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,registration,home_city,home_country,
    currency,rate_minor,rate_unit,listable,status,created_at)
    VALUES (?,'supplier',?,?,?,?,?,?,'Thailand','GBP',0,'quote',?,'active','2026-09-01')`)
    .run(id, host, host, kind, name, reg, city, listable);
  if (photo) {
    db.prepare(`INSERT INTO num_asset_photos (id,asset_id,r2_key,content_type,source,moderation,position,created_at,decided_at,decided_by)
      VALUES (?,?,?,'image/png','upload','ok',1,'2026-09-01','2026-09-01','host')`)
      .run('aph_' + id, id, 'k/' + id);
  }
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
function deps(db, { hostId = 'h1' } = {}) {
  return {
    J: (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } }),
    clean: (s, max = 200) => (s === null || s === undefined ? '' : String(s).trim().slice(0, max)),
    hostAuth: async () => (hostId ? db.prepare('SELECT * FROM num_hosts WHERE id=?').get(hostId) : null),
  };
}
const find = async (db, qs, opts) => {
  const url = new URL('https://itsnum.com/api/host/find?k=key-one&' + qs);
  return (await hostFind(new Request(url), { DB: d1(db) }, url, deps(db, opts))).json();
};

/* ── who ───────────────────────────────────────────────────────────────── */

test('a search by city finds the host who covers it', async () => {
  const r = await find(freshDb(), 'city=Bangkok');
  assert.deepEqual(r.hosts.map((h) => h.host_id), ['h2']);
});

test('a search by service finds the host who does it', async () => {
  const r = await find(freshDb(), 'service=yacht');
  assert.deepEqual(r.hosts.map((h) => h.host_id), ['h3']);
});

test('free text reaches the blurb, not just the name', async () => {
  const r = await find(freshDb(), 'q=airport');
  assert.deepEqual(r.hosts.map((h) => h.host_id), ['h2']);
});

test('a host who is not in the network is never in the answer', async () => {
  const r = await find(freshDb(), 'service=car');
  assert.ok(!r.hosts.some((h) => h.host_id === 'h4'), 'h4 opted out');
});

test('you never find yourself', async () => {
  const r = await find(freshDb(), '');
  assert.ok(!r.hosts.some((h) => h.host_id === 'h1'));
});

test('no email or phone number is ever returned', async () => {
  const db = freshDb();
  const r = await find(db, '');
  const blob = JSON.stringify(r);
  assert.ok(!/@/.test(blob), blob);
  assert.ok(!/phone/.test(blob), blob);
});

test('someone you already work with comes first', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_host_links (id,host_a,host_b,asked_by,status,created_at)
    VALUES ('l1','h1','h3','h1','accepted','2026-09-01')`).run();
  const r = await find(db, 'country=Thailand');
  assert.equal(r.hosts[0].host_id, 'h3');
  assert.equal(r.hosts[0].connected, true);
  assert.equal(r.hosts.find((h) => h.host_id === 'h2').connected, false);
});

test('a link you asked for and have not got shows as asked, not connected', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_host_links (id,host_a,host_b,asked_by,status,created_at)
    VALUES ('l1','h1','h2','h1','pending','2026-09-01')`).run();
  const r = await find(db, 'city=Bangkok');
  assert.equal(r.hosts[0].asked, true);
  assert.equal(r.hosts[0].connected, false);
});

/* ── what ──────────────────────────────────────────────────────────────── */

test('a listed hull is found alongside its host', async () => {
  const db = freshDb();
  addAsset(db, { id: 'ast1', host: 'h3' });
  const r = await find(db, 'city=Phuket');
  assert.equal(r.assets.length, 1);
  assert.equal(r.assets[0].host_name, 'Phuket Pearl');
});

test('A REGISTRATION IS NEVER IN A SEARCH RESULT', async () => {
  // The search a host runs is copy they are about to paste into a message to
  // their client. clientView is what keeps the column out, and this is the
  // test that fails if somebody replaces it with a spread.
  const db = freshDb();
  addAsset(db, { id: 'ast1', host: 'h3', reg: 'HULL-SECRET-1' });
  const r = await find(db, '');
  assert.ok(!JSON.stringify(r).includes('HULL-SECRET'), JSON.stringify(r.assets[0]));
});

test('an asset with no approved photograph is not a listing', async () => {
  const db = freshDb();
  addAsset(db, { id: 'ast1', host: 'h3', photo: false });
  const r = await find(db, '');
  assert.equal(r.assets.length, 0);
});

test('an unlistable asset stays invisible', async () => {
  const db = freshDb();
  addAsset(db, { id: 'ast1', host: 'h3', listable: 0 });
  const r = await find(db, '');
  assert.equal(r.assets.length, 0);
});

test('your own assets are not offered back to you as somebody else’s supply', async () => {
  const db = freshDb();
  addAsset(db, { id: 'mine', host: 'h1' });
  const r = await find(db, '');
  assert.equal(r.assets.length, 0);
});

test('kind narrows the hulls', async () => {
  const db = freshDb();
  addAsset(db, { id: 'a1', host: 'h3', kind: 'yacht' });
  addAsset(db, { id: 'a2', host: 'h2', kind: 'car', name: 'S-Class', city: 'Bangkok' });
  const r = await find(db, 'kind=car');
  assert.deepEqual(r.assets.map((a) => a.name), ['S-Class']);
});

/* ── the awkward inputs ────────────────────────────────────────────────── */

test('a wildcard is a character, not a wildcard', async () => {
  // '%' alone would match every row and look like a brilliant search.
  const db = freshDb();
  const r = await find(db, 'q=%25');
  assert.equal(r.hosts.length, 0);
  assert.equal(likeTerm('%'), '%\\%%');
  assert.equal(likeTerm('a_b'), '%a\\_b%');
});

test('no query at all is the directory, not an error', async () => {
  const r = await find(freshDb(), '');
  assert.equal(r.ok, true);
  assert.equal(r.hosts.length, 2);
});

test('nothing found says what to do next instead of going quiet', async () => {
  const r = await find(freshDb(), 'city=Reykjavik');
  assert.equal(r.hosts.length, 0);
  assert.match(r.note, /Widen it/);
});

test('an unknown key gets nothing', async () => {
  const db = freshDb();
  const url = new URL('https://itsnum.com/api/host/find?k=nope');
  const res = await hostFind(new Request(url), { DB: d1(db) }, url, deps(db, { hostId: null }));
  assert.equal(res.status, 401);
});

test('the fee is stated where the work is handed over', async () => {
  const r = await find(freshDb(), '');
  assert.match(r.how_money_works, /never charges them/);
});

/* ── ranking ───────────────────────────────────────────────────────────── */

test('ranking prefers connection, then service, then place', () => {
  const base = { name: 'A', company: '', blurb: '', city: 'Bangkok', services: ['car'], assets: 0 };
  const q = { q: '', city: 'Bangkok', service: 'car' };
  assert.ok(rankHost({ ...base, connected: true }, q) > rankHost({ ...base, connected: false }, q));
  assert.ok(rankHost({ ...base, services: ['car'] }, q) > rankHost({ ...base, services: ['stay'] }, q));
  assert.ok(rankHost({ ...base, city: 'Bangkok' }, q) > rankHost({ ...base, city: 'Leeds' }, q));
});

test('a host with listed things ranks above one with none, but connection still wins', () => {
  const b = { name: 'A', company: '', blurb: '', city: '', services: [], connected: false };
  const q = { q: '', city: '', service: null };
  assert.ok(rankHost({ ...b, assets: 4 }, q) > rankHost({ ...b, assets: 0 }, q));
  assert.ok(rankHost({ ...b, assets: 0, connected: true }, q) > rankHost({ ...b, assets: 99 }, q));
});
