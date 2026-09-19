// billpay — a guest paying a bill code through the venue's own Stripe account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { _resetSchemaCache } from './commission.mjs';
import { billFor, billRails, feeForBill, createBillCheckout, handleConnectWebhook, handleBill } from './billpay.mjs';

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
      pos_vendor TEXT, pos_order_id TEXT, pos_closed_at TEXT);
    CREATE TABLE num_bookings (id TEXT PRIMARY KEY, business_id TEXT, status TEXT, value_cs INTEGER DEFAULT 0);
    CREATE TABLE num_business_pos (business_id TEXT PRIMARY KEY, vendor TEXT, merchant_id TEXT, location_id TEXT,
      token_enc TEXT, refresh_enc TEXT, expires_at TEXT, state TEXT DEFAULT 'active', last_error TEXT,
      connected_at TEXT, updated_at TEXT);
    INSERT INTO businesses VALUES ('b1','Bar Nine','active');
    INSERT INTO num_business_profiles VALUES ('b1','US');
    INSERT INTO num_business_settings (business_id, commission_bp) VALUES ('b1', 1000);
    INSERT INTO num_business_rails VALUES ('b1','acct_venue',1,'[]');
    INSERT INTO num_paylinks (token,business_id,label,kind,target,amount_mode,currency,state,created_at,one_time)
      VALUES ('STICK','b1','Table 4','url','https://pay.barnine.com','open','USD','active','2026-09-17',0);
    INSERT INTO num_paylinks (token,business_id,label,kind,target,amount_mode,amount,currency,state,created_at,one_time,booking_id)
      VALUES ('BILL1','b1','Bill · bk1','url','https://pay.barnine.com','fixed','84.50','USD','active','2026-09-17',1,'bk1');
    INSERT INTO num_paylinks (token,business_id,label,kind,target,amount_mode,amount,currency,state,created_at,one_time)
      VALUES ('WALKIN','b1','Bill','url','https://pay.barnine.com','fixed','30.00','USD','active','2026-09-17',1);
    INSERT INTO num_bookings VALUES ('bk1','b1','confirmed',0);
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
  return { d, env: { DB, STRIPE_SECRET_KEY: 'sk_test_x', SITE: 'https://itsnum.com', APP_ORIGIN: 'https://app.itsnum.com' } };
}

const req = (url, { method = 'GET', headers = {}, body = null } = {}) =>
  new Request(url, { method, headers: { 'user-agent': 'Mozilla/5.0 (iPhone)', 'accept-language': 'en-US', ...headers }, body });

test('billFor reads the amount strictly and knows open / paid / dead', async () => {
  const { d, env } = realDb();
  const b = await billFor(env, 'bill1');
  assert.equal(b.token, 'BILL1');
  assert.equal(b.amount_minor, 8450);
  assert.equal(b.state, 'open');
  assert.equal((await billFor(env, 'STICK')).fixed, false);
  d.prepare("UPDATE num_paylinks SET settled_at='2026-09-17T20:00:00Z' WHERE token='WALKIN'").run();
  assert.equal((await billFor(env, 'WALKIN')).state, 'paid');
  assert.equal(await billFor(env, 'NOPE'), null);
});

test('billRails: one list, every rail carries the URL that starts it', async () => {
  const { env } = realDb();
  const out = await billRails(env, 'BILL1', { device: 'ios', locale: 'en-US' });
  const ids = out.rails.map((r) => r.id);
  assert.equal(ids[0], 'apple_pay');
  assert.ok(ids.includes('card') && ids.includes('cashapp') && ids.includes('venue_link'));
  assert.ok(!ids.includes('google_pay'), 'not on an iPhone');
  assert.ok(!ids.includes('paypal'), 'PayPal is not offered to US venues');
  const card = out.rails.find((r) => r.id === 'card');
  assert.equal(card.action, 'https://app.itsnum.com/api/bill/BILL1/checkout?rail=card');
  assert.equal(out.rails.find((r) => r.id === 'venue_link').action, 'https://itsnum.com/p/BILL1/go');
  assert.equal(out.rails.at(-1).id, 'num_app');
  assert.equal(out.rails.at(-1).action, 'https://app.itsnum.com/pay/BILL1');
});

