import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDestination, airport, airportsIn, countryName, countriesWithAirports, destinationWords } from './esimplaces.mjs';

test('airport codes', () => {
  const r = resolveDestination('ESIM BKK');
  assert.equal(r.kind, 'airport');
  assert.equal(r.country, 'TH');
  assert.equal(r.airport[0], 'BKK');
  assert.equal(resolveDestination('esim lax').country, 'US');
  assert.equal(resolveDestination('esim edi').country, 'GB');
});

test('country names, any case, with filler', () => {
  assert.equal(resolveDestination('ESIM THAILAND').country, 'TH');
  assert.equal(resolveDestination('esim for thailand please').country, 'TH');
  assert.equal(resolveDestination('Need an eSIM for Japan next week').country, 'JP');
  assert.equal(resolveDestination('e-sim united kingdom').country, 'GB');
});

test('what people actually type: UK, USA, UAE, Bali, Samui', () => {
  assert.equal(resolveDestination('esim uk').country, 'GB');
  assert.equal(resolveDestination('ESIM USA').country, 'US');
  assert.equal(resolveDestination('esim uae').country, 'AE');
  assert.equal(resolveDestination('esim bali').country, 'ID');
  assert.equal(resolveDestination('esim koh samui').country, 'TH');
  assert.equal(resolveDestination('esim dubai').country, 'AE');
});

test('USA and UAE are countries, never airport codes', () => {
  assert.equal(resolveDestination('ESIM USA').kind, 'country');
  assert.equal(resolveDestination('ESIM UAE').kind, 'country');
});

test('two-letter codes only in capitals', () => {
  assert.equal(resolveDestination('ESIM IT').country, 'IT');
  assert.equal(resolveDestination('esim it').kind, 'none');
  assert.equal(resolveDestination('esim in').kind, 'none');
});

test('regions', () => {
  assert.deepEqual(resolveDestination('esim europe'), { kind: 'region', region: 'EU', label: 'Europe' });
  assert.equal(resolveDestination('ESIM worldwide').region, 'WORLD');
});

test('cities with an airport, only when the country is unambiguous', () => {
  const r = resolveDestination('esim chiang mai');
  assert.equal(r.country, 'TH');
  const v = resolveDestination('esim victoria');
  assert.ok(v.kind === 'ambiguous' || v.kind === 'airport');
});

test('nothing usable means ask, not guess', () => {
  assert.equal(resolveDestination('ESIM').kind, 'none');
  assert.equal(resolveDestination('esim please').kind, 'none');
  assert.equal(resolveDestination('esim zzzzqq').kind, 'none');
});

test('lookups', () => {
  assert.equal(airport('bkk')[1], 'Suvarnabhumi Airport');
  assert.equal(airport('zzz'), null);
  assert.equal(countryName('th'), 'Thailand');
  const th = airportsIn('TH');
  assert.ok(th.length >= 10);
  assert.equal(th[0][4], 'L', 'biggest first');
  assert.ok(countriesWithAirports().length > 200);
});

test('keyword and filler are stripped', () => {
  assert.deepEqual(destinationWords('ESIM to Koh Samui pls'), ['koh', 'samui']);
  assert.deepEqual(destinationWords('e sim japan'), ['japan']);
});
