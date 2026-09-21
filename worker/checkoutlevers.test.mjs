/**
 * What NUM's checkout sends to Stripe, and what it deliberately does not.
 *
 * Measured on 20 Sep 2026: two live checkout sessions in the product's whole
 * history, both expired unpaid, and nothing was sent after either one. The
 * session body carried no email we already held, no promotion-code field, no
 * trial, and no recovery — four absences at the one screen where money
 * changes hands.
 *
 * These tests hold the four, and hold the two defaults OFF. A promotion field
 * with no live code behind it asks every buyer a question they cannot answer,
 * and a trial is an Automatic Renewal Law decision rather than a flag, so both
 * wait for someone to switch them on deliberately.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { requestSubscription } from './pay.mjs';

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
  db.exec(`CREATE TABLE num_payments (
    id TEXT PRIMARY KEY, member_id TEXT, mode TEXT NOT NULL, ref TEXT,
    amount_cents INTEGER, currency TEXT, description TEXT,
    session_id TEXT, url TEXT, state TEXT NOT NULL DEFAULT 'created',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT,
    owner_kind TEXT, owner_id TEXT)`);
  db.exec('CREATE TABLE num_members (id TEXT PRIMARY KEY, email TEXT)');
  db.exec('CREATE TABLE num_hosts (id TEXT PRIMARY KEY, email TEXT)');
  db.exec(`CREATE TABLE num_business_users (
    id TEXT PRIMARY KEY, business_id TEXT, email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner', status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL DEFAULT 0)`);
  return db;
};

/** Runs one subscription checkout and hands back the body Stripe was sent. */
async function sent(env, args) {
  const realFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/checkout/sessions')) body = new URLSearchParams(init?.body ?? '');
    return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try { await requestSubscription(env, args); } finally { globalThis.fetch = realFetch; }
  assert.ok(body, 'no checkout session was created');
  return body;
}

test('the email we already hold is filled in for them', async () => {
  const db = fresh();
  db.exec("INSERT INTO num_members (id, email) VALUES ('mem_1','ada@example.com')");
  const body = await sent({ DB: d1(db), STRIPE_SECRET_KEY: 'sk_test_x' },
    { memberId: 'mem_1', amountCents: 898, name: 'NUM Plus', ref: 'tier:plus' });
  assert.equal(body.get('customer_email'), 'ada@example.com');
});

test('a host and a business owner get the same courtesy', async () => {
  const db = fresh();
  db.exec("INSERT INTO num_hosts (id, email) VALUES ('host_1','h@example.com')");
  db.exec(`INSERT INTO num_business_users (id, business_id, email, role, status, created_at)
             VALUES ('bu_2','biz_1','manager@example.com','manager','active',1),
                    ('bu_1','biz_1','owner@example.com','owner','active',2)`);
  const env = { DB: d1(db), STRIPE_SECRET_KEY: 'sk_test_x' };

  const host = await sent(env, { hostId: 'host_1', amountCents: 1999, currency: 'GBP', name: 'Pro', ref: 'hosttier:pro' });
  assert.equal(host.get('customer_email'), 'h@example.com');

  // The OWNER, even though the manager was added first: a manager's address on
  // the billing receipt is how a subscription goes invisible to whoever pays.
  const biz = await sent(env, { businessId: 'biz_1', amountCents: 34900, currency: 'THB', name: 'Small', ref: 'biztier:small' });
  assert.equal(biz.get('customer_email'), 'owner@example.com');
});

test('no email on file is not a reason to fail a sale', async () => {
  const db = fresh();
  db.exec("INSERT INTO num_members (id, email) VALUES ('mem_1', NULL)");
  const body = await sent({ DB: d1(db), STRIPE_SECRET_KEY: 'sk_test_x' },
    { memberId: 'mem_1', amountCents: 898, name: 'NUM Plus', ref: 'tier:plus' });
  assert.equal(body.get('customer_email'), null, 'Stripe asks for it instead');
  assert.equal(body.get('after_expiration[recovery][enabled]'), null,
    'recovery without an address to recover to is a setting that does nothing');
  assert.equal(body.get('mode'), 'subscription', 'and the checkout still happens');
});

test('an abandoned checkout is followed up, because both real ones were not', async () => {
  const db = fresh();
  db.exec("INSERT INTO num_members (id, email) VALUES ('mem_1','ada@example.com')");
  const body = await sent({ DB: d1(db), STRIPE_SECRET_KEY: 'sk_test_x' },
    { memberId: 'mem_1', amountCents: 898, name: 'NUM Plus', ref: 'tier:plus' });
  assert.equal(body.get('after_expiration[recovery][enabled]'), 'true');
});

