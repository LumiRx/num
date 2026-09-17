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

import { faresBlock, wantsFares } from './fares.mjs';

/* The block is as much about what it REFUSES to say as what it says. A tariff
   is checkable; a total for a trip whose distance nobody measured is not. */

test('it fires on a taxi ask and stays quiet otherwise', () => {
  for (const q of ['how much is a taxi to the airport?', 'what should a cab cost', 'is the tuk tuk price a rip-off', 'taxi fare from town']) {
    assert.ok(wantsFares(q), q);
  }
  for (const q of ['dinner for two tonight', 'a massage near me', 'book me a table']) {
    assert.equal(wantsFares(q), false, q);
  }
});

test('a taxi ask in a city we hold a tariff for renders the published rates', () => {
  const b = faresBlock({ place: { slug: 'bangkok' }, text: 'how much is a taxi to the airport?' });
  assert.match(b, /OFFICIAL METERED TAXI FARE — Bangkok/);
  assert.match(b, /first 1 km: 35 THB/);
  assert.match(b, /1–10 km: 6\.5 THB\/km/);
  assert.match(b, /beyond 80 km/);
  assert.match(b, /from the airport: \+50 THB/);
  assert.match(b, /suvarnabhumi\.airportthai\.co\.th/);
});

test('it tells the model to quote rates, never a total it cannot know', () => {
  const b = faresBlock({ place: { slug: 'phuket' }, text: 'taxi price to Patong?' });
  assert.match(b, /Quote the rates, not a total/);
  assert.match(b, /Never invent a distance/);
  assert.match(b, /show the arithmetic/);
});

test('an unverified tariff says so, in the block, where the model will read it', () => {
  const b = faresBlock({ place: { slug: 'phuket' }, text: 'what does a taxi cost' });
  assert.match(b, /could not be confirmed against a primary government source/);
  assert.doesNotMatch(
    faresBlock({ place: { slug: 'bangkok' }, text: 'what does a taxi cost' }),
    /could not be confirmed/,
    'Bangkok has a primary source and must not carry the caveat',
  );
});

test('no tariff and no ask both produce nothing at all', () => {
  assert.equal(faresBlock({ place: { slug: 'edinburgh' }, text: 'how much is a taxi?' }), null);
  assert.equal(faresBlock({ place: { slug: 'bangkok' }, text: 'where should I eat?' }), null);
  assert.equal(faresBlock({ place: null, text: 'how much is a taxi?' }), null);
  assert.equal(faresBlock(), null);
});
