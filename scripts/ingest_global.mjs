#!/usr/bin/env node
/**
 * NUM · global place ingestion → Cloudflare D1
 *
 * Source: OpenStreetMap via Overpass API (ODbL, free, no scraping).
 * Writes into the `places` table, which the console and the AI concierge both read.
 *
 * Must run on a machine with real internet + an authenticated wrangler
 * (the Cowork sandbox cannot reach overpass-api.de).
 *
 *   node ingest_global.mjs                     # every destination not yet ingested
 *   node ingest_global.mjs --only=rome,paris   # just these
 *   node ingest_global.mjs --region=Europe     # whole region
 *   node ingest_global.mjs --force             # re-ingest even if already done
 *   node ingest_global.mjs --dry               # fetch + build SQL, don't write to D1
 *   node ingest_global.mjs --from-json=public/console/directory.json --dest=phuket
 *                                              # backfill an existing directory.json
 *                                              # (keeps its Google ratings/reviews)
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DESTINATIONS, bySlug } from './destinations.mjs';

const DB = 'num-db';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OUT = 'sql';
const STATE = '.ingest_state.json';
const ROWS_PER_STMT = 100;

const argv = process.argv.slice(2);
const flag = k => argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const has  = k => argv.includes(`--${k}`);
const ONLY = flag('only')?.split(',').map(s => s.trim()).filter(Boolean);
const REGION = flag('region');
const FROM_JSON = flag('from-json');
const JSON_DEST = flag('dest');
const FORCE = has('force'), DRY = has('dry');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const saveState = () => writeFileSync(STATE, JSON.stringify(state, null, 1));

// ── category normalisation ───────────────────────────────────────────
const CATMAP = {
  restaurant:'Restaurant', cafe:'Café', bar:'Bar', pub:'Bar', biergarten:'Bar', nightclub:'Nightlife',
  fast_food:'Street food', food_court:'Street food', ice_cream:'Dessert', marketplace:'Market',
  pharmacy:'Pharmacy', car_rental:'Vehicle rental', bicycle_rental:'Vehicle rental',
  boat_rental:'Boat charter', casino:'Nightlife', theatre:'Theatre', cinema:'Cinema',
  hotel:'Hotel', hostel:'Hostel', guest_house:'Guesthouse', apartment:'Apartment',
  resort:'Resort', attraction:'Attraction', museum:'Museum', gallery:'Gallery',
  theme_park:'Theme park', zoo:'Zoo', aquarium:'Aquarium', viewpoint:'Viewpoint',
  artwork:'Attraction', information:'Attraction',
  massage:'Massage & spa', beauty:'Beauty & spa', hairdresser:'Beauty & spa',
  scuba_diving:'Diving', motorcycle:'Vehicle rental', tailor:'Tailor', gift:'Souvenirs & gifts',
  bakery:'Bakery', confectionery:'Dessert', deli:'Deli', greengrocer:'Market',
  wine:'Wine & spirits', alcohol:'Wine & spirits', supermarket:'Supermarket',
  convenience:'Convenience', clothes:'Shopping', shoes:'Shopping', jewelry:'Shopping',
  books:'Shopping', department_store:'Shopping', mall:'Shopping',
  spa:'Massage & spa', fitness_centre:'Gym & fitness', sports_centre:'Gym & fitness',
  water_park:'Water park', golf_course:'Golf', marina:'Marina & charters',
  beach_resort:'Beach club', dance:'Nightlife', travel_agency:'Tours & travel',
  attraction_yes:'Attraction',
};
const titled = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

const OVERPASS_QUERY = bbox => `[out:json][timeout:180];
(
  nwr["amenity"~"^(restaurant|cafe|bar|pub|biergarten|fast_food|food_court|ice_cream|nightclub|marketplace|pharmacy|car_rental|bicycle_rental|boat_rental|casino|theatre|cinema)$"]["name"](${bbox});
  nwr["tourism"~"^(hotel|hostel|guest_house|apartment|resort|attraction|museum|gallery|theme_park|zoo|aquarium|viewpoint)$"]["name"](${bbox});
  nwr["shop"~"^(massage|beauty|hairdresser|scuba_diving|motorcycle|tailor|gift|bakery|confectionery|deli|greengrocer|wine|alcohol|supermarket|convenience|clothes|shoes|jewelry|books|department_store|mall|travel_agency)$"]["name"](${bbox});
  nwr["leisure"~"^(spa|fitness_centre|sports_centre|water_park|golf_course|marina|beach_resort|dance)$"]["name"](${bbox});
  nwr["office"="travel_agent"]["name"](${bbox});
  nwr["club"="scuba_diving"]["name"](${bbox});
);
out center 20000;`;

async function overpass(bbox) {
  const body = 'data=' + encodeURIComponent(OVERPASS_QUERY(bbox.join(',')));
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'NUM-by-5arz/1.0 (info@5arz.com)' },
        body,
      });
      if (res.status === 429 || res.status === 504) {
        const wait = 20000 * (attempt + 1);
        console.log(`    ⏳ ${res.status} from ${new URL(url).host} — backing off ${wait / 1000}s`);
        await sleep(wait); continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.log(`    ⚠ ${new URL(url).host}: ${e.message} (attempt ${attempt + 1}/6)`);
      await sleep(10000 * (attempt + 1));
    }
  }
  throw new Error('Overpass unreachable after 6 attempts');
}

const pid = (source, name, lat, lng) =>
  createHash('sha1').update(`${source}|${String(name).toLowerCase().trim()}|${(+lat).toFixed(4)}|${(+lng).toFixed(4)}`)
    .digest('hex').slice(0, 20);

function normalise(el, dest) {
  const t = el.tags || {};
  const name = t.name || t['name:en']; if (!name) return null;
  const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) return null;

  const raw = t.amenity || t.tourism || t.shop || t.leisure
    || (t.office === 'travel_agent' ? 'travel_agency' : null)
    || (t.club === 'scuba_diving' ? 'scuba_diving' : 'business');

  const area = t['addr:suburb'] || t['addr:district'] || t['addr:neighbourhood']
    || t['addr:quarter'] || t['addr:city'] || t['addr:town'] || null;

  const address = [t['addr:housenumber'], t['addr:street'], t['addr:postcode'], t['addr:city']]
    .filter(Boolean).join(' ') || null;

  const localName = Object.keys(t).filter(k => k.startsWith('name:') && k !== 'name:en')
    .map(k => t[k]).find(v => v && v !== name) || null;

  return {
    id: pid('osm', name, lat, lng),
    name, name_local: localName,
    category: CATMAP[raw] || titled(raw),
    lat: +(+lat).toFixed(5), lng: +(+lng).toFixed(5),
    cell_lat: Math.floor(lat * 10), cell_lng: Math.floor(lng * 10),
    dest: dest.slug, area, country: dest.country, region: dest.region,
    phone: t.phone || t['contact:phone'] || null,
    website: t.website || t['contact:website'] || null,
    email: t.email || t['contact:email'] || null,
    address, hours: t.opening_hours || null, cuisine: t.cuisine || null,
    rating: null, reviews: 0, source: 'osm', status: 'unclaimed',
  };
}

// ── SQL emit ─────────────────────────────────────────────────────────
const COLS = '(id,name,name_local,category,lat,lng,cell_lat,cell_lng,dest,area,country,region,phone,website,email,address,hours,cuisine,rating,reviews,source,status)';
const q = v => (v == null || v === '') ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'";
const num = v => (v == null || v === '' || isNaN(v)) ? 'NULL' : Number(v);
const tuple = p => '(' + [
  q(p.id), q(p.name), q(p.name_local), q(p.category), num(p.lat), num(p.lng),
  p.cell_lat, p.cell_lng, q(p.dest), q(p.area), q(p.country), q(p.region),
  q(p.phone), q(p.website), q(p.email), q(p.address), q(p.hours), q(p.cuisine),
  num(p.rating), num(p.reviews) || 0, q(p.source), q(p.status),
].join(',') + ')';

function writeSql(slug, places) {
  mkdirSync(OUT, { recursive: true });
  const stmts = [];
  for (let i = 0; i < places.length; i += ROWS_PER_STMT) {
    stmts.push(`INSERT OR REPLACE INTO places ${COLS} VALUES\n` +
      places.slice(i, i + ROWS_PER_STMT).map(tuple).join(',\n') + ';');
  }
  const file = `${OUT}/${slug}.sql`;
  writeFileSync(file, stmts.join('\n\n') + '\n');
  return file;
}

function d1(file) {
  // Back-to-back `npx wrangler` invocations occasionally collide on the npx/wrangler
  // cache lock and exit non-zero without ever reaching D1 — retry rather than lose a run.
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      execFileSync('npx', ['wrangler@latest', 'd1', 'execute', DB, '--remote', `--file=${file}`, '-y'],
        { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, encoding: 'utf8' });
      return;
    } catch (e) {
      lastErr = e;
      const detail = (e.stderr || e.stdout || '').toString().trim().split('\n').slice(-3).join(' | ');
      console.log(`    ⚠ d1 execute failed (attempt ${attempt}/4)${detail ? ': ' + detail : ''}`);
      if (attempt < 4) execFileSync('sleep', ['6']);
    }
  }
  throw lastErr;
}

function d1Command(sql) {
  const f = `${OUT}/_cmd.sql`;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(f, sql);
  d1(f);
}

function upsertDestination(d, count) {
  d1Command(`INSERT INTO destinations (slug,name,country,region,lat,lng,bbox,tz,live,place_count,last_ingest_at)
VALUES (${q(d.slug)},${q(d.name)},${q(d.country)},${q(d.region)},${d.lat},${d.lng},${q(JSON.stringify(d.bbox))},${q(d.tz)},${count > 0 ? 1 : 0},${count},datetime('now'))
ON CONFLICT(slug) DO UPDATE SET name=excluded.name,country=excluded.country,region=excluded.region,
 lat=excluded.lat,lng=excluded.lng,bbox=excluded.bbox,tz=excluded.tz,live=excluded.live,
 place_count=excluded.place_count,last_ingest_at=excluded.last_ingest_at;`);
}

// ── mode: backfill from an existing directory.json ───────────────────
if (FROM_JSON) {
  const dest = bySlug[JSON_DEST];
  if (!dest) { console.error(`--dest=${JSON_DEST} is not in destinations.mjs`); process.exit(1); }
  const data = JSON.parse(readFileSync(FROM_JSON, 'utf8'));
  const seen = new Set(), places = [];
  for (const b of data.businesses || []) {
    if (!b.name || b.lat == null || b.lng == null) continue;
    const id = pid(b.source || 'osm', b.name, b.lat, b.lng);
    if (seen.has(id)) continue; seen.add(id);
    places.push({
      id, name: b.name, name_local: b.name_th || null, category: b.category || null,
      lat: +(+b.lat).toFixed(5), lng: +(+b.lng).toFixed(5),
      cell_lat: Math.floor(b.lat * 10), cell_lng: Math.floor(b.lng * 10),
      dest: dest.slug, area: b.area || null, country: dest.country, region: dest.region,
      phone: b.phone || null, website: b.website || null, email: b.email || null,
      address: b.address || null, hours: b.hours || null, cuisine: b.cuisine || null,
      rating: b.google_rating ?? null, reviews: b.google_reviews ?? 0,
      source: b.source || 'osm', status: b.status || 'unclaimed',
    });
  }
  const file = writeSql(dest.slug, places);
  console.log(`${dest.name}: ${places.length} places → ${file}`);
  if (!DRY) { d1(file); upsertDestination(dest, places.length); console.log('  ✓ written to D1'); }
  process.exit(0);
}

// ── mode: Overpass ingestion ─────────────────────────────────────────
let targets = DESTINATIONS;
if (ONLY) targets = targets.filter(d => ONLY.includes(d.slug));
if (REGION) targets = targets.filter(d => d.region.toLowerCase() === REGION.toLowerCase());
if (!FORCE) targets = targets.filter(d => !state[d.slug]?.ok);

if (!targets.length) { console.log('Nothing to do (use --force to re-ingest).'); process.exit(0); }
console.log(`Ingesting ${targets.length} destination(s): ${targets.map(d => d.slug).join(', ')}\n`);

let grand = 0;
for (const [i, d] of targets.entries()) {
  console.log(`[${i + 1}/${targets.length}] ${d.name} (${d.country})`);
  try {
    const j = await overpass(d.bbox);
    const seen = new Set(), places = [];
    for (const el of j.elements || []) {
      const p = normalise(el, d); if (!p) continue;
      if (seen.has(p.id)) continue; seen.add(p.id); places.push(p);
    }
    places.sort((a, b) => a.name.localeCompare(b.name));
    console.log(`    ${places.length} named places`);
    if (!places.length) { state[d.slug] = { ok: false, count: 0, note: 'empty result' }; saveState(); continue; }

    const file = writeSql(d.slug, places);
    if (!DRY) { d1(file); upsertDestination(d, places.length); }
    state[d.slug] = { ok: !DRY, count: places.length, at: new Date().toISOString() };
    saveState();
    grand += places.length;
    console.log(`    ✓ ${DRY ? 'built' : 'written to D1'}\n`);
  } catch (e) {
    console.log(`    ✗ ${d.slug}: ${e.message}\n`);
    state[d.slug] = { ok: false, error: e.message };
    saveState();
  }
  if (i < targets.length - 1) await sleep(8000); // be a good Overpass citizen
}

console.log(`\n✅ ${grand} places across ${targets.filter(d => state[d.slug]?.ok).length} destinations`);
console.log('   Re-run any time — ids are stable, so it upserts instead of duplicating.');
