// A standing instruction to move somebody's money. Most of these tests exist
// to prove it cannot run away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  mandateText, settingsFor, beginSetup, enable, disable, eligible, attemptAutoPay,
  handleAutopay, HARD_CAP_MINOR, MAX_PER_DAY,
} from './autopay.mjs';

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE num_member_autopay (member_id TEXT PRIMARY KEY, stripe_customer_id TEXT,
      payment_method_id TEXT, cap_minor INTEGER, currency TEXT, state TEXT DEFAULT 'pending',
      mandate_text TEXT, mandate_at TEXT, last_used_at TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT);
    CREATE TABLE num_autopay_attempts (id TEXT PRIMARY KEY, member_id TEXT, token TEXT,
      business_id TEXT, amount_minor INTEGER, currency TEXT, state TEXT, reason TEXT,
      payment_intent_id TEXT, created_at TEXT DEFAULT (datetime('now')));
  `);
  const DB = {
    prepare(sql) {
      const b = [];
      const api = { bind(...a) { b.push(...a); return api; },
        async first() { return d.prepare(sql).get(...b) ?? null; },
        async all() { return { results: d.prepare(sql).all(...b) }; },
        async run() { const r = d.prepare(sql).run(...b); return { meta: { changes: Number(r.changes ?? 0) } }; } };
      return api;
    },
  };
  return { d, env: { DB, STRIPE_SECRET_KEY: 'sk_test' } };
}

const capture = (responder) => {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers, body: String(init.body ?? '') });
    return responder(String(url), calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
};

const BILL = { token: 'BILL1', business_id: 'b1', amount_minor: 4200, currency: 'USD' };
const VENUE = { stripe_account_id: 'acct_venue', stripe_charges_enabled: true, name: 'Bar Nine' };

async function turnOn(env, { cap = 10000, currency = 'USD' } = {}) {
  await env.DB.prepare(`INSERT INTO num_member_autopay (member_id, stripe_customer_id) VALUES ('m1','cus_1')`).bind().run();
  return enable(env, 'm1', { paymentMethodId: 'pm_1', capMinor: cap, currency });
}

test('the mandate says what is authorised, how often, and how the amount is decided', () => {
  const t = mandateText({ capMinor: 10000, currency: 'USD' });
  assert.match(t, /authorise NUM to pay/);
  assert.match(t, /up to USD 100\.00 per bill/);
  assert.match(t, /whatever the venue has put on the bill/, 'how the amount is determined');
  assert.match(t, /still need a tap/);
  assert.match(t, /turn this off/);
});

test('it is off until a member turns it on, and the cap is clamped on the server', async () => {
  const { env } = db();
  assert.equal(await settingsFor(env, 'm1'), null);
  assert.deepEqual(await eligible(env, 'm1', BILL), { ok: false, why: 'off' });

  const on = await turnOn(env, { cap: 999_999_999 });
  assert.equal(on.ok, true);
  assert.equal(on.cap_minor, HARD_CAP_MINOR, 'a cap that only exists in a form field is not a cap');
  assert.match(on.mandate, /authorise NUM/);
  assert.equal((await settingsFor(env, 'm1')).state, 'on');
  assert.equal((await enable(env, 'm1', { paymentMethodId: 'pm', capMinor: 0 })).ok, false);
  assert.equal((await enable(env, 'm1', { capMinor: 500 })).reason, 'no card was saved');
});

test('off is immediate', async () => {
  const { env } = db();
  await turnOn(env);
  await disable(env, 'm1');
  assert.deepEqual(await eligible(env, 'm1', BILL), { ok: false, why: 'off' });
});

test('every refusal is a SPECIFIC refusal, because the app has to say which one', async () => {
  const { d, env } = db();
  await turnOn(env, { cap: 5000, currency: 'USD' });
  assert.equal((await eligible(env, 'm1', BILL)).ok, true);

  const over = await eligible(env, 'm1', { ...BILL, amount_minor: 5001 });
  assert.equal(over.why, 'over_cap');
  assert.equal(over.cap_minor, 5000);

  // A cap in dollars says nothing about a bill in baht, and NUM converting it
  // would make NUM the one deciding an exchange rate.
  assert.equal((await eligible(env, 'm1', { ...BILL, currency: 'THB' })).why, 'other_currency');
  assert.equal((await eligible(env, 'm1', { ...BILL, amount_minor: 0 })).why, 'no_amount');

  for (let i = 0; i < MAX_PER_DAY; i++) {
    d.prepare(`INSERT INTO num_autopay_attempts (id,member_id,state) VALUES ('a${i}','m1','paid')`).run();
  }
  assert.equal((await eligible(env, 'm1', BILL)).why, 'too_many_today',
    'a compromised session must not be able to drain a card');
});

test('paying: the card is CLONED onto the venue account and charged there — never through NUM', async () => {
  const { d, env } = db();
  await turnOn(env);
  const { calls, restore } = capture((url, n) => {
    if (url.endsWith('/payment_methods')) return new Response(JSON.stringify({ id: 'pm_clone' }), { status: 200 });
    return new Response(JSON.stringify({ id: 'pi_1', status: 'succeeded' }), { status: 200 });
  });
  try {
    const out = await attemptAutoPay(env, { memberId: 'm1', bill: BILL, venue: VENUE, feeMinor: 420 });
    assert.equal(out.ok, true);
    assert.equal(out.payment_intent, 'pi_1');
    assert.equal(calls.length, 2);

    const clone = calls[0];
    assert.equal(clone.headers['Stripe-Account'], 'acct_venue', 'the clone lands on the VENUE account');
    assert.match(decodeURIComponent(clone.body), /customer=cus_1/);
    assert.match(decodeURIComponent(clone.body), /payment_method=pm_1/);

    const pi = decodeURIComponent(calls[1].body);
    assert.equal(calls[1].headers['Stripe-Account'], 'acct_venue', 'still a DIRECT charge');
    assert.match(pi, /payment_method=pm_clone/, 'the clone, not the platform card');
    assert.match(pi, /off_session=true/);
    assert.match(pi, /confirm=true/);
    assert.match(pi, /application_fee_amount=420/);
    assert.ok(!/on_behalf_of|transfer_data|destination/.test(pi), 'never a destination charge');
    assert.equal(calls[1].headers['Idempotency-Key'], 'autopay-BILL1', 'a retry pays once');

    const att = d.prepare('SELECT * FROM num_autopay_attempts').get();
    assert.equal(att.state, 'paid');
    assert.equal(att.payment_intent_id, 'pi_1');
    assert.ok(d.prepare('SELECT last_used_at FROM num_member_autopay').get().last_used_at);
  } finally { restore(); }
});

test('an issuer that wants the cardholder hands back to the tap — and NOTHING is retried', async () => {
  const { d, env } = db();
  await turnOn(env);
  const { calls, restore } = capture((url) => {
    if (url.endsWith('/payment_methods')) return new Response(JSON.stringify({ id: 'pm_clone' }), { status: 200 });
    return new Response(JSON.stringify({ error: { message: 'This payment requires authentication (requires_action).' } }), { status: 402 });
  });
  try {
    const out = await attemptAutoPay(env, { memberId: 'm1', bill: BILL, venue: VENUE });
    assert.equal(out.ok, false);
    assert.equal(out.tap, true, 'the app shows the buttons — which is where a guest already was');
    assert.equal(out.why, 'needs_authentication');
    assert.equal(calls.length, 2, 'one clone, one attempt, no retry');
    const att = d.prepare('SELECT state, reason FROM num_autopay_attempts').get();
    assert.equal(att.state, 'failed');
    assert.match(att.reason, /needs_authentication/);
  } finally { restore(); }
});

test('a declined card, an unusable card and an unconnected venue each fall to the tap', async () => {
  const { env } = db();
  await turnOn(env);
  let r = capture(() => new Response(JSON.stringify({ error: { message: 'Your card was declined.' } }), { status: 402 }));
  try {
    const out = await attemptAutoPay(env, { memberId: 'm1', bill: BILL, venue: VENUE });
    assert.equal(out.why, 'card_unavailable', 'the clone itself failed');
    assert.equal(out.tap, true);
  } finally { r.restore(); }

  r = capture((url) => (url.endsWith('/payment_methods')
    ? new Response(JSON.stringify({ id: 'pm_clone' }), { status: 200 })
    : new Response(JSON.stringify({ id: 'pi_x', status: 'requires_action' }), { status: 200 })));
  try {
    const out = await attemptAutoPay(env, { memberId: 'm1', bill: BILL, venue: VENUE });
    assert.equal(out.why, 'needs_authentication');
    assert.equal(out.tap, true);
  } finally { r.restore(); }

  const out = await attemptAutoPay(env, { memberId: 'm1', bill: BILL, venue: { stripe_account_id: null } });
  assert.equal(out.why, 'venue_not_connected');
  assert.equal(out.tap, true);
});

test('auto-pay does not settle the bill — one settle path, whichever rail paid', async () => {
  const { env } = db();
  await turnOn(env);
  const { restore } = capture((url) => (url.endsWith('/payment_methods')
    ? new Response(JSON.stringify({ id: 'pm_clone' }), { status: 200 })
    : new Response(JSON.stringify({ id: 'pi_1', status: 'succeeded' }), { status: 200 })));
  try {
    const out = await attemptAutoPay(env, { memberId: 'm1', bill: BILL, venue: VENUE });
    assert.equal(out.ok, true);
    // The Connect webhook writes the ledger, closes the till and stamps the
    // paylink. If this function did any of that, a bill could settle twice.
    assert.ok(!('settled' in out));
    assert.match(String(await (await import('node:fs')).promises.readFile(new URL('./autopay.mjs', import.meta.url), 'utf8')),
      /NOT settled here/);
  } finally { restore(); }
});

test('setup creates a platform customer and an off_session SetupIntent, so 3DS happens ONCE and at save time', async () => {
  const { d, env } = db();
  const { calls, restore } = capture((url) => (url.endsWith('/customers')
    ? new Response(JSON.stringify({ id: 'cus_new' }), { status: 200 })
    : new Response(JSON.stringify({ id: 'seti_1', client_secret: 'seti_1_secret' }), { status: 200 })));
  try {
    const out = await beginSetup(env, 'm1');
    assert.equal(out.ok, true);
    assert.equal(out.client_secret, 'seti_1_secret');
    assert.ok(!calls[0].headers['Stripe-Account'], 'the card is saved on the PLATFORM, then cloned per charge');
    const si = decodeURIComponent(calls[1].body);
    assert.match(si, /usage=off_session/);
    assert.match(si, /customer=cus_new/);
    assert.equal(d.prepare('SELECT state FROM num_member_autopay').get().state, 'pending', 'saved is not the same as on');
  } finally { restore(); }
});

test('the route refuses an anonymous caller and reports the ceilings it will enforce', async () => {
  const { env } = db();
  assert.equal((await handleAutopay(new Request('https://x/api/autopay'), env, '/')).status, 401);
  const body = await (await handleAutopay(new Request('https://x/api/autopay?me=m1'), env, '/')).json();
  assert.equal(body.on, false);
  assert.equal(body.hard_cap_minor, HARD_CAP_MINOR);
  assert.equal(body.max_per_day, MAX_PER_DAY);
  await turnOn(env, { cap: 3000 });
  const on = await (await handleAutopay(new Request('https://x/api/autopay?me=m1'), env, '/')).json();
  assert.equal(on.on, true);
  assert.equal(on.cap_minor, 3000);
  assert.equal(on.has_card, true);
});
