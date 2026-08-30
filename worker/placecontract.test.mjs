// The contract between grounding.mjs and every partner rail.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
//
// Viator, Localrent, Ticketmaster and Bounce all shipped with their own tests
// passing — 1,761 of them — and three of the four could not fire in
// production. Not because the rails were wrong: because `groundRequest`
// returned a `place` with no `lat`, no `lng` and no `country_code`, and every
// rail degraded silently rather than failing.
//
// That is the worst shape a bug can have. Ticketmaster returned
// 'no_coordinates' and swallowed it. Viator and Localrent fell back to
// matching place NAMES — the exact guesswork the coordinate path was written
// to replace — so they produced plausible output while quietly being wrong.
// A unit test of each rail cannot see this, because each rail was handed a
// hand-built place object with the fields it wanted.
//
// So this file asserts the SHAPE grounding actually publishes, and then drives
// the real rails with it. If someone drops a field from that object again,
// this fails loudly instead of three integrations going quiet.
//
// PLACE below is copied field-for-field from the object literal in
// groundRequest. Changing one and not the other is the thing being tested.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { locate as localrentLocate, carLink } from './localrent.mjs';
import { search as tmSearch } from './events.tm.mjs';
import { resolve as viatorResolve, normalise } from './viator.mjs';
import { luggageLink } from './luggage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Exactly what groundRequest returns for a guest sitting in Phuket. */
const PLACE = Object.freeze({
  name: 'Phuket',
  slug: 'phuket',
  country: 'TH',
  country_code: 'TH',
  lat: 7.953,
  lng: 98.338,
  tz: 'Asia/Bangkok',
  label: 'Kata, Phuket',
  precise: true,
  inferred: false,
});

const EDINBURGH = Object.freeze({ ...PLACE, name: 'Edinburgh', slug: 'edinburgh', country: 'GB', country_code: 'GB', lat: 55.9533, lng: -3.1883, tz: 'Europe/London', label: 'Edinburgh' });

test('grounding still publishes every field the rails read', () => {
  const src = readFileSync(join(HERE, 'grounding.mjs'), 'utf8');
  for (const field of ['name:', 'slug:', 'country:', 'country_code:', 'lat:', 'lng:']) {
    assert.ok(src.includes(field), `grounding.mjs no longer sets ${field} — a rail is about to go quiet`);
  }
});

test('country_code is an ISO code, and country holds the same thing', () => {
  // The field has always been a code despite its name. Rails must not read
  // `country` expecting "Thailand".
  assert.match(PLACE.country_code, /^[A-Z]{2}$/);
  assert.equal(PLACE.country, PLACE.country_code);
});

// ── EACH RAIL, DRIVEN BY THE REAL OBJECT ─────────────────────────────────

test('Localrent resolves from the real place object', () => {
  assert.deepEqual(localrentLocate(PLACE), { country: 'thailand', city: 'phuket' });
  const u = new URL(carLink({ LOCALRENT_MARKER: 'm' }, PLACE));
  assert.equal(u.pathname, '/en/thailand/phuket/');
});

test('Localrent stays silent where it does not operate', () => {
  assert.equal(carLink({ LOCALRENT_MARKER: 'm' }, EDINBURGH), null, 'Localrent has no United Kingdom');
});

test('Ticketmaster gets coordinates from the real place object', async () => {
  let sent = null;
  const spy = async (url) => {
    sent = Object.fromEntries(new URL(url).searchParams);
    return { ok: true, json: async () => ({ _embedded: { events: [] }, page: { totalElements: 0 } }) };
  };
  const r = await tmSearch({ TICKETMASTER_API_KEY: 'k' },
    { lat: EDINBURGH.lat, lng: EDINBURGH.lng, country: EDINBURGH.country_code }, spy);
  assert.equal(r.ok, true, 'this returned no_coordinates in production for weeks');
  assert.equal(sent.geoPoint, 'gcvwr3y');
});

test('Viator resolves by coordinate from the real place object', () => {
  const rows = [
    { id: 351, name: 'Phuket', parent: 'Thailand', type: 'REGION', selectable: true, lat: 7.9519, lng: 98.3381, norm: normalise('Phuket') },
    { id: 738, name: 'Kathmandu', parent: 'Nepal', type: 'CITY', selectable: true, lat: 27.7172, lng: 85.324, norm: normalise('Kathmandu') },
  ];
  assert.equal(viatorResolve(rows, PLACE, PLACE.country_code), 351);
});

// An ISO code is not a country name, and substring-matching a two-letter code
// against parent names is worse than no filter: 'th' is inside 'Thailand' by
// luck and inside 'Netherlands', 'South Africa' and 'Lithuania' by accident.
test('a two-letter country code never narrows Viator by substring', () => {
  const rows = [
    { id: 1, name: 'Springfield', parent: 'Netherlands', type: 'CITY', selectable: true, lat: null, lng: null, norm: 'springfield' },
    { id: 2, name: 'Springfield', parent: 'Thailand', type: 'CITY', selectable: true, lat: null, lng: null, norm: 'springfield' },
  ];
  // With a bare code the filter must not fire at all — both parents contain
  // "th", so a substring match would pick whichever happened to be first and
  // call it a country match.
  assert.equal(viatorResolve(rows, { name: 'Springfield' }, 'TH'), 1, 'a code must not filter');
  // A real name still narrows correctly.
  assert.equal(viatorResolve(rows, { name: 'Springfield' }, 'Thailand'), 2);
});

test('Bounce resolves from the real place object', () => {
  const u = new URL(luggageLink({ BOUNCE_REF: 'NUM1' }, PLACE));
  assert.equal(u.pathname, '/city/phuket');
});

// The city-centre fallback. A guest with no GPS fix and no usable IP still has
// a destination, and its centre is a perfectly good basis for "what is on in
// this city" — far better than the rail going silent.
test('a place with only city-centre coordinates still drives every rail', async () => {
  const centreOnly = { ...EDINBURGH, precise: false, inferred: true };
  let ok = false;
  await tmSearch({ TICKETMASTER_API_KEY: 'k' },
    { lat: centreOnly.lat, lng: centreOnly.lng, country: centreOnly.country_code },
    async () => { ok = true; return { ok: true, json: async () => ({ _embedded: { events: [] }, page: {} }) }; });
  assert.ok(ok, 'an imprecise coordinate is still a coordinate');
  assert.ok(luggageLink({ BOUNCE_REF: 'NUM1' }, centreOnly));
});

// The unsupported branch of groundRequest returns `{name, unsupported:true}`
// and nothing else. Every rail must survive that rather than throw.
test('the unsupported-place object breaks nothing', async () => {
  const thin = { name: 'Delmar', unsupported: true };
  assert.equal(carLink({ LOCALRENT_MARKER: 'm' }, thin), null);
  assert.equal(localrentLocate(thin), null);
  assert.ok(luggageLink({ BOUNCE_REF: 'NUM1' }, thin), 'falls back to the generic referral');
  const r = await tmSearch({ TICKETMASTER_API_KEY: 'k' }, { lat: undefined, lng: undefined }, () => {
    throw new Error('should not fetch');
  });
  assert.deepEqual(r, { ok: false, reason: 'no_coordinates' });
});

test('a null place breaks nothing', () => {
  assert.equal(carLink({ LOCALRENT_MARKER: 'm' }, null), null);
  assert.equal(localrentLocate(null), null);
  assert.equal(luggageLink({}, null), null);
});
