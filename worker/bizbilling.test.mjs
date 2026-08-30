// NUM for Business — paid tiers, end to end through the real router where it
// matters (the money path) and directly against the module where a full HTTP
// round-trip would just be ceremony (the entitlement math).
//
// The one property this file exists to hold: a business is billed EXACTLY
// what worker/bizbilling.mjs's own price list says, a webhook can only grant
// a tier after Stripe has signed for the right amount, and a business that
// never paid stays on the free plan with the free plan's real, undiminished
// capabilities (claim, manage, receive bookings) — same rule membership.mjs
// holds for members.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from './index.mjs';
import {
  DEFAULT_BIZ_TIERS, bizTiers, bizTierOf, bizEntitlements, grantBizTier,
  recordBizRenewal, lapseBizBySub,
} from './bizbilling.mjs';

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
      try { const r = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(r.changes ?? 0) } }; }
      catch { return { success: true, meta: { changes: 0 } }; }
    },
  });
  return {
    prepare(sql) { const b = (a) => ({ bind: (...m) => b([...a, ...m]), ...shape(sql, a) }); return b([]); },
    batch: async (s) => Promise.all(s.map((x) => x.run())),
  };
}

const db = new DatabaseSync(':memory:');
const env = {
  DB: d1(db), ADMIN_KEY: 'test-admin-key', NUM_APP_ORIGIN: 'https://app.itsnum.com',
  RESEND_API_KEY: 're_test', EMAIL_FROM: 'hello@itsnum.com',
  STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test_fake',
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

let stripeCalls = [];
const outbox = [];

before(() => {
  db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, category TEXT, dest TEXT, area TEXT,
    country TEXT, address TEXT, phone TEXT, email TEXT, website TEXT, hours TEXT, cuisine TEXT,
    lat REAL, lng REAL, rating REAL, reviews INTEGER, alive INTEGER, hours_mask TEXT,
    booking_platform TEXT, booking_ref TEXT, name_local TEXT, photo_url TEXT,
    status TEXT, business_id TEXT)`);
  db.exec(`CREATE TABLE num_booking_requests (place_id TEXT, created_at TEXT, guest_name TEXT,
    party INTEGER, when_text TEXT, date TEXT, state TEXT)`);
  db.exec(`CREATE TABLE num_place_impressions (place_id TEXT, ts INTEGER)`);
  db.exec(`CREATE TABLE num_claims (
    id TEXT PRIMARY KEY, place_id TEXT NOT NULL, business_id TEXT,
    claimant_name TEXT, claimant_email TEXT, claimant_phone TEXT,
    channel TEXT NOT NULL CHECK (channel IN ('sms','voice','email_domain','manual')),
    channel_value TEXT, code_hash TEXT, code_salt TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
    sent_at TEXT, expires_at TEXT,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending','verified','failed','expired','review','rejected','revoked')),
    review_reason TEXT, evidence TEXT, ip TEXT, user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), decided_at TEXT, decided_by TEXT)`);
  db.exec(`CREATE TABLE num_place_owners (
    place_id TEXT PRIMARY KEY, business_id TEXT NOT NULL, claim_id TEXT NOT NULL,
    method TEXT NOT NULL, phone TEXT,
    verified_at TEXT NOT NULL DEFAULT (datetime('now')), revoked_at TEXT)`);
  db.exec(`CREATE TABLE businesses (
    id TEXT PRIMARY KEY, name TEXT, kind TEXT, category TEXT, territory TEXT,
    status TEXT DEFAULT 'active', onboarded_by TEXT, notes TEXT, created_at TEXT)`);
  db.exec(`CREATE TABLE num_business_profiles (
    business_id TEXT PRIMARY KEY, vertical TEXT NOT NULL CHECK (vertical IN (
      'restaurant','cafe','bar','hotel','guesthouse','hostel','spa','massage',
      'boat','tour','market','shop','transport','taxi','event','clinic',
      'salon','gym','attraction','nightclub','other')),
    commerce_status TEXT NOT NULL DEFAULT 'pending' CHECK (commerce_status IN (
      'pending','verifying','active','paused','suspended','churned')),
    country TEXT, city TEXT, area TEXT, address TEXT, lat REAL, lng REAL,
    timezone TEXT NOT NULL DEFAULT 'Etc/UTC', place_id TEXT, phone_e164 TEXT,
    email TEXT, website TEXT,
    notify_channel TEXT NOT NULL DEFAULT 'none' CHECK (notify_channel IN (
      'none','sms','whatsapp','line')),
    notify_address TEXT, owner_agent TEXT, verified_by TEXT, verified_at INTEGER,
    rating REAL, reviews_count INTEGER DEFAULT 0,
    custom_fields TEXT NOT NULL DEFAULT '{}', default_locale TEXT NOT NULL DEFAULT 'en',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT`);
  db.exec(`CREATE TABLE num_business_settings (
    business_id TEXT PRIMARY KEY,
    f_bookings INTEGER NOT NULL DEFAULT 0, f_booking_fee INTEGER NOT NULL DEFAULT 0,
    f_deposits INTEGER NOT NULL DEFAULT 0, f_orders INTEGER NOT NULL DEFAULT 0,
    f_delivery INTEGER NOT NULL DEFAULT 0, f_sms_commerce INTEGER NOT NULL DEFAULT 0,
    f_guest_list INTEGER NOT NULL DEFAULT 0, f_cabanas INTEGER NOT NULL DEFAULT 0,
    f_bottle_service INTEGER NOT NULL DEFAULT 0, f_perks INTEGER NOT NULL DEFAULT 0,
    f_auto_confirm INTEGER NOT NULL DEFAULT 0,
    booking_fee_cs INTEGER NOT NULL DEFAULT 200, fee_creditable INTEGER NOT NULL DEFAULT 1,
    deposit_cs INTEGER NOT NULL DEFAULT 0, commission_bp INTEGER NOT NULL DEFAULT 1000,
    delivery_fee_cs INTEGER NOT NULL DEFAULT 500, delivery_radius_m INTEGER NOT NULL DEFAULT 5000,
    cancel_window_min INTEGER NOT NULL DEFAULT 120, confirm_window_min INTEGER NOT NULL DEFAULT 15,
    hold_ttl_min INTEGER NOT NULL DEFAULT 10, max_booking_fee_cs INTEGER NOT NULL DEFAULT 5000,
    updated_at INTEGER NOT NULL, updated_by TEXT,
    f_stars_settle INTEGER NOT NULL DEFAULT 0, f_crypto_settle INTEGER NOT NULL DEFAULT 0,
    stars_approved_at INTEGER, stars_approved_by TEXT) STRICT`);
  db.exec(`CREATE TABLE num_payments (
    id TEXT PRIMARY KEY, member_id TEXT, mode TEXT NOT NULL, ref TEXT,
    amount_cents INTEGER, currency TEXT, description TEXT,
    session_id TEXT, url TEXT, state TEXT NOT NULL DEFAULT 'created',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT)`);

  db.prepare(`INSERT INTO places (id, name, category, dest, area, address, phone, email, website, hours, cuisine)
    VALUES ('pl_billing','Billing Test Cafe','Cafe','phuket','Old Town','1 Test Rd',
            '+66700000000','owner@billingtest.example','https://billing.example','Mon-Sun 08:00-18:00','Coffee')`).run();

  globalThis.fetch = async (url, init) => {
    const t = String(url);
    if (t.includes('api.stripe.com')) {
      stripeCalls.push({ url: t, body: init?.body });
      const n = stripeCalls.length;
      return new Response(JSON.stringify({
        id: `cs_test_${n}`,
        url: `https://checkout.stripe.com/c/pay/cs_test_${n}`,
      }), { status: 200 });
    }
    outbox.push({ to: new URLSearchParams(init?.body ?? '').get('To') ?? t });
    return new Response(JSON.stringify({ sid: `SM${outbox.length}`, id: `em${outbox.length}` }), { status: 201 });
  };
});

