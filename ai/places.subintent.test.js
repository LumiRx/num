// The barbershop test.
//
// On 14 Sep a guest in Los Angeles asked for deep-tissue massage and was
// offered "Platinum Cuts Barbershop" — one result, a haircut place, with a
// website that 403s. This file reproduces that exact query against a real
// SQLite and asserts it cannot happen again.
//
// Three separate faults produced it and each has a test here:
//   1. "Deep tissue" matched no category keyword, so the search fell through
//      to DEFAULT_PATTERNS, which include %spa%.
//   2. Google files a barbershop and a genuine day spa under the SAME
//      "Beauty & spa" category, so no category pattern could separate them.
//   3. The specific ask was discarded entirely — "deep tissue" and "manicure"
//      searched identically once detectCat reduced both to `spa`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { detectCat, subIntent, nearbyPlaces } from './places.js';

/* ── the two faults that need no database ─────────────────────────────── */

test('the exact words the guest typed now find the category', () => {
  assert.equal(detectCat('Deep tissue'), 'spa');
  assert.equal(detectCat('deep-tissue'), 'spa');
  assert.equal(detectCat('sports massage'), 'spa');
  assert.equal(detectCat('reflexology'), 'spa');
});

test('a costume ask reaches the costume shops, and does not steal the bar', () => {
  // 22 Sep 2026. The directory held 204 rows categorised 'Costume Store' across
  // Los Angeles, Tokyo, London, Phuket, Edinburgh and Orange County, and a guest
  // could not reach one of them: "where do I get a costume" matched no keyword
  // at all, and "costume shop" matched `shopping` on the word 'shop', which then
  // searched '%shop%' and never matches 'Costume Store'.
  assert.equal(detectCat('where can i get a costume in los angeles'), 'costume');
  assert.equal(detectCat('costume shop near me'), 'costume');
  assert.equal(detectCat('I need a fancy dress outfit for halloween'), 'costume');
  assert.equal(detectCat('where do i rent a cosplay outfit'), 'costume');
  // `bar` carries the word 'party', and it sits below costume on purpose.
  assert.equal(detectCat('a costume for a party tonight'), 'costume');
  // ...but a plain party ask must still be a bar ask, and a suit must still be
  // a tailor ask. Russian 'костюм' means suit and is deliberately not a costume
  // keyword for that reason.
  assert.equal(detectCat('any good party tonight'), 'bar');
  assert.equal(detectCat('where should we go for drinks tonight'), 'bar');
  assert.equal(detectCat('i need a suit tailored'), 'tailor');
  assert.equal(detectCat('where should i shop around here'), 'shopping');
});

test('a bare answer still finds it from what Num had just asked', () => {
  const ask = 'Deep tissue';
  const hint = 'Do you want a full-service spa appointment, a quick walk-in, or sports/deep-tissue massage?';
  // Even if the answer itself carried nothing, the question did.
  assert.equal(detectCat('the second one') ?? detectCat(hint), 'spa');
  assert.equal(detectCat(ask), 'spa');
});

test('the specific ask survives the category, instead of being thrown away', () => {
  assert.equal(subIntent('spa', 'deep tissue'), '%massage%');
  assert.equal(subIntent('spa', 'sports massage'), '%massage%');
  assert.equal(subIntent('spa', 'manicure'), '%beauty%');
  assert.equal(subIntent('spa', 'sauna'), '%spa%');
  // No sub-intent is a normal answer, not a failure.
  assert.equal(subIntent('spa', 'somewhere nice'), null);
  assert.equal(subIntent('restaurant', 'deep tissue'), null);
});

/* ── the real query ───────────────────────────────────────────────────── */

const LA = { lat: 33.9617, lng: -118.3531 };

