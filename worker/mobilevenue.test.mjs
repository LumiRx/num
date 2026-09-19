// A venue that moves, and the one rule that makes it safe to list: when the
// time the operator gave has passed, NUM stops giving out a location. Not a
// stale one with a caveat — none.
//
// Hugo's Tacos is the first of these. The two Hugo's Restaurant sites run on
// Resy; the taco side has no booking system because there is nothing to book.
// The only question a guest has is where the truck is standing right now, and
// that is a question a pin on Google Maps cannot answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  registerMobile, setPosition, clearPosition, positionOf, parkedNear,
  recentPitches, sayWhere, coord, hereToken, sameToken, hideExpired,
  MIN_DWELL_MIN, MAX_DWELL_MIN, __resetReady,
} from './mobilevenue.mjs';
import { coordsFromText, minutesFromText, labelFromText, readHereText } from './mobileroutes.mjs';

const VENICE = { lat: 33.9905, lng: -118.4655 };

function realDb() {
  const d = new DatabaseSync(':memory:');
  const DB = {
    prepare(sql) {
      const bound = [];
      const api = {
        bind(...a) { bound.push(...a); return api; },
        async first() { try { return d.prepare(sql).get(...bound) ?? null; } catch { return null; } },
        async all() { return { results: d.prepare(sql).all(...bound) }; },
        async run() { const r = d.prepare(sql).run(...bound); return { meta: { changes: Number(r.changes ?? 0) } }; },
      };
      return api;
    },
    async batch(st) { const o = []; for (const x of st) o.push(await x.run()); return o; },
  };
  __resetReady();
  return { d, env: { DB, ADMIN_KEY: 'test-key', SITE: 'https://itsnum.com' } };
}

async function truck(env, d) {
  await registerMobile(env, 'p_hugos_tacos', { name: "Hugo's Tacos", kind: 'truck', businessId: 'b1' });
  return d;
}

/* ══ The rule ═══════════════════════════════════════════════════════════ */

test('a parked truck gives its position', async () => {
  const { d, env } = realDb();
  await truck(env, d);
  const set = await setPosition(env, 'p_hugos_tacos', { ...VENICE, accuracy: 12, label: 'Abbot Kinney', minutes: 180 });
  assert.equal(set.ok, true);

  const pos = await positionOf(env, 'p_hugos_tacos');
  assert.equal(pos.state, 'parked');
  assert.equal(pos.lat, VENICE.lat);
  assert.match(sayWhere(pos), /parked at Abbot Kinney until \d\d:\d\d/);
});

test('once the time they gave has passed there are NO coordinates at all', async () => {
  // The whole design. Not null coordinates, not stale ones behind a flag —
  // absent, so a caller that forgets to check the state has nothing to render
  // and no prompt can read an old spot back to a guest.
  const { d, env } = realDb();
  await truck(env, d);
  await setPosition(env, 'p_hugos_tacos', { ...VENICE, label: 'Abbot Kinney', minutes: 60 });
  d.prepare("UPDATE num_venue_positions SET valid_until = datetime('now','-10 minutes')").run();

  const pos = await positionOf(env, 'p_hugos_tacos');
  assert.equal(pos.state, 'expired');
  assert.ok(!('lat' in pos), 'lat must not be present on an expired position');
  assert.ok(!('lng' in pos), 'lng must not be present on an expired position');
  // The history survives, because it is honest and useful.
  assert.equal(pos.last.label, 'Abbot Kinney');
  const said = sayWhere(pos);
  assert.match(said, /not parked anywhere right now/);
  assert.match(said, /Last time it was at Abbot Kinney/);
});

test('what NUM says about an expired truck never reads as a location now', async () => {
  const { d, env } = realDb();
  await truck(env, d);
  await setPosition(env, 'p_hugos_tacos', { ...VENICE, label: 'Abbot Kinney', minutes: 60 });
  d.prepare("UPDATE num_venue_positions SET valid_until = datetime('now','-1 hours')").run();
  const said = sayWhere(await positionOf(env, 'p_hugos_tacos'));
  assert.ok(!/\bis at\b/.test(said), said);
  assert.ok(!/\bis parked at\b/.test(said), said);
});

test('packing up early takes them off the map immediately', async () => {
  const { d, env } = realDb();
  await truck(env, d);
  await setPosition(env, 'p_hugos_tacos', { ...VENICE, minutes: 300 });
  assert.equal((await positionOf(env, 'p_hugos_tacos')).state, 'parked');
  await clearPosition(env, 'p_hugos_tacos', { by: 'driver' });
  assert.equal((await positionOf(env, 'p_hugos_tacos')).state, 'expired');
});

test('a registered truck that has never parked says so, rather than nothing', async () => {
  const { d, env } = realDb();
  await truck(env, d);
  const pos = await positionOf(env, 'p_hugos_tacos');
  assert.equal(pos.state, 'never');
  assert.match(sayWhere(pos), /moves around and has not said where it is yet/);
});

test('an ordinary fixed place is none of this file\u2019s business', async () => {
  const { env } = realDb();
  assert.equal((await positionOf(env, 'p_a_restaurant')).state, 'not_mobile');
  assert.equal(sayWhere({ state: 'not_mobile' }), null);
});

