/**
 * A HOST WHO TYPED A CITY SHOULD BE FINDABLE BY SOMEBODY STANDING IN IT.
 *
 * num_host_areas.lat and .lng were null for every host who had ever saved a
 * profile, because nothing in the save path asked the geocoder anything. The
 * city-NAME match still worked, so nobody noticed — but the COORDINATE match
 * filters on `a.lat BETWEEN ? AND ?`, and null passes no BETWEEN. It returned
 * an empty list every time, which reads exactly like "no host covers you".
 *
 * These tests pin the three decisions that make the fix safe rather than just
 * present. The function is read out of growth/worker.js and run with the
 * geocoder stubbed, because the point is the behaviour around a third party we
 * do not control.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'worker.js'), 'utf8');

const START = 'async function fillAreaCoords(env, areas) {';
const END = 'async function syncHostAreas(env, hostId, areas) {';
const body = SRC.slice(SRC.indexOf(START), SRC.indexOf(END));

/** Build the real function with our own geocoder behind it. */
function build(ready, geocode) {
  // eslint-disable-next-line no-new-func
  return new Function('geocodeReady', 'geocode', body + '\nreturn fillAreaCoords;')(ready, geocode);
}
const area = (o) => Object.assign(
  { city: 'Los Angeles', country: 'United States', lat: null, lng: null, radius_km: 50 }, o);

test('the function is still where the test thinks it is', () => {
  assert.ok(SRC.includes(START), 'fillAreaCoords has moved or been renamed');
  assert.ok(SRC.includes('await syncHostAreas(env, host.id, await fillAreaCoords(env, areas))'),
    'the profile save no longer geocodes before writing areas');
});

test('a city gets coordinates', async () => {
  const fn = build(() => true, async () => ({ ok: true, lat: 34.05, lng: -118.24, confidence: 0.9 }));
  const [a] = await fn({}, [area()]);
  assert.equal(a.lat, 34.05);
  assert.equal(a.lng, -118.24);
  assert.equal(a.city, 'Los Angeles', 'the host’s own words survive');
  assert.equal(a.radius_km, 50);
});

test('a country NAME is never passed as the country filter', async () => {
  // Geoapify compares the filter against a two-letter code. Passing
  // "United States" fails every lookup with wrong_country — worse than not
  // trying, and invisible, because the save still succeeds.
  let seen = null;
  const fn = build(() => true, async (_e, args) => { seen = args; return { ok: false, reason: 'no_match' }; });
  await fn({}, [area()]);
  assert.equal(seen.country, null, 'a country name leaked into the filter');
  assert.match(seen.text, /Los Angeles, United States/, 'the country belongs in the text');
});

test('a two-letter country code IS passed as the filter', async () => {
  let seen = null;
  const fn = build(() => true, async (_e, args) => { seen = args; return { ok: false, reason: 'no_match' }; });
  await fn({}, [area({ country: 'US' })]);
  assert.equal(seen.country, 'US');
});

test('a geocoder that is down never costs the host their save', async () => {
  const fn = build(() => true, async () => { throw new Error('upstream on fire'); });
  const [a] = await fn({}, [area()]);
  assert.equal(a.city, 'Los Angeles');
  assert.equal(a.lat, null, 'no coordinates, but the area survives');
});

test('a geocoder that refuses the answer never costs the host their save', async () => {
  const fn = build(() => true, async () => ({ ok: false, reason: 'ambiguous' }));
  const [a] = await fn({}, [area()]);
  assert.equal(a.lat, null);
  assert.equal(a.city, 'Los Angeles');
});

test('no geocoder configured is a no-op, not a failure', async () => {
  const fn = build(() => false, async () => { throw new Error('must not be called'); });
  const out = await fn({}, [area(), area({ city: 'Chino' })]);
  assert.equal(out.length, 2);
  assert.equal(out[0].lat, null);
});

test('coordinates the host already has are left alone', async () => {
  const fn = build(() => true, async () => { throw new Error('must not be called'); });
  const [a] = await fn({}, [area({ lat: 1.5, lng: 2.5 })]);
  assert.equal(a.lat, 1.5);
  assert.equal(a.lng, 2.5);
});

test('an area with no city is skipped rather than guessed at', async () => {
  const fn = build(() => true, async () => { throw new Error('must not be called'); });
  const [a] = await fn({}, [area({ city: null })]);
  assert.equal(a.lat, null);
});

test('a profile save spends at most five lookups', async () => {
  // A host editing their profile should not wait on twenty round trips.
  // The sixth city onward gets its coordinates the next time they save.
  let calls = 0;
  const fn = build(() => true, async () => { calls++; return { ok: true, lat: 1, lng: 2 }; });
  const out = await fn({}, Array.from({ length: 9 }, (_, i) => area({ city: 'City ' + i })));
  assert.equal(calls, 5);
  assert.equal(out.length, 9, 'every area is still returned');
  assert.equal(out[8].lat, null, 'the ones we did not reach keep their nulls');
});
