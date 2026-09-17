import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meterFare, hasTariff, TARIFFS } from './fares.mjs';

test('Bangkok flag fall covers the first kilometre', () => {
  assert.equal(meterFare('bangkok', 0.5).fare, 35);
  assert.equal(meterFare('bangkok', 1).fare, 35);
});

test('Bangkok bands add up the way the published table says', () => {
  // 35 + 9 km x 6.50 = 93.5
  assert.equal(meterFare('bangkok', 10).fare, 94);
  // + 10 km x 7.00 = 163.5
  assert.equal(meterFare('bangkok', 20).fare, 164);
  // Suvarnabhumi to Sukhumvit is about 30 km: 163.5 + 10 x 8 = 243.5, +50 at the counter
  const r = meterFare('bangkok', 30, { fromAirport: true });
  assert.equal(r.fare, 294);
  assert.ok(r.low <= r.fare + 5 && r.high > r.low);
});

test('Phuket: 50 for 2 km, 12/km to 15, 10/km beyond, +100 at the airport', () => {
  assert.equal(meterFare('phuket', 2).fare, 50);
  assert.equal(meterFare('phuket', 15).fare, 50 + 13 * 12);
  assert.equal(meterFare('Phuket', 40, { fromAirport: true }).fare, 50 + 13 * 12 + 25 * 10 + 100);
});

test('every result carries caveats, and Phuket admits it is not what drivers charge', () => {
  for (const k of Object.keys(TARIFFS)) assert.ok(meterFare(k, 5).caveats.length >= 2);
  assert.match(meterFare('phuket', 5).caveats.join(' '), /fixed fare/i);
  assert.equal(meterFare('phuket', 5).verified, false, 'no primary Phuket source was found; do not claim one');
});

test('no tariff, no number', () => {
  assert.equal(meterFare('edinburgh', 5), null);
  assert.equal(meterFare('bangkok', -1), null);
  assert.equal(meterFare('bangkok', 'far'), null);
  assert.equal(hasTariff('chiang mai'), false);
});
