// Hotel deep links — the hotel's own booking engine, not an OTA.
//
// ── WHY THESE ARE 'stay' AND NOT AN API ──────────────────────────────────
//
// The guest completes on the hotel's own page, so the reservation lands in the
// hotel's own system, the hotel pays no OTA commission, and NUM holds no money
// at any point. That last property is what keeps a seller-of-travel bond at
// zero (Cal. B&P §17550.11) and it is the same promise made to LetsGo2Trip.
// A deep link preserves it. An API that books on the hotel's behalf does not,
// and would not scale anyway: even through a channel manager, every individual
// hotel still has to switch NUM on as a channel.
//
// ── THE PROPERTY THESE TESTS EXIST TO PROTECT ────────────────────────────
//
// Every one of these engines is a single-page app that answers HTTP 200 to ANY
// query string, including invented parameter names. So "the link loaded" is not
// evidence the dates were understood. Guessing `checkInDate` when the engine
// wants `dateFrom` yields a page that opens cleanly on TODAY while the traveller
// believes they are looking at their weekend — a failure nobody sees until
// someone arrives at a hotel with no room.
//
// Hence: dates are prefilled only where the parameters were read off a live
// page, and `dated` reports honestly whether that happened.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORMS, STAY_PLATFORMS, PREFILLS_DATES, detectBooking, bookingLink, bookable } from './booking.mjs';

const stay = (platform, ref) => ({ booking_platform: platform, booking_ref: ref });
const WHEN = { checkin: '2026-09-24', checkout: '2026-09-26', adults: 2 };

describe('detection from a real hotel page', () => {
  // Every fixture below is a URL captured from a live Bath hotel website.
  const CASES = [
    ['https://direct-book.com/properties/theyardbathdirect', 'siteminder', 'theyardbathdirect'],
    ['https://app.mews.com/distributor/57662e28-3ba5-471b-b3d4-b287008b3109', 'mews',
      '57662e28-3ba5-471b-b3d4-b287008b3109'],
    ['https://reservations.travelclick.com/111998?languageid=1', 'travelclick', '111998'],
    ['https://be.synxis.com/?adult=2&arrive=2020-10-30&chain=32565&child=0&depart=2020-10-31&hotel=5160&level=hotel',
      'synxis', '5160:32565'],
  ];
  for (const [url, platform, ref] of CASES) {
    test(`finds ${platform}`, () => {
      const got = detectBooking(`<a href="${url}">Book</a>`, '');
      assert.ok(got, `nothing detected in ${url}`);
      assert.equal(got.platform, platform);
      assert.equal(got.ref, ref);
      assert.equal(got.kind, 'stay');
    });
  }

  test('SynXis captures hotel AND chain, in either order', () => {
    // A hotel id on its own lands the guest on a chain picker, which looks
    // like a working link and books nothing.
    const a = detectBooking('<a href="https://be.synxis.com/?hotel=1197&chain=5301">x</a>');
    const b = detectBooking('<a href="https://be.synxis.com/?chain=5301&hotel=1197">x</a>');
    assert.equal(a.ref, '1197:5301');
    assert.equal(b.ref, '1197:5301', 'parameter order changed the ref');
  });

  test('an engine’s own home page is not a hotel', () => {
    for (const noise of [
      '<a href="https://be.synxis.com/">Sign in</a>',
      '<a href="https://direct-book.com/properties/">x</a>',
      '<a href="https://www.siteminder.com/">Powered by SiteMinder</a>',
    ]) {
      const got = detectBooking(noise);
      assert.ok(!got || got.kind !== 'stay', `matched a platform front page: ${noise}`);
    }
  });

  test('a restaurant page still detects as a table, not a stay', () => {
    const got = detectBooking('<a href="https://www.opentable.com/r/bestia-los-angeles">Book</a>');
    assert.equal(got.platform, 'opentable');
    assert.equal(got.kind, 'table');
  });
});

describe('URLs captured from live UK hotel websites', () => {
  // Not invented fixtures. Every URL below was read off a real Bath or
  // Edinburgh hotel's own website on 24 Aug 2026 by sweeping 68 independents.
  // Three pattern bugs were found this way and only this way:
  //   · Cloudbeds publishes an embeddable WIDGET url, not /reservation/
  //   · Guestline is regionalised (booking.eu.guestline.app)
  //   · Profitroom had no pattern at all
  // Each was a connectable hotel being silently classed as unreachable.
  const FOUND = [
    ['https://direct-book.com/properties/theyardbathdirect', 'siteminder', 'theyardbathdirect'],
    ['https://direct-book.com/properties/CENTRALHOTELDIRECT?locale=en&', 'siteminder', 'CENTRALHOTELDIRECT'],
    ['https://direct-book.com/properties/murrayfielddirect?locale=en&amp', 'siteminder', 'murrayfielddirect'],
    ['https://direct-book.com/properties/hanover71suites', 'siteminder', 'hanover71suites'],
    ['https://app.mews.com/distributor/57662e28-3ba5-471b-b3d4-b287008b3109', 'mews', '57662e28-3ba5-471b-b3d4-b287008b3109'],
    ['https://app.mews.com/distributor/7c5055a3-d834-40f9-8fc6-216164c991eb', 'mews', '7c5055a3-d834-40f9-8fc6-216164c991eb'],
    ['https://hotels.cloudbeds.com/widget/load/HbdPEF/horiz?newWindow=1', 'cloudbeds', 'HbdPEF'],
    ['https://booking.profitroom.com/en/niracaledonia3/home?currency=GBP', 'profitroom', 'niracaledonia3'],
    ['https://booking.eu.guestline.app/frederickhse/availability?hotel=FREDERICK', 'guestline', 'frederickhse'],
    ['https://app.littlehotelier.com/properties/no32hotel', 'littlehotelier', 'no32hotel'],
    ['https://reservations.travelclick.com/111998', 'travelclick', '111998'],
  ];
  for (const [url, platform, ref] of FOUND) {
    test(`${platform} — ${ref.slice(0, 22)}`, () => {
      const got = detectBooking(`<a href="${url}">Book now</a>`);
      assert.ok(got, `no engine found in ${url}`);
      assert.equal(got.platform, platform);
      assert.equal(got.ref, ref);
      assert.equal(got.kind, 'stay');
      assert.ok(new URL(bookingLink({ booking_platform: platform, booking_ref: ref }, {}).url));
    });
  }

  test('a vendor MARKETING page is not a booking engine', () => {
    // Hotel Ceilidh-Donia links eviivo's own product page in its footer. A
    // sweep flagged it as connectable; the detector must not, or NUM sends a
    // guest to a software company's sales page and calls it a hotel booking.
    const got = detectBooking('<a href="https://eviivo.com/products/website-manager/?utm_source=website-builder">x</a>');
    assert.ok(!got || got.kind !== 'stay', 'a vendor marketing URL was taken for a booking page');
  });

  test('a SynXis link with no hotel id is refused', () => {
    // Royal Crescent and The Bird both surface a bare be.synxis.com in their
    // markup. It loads, and it books nothing — it is a chain picker.
    for (const url of ['https://be.synxis.com/', 'https://be.synxis.com/?chain=5154&amp']) {
      assert.equal(detectBooking(`<a href="${url}">x</a>`), null, `accepted ${url}`);
    }
  });
});

