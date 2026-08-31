import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripeReady, liveMode, applePayReady, authKey, captureKey, PAY,
  amountFor, toStripeAmount, authorize, capture, voidAuth, refund, purchase,
  recordPayment, payBlock,
} from './flightpay.mjs';

const OFFER = {
  origin: 'DXB', dest: 'LHR', depart_date: '2026-09-14',
  currency: 'USD', fare_cs: 44500, tax_cs: 5500, fee_cs: 1500, price: 51500,
};
const BOOKING = {
  offer: OFFER,
  passengers: [{ given_name: 'Alexandra', family_name: 'Johnson' }],
  contact: { email: 'alex@example.com', phone: '+447700900123' },
};
const ENV = { STRIPE_SECRET_KEY: 'sk_test_123' };

/** Capture every Stripe call without making one. */
function stub(responses = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url).replace('https://api.stripe.com/v1', '');
    const body = Object.fromEntries(new URLSearchParams(init?.body ?? ''));
    calls.push({ path, body, idem: init?.headers?.['Idempotency-Key'] ?? null, method: init?.method ?? 'GET' });
    const r = responses[path];
    const payload = typeof r === 'function' ? r(body) : r;
    if (payload?.__fail) return { ok: false, status: payload.status ?? 402, json: async () => ({ error: { message: payload.message } }) };
    return { ok: true, status: 200, json: async () => payload ?? {} };
  };
  return calls;
}
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

/* ─────────────────────────────────────────────────────────────────────────
   THE ORDER IS THE WHOLE DESIGN

   Authorise, issue, capture. Charge-then-issue leaves a traveller $515 down
   holding no ticket, waiting a week for a refund they have to ask for.
   ───────────────────────────────────────────────────────────────────────── */

test('the hold is manual capture — the line this file exists for', async () => {
  const calls = stub({ '/payment_intents': { id: 'pi_1', client_secret: 'pi_1_secret', status: 'requires_payment_method' } });
  const r = await authorize(ENV, BOOKING, { ref: 'NUM123' });
  assert.equal(r.ok, true);
  assert.equal(calls[0].body.capture_method, 'manual',
    'automatic capture takes the money before the ticket exists');
  assert.equal(r.status, 'requires_payment_method');
});

test('capture without an issued ticket is refused, not merely discouraged', async () => {
  const calls = stub({});
  for (const missing of [undefined, null, '', 0]) {
    const r = await capture(ENV, { intentId: 'pi_1', issuedReference: missing });
    assert.equal(r.ok, false, String(missing));
    assert.equal(r.error, 'not_issued');
    assert.match(r.message, /Authorise, issue, then capture/);
  }
  assert.equal(calls.length, 0, 'not one call reached Stripe');
});

