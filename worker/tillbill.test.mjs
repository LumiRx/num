// Scan the table's own sticker, see the real bill.
//
// Most of what is pinned here is what this refuses to do, because the failure
// it risks is showing a guest somebody else's dinner and inviting them to pay
// for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { suggestTableNumber, tillTableFor, liveCheckFor, billFromCheck, whyNot } from './tillbill.mjs';
import { saveConnection } from '../growth/pos/index.mjs';

function realDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, status TEXT);
    CREATE TABLE num_business_profiles (business_id TEXT PRIMARY KEY, country TEXT);
    CREATE TABLE num_resources (id TEXT PRIMARY KEY, business_id TEXT, name TEXT, active INTEGER DEFAULT 1, pos_table TEXT);
    CREATE TABLE num_business_pos (business_id TEXT PRIMARY KEY, vendor TEXT, merchant_id TEXT, location_id TEXT,
      token_enc TEXT, refresh_enc TEXT, expires_at TEXT, state TEXT DEFAULT 'active', last_error TEXT,
      connected_at TEXT, updated_at TEXT, webhook_id TEXT);
    CREATE TABLE num_paylinks (token TEXT PRIMARY KEY, business_id TEXT, label TEXT, kind TEXT, target TEXT,
      promptpay_kind TEXT, amount_mode TEXT, amount TEXT, currency TEXT, state TEXT, created_at TEXT,
      booking_id TEXT, settled_at TEXT, one_time INTEGER DEFAULT 0, resource_id TEXT, issued_by TEXT,
      crypto_asset TEXT, crypto_base_units TEXT, crypto_quote TEXT, pos_vendor TEXT, pos_order_id TEXT, pos_closed_at TEXT);
    CREATE TABLE num_bill_items (id TEXT PRIMARY KEY, token TEXT, pos INTEGER, name TEXT,
      qty INTEGER, unit_minor INTEGER, line_minor INTEGER, created_at TEXT);
    INSERT INTO businesses VALUES ('b1','Bar Nine','active');
    INSERT INTO num_business_profiles VALUES ('b1','US');
    INSERT INTO num_resources VALUES ('r7','b1','Table 7',1,'7');
    INSERT INTO num_resources VALUES ('r9','b1','Terrace',1,NULL);
    INSERT INTO num_paylinks (token,business_id,label,kind,target,amount_mode,currency,state,created_at,one_time,resource_id)
      VALUES ('STICK','b1','Table 7','url','https://pay.barnine.com','open','USD','active','2026-09-19',0,'r7');
  `);
  const DB = {
    prepare(sql) {
      const bound = [];
      const api = {
        bind(...a) { bound.push(...a); return api; },
        async first() { return d.prepare(sql).get(...bound) ?? null; },
        async all() { return { results: d.prepare(sql).all(...bound) }; },
        async run() { const r = d.prepare(sql).run(...bound); return { meta: { changes: Number(r.changes ?? 0) } }; },
      };
      return api;
    },
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
  return { d, env: { DB, POS_TOKEN_KEY: 'k', SITE: 'https://itsnum.com' } };
}

const CHECK = {
  uuid: 'chk-1', tableNumber: 7, clientCount: 4, staffName: 'Mia',
  openDate: '2026-09-19T19:04:00Z', currentAmount: 84.5, paidAmount: 0,
  salesEntries: [{ name: 'Pad Thai', quantity: 2, unitAmount: 18 }, { name: 'Singha', quantity: 3, unitAmount: 9.5 }],
};

function till(body, status = 200) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, restore() { globalThis.fetch = real; } };
}

/* ── the suggestion, which is only ever a suggestion ────────────────────── */

test('a clean table name suggests its number, and an ambiguous one suggests nothing', () => {
  assert.equal(suggestTableNumber('Table 7'), '7');
  assert.equal(suggestTableNumber('7'), '7');
  assert.equal(suggestTableNumber('Table 07'), '7');
  // Nothing worth offering a human, so nothing is offered.
  assert.equal(suggestTableNumber('Terrace'), null);
  assert.equal(suggestTableNumber('Table 12A'), null, '12A is not 12 as far as a till is concerned');
  assert.equal(suggestTableNumber('Booth 3 / 4'), null, 'two numbers is not one answer');
  assert.equal(suggestTableNumber(''), null);
  assert.equal(suggestTableNumber(null), null);
});

/* ── nothing is read without a stored mapping ───────────────────────────── */

test('an unmapped table reads no check at all, and does not call the till', async () => {
  // This is the whole guard. Parsing "Terrace" into a number and asking the
  // till for it is how a guest gets somebody else's dinner.
  const { env } = realDb();
  await saveConnection(env, 'b1', { vendor: 'lightspeed', locationId: '77', token: 't' });
  const v = till([CHECK]);
  try {
    const out = await liveCheckFor(env, 'b1', 'r9');
    assert.equal(out.ok, false);
    assert.equal(out.why, 'unmapped');
    assert.equal(v.calls.length, 0, 'the till must not be asked about a table nobody mapped');
  } finally { v.restore(); }
});

test('a venue with no till, or a till that cannot answer per table, is a quiet no', async () => {
  const { env } = realDb();
  assert.equal((await liveCheckFor(env, 'b1', 'r7')).why, 'no_till');
  // Square can list open checks but cannot be asked about one table, so it is
  // refused here rather than matched by amount.
  await saveConnection(env, 'b1', { vendor: 'square', locationId: 'L1', token: 't' });
  assert.equal((await liveCheckFor(env, 'b1', 'r7')).why, 'till_has_no_tables');
  // And a quiet no says nothing to the guest: the venue just does it the
  // usual way.
  assert.equal(whyNot('no_till'), null);
  assert.equal(whyNot('till_has_no_tables'), null);
  assert.equal(whyNot('unmapped'), null);
});

/* ── the happy path ─────────────────────────────────────────────────────── */

test('a mapped table on Lightspeed reads the real check, with its lines', async () => {
  const { env } = realDb();
  await saveConnection(env, 'b1', { vendor: 'lightspeed', locationId: '77', token: 't' });
  const v = till(CHECK);
  try {
    const out = await liveCheckFor(env, 'b1', 'r7');
    assert.equal(out.ok, true);
    assert.equal(out.check.amount_minor, 8450);
    assert.equal(out.check.items.length, 2);
    assert.equal(out.check.guests, 4, 'shown so the guest can tell it is their table');
    assert.equal(out.check.opened_at, '2026-09-19T19:04:00Z');
    assert.match(v.calls[0], /\/order\/table\/7\/getCheck/);
  } finally { v.restore(); }
});

test('the currency comes from the venue profile, never the till', async () => {
  // K-Series has no currency field at all. Inventing one is how a bill in
  // Bangkok becomes dollars.
  const { d, env } = realDb();
  await saveConnection(env, 'b1', { vendor: 'lightspeed', locationId: '77', token: 't' });
  const v = till(CHECK);
  try {
    assert.equal((await liveCheckFor(env, 'b1', 'r7')).check.currency, 'USD');
    d.prepare("UPDATE num_business_profiles SET country='TH' WHERE business_id='b1'").run();
    assert.equal((await liveCheckFor(env, 'b1', 'r7')).check.currency, 'THB');
  } finally { v.restore(); }
});

test('raising the check mints ONE bill, with the till lines on it', async () => {
  const { d, env } = realDb();
  await saveConnection(env, 'b1', { vendor: 'lightspeed', locationId: '77', token: 't' });
  const v = till(CHECK);
  try {
    const out = await billFromCheck(env, 'b1', 'r7');
    assert.equal(out.ok, true, out.reason);
    assert.equal(out.amount, '84.50');
    assert.equal(out.items, 2);

    const row = d.prepare('SELECT amount, currency, pos_vendor, pos_order_id, resource_id FROM num_paylinks WHERE token=?').get(out.token);
    assert.equal(row.amount, '84.50');
    assert.equal(row.currency, 'USD');
    assert.equal(row.pos_vendor, 'lightspeed');
    assert.equal(row.pos_order_id, 'chk-1', 'so settling it closes the right check');
    assert.equal(row.resource_id, 'r7');

    const lines = d.prepare('SELECT name, line_minor FROM num_bill_items WHERE token=? ORDER BY pos').all(out.token);
    assert.deepEqual(lines.map((l) => [l.name, l.line_minor]), [['Pad Thai', 3600], ['Singha', 2850]]);
  } finally { v.restore(); }
});

test('two people tapping at once get the SAME bill, not two payable codes', async () => {
  const { d, env } = realDb();
  await saveConnection(env, 'b1', { vendor: 'lightspeed', locationId: '77', token: 't' });
  const v = till(CHECK);
  try {
    const first = await billFromCheck(env, 'b1', 'r7');
    const second = await billFromCheck(env, 'b1', 'r7');
    assert.equal(second.token, first.token);
    assert.equal(second.already, true);
    assert.equal(d.prepare("SELECT COUNT(*) n FROM num_paylinks WHERE one_time=1").get().n, 1,
      'one dinner, one code — two would be two ways to pay for the same table');
  } finally { v.restore(); }
});

test('once that bill is settled, a fresh check raises a fresh bill', async () => {
  const { d, env } = realDb();
  await saveConnection(env, 'b1', { vendor: 'lightspeed', locationId: '77', token: 't' });
  const v = till(CHECK);
  try {
    const first = await billFromCheck(env, 'b1', 'r7');
    d.prepare("UPDATE num_paylinks SET settled_at='2026-09-19' WHERE token=?").run(first.token);
    const next = await billFromCheck(env, 'b1', 'r7');
    assert.notEqual(next.token, first.token);
  } finally { v.restore(); }
});

/* ── every no is a specific no ──────────────────────────────────────────── */

test('nothing open, and nothing owed, are different answers', async () => {
  const { env } = realDb();
  await saveConnection(env, 'b1', { vendor: 'lightspeed', locationId: '77', token: 't' });

  let v = till(null);
  try {
    assert.equal((await liveCheckFor(env, 'b1', 'r7')).why, 'nothing_open');
  } finally { v.restore(); }

  v = till({ ...CHECK, currentAmount: 40, paidAmount: 40 });
  try {
    assert.equal((await liveCheckFor(env, 'b1', 'r7')).why, 'nothing_owed');
  } finally { v.restore(); }

  assert.match(whyNot('nothing_open', 'Bar Nine'), /nothing open on this table/);
  assert.match(whyNot('nothing_owed'), /nothing left to pay/);
});

test('a till that will not answer says so, and does not mint anything', async () => {
  const { d, env } = realDb();
  await saveConnection(env, 'b1', { vendor: 'lightspeed', locationId: '77', token: 't' });
  const v = till({ message: 'gateway timeout' }, 504);
  try {
    const out = await billFromCheck(env, 'b1', 'r7');
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'till_unreachable');
    assert.equal(d.prepare("SELECT COUNT(*) n FROM num_paylinks WHERE one_time=1").get().n, 0);
    assert.match(whyNot('till_unreachable', 'Bar Nine'), /ask staff for the bill/);
  } finally { v.restore(); }
});

test('the mapping is read from the venue that owns the table', async () => {
  const { env } = realDb();
  assert.equal((await tillTableFor(env, 'b1', 'r7')).table, '7');
  assert.equal(await tillTableFor(env, 'b2', 'r7'), null, 'another venue cannot read this table');
  assert.equal(await tillTableFor(env, 'b1', 'nope'), null);
});
