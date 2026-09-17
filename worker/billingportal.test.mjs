/**
 * The things that keep a subscriber, rather than the ones that win them.
 *
 * A plan is lost twice as often to an expiring card as to a decision, and
 * until now NUM had no page for the thirty seconds that would have saved it:
 * no portal, no invoice, no way to change a card. These tests hold the shape
 * of the fix — and, as much, hold the two promises it must not break: the
 * stored Stripe customer is never overwritten with nothing, and a business
 * that has never been charged is told so plainly instead of being handed an
 * empty page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { billingPortal } from './pay.mjs';
import { grantBizTier, canAddLocation } from './bizbilling.mjs';

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

const fresh = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_business_subscriptions (
    business_id TEXT PRIMARY KEY, tier TEXT NOT NULL DEFAULT 'free',
    since TEXT, renews_at TEXT, source TEXT, ref TEXT, stripe_sub TEXT, stripe_customer TEXT)`);
  db.exec(`CREATE TABLE num_place_owners (place_id TEXT PRIMARY KEY, business_id TEXT, revoked_at TEXT)`);
  return db;
};

test('the portal opens for a customer, and says so plainly when there is not one', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    return new Response(JSON.stringify({ url: 'https://billing.stripe.com/session/abc' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const env = { STRIPE_SECRET_KEY: 'sk_test_x', NUM_APP_ORIGIN: 'https://app.itsnum.com' };
    const out = await billingPortal(env, 'cus_123', 'https://app.itsnum.com/api/biz/console?p=plan');
    assert.equal(out.ok, true);
    assert.equal(out.url, 'https://billing.stripe.com/session/abc');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/billing_portal\/sessions$/);
    assert.match(calls[0].body, /customer=cus_123/);
    // The owner comes back to the page they left, not to a generic app root.
    assert.match(decodeURIComponent(calls[0].body), /return_url=https:\/\/app\.itsnum\.com\/api\/biz\/console\?p=plan/);

    // No customer is a sentence, not a crash and not an empty portal.
    const none = await billingPortal(env, null);
    assert.equal(none.ok, false);
    assert.match(none.error, /No Stripe customer/i);

    // No Stripe key at all is its own answer.
    const off = await billingPortal({}, 'cus_123');
    assert.equal(off.ok, false);
    assert.match(off.error, /not connected/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a Stripe error becomes a sentence a business can read, never a stack', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'No configuration provided' } }),
    { status: 400, headers: { 'content-type': 'application/json' } });
  try {
    const out = await billingPortal({ STRIPE_SECRET_KEY: 'sk_test_x' }, 'cus_123');
    assert.equal(out.ok, false);
    assert.doesNotMatch(out.error, /configuration|stripe\.com|\bat \w+\b/i, 'vendor text must not reach a merchant');
    assert.match(out.error, /try again/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the Stripe customer is stored on a paid grant, and never wiped by a later one', async () => {
  const db = fresh();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const env = { DB: d1(db), STRIPE_SECRET_KEY: 'sk_test_x' };
    await grantBizTier(env, 'biz_1', 'pro', { sub: 'sub_1', customer: 'cus_ABC' });
    assert.equal(db.prepare('SELECT stripe_customer FROM num_business_subscriptions WHERE business_id=?').get('biz_1').stripe_customer, 'cus_ABC');

    // A Stars grant, an admin fix or a renewal carries no customer. Losing the
    // stored one would take the billing page away from someone still paying.
    await grantBizTier(env, 'biz_1', 'full', { source: 'admin', sub: 'sub_1' });
    assert.equal(db.prepare('SELECT stripe_customer FROM num_business_subscriptions WHERE business_id=?').get('biz_1').stripe_customer, 'cus_ABC');
    assert.equal(db.prepare('SELECT tier FROM num_business_subscriptions WHERE business_id=?').get('biz_1').tier, 'full');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('canAddLocation counts real ownership and explains a refusal in the plan\'s own words', async () => {
  const db = fresh();
  const env = { DB: d1(db) };
  db.exec("INSERT INTO num_business_subscriptions (business_id, tier) VALUES ('biz_1','free')");
  db.exec("INSERT INTO num_place_owners (place_id, business_id) VALUES ('p1','biz_1')");
  const free = await canAddLocation(env, 'biz_1');
  assert.equal(free.ok, false);
  assert.equal(free.count, 1);
  assert.equal(free.max, 1);
  assert.match(free.reason, /covers 1 location/);
  // A revoked listing does not count against the limit.
  db.exec("INSERT INTO num_place_owners (place_id, business_id, revoked_at) VALUES ('p2','biz_1',datetime('now'))");
  assert.equal((await canAddLocation(env, 'biz_1')).count, 1);
});

test('the console no longer caps every plan at 30 days', () => {
  const src = readFileSync(new URL('./bizconsole.mjs', import.meta.url), 'utf8');
  // Pro is sold on 90 days and Full on 365. A hard 30 in the renderer made
  // both of those invisible to the person who bought them.
  assert.doesNotMatch(src, /Math\.min\(30,\s*plan/, 'the 30-day clamp must not come back');
});

test('the agent quota refusal no longer quotes a price nothing can sell', () => {
  const src = readFileSync(new URL('../agents/worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ''), /\$9\.99|\$19\.99|\$50/,
    'no code path grants an agent tier, so no agent-facing copy may price one');
});
