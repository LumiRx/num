// The whole thing, end to end, with nothing mocked but the two vendors.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
//
// Every piece of QR bill pay has its own tests and they all pass. That is not
// the same as the chain working, and the chain is where this system has
// actually broken: the Connect webhook that did not exist, the payer column
// nobody wrote to, the shares that each charged the venue a flat fee. Each of
// those was invisible to a unit test and obvious the moment the pieces were
// run in order.
//
// So this runs the real modules in the real order against a real SQLite
// database — mint, rails, checkout, webhook, ledger, till, funnel — and stubs
// exactly two things: Stripe's HTTP and Square's HTTP. Everything between them
// is the production code path.
//
// It is also the rehearsal for the live test-mode run. Anything that fails
// here would have failed in a restaurant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { _resetSchemaCache } from './commission.mjs';
import { mintBillCode } from './billqr.mjs';
import { billRails, createBillCheckout, handleConnectWebhook } from './billpay.mjs';
import { normaliseItems, saveItems, itemsFor } from './billitems.mjs';
import { splitBill } from './billsplit.mjs';
import { billsFor } from './billhistory.mjs';
import { trailFor, funnelFor } from './paytrack.mjs';
import { saveConnection } from '../growth/pos/index.mjs';

/** Production's schema for everything this path touches, migrations 0035–0047. */
function realDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, status TEXT);
    CREATE TABLE num_business_profiles (business_id TEXT PRIMARY KEY, country TEXT);
    CREATE TABLE num_business_settings (business_id TEXT PRIMARY KEY, commission_bp INTEGER,
      booking_fee_cs INTEGER, delivery_fee_cs INTEGER, walkin_fee_cs INTEGER);
    CREATE TABLE num_business_rails (business_id TEXT PRIMARY KEY, stripe_account_id TEXT,
      stripe_charges_enabled INTEGER DEFAULT 0, rails_off TEXT DEFAULT '[]');
    CREATE TABLE num_paylinks (token TEXT PRIMARY KEY, business_id TEXT, label TEXT, kind TEXT,
      target TEXT, promptpay_kind TEXT, amount_mode TEXT, amount TEXT, currency TEXT,
      state TEXT, created_at TEXT, booking_id TEXT, settled_at TEXT, one_time INTEGER DEFAULT 0,
      resource_id TEXT, issued_by TEXT, settled_by TEXT, crypto_asset TEXT, crypto_base_units TEXT, crypto_quote TEXT,
      checkout_session_id TEXT, payment_intent_id TEXT, charged_via TEXT, application_fee_minor INTEGER,
      pos_vendor TEXT, pos_order_id TEXT, pos_closed_at TEXT, revoked_at TEXT,
      paid_by_member TEXT, split_parent TEXT, split_for_member TEXT, split_at TEXT);
    CREATE TABLE num_bookings (id TEXT PRIMARY KEY, business_id TEXT, status TEXT, value_cs INTEGER DEFAULT 0);
    CREATE TABLE num_resources (id TEXT PRIMARY KEY, business_id TEXT, name TEXT);
    CREATE TABLE num_business_pos (business_id TEXT PRIMARY KEY, vendor TEXT, merchant_id TEXT, location_id TEXT,
      token_enc TEXT, refresh_enc TEXT, expires_at TEXT, state TEXT DEFAULT 'active', last_error TEXT,
      connected_at TEXT, updated_at TEXT);
    CREATE TABLE num_bill_items (id TEXT PRIMARY KEY, token TEXT, pos INTEGER, name TEXT,
      qty INTEGER, unit_minor INTEGER, line_minor INTEGER, created_at TEXT);
    CREATE TABLE num_pay_events (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT, business_id TEXT,
      kind TEXT, billable INTEGER DEFAULT 0, visitor_id TEXT, ip_hash TEXT, day TEXT, created_at TEXT,
      rail TEXT, member_id TEXT, detail TEXT, amount_minor INTEGER);

    INSERT INTO businesses VALUES ('b1','Bar Nine','active');
    INSERT INTO num_business_profiles VALUES ('b1','US');
    INSERT INTO num_business_settings (business_id, commission_bp, walkin_fee_cs) VALUES ('b1', 1000, 200);
    INSERT INTO num_business_rails VALUES ('b1','acct_venue',1,'[]');
    INSERT INTO num_resources VALUES ('r7','b1','Table 7');
    INSERT INTO num_bookings VALUES ('bk1','b1','confirmed',0);
    -- The venue's own sticker. A bill code inherits its target from this and
    -- from nothing a caller sends.
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
  return {
    d,
    env: {
      DB,
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect',
      POS_TOKEN_KEY: 'a-test-key-for-sealing-merchant-tokens',
      SITE: 'https://itsnum.com',
      APP_ORIGIN: 'https://app.itsnum.com',
    },
  };
}

