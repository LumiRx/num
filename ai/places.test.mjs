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
import { statedPlace, resolveLocation, __resetDestCache } from './places.js';
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
      // isKnownArea reads the precomputed num_dest_areas table (0016) and
      // falls back to the places scan when it is absent — model both.
      if (/FROM num_dest_areas WHERE area = /.test(sql) || /FROM places WHERE area LIKE/.test(sql)) {
        const want = String(args[0] || '').toLowerCase();
        return areas.some(a => a.toLowerCase() === want) ? { 1: 1 } : null;
      }
      return null;
    },
  });
  // Both stubs reset it, so neither can poison the other whichever order the
  // runner picks.
  __resetDestCache();
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

// ───────────────── the neighbourhood that was thrown away ────────────────────
//
// 15 Sep 2026, from the app. A guest asked for a vegetarian, standing-friendly
// table and named Hollywood. Num answered: "Hollywood is a blank for me — Num
// has no verified places there yet." At that moment the directory held 3,082
// places across Hollywood, West Hollywood and North Hollywood, 2,797 of them
// with a phone number.
//
// The cause was one condition. `areaCenter` ran only `if (!out.lat)`, and her
// phone's IP had already filled out.lat with a Los Angeles position — so the
// word "Hollywood" was never read, and retrieval searched rings around the
// handset instead. The fix inverts the precedence to match what the top of
// resolveLocation has always promised: a place the guest NAMED beats where
// they happen to be standing.

const LA = { slug: 'los-angeles', name: 'Los Angeles', country: 'US', tz: 'America/Los_Angeles', lat: 34.052, lng: -118.243, place_count: 90264 };

/** D1 stub with destinations AND neighbourhood centroids. */
function mockCity({ areas = [] } = {}) {
  const dests = [...DESTS, LA];
  const handle = (sql, args = []) => ({
    all: async () => ({
      results: /FROM destinations/.test(sql) ? dests
        : /num_dest_areas WHERE dest/.test(sql) || /GROUP BY area/.test(sql) ? areas
        : [],
    }),
    first: async () => {
      if (/FROM num_dest_areas WHERE area = /.test(sql) || /FROM places WHERE area LIKE/.test(sql)) {
        const want = String(args[0] || '').toLowerCase();
        return areas.some(a => String(a.area).toLowerCase() === want) ? { 1: 1 } : null;
      }
      return null;
    },
  });
  // The destination list is cached at module scope for five minutes, so
  // without this every test after the first resolves against whatever the
  // first one loaded — which is how this stub's Los Angeles kept coming back
  // as Phuket.
  __resetDestCache();
  return { DB: { prepare(sql) { return Object.assign(handle(sql), { bind: (...a) => handle(sql, a) }); } } };
}

const HOLLYWOOD = { area: 'Hollywood', lat: 34.0983, lng: -118.3267, n: 251 };
const WEHO = { area: 'West Hollywood', lat: 34.0900, lng: -118.3617, n: 2131 };
// Downtown LA — roughly where a coarse IP lookup drops a Los Angeles request,
// and ~12km from the Hollywood centroid. Far enough that a 8km ring misses it.
const DTLA_IP = { latitude: '34.0407', longitude: '-118.2468' };

test('THE HOLLYWOOD BUG: a named neighbourhood beats the IP guess', async () => {
  const env = mockCity({ areas: [WEHO, HOLLYWOOD] });
  const loc = await resolveLocation(env, {
    text: "No I don't want American and yes search hollywood",
    guest: null,
    cf: DTLA_IP,
  });
  assert.equal(loc.dest.slug, 'los-angeles', 'lost the city');
  assert.equal(loc.source, 'named_area', 'the neighbourhood was thrown away again');
  assert.equal(loc.label, 'Hollywood');
  assert.ok(Math.abs(loc.lat - HOLLYWOOD.lat) < 0.001, 'centred on the phone, not on Hollywood');
});