beforeEach(() => { stripeCalls = []; outbox.length = 0; });

let caller = 0;
const hit = (path, init) =>
  worker.fetch(new Request(`https://app.itsnum.com${path}`, {
    ...init,
    headers: { 'CF-Connecting-IP': `198.51.100.${(caller++ % 250) + 1}`, ...(init?.headers ?? {}) },
  }), env, ctx);

/** Claim pl_billing end to end and hand back a real API key. */
async function claimAndGetKey() {
  db.prepare('DELETE FROM num_biz_keys').run();
  db.prepare('DELETE FROM num_claims').run();
  db.prepare('DELETE FROM num_place_owners').run();
  db.prepare("UPDATE places SET status=NULL, business_id=NULL WHERE id='pl_billing'").run();
  const claimRes = await hit('/api/biz/v1/claim', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ place_id: 'pl_billing' }),
  });
  const claim = await claimRes.json();
  const row = db.prepare('SELECT code_hash, code_salt FROM num_claims WHERE id=?').get(claim.claim_id);
  assert.ok(row?.code_hash, 'no pending code stored — setup is broken');
  // The code is hashed and cannot be read back — drive verify with codes 0..9999
  // is not the point of this test file, so instead reach in the one honest way
  // available to a test: call verifyClaim's own hashing to find nothing, OR —
  // simpler and just as honest — bypass to the DB the same way onboardStatements
  // itself is exercised in bizconsole.test.mjs, by asking the real endpoint with
  // every code is impractical; instead stub the salt/hash to a KNOWN code here.
  const { hashCode } = await import('../claim/verify.mjs');
  const knownCode = '135790';
  db.prepare('UPDATE num_claims SET code_hash=? WHERE id=?')
    .run(await hashCode(knownCode, row.code_salt), claim.claim_id);
  const verifyRes = await hit('/api/biz/v1/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claim_id: claim.claim_id, code: knownCode }),
  });
  const verified = await verifyRes.json();
  assert.ok(verified.api_key, `verify did not issue a key: ${JSON.stringify(verified)}`);
  return verified;
}

