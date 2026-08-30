// The three product facts the $0 bond rests on, pinned as behaviour.
//
// Under the referral structure (HQ/divisions/num/REFERRAL_STRUCTURE_ANALYSIS.md)
// Num holds no traveller money and a registered partner is merchant of record.
// §17550.11 then sizes an adequate surety bond at ZERO — but only because of
// three things that are true about the code:
//
//   1. no travel capability is reserved for payers   (§17550.27)
//   2. no Num money rail settles travel              (§17550.15(b))
//   3. no travel price is one Num computed           (§17550.1(a), §17550.15(b))
//
// Each is exercised here against the real modules. Nothing below reads source
// text: the point is what the functions DO.
//
// Run: node --test worker/compliance.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tiers, may, UNGATED } from './membership.mjs';
import { checkPayment, checkStars, isTravelRef } from './preflight.mjs';
import { STAR_POLICY } from './pay.mjs';
import { normalizeOffers, normalizeRates } from './sabre.mjs';

/* ── 1 · TRAVEL IS NOT A PAID BENEFIT (§17550.27) ──────────────────────── */

test('a free member can search fares, gets the priority lane, and is not locked out of booking', async () => {
  const free = tiers({}).free.entitlements;
  assert.equal(free.flight_search, true);
  assert.equal(free.priority_queue, true);
  assert.equal(free.concierge_booking, true);
});

test('every tier grants every ungated capability — no tier can differ on travel', () => {
  const all = tiers({});
  for (const [id, t] of Object.entries(all)) {
    for (const cap of UNGATED) {
      assert.equal(t.entitlements[cap], true, `${id} does not grant ${cap}`);
    }
  }
});

test('may() says yes to a member who has never paid and has no row in the database', async () => {
  for (const cap of UNGATED) {
    const v = await may({}, 'member-who-never-paid', cap);
    assert.equal(v.ok, true, `${cap} refused to a free member`);
  }
});

test('MEMBERSHIP_TIERS cannot re-gate travel from a dashboard with no deploy', () => {
  const hostile = JSON.stringify({
    free: { name: 'Num', price_cents: 0, entitlements: { concierge: true, flight_search: false, priority_queue: false, concierge_booking: false } },
    pro: { name: 'Num Pro', price_cents: 2898, entitlements: { flight_search: true, priority_queue: true, concierge_booking: true } },
  });
  const t = tiers({ MEMBERSHIP_TIERS: hostile });
  for (const cap of UNGATED) assert.equal(t.free.entitlements[cap], true, `${cap} was re-gated by the override`);
});

test('a paid tier advertises nothing about travel', () => {
  const all = tiers({});
  const paid = Object.values(all).filter((t) => t.price_cents > 0);
  assert.ok(paid.length > 0);
  for (const t of paid) {
    // The blurb is the sentence the pricing card shows. A travel promise here
    // is the "preferential treatment not made generally available" of
    // §17550.27(a)(1) in marketing copy.
    assert.doesNotMatch(String(t.blurb), /flight|fare|ticket|book|travel|hotel/i, `paid tier blurb sells travel: ${t.blurb}`);
  }
});

/* ── 2 · NO NUM RAIL SETTLES TRAVEL (§17550.15(b)) ─────────────────────── */

test('Stars do not spend on travel, and the policy says so', () => {
  assert.ok(!STAR_POLICY.spends_on.includes('bookings'), 'travel came back to spends_on');
  for (const s of STAR_POLICY.spends_on) {
    assert.doesNotMatch(s, /flight|hotel|travel|booking|ticket|cruise|rail/i, `spends_on names travel: ${s}`);
  }
  assert.ok(Array.isArray(STAR_POLICY.never_spends_on));
});

test('a Star spend for travel is refused, whatever the balance', () => {
  for (const purpose of ['flight:BKK-HKT', 'hotel:phuket-3n', 'cruise:med', 'rail:eurostar', 'travel:anything', 'transfer:airport']) {
    const v = checkStars({ amount: 10, available: 10_000_000, purpose });
    assert.equal(v.ok, false, `Stars settled travel: ${purpose}`);
    assert.equal(v.correction, null, 'a travel refusal must offer no way through');
  }
});

test('a Star spend for the things Stars are for still works', () => {
  for (const purpose of ['errand:charger', 'tab:bestia', 'table:bestia', 'bounty:passport', null]) {
    assert.equal(checkStars({ amount: 10, available: 500, purpose }).ok, true, `broke a real Star path: ${purpose}`);
  }
});

