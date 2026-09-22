import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkoutParams, createCheckout, refundOrder, refundDuplicate, sessionPays, CHECKOUT_TTL_S } from './esimstripe.mjs';
import { stripeForm } from './pay.mjs';

const ORDER = { id: 'eso_1', token: 'tok_abcdefghijklmnopqrstuv', price_cs: 499, dest_label: 'Thailand', plan_label: '10 GB · 30 days', country: 'TH', email: null, phone: '+14155550100', stripe_pi: 'pi_1' };

test('checkout charges exactly the server price, in USD, for this order', () => {
  const p = checkoutParams(ORDER, { origin: 'https://app.itsnum.com', now: 1_000_000_000_000 });
  assert.equal(p.mode, 'payment');
  assert.equal(p.line_items[0].price_data.unit_amount, 499);
  assert.equal(p.line_items[0].price_data.currency, 'usd');
  assert.equal(p.metadata.num_esim, 'eso_1');
  assert.equal(p.metadata.kind, 'esim');
  assert.equal(p.payment_intent_data.metadata.num_esim, 'eso_1');
  assert.equal(p.client_reference_id, 'eso_1');
  assert.equal(p.success_url, 'https://app.itsnum.com/esim/o/tok_abcdefghijklmnopqrstuv?paid=1');
  assert.equal(p.cancel_url, 'https://app.itsnum.com/esim/th');
  assert.equal(p.expires_at, 1_000_000_000 + CHECKOUT_TTL_S);
  assert.equal(p.phone_number_collection.enabled, 'false', 'phone already known');
  assert.match(p.line_items[0].price_data.product_data.description, /Data-only/);
});

test('asks Stripe for the phone when we do not have one', () => {
  assert.equal(checkoutParams({ ...ORDER, phone: null }, { origin: 'x' }).phone_number_collection.enabled, 'true');
});

test('creates the session through the shared Stripe client, with an idempotency key per attempt', async () => {
  const calls = [];
  const stripeCall = async (env, path, body, idem) => { calls.push({ path, body, idem }); return { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }; };
  const r = await createCheckout({ STRIPE_SECRET_KEY: 'sk_x' }, ORDER, { origin: 'https://app.itsnum.com', attempt: 2, stripeCall });
  assert.deepEqual(r, { ok: true, id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
  assert.equal(calls[0].path, '/checkout/sessions');
  assert.equal(calls[0].idem, 'esim_cs_eso_1_2');
});

test('no key, no call', async () => {
  let called = false;
  const r = await createCheckout({}, ORDER, { origin: 'x', stripeCall: async () => { called = true; } });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test('refund is idempotent per order and a Stripe error is reported, not thrown', async () => {
  const seen = [];
  const ok = await refundOrder({ STRIPE_SECRET_KEY: 'sk' }, ORDER, { stripeCall: async (e, p, b, idem) => { seen.push({ p, b, idem }); return { id: 're_1', status: 'succeeded' }; } });
  assert.deepEqual(ok, { ok: true, id: 're_1', status: 'succeeded' });
  assert.equal(seen[0].idem, 'esim_refund_eso_1');
  assert.equal(seen[0].b.payment_intent, 'pi_1');
  const bad = await refundOrder({ STRIPE_SECRET_KEY: 'sk' }, ORDER, { stripeCall: async () => { const e = new Error('No such payment_intent'); e.status = 400; throw e; } });
  assert.deepEqual(bad, { ok: false, status: 400, error: 'No such payment_intent' });
  assert.equal((await refundOrder({ STRIPE_SECRET_KEY: 'sk' }, { ...ORDER, stripe_pi: null })).ok, false);
});

test('a duplicate payment is refunded under its own key', async () => {
  let idem;
  await refundDuplicate({ STRIPE_SECRET_KEY: 'sk' }, 'pi_2', 'eso_1', { stripeCall: async (e, p, b, k) => { idem = k; return { id: 're_2' }; } });
  assert.equal(idem, 'esim_dup_pi_2');
});

test('sessionPays: amount, currency, status and order must all match', () => {
  const s = { metadata: { num_esim: 'eso_1' }, payment_status: 'paid', currency: 'usd', amount_total: 499 };
  assert.deepEqual(sessionPays(s, ORDER), { ok: true });
  assert.equal(sessionPays({ ...s, amount_total: 1 }, ORDER).ok, false);
  assert.equal(sessionPays({ ...s, currency: 'eur' }, ORDER).ok, false);
  assert.equal(sessionPays({ ...s, payment_status: 'unpaid' }, ORDER).ok, false);
  assert.equal(sessionPays({ ...s, metadata: { num_esim: 'eso_2' } }, ORDER).ok, false);
});

test('only instant payment methods: card, which carries Apple Pay and Google Pay', () => {
  const p = checkoutParams(ORDER, { origin: 'https://app.itsnum.com' });
  assert.deepEqual(p.payment_method_types, ['card']);
});

test('the session request Stripe receives names card as the only payment method', async () => {
  const calls = [];
  const stripeCall = async (env, path, body, idem) => { calls.push({ path, body, idem }); return { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }; };
  await createCheckout({ STRIPE_SECRET_KEY: 'sk_x' }, ORDER, { origin: 'https://app.itsnum.com', stripeCall });
  assert.deepEqual(calls[0].body.payment_method_types, ['card']);
  assert.match(stripeForm(calls[0].body), /(^|&)payment_method_types\[0\]=card(&|$)/);
  assert.doesNotMatch(stripeForm(calls[0].body), /payment_method_types\[1\]/);
});
