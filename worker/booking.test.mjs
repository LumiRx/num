// Booking detection and deep links.
//
// The rule underneath all of it: we never claim to have booked something we
// have not booked. Every platform here is mode 'deeplink' — the guest taps
// and completes it on the venue's own platform, with the form already filled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBooking, bookingLink, bookable, PLATFORMS } from './booking.mjs';

test('a booking link on a venue page names the platform and the venue', () => {
  const html = '<a href="https://resy.com/cities/la/bestia?date=2026-08-11">Reservations</a>';
  assert.deepEqual(detectBooking(html), { platform: 'resy', ref: 'bestia', kind: 'table', mode: 'deeplink' });
});

test('OpenTable is recognised by slug and by numeric ref', () => {
  assert.equal(detectBooking('<a href="https://www.opentable.com/r/bestia-los-angeles">book</a>').ref, 'bestia-los-angeles');
  const byId = detectBooking('<a href="https://www.opentable.com/restaurant/profile/12345?restref=87421">book</a>');
  assert.equal(byId.platform, 'opentable');
});

test('a bare platform homepage is not a venue', () => {
  // "resy.com/cities/la" with no venue would otherwise store ref 'la' and
  // send every guest to a city index.
  assert.equal(detectBooking('<a href="https://resy.com/cities/la">Find a table</a>'), null);
  assert.equal(detectBooking('<a href="https://www.opentable.com/">powered by OpenTable</a>'), null);
});

test('a page with no booking link returns null, not a guess', () => {
  assert.equal(detectBooking('<html><body>Walk-ins only. Call us.</body></html>'), null);
});

test('the link arrives prefilled', () => {
  const l = bookingLink({ booking_platform: 'opentable', booking_ref: 'bestia-los-angeles' },
    { party: 4, date: '2026-08-12', time: '19:30' });
  assert.match(l.url, /covers=4/, 'the party size did not survive — the guest re-enters it');
  assert.match(l.url, /dateTime=2026-08-12T19%3A30/);
  assert.equal(l.mode, 'deeplink', 'a deeplink must never present as an API booking');
});

test('nonsense in the booking details is dropped, not passed through', () => {
  const l = bookingLink({ booking_platform: 'resy', booking_ref: 'bestia' },
    { party: 'DROP TABLE', date: 'tomorrow', time: 'sevenish' });
  assert.ok(!/DROP|tomorrow|sevenish/.test(l.url), 'unvalidated input reached the outbound URL');
});

test('party size is capped', () => {
  const l = bookingLink({ booking_platform: 'tock', booking_ref: 'somewhere' }, { party: 500 });
  assert.match(l.url, /size=20/, 'a 500-cover request went out as-is');
});

test('a place with no platform simply cannot be booked', () => {
  // The caller has to say so out loud rather than show a dead button.
  assert.equal(bookingLink({ name: 'Somewhere' }), null);
  assert.equal(bookable({ booking_platform: 'resy' }), false, 'a platform with no ref is not bookable');
  assert.equal(bookable({ booking_platform: 'resy', booking_ref: 'bestia' }), true);
});

test('no platform claims to book by API until one actually does', () => {
  for (const [id, p] of Object.entries(PLATFORMS)) {
    assert.equal(p.mode, 'deeplink',
      `${id} is marked '${p.mode}' — if a real write API landed, make sure the confirmation copy changed too`);
  }
});

test('every platform builds a valid URL from its own ref', () => {
  for (const [id, p] of Object.entries(PLATFORMS)) {
    const url = bookingLink({ booking_platform: id, booking_ref: 'test-ref-1234' }, { party: 2 })?.url;
    assert.ok(url && /^https:\/\//.test(url), `${id} produced no usable link`);
    assert.doesNotThrow(() => new URL(url), `${id} produced a malformed URL`);
  }
});

test('SynXis is found when a hotel white-labels it on its own domain', () => {
  // The Fingal's booking button is book.fingal.co.uk carrying the identical
  // hotel/chain/level triple. Matching only be.synxis.com missed every
  // white-labelled property — and Fingal claimed its NUM listing the same week.
  const d = detectBooking('', 'https://book.fingal.co.uk/?adult=2&arrive=2026-08-28&chain=6386&hotel=31306&level=hotel&locale=en-GB');
  assert.equal(d?.platform, 'synxis');
  assert.equal(d.ref, '31306:6386:book.fingal.co.uk');
});

test('a white-labelled engine keeps the guest on the hotel own domain', () => {
  // Bouncing somebody to a Sabre URL they have never seen, to pay a hotel they
  // chose by name, is how a booking gets abandoned.
  const d = detectBooking('', 'https://book.fingal.co.uk/?chain=6386&hotel=31306&level=hotel');
  const out = bookingLink({ booking_platform: d.platform, booking_ref: d.ref },
    { checkin: '2026-09-12', checkout: '2026-09-14', adults: 2, rooms: 1 });
  assert.ok(out.url.startsWith('https://book.fingal.co.uk/'), out.url);
  assert.match(out.url, /arrive=2026-09-12&depart=2026-09-14/);
  assert.equal(out.dated, true);
});

test('the original Sabre-hosted form still works, and still prefills', () => {
  const d = detectBooking('', 'https://be.synxis.com/?adult=2&chain=25766&hotel=66353&level=hotel');
  assert.equal(d.ref, '66353:25766', 'the canonical host stays a two-segment ref');
  const out = bookingLink({ booking_platform: d.platform, booking_ref: d.ref },
    { checkin: '2026-09-12', checkout: '2026-09-14', adults: 2, rooms: 1 });
  assert.ok(out.url.startsWith('https://be.synxis.com/'));
  assert.match(out.url, /hotel=66353&chain=25766/);
});

test('a stray hotel/chain pair on an unrelated site is not a booking engine', () => {
  // level=hotel is the SynXis-ism that makes the host-agnostic half safe.
  assert.equal(detectBooking('', 'https://example.com/?hotel=2&chain=3'), null);
  assert.equal(detectBooking('', 'https://blog.example.com/best-hotel=5-chain=9-guide'), null);
});

test('a two-segment ref from before white-labelling still resolves', () => {
  // Rows written before the host was captured must keep working.
  const out = bookingLink({ booking_platform: 'synxis', booking_ref: '66353:25766' },
    { checkin: '2026-09-12', checkout: '2026-09-14' });
  assert.ok(out.url.startsWith('https://be.synxis.com/'), out.url);
});