test('the promotion-code field stays off until a real code exists', async () => {
  const db = fresh();
  db.exec("INSERT INTO num_members (id, email) VALUES ('mem_1','ada@example.com')");
  const off = await sent({ DB: d1(db), STRIPE_SECRET_KEY: 'sk_test_x' },
    { memberId: 'mem_1', amountCents: 898, name: 'NUM Plus', ref: 'tier:plus' });
  assert.equal(off.get('allow_promotion_codes'), null,
    'an empty promo box asks a question the buyer cannot answer');

  const on = await sent({ DB: d1(db), STRIPE_SECRET_KEY: 'sk_test_x', NUM_CHECKOUT_PROMO: '1' },
    { memberId: 'mem_1', amountCents: 898, name: 'NUM Plus', ref: 'tier:plus' });
  assert.equal(on.get('allow_promotion_codes'), 'true');
  assert.equal(on.get('after_expiration[recovery][allow_promotion_codes]'), 'true',
    'a recovered checkout can still take the code it was offered');
});

test('a trial is a deliberate act, and a nonsense length is ignored', async () => {
  const db = fresh();
  db.exec("INSERT INTO num_members (id, email) VALUES ('mem_1','ada@example.com')");
  const base = { memberId: 'mem_1', amountCents: 898, name: 'NUM Plus', ref: 'tier:plus' };
  const key = 'subscription_data[trial_period_days]';

  const none = await sent({ DB: d1(db), STRIPE_SECRET_KEY: 'sk_test_x' }, base);
  assert.equal(none.get(key), null);

  const set = await sent({ DB: d1(db), STRIPE_SECRET_KEY: 'sk_test_x', NUM_TRIAL_DAYS: '14' }, base);
  assert.equal(set.get(key), '14');

  for (const bad of ['0', '-3', '400', 'soon', '']) {
    const out = await sent({ DB: d1(db), STRIPE_SECRET_KEY: 'sk_test_x', NUM_TRIAL_DAYS: bad }, base);
    assert.equal(out.get(key), null, `NUM_TRIAL_DAYS=${bad} must not reach Stripe`);
  }
});

test('none of this disturbs what the webhook reads back', async () => {
  const db = fresh();
  db.exec("INSERT INTO num_members (id, email) VALUES ('mem_1','ada@example.com')");
  const body = await sent({ DB: d1(db), STRIPE_SECRET_KEY: 'sk_test_x', NUM_TRIAL_DAYS: '14', NUM_CHECKOUT_PROMO: '1' },
    { memberId: 'mem_1', amountCents: 898, name: 'NUM Plus', ref: 'tier:plus' });
  assert.equal(body.get('metadata[num_member]'), 'mem_1');
  assert.equal(body.get('metadata[num_ref]'), 'tier:plus');
  assert.equal(body.get('subscription_data[metadata][num_member]'), 'mem_1',
    'the grant on invoice.paid reads the SUBSCRIPTION metadata, not the session');
  assert.equal(body.get('subscription_data[metadata][num_ref]'), 'tier:plus');
});

test('a year can be sold, and a typo still bills a month', async () => {
  const db = fresh();
  db.exec("INSERT INTO num_members (id, email) VALUES ('mem_1','ada@example.com')");
  const env = { DB: d1(db), STRIPE_SECRET_KEY: 'sk_test_x' };
  const key = 'line_items[0][price_data][recurring][interval]';

  const monthly = await sent(env, { memberId: 'mem_1', amountCents: 898, name: 'NUM Plus', ref: 'tier:plus' });
  assert.equal(monthly.get(key), 'month', 'the default must not move');

  const yearly = await sent(env, { memberId: 'mem_1', amountCents: 4488, name: 'NUM Plus, a year', ref: 'tier:plus', interval: 'year' });
  assert.equal(yearly.get(key), 'year');
  assert.equal(yearly.get('line_items[0][price_data][unit_amount]'), '4488');

  // A twelvefold billing mistake is the one this guard exists for.
  for (const bad of ['yearly', 'annual', 'week', '', 'YEAR ']) {
    const out = await sent(env, { memberId: 'mem_1', amountCents: 898, name: 'NUM Plus', ref: 'tier:plus', interval: bad });
    assert.equal(out.get(key), 'month', `interval=${JSON.stringify(bad)} must fall back to a month`);
  }
});
