import test from 'node:test';
import assert from 'node:assert/strict';
import {
  viatorReady, normalise, resolve, attributed, shape, search, activitiesBlock, MIN_NAME_LEN, _resetForTests,
  wantsActivities, blockFor,
} from './viator.mjs';

const row = (o) => ({ selectable: true, lat: null, lng: null, parent: '', ...o, norm: normalise(o.name) });
const ROWS = [
  row({ id: 351, name: 'Phuket', parent: 'Thailand', type: 'REGION', lat: 7.9519, lng: 98.3381 }),
  row({ id: 4292, name: 'Phuket Town', parent: 'Phuket', type: 'CITY', lat: 7.8804, lng: 98.3923 }),
  row({ id: 343, name: 'Bangkok', parent: 'Thailand', type: 'CITY', lat: 13.7563, lng: 100.5018 }),
  row({ id: 738, name: 'Kathmandu', parent: 'Nepal', type: 'CITY', lat: 27.7172, lng: 85.324 }),
  row({ id: 5001, name: 'Kata Beach', parent: 'Phuket', type: 'CITY', lat: 7.8206, lng: 98.2977 }),
  row({ id: 5, name: 'Edinburgh', parent: 'Scotland', type: 'CITY', lat: 55.9533, lng: -3.1883 }),
  row({ id: 645, name: 'São Paulo', parent: 'Brazil', type: 'CITY', lat: -23.5505, lng: -46.6333 }),
];

test('not connected without a key', () => {
  assert.equal(viatorReady({}), false);
  assert.equal(viatorReady({ VIATOR_API_KEY: 'k' }), true);
});

test('normalise folds diacritics so two gazetteers can agree', () => {
  assert.equal(normalise('São Paulo'), 'sao paulo');
  assert.equal(normalise('  Ko Phi Phi  '), 'ko phi phi');
  assert.equal(normalise(null), '');
});

test('normalise strips the words gazetteers disagree about, symmetrically', () => {
  assert.equal(normalise('Kata Beach'), normalise('Kata'));
  assert.equal(normalise('Phuket Province'), normalise('Phuket'));
});

// THE AUGUST BUG, AS A TEST.
//
// A guest in Kata, Phuket wrote "we are in kata" and was told they were in
// Kathmandu — a beach became a country because a short name was matched
// loosely. Nothing in this module is allowed to do that again.
test('a short name is refused outright rather than fuzzily matched', () => {
  assert.equal(resolve(ROWS, 'kat', 'Thailand'), null);
  assert.ok('kat'.length < MIN_NAME_LEN);
});

test('kata does not resolve to kathmandu', () => {
  const id = resolve(ROWS, 'Kata', 'Thailand');
  assert.notEqual(id, 738, 'resolved a Phuket beach to Nepal');
  assert.equal(id, 5001, 'Kata Beach normalises to "kata" and should match exactly');
});

test('an exact match beats a prefix match', () => {
  // "Phuket" is an exact hit and also a prefix of "Phuket Town". The exact
  // one has to win, or every island query lands in the old town.
  assert.equal(resolve(ROWS, 'Phuket', 'Thailand'), 351);
});

test('among exact matches the country narrows it, then the broader type wins', () => {
  const rows = [
    { id: 9001, name: 'Springfield', parent: 'United States', type: 'CITY', norm: 'springfield' },
    { id: 9002, name: 'Springfield', parent: 'Thailand', type: 'REGION', norm: 'springfield' },
  ];
  assert.equal(resolve(rows, 'Springfield', 'Thailand'), 9002);
  assert.equal(resolve(rows, 'Springfield', 'United States'), 9001);
});

test('an unknown place resolves to nothing rather than to something nearby', () => {
  assert.equal(resolve(ROWS, 'Nowhereton', 'Thailand'), null);
});

test('attribution uses the URL Viator gave us and only adds a campaign', () => {
  const url = 'https://www.viator.com/tours/Phuket/x/d351-1234?mcid=42383&pid=P00063937&medium=api';
  const out = new URL(attributed(url));
  assert.equal(out.searchParams.get('pid'), 'P00063937', 'the partner id must survive untouched');
  assert.equal(out.searchParams.get('mcid'), '42383');
  assert.equal(out.searchParams.get('campaign'), 'num');
});

test('attribution never invents a link', () => {
  assert.equal(attributed(null), null);
  assert.equal(attributed('not a url'), null);
});

test('an existing campaign is not overwritten', () => {
  const out = attributed('https://www.viator.com/x?campaign=ig', 'num');
  assert.match(out, /campaign=ig/);
});

