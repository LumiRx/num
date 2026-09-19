// A secret is not an endpoint.
//
// On 18 Sep 2026 STRIPE_CONNECT_WEBHOOK_SECRET was set, the feature registry
// read `billpay: on`, and the Connect webhook endpoint did not exist at Stripe
// at all. Every signal available from inside the Worker said ready. The first
// guest to pay a real bill would have been charged correctly, handed a Stripe
// receipt, and left a table that the restaurant's till still showed as owing.
//
// These tests pin the properties that make checkBillPay able to see that, and
// — just as important — the ones that stop it crying wolf when Stripe is
// merely unreachable. They run the real source against stub fetches, never the
// live internet, so the suite stays deterministic and offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'health.mjs'), 'utf8');

function loadCheckBillPay(fakeFetch) {
  const start = src.indexOf('const CONNECT_HOOK_PATH');
  const end = src.indexOf('async function checkPush(');
  assert.ok(start > 0 && end > start, 'checkBillPay not found in health.mjs');
  const body = src.slice(start, end);
  const factory = new Function('fetch', 'AbortSignal', `${body}; return checkBillPay;`);
  return factory(fakeFetch, { timeout: () => null });
}

// A venue that is connected and can take charges — the only state in which a
// missing endpoint is an emergency rather than a not-yet.
const withVenues = (n) => ({
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_x',
  DB: { prepare: () => ({ first: async () => ({ n }) }) },
});

const listing = (data) => async () => ({
  ok: true, status: 200,
  json: async () => ({ object: 'list', data }),
});

const CONNECT_URL = 'https://app.itsnum.com/api/pay/webhook/connect';
const PLATFORM = { id: 'we_platform', url: 'https://app.itsnum.com/api/pay/webhook', status: 'enabled', enabled_events: ['checkout.session.completed'] };

test('no Connect endpoint at Stripe is a FAILURE once a venue is connected', async () => {
  // The 18 Sep state exactly: one platform endpoint, nothing on connect.
  const check = loadCheckBillPay(listing([PLATFORM]));
  const out = await check(withVenues(1));
  assert.equal(out.ok, false);
  // The remedy must name the consequence a human acts on, not a status colour.
  assert.match(out.remedy, /OPEN IN THE TILL/);
  assert.match(out.remedy, /connected accounts/);
});

test('an endpoint at the right URL with the right event passes', async () => {
  const check = loadCheckBillPay(listing([
    PLATFORM,
    { id: 'we_connect', url: CONNECT_URL, status: 'enabled', application: 'ca_x', enabled_events: ['checkout.session.completed', 'charge.refunded'] },
  ]));
  const out = await check(withVenues(2));
  assert.equal(out.ok, true);
  assert.equal(out.endpoint, 'we_connect');
  assert.equal(out.venues, 2);
});

test('the connected-accounts flag is REPORTED, never asserted', async () => {
  // Stripe does not reliably expose it. Claiming we verified it would be the
  // same lie as the secret standing in for the endpoint.
  const hand = { id: 'we_hand', url: CONNECT_URL, status: 'enabled', enabled_events: ['*'] };
  const out = await loadCheckBillPay(listing([hand]))(withVenues(1));
  assert.equal(out.ok, true);
  assert.equal(out.connected_accounts, 'unconfirmed');

  const viaApp = { ...hand, application: 'ca_x' };
  assert.equal((await loadCheckBillPay(listing([viaApp]))(withVenues(1))).connected_accounts, 'application');

  const viaFlag = { ...hand, connect: true };
  assert.equal((await loadCheckBillPay(listing([viaFlag]))(withVenues(1))).connected_accounts, 'connect');
});

test('an endpoint that exists but is not subscribed to the settling event FAILS', async () => {
  // Subtler than a missing endpoint and identical in effect: nothing settles.
  const check = loadCheckBillPay(listing([
    { id: 'we_connect', url: CONNECT_URL, status: 'enabled', enabled_events: ['charge.refunded'] },
  ]));
  const out = await check(withVenues(1));
  assert.equal(out.ok, false);
  assert.match(out.remedy, /checkout\.session\.completed/);
  assert.equal(out.endpoint, 'we_connect');
});

test('a DISABLED endpoint counts as no endpoint', async () => {
  const check = loadCheckBillPay(listing([
    { id: 'we_connect', url: CONNECT_URL, status: 'disabled', enabled_events: ['checkout.session.completed'] },
  ]));
  assert.equal((await check(withVenues(1))).ok, false);
});

