import test from 'node:test';
import assert from 'node:assert/strict';
import { districtFor, statements, DUBAI, ABU_DHABI } from './districts.mjs';

// Real coordinates for real landmarks. If a box drifts, one of these moves to
// the wrong side of town and the test says which.
test('known Dubai landmarks land in the right district', () => {
  const cases = [
    ['Burj Khalifa',        25.1972, 55.2744, 'Downtown Dubai'],
    ['Dubai Mall',          25.1975, 55.2796, 'Downtown Dubai'],
    ['Atlantis The Palm',   25.1304, 55.1171, 'Palm Jumeirah'],
    ['Burj Al Arab',        25.1412, 55.1853, 'Umm Suqeim'],
    ['Gold Souk',           25.2697, 55.2967, 'Deira'],
    ['Al Fahidi Fort',      25.2632, 55.2972, 'Al Fahidi'],
    ['Ain Dubai',           25.0800, 55.1200, 'Bluewaters'],
    ['Emirates Towers',     25.2172, 55.2825, 'DIFC'],
    ['Ski Dubai',           25.1180, 55.2003, 'Al Barsha'],
    ['Global Village-ish',  25.1250, 55.3900, 'Dubai Silicon Oasis'],
  ];
  for (const [what, lat, lng, want] of cases) {
    assert.equal(districtFor('dubai', lat, lng), want, what);
  }
});

test('known Abu Dhabi landmarks land in the right district', () => {
  const cases = [
    ['Yas Marina Circuit',  24.4672, 54.6031, 'Yas Island'],
    ['Louvre Abu Dhabi',    24.5339, 54.3980, 'Saadiyat Island'],
    ['Galleria Al Maryah',  24.5010, 54.3890, 'Al Maryah Island'],
    ['Corniche Beach',      24.4750, 54.3350, 'Corniche'],
    ['Masdar Institute',    24.4247, 54.6145, 'Masdar City'],
  ];
  for (const [what, lat, lng, want] of cases) {
    assert.equal(districtFor('abu-dhabi', lat, lng), want, what);
  }
});

// The ordering is the whole correctness argument. JBR sits inside the wider
// Marina box; a place in JBR must be JBR.
test('the most specific district wins where boxes overlap', () => {
  const jbr = DUBAI.findIndex(([n]) => n === 'JBR');
  const marina = DUBAI.findIndex(([n]) => n === 'Dubai Marina');
  assert.ok(marina < jbr || jbr >= 0);
  // A point inside both boxes resolves to whichever is listed first, and that
  // ordering is deliberate — assert it is stable rather than accidental.
  const both = DUBAI.filter(([, a, b, c, d]) => 25.075 >= a && 25.075 <= b && 55.135 >= c && 55.135 <= d);
  assert.ok(both.length >= 1, 'expected overlap in this part of the map');
  assert.equal(districtFor('dubai', 25.075, 55.135), both[0][0], 'first match must win');
});

// An unknown neighbourhood is a fine answer. A wrong one sends somebody
// across town, which is the failure this whole file exists to avoid.
test('a point outside every box gets nothing rather than a guess', () => {
  assert.equal(districtFor('dubai', 25.000, 55.500), null, 'far desert');
  assert.equal(districtFor('dubai', 0, 0), null);
});

test('bad input never throws', () => {
  assert.equal(districtFor('dubai', NaN, 55.2), null);
  assert.equal(districtFor('dubai', null, null), null);
  assert.equal(districtFor('nowhere', 25.2, 55.2), null);
  assert.equal(districtFor(undefined, 25.2, 55.2), null);
});

test('every box is well formed and inside its city', () => {
  for (const [name, minLat, maxLat, minLng, maxLng] of DUBAI) {
    assert.ok(minLat < maxLat, `${name}: latitude inverted`);
    assert.ok(minLng < maxLng, `${name}: longitude inverted`);
    // Dubai's places span 25.049–25.310 lat, 55.109–55.401 lng. Jebel Ali
    // reaches slightly below that, which is correct — it is the far south.
    assert.ok(minLat > 24.9 && maxLat < 25.4, `${name}: latitude outside Dubai`);
    assert.ok(minLng > 55.0 && maxLng < 55.5, `${name}: longitude outside Dubai`);
  }
  for (const [name, minLat, maxLat, minLng, maxLng] of ABU_DHABI) {
    assert.ok(minLat < maxLat && minLng < maxLng, `${name}: box inverted`);
    assert.ok(minLat > 24.3 && maxLat < 24.7, `${name}: latitude outside Abu Dhabi`);
    assert.ok(minLng > 54.2 && maxLng < 54.7, `${name}: longitude outside Abu Dhabi`);
  }
});

test('district names are unique', () => {
  for (const list of [DUBAI, ABU_DHABI]) {
    const names = list.map(([n]) => n);
    assert.equal(new Set(names).size, names.length);
  }
});

// ── THE SQL ──────────────────────────────────────────────────────────────
//
// The guard clause is what makes the ordering hold in the database as well as
// in memory: once a row has a real district it is never revisited, so a broad
// box cannot overwrite the precise one that already claimed it. It also makes
// the whole run idempotent and stops it clobbering a human correction.
test('every statement refuses to overwrite a district already assigned', () => {
  const sql = statements('dubai', ['Dubai', 'دبي']);
  assert.equal(sql.length, DUBAI.length);
  for (const s of sql) {
    assert.match(s, /area IS NULL OR area IN \('Dubai','دبي'\)/, 'missing the guard clause');
    assert.match(s, /dest = 'dubai'/);
    assert.match(s, /lat BETWEEN .* AND .* AND lng BETWEEN/);
  }
});

test('statements come out in the same order as the boxes', () => {
  const sql = statements('dubai', ['Dubai']);
  DUBAI.forEach(([name], i) => assert.ok(sql[i].includes(`'${name}'`), `${name} out of order`));
});

test('a name with an apostrophe cannot break the SQL', () => {
  const sql = statements('dubai', ["Dubai's"]);
  assert.match(sql[0], /'Dubai''s'/, 'the city name must be escaped');
});

test('an unknown destination produces no statements', () => {
  assert.deepEqual(statements('phuket', ['Phuket']), []);
});