/** Stripe and Square, and a record of everything that was asked of them. */
function vendors({ squareFails = false } = {}) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: init.headers ?? {}, body: init.body ?? null });
    if (u.includes('/v1/checkout/sessions')) {
      return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { status: 200 });
    }
    if (u.includes('/v2/payments')) {
      if (squareFails) return new Response(JSON.stringify({ errors: [{ detail: 'Order already paid' }] }), { status: 409 });
      return new Response(JSON.stringify({ payment: { id: 'sqpay_1' } }), { status: 200 });
    }
    if (u.includes('/pay')) return new Response(JSON.stringify({ order: { state: 'COMPLETED' } }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  };
  return { calls, restore() { globalThis.fetch = real; } };
}

async function sign(secret, payload, t = Math.floor(Date.now() / 1000)) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`));
  return `t=${t},v1=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const paidEvent = (token, rail = 'card') => JSON.stringify({
  type: 'checkout.session.completed',
  account: 'acct_venue',
  data: { object: { payment_status: 'paid', payment_intent: 'pi_1', client_reference_id: token, metadata: { num_bill_token: token, num_rail: rail } } },
});

async function webhook(env, token, rail = 'card') {
  const payload = paidEvent(token, rail);
  return handleConnectWebhook(new Request('https://app.itsnum.com/api/pay/webhook/connect', {
    method: 'POST', body: payload, headers: { 'Stripe-Signature': await sign('whsec_connect', payload) },
  }), env);
}

test('an itemised bill, paid by a member, settles the ledger AND closes the check', async () => {
  const { d, env } = realDb();
  _resetSchemaCache();
  await saveConnection(env, 'b1', { vendor: 'square', merchantId: 'm1', locationId: 'L1', token: 'sq_token' });
  const v = vendors();
  try {
    // 1. Staff build the bill from lines. The total IS the lines.
    const read = normaliseItems([
      { name: 'Pad Thai', qty: 2, price: '18.00' },
      { name: 'Singha', qty: 3, price: '9.50' },
    ]);
    assert.equal(read.total, '64.50');

    const bill = await mintBillCode(env, {
      businessId: 'b1', bookingId: 'bk1', amount: read.total, currency: 'USD',
      resourceId: 'r7', issuedBy: 'staff1', posVendor: 'square', posOrderId: 'ORD_7',
    });
    assert.equal(bill.ok, true, bill.reason);
    await saveItems(env, bill.token, read.items);
    assert.equal((await itemsFor(env, bill.token)).length, 2);

    // 2. The guest opens it. The rails are the ones this venue and this
    //    country allow, and the amount is the one staff sent.
    const view = await billRails(env, bill.token, { device: 'ios' });
    assert.equal(view.bill.state, 'open');
    assert.equal(view.bill.amount, '64.50');
    assert.equal(view.bill.items.length, 2);
    assert.ok(view.rails.some((r) => r.id === 'card' && r.ready));
    assert.equal(view.venue.stripe_account_id, undefined, 'the connected account never reaches a guest');

    // 3. They pay by card, signed in.
    const out = await createBillCheckout(env, bill.token, 'card', { guest: { device: 'ios' }, me: 'mem_dre' });
    assert.equal(out.ok, true, out.reason);
    assert.equal(out.fee.minor, 645, '10% of 64.50, because this bill carries a verified booking');

    const session = v.calls.find((c) => c.url.includes('/checkout/sessions'));
    assert.equal(session.headers['Stripe-Account'], 'acct_venue', 'a DIRECT charge on the venue account');
    const body = decodeURIComponent(session.body);
    assert.match(body, /payment_intent_data\[application_fee_amount\]=645/);
    assert.ok(!/on_behalf_of|transfer_data/.test(body), 'never routed through NUM');

    // 4. Stripe settles it. This is the step that did not exist for a day.
    const res = await webhook(env, bill.token);
    assert.equal(res.status, 200);
    const done = await res.json();
    assert.equal(done.settled, true);

    // ── THE THREE THINGS, CHECKED INDEPENDENTLY ────────────────────────
    const row = d.prepare('SELECT settled_at, paid_by_member, payment_intent_id, pos_closed_at FROM num_paylinks WHERE token=?').get(bill.token);
    assert.ok(row.settled_at, 'the bill is settled');
    assert.equal(row.paid_by_member, 'mem_dre', 'and we know who paid it');
    assert.equal(row.payment_intent_id, 'pi_1');

    const comm = d.prepare("SELECT paid_cs FROM num_commissions WHERE booking_id='bk1'").get();
    assert.equal(comm.paid_cs, 645, 'NUM recorded exactly what it collected at source');

    assert.ok(row.pos_closed_at, 'and the check is CLOSED in the till — the one a guest feels at the door');
    const sq = v.calls.find((c) => c.url.includes('/v2/payments'));
    assert.match(String(sq.body), /"source_id":"EXTERNAL"/);
    assert.match(String(sq.body), /"autocomplete":false/);

    // 5. It is in the member's history, and the funnel saw every step.
    const history = await billsFor(env, 'mem_dre');
    assert.equal(history.length, 1);
    assert.equal(history[0].amount, '64.50');
    assert.equal(history[0].items, 2);

    const trail = (await trailFor(env, bill.token)).map((e) => e.kind);
    assert.deepEqual(trail, ['checkout_opened', 'paid', 'till_closed']);
  } finally {
    v.restore();
  }
});

