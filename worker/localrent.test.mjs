import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COVERAGE, COUNTRY_SLUG, MARKER_PARAM, localrentReady, citySlug, locate, isoDate, carLink, carBlock,
} from './localrent.mjs';

const ENV = { LOCALRENT_MARKER: '12345' };

test('not ready without a marker — an unattributed link earns nothing', () => {
  assert.equal(localrentReady({}), false);
  assert.equal(carLink({}, { country_code: 'TH', name: 'Phuket' }), null);
});

test('the coverage map matches their sitemap', () => {
  assert.equal(Object.keys(COVERAGE).length, 37);
  assert.deepEqual(COVERAGE.thailand, ['bangkok', 'chiang-rai', 'chiangmai', 'krabi', 'pattaya', 'phuket', 'samui', 'surat-thani']);
  // Filter pages, not cities. If one of these slips into the map, Num will
  // eventually hand somebody a link to "cars without a credit card in Turkey"
  // when they asked for Istanbul.
  for (const cities of Object.values(COVERAGE)) {
    for (const c of cities) assert.ok(!/^without-/.test(c), `${c} is a filter page, not a city`);
  }
});

// THE FINDING THAT MATTERS MOST ABOUT THIS RAIL.
//
// Num's traffic is Phuket, Bangkok, Los Angeles and Edinburgh. Localrent
// serves the first two and does not exist in the other two. A link for a
// traveller in Santa Monica would be a dead end with our marker on it, which
// is worse than no link at all.
test('countries Localrent does not serve produce NO link, ever', () => {
  for (const code of ['US', 'GB', 'ID', 'JP', 'AU', 'CA', 'IN', 'BR', 'SG', 'PH']) {
    assert.equal(COUNTRY_SLUG[code], undefined, `${code} must not be in the slug map`);
    assert.equal(carLink(ENV, { country_code: code, name: 'Anywhere' }), null, `${code} produced a link`);
  }
});

test('a covered place produces a real, attributed URL', () => {
  const u = new URL(carLink(ENV, { country_code: 'TH', name: 'Phuket' }));
  assert.equal(u.origin + u.pathname, 'https://www.localrent.com/en/thailand/phuket/');
  assert.equal(u.searchParams.get(MARKER_PARAM), '12345');
});

test('the marker parameter is pinned, so a rename cannot silently stop paying', () => {
  assert.equal(MARKER_PARAM, 'marker');
});

test('filters ride as the parameters their white-label panel documents', () => {
  const u = new URL(carLink(ENV, { country_code: 'TH', name: 'Phuket' }, {
    from: '2026-09-04', to: '2026-09-11', automatic: true, suv: true, delivery: true,
  }));
  assert.equal(u.searchParams.get('date_from'), '2026-09-04');
  assert.equal(u.searchParams.get('date_to'), '2026-09-11');
  assert.equal(u.searchParams.get('gearbox[0]'), 'automatic');
  assert.equal(u.searchParams.get('multi_tabs[0]'), 'suv');
  assert.equal(u.searchParams.get('city_delivery'), 'true');
});

test('no filters means no parameters — a bare search is a clean search', () => {
  const u = new URL(carLink(ENV, { country_code: 'TH', name: 'Bangkok' }));
  assert.equal(u.searchParams.get('gearbox[0]'), null);
  assert.equal(u.searchParams.get('date_from'), null);
  assert.equal([...u.searchParams.keys()].length, 1, 'only the marker should be there');
});

// Kata and Patong are not Localrent pages. Phuket is. Falling back to the
// parent is what makes the rail work for the way people actually describe
// where they are.
test('a beach falls back to the island it sits on', () => {
  assert.deepEqual(locate({ country_code: 'TH', name: 'Kata Beach', city: 'Phuket' }), { country: 'thailand', city: 'phuket' });
  assert.deepEqual(locate({ country_code: 'TH', name: 'Patong', region: 'Phuket' }), { country: 'thailand', city: 'phuket' });
});

// Their sitemap is a SUBSET of their real pages: /en/thailand/surat-thani/ is
// absent from it and serves a proper page anyway, while a nonsense slug 404s.
// So an unlisted town must not be guessed at (sometimes a 404 carrying our
// marker) nor refused (throwing away a country we cover) — it degrades to the
// country page, which always exists.
test('a covered country with an unlisted city falls back to the country page', () => {
  assert.deepEqual(locate({ country_code: 'TH', name: 'Nakhon Nowhere' }), { country: 'thailand', city: null });
  const u = new URL(carLink(ENV, { country_code: 'TH', name: 'Nakhon Nowhere' }));
  assert.equal(u.origin + u.pathname, 'https://www.localrent.com/en/thailand/');
  assert.equal(u.searchParams.get(MARKER_PARAM), '12345', 'the fallback still has to be attributed');
});