test('a guest coming back later gets a live payment page, not the dead one', async () => {
  // THE FAILURE THIS PINS. Stripe replays an idempotent request for 24 hours.
  // With one fixed key per bill and rail, the second tap returned the FIRST
  // session — URL and all — so a guest who opened the page, ordered another
  // drink and came back at minute forty met an expired Stripe page on a bill
  // that was still perfectly payable for another fifty.
  const { env } = realDb();
  const keys = [];
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  globalThis.fetch = async (url, init) => {
    keys.push(init.headers['Idempotency-Key']);
    return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }), { status: 200 });
  };
  try {
    const t0 = 1_800_000_000_000;
    Date.now = () => t0;
    await createBillCheckout(env, 'BILL1', 'card', {});
    // A double-tap on a bad connection must NOT mint a second session.
    Date.now = () => t0 + 40_000;
    await createBillCheckout(env, 'BILL1', 'card', {});
    assert.equal(keys[0], keys[1], 'two taps a moment apart are one session');

    // Thirty-one minutes later the old session is dead, so this must be a new
    // one — a fresh page costs nothing, a dead page costs the table.
    Date.now = () => t0 + 31 * 60_000;
    await createBillCheckout(env, 'BILL1', 'card', {});
    assert.notEqual(keys[2], keys[0], 'after the session expires, mint another');
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
});

test('the window is shorter than the session, so a replayed session always has time left on it', async () => {
  // The two constants are the whole guarantee: if the window ever grew past
  // the session's life, a replay could hand back something already expired.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('billpay.mjs', import.meta.url), 'utf8');
  const session = Number(src.match(/const SESSION_MIN = (\d+)/)?.[1]);
  const win = Number(src.match(/const WINDOW_MIN = (\d+)/)?.[1]);
  assert.ok(Number.isFinite(session) && Number.isFinite(win));
  assert.ok(win < session, `the idempotency window (${win}m) must be shorter than the session (${session}m)`);
});

test('feeForBill mirrors the ledger: 10% on a verified booking, the flat floor on a walk-in', async () => {
  const { env } = realDb();
  assert.deepEqual(await feeForBill(env, await billFor(env, 'BILL1')), { minor: 845, basis: 'percentage', rate_bp: 1000 });
  assert.deepEqual(await feeForBill(env, await billFor(env, 'WALKIN')), { minor: 200, basis: 'flat' });
});

test('createBillCheckout: a DIRECT charge on the venue account, approved types only, NUM\'s fee on top', async () => {
  const { d, env } = realDb();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: init.body });
    return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { status: 200 });
  };
  try {
    const res = await createBillCheckout(env, 'BILL1', 'cashapp', { guest: { device: 'ios' } });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers['Stripe-Account'], 'acct_venue', 'the charge must be ON the venue account');
    // The key carries a time window shorter than the session's 30-minute life,
    // so a replayed request can never hand back a session that has expired.
    assert.match(calls[0].headers['Idempotency-Key'], /^bill:BILL1:cashapp:\d+$/);
    const body = decodeURIComponent(calls[0].body);
    assert.match(body, /payment_method_types\[0\]=cashapp/);
    assert.ok(!/payment_method_types\[1\]/.test(body), 'the guest chose one rail');
    assert.match(body, /payment_intent_data\[application_fee_amount\]=845/);
    assert.match(body, /line_items\[0\]\[price_data\]\[unit_amount\]=8450/);
    assert.match(body, /currency\]=usd/);
    assert.ok(!/on_behalf_of|transfer_data/.test(body), 'never a destination charge');
    const row = d.prepare("SELECT checkout_session_id, charged_via, application_fee_minor FROM num_paylinks WHERE token='BILL1'").get();
    assert.deepEqual({ ...row }, { checkout_session_id: 'cs_test_1', charged_via: 'cashapp', application_fee_minor: 845 });

    // Refusals name the reason.
    assert.equal((await createBillCheckout(env, 'STICK', 'card')).status, 422);   // open sticker, no amount
    assert.equal((await createBillCheckout(env, 'BILL1', 'paypal')).status, 422); // not a US rail
    assert.equal((await createBillCheckout(env, 'NOPE', 'card')).status, 404);
    d.prepare("UPDATE num_paylinks SET settled_at='x' WHERE token='BILL1'").run();
    assert.equal((await createBillCheckout(env, 'BILL1', 'card')).status, 409);
  } finally { globalThis.fetch = realFetch; }
});

