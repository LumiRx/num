import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COVER, COLS, UPSERT_TAIL, buildSql, gridFor, q, registerDestinationsSql, tuple } from './coverplan.mjs';

const P = {
  id: 'abc123', name: "Ah-Ming's", name_local: '阿明豬心冬粉', category: 'Restaurant',
  lat: 22.9908, lng: 120.2019, cell_lat: 229, cell_lng: 1202, dest: 'tainan',
  area: '中西區', country: 'TW', region: 'Asia', phone: '+886 6 222 3387',
  website: null, email: null, address: '114 Baoan Rd', hours: '17:00-24:00',
  cuisine: null, rating: null, reviews: 0, source: 'osm', status: 'unclaimed',
};

test('the cover stops at the water', () => {
  for (const c of COVER.TW) {
    const [s, w, n, e] = c.bbox;
    assert.ok(n > s && e > w, `${c.name} bbox is inside out`);
    // Nothing may reach into the South China Sea. Pratas is 20.7N/116.7E and
    // Taiping is 10.4N/114.4E; Kaohsiung's official envelope covers both.
    assert.ok(s > 21.0, `${c.name} reaches south of 21°N — that is open ocean and disputed features`);
    assert.ok(w > 117.5, `${c.name} reaches west of 117.5°E`);
  }
});

test('the cover reaches every inhabited part of the country', () => {
  const inside = (lat, lng) => COVER.TW.some((c) => lat >= c.bbox[0] && lat <= c.bbox[2] && lng >= c.bbox[1] && lng <= c.bbox[3]);
  const places = [
    ['Taipei', 25.033, 121.565], ['Kaohsiung', 22.640, 120.302],
    ['Hengchun (southern tip)', 21.998, 120.744], ['Fugui Cape (northern tip)', 25.298, 121.537],
    ['Hualien', 23.976, 121.601], ['Lanyu / Orchid Island', 22.049, 121.541],
    ['Green Island', 22.661, 121.487], ['Magong, Penghu', 23.566, 119.566],
    ['Kinmen', 24.436, 118.317], ['Nangan, Matsu', 26.152, 119.939],
    ['Yushan summit', 23.470, 120.957], ['Douliu', 23.708, 120.543],
  ];
  for (const [name, lat, lng] of places) assert.ok(inside(lat, lng), `${name} is outside the cover`);
});

test('the cover excludes what it must', () => {
  const inside = (lat, lng) => COVER.TW.some((c) => lat >= c.bbox[0] && lat <= c.bbox[2] && lng >= c.bbox[1] && lng <= c.bbox[3]);
  assert.ok(!inside(20.70, 116.72), 'Pratas Island must not be in the cover');
  assert.ok(!inside(10.37, 114.36), 'Taiping Island must not be in the cover');
  assert.ok(!inside(25.05, 102.7), 'mainland China must not be in the cover');
});

test('gridFor tiles the whole cover and nothing else', () => {
  const g = gridFor('TW', 0.25);
  assert.ok(g.length > 100, `only ${g.length} tiles`);
  for (const t of g) {
    const home = COVER.TW.find((c) => c.name === t.name);
    assert.ok(t.bbox[0] >= home.bbox[0] && t.bbox[2] <= home.bbox[2]);
    assert.ok(t.bbox[1] >= home.bbox[1] && t.bbox[3] <= home.bbox[3]);
  }
  assert.deepEqual(gridFor('ZZ'), [], 'an unknown country yields no tiles, not a crash');
  assert.deepEqual(gridFor('tw', 0.25).length, g.length, 'country code is case-insensitive');
});

test('a smaller step means more tiles, never fewer', () => {
  assert.ok(gridFor('TW', 0.1).length > gridFor('TW', 0.25).length);
});

test('quoting survives an apostrophe', () => {
  assert.equal(q("Ah-Ming's"), "'Ah-Ming''s'");
  assert.equal(q(null), 'NULL');
  assert.equal(q(''), 'NULL', 'an empty string is absence, not a value');
});

