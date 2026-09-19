// The supplier layer. Who may be added, who may be named as an owner, and what
// a host is told when it refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { hostSuppliers, supplierAssets, SUPPLIER_KINDS } from './hostsuppliers.mjs';
import { hostAssets } from './hostassets.mjs';

const M = (f) => readFileSync(new URL('../worker/migrations/' + f, import.meta.url), 'utf8');
const ALL = [M('0019_suppliers.sql'), M('0021_luxury_assets.sql'), M('0022_supplier_contact.sql')].join('\n');
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_members (id TEXT PRIMARY KEY, phone TEXT, phone_verified INTEGER DEFAULT 0);`);
  db.exec(`CREATE TABLE num_hosts (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active', console_key TEXT, currency TEXT DEFAULT 'GBP');`);
  for (const raw of ALL.split(';')) {
    const stmt = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (!stmt) continue;
    try { db.exec(stmt + ';'); } catch { /* not for this test's tables */ }
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
      // D1 reports changes as result.meta.changes. node:sqlite reports
      // result.changes. Handlers check meta.changes to tell "nothing matched"
      // from "it worked", so a stub that does not reshape this leaves the
      // not-found branch permanently untested and permanently wrong.
      async run() { const r = go('run'); return { ...r, meta: { changes: Number(r.changes ?? 0) } }; },
      _run: () => go('run'),
    };
    return api;
  },
  // env.DB.batch — runs the prepared statements in order, like D1 does.
  async batch(stmts) { return stmts.map((s) => s._run()); },
});

const stripControl = (s) => String(s).split('')
  .filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127).join('');

function deps(db, { hostId = 'h1', mail = [] } = {}) {
  return {
    J: (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } }),
    clean: (s, max = 200) => (s === null || s === undefined ? '' : stripControl(s).trim().slice(0, max)),
    readJSON: async (req) => req.json(),
    badOrigin: () => false,
    hostAuth: async () => (hostId ? db.prepare(`SELECT * FROM num_hosts WHERE id=?`).get(hostId) : null),
    sendBatch: async (env, msgs) => { mail.push(...msgs); return { ok: true }; },
    _mail: mail,
  };
}

