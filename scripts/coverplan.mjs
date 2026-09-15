/**
 * NUM · the pure half of a country-wide ingest: where to walk, and what SQL
 * to write when you get there. No network, no database, no process.argv.
 */
import { tiles } from './osmplace.mjs';

/**
 * The land, and only the land.
 *
 * Kaohsiung municipality legally administers the Pratas and Taiping islands,
 * 1,300km out in the South China Sea, so its administrative envelope reaches
 * past the Philippines. A cover derived from official boundaries would ingest
 * a rectangle of open ocean plus a set of disputed features NUM has no
 * business asserting anything about. So the cover is written by hand, island
 * by island, and it stops at the water.
 */
/**
 * Country walk plans.
 *
 * A bbox here is a SEARCH AREA, not a border. Boxes overlap neighbouring
 * countries and that is fine — `assignDest` is given only this country's
 * destinations and a distance cap, so anything that lands over a border is
 * dropped rather than filed under the nearest city on our side. Without the
 * cap a hospital in Laos becomes a hospital "in" Chiang Mai, which for the
 * essentials selector is the worst thing this file could produce.
 *
 * Countries are added when there is a reason to walk them. Ordered here by
 * NUM's directory size so the reason is visible.
 */
export const COVER = Object.freeze({
  TW: Object.freeze([
    { name: 'Taiwan main island', bbox: [21.85, 120.00, 25.32, 122.03] },
    { name: 'Penghu', bbox: [23.15, 119.25, 23.85, 119.80] },
    { name: 'Kinmen', bbox: [24.35, 118.13, 24.60, 118.55] },
    { name: 'Matsu', bbox: [25.90, 119.85, 26.40, 120.55] },
  ]),
  TH: Object.freeze([
    { name: 'Thailand mainland', bbox: [5.60, 97.30, 20.50, 105.70] },
    { name: 'Phuket and Andaman', bbox: [6.90, 98.10, 9.20, 99.20] },
  ]),
  VN: Object.freeze([
    { name: 'Vietnam', bbox: [8.20, 102.10, 23.40, 109.50] },
  ]),
  JP: Object.freeze([
    { name: 'Japan main islands', bbox: [30.90, 129.30, 45.60, 146.00] },
    { name: 'Okinawa and Ryukyu', bbox: [24.00, 122.90, 27.10, 131.40] },
  ]),
  PH: Object.freeze([
    { name: 'Philippines', bbox: [4.60, 116.90, 21.20, 126.60] },
  ]),
  ID: Object.freeze([
    { name: 'Java and Bali', bbox: [-9.20, 105.00, -5.80, 116.00] },
    { name: 'Sumatra', bbox: [-6.00, 95.00, 6.10, 106.00] },
    { name: 'Sulawesi and east', bbox: [-11.00, 116.00, 5.00, 141.10] },
  ]),
  MY: Object.freeze([
    { name: 'Peninsular Malaysia', bbox: [1.20, 99.60, 6.75, 104.60] },
    { name: 'Malaysian Borneo', bbox: [0.85, 109.60, 7.40, 119.30] },
  ]),
  SG: Object.freeze([
    { name: 'Singapore', bbox: [1.15, 103.60, 1.48, 104.10] },
  ]),
  HK: Object.freeze([
    { name: 'Hong Kong', bbox: [22.15, 113.83, 22.57, 114.44] },
  ]),
  KR: Object.freeze([
    { name: 'South Korea', bbox: [33.10, 125.90, 38.62, 129.60] },
  ]),
  AE: Object.freeze([
    { name: 'United Arab Emirates', bbox: [22.60, 51.50, 26.10, 56.40] },
  ]),
  GB: Object.freeze([
    { name: 'Great Britain and Northern Ireland', bbox: [49.90, -8.70, 60.90, 1.80] },
  ]),
  ES: Object.freeze([
    { name: 'Spain mainland and Balearics', bbox: [35.90, -9.30, 43.80, 4.40] },
    { name: 'Canary Islands', bbox: [27.60, -18.20, 29.50, -13.40] },
  ]),
  IT: Object.freeze([
    { name: 'Italy', bbox: [36.60, 6.60, 47.10, 18.60] },
  ]),
  FR: Object.freeze([
    { name: 'France mainland and Corsica', bbox: [41.30, -5.20, 51.10, 9.60] },
  ]),
  PT: Object.freeze([
    { name: 'Portugal mainland', bbox: [36.90, -9.60, 42.20, -6.15] },
    { name: 'Madeira', bbox: [32.60, -17.30, 33.15, -16.25] },
  ]),
  GR: Object.freeze([
    { name: 'Greece and the islands', bbox: [34.80, 19.30, 41.80, 29.70] },
  ]),
  TR: Object.freeze([
    { name: 'Turkey', bbox: [35.80, 25.60, 42.15, 44.85] },
  ]),
  US: Object.freeze([
    { name: 'Continental United States', bbox: [24.50, -125.00, 49.40, -66.90] },
    { name: 'Hawaii', bbox: [18.90, -160.30, 22.30, -154.70] },
    { name: 'Alaska south', bbox: [54.50, -168.00, 62.00, -130.00] },
  ]),
});