test('a bill paid twice is settled once, billed once, and closed once', async () => {
  // Stripe retries. A webhook that is not idempotent bills a venue twice for
  // one dinner and tries to close a check that is already closed.
  const { d, env } = realDb();
  _resetSchemaCache();
  await saveConnection(env, 'b1', { vendor: 'square', merchantId: 'm1', locationId: 'L1', token: 'sq_token' });
  const v = vendors();
  try {
    const bill = await mintBillCode(env, { businessId: 'b1', bookingId: 'bk1', amount: '40.00', currency: 'USD', resourceId: 'r7', posVendor: 'square', posOrderId: 'ORD_9' });
    await createBillCheckout(env, bill.token, 'card', { me: 'mem_dre' });
    await webhook(env, bill.token);
    const first = v.calls.filter((c) => c.url.includes('/v2/payments')).length;

    const again = await webhook(env, bill.token);
    assert.equal((await again.json()).already, true);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM num_commissions').get().n, 1);
    assert.equal(d.prepare("SELECT paid_cs FROM num_commissions WHERE booking_id='bk1'").get().paid_cs, 400);
    assert.equal(v.calls.filter((c) => c.url.includes('/v2/payments')).length, first, 'the till is not asked twice');
  } finally {
    v.restore();
  }
});

test('a till that refuses does NOT turn a paid bill into a failed one', async () => {
  // The guest's money moved seconds ago. A webhook that 500s here makes Stripe
  // retry a settled bill; the honest outcome is a paid bill, an open check,
  // and a row saying so where the venue's console can show it.
  const { d, env } = realDb();
  _resetSchemaCache();
  await saveConnection(env, 'b1', { vendor: 'square', merchantId: 'm1', locationId: 'L1', token: 'sq_token' });
  const v = vendors({ squareFails: true });
  try {
    const bill = await mintBillCode(env, { businessId: 'b1', amount: '25.00', currency: 'USD', resourceId: 'r7', posVendor: 'square', posOrderId: 'ORD_X' });
    await createBillCheckout(env, bill.token, 'card', { me: 'mem_dre' });
    const res = await webhook(env, bill.token);
    assert.equal(res.status, 200, 'never a 5xx: Stripe must not retry a settled bill');
    const body = await res.json();
    assert.equal(body.settled, true);
    assert.equal(body.pos_closed, false);

    const row = d.prepare('SELECT settled_at, pos_closed_at FROM num_paylinks WHERE token=?').get(bill.token);
    assert.ok(row.settled_at);
    assert.equal(row.pos_closed_at, null);

    const trail = (await trailFor(env, bill.token)).map((e) => e.kind);
    assert.ok(trail.includes('till_failed'), 'and it is written down, not only logged');
  } finally {
    v.restore();
  }
});