const POST = (body) => new Request('https://itsnum.com/api/host/suppliers', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const GET = () => new Request('https://itsnum.com/api/host/suppliers');
const U = (qs = '') => new URL('https://itsnum.com/api/host/suppliers?k=key-one' + qs);
const jsonOf = (res) => res.json();

/* adding somebody */

test('adding a supplier stores them, links them, and turns texting photos on', async () => {
  const db = freshDb();
  const D = deps(db);
  const out = await jsonOf(await hostSuppliers(POST({
    display_name: 'Marco at Royal Phuket', kind: 'marina',
    phone: '+66812345678', email: 'marco@example.com', business_name: 'Royal Phuket Marine',
  }), { DB: d1(db) }, U(), D));
  assert.equal(out.ok, true);
  assert.equal(out.suppliers.length, 1);

  const s = db.prepare(`SELECT * FROM num_suppliers`).get();
  assert.equal(s.phone, '+66812345678');
  assert.equal(s.added_by_host, 'h1');
  assert.equal(s.accepts_mms, 1, 'texting photos in is the point of the record');
  assert.ok(s.invited_at);

  const l = db.prepare(`SELECT * FROM num_supplier_links`).get();
  assert.equal(l.host_id, 'h1');
  assert.equal(l.supplier_id, s.id);
  assert.equal(l.asked_by, 'host');
  assert.equal(l.status, 'accepted');
  assert.ok(l.decided_at);
});

test('a supplier who is not a NUM member still gets a valid row', async () => {
  const db = freshDb();
  await hostSuppliers(POST({ display_name: 'Marco', phone: '+66812345678' }), { DB: d1(db) }, U(), deps(db));
  const s = db.prepare(`SELECT * FROM num_suppliers`).get();
  // member_id is NOT NULL in 0019. It carries the supplier's own id, which says
  // "this person exists only as a supplier" rather than pointing at somebody
  // else's member row.
  assert.equal(s.member_id, s.id);
});

test('adding somebody TELLS them — that is the consent step', async () => {
  const db = freshDb();
  const D = deps(db);
  await hostSuppliers(POST({
    display_name: 'Marco', phone: '+66812345678', email: 'marco@example.com',
  }), { DB: d1(db), SITE: 'https://itsnum.com' }, U(), D);

  assert.equal(D._mail.length, 1, 'a record created quietly about somebody is a list, not a relationship');
  const m = D._mail[0];
  assert.equal(m.to, 'marco@example.com');
  assert.match(m.subject, /Host One/, 'the host must be named, not NUM alone');
  assert.match(m.text, /pay you\s*\ndirectly/, 'the money rule has to be in the first mail he gets');
  assert.match(m.text, /\+66812345678/, 'tell him which number to text photos from');
  assert.match(m.text, /STOP/, 'a way out must be in the same message');
  // With no inbound number configured this deployment cannot make the promise,
  // so it says so instead of leaving a sentence with a hole in it.
  assert.match(m.text, /not switched on just yet/);
});

test('...and tells him BOTH numbers once texting in is configured', async () => {
  // The half that was missing until 19 Sep 2026: "to NUM" with no address.
  // From-number and to-number are different things and he needs both.
  const db = freshDb();
  const D = deps(db);
  await hostSuppliers(POST({
    display_name: 'Marco', phone: '+66812345678', email: 'marco@example.com',
  }), { DB: d1(db), SITE: 'https://itsnum.com', TWILIO_FROM: '+14243460888' }, U(), D);

  const m = D._mail[0];
  assert.match(m.text, /to NUM on \+14243460888/, 'the destination');
  assert.match(m.text, /from \+66812345678/, 'and the number he sends it from');
  assert.equal(/not switched on/.test(m.text), false);
});

test('no email means no mail, and the record still stands', async () => {
  const db = freshDb();
  const D = deps(db);
  const out = await jsonOf(await hostSuppliers(
    POST({ display_name: 'Marco', phone: '+66812345678' }), { DB: d1(db) }, U(), D,
  ));
  assert.equal(out.ok, true);
  assert.equal(D._mail.length, 0);
  assert.equal(db.prepare(`SELECT notified_at FROM num_suppliers`).get().notified_at, null,
    'notified_at must stay empty so the console can show "not told yet"');
});

/* the phone, which is what makes the whole thing work */

test('a number with no country code is refused with an explanation', async () => {
  const db = freshDb();
  const out = await jsonOf(await hostSuppliers(
    POST({ display_name: 'Marco', phone: '0812345678' }), { DB: d1(db) }, U(), deps(db),
  ));
  assert.equal(out.ok, false);
  assert.equal(out.error, 'bad_phone');
  assert.match(out.says, /\+66/, 'the refusal must show the host what a good number looks like');
  assert.match(out.says, /country code/i);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM num_suppliers`).get().n, 0,
    'a number we cannot place must not be stored loosely — a photo would resolve to the wrong person');
});

test('a supplier with no contact at all is refused', async () => {
  const db = freshDb();
  const out = await jsonOf(await hostSuppliers(
    POST({ display_name: 'Nobody' }), { DB: d1(db) }, U(), deps(db),
  ));
  assert.equal(out.error, 'no_contact');
  assert.match(out.says, /text photos in/);
});

test('an email-only supplier is allowed — they just cannot text photos', async () => {
  const db = freshDb();
  const out = await jsonOf(await hostSuppliers(
    POST({ display_name: 'Agency', email: 'ops@example.com' }), { DB: d1(db) }, U(), deps(db),
  ));
  assert.equal(out.ok, true);
  assert.equal(db.prepare(`SELECT phone FROM num_suppliers`).get().phone, null);
});

test('no name is refused', async () => {
  const db = freshDb();
  const out = await jsonOf(await hostSuppliers(
    POST({ phone: '+66812345678' }), { DB: d1(db) }, U(), deps(db),
  ));
  assert.equal(out.error, 'no_name');
});

test('adding the same number twice is refused by name, not by a constraint error', async () => {
  const db = freshDb();
  const env = { DB: d1(db) };
  await hostSuppliers(POST({ display_name: 'Marco', phone: '+66812345678' }), env, U(), deps(db));
  const out = await jsonOf(await hostSuppliers(
    POST({ display_name: 'Marco again', phone: '+66812345678' }), env, U(), deps(db),
  ));
  assert.equal(out.error, 'already_added');
  assert.match(out.says, /Marco/);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM num_suppliers`).get().n, 1,
    'two rows for one person means a photo resolves to whichever sorted first');
});