test('a row round-trips into a tuple with its Chinese name intact', () => {
  const t = tuple(P);
  assert.ok(t.includes("'阿明豬心冬粉'"));
  assert.ok(t.includes("'Ah-Ming''s'"));
  assert.ok(t.includes('22.9908'));
  assert.ok(t.includes('NULL'), 'missing website must be NULL, not empty string');
});

test('buildSql upserts and never REPLACEs', () => {
  const sql = buildSql([P]);
  assert.ok(sql.startsWith(`INSERT INTO places (${COLS}) VALUES`));
  assert.ok(!/INSERT\s+OR\s+REPLACE/i.test(sql), 'REPLACE would delete the row and lose everything not in this insert');
  assert.ok(sql.includes('ON CONFLICT(id) DO UPDATE SET'));
});

test('the upsert never overwrites what a place has earned', () => {
  // These are set by enrichment, by claims, by bookings — never by OSM.
  for (const col of ['rating=', 'reviews=', 'photo_url=', 'status=', 'business_id=', 'num_rating']) {
    assert.ok(!UPSERT_TAIL.includes(col), `${col} must not appear in the upsert — a re-walk would erase it`);
  }
});

test('the upsert prefers a real value over a blanked OSM tag', () => {
  for (const col of ['phone', 'website', 'email', 'address', 'hours', 'cuisine', 'area', 'name_local']) {
    assert.ok(
      UPSERT_TAIL.includes(`${col}=COALESCE(excluded.${col}, places.${col})`),
      `${col} must fall back to the value we already hold`,
    );
  }
});

test('the upsert does overwrite what OSM owns', () => {
  for (const col of ['name', 'category', 'lat', 'lng', 'dest']) {
    assert.ok(new RegExp(`${col}=excluded\\.${col}`).test(UPSERT_TAIL), `${col} must track OSM`);
  }
});

test('statements are chunked so no single insert is unbounded', () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ ...P, id: `id${i}` }));
  const sql = buildSql(many, 100);
  assert.equal((sql.match(/INSERT INTO places/g) || []).length, 3);
});

test('buildSql on nothing produces nothing to run', () => {
  assert.equal(buildSql([]).trim(), '');
});

test('the destination registration parses as SQLite, not just as text', () => {
  // This exact statement failed on the Taiwan run, after all 183,095 rows had
  // already been written: SQLite cannot tell whether ON CONFLICT belongs to the
  // INSERT or to the SELECT feeding it, and says `near "DO": syntax error`.
  // Every place was in the database and every destination was invisible.
  const sql = registerDestinationsSql([
    { slug: 'kinmen', name: 'Kinmen', country: 'TW', region: 'Asia', lat: 24.437, lng: 118.317, bbox: [24.35, 118.13, 24.6, 118.55], tz: 'Asia/Taipei' },
  ]);
  assert.ok(/FROM incoming i WHERE true\s*\nON CONFLICT\(slug\) DO UPDATE SET/.test(sql),
    'ON CONFLICT after an INSERT…SELECT needs WHERE true to disambiguate');
});

test('registration reads its counts back from places, never from this process', () => {
  const sql = registerDestinationsSql([{ slug: 'a', name: 'A', country: 'TW', region: 'Asia', lat: 1, lng: 2, bbox: [1, 2, 3, 4], tz: 'Asia/Taipei' }]);
  // A partial run must report what is in the database, not what it sent.
  assert.ok(sql.includes('(SELECT COUNT(*) FROM places p WHERE p.dest = i.slug)'));
  assert.ok(sql.includes('live=excluded.live'), 'a destination with no places must not be live');
});

test('registration quotes names and refuses an empty list', () => {
  assert.equal(registerDestinationsSql([]), '');
  assert.equal(registerDestinationsSql(null), '');
  const sql = registerDestinationsSql([{ slug: 'x', name: "O'Brien Bay", country: 'TW', region: 'Asia', lat: 1, lng: 2, bbox: [1, 2, 3, 4], tz: 'Asia/Taipei' }]);
  assert.ok(sql.includes("'O''Brien Bay'"));
  assert.ok(sql.includes("'[1,2,3,4]'"), 'the bbox is stored as JSON text');
});