test('a failed issue cancels the hold, so no money ever moved', async () => {
  const calls = stub({
    '/payment_intents': { id: 'pi_2', client_secret: 's', status: 'requires_capture' },
    '/payment_intents/pi_2/cancel': { id: 'pi_2', status: 'canceled' },
  });
  const r = await purchase(ENV, BOOKING, {
    ref: 'NUM124',
    issueFn: async () => ({ ok: false, error: 'no_seats', message: 'The fare went while they were typing.' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'issue');
  assert.equal(r.voided, true);
  assert.ok(calls.some((c) => c.path === '/payment_intents/pi_2/cancel'));
  assert.ok(!calls.some((c) => c.path.endsWith('/capture')), 'nothing was captured');
});

test('an issuer that throws also releases the hold', async () => {
  const calls = stub({
    '/payment_intents': { id: 'pi_3', status: 'requires_capture' },
    '/payment_intents/pi_3/cancel': { id: 'pi_3', status: 'canceled' },
  });
  const r = await purchase(ENV, BOOKING, {
    ref: 'NUM125',
    issueFn: async () => { throw new Error('GDS timeout'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.voided, true);
  assert.match(r.message, /GDS timeout/);
  assert.ok(calls.some((c) => c.path === '/payment_intents/pi_3/cancel'));
});

test('the happy path captures exactly once, after the ticket', async () => {
  const calls = stub({
    '/payment_intents': { id: 'pi_4', status: 'requires_capture' },
    '/payment_intents/pi_4/capture': { id: 'pi_4', status: 'succeeded', amount_received: 51500 },
  });
  const r = await purchase(ENV, BOOKING, {
    ref: 'NUM126',
    issueFn: async () => ({ ok: true, reference: 'K7QM2P' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.captured_cs, 51500);
  const order = calls.map((c) => c.path);
  assert.ok(order.indexOf('/payment_intents') < order.indexOf('/payment_intents/pi_4/capture'),
    'the hold must exist before the capture');
  assert.equal(calls.filter((c) => c.path.endsWith('/capture')).length, 1);
});

// The one case where voiding would be catastrophic: the ticket is real and
// the money is not. Giving back the hold gives away a ticket.
test('ticket issued but capture failed never cancels the hold', async () => {
  const calls = stub({
    '/payment_intents': { id: 'pi_5', status: 'requires_capture' },
    '/payment_intents/pi_5/capture': { __fail: true, status: 402, message: 'Your card was declined.' },
  });
  const r = await purchase(ENV, BOOKING, { ref: 'NUM127', issueFn: async () => ({ ok: true, reference: 'K7QM2P' }) });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'capture');
  assert.equal(r.needsHuman, true);
  assert.equal(r.issued.reference, 'K7QM2P', 'the ticket is real and must be reported');
  assert.ok(!calls.some((c) => c.path.endsWith('/cancel')), 'cancelling here gives away a ticket');
});

/* ── DOUBLE CHARGES ──────────────────────────────────────────────────── */

// The retry that matters is the one where the FIRST response was lost. A
// random idempotency key on the retry produces a second hold for one flight.
test('idempotency keys come from the booking, not from randomness', async () => {
  assert.equal(authKey('NUM123'), 'flightauth_NUM123');
  assert.equal(authKey('NUM123'), authKey('NUM123'), 'a retry must reuse the key');
  assert.notEqual(authKey('NUM123'), authKey('NUM124'));
  assert.notEqual(authKey('X'), captureKey('X'), 'authorise and capture are different operations');

  const calls = stub({ '/payment_intents': { id: 'pi_6', status: 'requires_capture' } });
  await authorize(ENV, BOOKING, { ref: 'NUM123' });
  await authorize(ENV, BOOKING, { ref: 'NUM123' });
  assert.equal(calls[0].idem, 'flightauth_NUM123');
  assert.equal(calls[1].idem, calls[0].idem, 'Stripe collapses these into one authorisation');
});

test('no booking reference means no authorisation — money needs something to hang on', async () => {
  const calls = stub({});
  const r = await authorize(ENV, BOOKING, {});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_ref');
  assert.equal(calls.length, 0);
});

test('a zero or negative amount is refused before it reaches Stripe', async () => {
  const calls = stub({});
  for (const offer of [{ ...OFFER, fare_cs: 0, tax_cs: 0, fee_cs: 0 }, { ...OFFER, fare_cs: -100, tax_cs: 0, fee_cs: 0 }]) {
    const r = await authorize(ENV, { ...BOOKING, offer }, { ref: 'X' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'zero_amount');
  }
  assert.equal(calls.length, 0);
});

/* ── THE MONEY ───────────────────────────────────────────────────────── */

test('the total is itemised, and what is ours is separated from what is not', () => {
  const a = amountFor(OFFER);
  assert.equal(a.total_cs, 51500);
  assert.equal(a.fare_cs + a.tax_cs + a.fee_cs, a.total_cs);
  assert.equal(a.ours_cs, 1500, 'only the fee is Num revenue');
  assert.equal(a.passthrough_cs, 50000, 'the fare and taxes are somebody else\'s money passing through');
  assert.equal(a.currency, 'usd');
});

// ¥51500 sent as 51500 charges a hundred times the fare.
test('zero-decimal currencies are not multiplied by a hundred', () => {
  assert.equal(toStripeAmount(51500, 'usd'), 51500, '$515.00');
  assert.equal(toStripeAmount(51500, 'jpy'), 515, '¥515, not ¥51,500');
  assert.equal(toStripeAmount(51500, 'KRW'), 515, 'case does not matter');
  assert.equal(toStripeAmount(51500, 'aed'), 51500, 'AED has decimals');
});

test('the amount sent to Stripe matches the amount shown to the traveller', async () => {
  const calls = stub({ '/payment_intents': { id: 'pi_7', status: 'requires_capture' } });
  await authorize(ENV, BOOKING, { ref: 'NUM128' });
  assert.equal(calls[0].body.amount, '51500');
  assert.equal(calls[0].body.currency, 'usd');
});

test('a capture may be for less than the hold, never more', async () => {
  const calls = stub({ '/payment_intents/pi_8/capture': { id: 'pi_8', status: 'succeeded', amount_received: 50000 } });
  await capture(ENV, { intentId: 'pi_8', issuedReference: 'K7QM2P', amountCs: 50000 });
  assert.equal(calls[0].body.amount_to_capture, '50000');
  // Stripe itself rejects a capture above the authorisation, which is another
  // reason the hold goes on the full amount first.
});

/* ── APPLE PAY ───────────────────────────────────────────────────────────
   An unregistered domain does not error. The button simply never appears, on
   the platform where most travel booking happens, and nobody files a bug —
   they just do not pay. Same shape as the Twilio SID and the Resend key. */

test('Apple Pay readiness is asked of Stripe, never assumed from a variable', async () => {
  stub({});
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ data: [{ domain_name: 'app.itsnum.com', enabled: true }] }),
  });
  const r = await applePayReady(ENV, 'app.itsnum.com');
  assert.equal(r.ok, true);
  assert.deepEqual(r.domains, ['app.itsnum.com']);
});

test('an unregistered domain fails with the exact fix attached', async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ data: [{ domain_name: 'itsnum.com', enabled: true }] }),
  });
  const r = await applePayReady(ENV, 'app.itsnum.com');
  assert.equal(r.ok, false);
  assert.match(r.why, /not a registered Apple Pay domain/);
  assert.match(r.why, /Settings → Payment methods → Apple Pay/);
  assert.match(r.why, /silently does not render/, 'the failure mode has to be in the message');
});

