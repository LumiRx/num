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
export const COVER = Object.freeze({
  TW: Object.freeze([
    { name: 'Taiwan main island', bbox: [21.85, 120.00, 25.32, 122.03] },
    { name: 'Penghu', bbox: [23.15, 119.25, 23.85, 119.80] },
    { name: 'Kinmen', bbox: [24.35, 118.13, 24.60, 118.55] },
    { name: 'Matsu', bbox: [25.90, 119.85, 26.40, 120.55] },
  ]),
});

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
