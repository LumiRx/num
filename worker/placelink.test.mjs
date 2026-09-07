import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { placeLink, mapsUrl, cleanUrl, telLink, placeContact, linkable } from './placelink.mjs';

const KATA = { id: 'p1', name: 'Baan Rim Pa', lat: 7.8942, lng: 98.2931, address: '223 Prabaramee Rd', phone: '+66 76 340 789' };

describe('a link is derived, never invented', () => {
  test('the venue’s own website wins when we have one', () => {
    assert.deepEqual(placeLink({ ...KATA, website: 'baanrimpa.com' }), { url: 'https://baanrimpa.com/', kind: 'website' });
  });
  test('a site we FETCHED and found dead is not sent to a guest — the map is', () => {
    const l = placeLink({ ...KATA, website: 'gone.example', alive: 0 });
    assert.equal(l.kind, 'map');
    assert.match(l.url, /7\.8942%2C98\.2931/);
  });
  test('alive null (never checked) is not evidence of death', () => {
    assert.equal(placeLink({ ...KATA, website: 'baanrimpa.com', alive: null }).kind, 'website');
  });
  test('no website → a map from the coordinates, which cannot be ambiguous', () => {
    const l = placeLink(KATA);
    assert.equal(l.kind, 'map');
    assert.match(l.url, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
    assert.match(l.url, /7\.8942%2C98\.2931/);
  });
  test('no coordinates → name and address, never a bare name', () => {
    const l = placeLink({ name: 'Blue Elephant', address: '96 Krabi Rd, Phuket' });
    assert.match(decodeURIComponent(l.url), /Blue Elephant, 96 Krabi Rd, Phuket/);
  });
  test('0,0 is not a location — it is a missing one', () => {
    assert.equal(mapsUrl({ name: 'X', lat: 0, lng: 0 }), null);
  });
  test('a row with nothing at all is honestly unlinkable', () => {
    assert.equal(placeLink({ name: 'Nowhere' }), null);
    assert.equal(linkable({ name: 'Nowhere' }), false);
    assert.equal(linkable(KATA), true);
  });
});

describe('cleanUrl refuses what a 2.6M-row open-data directory contains', () => {
  test('bare domains are upgraded to https', () => assert.equal(cleanUrl('example.com'), 'https://example.com/'));
  test('javascript: and data: are never links', () => {
    assert.equal(cleanUrl('javascript:alert(1)'), null);
    assert.equal(cleanUrl('data:text/html,<script>'), null);
  });
  test('a hostname with no dot is not a site', () => assert.equal(cleanUrl('localhost'), null));
  test('empty and junk', () => {
    assert.equal(cleanUrl(''), null);
    assert.equal(cleanUrl(null), null);
    assert.equal(cleanUrl('   '), null);
  });
});

describe('telLink', () => {
  test('a verified number becomes tappable, spacing and all', () => {
    assert.equal(telLink('+66 76 340 789'), 'tel:+6676340789');
  });
  test('too short to be a phone number', () => {
    assert.equal(telLink('123'), null);
    assert.equal(telLink(''), null);
  });
});

describe('placeContact is the whole verified row, flattened for the screen', () => {
  test('carries link, map, tel and address together', () => {
    const c = placeContact({ ...KATA, website: 'baanrimpa.com', open_now: true, booking_platform: 'opentable', booking_ref: 'r/x' });
    assert.equal(c.link_kind, 'website');
    assert.equal(c.tel, 'tel:+6676340789');
    assert.equal(c.address, '223 Prabaramee Rd');
    assert.equal(c.open_now, true);
    assert.equal(c.bookable, true);
    assert.match(c.map, /maps/);   // a map is ALWAYS offered, even when the website is the primary link
  });
  test('an unknown open state stays null, never false', () => {
    assert.equal(placeContact(KATA).open_now, null);
  });
  test('not bookable unless BOTH platform and ref are present', () => {
    assert.equal(placeContact({ ...KATA, booking_platform: 'opentable' }).bookable, false);
  });
});

import { resolvePicks } from './placelink.mjs';

const PARTNERS = [
  { id: 'p1', name: 'Baan Rim Pa', name_local: 'บ้านริมป่า', category: 'restaurant', area: 'Kalim', km: 1.2, rating: 4.5, lat: 7.8942, lng: 98.2931, address: '223 Prabaramee Rd', phone: '+66 76 340 789', website: 'baanrimpa.com' },
  { id: 'p2', name: 'Suay Restaurant', category: 'restaurant', lat: 7.88, lng: 98.39, address: '50/2 Takuapa Rd', open_now: true },
  { id: 'p3', name: 'No Location Cafe', category: 'cafe' },
];

describe('resolvePicks — the link comes from the row, or the pick does not ship', () => {
  test('matches by id and attaches the verified link, phone and address', () => {
    const { picks } = resolvePicks([{ id: 'p1', name: 'Baan Rim Pa', why: 'Cliffside tables over the water' }], PARTNERS);
    assert.equal(picks.length, 1);
    assert.equal(picks[0].link, 'https://baanrimpa.com/');
    assert.equal(picks[0].link_kind, 'website');
    assert.equal(picks[0].tel, 'tel:+6676340789');
    assert.equal(picks[0].why, 'Cliffside tables over the water');
    assert.equal(picks[0].name_local, 'บ้านริมป่า');
  });
  test('matches by name when the model omits the id', () => {
    const { picks } = resolvePicks([{ name: 'suay restaurant', why: 'x' }], PARTNERS);
    assert.equal(picks[0].id, 'p2');
    assert.equal(picks[0].link_kind, 'map');
    assert.equal(picks[0].open_now, true);
  });
  test('a place with no verified row is DROPPED, never shown as a bare name', () => {
    const { picks, dropped } = resolvePicks([{ name: 'Somewhere I Invented', why: 'x' }], PARTNERS);
    assert.deepEqual(picks, []);
    assert.deepEqual(dropped, ['Somewhere I Invented']);
  });
  test('a verified row we cannot point at is also dropped — a name is not a recommendation', () => {
    const { picks, dropped } = resolvePicks([{ id: 'p3', name: 'No Location Cafe', why: 'x' }], PARTNERS);
    assert.deepEqual(picks, []);
    assert.deepEqual(dropped, ['No Location Cafe']);
  });
  test('the directory’s name wins over the model’s', () => {
    const { picks } = resolvePicks([{ id: 'p1', name: 'baan rim pa restaurant', why: 'x' }], PARTNERS);
    assert.equal(picks[0].name, 'Baan Rim Pa');
  });
  test('the same place named twice appears once', () => {
    const { picks } = resolvePicks([{ id: 'p1', name: 'Baan Rim Pa', why: 'a' }, { name: 'Baan Rim Pa', why: 'b' }], PARTNERS);
    assert.equal(picks.length, 1);
  });
  test('empty, null and junk are safe', () => {
    assert.deepEqual(resolvePicks(null, PARTNERS).picks, []);
    assert.deepEqual(resolvePicks([], PARTNERS).picks, []);
    assert.deepEqual(resolvePicks([{ why: 'no name' }], PARTNERS).picks, []);
    assert.deepEqual(resolvePicks([{ name: 'x' }], []).picks, []);
  });
  test('a why longer than a sentence is clipped, not dropped', () => {
    const { picks } = resolvePicks([{ id: 'p1', name: 'Baan Rim Pa', why: 'y'.repeat(500) }], PARTNERS);
    assert.equal(picks[0].why.length, 160);
  });
});