test('a disabled domain does not count as registered', async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ data: [{ domain_name: 'app.itsnum.com', enabled: false }] }),
  });
  assert.equal((await applePayReady(ENV, 'app.itsnum.com')).ok, false);
});

test('Apple Pay and Google Pay are switched on by letting Stripe decide', async () => {
  const calls = stub({ '/payment_intents': { id: 'pi_9', status: 'requires_capture' } });
  await authorize(ENV, BOOKING, { ref: 'NUM129' });
  assert.equal(calls[0].body['automatic_payment_methods[enabled]'], 'true',
    'enumerating card brands ourselves is how the wallet buttons go missing');
});

/* ── THE STATEMENT ───────────────────────────────────────────────────── */

// An unrecognised descriptor is the most common reason a legitimate charge
// gets disputed, and travel already has one of the highest dispute rates.
test('the charge is recognisable on a statement and carries the booking', async () => {
  const calls = stub({ '/payment_intents': { id: 'pi_10', status: 'requires_capture' } });
  await authorize(ENV, BOOKING, { ref: 'NUM130', memberId: 'mem_1' });
  const b = calls[0].body;
  assert.equal(b.statement_descriptor_suffix, 'FLIGHT');
  assert.match(b.description, /Num flight DXB-LHR 2026-09-14/);
  assert.equal(b['metadata[num_booking_ref]'], 'NUM130');
  assert.equal(b['metadata[route]'], 'DXB-LHR');
  assert.equal(b['metadata[num_fee_cs]'], '1500', 'a dispute needs the breakdown, and so does reconciliation');
  assert.equal(b.receipt_email, 'alex@example.com');
});

/* ── FAILURE IS NEVER AN EXCEPTION ───────────────────────────────────── */

test('every operation returns a result rather than throwing', async () => {
  globalThis.fetch = async () => { throw new Error('network gone'); };
  for (const [what, p] of [
    ['authorize', authorize(ENV, BOOKING, { ref: 'X' })],
    ['capture', capture(ENV, { intentId: 'pi', issuedReference: 'K7QM2P' })],
    ['void', voidAuth(ENV, 'pi')],
    ['refund', refund(ENV, { intentId: 'pi' })],
  ]) {
    const r = await p;
    assert.equal(r.ok, false, what);
    assert.ok(r.error, `${what} returned no error code`);
  }
});

test('nothing is attempted when Stripe is not connected', async () => {
  const calls = stub({});
  for (const p of [
    authorize({}, BOOKING, { ref: 'X' }),
    capture({}, { intentId: 'pi', issuedReference: 'K' }),
    voidAuth({}, 'pi'),
    refund({}, { intentId: 'pi' }),
  ]) assert.equal((await p).error, 'stripe_not_configured');
  assert.equal(calls.length, 0);
});

test('live and test keys are distinguishable', () => {
  assert.equal(liveMode({ STRIPE_SECRET_KEY: 'sk_live_x' }), true);
  assert.equal(liveMode(ENV), false);
  assert.equal(stripeReady({}), false);
  assert.equal(stripeReady(ENV), true);
});

/* ── THE LEDGER ──────────────────────────────────────────────────────── */

test('a payment row is keyed on the booking, so a retry updates rather than duplicates', async () => {
  const calls = [];
  const DB = { prepare: (sql) => ({ bind: (...a) => ({ run: async () => calls.push({ sql, a }) }) }) };
  await recordPayment({ DB }, {
    ref: 'NUM131', memberId: 'mem_1', amount: amountFor(OFFER), intentId: 'pi_1', state: PAY.CAPTURED,
  });
  assert.match(calls[0].sql, /ON CONFLICT\(id\) DO UPDATE/);
  assert.equal(calls[0].a[0], 'pay_NUM131');
  assert.equal(calls[0].a[3], 51500);
  assert.ok(calls[0].a[8], 'a captured payment records when it was paid');
});

