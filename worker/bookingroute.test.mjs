/**
 * Every place Num names must come with a way to actually get a table.
 *
 * 6 Sep 2026, from Dre: "you are supposed to give the links to the restaurant
 * the user is asking for… we can connect them for the booking if we have it,
 * or if not suggest a booking app."
 *
 * `booking.mjs` has carried OpenTable, Resy, Tock and SevenRooms since day one
 * and NOTHING IN THE ANSWER PATH EVER CALLED IT — `index.mjs` reads
 * `pick.bookable` and no code ever set it. Meanwhile the deeplink path needs a
 * stored venue ref, and across 2.7M places we hold 17, every one a hotel. So
 * for restaurants the answer was always null.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bookingSearch, bookingOptions, bookingLink } from './booking.mjs';
import { detail } from './pickdetail.mjs';

test('a venue with a phone is booked by Num itself — the thing no hand-off does', () => {
  const o = bookingOptions({ name: 'Nahm', phone: '+6621234567', country: 'TH', city: 'Bangkok' });
  assert.equal(o.desk.mode, 'desk');
  assert.equal(o.desk.phone, '+6621234567');
  assert.equal(o.deep, null, 'no stored ref, so no deeplink — and that must not be faked');
  assert.equal(o.search.mode, 'search');
});

test('the booking app offered follows the country, not the loudest brand', () => {
  assert.equal(bookingSearch({ name: 'Nahm', country: 'TH' }).label, 'Chope');
  assert.equal(bookingSearch({ name: 'Septime', country: 'FR' }).label, 'TheFork');
  assert.equal(bookingSearch({ name: 'Bestia', country: 'US' }).label, 'OpenTable');
  assert.equal(bookingSearch({ name: 'Somewhere', country: 'ZZ' }).label, 'OpenTable', 'unknown country still gets a link, never nothing');
  assert.equal(bookingSearch({ name: '', country: 'US' }), null, 'no name, no search for nothing');
});

test('the search link carries the venue and the city, url-encoded', () => {
  const s = bookingSearch({ name: 'Bo.lan', country: 'TH', city: 'Sukhumvit' });
  assert.match(s.url, /^https:\/\/www\.chope\.co\/search\?q=/);
  assert.match(decodeURIComponent(s.url), /Bo\.lan Sukhumvit/);
  assert.equal(s.dated, false);
});

test('a search link is NEVER bookable — a model told otherwise would promise a reservation nobody made', () => {
  const noPhone = detail({ id: 'p1' }, { id: 'p1', name: 'Nahm', area: 'Bangkok' }, 'Asia/Bangkok', new Date(), 'TH');
  assert.equal(noPhone.bookable, false);
  assert.equal(noPhone.book.mode, 'search');

  const withPhone = detail({ id: 'p1' }, { id: 'p1', name: 'Nahm', phone: '+6621234567', area: 'Bangkok' }, 'Asia/Bangkok', new Date(), 'TH');
  assert.equal(withPhone.bookable, true, 'a phone means Num can hold the table itself');
  assert.equal(withPhone.book.mode, 'desk');
  assert.equal(withPhone.book.alt.mode, 'search', 'the guest who declines the desk still gets the link');
});

test('a hotel with a real stored ref still gets its prefilled deeplink', () => {
  const deep = bookingLink({ booking_platform: 'opentable', booking_ref: 'bestia-los-angeles' }, { party: 4 });
  assert.equal(deep.label, 'OpenTable');
  assert.match(deep.url, /opentable\.com\/r\/bestia-los-angeles/);
  assert.match(deep.url, /covers=4/);
});

test('the answer path actually calls it — the dead branch is wired', () => {
  const pd = readFileSync(new URL('./pickdetail.mjs', import.meta.url), 'utf8');
  assert.match(pd, /import \{ bookingOptions \} from '\.\/booking\.mjs'/);
  assert.match(pd, /const book = bookingOptions\(/);
  const idx = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  assert.match(idx, /enrichPicks\(resolved\.picks, grounding\?\.partners \?\? \[\], grounding\?\.place\?\.tz, new Date\(\), grounding\?\.place\?\.country \?\? null\)/,
    'the country must reach enrichPicks or every guest gets the American engine');
});