test('Surat Thani resolves to its own page — the ferry problem needs it', () => {
  // The mainland side of Koh Phangan: where somebody who cannot take a hire
  // car on the boat actually picks one up.
  assert.deepEqual(locate({ country_code: 'TH', name: 'Surat Thani' }), { country: 'thailand', city: 'surat-thani' });
});

test('city slugs survive the spellings people actually use', () => {
  assert.equal(citySlug('Chiang Mai'), 'chiangmai');
  assert.equal(citySlug('Koh Samui'), 'samui');
  assert.equal(citySlug('Barcelona'), 'barselona', 'their own slug is barselona, not barcelona');
  assert.equal(citySlug('Thessaloniki'), 'salonica');
  assert.equal(citySlug('Málaga'), 'malaga');
  assert.equal(citySlug(''), null);
});

test('those aliases actually exist in the coverage map', () => {
  for (const [country, name] of [['thailand', 'Chiang Mai'], ['thailand', 'Koh Samui'], ['spain', 'Barcelona'], ['greece', 'Thessaloniki']]) {
    assert.ok(COVERAGE[country].includes(citySlug(name)), `${name} → ${citySlug(name)} is not a real page`);
  }
});

test('dates are normalised, and a bad one is dropped rather than passed on', () => {
  assert.equal(isoDate('2026-09-04'), '2026-09-04');
  assert.equal(isoDate(new Date(Date.UTC(2026, 8, 4))), '2026-09-04');
  assert.equal(isoDate('not a date'), null);
  assert.equal(isoDate(null), null);
  const u = new URL(carLink(ENV, { country_code: 'TH', name: 'Phuket' }, { from: 'nonsense' }));
  assert.equal(u.searchParams.get('date_from'), null);
});

test('the country name works when no ISO code came through', () => {
  assert.deepEqual(locate({ country: 'Thailand', name: 'Krabi' }), { country: 'thailand', city: 'krabi' });
});

// This rail has no prices and no availability. A block that implied otherwise
// would produce invented daily rates — the exact failure the services layer
// exists to prevent.
test('the prompt block forbids quoting a rate it cannot see', () => {
  const url = carLink(ENV, { country_code: 'TH', name: 'Phuket' });
  const block = carBlock(url, { name: 'Phuket' });
  assert.match(block, /CANNOT see prices/i);
  assert.match(block, /cannot book it/i);
  assert.match(block, /Never quote a daily rate/i);
  assert.match(block, /automatic/i, 'the manual-gearbox trap is the single most useful thing to say here');
  assert.ok(block.includes(url));
});

test('no link means no block', () => {
  assert.equal(carBlock(null, { name: 'Los Angeles' }), '');
});

// ── THE INTENT GATE (mirrors WANTS_CAR in index.mjs) ─────────────────────
//
// Renting a car and ordering one with a driver are different requests, and
// conflating them is how somebody asking for a lift to the airport gets handed
// a week-long hire. The ride specialist owns "a car to the airport"; this rail
// owns "hire a car".
const WANTS_CAR = /\b(rent(?:al|ing)?|hire|hiring)\s+(?:a\s+|an\s+)?(?:car|suv|4.?wd|jeep|van|vehicle|scooter|bike|motorbike)\b|\b(?:car|suv|4.?wd|jeep|van)\s+(?:rental|hire)\b|\bself.?drive\b|\b(?:4.?wd|4x4|jeep)\b/i;

test('the gate catches renting', () => {
  for (const q of [
    'can we rent a car for the week',
    'hire a car in phuket',
    'we need a 4wd',
    'rent a scooter',
    'car rental near the airport',
    'suv hire please',
    'is self drive an option',
    'renting a van for six of us',
  ]) assert.ok(WANTS_CAR.test(q), `missed: ${q}`);
});

test('the gate leaves the ride specialist alone', () => {
  for (const q of [
    'get me a car to the airport tomorrow morning',
    'hi find a car to the airport lax right now',
    'a car at 6',
    'book a taxi',
    'can you get us a driver for the day',
    'what should we do tonight',
    'thanks',
  ]) assert.equal(WANTS_CAR.test(q), false, `false positive: ${q}`);
});
