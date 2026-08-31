import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignDest, boxArea, distKm, inBox, normalise, pid, tiles,
  CORE_QUERY, FULL_QUERY, NOT_A_BUSINESS, NOT_A_VENUE, CATMAP, WORSHIP, isBusiness,
} from './osmplace.mjs';

const TAIPEI = { slug: 'taipei', country: 'TW', region: 'Asia', bbox: [24.99, 121.49, 25.10, 121.62], lat: 25.04, lng: 121.56 };
const NEWTAIPEI = { slug: 'new-taipei', country: 'TW', region: 'Asia', bbox: [24.67, 121.28, 25.30, 122.01], lat: 25.01, lng: 121.62 };
const TAMSUI = { slug: 'tamsui', country: 'TW', region: 'Asia', bbox: [25.14, 121.41, 25.20, 121.47], lat: 25.17, lng: 121.44 };
const TAITUNG = { slug: 'taitung', country: 'TW', region: 'Asia', bbox: [22.65, 120.95, 23.15, 121.25], lat: 22.75, lng: 121.14 };
const TW = [TAIPEI, NEWTAIPEI, TAMSUI, TAITUNG];

test('pid is stable and location-bound', () => {
  assert.equal(pid('osm', 'Din Tai Fung', 25.03306, 121.5654), pid('osm', ' din tai fung ', 25.03306, 121.5654));
  assert.notEqual(pid('osm', 'Din Tai Fung', 25.03306, 121.5654), pid('osm', 'Din Tai Fung', 25.1, 121.5654));
});

test('pid survives the two ingest paths finding the same shop', () => {
  // The city box and the county tile both return it. One row, not two.
  const viaCity = pid('osm', '7-ELEVEN', 25.0412, 121.5088);
  const viaTile = pid('osm', '7-eleven', 25.04120, 121.50880);
  assert.equal(viaCity, viaTile);
});

test('the smallest containing box wins', () => {
  // Tamsui sits inside New Taipei. A traveller says Tamsui.
  assert.equal(assignDest(25.17, 121.44, TW).slug, 'tamsui');
  assert.equal(assignDest(25.04, 121.56, TW).slug, 'taipei');
});

test('a point in no box still gets a home', () => {
  // Rural Taitung county, outside every rectangle. Full coverage means
  // nothing is dropped, not that every point sits inside a drawn box.
  const d = assignDest(23.05, 121.15, TW);
  assert.ok(d, 'a point outside every box must still be assigned');
  assert.equal(d.slug, 'taitung');
});

test('assignDest never invents a destination', () => {
  assert.equal(assignDest(25, 121, []), null);
  assert.equal(assignDest(25, 121, null), null);
});

test('assignDest ignores malformed boxes rather than throwing', () => {
  const bad = [{ slug: 'broken', bbox: [1, 2] }, TAIPEI];
  assert.equal(assignDest(25.04, 121.56, bad).slug, 'taipei');
});

test('inBox and boxArea agree on containment ordering', () => {
  assert.ok(inBox(25.17, 121.44, TAMSUI.bbox));
  assert.ok(!inBox(25.17, 121.44, TAIPEI.bbox));
  assert.ok(boxArea(TAMSUI.bbox) < boxArea(NEWTAIPEI.bbox));
});

test('distKm is right to within a percent over Taiwan', () => {
  // Taipei 101 to Kaohsiung station, ~296km great-circle.
  const km = distKm(25.0339, 121.5645, 22.6396, 120.3021);
  assert.ok(km > 290 && km < 302, `got ${km}`);
});

test('tiles cover the whole box and never overshoot it', () => {
  const b = [21.85, 120.0, 25.32, 122.02];
  const ts = tiles(b, 0.25);
  assert.ok(ts.length > 100);
  for (const t of ts) {
    assert.ok(t[0] >= b[0] && t[2] <= b[2], `lat out of range: ${t}`);
    assert.ok(t[1] >= b[1] && t[3] <= b[3], `lng out of range: ${t}`);
  }
  // south-west corner is the box corner; the far edges are clamped to it
  assert.deepEqual(ts[0].slice(0, 2), [21.85, 120]);
  assert.equal(Math.max(...ts.map((t) => t[2])), 25.32);
  assert.equal(Math.max(...ts.map((t) => t[3])), 122.02);
});