test('a card payment for travel is refused before amount or currency is even looked at', () => {
  for (const ref of ['flight:BKK-HKT', 'hotel:kata-3n', 'ticket:abc', 'airfare:xyz', 'cruise:med', 'itinerary:99', 'letsgo2trip:order']) {
    const v = checkPayment({ ref, amount_cents: 38900, currency: 'usd' });
    assert.equal(v.ok, false, `Num took money for travel: ${ref}`);
    assert.equal(v.correction, null);
    assert.match(v.reason, /travel/i);
  }
  // Even a nonsense currency and a nonsense amount refuse for the travel
  // reason, not the currency one — the order of the checks is the point.
  const v = checkPayment({ ref: 'flight:x', amount_cents: -5, currency: 'zzz' });
  assert.match(v.reason, /travel/i);
});

test('the payment paths that are not travel are untouched', () => {
  assert.equal(checkPayment({ ref: 'table:bestia', amount_cents: 12000 }).ok, true);
  assert.equal(checkPayment({ ref: 'tab:1234', amount_cents: 4500 }).ok, true);
  assert.equal(checkPayment({ ref: 'errand:charger', amount_cents: 900 }).ok, true);
  assert.equal(checkPayment({ ref: 'stars:1000' }).ok, true);
  assert.equal(checkPayment({ ref: 'tier:plus', amount_cents: 898 }).ok, true);
  assert.equal(isTravelRef('table:bestia'), false);
  assert.equal(isTravelRef('bookdesk:9'), false);
});

/* ── 3 · NO TRAVEL PRICE IS NUM'S (§17550.1(a)) ────────────────────────── */

test('a Sabre fare comes out of normalizeOffers byte-identical — no markup, no fee, no rounding', () => {
  const rs = {
    offers: [{
      id: 'OF1',
      totalPrice: { amount: '383.97', currencyCode: 'USD' },
      journeyRefs: ['J1'],
      items: [{ fares: [{ validatingAirlineCode: 'TG', fareTotal: { taxAmount: '41.13' }, fareComponents: [] }] }],
      validUntil: '2026-08-19T00:00:00Z',
    }],
    journeys: [{ id: 'J1', flightRefs: ['F1'] }],
    flights: [{
      id: 'F1', departureAirportCode: 'BKK', arrivalAirportCode: 'HKT',
      departureDate: '2026-09-01', departureTime: '23:59', arrivalDate: '2026-09-02', arrivalTime: '01:20',
      marketingAirlineCode: 'TG', marketingFlightNumber: '203', operatingAirlineCode: 'TG', operatingFlightNumber: '203',
      durationInMinutes: 81,
    }],
  };
  const [offer] = normalizeOffers(rs);
  assert.equal(offer.price, '383.97', 'the fare was altered on its way to the traveller');
  assert.equal(offer.currency, 'USD', 'Num converted a currency it must not convert');
  assert.equal(offer.tax, '41.13');
  assert.equal(typeof offer.price, 'string', 'a number would invite arithmetic; the supplier string must survive');
  // Nothing in the normalised offer is a second, Num-derived money field.
  const moneyish = Object.keys(offer).filter((k) => /price|fee|amount|markup|commission|surcharge/i.test(k));
  assert.deepEqual(moneyish.sort(), ['price'], `a Num-side money field appeared: ${moneyish}`);
});

test('a hotel rate comes out of normalizeRates unmodified too — lodging is travel', () => {
  const rs = {
    rooms: [{
      roomTypeName: 'Deluxe', numberOfAdults: 2,
      ratePlans: [{
        rateKey: 'RK1', ratePlanName: 'Best Flex',
        rateDetails: {
          averageNightlyRate: '2999.55', approxTotalPrice: '8998.65', currencyCode: 'THB',
          taxes: { amount: '629.90' }, fees: { amount: '0.00' },
          cancelPenalties: [{ refundable: true, description: 'Free until 24h before' }],
        },
      }],
    }],
  };
  const [rate] = normalizeRates(rs);
  assert.equal(rate.nightly, '2999.55');
  assert.equal(rate.total, '8998.65');
  assert.equal(rate.currency, 'THB', 'Num converted the supplier currency');
  assert.equal(rate.taxes, '629.90');
  assert.equal(rate.fees, '0.00', 'a fee Num did not levy must stay the supplier’s number');
});

test('there is no travel SKU in the price list Num controls', async () => {
  const { STAR_PACKS } = await import('./preflight.mjs');
  for (const k of Object.keys(STAR_PACKS)) assert.match(k, /^\d+$/);
  for (const t of Object.values(tiers({}))) {
    assert.doesNotMatch(String(t.name), /flight|fare|ticket|hotel|travel/i);
  }
});