test('a wildcard subscription is accepted', async () => {
  const check = loadCheckBillPay(listing([{ id: 'we_c', url: CONNECT_URL, status: 'enabled', enabled_events: ['*'] }]));
  assert.equal((await check(withVenues(1))).ok, true);
});

test('no connected venue is not a failure — it is a not-yet', async () => {
  // Nagging about an unused feature is how a monitor teaches people to ignore
  // it. Stripe must not even be called in this state.
  let called = false;
  const check = loadCheckBillPay(async () => { called = true; throw new Error('should not be reached'); });
  const out = await check(withVenues(0));
  assert.equal(out.ok, true);
  assert.equal(called, false);
  assert.match(out.note, /no venue has connected/);
});

test('a missing num_business_rails table reads as no venues, not as a crash', async () => {
  const env = {
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_x',
    DB: { prepare: () => ({ first: async () => { throw new Error('no such table: num_business_rails'); } }) },
  };
  const out = await loadCheckBillPay(listing([]))(env);
  assert.equal(out.ok, true);
});

test('Stripe being unreachable is NOT reported as a misconfiguration', async () => {
  // brainstate.mjs, 31 Aug: an ambiguous error once sent a human off to rotate
  // a key that was never broken. The absence of an answer is not an answer.
  const thrown = loadCheckBillPay(async () => { throw new Error('connect ETIMEDOUT'); });
  const a = await thrown(withVenues(1));
  assert.equal(a.ok, true);
  assert.match(a.note, /could not reach Stripe/);

  const fivexx = loadCheckBillPay(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  const b = await fivexx(withVenues(1));
  assert.equal(b.ok, true);
  assert.match(b.note, /503/);
});

test('a connected venue with no signing secret FAILS before Stripe is called', async () => {
  let called = false;
  const check = loadCheckBillPay(async () => { called = true; return { ok: true, status: 200, json: async () => ({ data: [] }) }; });
  const out = await check({
    STRIPE_SECRET_KEY: 'sk_test_x',
    DB: { prepare: () => ({ first: async () => ({ n: 3 }) }) },
  });
  assert.equal(out.ok, false);
  assert.equal(called, false);
  assert.match(out.remedy, /STRIPE_CONNECT_WEBHOOK_SECRET/);
});

test('bill pay unconfigured is silent', async () => {
  const check = loadCheckBillPay(async () => { throw new Error('should not be reached'); });
  const out = await check({ DB: null });
  assert.equal(out.ok, true);
  assert.match(out.note, /not configured/);
});

test('checkBillPay is wired into runHealth', async () => {
  // A check nobody calls is a comment. This is the assertion that would have
  // caught it being written and then left out of the checks object.
  assert.match(src, /bill_pay:\s*await checkBillPay\(env\)/);
});

/* ── the funnel's own precondition ─────────────────────────────────────── */

function loadCheckBillTracking() {
  const start = src.indexOf('async function checkBillTracking(');
  const end = src.indexOf('async function checkPush(');
  assert.ok(start > 0 && end > start, 'checkBillTracking not found in health.mjs');
  const factory = new Function(`${src.slice(start, end)}; return checkBillTracking;`);
  return factory();
}

const envWith = (venues, cols) => ({
  DB: {
    prepare(sql) {
      return {
        bind: () => ({
          async first() {
            return { n: /num_business_rails/.test(sql) ? venues : cols };
          },
        }),
        async first() { return { n: /num_business_rails/.test(sql) ? venues : cols }; },
      };
    },
  },
});

test('a venue taking payments with migration 0047 missing is a FAILURE', async () => {
  // features.mjs evaluates ready synchronously and cannot ask the database
  // whether a column arrived, so paytrack reports `on` from the code alone.
  // That claim is checked here instead.
  const check = loadCheckBillTracking();
  const out = await check(envWith(1, 0));
  assert.equal(out.ok, false);
  assert.match(out.remedy, /0047/);
  assert.match(out.remedy, /can only see the code/);
});

test('all four columns present is ok, and a partial migration is not', async () => {
  const check = loadCheckBillTracking();
  assert.equal((await check(envWith(2, 4))).ok, true);
  assert.equal((await check(envWith(2, 3))).ok, false, 'three of four columns is a half-run migration');
});

test('no venue taking payments is a not-yet, not a failure', async () => {
  const check = loadCheckBillTracking();
  const out = await check(envWith(0, 0));
  assert.equal(out.ok, true);
  assert.match(out.note, /nothing to record/);
});

test('checkBillTracking is wired into runHealth', () => {
  assert.match(src, /bill_tracking:\s*await checkBillTracking\(env\)/);
});