/**
 * The essentials walk goes where the travellers are, not where the border is.
 *
 * A country-wide walk of Thailand at 0.25° is 2,040 tiles and around eleven
 * hours, and `assignDest`'s 200km cap then throws away nearly all of it —
 * we would be paying a public Overpass mirror for tiles we have already
 * decided not to keep.
 *
 * So for essentials the grid is built from the DESTINATIONS themselves, each
 * padded outward. The padding is the point: somebody in Phuket town needs the
 * hospital at the north of the island, and a destination bbox is a
 * neighbourhood, not a catchment. `pad` is in degrees — 0.45° is roughly
 * 50km, comfortably inside the cap that decides what is kept anyway.
 *
 * This is not a smaller version of the country walk. It is the right shape
 * for the question: the nearest chemist matters within a few kilometres of
 * where somebody is standing, and nowhere else.
 */
export const essentialsGridFor = (country, step = 0.25, dests = [], pad = 0.45) => {
  const cc = String(country).toUpperCase();
  const mine = dests.filter((d) => String(d.country).toUpperCase() === cc && Array.isArray(d.bbox));
  // Padded destinations overlap heavily where a country has many of them —
  // Taiwan has 28, and without this the "cheaper" plan came out at 866 tiles
  // against a country walk's 143. Deduped on the tile itself, first
  // destination wins the label.
  const seen = new Map();
  for (const d of mine) {
    const [s0, w0, n0, e0] = d.bbox;
    const box = [
      Math.max(-90, s0 - pad), Math.max(-180, w0 - pad),
      Math.min(90, n0 + pad), Math.min(180, e0 + pad),
    ];
    for (const t of tiles(box, step)) {
      const key = t.map((n) => n.toFixed(4)).join(',');
      if (!seen.has(key)) seen.set(key, { name: d.slug, bbox: t });
    }
  }
  return [...seen.values()];
};

export const gridFor = (country, step = 0.25) =>
  (COVER[String(country).toUpperCase()] || [])
    .flatMap((c) => tiles(c.bbox, step).map((t) => ({ name: c.name, bbox: t })));

export const COLS = 'id,name,name_local,category,lat,lng,cell_lat,cell_lng,dest,area,country,region,'
  + 'phone,website,email,address,hours,cuisine,rating,reviews,source,status';

export const q = (v) => (v == null || v === '') ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
export const num = (v) => (v == null || v === '' || Number.isNaN(Number(v))) ? 'NULL' : Number(v);