test('shape trims a product to what the model will actually use', () => {
  const p = shape({
    productCode: 'P1',
    title: 'Phang Nga Bay by longtail',
    description: 'x'.repeat(500),
    pricing: { summary: { fromPrice: 38.5 }, currency: 'GBP' },
    reviews: { combinedAverageRating: 4.83, totalReviews: 2100 },
    duration: { description: '8 hours' },
    productUrl: 'https://www.viator.com/t?pid=P1',
    images: [{ variants: [{ url: 'small' }, { url: 'large' }] }],
  });
  assert.equal(p.from, 38.5);
  assert.equal(p.currency, 'GBP');
  assert.equal(p.reviews, 2100);
  assert.equal(p.image, 'large', 'the last variant is the biggest');
  assert.equal(p.blurb.length, 220, 'the description must be capped');
});

test('search refuses to call out when there is no key', async () => {
  const r = await search({}, { name: 'Phuket' }, () => { throw new Error('should not fetch'); });
  assert.deepEqual(r, { ok: false, reason: 'not_connected' });
});

const fakeFetch = (taxonomy, products) => async (url, init) => {
  if (String(url).includes('taxonomy')) {
    return { ok: true, json: async () => ({ data: taxonomy }) };
  }
  const body = JSON.parse(init.body);
  return { ok: true, json: async () => ({ products, totalCount: products.length, _echo: body }) };
};

const TAXONOMY = [
  { destinationId: 351, destinationName: 'Phuket', parentDestinationName: 'Thailand', destinationType: 'REGION' },
];
const PRODUCT = {
  productCode: 'P1', title: 'Phi Phi by speedboat',
  pricing: { summary: { fromPrice: 42 }, currency: 'USD' },
  reviews: { combinedAverageRating: 4.7, totalReviews: 900 },
  productUrl: 'https://www.viator.com/t?pid=P1', images: [],
};

test('a real search resolves the destination and returns shaped products', async () => {
  _resetForTests();
  const r = await search({ VIATOR_API_KEY: 'k' }, { name: 'Phuket', country: 'Thailand' }, fakeFetch(TAXONOMY, [PRODUCT]));
  assert.equal(r.ok, true);
  assert.equal(r.destination, 351);
  assert.equal(r.products[0].title, 'Phi Phi by speedboat');
  assert.match(r.products[0].url, /campaign=num/);
});

test('an unresolvable place fails cleanly instead of searching the wrong city', async () => {
  _resetForTests();
  const r = await search({ VIATOR_API_KEY: 'k' }, { name: 'Nowhereton' }, fakeFetch(TAXONOMY, [PRODUCT]));
  assert.deepEqual(r, { ok: false, reason: 'no_destination', name: 'Nowhereton' });
});

test('count is capped so a search cannot flood the prompt', async () => {
  _resetForTests();
  let sent = null;
  const spy = async (url, init) => {
    if (String(url).includes('taxonomy')) return { ok: true, json: async () => ({ data: TAXONOMY }) };
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ products: [], totalCount: 0 }) };
  };
  await search({ VIATOR_API_KEY: 'k' }, { name: 'Phuket', count: 500 }, spy);
  assert.equal(sent.pagination.count, 12);
  assert.equal(sent.sorting.sort, 'TRAVELLER_RATING', 'a concierge leads with the best, not the cheapest');
});

test('the taxonomy is fetched once and reused within an isolate', async () => {
  _resetForTests();
  let taxonomyCalls = 0;
  const spy = async (url) => {
    if (String(url).includes('taxonomy')) {
      taxonomyCalls++;
      return { ok: true, json: async () => ({ data: TAXONOMY }) };
    }
    return { ok: true, json: async () => ({ products: [], totalCount: 0 }) };
  };
  await search({ VIATOR_API_KEY: 'k' }, { name: 'Phuket' }, spy);
  await search({ VIATOR_API_KEY: 'k' }, { name: 'Phuket' }, spy);
  assert.equal(taxonomyCalls, 1);
});

test('an upstream failure is reported, never faked', async () => {
  _resetForTests();
  const failing = async (url) => {
    if (String(url).includes('taxonomy')) return { ok: true, json: async () => ({ data: TAXONOMY }) };
    return { ok: false, status: 429 };
  };
  const r = await search({ VIATOR_API_KEY: 'k' }, { name: 'Phuket' }, failing);
  assert.deepEqual(r, { ok: false, reason: 'http_429' });
});

test('the prompt block is empty when there is nothing real to show', () => {
  assert.equal(activitiesBlock(null), '');
  assert.equal(activitiesBlock({ ok: true, products: [] }), '');
  assert.equal(activitiesBlock({ ok: false, reason: 'http_500' }), '');
});

