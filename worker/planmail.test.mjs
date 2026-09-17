/**
 * Two things that only matter when somebody has actually paid.
 *
 * 1. THE RECEIPT. A subscriber used to get nothing at all, and the one
 *    handler holding a customer's address spent it on a console.warn. These
 *    tests hold the shape of what now goes out — and, more importantly, that
 *    the number in the email is the number from worker/planprice.mjs rather
 *    than one this layer invented.
 *
 * 2. THE SWITCH. Granting a new tier used to overwrite `stripe_sub` and leave
 *    the old subscription running at Stripe: two live subscriptions, one row.
 *    The tests below fail if the replaced subscription is not ended, which is
 *    the only way to catch a bug whose symptom is a second charge a month
 *    later.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { composeTemplate } from './email.mjs';
import { priceFor, formatPrice } from './planprice.mjs';
import { sendPlanMail, payerEmail } from './planmail.mjs';
import { grantBizTier } from './bizbilling.mjs';

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      try {
        const st = db.prepare(sql);
        if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: st.all(...args), success: true };
        st.run(...args); return { results: [], success: true };
      } catch { return { results: [], success: true }; }
    },
    first: async () => { try { return db.prepare(sql).get(...args) ?? null; } catch { return null; } },
    run: async () => {
      try { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes ?? 0) } }; }
      catch { return { success: true, meta: { changes: 0 } }; }
    },
  });
  return {
    prepare(sql) { const b = (a) => ({ bind: (...m) => b([...a, ...m]), ...shape(sql, a) }); return b([]); },
    batch: async (s) => Promise.all(s.map((x) => x.run())),
  };
}

test('the receipt states the plan, the price and when it charges again', () => {
  const price = formatPrice(priceFor('biz', 'small', 'THB'), 'THB');
  const m = composeTemplate('plan_receipt', {
    plan: 'NUM for Business — Small Business',
    price,
    renews: '17 October 2026',
    what: '30-day analytics.',
    link: 'https://app.itsnum.com/api/biz/console',
  });
  // The four facts that stop a charge becoming a chargeback.
  assert.match(m.subject, /Small Business/);
  assert.match(m.subject, /฿349/);
  for (const part of [m.html, m.text]) {
    assert.ok(part.includes('฿349'), 'the price must appear in both parts');
    assert.ok(part.includes('17 October 2026'), 'the renewal date must appear in both parts');
    assert.match(part, /cancel/i);
  }
  // A text part always, because a missing one is a spam signal in its own right.
  assert.ok(m.text.trim().length > 60);
  // And the price is the table's, not a re-derivation.
  assert.equal(price, '฿349');
});

test('a failed renewal says nothing has been taken away yet', () => {
  const m = composeTemplate('plan_renewal_failed', { plan: 'NUM for hosts — Pro', price: '£19.99', link: 'https://itsnum.com/host/' });
  assert.match(m.subject, /could not renew/i);
  assert.match(m.text, /declined/i);
  // The reassurance is load-bearing: a message implying the plan is already
  // gone earns a support reply instead of a new card.
  assert.match(m.text, /Nothing has changed yet/i);
  assert.match(m.text, /£19\.99/);
});

test('an ended plan promises no further charge and a listing that stays live', () => {
  const m = composeTemplate('plan_ended', { plan: 'NUM for Business — Pro' });
  assert.match(m.text, /not be charged again/i);
  assert.match(m.text, /free/i);
});

test('the receipt goes to the address that paid, never to a row in our database', () => {
  assert.equal(payerEmail({ customer_details: { email: 'paid@example.com' }, customer_email: 'other@example.com' }), 'paid@example.com');
  assert.equal(payerEmail({ customer_email: 'fallback@example.com' }), 'fallback@example.com');
  assert.equal(payerEmail({}), null);
  assert.equal(payerEmail(null), null);
});

test('sendPlanMail refuses a bad address and never throws into the webhook', async () => {
  const env = { DB: null };
  for (const bad of [null, '', 'not-an-email', 'a@b']) {
    const r = await sendPlanMail(env, 'plan_receipt', { to: bad, ownerKind: 'biz', tier: 'pro', currency: 'USD' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_address');
  }
  // An unknown template is refused rather than sent blank.
  const r = await sendPlanMail(env, 'not_a_template', { to: 'a@example.com', ownerKind: 'biz', tier: 'pro' });
  assert.equal(r.ok, false);
});

test('switching plan ends the subscription it replaces — immediately, and only that one', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_business_subscriptions (
    business_id TEXT PRIMARY KEY, tier TEXT NOT NULL DEFAULT 'free',
    since TEXT, renews_at TEXT, source TEXT, ref TEXT, stripe_sub TEXT)`);
  db.exec("INSERT INTO num_business_subscriptions (business_id, tier, stripe_sub) VALUES ('biz_1','small','sub_OLD')");

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const env = { DB: d1(db), STRIPE_SECRET_KEY: 'sk_test_x' };
    const g = await grantBizTier(env, 'biz_1', 'pro', { sub: 'sub_NEW', ref: 'pay_1' });
    assert.equal(g.ok, true);

    const del = calls.filter((c) => c.method === 'DELETE');
    assert.equal(del.length, 1, 'exactly one subscription should have been ended');
    assert.match(del[0].url, /\/subscriptions\/sub_OLD$/, 'the OLD subscription is the one that ends');
    assert.ok(!del.some((c) => c.url.includes('sub_NEW')), 'the new subscription must survive — they just paid for it');

    // The row now points at the new subscription.
    assert.equal(db.prepare('SELECT stripe_sub FROM num_business_subscriptions WHERE business_id=?').get('biz_1').stripe_sub, 'sub_NEW');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a first-time buyer, and a renewal of the same plan, cancel nothing', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_business_subscriptions (
    business_id TEXT PRIMARY KEY, tier TEXT NOT NULL DEFAULT 'free',
    since TEXT, renews_at TEXT, source TEXT, ref TEXT, stripe_sub TEXT)`);

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const env = { DB: d1(db), STRIPE_SECRET_KEY: 'sk_test_x' };
    // Nobody had a subscription before: nothing to end.
    await grantBizTier(env, 'biz_2', 'pro', { sub: 'sub_A' });
    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0, 'a first purchase must not cancel anything');
    // The same subscription renewing must not cancel itself — the failure
    // that would end every plan on its second month.
    await grantBizTier(env, 'biz_2', 'pro', { sub: 'sub_A' });
    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0, 'a renewal of the same subscription must not cancel it');
  } finally {
    globalThis.fetch = realFetch;
  }
});