/* ══ What we refuse to believe ══════════════════════════════════════════ */

test('Null Island is refused', async () => {
  // A phone that has failed to get a fix reports 0,0 far more often than
  // anybody is genuinely in the Gulf of Guinea.
  const { d, env } = realDb();
  await truck(env, d);
  assert.equal(coord(0, 0), null);
  assert.equal((await setPosition(env, 'p_hugos_tacos', { lat: 0, lng: 0 })).error, 'bad_coordinates');
  assert.equal((await setPosition(env, 'p_hugos_tacos', { lat: 91, lng: 0 })).error, 'bad_coordinates');
  assert.equal((await setPosition(env, 'p_hugos_tacos', { lat: 'here', lng: 'there' })).error, 'bad_coordinates');
});

test('a fix that is only a guess from a cell tower is refused', async () => {
  const { d, env } = realDb();
  await truck(env, d);
  const out = await setPosition(env, 'p_hugos_tacos', { ...VENICE, accuracy: 4800 });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'position_too_vague');
  // "Within five kilometres" is not an answer to "where is the truck".
  assert.equal((await positionOf(env, 'p_hugos_tacos')).state, 'never');
});

test('a dwell outside the bounds is refused rather than rounded', async () => {
  const { d, env } = realDb();
  await truck(env, d);
  assert.equal((await setPosition(env, 'p_hugos_tacos', { ...VENICE, minutes: 5 })).error, 'bad_dwell');
  // "Parked here till next Tuesday" is a typo, not a plan.
  assert.equal((await setPosition(env, 'p_hugos_tacos', { ...VENICE, minutes: 60 * 24 * 7 })).error, 'bad_dwell');
  assert.equal((await setPosition(env, 'p_hugos_tacos', { ...VENICE, minutes: MIN_DWELL_MIN })).ok, true);
  assert.equal((await setPosition(env, 'p_hugos_tacos', { ...VENICE, minutes: MAX_DWELL_MIN })).ok, true);
});

/* ══ Finding one ════════════════════════════════════════════════════════ */

test('only trucks standing somewhere NOW come back from a nearby search', async () => {
  const { d, env } = realDb();
  await registerMobile(env, 'p_here', { name: 'Parked' });
  await registerMobile(env, 'p_gone', { name: 'Left an hour ago' });
  await setPosition(env, 'p_here', { ...VENICE, minutes: 120 });
  await setPosition(env, 'p_gone', { lat: VENICE.lat + 0.002, lng: VENICE.lng, minutes: 60 });
  d.prepare("UPDATE num_venue_positions SET valid_until = datetime('now','-5 minutes') WHERE place_id='p_gone'").run();

  const near = await parkedNear(env, { ...VENICE, km: 5 });
  assert.deepEqual(near.map((r) => r.place_id), ['p_here'],
    'the expiry must be in the query, not in a filter every caller has to remember');
});

test('a truck across town is not nearby', async () => {
  const { d, env } = realDb();
  await truck(env, d);
  await setPosition(env, 'p_hugos_tacos', { ...VENICE, minutes: 120 });
  assert.equal((await parkedNear(env, { lat: 34.0928, lng: -118.3287, km: 5 })).length, 0, 'Hollywood is not Venice');
  const wide = await parkedNear(env, { lat: 34.0928, lng: -118.3287, km: 25 });
  assert.equal(wide.length, 1);
  assert.ok(wide[0].km > 10 && wide[0].km < 25, `got ${wide[0].km}km`);
});

test('every pitch is kept, so "where were they yesterday" has an answer', async () => {
  const { d, env } = realDb();
  await truck(env, d);
  await setPosition(env, 'p_hugos_tacos', { ...VENICE, label: 'Abbot Kinney', minutes: 60 });
  await setPosition(env, 'p_hugos_tacos', { lat: 34.0195, lng: -118.4912, label: 'Main St', minutes: 60 });
  const log = await recentPitches(env, 'p_hugos_tacos');
  assert.equal(log.length, 2);
  assert.deepEqual(log.map((r) => r.label).sort(), ['Abbot Kinney', 'Main St']);
});

/* ══ The link in the driver's phone ═════════════════════════════════════ */

test('the link authorises one venue and nothing else', async () => {
  const { env } = realDb();
  const mine = await hereToken(env, 'p_hugos_tacos');
  const theirs = await hereToken(env, 'p_someone_else');
  assert.notEqual(mine, theirs);
  assert.equal(sameToken(mine, mine), true);
  assert.equal(sameToken(mine, theirs), false);
  assert.equal(sameToken(mine, ''), false);
  assert.equal(sameToken(mine, `${mine}x`), false, 'a length difference must not read as equal');
});

/* ══ Reading a text from a driver ═══════════════════════════════════════ */

