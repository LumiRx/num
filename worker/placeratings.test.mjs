import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameVenue, cellOf, enrichCell, searchMaps, QUERY_FOR } from './placeratings.mjs';
import { wantsDelivery, servicesBlock } from './services.mjs';

test('the same venue is recognised across spelling and a short distance', () => {
  const ours = { name: 'Thai Aree Food', lat: 13.7563, lng: 100.5018 };
  assert.ok(sameVenue(ours, { name: 'Thai Aree Food Restaurant', lat: 13.7565, lng: 100.5020 }));
  assert.ok(sameVenue(ours, { name: 'thai aree food', lat: 13.7590, lng: 100.5018 }), 'same name within 400 m');
  assert.ok(!sameVenue(ours, { name: 'Aree Noodles', lat: 13.7563, lng: 100.5018 }), 'different place, same street');
  assert.ok(!sameVenue(ours, { name: 'Thai Aree Food', lat: 13.80, lng: 100.50 }), 'same name across town is a chain, not a match');
  assert.equal(cellOf(13.7563, 100.5018), '1376_10050');
  assert.equal(QUERY_FOR.spa, 'massage spa');
});

test('one search per cell per category; ratings land on our rows; nothing is created', async () => {
  const runs = new Map(); const updates = [];
  const db = {
    prepare(sql) {
      const s = { args: [], bind(...a) { s.args = a; return s; } };
      s.run = async () => {
        if (/INSERT OR REPLACE INTO num_rating_runs/.test(sql)) runs.set(`${s.args[0]}|${s.args[1]}`, { ts: s.args[2] });
        if (/UPDATE places SET rating/.test(sql)) updates.push(s.args);
        return {};
      };
      s.first = async () => (/FROM num_rating_runs/.test(sql) ? runs.get(`${s.args[0]}|${s.args[1]}`) ?? null : null);
      s.all = async () => ({ results: [{ id: 'p1', name: 'Thai Aree Food', lat: 13.7563, lng: 100.5018 }, { id: 'p2', name: 'Blue Elephant', lat: 13.7570, lng: 100.5030 }] });
      return s;
    },
  };
  let calls = 0;
  // Google Places API (New) searchText shape — moved off SerpAPI 21 Sep 2026
  // after 440 straight refusals. scripts/enrich_ratings.mjs has read this
  // same endpoint since 11 August; now there is one key and one road.
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ places: [
    { displayName: { text: 'Thai Aree Food' }, rating: 4.6, userRatingCount: 812, location: { latitude: 13.7564, longitude: 100.5019 } },
    { displayName: { text: 'Somewhere New' }, rating: 4.9, userRatingCount: 50, location: { latitude: 13.7566, longitude: 100.5021 } },
  ] }) }; };
  const env = { DB: db, GOOGLE_PLACES_API_KEY: 'k' };
  const first = await enrichCell(env, { lat: 13.7563, lng: 100.5018, cat: 'restaurant', fetchImpl });
  assert.deepEqual(first, { found: 2, matched: 1 });
  assert.equal(updates[0][4], 'p1'); assert.equal(updates[0][0], 4.6);
  const second = await enrichCell(env, { lat: 13.7563, lng: 100.5018, cat: 'restaurant', fetchImpl });
  assert.deepEqual(second, { skipped: 'fresh' });
  assert.equal(calls, 1, 'the second ask in the same cell costs nothing');
});

test('delivery apps are listed only when the ask is about delivery', () => {
  assert.equal(wantsDelivery('where should we eat tonight'), false);
  assert.equal(wantsDelivery('order me dinner to the hotel'), true);
  assert.equal(wantsDelivery('can someone deliver pad thai to room 1204'), true);
  const place = { name: 'Los Angeles', country_code: 'US' };
  assert.doesNotMatch(servicesBlock(place, {}, { ask: 'a good new restaurant near me' }), /DoorDash|delivery:/);
  assert.match(servicesBlock(place, {}, { ask: 'order food to the room' }), /DoorDash/);
  assert.match(servicesBlock(place, {}), /DoorDash/, 'no ask given: unchanged behaviour');
});

/* ── GOOGLE DIRECTLY, NOT A RESELLER (21 Sep 2026) ───────────────────────
 *
 * Dre: "we aren't using SerpAPI right now, use Google Maps."
 *
 * SerpAPI was a scraper sitting in front of Google Maps, and it had refused
 * 440 searches since 18 September — every one a 429, plan spent. Three days
 * with no rating written anywhere, while ai/places.js fell back to distance
 * and whether a row happens to carry a phone number.
 *
 * scripts/enrich_ratings.mjs had been reading Google's own Places API since
 * 11 August on GOOGLE_PLACES_API_KEY. Two roads to the same data, one dead,
 * two keys to keep alive. Now there is one of each.
 */

test('it calls Google’s own endpoint, with the key Google issued', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, json: async () => ({ places: [] }) };
  };
  await searchMaps({ GOOGLE_PLACES_API_KEY: 'k' }, { lat: 13.75, lng: 100.5, q: 'restaurants', fetchImpl });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://places.googleapis.com/v1/places:searchText');
  assert.doesNotMatch(seen[0].url, /serpapi/i, 'still going through a reseller');
  assert.equal(seen[0].init.headers['X-Goog-Api-Key'], 'k');
  assert.equal(seen[0].init.method, 'POST');
});

test('the field mask asks for four fields and no more', async () => {
  // Places API charges by the fields requested. `priceLevel` and
  // `primaryType` came back free from SerpAPI, were assigned to a variable
  // here, and were read by nothing — asking Google for them would move every
  // call to a dearer SKU to populate two fields we throw away.
  let mask = null;
  const fetchImpl = async (_url, init) => {
    mask = init.headers['X-Goog-FieldMask'];
    return { ok: true, json: async () => ({ places: [] }) };
  };
  await searchMaps({ GOOGLE_PLACES_API_KEY: 'k' }, { lat: 1, lng: 1, q: 'bars', fetchImpl });
  assert.equal(mask, 'places.displayName,places.rating,places.userRatingCount,places.location');
  assert.doesNotMatch(mask, /priceLevel|primaryType/, 'paying for fields nothing reads');
});

test('no key, no call — and no throw', async () => {
  let called = false;
  const out = await searchMaps({}, { lat: 1, lng: 1, q: 'bars', fetchImpl: async () => { called = true; } });
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test('a refusal keeps its status in the message, because the ledger reads it', async () => {
  // 429 is a spent quota and 401/403 a bad key. Those two are what open a
  // ledger row; everything else is weather. If the status stops appearing in
  // the message, the refusal stops reaching anybody.
  const fetchImpl = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(
    () => searchMaps({ GOOGLE_PLACES_API_KEY: 'k' }, { lat: 1, lng: 1, q: 'bars', fetchImpl }),
    /\b429\b/,
  );
});

test('a result with no rating is dropped rather than stored as zero', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ places: [
    { displayName: { text: 'Rated' }, rating: 4.2, userRatingCount: 10, location: { latitude: 1, longitude: 1 } },
    { displayName: { text: 'Unrated' }, userRatingCount: 0, location: { latitude: 1, longitude: 1 } },
    { displayName: { text: 'Nowhere' }, rating: 5, userRatingCount: 3 },
  ] }) });
  const out = await searchMaps({ GOOGLE_PLACES_API_KEY: 'k' }, { lat: 1, lng: 1, q: 'bars', fetchImpl });
  assert.deepEqual(out.map((r) => r.name), ['Rated']);
  assert.equal(out[0].reviews, 10);
});