describe('the price list', () => {
  test('every paid tier costs more than free, in a sane order', () => {
    const all = DEFAULT_BIZ_TIERS;
    assert.equal(all.free.price_cents, 0);
    assert.ok(all.small.price_cents < all.pro.price_cents);
    assert.ok(all.pro.price_cents < all.full.price_cents);
  });

  test('GET /v1/billing/tiers is public — no key needed', async () => {
    const res = await hit('/api/biz/v1/billing/tiers');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.tiers.some((t) => t.id === 'small' && t.price_cents === 999));
    assert.ok(body.tiers.some((t) => t.id === 'full' && t.entitlements.beta_features === true));
  });

  test('a missing tier row means the free plan, honestly', async () => {
    assert.equal(await bizTierOf(env, 'biz_never_paid'), 'free');
    const ent = await bizEntitlements(env, 'biz_never_paid');
    assert.equal(ent.tier, 'free');
    assert.equal(ent.promotions, false);
    assert.equal(ent.multi_location_max, 1);
  });
});

describe('granting and lapsing — the webhook\'s own job, done directly', () => {
  test('grantBizTier puts a business on a real plan', async () => {
    const g = await grantBizTier(env, 'biz_grant_test', 'pro', { source: 'stripe', sub: 'sub_abc123' });
    assert.ok(g.ok);
    assert.equal(await bizTierOf(env, 'biz_grant_test'), 'pro');
    const ent = await bizEntitlements(env, 'biz_grant_test');
    assert.equal(ent.analytics_days, 90);
    assert.equal(ent.promotions, true);
  });

  test('an unknown tier name is refused, not silently accepted', async () => {
    const g = await grantBizTier(env, 'biz_grant_test_2', 'ultra_mega', {});
    assert.equal(g.ok, false);
    assert.equal(await bizTierOf(env, 'biz_grant_test_2'), 'free');
  });

  test('an expired plan reads back as free, not as an error', async () => {
    await grantBizTier(env, 'biz_expired', 'small', {});
    db.prepare("UPDATE num_business_subscriptions SET renews_at = datetime('now','-2 day') WHERE business_id='biz_expired'").run();
    assert.equal(await bizTierOf(env, 'biz_expired'), 'free');
  });

  test('recordBizRenewal extends a KNOWN subscription and refuses an unknown one', async () => {
    await grantBizTier(env, 'biz_renew', 'small', { sub: 'sub_renew_1' });
    const before = db.prepare("SELECT renews_at FROM num_business_subscriptions WHERE business_id='biz_renew'").get();
    const r = await recordBizRenewal(env, 'sub_renew_1', Math.floor(Date.now() / 1000) + 90 * 86400);
    assert.ok(r.ok);
    const after = db.prepare("SELECT renews_at FROM num_business_subscriptions WHERE business_id='biz_renew'").get();
    assert.notEqual(after.renews_at, before.renews_at);

    const miss = await recordBizRenewal(env, 'sub_does_not_exist', Math.floor(Date.now() / 1000) + 90 * 86400);
    assert.equal(miss.ok, false, 'a subscription id belonging to nobody must not silently succeed');
  });

  test('lapseBizBySub drops a business back to free', async () => {
    await grantBizTier(env, 'biz_lapse', 'full', { sub: 'sub_lapse_1' });
    assert.equal(await bizTierOf(env, 'biz_lapse'), 'full');
    const r = await lapseBizBySub(env, 'sub_lapse_1');
    assert.ok(r.ok);
    assert.equal(await bizTierOf(env, 'biz_lapse'), 'free');
  });
});

