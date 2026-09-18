// payrails — the approved-rail registry. These tests are the four tests made
// executable: a rail that fails one cannot be added without failing here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  RAILS, REFUSED, CRYPTO_HELD, railStatus, railsFor, checkoutTypesFor, venueRails, guestFromRequest,
} from './payrails.mjs';

const connected = (country, extra = {}) => ({
  country, stickers: {}, stripe_account_id: 'acct_test', stripe_charges_enabled: true, rails_off: new Set(), ...extra,
});
const ids = (rails) => rails.map((r) => r.id);

test('every rail passes the four tests as data', () => {
  for (const [id, r] of Object.entries(RAILS)) {
    assert.equal(r.instant, true, `${id} must confirm at the table`);
    assert.equal(r.own_device, true, `${id} must authenticate on the guest's own device`);
    assert.equal(r.refundable, true, `${id} must support refunds`);
    assert.equal(r.financing, false, `${id} must not be financing`);
    assert.ok(r.how && r.how.length > 10, `${id} needs a sentence the guest reads`);
  }
});

test('the refused rails are refused on the record, and none of them sneaks into RAILS', () => {
  for (const k of ['klarna', 'affirm', 'afterpay_clearpay', 'zip', 'us_bank_account', 'bacs_debit', 'sepa_debit', 'stars']) {
    assert.ok(REFUSED[k], `${k} must be listed as refused with a reason`);
    assert.equal(RAILS[k], undefined, `${k} must not be a rail`);
  }
  const stripeTypes = Object.values(RAILS).map((r) => r.stripe_type).filter(Boolean);
  for (const k of Object.keys(REFUSED)) assert.ok(!stripeTypes.includes(k), `${k} appears as a Checkout type`);
});

test('country facts from Stripe\'s table: PayPal not in the US, Alipay not in GB, Cash App and USDC-via-Stripe US-only, Pay by Bank GB-only', () => {
  assert.equal(railStatus('paypal', connected('US')).ready, false);
  assert.equal(railStatus('paypal', connected('GB')).ready, true);
  assert.equal(railStatus('alipay', connected('GB')).ready, false);
  assert.equal(railStatus('alipay', connected('US')).ready, true);
  assert.equal(railStatus('wechat_pay', connected('GB')).ready, true);
  assert.equal(railStatus('cashapp', connected('GB')).ready, false);
  assert.equal(railStatus('cashapp', connected('US')).ready, true);
  assert.equal(railStatus('usdc_stripe', connected('GB')).ready, false);
  assert.equal(railStatus('usdc_stripe', connected('US')).ready, true);
  assert.equal(railStatus('pay_by_bank', connected('US')).ready, false);
  assert.equal(railStatus('pay_by_bank', connected('GB')).ready, true);
  assert.equal(railStatus('promptpay_stripe', connected('GB')).ready, false);
  assert.equal(railStatus('promptpay_stripe', connected('TH')).ready, true);
});

test('crypto is HELD in Thailand — a saved USDC address is never shown, and the reason is stated', () => {
  assert.ok(CRYPTO_HELD.has('TH'));
  const th = connected('TH', { stickers: { crypto: true } });
  const st = railStatus('usdc_direct', th);
  assert.equal(st.ready, false);
  assert.equal(st.held, true);
  assert.match(st.reason, /counsel/);
  assert.ok(!ids(railsFor(th, {})).includes('usdc_direct'));
  // The same address at a US venue is a live rail.
  assert.equal(railStatus('usdc_direct', connected('US', { stickers: { crypto: true } })).ready, true);
  // And a UK venue may hold USDC today.
  assert.equal(railStatus('usdc_direct', connected('GB', { stickers: { crypto: true } })).ready, true);
});

test('a Stripe rail needs a connected account that can take charges; a venue rail needs the sticker', () => {
  const none = { country: 'US', stickers: {} };
  assert.equal(railStatus('card', none).ready, false);
  assert.equal(railStatus('card', none).needs, 'stripe_connect');
  assert.equal(railStatus('card', { ...none, stripe_account_id: 'acct', stripe_charges_enabled: false }).ready, false);
  assert.equal(railStatus('promptpay_sticker', { country: 'TH', stickers: {} }).needs, 'sticker:promptpay');
  assert.equal(railStatus('promptpay_sticker', { country: 'TH', stickers: { promptpay: true } }).ready, true);
  assert.equal(railStatus('venue_link', { country: 'MN', stickers: { url: true } }).ready, true);
});

test('a venue can switch a rail off, and off is off on every surface', () => {
  const v = connected('GB', { rails_off: new Set(['paypal']) });
  assert.equal(railStatus('paypal', v).reason, 'switched off by the venue');
  assert.ok(!ids(railsFor(v, {})).includes('paypal'));
  assert.equal(checkoutTypesFor(railsFor(v, {})).includes('paypal'), false);
});

test('UK: Pay by Bank stays first for a UK guest even on an iPhone; a Chinese-speaking guest sees WeChat Pay first', () => {
  const v = connected('GB');
  assert.deepEqual(ids(railsFor(v, { device: 'ios', locale: 'en-GB' })).slice(0, 3), ['pay_by_bank', 'apple_pay', 'card']);
  assert.equal(ids(railsFor(v, { device: 'ios', locale: 'zh-CN' }))[0], 'wechat_pay');
  // Google Pay is not shown on an iPhone, Apple Pay not on Android.
  assert.ok(!ids(railsFor(v, { device: 'ios' })).includes('google_pay'));
  assert.ok(!ids(railsFor(v, { device: 'android' })).includes('apple_pay'));
});