test('the longest matching neighbourhood wins, so West Hollywood is not Hollywood', async () => {
  const env = mockCity({ areas: [HOLLYWOOD, WEHO] });
  const loc = await resolveLocation(env, { text: 'dinner in west hollywood', guest: null, cf: DTLA_IP });
  assert.equal(loc.label, 'West Hollywood');
});

test('a named neighbourhood is never reported as a precise position', async () => {
  // A centroid is a district, not a doorstep. Leaving `precise` true makes
  // retrieval search a 4km ring around an averaged point and call it walking
  // distance, and makes the prompt claim "near me" means walking distance.
  const env = mockCity({ areas: [HOLLYWOOD] });
  const loc = await resolveLocation(env, {
    text: 'vegetarian in hollywood',
    guest: { last_lat: 34.0407, last_lng: -118.2468, last_loc_at: new Date().toISOString().slice(0, 19).replace('T', ' ') },
    cf: null,
  });
  assert.equal(loc.precise, false);
  assert.equal(loc.source, 'named_area');
});

test('THE LIMIT: "near me" with a real GPS fix still centres on the guest', async () => {
  // The other half of the rule. When the guest's own body is the subject of
  // the sentence, a neighbourhood mentioned in passing must not move the
  // search across town. Without this the fix would break "anywhere close by".
  const env = mockCity({ areas: [HOLLYWOOD] });
  const loc = await resolveLocation(env, {
    text: 'somewhere near me, I used to live in hollywood',
    guest: { last_lat: 34.0407, last_lng: -118.2468, last_loc_at: new Date().toISOString().slice(0, 19).replace('T', ' ') },
    cf: null,
  });
  assert.equal(loc.source, 'shared_location', 'a passing mention moved the guest across town');
  assert.equal(loc.precise, true);
  assert.ok(Math.abs(loc.lat - 34.0407) < 0.001);
});

test('a coarse IP is NOT a body — "near me" on IP still yields to the named area', async () => {
  // asksNearMe alone must not win: IP geo is a city-level guess, often a VPN
  // or a roaming SIM, and it has no business beating a place the guest typed.
  const env = mockCity({ areas: [HOLLYWOOD] });
  const loc = await resolveLocation(env, { text: 'anywhere near me in hollywood', guest: null, cf: DTLA_IP });
  assert.equal(loc.source, 'named_area');
  assert.equal(loc.label, 'Hollywood');
});

test('no neighbourhood named: the guest position still wins, unchanged', async () => {
  const env = mockCity({ areas: [HOLLYWOOD, WEHO] });
  const loc = await resolveLocation(env, { text: 'somewhere for dinner', guest: null, cf: DTLA_IP });
  assert.equal(loc.source, 'ip_location');
  assert.ok(Math.abs(loc.lat - 34.0407) < 0.001);
});

test('a covered neighbourhood is never classified unsupported', async () => {
  // The other route to "Hollywood is a blank": statedPlace hears "in
  // hollywood", isKnownArea must recognise it, and the unsupported branch must
  // not fire. If this ever regresses the prompt tells the model there is no
  // partner network in a city holding 90,264 places.
  const env = mockCity({ areas: [HOLLYWOOD] });
  const loc = await resolveLocation(env, { text: 'vegetarian dinner in hollywood', guest: null, cf: DTLA_IP });
  assert.equal(loc.unsupported, undefined, 'a Los Angeles neighbourhood was called an unsupported city');
  assert.notEqual(loc.source, 'unsupported');
});

test('a genuinely unsupported city is still heard', async () => {
  // The guard must not be so eager that it swallows the real case this whole
  // branch exists for.
  const env = mockCity({ areas: [HOLLYWOOD] });
  const loc = await resolveLocation(env, { text: 'horse races in Del Mar this weekend', guest: null, cf: DTLA_IP });
  assert.equal(loc.source, 'unsupported');
  assert.match(String(loc.unsupported), /del mar/i);
});