export const tuple = (p) => '(' + [
  q(p.id), q(p.name), q(p.name_local), q(p.category), num(p.lat), num(p.lng),
  p.cell_lat, p.cell_lng, q(p.dest), q(p.area), q(p.country), q(p.region),
  q(p.phone), q(p.website), q(p.email), q(p.address), q(p.hours), q(p.cuisine),
  num(p.rating), num(p.reviews) || 0, q(p.source), q(p.status),
].join(',') + ')';

/**
 * Upsert, not REPLACE.
 *
 * INSERT OR REPLACE throws away everything a row has learned since it was
 * ingested — its rating, its photo, its claim, its booking link — every time
 * the tile it lives in is re-walked. OSM columns are overwritten because OSM
 * is their source of truth; everything NUM earned is left alone, and a field
 * OSM has since blanked keeps the value we already had rather than losing it
 * to an empty tag.
 */
export const UPSERT_TAIL = `
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name,
  name_local=COALESCE(excluded.name_local, places.name_local),
  category=excluded.category,
  lat=excluded.lat, lng=excluded.lng,
  cell_lat=excluded.cell_lat, cell_lng=excluded.cell_lng,
  dest=excluded.dest, country=excluded.country, region=excluded.region,
  area=COALESCE(excluded.area, places.area),
  phone=COALESCE(excluded.phone, places.phone),
  website=COALESCE(excluded.website, places.website),
  email=COALESCE(excluded.email, places.email),
  address=COALESCE(excluded.address, places.address),
  hours=COALESCE(excluded.hours, places.hours),
  cuisine=COALESCE(excluded.cuisine, places.cuisine),
  updated_at=datetime('now')`;

export function buildSql(places, rowsPerStmt = 100) {
  const stmts = [];
  for (let i = 0; i < places.length; i += rowsPerStmt) {
    stmts.push(`INSERT INTO places (${COLS}) VALUES\n`
      + places.slice(i, i + rowsPerStmt).map(tuple).join(',\n')
      + UPSERT_TAIL + ';');
  }
  return stmts.join('\n\n') + '\n';
}

/**
 * Register a country's destinations with counts read back from `places`.
 *
 * The counts are read back rather than counted in the ingest process, so a
 * partial run reports what is actually in the database instead of what that
 * run happened to send. A place with no row here is invisible: the hub does
 * not list it, destpage.mjs will not build it, and the concierge cannot
 * resolve its name.
 *
 * The `WHERE true` is not decoration. SQLite cannot tell whether `ON CONFLICT`
 * belongs to the INSERT or to the SELECT that feeds it, and answers the
 * ambiguity with `near "DO": syntax error`. This statement failed exactly that
 * way on the Taiwan run, after every row had already been written — the data
 * was fine and the destinations were invisible.
 */
export function registerDestinationsSql(dests) {
  if (!dests?.length) return '';
  const rows = dests.map((d) => `(${q(d.slug)},${q(d.name)},${q(d.country)},${q(d.region)},`
    + `${Number(d.lat)},${Number(d.lng)},${q(JSON.stringify(d.bbox))},${q(d.tz)})`).join(',\n  ');
  return `WITH incoming(slug,name,country,region,lat,lng,bbox,tz) AS (VALUES\n  ${rows}\n)
INSERT INTO destinations (slug,name,country,region,lat,lng,bbox,tz,live,place_count,last_ingest_at)
SELECT i.slug, i.name, i.country, i.region, i.lat, i.lng, i.bbox, i.tz,
       CASE WHEN (SELECT COUNT(*) FROM places p WHERE p.dest = i.slug) > 0 THEN 1 ELSE 0 END,
       (SELECT COUNT(*) FROM places p WHERE p.dest = i.slug),
       datetime('now')
  FROM incoming i WHERE true
ON CONFLICT(slug) DO UPDATE SET
  name=excluded.name, country=excluded.country, region=excluded.region,
  lat=excluded.lat, lng=excluded.lng, bbox=excluded.bbox, tz=excluded.tz,
  live=excluded.live, place_count=excluded.place_count, last_ingest_at=excluded.last_ingest_at;`;
}