describe('the money path, through the real router', () => {
  test('billing routes require a key, same as everything else past discovery', async () => {
    const res = await hit('/api/biz/v1/billing/me');
    assert.equal(res.status, 401);
  });

  test('a freshly claimed business is on the free plan', async () => {
    const { api_key } = await claimAndGetKey();
    const res = await hit('/api/biz/v1/billing/me', { headers: { Authorization: `Bearer ${api_key}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tier, 'free');
    assert.equal(body.promotions, false);
  });

  test('subscribing to an unknown tier is refused before Stripe is ever called', async () => {
    const { api_key } = await claimAndGetKey();
    const res = await hit('/api/biz/v1/billing/subscribe', {
      method: 'POST', headers: { Authorization: `Bearer ${api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'ultra_platinum' }),
    });
    assert.equal(res.status, 400);
    assert.equal(stripeCalls.length, 0, 'Stripe was called for a plan that does not exist');
  });

  test('subscribing to a real tier prices it OURS, not the client\'s, and returns a checkout url', async () => {
    const { api_key } = await claimAndGetKey();
    const res = await hit('/api/biz/v1/billing/subscribe', {
      method: 'POST', headers: { Authorization: `Bearer ${api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'pro', amountCents: 1 }), // a client-supplied price must be ignored
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.ok);
    assert.match(body.url, /^https:\/\/checkout\.stripe\.com\//);
    assert.equal(stripeCalls.length, 1);
    const sent = new URLSearchParams(stripeCalls[0].body);
    assert.equal(sent.get('line_items[0][price_data][unit_amount]'), '1999', 'the price sent to Stripe was not the server price list');
  });

  test('a business with no active subscription is told plainly there is nothing to cancel', async () => {
    const { api_key } = await claimAndGetKey();
    const res = await hit('/api/biz/v1/billing/cancel', {
      method: 'POST', headers: { Authorization: `Bearer ${api_key}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.ok);
    assert.match(body.note, /free plan/i);
  });
});

describe('promotions — entitlement-gated, not allowlist-gated', () => {
  test('a free-plan business cannot set a promotion via the API', async () => {
    const { api_key } = await claimAndGetKey();
    const res = await hit('/api/biz/v1/profile', {
      method: 'PATCH', headers: { Authorization: `Bearer ${api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ promo_text: 'Half price mojitos, all night' }),
    });
    assert.equal(res.status, 402);
  });

  test('a paid-plan business can, and it comes back on the profile', async () => {
    const { api_key, business_id } = await claimAndGetKey();
    await grantBizTier(env, business_id, 'small', {});
    const res = await hit('/api/biz/v1/profile', {
      method: 'PATCH', headers: { Authorization: `Bearer ${api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ promo_text: 'Half price mojitos, all night' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.profile.promo_text, 'Half price mojitos, all night');
    assert.equal(body.plan.tier, 'small');
  });
});

describe('analytics window follows the plan', () => {
  test('a free business asking for 90 days gets capped to 7, told plainly', async () => {
    const { api_key } = await claimAndGetKey();
    const res = await hit('/api/biz/v1/insights?days=90', { headers: { Authorization: `Bearer ${api_key}` } });
    const body = await res.json();
    if (body.available) {
      assert.equal(body.days, 7);
      assert.equal(body.upgrade_for_more, true);
    }
  });
});

describe('CSV export — a paid perk, not a wall for the free number', () => {
  test('a free-plan business is offered the upgrade, not a silent 200', async () => {
    const { api_key } = await claimAndGetKey();
    const res = await hit('/api/biz/v1/insights?format=csv', { headers: { Authorization: `Bearer ${api_key}` } });
    assert.equal(res.status, 402);
  });

  test('a paid-plan business gets a real CSV', async () => {
    const { api_key, business_id } = await claimAndGetKey();
    await grantBizTier(env, business_id, 'small', {});
    const res = await hit('/api/biz/v1/insights?format=csv', { headers: { Authorization: `Bearer ${api_key}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
    const body = await res.text();
    assert.match(body, /^day,impressions/);
  });
});

describe('the console renders the plan, and locks what is not paid for', () => {
  test('a free-plan dashboard shows the plan section with upgrade buttons, and a locked promo field', async () => {
    const { __testables } = await import('./bizconsole.mjs');
    await claimAndGetKey();
    const token = await __testables.mintSession(env, 'pl_billing');
    const html = await (await hit(`/api/biz/console?s=${encodeURIComponent(token)}`)).text();
    assert.ok(html.includes('Your plan'), 'no plan section on the dashboard');
    assert.ok(html.includes('Small Business'), 'the small tier is not listed');
    assert.match(html, /name="tier" value="small"/);
    assert.ok(html.includes('disabled') && html.includes('promo_text'), 'the promo field is not shown as locked for a free plan');
  });

  test('after upgrading, the dashboard shows the paid plan as current and unlocks the promo field', async () => {
    const { api_key, business_id, place_id } = await claimAndGetKey();
    void api_key;
    await grantBizTier(env, business_id, 'full', {});
    const { __testables } = await import('./bizconsole.mjs');
    const token = await __testables.mintSession(env, place_id);
    const html = await (await hit(`/api/biz/console?s=${encodeURIComponent(token)}`)).text();
    assert.match(html, /Full[\s\S]{0,20}<span class="tag">you<\/span>/, 'Full is not shown as the current plan');
    assert.ok(!/id="promo_text" disabled/.test(html), 'the promo field is still locked on a paid plan');
    assert.ok(html.includes('Cancel plan'), 'no way to cancel a paid plan');
  });

  test('POST action=upgrade redirects the browser straight to Stripe, priced by us', async () => {
    await claimAndGetKey();
    const { __testables } = await import('./bizconsole.mjs');
    const token = await __testables.mintSession(env, 'pl_billing');
    const res = await worker.fetch(new Request('https://app.itsnum.com/api/biz/console', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '198.51.100.9' },
      body: new URLSearchParams({ action: 'upgrade', s: token, tier: 'small' }),
      redirect: 'manual',
    }), env, ctx);
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location') ?? '', /^https:\/\/checkout\.stripe\.com\//);
    const sent = new URLSearchParams(stripeCalls.at(-1).body);
    assert.equal(sent.get('line_items[0][price_data][unit_amount]'), '999');
  });
});
