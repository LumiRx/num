// App Review, 21 Sep 2026, 1.0 (12) — four findings, pinned here so none of
// them can come back quietly. See worker/storefront.mjs for the reasoning.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isIosApp, isDigitalSaleRef, IOS_NO_SALE } from './storefront.mjs';
import { handlePay } from './pay.mjs';
import { handleMembership } from './membership.mjs';
import { handleGiveaways } from './giveaways.mjs';
import { nearestDest } from './discover.mjs';

const req = (origin, { method = 'GET', body, headers = {} } = {}) =>
  new Request('https://app.itsnum.com/api/x', {
    method,
    headers: { ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe('who is the iOS app', () => {
  test('the bundled iOS origin is', () => assert.equal(isIosApp(req('capacitor://localhost')), true));
  test('an explicit header is', () => assert.equal(isIosApp(req(null, { headers: { 'X-Num-Platform': 'ios' } })), true));
  test('the web is not', () => assert.equal(isIosApp(req('https://app.itsnum.com')), false));
  test('Android is not — Play allows the link-out', () => assert.equal(isIosApp(req('https://localhost')), false));
  test('no origin at all is not', () => assert.equal(isIosApp(req(null)), false));
  test('a broken request never throws', () => assert.equal(isIosApp(null), false));
});

describe('3.1.1 — Stars and plans cannot be bought from iOS', () => {
  test('a Stars pack and a plan are digital sales; a bill is not', () => {
    assert.equal(isDigitalSaleRef('stars:1000'), true);
    assert.equal(isDigitalSaleRef('tier:pro'), true);
    assert.equal(isDigitalSaleRef('bill:LD-2841'), false);
    assert.equal(isDigitalSaleRef(undefined), false);
  });

  test('the pay rail refuses a Stars pack from iOS before anything else runs', async () => {
    const env = { STARS_SALE_OK: '1', STRIPE_SECRET_KEY: 'sk_test_x' };
    const r = await handlePay(req('capacitor://localhost', { method: 'POST', body: { ref: 'stars:1000', amount_cents: 1000, me: 'm1' } }), env, '/request');
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, IOS_NO_SALE.error);
  });

  test('the pay rail refuses a plan from iOS', async () => {
    const r = await handlePay(req('capacitor://localhost', { method: 'POST', body: { ref: 'tier:pro', amount_cents: 999 } }), { STARS_SALE_OK: '1' }, '/request');
    assert.equal(r.status, 403);
  });

  test('the status the iOS app reads carries no packs and no sale', async () => {
    const r = await handlePay(req('capacitor://localhost'), { STARS_SALE_OK: '1', STRIPE_SECRET_KEY: 'sk_test_x' }, '/status');
    const j = await r.json();
    assert.equal(j.stars_sale, false);
    assert.deepEqual(j.packs, []);
  });

  test('the web still sees its packs', async () => {
    const r = await handlePay(req('https://app.itsnum.com'), { STARS_SALE_OK: '1', STRIPE_SECRET_KEY: 'sk_test_x' }, '/status');
    const j = await r.json();
    assert.equal(j.stars_sale, true);
    assert.ok(j.packs.length > 0);
  });

  for (const path of ['/subscribe', '/upgrade-with-stars']) {
    test(`membership ${path} is refused from iOS`, async () => {
      const r = await handleMembership(req('capacitor://localhost', { method: 'POST', body: { me: 'm1', tier: 'plus' } }), {}, path);
      assert.equal(r.status, 403);
      assert.equal((await r.json()).error, IOS_NO_SALE.error);
    });
  }
});

describe('3.1.1 — no code enters or unlocks anything from iOS', () => {
  const env = { DB: {} };
  test('the iOS app is listed no giveaways', async () => {
    const r = await handleGiveaways(req('capacitor://localhost'), env, '/', new URL('https://app.itsnum.com/api/giveaways'));
    assert.deepEqual((await r.json()).giveaways, []);
  });
  test('and cannot enter one', async () => {
    const r = await handleGiveaways(req('capacitor://localhost', { method: 'POST', body: { me: 'm1', id: 'friday-packs' } }), env, '/enter', new URL('https://app.itsnum.com/api/giveaways/enter'));
    assert.equal(r.status, 403);
  });
  test('the PACKS code is not intercepted for the iOS app', () => {
    const src = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
    assert.match(src, /if \(isEntry\(lastUser\) && !isIosApp\(request\)\)/);
  });
});

describe('2.1(a) — Surprise me always has somewhere to deal from', () => {
  const db = (rows) => ({ prepare: () => ({ all: async () => ({ results: rows }) }) });
  const LA = { slug: 'los-angeles', name: 'Los Angeles', country: 'US', lat: 34.052, lng: -118.244 };
  const CUPERTINO = [37.3349, -122.009];

  test('within 150 km is still the default rule', async () => {
    assert.equal(await nearestDest({ DB: db([LA]) }, ...CUPERTINO), null);
  });
  test('but App Review’s own desk finds the nearest city NUM covers', async () => {
    const far = await nearestDest({ DB: db([LA]) }, ...CUPERTINO, { maxKm: Infinity });
    assert.equal(far?.slug, 'los-angeles');
    assert.ok(far.km > 400 && far.km < 600);
  });
  test('the route falls back instead of refusing, and says so', () => {
    const src = readFileSync(new URL('./discover.mjs', import.meta.url), 'utf8');
    assert.match(src, /maxKm: Infinity/);
    assert.match(src, /the nearest city it does/);
  });
  test('a tap with nowhere to deal from opens the place sheet', () => {
    const src = readFileSync(new URL('../src/components/app/DiscoverSheet.tsx', import.meta.url), 'utf8');
    assert.match(src, /if \(tapped && !s\.place && !s\.here\) \{ store\.set\(\{ discoverOpen: null, placeOpen: true \}\)/);
    assert.match(src, /void deal\(null, true\)/);
  });
});

describe('the client gates the same things', () => {
  const read = (f) => readFileSync(new URL(`../src/components/app/${f}`, import.meta.url), 'utf8');
  test('giveaways are hidden on iOS', () => assert.match(read('GiveawaysCard.tsx'), /if \(!canOfferSubscription\(\)\) return null;/));
  test('the pairing-code field is hidden on iOS', () => assert.match(read('PairBridge.tsx'), /if \(!canOfferSubscription\(\)\) return null;\s*return <PairRedeem \/>/));
  test('the profile UPGRADE chip is gated', () => assert.match(read('ProfileView.tsx'), /\{canOfferSubscription\(\) && <div[\s\S]{0,200}aria-label=\{t\('Your plan'\)\}/));
});