describe('the links themselves', () => {
  test('every stay platform builds a valid https URL', () => {
    assert.ok(STAY_PLATFORMS.length >= 8, `only ${STAY_PLATFORMS.length} stay engines`);
    for (const id of STAY_PLATFORMS) {
      const link = bookingLink(stay(id, id === 'synxis' ? '5160:32565' : 'testref'), {});
      assert.ok(link, `${id} produced no link`);
      const u = new URL(link.url);
      assert.equal(u.protocol, 'https:', `${id} is not https`);
      assert.equal(link.kind, 'stay');
    }
  });

  test('SynXis prefills the parameters observed on the live page', () => {
    const { url, dated } = bookingLink(stay('synxis', '5160:32565'), WHEN);
    const u = new URL(url);
    assert.equal(u.searchParams.get('hotel'), '5160');
    assert.equal(u.searchParams.get('chain'), '32565');
    assert.equal(u.searchParams.get('arrive'), '2026-09-24');
    assert.equal(u.searchParams.get('depart'), '2026-09-26');
    assert.equal(u.searchParams.get('adult'), '2');
    assert.equal(u.searchParams.get('rooms'), '1');
    assert.equal(dated, true);
  });

  test('Mews prefills its distributor parameters', () => {
    const u = new URL(bookingLink(stay('mews', 'abc'), WHEN).url);
    assert.equal(u.searchParams.get('mewsStart'), '2026-09-24');
    assert.equal(u.searchParams.get('mewsEnd'), '2026-09-26');
    assert.equal(u.searchParams.get('mewsAdultCount'), '2');
  });

  test('an UNVERIFIED engine gets a bare link and says dated:false', () => {
    // The whole discipline. These engines 200 on anything, so an invented
    // parameter would produce a confidently wrong booking page.
    for (const id of STAY_PLATFORMS.filter((x) => !PREFILLS_DATES.includes(x))) {
      const link = bookingLink(stay(id, 'testref'), WHEN);
      assert.equal(link.dated, false, `${id} claims to be dated`);
      const q = new URL(link.url).search;
      assert.ok(!/2026-09-24/.test(q), `${id} invented a date parameter`);
    }
  });

  test('an inverted or partial date range is refused, not guessed', () => {
    const back = bookingLink(stay('synxis', '5160:32565'),
      { checkin: '2026-09-26', checkout: '2026-09-24' });
    assert.equal(back.dated, false, 'checkout before checkin was accepted');
    assert.ok(!/arrive=/.test(back.url));
    assert.equal(bookingLink(stay('synxis', '5160:32565'), { checkin: '2026-09-24' }).dated, false);
    assert.equal(bookingLink(stay('synxis', '5160:32565'), { checkin: 'next friday', checkout: 'sunday' }).dated, false);
  });

  test('same night in and out is not a stay', () => {
    assert.equal(bookingLink(stay('synxis', '5160:32565'),
      { checkin: '2026-09-24', checkout: '2026-09-24' }).dated, false);
  });

  test('adults and rooms are clamped, never echoed raw', () => {
    const u = new URL(bookingLink(stay('synxis', '5160:32565'),
      { ...WHEN, adults: 99, rooms: 40 }).url);
    assert.equal(u.searchParams.get('adult'), '12');
    assert.equal(u.searchParams.get('rooms'), '5');
  });

  test('no ref, no link — and bookable() agrees', () => {
    assert.equal(bookingLink(stay('synxis', ''), WHEN), null);
    assert.equal(bookingLink({ booking_platform: 'not-an-engine', booking_ref: 'x' }, WHEN), null);
    assert.equal(bookable(stay('synxis', '')), false);
    assert.equal(bookable(stay('mews', 'abc')), true);
  });

  test('every stay label describes the HOTEL, never an OTA', () => {
    // The label is what a guest reads. "Book on Expedia" would be a lie about
    // where the money goes and who holds the reservation.
    for (const id of STAY_PLATFORMS) {
      const l = PLATFORMS[id].label.toLowerCase();
      assert.match(l, /hotel/, `${id} label does not name the hotel: ${l}`);
      assert.ok(!/booking\.com|expedia|agoda|hotels\.com/.test(l), `${id} label names an OTA`);
    }
  });
});