test('an unpaid state records no paid_at — the column means something', async () => {
  const calls = [];
  const DB = { prepare: (sql) => ({ bind: (...a) => ({ run: async () => calls.push({ sql, a }) }) }) };
  await recordPayment({ DB }, { ref: 'X', amount: amountFor(OFFER), state: PAY.AUTHORIZED });
  assert.equal(calls[0].a[8], null);
});

test('a broken ledger costs a row, never the transaction', async () => {
  const r = await recordPayment({ DB: { prepare() { throw new Error('D1 gone'); } } }, { ref: 'X', amount: amountFor(OFFER), state: PAY.CAPTURED });
  assert.equal(r.ok, false);
});

/* ── WHAT THE CONCIERGE SAYS ─────────────────────────────────────────── */

test('the total is read back itemised, and the fee is named as ours', () => {
  const s = payBlock(BOOKING, ENV);
  assert.match(s, /fare \$445\.00/);
  assert.match(s, /taxes \$55\.00/);
  assert.match(s, /Num booking fee \$15\.00/);
  assert.match(s, /TOTAL \$515\.00/);
  assert.match(s, /it is how Num gets paid/);
  assert.match(s, /Never fold it into the fare/);
});

test('the block explains the hold, because it is reassuring and true', () => {
  const s = payBlock(BOOKING, ENV);
  assert.match(s, /holds the amount first and only takes it once/);
  assert.match(s, /the hold is released and nothing is taken/);
  assert.match(s, /Apple Pay, Google Pay or a card/);
});

test('nothing is called paid before the confirmation comes back', () => {
  assert.match(payBlock(BOOKING, ENV), /Never say paid, charged or booked until the confirmation comes back/);
});

test('a booking with no fee does not announce a fee of zero', () => {
  const s = payBlock({ ...BOOKING, offer: { ...OFFER, fee_cs: 0 } }, ENV);
  assert.ok(!/booking fee/.test(s));
  assert.match(s, /TOTAL \$500\.00/);
});

/* ─────────────────────────────────────────────────────────────────────────
   THE COMPLIANCE CLAIM CANNOT OUTLIVE ITS TRUTH

   /api/pay/status published, as a frozen literal:
     "never — the traveller pays the travel partner directly (B&P §17550.20(g)(5))"

   That is the California seller-of-travel exemption for somebody who does not
   handle the money, and it was the basis on which Num had not registered. The
   moment Num charges a card for a ticket it stops being true, and a false
   compliance claim published by our own API is invent_fact aimed at ourselves.
   ───────────────────────────────────────────────────────────────────────── */
import { travelSettlement, starPolicy, STAR_POLICY } from './pay.mjs';

test('with no issuer, Num still claims the exemption — because it still holds', () => {
  const t = travelSettlement({});
  assert.equal(t.mode, 'direct_to_partner');
  assert.match(t.seller_of_travel, /Exempt under B&P §17550\.20\(g\)\(5\)/);
  assert.equal(t.chargebacks, 'land on the partner');
});

test('the moment Num can issue, the exemption claim is withdrawn automatically', () => {
  const real = { FLIGHT_ISSUER: 'duffel', DUFFEL_ACCESS_TOKEN: 't', DUFFEL_ISSUING_APPROVED: 'true' };
  const t = travelSettlement(real);
  assert.equal(t.mode, 'num_is_merchant_of_record');
  assert.match(t.seller_of_travel, /does not apply/);
  assert.match(t.seller_of_travel, /California Attorney General/);
  assert.equal(t.chargebacks, 'land on Num');
  assert.ok(!/Exempt under/.test(t.seller_of_travel), 'both claims must never be published at once');
});

test('the simulator does not change what Num publishes about itself', () => {
  assert.equal(travelSettlement({ FLIGHT_ISSUER: 'simulated' }).mode, 'direct_to_partner',
    'a demo must not make Num announce it is the merchant of record');
});

// Stars never buying travel is a separate guardrail about what a purchased
// credit may be spent on. It holds whichever way settlement resolves.
test('Stars still never buy travel, either way', () => {
  for (const env of [{}, { FLIGHT_ISSUER: 'duffel', DUFFEL_ACCESS_TOKEN: 't', DUFFEL_ISSUING_APPROVED: 'true' }]) {
    const p = starPolicy(env);
    assert.deepEqual(p.never_spends_on, STAR_POLICY.never_spends_on);
    assert.ok(p.never_spends_on.includes('any travel'));
    assert.equal(p.purchased_cashable, false);
  }
});

test('the published policy no longer carries a frozen sentence that can go stale', () => {
  assert.equal(STAR_POLICY.travel_settlement, undefined,
    'a hardcoded compliance claim is one nobody updates when the facts move');
  assert.equal(typeof starPolicy({}).travel_settlement, 'object');
});
