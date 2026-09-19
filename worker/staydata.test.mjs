/**
 * The data layer, tested where a wrong answer costs money or trust.
 *
 *   1. TWO PUBLIC PRICES THAT DISAGREE. Everything NUM says about a member
 *      rate rests on one field from one call. The second reference exists so
 *      that being wrong is detectable; averaging the two would hide exactly
 *      the case it was added to catch.
 *
 *   2. RECONCILIATION. "Not paid yet" and "not due yet" are different facts,
 *      and reporting them as one is how a rail that stopped paying looks
 *      healthy for a month.
 *
 *   3. THE CHAIN TEST. The loyalty disclosure is only honest if it fires on
 *      the properties it applies to and stays quiet on the ones it does not.
 *
 *   node --test worker/staydata.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  agreement, reconcile, chainProperty, LOYALTY_DISCLOSURE,
  hotelContent, publicPrice, resolvePlace,
} from './staydata.mjs';

const ENV = { LITEAPI_KEY: 'sand_test' };
const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });

/* ── 1. the second opinion ────────────────────────────────────────────── */

describe('two public-price references', () => {
  test('close enough is agreement, and the HIGHER one is used', () => {
    const a = agreement(312, 305);
    assert.equal(a.verdict, 'agreed');
    assert.equal(a.usable, 312,
      'overstating a saving is worse than understating one, so the higher reference wins');
  });

  test('a large gap is a finding, not a rounding error — and it is NOT averaged', () => {
    const a = agreement(312, 180);
    assert.equal(a.verdict, 'disagreed');
    assert.equal(a.usable, 180, 'the conservative claim is the lower public price');
    assert.ok(a.usable !== 246, 'averaging two numbers when one is wrong produces a third wrong one');
    assert.ok(a.gapPct > 40);
  });

  test('one reference missing is said out loud rather than treated as agreement', () => {
    assert.equal(agreement(312, null).verdict, 'one_sided');
    assert.equal(agreement(312, null).usable, 312);
    assert.equal(agreement(null, null).usable, null);
  });

  test('a zero or negative price is nonsense and yields nothing usable', () => {
    assert.equal(agreement(0, 312).verdict, 'nonsense');
    assert.equal(agreement(-5, 312).usable, null);
  });
});

/* ── 2. is NUM being paid ─────────────────────────────────────────────── */

describe('reconciliation', () => {
  const ours = [
    { client_reference: 'num-a', total_cs: 27140, checkout: '2026-09-04' }, // past, matched
    { client_reference: 'num-b', total_cs: 19900, checkout: '2026-09-05' }, // past, NOT matched
    { client_reference: 'num-c', total_cs: 41000, checkout: '2027-01-10' }, // future
  ];
  const theirs = [
    { clientReference: 'num-a', commission: 24.3, status: 'paid' },
    { clientReference: 'num-zzz', commission: 9.1, status: 'paid' },
  ];
  const r = reconcile(ours, theirs, { now: new Date('2026-09-19T00:00:00Z') });

  test('a stay that has not happened yet is NOT reported as unpaid', () => {
    assert.deepEqual(r.notYetDue, ['num-c'],
      'payouts land after checkout — calling this unpaid cries wolf every week');
    assert.ok(!r.unpaid.includes('num-c'));
  });

  test('a past stay with no commission row IS unpaid, and named', () => {
    assert.deepEqual(r.unpaid, ['num-b']);
  });

  test('matched rows carry both sides so they can be compared, not just counted', () => {
    assert.equal(r.matched.length, 1);
    assert.equal(r.matched[0].theirs, 24.3);
    assert.equal(r.matched[0].ours, 27140);
  });

  test('a booking THEY have that NUM does not is surfaced, not silently dropped', () => {
    assert.deepEqual(r.unknownToUs, ['num-zzz'],
      'a booking against NUM’s account with no NUM record is the loudest thing on this page');
  });
});

/* ── 3. the disclosure ────────────────────────────────────────────────── */

describe('the loyalty disclosure', () => {
  test('fires on chain properties, by chain OR by name', () => {
    assert.ok(chainProperty({ chain: 'Marriott International' }));
    assert.ok(chainProperty({ name: 'DoubleTree by Hilton Edinburgh City Centre' }));
    assert.ok(chainProperty({ hotelName: 'Kimpton Charlotte Square' }));
    assert.ok(chainProperty({ name: 'Holiday Inn Express Bath' }));
  });

  test('stays quiet on an independent', () => {
    assert.ok(!chainProperty({ name: 'The Yard Bath', chain: null }));
    assert.ok(!chainProperty({ name: 'Mono Suites', chain: '' }));
  });

  test('it says the thing that costs NUM the booking, which is why it is worth having', () => {
    assert.match(LOYALTY_DISCLOSURE, /does not earn/i);
    assert.match(LOYALTY_DISCLOSURE, /before they book/i);
    assert.match(LOYALTY_DISCLOSURE, /hotel's own page|hotel’s own page/i);
  });
});

/* ── 4. the reads ─────────────────────────────────────────────────────── */

describe('content', () => {
  test('check-in and check-out times are captured — the most asked, never held', async () => {
    const c = await hotelContent(ENV, 'lp1a2b3', {
      fetchImpl: ok({
        data: {
          id: 'lp1a2b3', name: 'The Caledonian', starRating: 5,
          checkinCheckoutTimes: { checkin: '15:00', checkout: '11:00', checkinStart: '14:00' },
          hotelFacilities: [{ name: 'Free WiFi' }, { name: 'Spa' }],
          hotelImages: [{ url: 'https://img/1.jpg' }],
          latitude: 55.9469, longitude: -3.2053,
        },
      }),
    });
    assert.equal(c.checkinFrom, '15:00');
    assert.equal(c.checkoutBefore, '11:00');
    assert.deepEqual(c.facilities, ['Free WiFi', 'Spa']);
    assert.deepEqual(c.images, ['https://img/1.jpg']);
    assert.equal(c.lat, 55.9469);
  });

  test('a place search returns ids, and drops rows with none', async () => {
    const places = await resolvePlace(ENV, 'Sukhumvit, Bangkok', {
      fetchImpl: ok({
        data: [
          { placeId: 'ChIJ_sukhumvit', displayName: 'Sukhumvit', types: ['sublocality'], latitude: 13.7, longitude: 100.5 },
          { displayName: 'no id here' },
        ],
      }),
    });
    assert.equal(places.length, 1);
    assert.equal(places[0].placeId, 'ChIJ_sukhumvit');
  });

  test('the key travels on a data read, and a failure carries the supplier’s words', async () => {
    let seen = null;
    await publicPrice(ENV, {
      hotelId: 'h1', checkin: '2026-10-01', checkout: '2026-10-04',
      fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ data: { publicPrice: 312 } }) }; },
    });
    assert.ok(seen.url.startsWith('https://book.liteapi.travel/'));
    assert.equal(seen.init.headers['X-API-Key'], 'sand_test');

    await assert.rejects(
      () => publicPrice(ENV, {
        hotelId: 'h1',
        fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ error: { description: 'No cached price' } }) }),
      }),
      /No cached price/,
    );
  });

  test('nothing runs without a key', async () => {
    await assert.rejects(() => hotelContent({}, 'h1'), /LITEAPI_KEY/);
  });
});
