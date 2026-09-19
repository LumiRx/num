// One client's file: what is in it, who may read it, and what the money says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { hostClient, hostClientWrite, hostClientImport, tidyInterests, clientFile } from './clientfile.mjs';

const load = (f) => readFileSync(new URL('../worker/migrations/' + f, import.meta.url), 'utf8');
const SQL = [load('0014_host_clients.sql'), load('0015_host_separation.sql'),
  load('0018_host_client_intake.sql'), load('0020_requests_booking_fee.sql'),
  load('0038_client_file.sql')].join('\n');

const T = '2026-09-01 00:00:00';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_hosts (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active',
            console_key TEXT, currency TEXT DEFAULT 'GBP');`);
  for (const stmt of SQL.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
    .split(';').map((x) => x.trim()).filter(Boolean)) {
    try { db.exec(stmt + ';'); } catch { /* not for this test */ }
  }
  db.prepare(`INSERT INTO num_hosts (id,name,console_key) VALUES ('h1','Host One','key-one')`).run();
  db.prepare(`INSERT INTO num_hosts (id,name,console_key) VALUES ('h2','Host Two','key-two')`).run();
  addClient(db, 'c1', 'h1', 'Ada Lovelace');
  addClient(db, 'c9', 'h2', 'Somebody Else');
  return db;
}
function addClient(db, id, host, name) {
  db.prepare(`INSERT INTO num_host_clients (id,host_id,name,consent_text,status,member_token,created_at)
    VALUES (?,?,?,'a private client since 2019 who gave me these details directly','active',?,?)`)
    .run(id, host, name, 'tok_' + id, T);
}
function addWork(db, { id, host = 'h1', client = 'c1', title = 'Car from LAX', status = 'confirmed',
  price = 25000, starts = '2026-12-01 09:00:00' } = {}) {
  db.prepare(`INSERT INTO num_host_requests (id,host_id,client_id,service_key,title,starts_at,
    price_minor,currency,unit,status,created_at) VALUES (?,?,?,'car',?,?,?,'GBP','quote',?,?)`)
    .run(id, host, client, title, starts, price, status, T);
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
    readJSON: async (r) => r.json(),
    badOrigin: () => false,
    hostAuth: async () => (hostId ? db.prepare('SELECT * FROM num_hosts WHERE id=?').get(hostId) : null),
  };
}
const env = (db) => ({ DB: d1(db), SITE: 'https://itsnum.com' });

const read = async (db, id = 'c1', opts) => {
  const url = new URL('https://itsnum.com/api/host/client?k=key-one&id=' + id);
  return (await hostClient(new Request(url), env(db), url, deps(db, opts))).json();
};
const write = async (db, body, opts) => {
  const url = new URL('https://itsnum.com/api/host/client?k=key-one');
  const req = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return hostClientWrite(req, env(db), url, deps(db, opts));
};
const importIcs = async (db, text, id = 'c1', opts) => {
  const url = new URL('https://itsnum.com/api/host/client-import?k=key-one&id=' + id);
  const req = new Request(url, { method: 'POST', headers: { 'content-type': 'text/calendar' }, body: text });
  return (await hostClientImport(req, env(db), url, deps(db, opts))).json();
};

/* ── who may read it ───────────────────────────────────────────────────── */

test("another host's client is not found, not refused with detail", async () => {
  const db = freshDb();
  const url = new URL('https://itsnum.com/api/host/client?k=key-one&id=c9');
  const res = await hostClient(new Request(url), env(db), url, deps(db));
  assert.equal(res.status, 404);
});

test('every write re-derives ownership from the database', async () => {
  const db = freshDb();
  for (const body of [
    { action: 'save', id: 'c9', likes: 'nothing' },
    { action: 'event', id: 'c9', title: 'x', starts_at: '2026-10-01' },
    { action: 'portal', id: 'c9', portal_trips: 0 },
  ]) {
    const res = await write(db, body);
    assert.equal(res.status, 404, body.action);
  }
  assert.equal(db.prepare('SELECT likes FROM num_host_clients WHERE id=?').get('c9').likes, null);
});

/* ── what they like ────────────────────────────────────────────────────── */

test('likes, dislikes and the ones that are not preferences are saved apart', async () => {
  const db = freshDb();
  await write(db, {
    action: 'save', id: 'c1',
    likes: 'Corner tables. Burgundy.', dislikes: 'No boats. Never before 9am.',
    dietary: 'Shellfish allergy — anaphylactic', access_needs: 'Step-free',
    interests: ['opera', 'diving'], birthday: '03-14', company: 'Analytical Engines',
  });
  const r = await read(db);
  assert.equal(r.client.likes, 'Corner tables. Burgundy.');
  assert.equal(r.client.dislikes, 'No boats. Never before 9am.');
  // The allergy is its own field, not one line among ten in notes.
  assert.match(r.client.dietary, /Shellfish/);
  assert.equal(r.client.access_needs, 'Step-free');
  assert.deepEqual(r.client.interests, ['opera', 'diving']);
  assert.equal(r.client.birthday, '03-14');
  assert.equal(r.client.company, 'Analytical Engines');
});

test('interests are tags — trimmed, deduped, capped, and a string works too', () => {
  assert.deepEqual(tidyInterests(' golf , Golf,  opera '), ['golf', 'opera']);
  assert.deepEqual(tidyInterests(['a', '', null, 'b']), ['a', 'b']);
  assert.equal(tidyInterests(Array.from({ length: 40 }, (_, i) => 'k' + i)).length, 20);
});

test('the consent record is never echoed into the file view', () => {
  // It is a legal record, shown once where it was given — not a field that
  // travels into every view and every log line.
  const out = JSON.stringify(clientFile({ id: 'c1', name: 'A', consent_text: 'SECRET BASIS', status: 'active' }));
  assert.ok(!out.includes('SECRET BASIS'), out);
});

/* ── the calendar ──────────────────────────────────────────────────────── */

const TRIP = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:trip-1', 'SUMMARY:BA009 LHR-BKK', 'DTSTART:20261201T120000', 'DTEND:20261201T235500', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:trip-2', 'SUMMARY:Board meeting', 'DTSTART;VALUE=DATE:20261203', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('an .ics their client sent becomes their calendar', async () => {
  const db = freshDb();
  const r = await importIcs(db, TRIP);
  assert.equal(r.added, 2);
  const file = await read(db);
  assert.equal(file.calendar.ahead.length, 2);
  assert.equal(file.calendar.ahead[0].source, 'import');
});

test('THE SAME TRIP SENT TWICE IS ONE CALENDAR, NOT TWO', async () => {
  const db = freshDb();
  await importIcs(db, TRIP);
  const again = await importIcs(db, TRIP.replace('BA009 LHR-BKK', 'BA009 LHR-BKK (moved to T3)'));
  assert.equal(again.added, 0);
  assert.equal(again.updated, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM num_client_events').get().n, 2);
  // And the update is the point: the changed title is the one held now.
  assert.match(db.prepare("SELECT title FROM num_client_events WHERE uid='trip-1'").get().title, /T3/);
});

test('a calendar that is half-broken imports the readable half and says what it could not read', async () => {
  const db = freshDb();
  const r = await importIcs(db, [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Fine', 'DTSTART:20261201T120000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'DTSTART:20261202T120000', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'));
  assert.equal(r.added, 1);
  assert.equal(r.skipped, 1);
  assert.match(r.says, /could not read/);
});

test('a file with nothing in it is refused in words, not with a stack trace', async () => {
  const db = freshDb();
  const r = await importIcs(db, 'this is a holiday photo, not a calendar');
  assert.equal(r.ok, false);
  assert.match(r.says, /\.ics/);
});

test('a whole exported calendar is refused, and says what to send instead', async () => {
  const db = freshDb();
  const r = await importIcs(db, 'X'.repeat(600 * 1024));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'too_big');
  assert.match(r.says, /just the trip/);
});

test("an import cannot be aimed at another host's client", async () => {
  const db = freshDb();
  const url = new URL('https://itsnum.com/api/host/client-import?k=key-one&id=c9');
  const res = await hostClientImport(
    new Request(url, { method: 'POST', body: TRIP }), env(db), url, deps(db),
  );
  assert.equal(res.status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM num_client_events').get().n, 0);
});

test('a host can add an entry by hand and remove it again', async () => {
  const db = freshDb();
  const made = await (await write(db, { action: 'event', id: 'c1', title: 'Anniversary dinner', starts_at: '2026-11-02 20:00:00', location: 'Rome' })).json();
  assert.equal(made.ok, true);
  assert.equal(db.prepare('SELECT source FROM num_client_events WHERE id=?').get(made.event_id).source, 'host');
  const gone = await (await write(db, { action: 'event-delete', id: 'c1', event_id: made.event_id })).json();
  assert.equal(gone.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM num_client_events').get().n, 0);
});

test('an entry with no date is refused in words', async () => {
  const db = freshDb();
  const res = await write(db, { action: 'event', id: 'c1', title: 'Something' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).says, /a date/);
});

/* ── bookings, history, money ──────────────────────────────────────────── */

test('what is coming and what has been are split for the host, not left to them', async () => {
  const db = freshDb();
  addWork(db, { id: 'r1', starts: '2026-12-01 09:00:00' });
  addWork(db, { id: 'r2', starts: '2026-01-05 09:00:00', title: 'Last winter' });
  const r = await read(db);
  assert.deepEqual(r.bookings.map((x) => x.id), ['r1']);
  assert.deepEqual(r.history.map((x) => x.id), ['r2']);
});

test('only confirmed work is money', async () => {
  const db = freshDb();
  addWork(db, { id: 'r1', status: 'confirmed', price: 25000 });
  addWork(db, { id: 'r2', status: 'declined', price: 999999 });
  const r = await read(db);
  assert.equal(r.money.confirmed_minor, 25000);
  assert.deepEqual(r.money.invoices.map((i) => i.id), ['r1']);
});

test('an invoice line starts unbilled, is sent, then paid', async () => {
  const db = freshDb();
  addWork(db, { id: 'r1' });
  assert.equal((await read(db)).money.invoices[0].state, 'unbilled');

  await write(db, { action: 'invoice', id: 'c1', request_id: 'r1', state: 'sent', invoice_ref: 'INV-1042' });
  let r = await read(db);
  assert.equal(r.money.invoices[0].state, 'sent');
  assert.equal(r.money.invoices[0].invoice_ref, 'INV-1042');
  assert.equal(r.money.unpaid_minor, 25000);

  await write(db, { action: 'invoice', id: 'c1', request_id: 'r1', state: 'paid', invoice_ref: 'INV-1042' });
  r = await read(db);
  assert.equal(r.money.invoices[0].state, 'paid');
  assert.equal(r.money.unpaid_minor, 0);
  assert.equal(r.money.unpaid_count, 0);
});

test('unpaying leaves it sent, not paid-and-unbilled', async () => {
  const db = freshDb();
  addWork(db, { id: 'r1' });
  await write(db, { action: 'invoice', id: 'c1', request_id: 'r1', state: 'paid' });
  await write(db, { action: 'invoice', id: 'c1', request_id: 'r1', state: 'sent' });
  const row = db.prepare('SELECT invoiced_at, paid_at FROM num_host_requests WHERE id=?').get('r1');
  assert.ok(row.invoiced_at);
  assert.equal(row.paid_at, null);
});

test('work that was never confirmed cannot be marked paid', async () => {
  const db = freshDb();
  addWork(db, { id: 'r1', status: 'new' });
  const res = await write(db, { action: 'invoice', id: 'c1', request_id: 'r1', state: 'paid' });
  assert.equal(res.status, 409);
  assert.equal(db.prepare('SELECT paid_at FROM num_host_requests WHERE id=?').get('r1').paid_at, null);
});

test("you cannot bill against another host's booking", async () => {
  const db = freshDb();
  addWork(db, { id: 'r9', host: 'h2', client: 'c9' });
  const res = await write(db, { action: 'invoice', id: 'c1', request_id: 'r9', state: 'paid' });
  assert.equal(res.status, 404);
});

/* ── their own page ────────────────────────────────────────────────────── */

test('the client link already exists and is handed back, not minted here', async () => {
  const r = await read(freshDb());
  assert.match(r.portal.url, /\/my-host\/\?t=tok_c1$/);
  assert.match(r.portal.calendar, /client-calendar\.ics\?t=tok_c1$/);
  assert.equal(r.portal.trips, true);
});

test('turning trips off says plainly what it does not turn off', async () => {
  const db = freshDb();
  const r = await (await write(db, { action: 'portal', id: 'c1', portal_trips: 0 })).json();
  assert.equal(r.portal_trips, false);
  assert.match(r.says, /who holds their details/);
  assert.equal((await read(db)).portal.trips, false);
});