// The whole point of the rail. Sabre taught this lesson once already: telling
// a model it can SEE something, without telling it where the permission stops,
// gets a ticket promised that nobody holds.
test('the prompt block states the price as fact AND forbids the booking', () => {
  const block = activitiesBlock({ ok: true, products: [shape(PRODUCT)] });
  assert.match(block, /state them as fact/i);
  assert.match(block, /CANNOT book/i);
  assert.match(block, /Never say booked, held or reserved/i);
  assert.match(block, /Do not invent an activity/i, 'the model must not pad the list with guesses');
  assert.match(block, /4\.7/, 'the real rating has to reach the model');
});

// ── THE GATE ─────────────────────────────────────────────────────────────
//
// This regex sits on the path between a person pressing send and seeing a
// reply. Every false positive is two network round trips added to a turn that
// did not want them, for every user. So the tests below care much more about
// what it does NOT match than about what it does.

test('the gate fires on the ways people actually ask for something to do', () => {
  for (const q of [
    'what should we do tonight',
    'things to do in phuket',
    'anything to do with kids tomorrow',
    'is there a day trip worth taking',
    'we want to go snorkelling',
    'island hopping?',
    'book us a cooking class',
    'something for the kids to do tonight 8yrs',
    'kid friendly stuff near us',
    "we're bored",
  ]) assert.ok(wantsActivities(q), `missed: ${q}`);
});

test('the gate stays out of the way of every other kind of turn', () => {
  for (const q of [
    'thanks!',
    'book me a table at 8',
    'where should we eat tonight',
    'get me a car to the airport tomorrow morning',
    'book me a massage nearby tomorrow afternoon',
    'what time is my flight',
    'hotel for the first two days in sanur',
    'can you split the bill',
    'whats my balance',
    '',
  ]) assert.equal(wantsActivities(q), false, `false positive: ${q}`);
});

test('blockFor never calls out when the gate is shut', async () => {
  const boom = () => { throw new Error('should not fetch'); };
  assert.equal(await blockFor({ VIATOR_API_KEY: 'k' }, { name: 'Phuket' }, 'thanks!', boom), '');
  assert.equal(await blockFor({ VIATOR_API_KEY: 'k' }, null, 'things to do', boom), '');
  assert.equal(await blockFor({}, { name: 'Phuket' }, 'things to do', boom), '');
});

// The property that matters most in production. Viator is a third party on the
// hot path; if it is slow, broken, rate-limited or returns nonsense, the user
// must still get their answer. An empty block is a fine outcome — Num falls
// back to what it already knows about the place.
test('a broken Viator costs a block, never a reply', async () => {
  _resetForTests();
  const throws = async () => { throw new Error('ECONNRESET'); };
  assert.equal(await blockFor({ VIATOR_API_KEY: 'k' }, { name: 'Phuket' }, 'things to do', throws), '');

  _resetForTests();
  const rateLimited = async () => ({ ok: false, status: 429 });
  assert.equal(await blockFor({ VIATOR_API_KEY: 'k' }, { name: 'Phuket' }, 'things to do', rateLimited), '');

  _resetForTests();
  const garbage = async () => ({ ok: true, json: async () => ({ nonsense: true }) });
  assert.equal(await blockFor({ VIATOR_API_KEY: 'k' }, { name: 'Phuket' }, 'things to do', garbage), '');
});

test('an unresolvable place costs a block, never a reply', async () => {
  _resetForTests();
  const ok = async (url) => {
    if (String(url).includes('taxonomy')) return { ok: true, json: async () => ({ data: TAXONOMY }) };
    return { ok: true, json: async () => ({ products: [PRODUCT], totalCount: 1 }) };
  };
  assert.equal(await blockFor({ VIATOR_API_KEY: 'k' }, { name: 'Nowhereton' }, 'things to do', ok), '');
});

test('the happy path reaches the prompt with real products in it', async () => {
  _resetForTests();
  const ok = async (url) => {
    if (String(url).includes('taxonomy')) return { ok: true, json: async () => ({ data: TAXONOMY }) };
    return { ok: true, json: async () => ({ products: [PRODUCT], totalCount: 1 }) };
  };
  const block = await blockFor({ VIATOR_API_KEY: 'k' }, { name: 'Phuket', country_code: 'TH' }, 'things to do here', ok);
  assert.match(block, /Phi Phi by speedboat/);
  assert.match(block, /CANNOT book/i);
});

// ── THE COORDINATE PATH ──────────────────────────────────────────────────
//
// The taxonomy carries latitude and longitude for every destination, and Num
// already knows where the traveller is standing. Matching "kata" as a STRING
// against a list containing "Kathmandu" is guessing. Asking which destination
// is nearest to 7.82N 98.30E is knowing. These tests exist to keep it that way.

