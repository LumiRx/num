/**
 * The stays rail, tested where it can actually be wrong.
 *
 * Three things this file exists to protect, in order of how much they would
 * cost if they broke:
 *
 *   1. THE WALL. The backend cross-check — public price, saving, commission,
 *      score — must never reach a guest. A leak here is not cosmetic: it
 *      publishes what NUM earns per room and it implies NUM has read a
 *      competitor's page, which NUM has not.
 *
 *   2. THE CLOSED USER GROUP. A below-public rate served to a signed-out
 *      visitor is a breach of a supplier contract term. That never happens as
 *      a decision; it happens as a refactor. So it is a test.
 *
 *   3. THE BOOKING SIMULATION. rates → prebook → book → cancel, driven end to
 *      end against a fake fetch, so the whole commit path is exercised with no
 *      credentials and nothing ever reaching Nuitée. The two hosts are
 *      asserted per call, because pointing a book at the search host fails as
 *      a 404 that reads exactly like a missing booking.
 *
 *   node --test worker/liteapi.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  missingForRates, missingForBook, normalizeRates, nightsBetween,
  intel, rank, publicOption, assertPublicSafe, offer,
  marginFor, keyEstate, bookingGate, searchRates, prebook, book, cancelBooking, paymentFor, enrich, marginToClearPublic,
} from './liteapi.mjs';

const ENV = { LITEAPI_KEY: 'sand_test', LITEAPI_BOOKING_ENABLED: 'true' };

/** A rates response shaped like theirs: hotel → roomTypes → rates. */
const RATES_RS = {
  data: [
    {
      hotelId: 'lp1a2b3',
      roomTypes: [
        {
          offerId: 'offer-refundable',
          name: 'Deluxe Double',
          maxOccupancy: 2,
          rates: [
            {
              rateId: 'r1',
              name: 'Deluxe Double, city view',
              boardType: 'BI',
              boardName: 'Breakfast included',
              refundableTag: 'RFN',
              cancellationPolicies: {
                cancelPolicyInfos: [{ cancelTime: '2026-10-01T12:00:00', amount: 0 }],
              },
              retailRate: {
                total: [{ amount: 271.4, currency: 'USD' }],
                suggestedSellingPrice: [{ amount: 312.0, currency: 'USD' }],
                commission: [{ amount: 24.3, currency: 'USD' }],
                taxesAndFees: [{ included: true, description: 'VAT', amount: 18.2, currency: 'USD' }],
              },
            },
          ],
        },
        {
          offerId: 'offer-resortfee',
          name: 'Standard Twin',
          rates: [
            {
              rateId: 'r2',
              name: 'Standard Twin',
              boardType: 'RO',
              refundableTag: 'NRFN',
              retailRate: {
                total: [{ amount: 240.0, currency: 'USD' }],
                suggestedSellingPrice: [{ amount: 244.0, currency: 'USD' }],
                commission: [{ amount: 12.0, currency: 'USD' }],
                taxesAndFees: [
                  { included: false, description: 'Resort fee', amount: 45.0, currency: 'USD' },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
  hotels: [{ id: 'lp1a2b3', name: 'The Caledonian', address: '1 Princes St', starRating: 5 }],
};

/* ── 1. the fields nobody was collecting ──────────────────────────────── */

describe('a search refuses to guess what it was not told', () => {
  test('names guestNationality, which NUM has never asked anyone for', () => {
    const missing = missingForRates({
      checkin: '2026-10-01', checkout: '2026-10-04', currency: 'USD',
      occupancies: [{ adults: 2 }], cityName: 'Edinburgh', countryCode: 'GB',
    });
    assert.deepEqual(missing, ['guestNationality']);
  });

  test('"where" is a single missing field, however many ways there are to say it', () => {
    const missing = missingForRates({
      checkin: '2026-10-01', checkout: '2026-10-04', currency: 'USD',
      guestNationality: 'US', occupancies: [{ adults: 2 }],
    });
    assert.deepEqual(missing, ['where']);
  });

  test('children without ages is refused — a 2-year-old and a 15-year-old are not the same price', () => {
    const missing = missingForRates({
      checkin: '2026-10-01', checkout: '2026-10-04', currency: 'USD', guestNationality: 'GB',
      placeId: 'x', occupancies: [{ adults: 2, children: 2, childrenAges: [7] }],
    });
    assert.ok(missing.includes('childrenAges'));
  });

  test('a complete search has nothing missing', () => {
    assert.deepEqual(missingForRates({
      checkin: '2026-10-01', checkout: '2026-10-04', currency: 'GBP', guestNationality: 'GB',
      placeId: 'ChIJ', occupancies: [{ adults: 2, children: 1, childrenAges: [7] }],
    }), []);
  });
});

/* ── 2. normalizing ───────────────────────────────────────────────────── */

describe('normalize', () => {
  const rates = normalizeRates(RATES_RS);

  test('flattens hotel → roomTypes → rates', () => {
    assert.equal(rates.length, 2);
    assert.equal(rates[0].hotelName, 'The Caledonian');
    assert.equal(rates[0].offerId, 'offer-refundable');
  });

  test('RFN and NRFN become a boolean a person can read', () => {
    assert.equal(rates[0].refundable, true);
    assert.equal(rates[1].refundable, false);
  });

  test('an EXCLUDED fee is carried out separately, never folded into the total', () => {
    assert.equal(rates[1].total, 240);
    assert.equal(rates[1].feesExcluded, 45);
    assert.deepEqual(rates[1].feesExcludedNames, ['Resort fee']);
    // An included tax must NOT count as money owed at the desk.
    assert.equal(rates[0].feesExcluded, 0);
  });

  test('nights', () => {
    assert.equal(nightsBetween('2026-10-01', '2026-10-04'), 3);
    assert.equal(nightsBetween('2026-10-04', '2026-10-01'), null);
  });
});

/* ── 3. the cross-check itself ────────────────────────────────────────── */

describe('intel', () => {
  const [refundable, resortfee] = normalizeRates(RATES_RS);

  test('reads the saving out of the same payload, with nothing scraped', () => {
    const i = intel(refundable);
    assert.equal(i.belowPublic, true);
    assert.equal(i.savingCs, 4060); // 312.00 − 271.40
    assert.equal(i.verdict, 'below_public');
  });

  test('no public reference is its own verdict, not a saving of zero', () => {
    const i = intel({ total: 100, publicTotal: null });
    assert.equal(i.verdict, 'no_public_reference');
    assert.equal(i.belowPublic, false);
  });

  test('ranking prefers refundable and punishes a fee waiting at the desk', () => {
    const ranked = rank([refundable, resortfee]);
    assert.equal(ranked[0].offerId, 'offer-refundable',
      'the cheaper room won, which means price is outranking cancellability again');
  });
});

describe('the second public-price reference', () => {
  const [refundable] = normalizeRates(RATES_RS); // total 271.40, publicTotal 312

  test('with no second reference, nothing changes — one_sided, and the rate payload stands', () => {
    const i = intel(refundable);
    assert.equal(i.publicRefVerdict, 'one_sided');
    assert.equal(i.publicUsed, 312);
    assert.equal(i.savingCs, 4060);
  });

  test('a second reference that agrees firms it up, and the higher one is used', () => {
    const i = intel(refundable, { publicRef: 305 });
    assert.equal(i.publicRefVerdict, 'agreed');
    assert.equal(i.publicUsed, 312, 'overstating a saving is the worse error');
  });

  test('a second reference that disagrees shrinks the claim rather than hiding it', () => {
    const i = intel(refundable, { publicRef: 180 });
    assert.equal(i.publicRefVerdict, 'disagreed');
    assert.equal(i.publicUsed, 180);
    // 180 − 271.40 is negative: on the conservative reference this room is NOT
    // below the public price, and NUM must stop saying it is.
    assert.equal(i.belowPublic, false,
      'a disputed reference must not be allowed to keep a saving claim alive');
    assert.ok(i.publicRefGapPct > 40);
  });

  test('offer() threads the references through by hotel id', () => {
    const out = offer(normalizeRates(RATES_RS), {
      signedIn: true, nights: 3, publicRefs: new Map([['lp1a2b3', 180]]),
    });
    assert.equal(out.length, 2, 'a disputed reference changes the claim, not the inventory');
  });
});

describe('enrich — the half that makes the data layer real', () => {
  const rates = normalizeRates(RATES_RS);

  const supplier = ({ price = 305, content = {}, failPrice = false, failContent = false } = {}) => {
    const calls = [];
    return {
      calls,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.includes('/price-index/public-price')) {
          if (failPrice) return { ok: false, status: 500, json: async () => ({}) };
          return { ok: true, status: 200, json: async () => ({ data: { publicPrice: price } }) };
        }
        if (url.includes('/data/hotel')) {
          if (failContent) throw new Error('content down');
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { id: 'lp1a2b3', checkinCheckoutTimes: { checkin: '15:00', checkout: '11:00' }, ...content } }),
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      },
    };
  };

  test('it spends calls only on the shortlist, not on every rate returned', async () => {
    const sup = supplier();
    await enrich(ENV, rates, { checkin: '2026-10-01', checkout: '2026-10-04', fetchImpl: sup.fetchImpl });
    // One hotel in the fixture, two rates. Two calls — a price and a content —
    // not one pair per rate.
    assert.equal(sup.calls.length, 2, 'a 200-rate search must not become 200 reference lookups');
  });

  test('the second reference reaches the ranking', async () => {
    const sup = supplier({ price: 180 });
    const { publicRefs } = await enrich(ENV, rates, { checkin: '2026-10-01', checkout: '2026-10-04', fetchImpl: sup.fetchImpl });
    assert.equal(publicRefs.get('lp1a2b3'), 180);
    const out = offer(rates, { signedIn: true, nights: 3, publicRefs });
    assert.ok(out.length > 0);
  });

  test('check-in times reach the guest payload — and the margin still does not', async () => {
    const sup = supplier();
    const { content } = await enrich(ENV, rates, { checkin: '2026-10-01', checkout: '2026-10-04', fetchImpl: sup.fetchImpl });
    const [first] = offer(rates, { signedIn: true, nights: 3, content });
    assert.equal(first.checkinFrom, '15:00');
    assert.equal(first.checkoutBefore, '11:00');
    const blob = JSON.stringify(first);
    for (const leak of ['publicTotal', 'commission', '_intel', '_score']) {
      assert.ok(!blob.includes(leak), `content enrichment leaked ${leak}`);
    }
  });

  test('a chain is detected, which is what turns the loyalty warning on', async () => {
    const sup = supplier({ content: { chain: 'Hilton' } });
    const { anyChain } = await enrich(ENV, rates, { checkin: '2026-10-01', checkout: '2026-10-04', fetchImpl: sup.fetchImpl });
    assert.equal(anyChain, true);
  });

  test('a content failure cannot SILENCE the warning — the hotel name is the fallback', async () => {
    const chainRates = rates.map((r) => ({ ...r, hotelName: 'DoubleTree by Hilton Edinburgh' }));
    const sup = supplier({ failContent: true });
    const { anyChain, content } = await enrich(ENV, chainRates, { checkin: '2026-10-01', checkout: '2026-10-04', fetchImpl: sup.fetchImpl });
    assert.equal(content.size, 0);
    assert.equal(anyChain, true, 'a failed lookup must not quietly drop a disclosure');
  });

  test('a failed price lookup degrades to one reference, and the search still answers', async () => {
    const sup = supplier({ failPrice: true });
    const { publicRefs } = await enrich(ENV, rates, { checkin: '2026-10-01', checkout: '2026-10-04', fetchImpl: sup.fetchImpl });
    assert.equal(publicRefs.size, 0);
    const out = offer(rates, { signedIn: true, nights: 3, publicRefs });
    assert.equal(out.length, 2, 'a slow price index must not take down a hotel search');
  });

  test('no rates in, no calls out', async () => {
    const sup = supplier();
    const e = await enrich(ENV, [], { checkin: '2026-10-01', checkout: '2026-10-04', fetchImpl: sup.fetchImpl });
    assert.equal(sup.calls.length, 0);
    assert.equal(e.anyChain, false);
  });
});

/* ── 4. THE WALL ──────────────────────────────────────────────────────── */

describe('nothing from the cross-check reaches a guest', () => {
  const ranked = rank(normalizeRates(RATES_RS));

  test('publicOption emits no public price, no saving, no commission, no score', () => {
    const out = publicOption(ranked[0], { nights: 3 });
    const blob = JSON.stringify(out);
    for (const leak of ['publicTotal', 'suggestedSellingPrice', 'commission', '_intel', '_score', 'savingCs', 'verdict']) {
      assert.ok(!blob.includes(leak), `the guest payload carries ${leak}`);
    }
    assert.equal(out.total, 271.4);
    assert.equal(out.nightly, 90.47);
    assert.equal(out.refundable, true);
    assert.equal(out.cancelBy, '2026-10-01T12:00:00');
  });

  test('money owed at the desk is said out loud, because the desk will say it otherwise', () => {
    const fee = ranked.find((r) => r.offerId === 'offer-resortfee');
    const out = publicOption(fee, { nights: 3 });
    assert.equal(out.payAtHotel, 45);
    assert.deepEqual(out.payAtHotelFor, ['Resort fee']);
  });

  test('the saving line is off unless someone switched it on, and never names a competitor', () => {
    assert.equal(publicOption(ranked[0], { nights: 3 }).belowPublicBy, undefined);
    const shown = publicOption(ranked[0], { nights: 3, showSaving: true });
    assert.equal(shown.belowPublicBy, 40.6);
    assert.ok(!JSON.stringify(shown).match(/booking|kayak|expedia|agoda/i));
  });
});

/* ── 5. the closed user group ─────────────────────────────────────────── */

describe('a member rate is not a public rate', () => {
  const ranked = rank(normalizeRates(RATES_RS));

  test('serving a below-public rate to a signed-out visitor throws', () => {
    assert.throws(() => assertPublicSafe(ranked[0], { signedIn: false }), /closed user group|signed-out/i);
  });

  test('signed in, the same rate is fine', () => {
    assert.equal(assertPublicSafe(ranked[0], { signedIn: true }), true);
  });

  // ── THIS TEST HAS BEEN WRONG TWICE, AND THE SECOND TIME MATTERED ──────
  //
  // First it asserted that below-public rates were FILTERED from a signed-out
  // answer, which returned nothing at all for a stranger.
  //
  // Then it asserted they were FLOORED — the displayed total raised to the
  // public price. That passed, and it was worse: the supplier was still quoted
  // at the lower margin, so prebook came back lower and the confirm screen
  // showed $271.40 under an options screen that had said $312. NUM published
  // one price and transacted at another.
  //
  // The price is now lifted by RE-QUOTING at a higher margin (the /search
  // route), so displayed and charged are the same number. offer() only drops
  // what is still below afterwards — the residual, not the mechanism.
  test('offer() no longer draws a price it would not charge', () => {
    const out = offer(normalizeRates(RATES_RS), { signedIn: false, nights: 3 });
    for (const o of out) {
      assert.ok(o.total != null);
    }
    // Both fixtures are below their public price and no re-quote has happened
    // in this unit, so both are correctly withheld rather than mis-drawn.
    assert.equal(out.length, 0,
      'showing a floored price here is what put the display and the charge out of step');
  });

  test('marginToClearPublic computes the re-quote that fixes it, from the supplier’s own arithmetic', () => {
    // 271.40 quoted at 7% → net 253.64. To reach 312 needs ~23%.
    const m = marginToClearPublic(normalizeRates(RATES_RS), 7);
    assert.ok(m >= 23 && m <= 25, `expected about 23%, got ${m}`);
    // Re-quoted at that margin, the same room clears its public price.
    const net = 271.4 / 1.07;
    assert.ok(net * (1 + m / 100) >= 312);
  });

  test('nothing below public means no re-quote is asked for', () => {
    const fine = normalizeRates(RATES_RS).map((r) => ({ ...r, total: 400 }));
    assert.equal(marginToClearPublic(fine, 7), null);
  });

  test('it takes the WORST case, because one request carries one margin', () => {
    const rates = [
      { total: 100, publicTotal: 110 },  // needs ~10%
      { total: 100, publicTotal: 150 },  // needs ~50%
    ];
    assert.equal(marginToClearPublic(rates, 0), 50);
  });

  test('a mad number is capped rather than sent to a supplier', () => {
    assert.equal(marginToClearPublic([{ total: 1, publicTotal: 10000 }], 0), 100);
  });

  test('signed in, the same room is the member price', () => {
    const out = offer(normalizeRates(RATES_RS), { signedIn: true, nights: 3 });
    assert.equal(out.length, 2);
    assert.equal(out.find((o) => o.id === 'offer-refundable').total, 271.4);
  });

  test('a signed-out answer never claims a saving, whatever is in it', () => {
    const out = offer(normalizeRates(RATES_RS), { signedIn: false, nights: 3, showSaving: true });
    for (const o of out) assert.equal(o.belowPublicBy, undefined);
  });

  test('the guard catches a floored rate whose price was put back by hand', () => {
    const [r] = rank(normalizeRates(RATES_RS));
    assert.throws(() => assertPublicSafe({ ...r, total: 200, publicTotal: 312 }, { signedIn: false }));
  });
});

/* ── 6. margin ────────────────────────────────────────────────────────── */

describe('margin is a commercial decision, not a default', () => {
  test('unset means NET — this file does not invent a markup', () => {
    assert.equal(marginFor({}, { member: false }), 0);
  });
  test('a member margin may be lower than the public one', () => {
    const e = { LITEAPI_MARGIN_PUBLIC: '12', LITEAPI_MARGIN_MEMBER: '6' };
    assert.equal(marginFor(e, { member: false }), 12);
    assert.equal(marginFor(e, { member: true }), 6);
  });
  test('a member with no member margin set falls back to the public one, never to zero', () => {
    assert.equal(marginFor({ LITEAPI_MARGIN_PUBLIC: '12' }, { member: true }), 12);
  });
  test('nonsense is refused rather than sent to a supplier', () => {
    assert.equal(marginFor({ LITEAPI_MARGIN_PUBLIC: '-5' }, {}), 0);
    assert.equal(marginFor({ LITEAPI_MARGIN_PUBLIC: 'lots' }, {}), 0);
  });
});

/* ── 7. capability is not permission ──────────────────────────────────── */

describe('the gates', () => {
  test('a key alone does not permit booking', () => {
    const g = bookingGate({ LITEAPI_KEY: 'sand_x' });
    assert.equal(g.ok, false);
    assert.match(g.why, /LITEAPI_BOOKING_ENABLED/);
  });

  test('production needs a second switch', () => {
    const g = bookingGate({ LITEAPI_KEY: 'prod_x', LITEAPI_BOOKING_ENABLED: 'true' });
    assert.equal(g.ok, false);
    assert.match(g.why, /LITEAPI_BOOKING_LIVE/);
    assert.equal(bookingGate({ LITEAPI_KEY: 'prod_x', LITEAPI_BOOKING_ENABLED: 'true', LITEAPI_BOOKING_LIVE: 'true' }).ok, true);
  });

  test('the estate is read off the key prefix, because there is no URL to check', () => {
    assert.equal(keyEstate({ LITEAPI_KEY: 'prod_abc' }), 'production');
    assert.equal(keyEstate({ LITEAPI_KEY: 'sand_abc' }), 'sandbox');
    assert.equal(keyEstate({}), 'none');
  });

  test('book refuses while the gate is shut, and says which switch', async () => {
    await assert.rejects(
      () => book({ LITEAPI_KEY: 'sand_x' }, { prebookId: 'p', holder: {}, guests: [], payment: {} }),
      /LITEAPI_BOOKING_ENABLED/,
    );
  });
});

/* ── 8. every field a booking cannot go without ───────────────────────── */

describe('the booking contract', () => {
  test('names each missing field by its path, so a form can put the cursor in it', () => {
    const missing = missingForBook({
      prebookId: 'pb_1',
      holder: { firstName: 'Dre' },
      guests: [{ occupancyNumber: 1, firstName: 'Dre' }],
      payment: { method: 'TRANSACTION_ID' },
    });
    assert.ok(missing.includes('holder.lastName'));
    assert.ok(missing.includes('holder.email'));
    assert.ok(missing.includes('guests[0].lastName'));
    // payment.transactionId is deliberately NOT listed. paymentFor() decides
    // the method and whether a session reference is needed, from the key's
    // estate; a second check here could disagree with the one that matters,
    // and in a sandbox it would demand something a rehearsal never has.
    assert.ok(!missing.some((m) => m.startsWith('payment')));
  });

  test('an email that is not an email is a missing email', () => {
    const missing = missingForBook({
      prebookId: 'pb_1',
      holder: { firstName: 'A', lastName: 'B', email: 'not-an-email' },
      guests: [{ occupancyNumber: 1, firstName: 'A', lastName: 'B' }],
      payment: { method: 'ACC_CREDIT_CARD' },
    });
    assert.ok(missing.some((m) => m.startsWith('holder.email')));
  });

  test('a complete payload has nothing missing', () => {
    assert.deepEqual(missingForBook({
      prebookId: 'pb_1',
      holder: { firstName: 'A', lastName: 'B', email: 'a@b.com' },
      guests: [{ occupancyNumber: 1, firstName: 'A', lastName: 'B' }],
      payment: { method: 'ACC_CREDIT_CARD' },
    }), []);
  });
});

/* ── 8b. THE PAYMENT METHOD IS NOT THE CALLER'S TO CHOOSE ─────────────── */

describe('a simulated charge cannot reach production', () => {
  const SAND = { LITEAPI_KEY: 'sand_x' };
  const PROD = { LITEAPI_KEY: 'prod_x' };

  test('ACC_CREDIT_CARD is refused against a production key', () => {
    // This is the hole. ACC_CREDIT_CARD moves no money, so against a prod key
    // it is a way to take a real room out of inventory with nothing paid — and
    // anything holding a member id can post to the book route, so "the app
    // would never send that" is not a control.
    assert.throws(
      () => paymentFor(PROD, { method: 'ACC_CREDIT_CARD' }),
      (err) => err.code === 'simulated_payment_refused' && err.status === 400,
    );
  });

  test('and is the right answer in a sandbox, which is what makes a rehearsal possible', () => {
    assert.deepEqual(paymentFor(SAND, { method: 'ACC_CREDIT_CARD' }), { method: 'ACC_CREDIT_CARD' });
    assert.deepEqual(paymentFor(SAND, {}), { method: 'ACC_CREDIT_CARD' },
      'an empty payment in a sandbox is a rehearsal, not an error');
  });

  test('a real session reference wins in either estate', () => {
    for (const env of [SAND, PROD]) {
      assert.deepEqual(paymentFor(env, { transactionId: 'tx_9' }), { method: 'TRANSACTION_ID', transactionId: 'tx_9' });
    }
  });

  test('a live booking with no session reference is refused, in NUM’s words not the supplier’s', () => {
    assert.throws(() => paymentFor(PROD, {}), (err) => err.code === 'no_payment_session');
  });

  test('a caller cannot smuggle the simulated method past a prod key through book()', async () => {
    await assert.rejects(
      () => book(
        { LITEAPI_KEY: 'prod_x', LITEAPI_BOOKING_ENABLED: 'true', LITEAPI_BOOKING_LIVE: 'true' },
        {
          prebookId: 'pb', holder: { firstName: 'A', lastName: 'B', email: 'a@b.com' },
          guests: [{ occupancyNumber: 1, firstName: 'A', lastName: 'B' }],
          payment: { method: 'ACC_CREDIT_CARD' },
        },
        { fetchImpl: async () => { throw new Error('the supplier should never have been called'); } },
      ),
      /sandbox key/,
    );
  });
});

/* ── 9. THE SIMULATED BOOKING, END TO END ─────────────────────────────── */

describe('a whole booking, against a fake supplier', () => {
  /** Records every call so the hosts and payloads can be asserted. */
  function recorder(responses) {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ url, method: init?.method, body, headers: init?.headers });
      const key = Object.keys(responses).find((k) => url.includes(k));
      if (!key) throw new Error(`no fixture for ${url}`);
      return { ok: true, status: 200, json: async () => responses[key] };
    };
    return { calls, fetchImpl };
  }

  test('rates → prebook → book → cancel', async () => {
    const { calls, fetchImpl } = recorder({
      '/hotels/rates': RATES_RS,
      '/rates/prebook': {
        data: { prebookId: 'pb_77', transactionId: 'tx_77', secretKey: 'sk_77', price: 271.4, priceChanged: false },
      },
      '/rates/book': {
        data: {
          bookingId: 'bk_99', clientReference: 'num-stay-abc', status: 'CONFIRMED',
          hotelConfirmationCode: 'CAL-55231', price: 271.4, currency: 'USD',
          checkin: '2026-10-01', checkout: '2026-10-04',
        },
      },
      '/bookings/bk_99': { data: { status: 'CANCELLED', refundAmount: 271.4 } },
    });

    // 1 — search, as a signed-in member so the member margin applies.
    const rs = await searchRates(ENV, {
      checkin: '2026-10-01', checkout: '2026-10-04', currency: 'USD', guestNationality: 'US',
      occupancies: [{ adults: 2 }], cityName: 'Edinburgh', countryCode: 'GB',
    }, { member: true, fetchImpl });
    const options = offer(normalizeRates(rs), { signedIn: true, nights: 3 });
    assert.equal(options.length, 2);
    assert.equal(options[0].hotel, 'The Caledonian');

    // 2 — prebook the one the guest tapped.
    const pre = await prebook(ENV, { offerId: options[0].id, fetchImpl });
    assert.equal(pre.prebookId, 'pb_77');
    assert.equal(pre.priceChanged, false);

    // 3 — book it. ACC_CREDIT_CARD is their sandbox method: it simulates a
    // charge and moves no money, which is what makes this rehearsable.
    const confirmed = await book(ENV, {
      prebookId: pre.prebookId,
      holder: { firstName: 'Dre', lastName: 'Tester', email: 'dre@example.com', phone: '0200923695' },
      guests: [{ occupancyNumber: 1, firstName: 'Dre', lastName: 'Tester' }],
      payment: { method: 'ACC_CREDIT_CARD' },
      clientReference: 'num-stay-abc',
    }, { fetchImpl });
    assert.equal(confirmed.bookingId, 'bk_99');
    assert.equal(confirmed.status, 'CONFIRMED');
    assert.equal(confirmed.hotelConfirmationCode, 'CAL-55231');

    // 4 — and undo it.
    const cancelled = await cancelBooking(ENV, confirmed.bookingId, { fetchImpl });
    assert.equal(cancelled.status, 'CANCELLED');

    // ── the assertions that only a recorder can make ──────────────────
    assert.ok(calls[0].url.startsWith('https://api.liteapi.travel/'), 'search went to the wrong host');
    for (const c of calls.slice(1)) {
      assert.ok(c.url.startsWith('https://book.liteapi.travel/'),
        `${c.url} committed against the search host — that 404s and reads like a missing booking`);
    }
    assert.equal(calls[0].headers['X-API-Key'], 'sand_test');
    // Their own documented sample carries holder.phone; ours must too.
    assert.equal(calls[2].body.holder.phone, '0200923695');
    assert.equal(calls[2].body.payment.method, 'ACC_CREDIT_CARD', 'the sandbox estate should have picked the simulated charge');
    assert.equal(calls[3].method, 'PUT', 'cancel must be a PUT on the booking, not a POST');
  });

  test('the margin actually travels on the request, and differs for a member', async () => {
    const e = { ...ENV, LITEAPI_MARGIN_PUBLIC: '14', LITEAPI_MARGIN_MEMBER: '7' };
    const { calls, fetchImpl } = recorder({ '/hotels/rates': RATES_RS });
    const q = {
      checkin: '2026-10-01', checkout: '2026-10-04', currency: 'USD', guestNationality: 'US',
      occupancies: [{ adults: 2 }], placeId: 'p',
    };
    await searchRates(e, q, { member: false, fetchImpl });
    await searchRates(e, q, { member: true, fetchImpl });
    assert.equal(calls[0].body.margin, 14);
    assert.equal(calls[1].body.margin, 7);
  });

  test('a price that moved at prebook is reported, and an undeterminable one is null not false', async () => {
    const moved = recorder({ '/rates/prebook': { data: { prebookId: 'p', priceDifference: 18.5 } } });
    assert.equal((await prebook(ENV, { offerId: 'o', fetchImpl: moved.fetchImpl })).priceChanged, true);

    const silent = recorder({ '/rates/prebook': { data: { prebookId: 'p' } } });
    assert.equal((await prebook(ENV, { offerId: 'o', fetchImpl: silent.fetchImpl })).priceChanged, null,
      'an unknown price change reported as "no change" is how somebody gets charged a price they never saw');
  });

  test('a supplier error surfaces its own words, not a generic 500', async () => {
    const fetchImpl = async () => ({
      ok: false, status: 422,
      json: async () => ({ error: { description: 'Rate no longer available' } }),
    });
    await assert.rejects(
      () => prebook(ENV, { offerId: 'gone', fetchImpl }),
      (err) => err.message === 'Rate no longer available' && err.status === 422,
    );
  });
});