test('two different hosts may each have the same person', async () => {
  const db = freshDb();
  const env = { DB: d1(db) };
  await hostSuppliers(POST({ display_name: 'Marco', phone: '+66812345678' }), env, U(), deps(db));
  const out = await jsonOf(await hostSuppliers(
    POST({ display_name: 'Marco', phone: '+66812345678' }), env, U(), deps(db, { hostId: 'h2' }),
  ));
  assert.equal(out.ok, true, 'a marina works for more than one host');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM num_suppliers`).get().n, 2);
});

/* ending, and reviving */

test('removing a supplier ends the link with a name on it', async () => {
  const db = freshDb();
  const env = { DB: d1(db) };
  await hostSuppliers(POST({ display_name: 'Marco', phone: '+66812345678' }), env, U(), deps(db));
  const linkId = db.prepare(`SELECT id FROM num_supplier_links`).get().id;
  const out = await jsonOf(await hostSuppliers(POST({ action: 'end', id: linkId }), env, U(), deps(db)));
  assert.equal(out.ok, true);
  assert.equal(out.suppliers.length, 0, 'an ended supplier comes off the list');
  const l = db.prepare(`SELECT * FROM num_supplier_links`).get();
  assert.equal(l.status, 'ended');
  assert.ok(l.ended_at);
  assert.ok(l.ended_by, 'the CHECK refuses an ended link with nobody responsible');
});

test('re-adding somebody you removed revives the link rather than duplicating them', async () => {
  const db = freshDb();
  const env = { DB: d1(db) };
  await hostSuppliers(POST({ display_name: 'Marco', phone: '+66812345678' }), env, U(), deps(db));
  const linkId = db.prepare(`SELECT id FROM num_supplier_links`).get().id;
  await hostSuppliers(POST({ action: 'end', id: linkId }), env, U(), deps(db));

  const out = await jsonOf(await hostSuppliers(
    POST({ display_name: 'Marco', phone: '+66812345678' }), env, U(), deps(db),
  ));
  assert.equal(out.ok, true);
  assert.equal(out.suppliers.length, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM num_suppliers`).get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM num_supplier_links`).get().n, 1);
});

test('a host cannot end another hosts link', async () => {
  const db = freshDb();
  const env = { DB: d1(db) };
  await hostSuppliers(POST({ display_name: 'Marco', phone: '+66812345678' }), env, U(), deps(db, { hostId: 'h2' }));
  const linkId = db.prepare(`SELECT id FROM num_supplier_links`).get().id;
  const out = await jsonOf(await hostSuppliers(POST({ action: 'end', id: linkId }), env, U(), deps(db)));
  assert.equal(out.error, 'not_found');
  assert.equal(db.prepare(`SELECT status FROM num_supplier_links`).get().status, 'accepted');
});

/* the list */

test('a host sees their own suppliers and nobody elses', async () => {
  const db = freshDb();
  const env = { DB: d1(db) };
  await hostSuppliers(POST({ display_name: 'Mine', phone: '+66811111111' }), env, U(), deps(db));
  await hostSuppliers(POST({ display_name: 'Theirs', phone: '+66822222222' }), env, U(), deps(db, { hostId: 'h2' }));
  const out = await jsonOf(await hostSuppliers(GET(), env, U(), deps(db)));
  assert.equal(out.suppliers.length, 1);
  assert.equal(out.suppliers[0].display_name, 'Mine');
});

test('the list says how many photos are waiting on each supplier', async () => {
  const db = freshDb();
  const env = { DB: d1(db) };
  await hostSuppliers(POST({ display_name: 'Marco', phone: '+66812345678' }), env, U(), deps(db));
  const sid = db.prepare(`SELECT id FROM num_suppliers`).get().id;
  db.prepare(`INSERT INTO num_inbound_media (id,from_hash,supplier_id,r2_key,content_type,sha256,status,created_at)
              VALUES ('m1','h',?,'k','image/jpeg','s1','new',?)`).run(sid, ts());
  const out = await jsonOf(await hostSuppliers(GET(), env, U(), deps(db)));
  assert.equal(out.suppliers[0].photos_waiting, 1);
});

test('no console key means no supplier list', async () => {
  const db = freshDb();
  const res = await hostSuppliers(GET(), { DB: d1(db) }, U(), deps(db, { hostId: null }));
  assert.equal(res.status, 401);
});

test('every kind the form offers is one the server accepts', () => {
  const html = readFileSync(new URL('../public/host/index.html', import.meta.url), 'utf8');
  const form = html.slice(html.indexOf('id="sp_kind"'), html.indexOf('</select>', html.indexOf('id="sp_kind"')));
  const offered = [...form.matchAll(/value="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(offered.length >= 5, `expected the form to offer several kinds, found ${offered.length}`);
  for (const k of offered) {
    assert.ok(SUPPLIER_KINDS.includes(k), `the form offers "${k}" which the server would silently turn into "other"`);
  }
});

/* THE HOLE: naming somebody elses supplier as the owner of your asset */

test('a host cannot put an asset in a suppliers hands unless they are linked', async () => {
  const db = freshDb();
  const env = { DB: d1(db) };
  // h2's supplier.
  await hostSuppliers(POST({ display_name: 'Theirs', phone: '+66822222222' }), env, U(), deps(db, { hostId: 'h2' }));
  const theirs = db.prepare(`SELECT id FROM num_suppliers`).get().id;

  const out = await jsonOf(await hostAssets(
    new Request('https://itsnum.com/api/host/assets', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'yacht', name: 'Not Mine', owner_id: theirs }),
    }), env, U(), deps(db),
  ));
  assert.equal(out.ok, false);
  assert.equal(out.error, 'not_your_supplier');
  assert.match(out.says, /Add them/);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM num_assets`).get().n, 0,
    'otherwise a competitors supplier sees a boat they have never heard of, with your rate on it');
});