test('coordinates decide, and they make the August bug impossible', () => {
  // A guest standing on Kata Beach. Even if the name were ambiguous, Kathmandu
  // is three thousand kilometres away and cannot win.
  const id = resolve(ROWS, { name: 'kata', lat: 7.8206, lng: 98.2977 });
  assert.equal(id, 5001);
  assert.notEqual(id, 738);
});

test('coordinates rescue a name too short for the string path', () => {
  // 'kat' is under MIN_NAME_LEN and the name path refuses it outright. With a
  // coordinate there is nothing to guess about.
  assert.equal(resolve(ROWS, { name: 'kat' }), null);
  assert.equal(resolve(ROWS, { name: 'kat', lat: 7.8206, lng: 98.2977 }), 5001);
});

test('a name match among nearby destinations beats the merely nearest', () => {
  // Standing in Phuket Town, asking about Phuket. Both are within NEAR_KM;
  // the name is what separates them.
  assert.equal(resolve(ROWS, { name: 'Phuket', lat: 7.8804, lng: 98.3923 }), 351);
});

test('coordinates in the middle of nowhere fall back rather than pick a stranger', () => {
  // Deep ocean. Nothing is within NEAR_KM, so the name path takes over — and
  // must still answer correctly rather than returning the nearest continent.
  assert.equal(resolve(ROWS, { name: 'Edinburgh', lat: 0, lng: -30 }), 5);
  assert.equal(resolve(ROWS, { name: 'Nowhereton', lat: 0, lng: -30 }), null);
});

test('an unselectable destination is never returned — Viator would reject it', () => {
  const rows = [
    row({ id: 900, name: 'Phuket', type: 'REGION', lat: 7.9519, lng: 98.3381, selectable: false }),
    row({ id: 901, name: 'Phuket Town', type: 'CITY', lat: 7.8804, lng: 98.3923 }),
  ];
  assert.equal(resolve(rows, { name: 'Phuket', lat: 7.9, lng: 98.33 }), 901);
});

test('a taxonomy with no selectable rows at all still answers', () => {
  const rows = [row({ id: 900, name: 'Phuket', type: 'REGION', lat: 7.95, lng: 98.33, selectable: false })];
  assert.equal(resolve(rows, { name: 'Phuket', lat: 7.95, lng: 98.33 }), 900);
});

test('resolve still accepts a bare name string, as it used to', () => {
  assert.equal(resolve(ROWS, 'Bangkok', 'Thailand'), 343);
});

// The taxonomy gives parentId, not a parent name. The first version of this
// module assumed a name, so the country tiebreak never fired once.
test('parent names are resolved from parentId so the country tiebreak works', async () => {
  _resetForTests();
  const taxonomy = [
    { destinationId: 1, destinationName: 'Thailand', destinationType: 'COUNTRY', latitude: 15.87, longitude: 100.99 },
    { destinationId: 2, destinationName: 'Springfield', parentId: 1, destinationType: 'CITY', latitude: 15, longitude: 101 },
    { destinationId: 3, destinationName: 'Springfield', parentId: 4, destinationType: 'CITY', latitude: 39.8, longitude: -89.6 },
    { destinationId: 4, destinationName: 'United States', destinationType: 'COUNTRY', latitude: 39, longitude: -98 },
  ];
  let seen = null;
  const spy = async (url, init) => {
    if (String(url).includes('taxonomy')) return { ok: true, json: async () => ({ data: taxonomy }) };
    seen = JSON.parse(init.body);
    return { ok: true, json: async () => ({ products: [], totalCount: 0 }) };
  };
  await search({ VIATOR_API_KEY: 'k' }, { name: 'Springfield', country: 'Thailand' }, spy);
  assert.equal(seen.filtering.destination, '2', 'the country tiebreak did not fire — parentId was not resolved to a name');
});

test('shape reads both documented pricing and duration forms', () => {
  const flat = shape({
    productCode: 'A', title: 't', productUrl: 'https://viator.com/a?pid=1',
    pricing: { fromPrice: 19, currency: 'USD' }, duration: 90,
  });
  assert.equal(flat.from, 19);
  assert.equal(flat.currency, 'USD');
  assert.equal(flat.duration, '1.5h', 'minutes should read as hours once past an hour');

  const nested = shape({
    productCode: 'B', title: 't', productUrl: 'https://viator.com/b?pid=1',
    pricing: { summary: { fromPrice: 42 }, currency: 'GBP' },
    duration: { fixedDurationInMinutes: 45 },
  });
  assert.equal(nested.from, 42);
  assert.equal(nested.duration, '45m');
});
