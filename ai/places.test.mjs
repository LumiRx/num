/**
 * Guards on location resolution.
 *
 * These exist because of a real production failure. A guest wrote "I'm in Los
 * Angeles"; NUM replied "I think there might be some confusion - you're
 * actually in Phuket", then recommended a Phuket restaurant, and repeated it
 * after two corrections.
 *
 * Two bugs combined:
 *   1. `destNamedIn` only recognises cities we cover, so an unsupported city
 *      was indistinguishable from silence, and resolution fell through to the
 *      hardcoded Phuket default.
 *   2. `last_dest` is sticky — once set, every later message re-anchored to it
 *      regardless of what the guest said.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statedPlace, resolveLocation } from './places.js';
import { SYSTEM } from './worker.js';

const DESTS = [
  { slug: 'phuket', name: 'Phuket', country: 'TH', tz: 'Asia/Bangkok', lat: 7.953, lng: 98.338, place_count: 200 },
  { slug: 'bangkok', name: 'Bangkok', country: 'TH', tz: 'Asia/Bangkok', lat: 13.756, lng: 100.501, place_count: 300 },
];

/** D1 stub. `areas` are neighbourhood names isKnownArea should recognise. */
function mockEnv({ areas = [] } = {}) {
  const handle = (sql, args = []) => ({
    all: async () => ({
      results: /FROM destinations/.test(sql) ? DESTS
        : /GROUP BY area/.test(sql) ? []
        : [],
    }),
    first: async () => {
      if (/FROM places WHERE area LIKE/.test(sql)) {
        const want = String(args[0] || '').toLowerCase();
        return areas.some(a => a.toLowerCase() === want) ? { 1: 1 } : null;
      }
      return null;
    },
  });
  return {
    DB: {
      prepare(sql) {
        return Object.assign(handle(sql), { bind: (...a) => handle(sql, a) });
      },
    },
  };
}

// ───────────────────────── statedPlace ──────────────────────────────────────

test('statedPlace hears a city the guest declares', () => {
  for (const [text, want] of [
    ["I'm in Los Angeles", 'Los Angeles'],
    ['im in los angeles right now', 'los angeles'],
    ["We're staying in Reykjavik", 'Reykjavik'],
    ['I am currently in San Francisco', 'San Francisco'],
    ['just landed in Lisbon', 'Lisbon'],
  ]) {
    assert.equal(String(statedPlace(text)).toLowerCase(), want.toLowerCase(), text);
  }
});

test('statedPlace hears a city with no "I am" in front of it', () => {
  // The exact message that still got a Phuket sky bar after the first fix.
  // The first version required a trigger phrase; guests rarely use one.
  assert.equal(statedPlace('Give me hookah bar in La tonight'), 'Los Angeles');
  assert.equal(statedPlace('best sushi in Tokyo'), 'Tokyo');
  assert.equal(statedPlace('hotels in NYC please'), 'New York');
  assert.equal(statedPlace('rooftop bar in SF'), 'San Francisco');
});

test('statedPlace ignores "in" that names no place', () => {
  for (const text of [
    "I'm in a hurry",
    "we're in the mood for thai food",
    "I'm in trouble, lost my wallet",
    'I am in general looking for spa',
    'book me in',
  ]) {
    assert.equal(statedPlace(text), null, text);
  }
});

// ───────────────────── the Los Angeles regression ───────────────────────────

test('an uncovered city the guest names is flagged, not silently swapped for Phuket', async () => {
  const loc = await resolveLocation(mockEnv(), {
    text: "I'm in Los Angeles, where should I eat tonight?",
    guest: {}, cf: null,
  });
  assert.equal(String(loc.unsupported).toLowerCase(), 'los angeles');
  assert.equal(loc.source, 'unsupported');
});

test('a stated uncovered city beats a stored last_dest — the sticky-Phuket bug', async () => {
  const loc = await resolveLocation(mockEnv(), {
    text: "I'm in Los Angeles now",
    guest: { last_dest: 'phuket' },   // they were in Phuket last week
    cf: null,
  });
  assert.equal(String(loc.unsupported).toLowerCase(), 'los angeles');
  assert.notEqual(loc.source, 'last_seen');
});

test('a covered city still resolves normally and is never flagged', async () => {
  const loc = await resolveLocation(mockEnv(), {
    text: 'looking for dinner in Bangkok', guest: {}, cf: null,
  });
  assert.equal(loc.dest.slug, 'bangkok');
  assert.ok(!loc.unsupported);
});

test('a neighbourhood is not mistaken for an uncovered city', async () => {
  const loc = await resolveLocation(mockEnv({ areas: ['Patong'] }), {
    text: "I'm staying in Patong", guest: { last_dest: 'phuket' }, cf: null,
  });
  assert.ok(!loc.unsupported, 'Patong is an area in Phuket, not an unsupported city');
});

test('saying nothing about location behaves exactly as before', async () => {
  const loc = await resolveLocation(mockEnv(), {
    text: 'where should I eat tonight?', guest: { last_dest: 'bangkok' }, cf: null,
  });
  assert.ok(!loc.unsupported);
  assert.equal(loc.source, 'last_seen');
  assert.equal(loc.dest.slug, 'bangkok');
});

// ───────────────────────── the prompt ───────────────────────────────────────

const basePlace = { dest: DESTS[0], rows: [], label: null, precise: false };

test('out-of-area prompt tells the truth and offers nothing local', () => {
  const p = SYSTEM({ ...basePlace, unsupported: 'Los Angeles' }, {}, 'Mon 7pm', null);
  assert.match(p, /GUEST IS IN: Los Angeles/);
  assert.match(p, /DOES NOT COVER/);
  assert.match(p, /overrides every other rule/i);
  // The exact sentence it used on the guest must be named and forbidden.
  assert.match(p, /some confusion/);
  assert.match(p, /Do NOT change the subject to travel packages/);
  assert.match(p, /Do NOT name a single business/);
});

test('out-of-area prompt never asserts the guest is in Phuket', () => {
  const p = SYSTEM({ ...basePlace, unsupported: 'Los Angeles' }, {}, 'Mon 7pm', null);
  assert.doesNotMatch(p, /GUEST IS IN: Phuket/);
  assert.doesNotMatch(p, /RECOMMENDATIONS CENTRED ON: Phuket/);
});

test('in-area prompt still serves partners and shows no warning block', () => {
  const p = SYSTEM({ ...basePlace, source: 'named', rows: [{ name: 'Baan Rim Pa', category: 'restaurant' }] },
    {}, 'Mon 7pm', null);
  assert.doesNotMatch(p, /DOES NOT COVER/);
  assert.match(p, /Baan Rim Pa/);
});

test('in-area location is stated as a guess, never as fact', () => {
  // Defence in depth. statedPlace is a regex and will always miss cases, so the
  // prompt must not assert location as known even when nothing was flagged —
  // "GUEST IS IN: Phuket" is what the model defended against the guest.
  const p = SYSTEM({ ...basePlace, source: 'last_seen' }, {}, 'Mon 7pm', null);
  assert.doesNotMatch(p, /^GUEST IS IN:/m, 'location must not be asserted as fact');
  assert.match(p, /WHERE WE THINK THE GUEST IS: Phuket, TH/);
  assert.match(p, /it is sometimes wrong/i);
  assert.match(p, /If the guest names anywhere else, they are right/);
});