test('createBillCheckout refuses honestly when the venue has not connected Stripe', async () => {
  const { d, env } = realDb();
  d.prepare("UPDATE num_business_rails SET stripe_account_id=NULL, stripe_charges_enabled=0").run();
  const res = await createBillCheckout(env, 'BILL1', 'card');
  assert.equal(res.ok, false);
  assert.match(res.reason, /not available/);
  const out = await billRails(env, 'BILL1', {});
  assert.deepEqual(out.rails.map((r) => r.id), ['venue_link', 'num_app']);
});

async function sign(secret, payload, t = Math.floor(Date.now() / 1000)) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`));
  return `t=${t},v1=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

test('the Connect webhook settles the bill, records the fee as collected, and is idempotent', async () => {
  const { d, env } = realDb();
  _resetSchemaCache();
  env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect';
  d.prepare("UPDATE num_paylinks SET application_fee_minor=845, charged_via='card' WHERE token='BILL1'").run();
  const payload = JSON.stringify({
    type: 'checkout.session.completed', account: 'acct_venue',
    data: { object: { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1', client_reference_id: 'BILL1', metadata: { num_bill_token: 'BILL1', num_rail: 'card' } } },
  });

  // Unsigned: refused, nothing settles.
  let r = await handleConnectWebhook(req('https://app.itsnum.com/api/pay/webhook/connect', { method: 'POST', body: payload }), env);
  assert.equal(r.status, 400);
  assert.equal(d.prepare("SELECT settled_at FROM num_paylinks WHERE token='BILL1'").get().settled_at, null);

  // Signed with the platform secret only: still refused — Connect events carry their own key.
  r = await handleConnectWebhook(req('https://x', { method: 'POST', body: payload, headers: { 'Stripe-Signature': await sign('whsec_platform', payload) } }), env);
  assert.equal(r.status, 400);

  r = await handleConnectWebhook(req('https://x', { method: 'POST', body: payload, headers: { 'Stripe-Signature': await sign('whsec_connect', payload) } }), env);
  assert.equal(r.status, 200);
  const first = await r.json();
  assert.equal(first.settled, true);
  const row = d.prepare("SELECT settled_at, settled_by, payment_intent_id FROM num_paylinks WHERE token='BILL1'").get();
  assert.ok(row.settled_at);
  assert.equal(row.settled_by, 'stripe:acct_venue');
  assert.equal(row.payment_intent_id, 'pi_1');
  const comm = d.prepare("SELECT booking_id, amount_cs, paid_cs, state FROM num_commissions WHERE booking_id='bk1'").get();
  assert.ok(comm, 'the ledger line exists');
  assert.equal(comm.paid_cs, 845, 'the fee collected at source is recorded as paid');

  // Stripe retries. Nothing doubles.
  r = await handleConnectWebhook(req('https://x', { method: 'POST', body: payload, headers: { 'Stripe-Signature': await sign('whsec_connect', payload) } }), env);
  assert.equal((await r.json()).already, true);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM num_commissions").get().n, 1);
});

test('GET /api/bill/<token> answers the pay page and the app; /checkout redirects a browser back with the reason when it cannot', async () => {
  const { env } = realDb();
  let r = await handleBill(req('https://app.itsnum.com/api/bill/BILL1'), env, '/BILL1');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.bill.token, 'BILL1');
  assert.ok(body.rails.length > 3);
  r = await handleBill(req('https://app.itsnum.com/api/bill/NOPE'), env, '/NOPE');
  assert.equal(r.status, 404);
  r = await handleBill(req('https://app.itsnum.com/api/bill/STICK/checkout?rail=card', { headers: { accept: 'text/html' } }), env, '/STICK/checkout');
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /^https:\/\/itsnum\.com\/p\/STICK\?why=/);
  r = await handleBill(req('https://app.itsnum.com/api/bill/STICK/checkout?rail=card'), env, '/STICK/checkout');
  assert.equal(r.status, 422);
});