function env() {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE places (
    id TEXT PRIMARY KEY, name TEXT, name_local TEXT, category TEXT, area TEXT,
    rating REAL, reviews INTEGER, phone TEXT, website TEXT, address TEXT,
    hours TEXT, cuisine TEXT, status TEXT, photo_url TEXT, photo_attr TEXT,
    photo_license TEXT, alive INTEGER, hours_mask TEXT, booking_platform TEXT,
    booking_ref TEXT, num_rating REAL, num_rating_n INTEGER DEFAULT 0,
    lat REAL, lng REAL, cell_lat INTEGER, cell_lng INTEGER, dest TEXT)`);

  const add = (id, name, category, rating, reviews, dLat = 0, dLng = 0) => {
    const lat = LA.lat + dLat, lng = LA.lng + dLng;
    d.prepare(`INSERT INTO places (id,name,category,rating,reviews,status,alive,num_rating_n,lat,lng,cell_lat,cell_lng,dest)
               VALUES (?,?,?,?,?,'unclaimed',NULL,0,?,?,?,?,'los-angeles')`)
      .run(id, name, category, rating, reviews, lat, lng, Math.floor(lat * 10), Math.floor(lng * 10));
  };

  // The real offender, with the strong review count that won it the top slot.
  add('p1', 'Platinum Cuts Barbershop', 'Beauty & spa', 4.9, 800, 0.001, 0.001);
  // Genuine bodywork, filed under the very same category label.
  add('p2', 'Bodywork Deep Tissue Studio', 'Beauty & spa', 4.7, 400, 0.004, 0.002);
  add('p3', 'Serenity Massage Therapy', 'Massage therapist', 4.6, 300, 0.006, 0.003);
  add('p4', 'La Brea Day Spa', 'Spa', 4.5, 250, 0.008, 0.004);
  // Other grooming that must also stay out of a massage answer.
  add('p5', 'Glamour Nail Bar', 'Beauty & spa', 4.8, 600, 0.002, 0.002);
  add('p6', 'Elite Hair Salon', 'Beauty & spa', 4.8, 700, 0.003, 0.001);

  return {
    DB: {
      prepare(sql) {
        return {
          bind(...b) {
            return { all: async () => ({ results: d.prepare(sql).all(...b) }) };
          },
        };
      },
    },
  };
}

const loc = { lat: LA.lat, lng: LA.lng, precise: true, dest: { tz: 'America/Los_Angeles' } };

test('a barbershop is never the answer to a deep-tissue ask', async () => {
  const { rows, cat } = await nearbyPlaces(env(), loc, 'Deep tissue', 6);
  assert.equal(cat, 'spa');
  const names = rows.map((r) => r.name);
  assert.ok(names.length, 'the query returned nothing at all');
  for (const banned of ['Platinum Cuts Barbershop', 'Glamour Nail Bar', 'Elite Hair Salon']) {
    assert.ok(!names.includes(banned), `${banned} came back for a massage ask: ${names.join(', ')}`);
  }
});

test('real bodywork ranks first, even against a better-reviewed barbershop', async () => {
  const { rows } = await nearbyPlaces(env(), loc, 'deep tissue massage', 6);
  assert.match(rows[0].name, /Massage|Deep Tissue/i, `top result was ${rows[0].name}`);
});

test('there is a LIST, not a single answer', async () => {
  // Dre, 14 Sep: "when we are recommending locations, just make sure to get a
  // list of locations not just one."
  const { rows } = await nearbyPlaces(env(), loc, 'Deep tissue', 6);
  assert.ok(rows.length >= 3, `only ${rows.length} place(s) came back: ${rows.map((r) => r.name).join(', ')}`);
});

test('a nail ask still reaches the nail bar — the exclusion is per intent', async () => {
  const { rows } = await nearbyPlaces(env(), loc, 'manicure', 6);
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('Glamour Nail Bar'), `nail bar missing from a manicure ask: ${names.join(', ')}`);
});

test('the topic hint rescues a bare answer', async () => {
  const hint = 'Do you want a full-service spa appointment, a quick walk-in, or sports/deep-tissue massage?';
  const { cat, rows } = await nearbyPlaces(env(), loc, 'the second one please', 6, hint);
  assert.equal(cat, 'spa');
  assert.ok(!rows.map((r) => r.name).includes('Platinum Cuts Barbershop'));
});

test('the hint never overrides a category the guest states outright', async () => {
  const hint = 'Do you want a full-service spa appointment, or sports/deep-tissue massage?';
  const { cat } = await nearbyPlaces(env(), loc, 'actually where can I get dinner', 6, hint);
  assert.equal(cat, 'restaurant', 'the previous topic must not follow the guest around');
});