test('Thailand: the free sticker leads for a Thai phone, a card leads for a phone that speaks English', () => {
  const v = connected('TH', { stickers: { promptpay: true } });
  assert.equal(ids(railsFor(v, { device: 'android', locale: 'th-TH' }))[0], 'promptpay_sticker');
  assert.equal(ids(railsFor(v, { device: 'ios', locale: 'en-US' }))[0], 'apple_pay');
  // An unconnected Thai venue: only the sticker and the app door. Nothing invented.
  assert.deepEqual(ids(railsFor({ country: 'TH', stickers: { promptpay: true } }, {})), ['promptpay_sticker', 'num_app']);
});

test('the app door is last and never shown inside the app; a signed-in guest gets rails only', () => {
  const v = connected('US');
  const out = ids(railsFor(v, {}));
  assert.equal(out[out.length - 1], 'num_app');
  assert.ok(!ids(railsFor(v, { signedIn: true })).includes('num_app'));
});

test('checkoutTypesFor hands Stripe only approved types, card first, deduplicated', () => {
  const v = connected('US');
  const types = checkoutTypesFor(railsFor(v, { device: 'ios' }));
  assert.equal(types[0], 'card');
  assert.equal(new Set(types).size, types.length);
  assert.ok(types.includes('cashapp') && types.includes('alipay') && types.includes('crypto'));
  assert.ok(!types.includes('paypal') && !types.includes('pay_by_bank'));
  // A single chosen rail narrows the list to that rail (card covers the wallets).
  assert.deepEqual(checkoutTypesFor(railsFor(v, {}), { only: 'cashapp' }), ['cashapp']);
  assert.deepEqual(checkoutTypesFor(railsFor(v, {}), { only: 'apple_pay' }), ['card']);
  // Venue rails produce no Checkout type at all.
  assert.deepEqual(checkoutTypesFor(railsFor({ country: 'TH', stickers: { promptpay: true } }, {})), []);
});

test('includeUnready gives the console the full picture with a reason per rail', () => {
  const full = railsFor({ country: 'TH', stickers: {} }, {}, { includeUnready: true });
  const card = full.find((r) => r.id === 'card');
  assert.equal(card.ready, false);
  assert.equal(card.needs, 'stripe_connect');
  const usdc = full.find((r) => r.id === 'usdc_direct');
  assert.equal(usdc.held, true);
  const pp = full.find((r) => r.id === 'paypal');
  assert.match(pp.reason, /not offered to venues in TH/);
});

test('venueRails reads the venue honestly, and a missing num_business_rails table means "not connected", not a 503', async () => {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE num_business_profiles (business_id TEXT PRIMARY KEY, country TEXT);
    CREATE TABLE num_paylinks (token TEXT PRIMARY KEY, business_id TEXT, kind TEXT, target TEXT,
      currency TEXT, state TEXT, one_time INTEGER DEFAULT 0);
    INSERT INTO businesses VALUES ('b1','The Longtail');
    INSERT INTO num_business_profiles VALUES ('b1','TH');
    INSERT INTO num_paylinks VALUES ('T1','b1','promptpay','0812345678','THB','active',0);
    INSERT INTO num_paylinks VALUES ('T2','b1','crypto','0xabc','THB','active',0);
    INSERT INTO num_paylinks VALUES ('T3','b1','url','https://x','THB','revoked',0);
    INSERT INTO num_paylinks VALUES ('B1','b1','promptpay','0812345678','THB','active',1);
  `);
  const DB = {
    prepare(sql) {
      const bound = [];
      const api = {
        bind(...a) { bound.push(...a); return api; },
        async first() { return d.prepare(sql).get(...bound) ?? null; }, // throws on a missing table, like D1
        async all() { return { results: d.prepare(sql).all(...bound) }; },
      };
      return api;
    },
  };
  const v = await venueRails({ DB }, 'b1');
  assert.equal(v.country, 'TH');
  assert.equal(v.currency, 'THB');
  assert.deepEqual(v.stickers, { promptpay: true, url: false, crypto: true });
  assert.equal(v.stripe_account_id, null);
  const out = ids(railsFor(v, {}));
  assert.deepEqual(out, ['promptpay_sticker', 'num_app']); // crypto held, url revoked, no Stripe

  // After 0035 and a connection, the card rails light up.
  d.exec(`CREATE TABLE num_business_rails (business_id TEXT PRIMARY KEY, stripe_account_id TEXT,
    stripe_charges_enabled INTEGER, rails_off TEXT);
    INSERT INTO num_business_rails VALUES ('b1','acct_1',1,'["promptpay_stripe"]');`);
  const v2 = await venueRails({ DB }, 'b1');
  assert.equal(v2.stripe_account_id, 'acct_1');
  const out2 = ids(railsFor(v2, {}));
  assert.ok(out2.includes('card'));
  assert.ok(!out2.includes('promptpay_stripe'), 'the venue switched the Stripe PromptPay rail off');
  assert.equal(await venueRails({ DB }, 'nobody'), null);
});

test('guestFromRequest reads device and language and nothing else', () => {
  const h = (m) => ({ headers: { get: (k) => m[k.toLowerCase()] ?? null } });
  assert.deepEqual(guestFromRequest(h({ 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', 'accept-language': 'th-TH,th;q=0.9' })),
    { device: 'ios', locale: 'th-TH', phoneCountry: null, signedIn: false });
  assert.equal(guestFromRequest(h({ 'user-agent': 'Mozilla/5.0 (Linux; Android 14)' })).device, 'android');
  assert.equal(guestFromRequest(h({})).device, null);
});
