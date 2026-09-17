import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameVenue, cellOf, enrichCell, QUERY_FOR } from './placeratings.mjs';
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
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ local_results: [
    { title: 'Thai Aree Food', rating: 4.6, reviews: 812, gps_coordinates: { latitude: 13.7564, longitude: 100.5019 } },
    { title: 'Somewhere New', rating: 4.9, reviews: 50, gps_coordinates: { latitude: 13.7566, longitude: 100.5021 } },
  ] }) }; };
  const env = { DB: db, SERPAPI_KEY: 'k' };
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