test('a paid bill closes the check in the venue\'s own till, once', async () => {
  const { d, env } = realDb();
  _resetSchemaCache();
  env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect';
  env.POS_TOKEN_KEY = 'test-pos-key';
  env.SQUARE_APP_ID = 'sq0idp'; env.SQUARE_APP_SECRET = 'sq0csp';
  const { saveConnection } = await import('../growth/pos/index.mjs');
  await saveConnection(env, 'b1', { vendor: 'square', locationId: 'L1', token: 'tok', refresh: 'ref' });
  d.prepare("UPDATE num_paylinks SET pos_vendor='square', pos_order_id='sq_o1', application_fee_minor=845 WHERE token='BILL1'").run();

  const payload = JSON.stringify({
    type: 'checkout.session.completed', account: 'acct_venue',
    data: { object: { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1', metadata: { num_bill_token: 'BILL1', num_rail: 'card' } } },
  });
  const sq = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sq.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/v2/payments')) return new Response(JSON.stringify({ payment: { id: 'pay_1' } }), { status: 200 });
    return new Response(JSON.stringify({ order: { id: 'sq_o1', state: 'COMPLETED' } }), { status: 200 });
  };
  try {
    const r = await handleConnectWebhook(req('https://x', { method: 'POST', body: payload, headers: { 'Stripe-Signature': await sign('whsec_connect', payload) } }), env);
    const body = await r.json();
    assert.equal(body.settled, true);
    assert.equal(body.pos_closed, true);
    assert.equal(sq.length, 2, 'CreatePayment then PayOrder');
    assert.equal(sq[0].body.source_id, 'EXTERNAL');
    assert.equal(sq[0].body.amount_money.amount, 8450);
    assert.equal(sq[0].body.external_details.source_fee_money.amount, 845, 'the venue sees what it netted');
    assert.ok(d.prepare("SELECT pos_closed_at FROM num_paylinks WHERE token='BILL1'").get().pos_closed_at);

    // Stripe retries. The till is not touched a second time.
    const again = await handleConnectWebhook(req('https://x', { method: 'POST', body: payload, headers: { 'Stripe-Signature': await sign('whsec_connect', payload) } }), env);
    assert.equal((await again.json()).already, true);
    assert.equal(sq.length, 2, 'a retried webhook must not create a second payment on the merchant account');
  } finally { globalThis.fetch = realFetch; }
});

test('a till that will not close the check never turns a paid bill into a failed one', async () => {
  const { d, env } = realDb();
  _resetSchemaCache();
  env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect';
  env.POS_TOKEN_KEY = 'test-pos-key';
  env.SQUARE_APP_ID = 'sq0idp'; env.SQUARE_APP_SECRET = 'sq0csp';
  const { saveConnection } = await import('../growth/pos/index.mjs');
  await saveConnection(env, 'b1', { vendor: 'square', locationId: 'L1', token: 'tok', refresh: 'ref' });
  d.prepare("UPDATE num_paylinks SET pos_vendor='square', pos_order_id='sq_gone' WHERE token='WALKIN'").run();

  const payload = JSON.stringify({
    type: 'checkout.session.completed', account: 'acct_venue',
    data: { object: { id: 'cs_2', payment_status: 'paid', payment_intent: 'pi_2', metadata: { num_bill_token: 'WALKIN' } } },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ errors: [{ detail: 'order not found' }] }), { status: 404 });
  try {
    const r = await handleConnectWebhook(req('https://x', { method: 'POST', body: payload, headers: { 'Stripe-Signature': await sign('whsec_connect', payload) } }), env);
    assert.equal(r.status, 200, 'a 500 here makes Stripe retry a bill that is already settled');
    const body = await r.json();
    assert.equal(body.settled, true, 'the guest paid; the ledger is written whatever the till says');
    assert.equal(body.pos_closed, false);
    assert.equal(d.prepare("SELECT pos_closed_at FROM num_paylinks WHERE token='WALKIN'").get().pos_closed_at, null);
  } finally { globalThis.fetch = realFetch; }
});