test('a host CAN put an asset in their own suppliers hands', async () => {
  const db = freshDb();
  const env = { DB: d1(db) };
  await hostSuppliers(POST({ display_name: 'Marco', phone: '+66812345678' }), env, U(), deps(db));
  const mine = db.prepare(`SELECT id FROM num_suppliers`).get().id;

  const out = await jsonOf(await hostAssets(
    new Request('https://itsnum.com/api/host/assets', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'yacht', name: 'Serenity II', owner_id: mine }),
    }), env, U(), deps(db),
  ));
  assert.equal(out.ok, true);
  const a = db.prepare(`SELECT * FROM num_assets`).get();
  assert.equal(a.owner_id, mine);
  assert.equal(a.host_id, 'h1', 'the host still hosts it — that is what listable depends on');
});

test('an asset with no owner named belongs to the host, and that always passes', async () => {
  const db = freshDb();
  const out = await jsonOf(await hostAssets(
    new Request('https://itsnum.com/api/host/assets', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'car', name: 'Defender' }),
    }), { DB: d1(db) }, U(), deps(db),
  ));
  assert.equal(out.ok, true);
  assert.equal(db.prepare(`SELECT owner_id FROM num_assets`).get().owner_id, 'h1');
});

test('an ended link stops being good enough to own an asset', async () => {
  const db = freshDb();
  const env = { DB: d1(db) };
  await hostSuppliers(POST({ display_name: 'Marco', phone: '+66812345678' }), env, U(), deps(db));
  const sid = db.prepare(`SELECT id FROM num_suppliers`).get().id;
  const linkId = db.prepare(`SELECT id FROM num_supplier_links`).get().id;
  await hostSuppliers(POST({ action: 'end', id: linkId }), env, U(), deps(db));

  const out = await jsonOf(await hostAssets(
    new Request('https://itsnum.com/api/host/assets', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'boat', name: 'After', owner_id: sid }),
    }), env, U(), deps(db),
  ));
  assert.equal(out.error, 'not_your_supplier');
});

/* what a supplier holds */

test('a host can see what their own supplier looks after', async () => {
  const db = freshDb();
  const env = { DB: d1(db) };
  await hostSuppliers(POST({ display_name: 'Marco', phone: '+66812345678' }), env, U(), deps(db));
  const sid = db.prepare(`SELECT id FROM num_suppliers`).get().id;
  db.prepare(`INSERT INTO num_assets (id,owner_kind,owner_id,host_id,kind,name,rate_unit,created_at)
              VALUES ('a1','supplier',?,'h1','boat','Serenity II','quote',?)`).run(sid, ts());

  const out = await jsonOf(await supplierAssets(
    GET(), env, new URL('https://itsnum.com/api/host/supplier-assets?k=key-one&id=' + sid), deps(db),
  ));
  assert.equal(out.ok, true);
  assert.equal(out.assets.length, 1);
  assert.equal(out.assets[0].name, 'Serenity II');
});

test('a host cannot see what another hosts supplier looks after', async () => {
  const db = freshDb();
  const env = { DB: d1(db) };
  await hostSuppliers(POST({ display_name: 'Theirs', phone: '+66822222222' }), env, U(), deps(db, { hostId: 'h2' }));
  const sid = db.prepare(`SELECT id FROM num_suppliers`).get().id;
  const out = await jsonOf(await supplierAssets(
    GET(), env, new URL('https://itsnum.com/api/host/supplier-assets?k=key-one&id=' + sid), deps(db),
  ));
  assert.equal(out.error, 'not_your_supplier');
});