test('tiles refuses a degenerate box instead of looping forever', () => {
  assert.deepEqual(tiles([25, 121, 25, 121]), []);
  assert.deepEqual(tiles([25, 121, 26, 122], 0), []);
});

test('a tile never exceeds the requested step', () => {
  for (const t of tiles([21.85, 120.0, 25.32, 122.02], 0.25)) {
    assert.ok(t[2] - t[0] <= 0.2501, `tall tile ${t}`);
    assert.ok(t[3] - t[1] <= 0.2501, `wide tile ${t}`);
  }
});

test('normalise reads a Taiwanese convenience store', () => {
  const p = normalise({
    type: 'node', lat: 25.0412, lon: 121.5088,
    tags: { name: '7-ELEVEN', 'name:zh': '統一超商', shop: 'convenience', 'addr:district': '中正區', phone: '+886 2 1234 5678' },
  }, TAIPEI, (t) => t['name:zh'] || null);
  assert.equal(p.category, 'Convenience');
  assert.equal(p.name_local, '統一超商');
  assert.equal(p.dest, 'taipei');
  assert.equal(p.country, 'TW');
  assert.equal(p.area, '中正區');
  assert.equal(p.cell_lat, 250);
  assert.equal(p.cell_lng, 1215);
  assert.equal(p.source, 'osm');
});

test('a temple is a Temple, not a Place Of Worship', () => {
  const p = normalise({ lat: 25.0375, lon: 121.5099, tags: { name: 'Longshan Temple', amenity: 'place_of_worship', religion: 'taoist' } }, TAIPEI);
  assert.equal(p.category, 'Temple');
});

test('an unmapped religion still lands somewhere honest', () => {
  const p = normalise({ lat: 25, lon: 121.5, tags: { name: 'X', amenity: 'place_of_worship' } }, TAIPEI);
  assert.equal(p.category, 'Place of worship');
});

test('normalise refuses what is not a place', () => {
  assert.equal(normalise({ lat: 25, lon: 121, tags: { amenity: 'cafe' } }, TAIPEI), null, 'no name');
  assert.equal(normalise({ tags: { name: 'X', amenity: 'cafe' } }, TAIPEI), null, 'no location');
  assert.equal(normalise({ lat: 25, lon: 121, tags: { name: 'X' } }, null), null, 'no destination');
  assert.equal(normalise(null, TAIPEI), null);
});

test('a way with only a center is read', () => {
  const p = normalise({ type: 'way', center: { lat: 25.04, lon: 121.56 }, tags: { name: 'Mall', shop: 'mall' } }, TAIPEI);
  assert.equal(p.category, 'Shopping');
  assert.equal(p.lat, 25.04);
});

test('offices and crafts get a readable category', () => {
  assert.equal(normalise({ lat: 25, lon: 121.5, tags: { name: 'A', office: 'travel_agent' } }, TAIPEI).category, 'Tours & travel');
  assert.equal(normalise({ lat: 25, lon: 121.5, tags: { name: 'B', office: 'lawyer' } }, TAIPEI).category, 'Lawyer');
  assert.equal(normalise({ lat: 25, lon: 121.5, tags: { name: 'C', craft: 'brewery' } }, TAIPEI).category, 'Brewery');
});

test('empty contact fields become null, not empty strings', () => {
  const p = normalise({ lat: 25, lon: 121.5, tags: { name: 'A', shop: 'books' } }, TAIPEI);
  assert.equal(p.phone, null);
  assert.equal(p.website, null);
  assert.equal(p.email, null);
  assert.equal(p.address, null);
  assert.equal(p.hours, null);
});

