/**
 * NUM NEVER COMES BACK EMPTY-HANDED.
 *
 * Dre's rule, 15 Sep 2026, after reading a real thread:
 *   "if we don't have a recommendation for an area we should search for one.
 *    We should never not give any recommendation."
 *
 * The thread that prompted it: a guest asked for a vegetarian, standing-room
 * table and named Hollywood. Num replied "Hollywood is a blank for me — Num
 * has no verified places there yet." The directory held 3,082 places across
 * Hollywood, West Hollywood and North Hollywood at that moment, 2,797 with a
 * phone number.
 *
 * Two independent faults produced one sentence, and both are covered here:
 *   1. The neighbourhood was thrown away before retrieval ran — see
 *      ai/places.test.mjs, "THE HOLLYWOOD BUG".
 *   2. Retrieval could return an empty list at all, and an empty partner
 *      block gives the model nothing to do but apologise. This file is the
 *      floor under that.
 *
 * The floor has a price, and it is the second half of this file: a widened
 * list must NEVER be presented as a local one. Recommending somewhere across
 * town is generous; calling it walkable is a lie that gets someone lost.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { nearbyPlaces } from '../ai/places.js';
import { contextBlock } from './prompt.mjs';

const LA = { slug: 'los-angeles', name: 'Los Angeles', country: 'US', tz: 'America/Los_Angeles', lat: 34.052, lng: -118.243 };
const LOC = { dest: LA, lat: 34.0983, lng: -118.3267, label: 'Hollywood', precise: false, source: 'named_area' };

/**
 * A D1 stub where every DISTANCE-BOUNDED query returns nothing and only the
 * destination-wide fallback has rows — the exact shape of the failure. If the
 * floor is removed, every test below goes empty.
 */
function starvedEnv({ fallback = [{ id: 'p1', name: 'Pa Ord Noodle', category: 'Restaurant', area: 'Hollywood', phone: '+13234642989', rating: 4.5, reviews: 900 }] } = {}) {
  let fallbackCalls = 0;
  const env = {
    DB: {
      prepare(sql) {
        const wide = /WHERE dest = \?1 AND alive IS NOT 0/.test(sql);
        if (wide) fallbackCalls += 1;
        return {
          bind: () => ({ all: async () => ({ results: wide ? fallback : [] }) }),
          all: async () => ({ results: [] }),
        };
      },
    },
  };
  return { env, calls: () => fallbackCalls };
}

describe('the floor', () => {
  test("THE RULE: a covered destination never returns an empty list", async () => {
    const { env } = starvedEnv();
    const r = await nearbyPlaces(env, LOC, 'somewhere vegetarian I can stand up at', 6);
    assert.ok(r.rows.length > 0, 'Num came back empty-handed in a city holding 90,264 places');
    assert.equal(r.rows[0].name, 'Pa Ord Noodle');
  });

  test('the fallback is flagged, so nobody downstream can mistake it for local', async () => {
    const { env } = starvedEnv();
    const r = await nearbyPlaces(env, LOC, 'vegetarian dinner', 6);
    assert.equal(r.widened, true);
  });

  test('a normal result is NOT flagged widened', async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({ all: async () => ({ results: [
            { id: 'a', name: 'Close By', category: 'Restaurant', km: 0.4 },
            { id: 'b', name: 'Also Close', category: 'Restaurant', km: 0.6 },
            { id: 'c', name: 'Third', category: 'Restaurant', km: 0.9 },
            { id: 'd', name: 'Fourth', category: 'Restaurant', km: 1.1 },
          ] }) }),
          all: async () => ({ results: [] }),
        }),
      },
    };
    const r = await nearbyPlaces(env, LOC, 'dinner', 6);
    assert.equal(r.widened, false, 'a local list was labelled as across-town');
  });

  test('the floor runs LAST — it never pre-empts a real nearby match', async () => {
    const { env, calls } = starvedEnv();
    await nearbyPlaces(env, LOC, 'dinner', 6);
    // Rings first, then the category-wide sweep, and only then the floor.
    assert.equal(calls(), 1, 'the destination-wide query ran more than once');
  });

  test('the floor cannot resurrect a dead listing', async () => {
    // `alive IS NOT 0` is in the query for a reason: a closed-down venue is
    // worse than no recommendation, which is the one thing worse than silence.
    const { env } = starvedEnv();
    let seen = '';
    const spy = { DB: { prepare(sql) { if (/alive/.test(sql)) seen = sql; return env.DB.prepare(sql); } } };
    await nearbyPlaces(spy, LOC, 'dinner', 6);
    assert.match(seen, /alive IS NOT 0/);
  });

  test('no destination means no floor — we do not invent coverage', async () => {
    const { env, calls } = starvedEnv();
    await nearbyPlaces(env, { dest: null, lat: 0, lng: 0 }, 'dinner', 6);
    assert.equal(calls(), 0, 'ran a destination query with no destination');
  });

  test('a database that throws still returns a shape, never undefined', async () => {
    const env = { DB: { prepare() { throw new Error('D1 down'); } } };
    const r = await nearbyPlaces(env, LOC, 'dinner', 6);
    assert.ok(Array.isArray(r.rows));
    assert.equal(r.rows.length, 0);
  });
});

describe('the price of the floor: it must never read as local', () => {
  const PARTNERS = [{ name: 'Pa Ord Noodle', category: 'Restaurant', area: 'Hollywood', phone: '+13234642989' }];

  test('a widened list is announced as a journey, not a walk', () => {
    const b = contextBlock({ place: { name: 'Los Angeles' }, partners: PARTNERS, widened: true });
    assert.match(b, /NOT NEARBY/);
    assert.match(b, /never apologise for having nothing/i);
  });

  test('the model is forbidden the specific words that would mislead', () => {
    const b = contextBlock({ place: { name: 'Los Angeles' }, partners: PARTNERS, widened: true });
    for (const w of ['close', 'walkable', 'round the corner', 'walking time']) {
      assert.ok(b.includes(w), `the ban on "${w}" is missing`);
    }
  });

  test('a normal list carries no such warning', () => {
    const b = contextBlock({ place: { name: 'Los Angeles' }, partners: PARTNERS, widened: false });
    assert.ok(!b.includes('NOT NEARBY'), 'a local list was announced as across-town');
  });

  test('the warning never appears with an empty partner list', () => {
    // It would be describing nothing, and it would spend the model's attention
    // on a block that has no rows under it.
    const b = contextBlock({ place: { name: 'Los Angeles' }, partners: [], widened: true });
    assert.ok(!b.includes('NOT NEARBY'));
  });
});

describe('"blank" is no longer sayable about a covered city', () => {
  test('the unsupported branch checks itself before claiming a blank', () => {
    const b = contextBlock({ place: { name: 'Hollywood', unsupported: true } });
    assert.match(b, /neighbourhood, district or suburb of a city Num does cover/);
    assert.match(b, /it is NOT a blank/);
  });

  test('a genuinely uncovered city still gets the honest answer', () => {
    const b = contextBlock({ place: { name: 'Del Mar', unsupported: true } });
    assert.match(b, /NO partner network there yet/);
    assert.match(b, /NEVER answer about a different city/);
  });
});