test('a walk-in pays the flat floor, not a percentage', async () => {
  const { d, env } = realDb();
  _resetSchemaCache();
  const v = vendors();
  try {
    const bill = await mintBillCode(env, { businessId: 'b1', amount: '300.00', currency: 'USD', resourceId: 'r7' });
    const out = await createBillCheckout(env, bill.token, 'card', {});
    assert.equal(out.fee.basis, 'flat');
    assert.equal(out.fee.minor, 200, 'a percentage of a walk-in would be an acquisition rate for no acquisition');
    await webhook(env, bill.token);
    const flat = d.prepare("SELECT paid_cs FROM num_commissions WHERE booking_id = ?").get(`bill:${bill.token}`);
    assert.equal(flat?.paid_cs, 200);
  } finally {
    v.restore();
  }
});

test('four friends splitting one dinner is ONE dinner to the ledger and the till', async () => {
  // The failure this pins is the expensive one: four shares each taking the
  // ordinary settlement path would bill the venue four times for one table.
  const { d, env } = realDb();
  _resetSchemaCache();
  await saveConnection(env, 'b1', { vendor: 'square', merchantId: 'm1', locationId: 'L1', token: 'sq_token' });
  const v = vendors();
  try {
    const bill = await mintBillCode(env, { businessId: 'b1', bookingId: 'bk1', amount: '84.00', currency: 'USD', resourceId: 'r7', posVendor: 'square', posOrderId: 'ORD_S' });
    const split = await splitBill(env, bill.token, {
      people: [{ member_id: 'm1', name: 'Dre' }, { member_id: 'm2', name: 'Viv' }, { member_id: 'm3' }, { member_id: 'm4' }],
      by: 'm1',
    });
    assert.equal(split.ok, true, split.reason);
    assert.equal(split.shares.reduce((n, sh) => n + sh.amount_minor, 0), 8400);

    // The table's own code is closed the moment it is split.
    assert.equal((await billRails(env, bill.token, {})).bill.state, 'split');

    for (const sh of split.shares) {
      await createBillCheckout(env, sh.token, 'card', { me: sh.member_id });
      await webhook(env, sh.token);
    }

    const parent = d.prepare('SELECT settled_at, pos_closed_at FROM num_paylinks WHERE token=?').get(bill.token);
    assert.ok(parent.settled_at, 'the dinner is paid once every share has landed');
    assert.ok(parent.pos_closed_at, 'and THEN the check closes — not on the first of four');

    assert.equal(d.prepare('SELECT COUNT(*) n FROM num_commissions').get().n, 1, 'one dinner, one commission line');
    assert.equal(d.prepare("SELECT paid_cs FROM num_commissions WHERE booking_id='bk1'").get().paid_cs, 840,
      '10% of the whole bill — not four fees, and not a fee on each share');

    // Each friend has their own share in their own history.
    for (const sh of split.shares) {
      const mine = await billsFor(env, sh.member_id);
      assert.equal(mine.length, 1);
      assert.equal(mine[0].share_of, bill.token);
    }

    assert.equal(v.calls.filter((c) => c.url.includes('/v2/payments')).length, 1, 'the till is closed once, for the table');
  } finally {
    v.restore();
  }
});

test('the funnel adds up to what actually happened', async () => {
  const { env } = realDb();
  _resetSchemaCache();
  const v = vendors();
  try {
    const a = await mintBillCode(env, { businessId: 'b1', amount: '10.00', currency: 'USD', resourceId: 'r7' });
    const b = await mintBillCode(env, { businessId: 'b1', amount: '20.00', currency: 'USD', resourceId: 'r7' });
    await createBillCheckout(env, a.token, 'card', { me: 'mem_dre' });
    await createBillCheckout(env, b.token, 'card', {});
    await webhook(env, a.token);
    // b opened a payment page and was never paid, which is a real outcome and
    // has to show as one.
    const f = await funnelFor(env, 'b1');
    assert.equal(f.counts.checkout_opened, 2);
    assert.equal(f.counts.paid, 1);
    assert.equal(f.rails.card.opened, 2);
    assert.equal(f.rails.card.paid, 1);
    assert.equal(f.rate, undefined, 'still no invented conversion rate');
  } finally {
    v.restore();
  }
});