test('coordinates are taken from what phones actually send', () => {
  assert.deepEqual(coordsFromText('https://maps.google.com/@33.9905,-118.4655,17z'), VENICE);
  assert.deepEqual(coordsFromText('https://maps.apple.com/?ll=33.9905,-118.4655&q=Dropped%20Pin'), VENICE);
  assert.deepEqual(coordsFromText('https://www.google.com/maps/place/x/data=!3d33.9905!4d-118.4655'), VENICE);
  assert.deepEqual(coordsFromText('33.9905, -118.4655'), VENICE);
});

test('a street name is not a coordinate, and is not treated as one', () => {
  // Guessing a pin from "abbot kinney" puts a guest at the wrong end of a
  // long road. Half an answer, correctly labelled, beats an invented one.
  const read = readHereText('parked on abbot kinney till 3');
  assert.equal(read.coords, null);
  assert.equal(read.label, 'abbot kinney');
  assert.ok(read.minutes > 0);
});

test('"till 3" at eleven in the morning means this afternoon', () => {
  const elevenAm = new Date('2026-09-19T11:00:00');
  assert.equal(minutesFromText('here till 3', elevenAm), 240);
  assert.equal(minutesFromText('until 3pm', elevenAm), 240);
  assert.equal(minutesFromText('till 14:30', elevenAm), 210);
  assert.equal(minutesFromText('for 2 hours', elevenAm), 120);
  assert.equal(minutesFromText('for 90 mins', elevenAm), 90);
  assert.equal(minutesFromText('somewhere nice', elevenAm), null, 'unknown must be null, never a default dressed as a reading');
});

test('a time that has already gone today means tomorrow, not the past', () => {
  const sixPm = new Date('2026-09-19T18:00:00');
  const mins = minutesFromText('till 9am', sixPm);
  assert.ok(mins > 0 && mins <= 16 * 60, `got ${mins}`);
});

test('the label is what they typed, without the link and the time words', () => {
  assert.equal(labelFromText('we\u2019re parked at Abbot Kinney till 3 https://maps.google.com/@1.1,2.2'), 'Abbot Kinney');
  assert.equal(labelFromText('till 3'), null, 'nothing left is null, not an empty string');
});

/* ══ The directory row, and putting it back ═════════════════════════════ */

test('parking moves the directory row, so the ordinary search finds it', async () => {
  // This is the trick that makes a moving venue findable without a second
  // proximity search: point places.lat/lng at the pitch and everything that
  // already works keeps working.
  const { d, env } = realDb();
  d.exec('CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, lat REAL, lng REAL, area TEXT, alive INTEGER DEFAULT 1)');
  d.prepare("INSERT INTO places (id,name,lat,lng,area) VALUES ('p_hugos_tacos','Hugo’s Tacos',34.1,-118.3,'Studio City')").run();
  await truck(env, d);

  await setPosition(env, 'p_hugos_tacos', { ...VENICE, label: 'Abbot Kinney', minutes: 120 });
  const row = d.prepare("SELECT lat,lng,area FROM places WHERE id='p_hugos_tacos'").get();
  assert.equal(Math.round(row.lat * 1000) / 1000, 33.991);
  assert.equal(row.area, 'Abbot Kinney');
});

test('and the expired one is taken out of the list before a guest sees it', async () => {
  // The cost of the trick above: places.lat/lng goes on saying Abbot Kinney
  // after the truck has left, because nothing moves it back. This does.
  const { d, env } = realDb();
  d.exec('CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, lat REAL, lng REAL, area TEXT)');
  await registerMobile(env, 'p_parked', { name: 'Still there' });
  await registerMobile(env, 'p_gone', { name: 'Left at three' });
  await setPosition(env, 'p_parked', { ...VENICE, minutes: 120 });
  await setPosition(env, 'p_gone', { ...VENICE, minutes: 60 });
  d.prepare("UPDATE num_venue_positions SET valid_until = datetime('now','-20 minutes') WHERE place_id='p_gone'").run();

  const list = [{ id: 'p_a_restaurant' }, { id: 'p_parked' }, { id: 'p_gone' }];
  const out = await hideExpired(env, list);
  assert.deepEqual(out.map((r) => r.id), ['p_a_restaurant', 'p_parked'],
    'a fixed place is untouched, a parked truck stays, one that has gone drops out');
});

test('a registered truck that has never parked is not shown either', async () => {
  const { env } = realDb();
  await registerMobile(env, 'p_never', { name: 'Newly signed up' });
  const out = await hideExpired(env, [{ id: 'p_never' }, { id: 'p_normal' }]);
  assert.deepEqual(out.map((r) => r.id), ['p_normal']);
});

test('a broken filter returns the list unchanged, never empty', async () => {
  // An empty recommendation block is worse than a truck at yesterday's kerb,
  // and "a list query that answers none on a failed read" is banned in this
  // codebase for reasons it earned.
  const bad = { DB: { prepare() { throw new Error('D1 is having a day'); }, batch() { throw new Error('nope'); } } };
  const list = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(await hideExpired(bad, list), list);
  assert.deepEqual(await hideExpired(null, list), list);
});

test('with no moving venues at all the list is handed straight back', async () => {
  const { env } = realDb();
  const list = [{ id: 'a' }, { id: 'b' }];
  assert.equal(await hideExpired(env, list), list, 'the common case must not copy the array');
});