test('the full query asks for whole tag families and never negates', () => {
  const q = FULL_QUERY('1,2,3,4');
  for (const fam of ['amenity', 'shop', 'office', 'craft', 'healthcare', 'tourism', 'leisure', 'historic']) {
    assert.ok(q.includes(`nwr["${fam}"]["name"]`), `${fam} missing`);
  }
  // A negated regex makes the server test every amenity in the tile, and
  // public mirrors answer a whole-island run of that with 504s. Measured.
  assert.ok(!q.includes('!~'), 'no negation belongs in the query');
  // The reasons people travel, not only the places they spend.
  for (const fam of ['"natural"="beach"', '"waterway"="waterfall"', '"boundary"="national_park"']) {
    assert.ok(q.includes(fam), `${fam} missing — a beach destination with no beaches happened once already`);
  }
});

test('street furniture is rejected on arrival', () => {
  for (const junk of ['bench', 'waste_basket', 'bicycle_parking', 'toilets', 'vending_machine', 'parking']) {
    assert.equal(isBusiness({ amenity: junk }), false, `${junk} is not a business`);
  }
  for (const junk of ['pitch', 'playground', 'picnic_table']) {
    assert.equal(isBusiness({ leisure: junk }), false, `${junk} is not a venue`);
  }
  assert.equal(isBusiness({ shop: 'vacant' }), false, 'an empty unit is not a business');
});

test('what a traveller actually needs is kept', () => {
  // A named bench is still a bench. A named ATM is a thing somebody is
  // looking for at midnight.
  for (const keep of ['atm', 'fuel', 'car_wash', 'pharmacy', 'post_office', 'clinic', 'place_of_worship', 'bank']) {
    assert.equal(isBusiness({ amenity: keep }), true, `${keep} must be kept`);
  }
  assert.equal(isBusiness({ leisure: 'sports_centre' }), true);
  assert.equal(isBusiness({ office: 'lawyer' }), true);
  assert.equal(isBusiness({ craft: 'brewery' }), true);
  assert.equal(isBusiness({ healthcare: 'physiotherapist' }), true);
  assert.equal(isBusiness({ historic: 'city_gate' }), true);
});

test('a signpost is not an attraction, but a tourist office is', () => {
  assert.equal(isBusiness({ tourism: 'information', information: 'guidepost' }), false);
  assert.equal(isBusiness({ tourism: 'information', information: 'map' }), false);
  assert.equal(isBusiness({ tourism: 'information' }), false);
  assert.equal(isBusiness({ tourism: 'information', information: 'office' }), true);
});

test('a row with nothing but a name is a label, not a place', () => {
  assert.equal(isBusiness({ name: 'Somewhere' }), false);
  assert.equal(isBusiness({}), false);
  assert.equal(isBusiness(null), false);
});

test('normalise refuses the junk isBusiness rejects', () => {
  const bench = normalise({ lat: 25, lon: 121.5, tags: { name: 'Riverside bench', amenity: 'bench' } }, { slug: 'taipei', country: 'TW', region: 'Asia' });
  assert.equal(bench, null, 'a named bench must never reach the database');
});

test('the full query is a superset of the core one', () => {
  const full = FULL_QUERY('1,2,3,4');
  for (const fam of ['amenity', 'shop', 'tourism', 'leisure', 'office']) {
    assert.ok(full.includes(`nwr["${fam}"]["name"]`), `${fam} missing from the full query`);
  }
  assert.ok(CORE_QUERY('1,2,3,4').includes('restaurant|cafe|bar'));
});

test('every query stays under the Overpass element cap', () => {
  for (const q of [CORE_QUERY('1,2,3,4'), FULL_QUERY('1,2,3,4')]) {
    assert.match(q, /out center 20000;/);
  }
});

test('category maps stay honest', () => {
  assert.equal(CATMAP.convenience, 'Convenience');
  assert.equal(WORSHIP.taoist, 'Temple');
  // Taiwan is Traditional-Chinese speaking; nothing here should assume otherwise.
  assert.equal(Object.values(CATMAP).filter((v) => /[一-鿿]/.test(v)).length, 0);
});