test('POST /api/bill/<token>/autopay pays on the venue account, and a refusal is a 200 that says why', async () => {
  const { d, env } = realDb();
  d.exec(`CREATE TABLE num_member_autopay (member_id TEXT PRIMARY KEY, stripe_customer_id TEXT,
    payment_method_id TEXT, cap_minor INTEGER, currency TEXT, state TEXT, mandate_text TEXT,
    mandate_at TEXT, last_used_at TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE num_autopay_attempts (id TEXT PRIMARY KEY, member_id TEXT, token TEXT, business_id TEXT,
      amount_minor INTEGER, currency TEXT, state TEXT, reason TEXT, payment_intent_id TEXT,
      created_at TEXT DEFAULT (datetime('now')));
    INSERT INTO num_member_autopay (member_id,stripe_customer_id,payment_method_id,cap_minor,currency,state)
      VALUES ('m1','cus_1','pm_1',10000,'USD','on');`);

  // Anonymous callers get nothing, and a GET can never move money.
  assert.equal((await handleBill(req('https://app.itsnum.com/api/bill/BILL1/autopay', { method: 'POST' }), env, '/BILL1/autopay')).status, 401);
  assert.equal((await handleBill(req('https://app.itsnum.com/api/bill/BILL1/autopay?me=m1'), env, '/BILL1/autopay')).status, 404,
    'a GET on this path is not a route — drawing a screen must not pay a bill');

  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: String(init.body ?? '') });
    if (String(url).endsWith('/payment_methods')) return new Response(JSON.stringify({ id: 'pm_clone' }), { status: 200 });
    return new Response(JSON.stringify({ id: 'pi_a', status: 'succeeded' }), { status: 200 });
  };
  try {
    const r = await handleBill(req('https://app.itsnum.com/api/bill/BILL1/autopay?me=m1', { method: 'POST' }), env, '/BILL1/autopay');
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
    assert.equal(calls[0].headers['Stripe-Account'], 'acct_venue');
    // The fee mirrors the ledger: 10% of 84.50 on a verified booking.
    assert.match(decodeURIComponent(calls[1].body), /application_fee_amount=845/);
    assert.equal(d.prepare("SELECT charged_via FROM num_paylinks WHERE token='BILL1'").get().charged_via, 'autopay');

    // Over the cap: a 200 that says which no it is.
    const over = await handleBill(req('https://app.itsnum.com/api/bill/WALKIN/autopay?me=m1', { method: 'POST' }), env, '/WALKIN/autopay');
    d.prepare("UPDATE num_member_autopay SET cap_minor=100 WHERE member_id='m1'").run();
    const body = await (await handleBill(req('https://app.itsnum.com/api/bill/WALKIN/autopay?me=m1', { method: 'POST' }), env, '/WALKIN/autopay')).json();
    assert.equal(body.ok, false);
    assert.equal(body.tap, true);
    assert.equal(body.why, 'over_cap');
    assert.equal(over.status, 200);
  } finally { globalThis.fetch = realFetch; }
});
