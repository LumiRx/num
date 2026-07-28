#!/usr/bin/env node
/**
 * NUM · Overture Maps places ingestion → Cloudflare D1
 *
 * Overture is the open map data foundation run by Meta, Microsoft, Amazon, TomTom
 * and Esri. Its Places theme merges Meta, Microsoft, Foursquare, AllThePlaces,
 * PinMeTo and others into one deduplicated POI set — roughly 10× the coverage of
 * raw OpenStreetMap in the cities we care about, and far better contact data.
 *
 *   Phuket:  OSM 3,968 places / 1,386 phones   →  Overture 41,370 / 30,847
 *   Bath:    OSM 1,119 places /    98 phones   →  Overture  6,677 /  5,936
 *
 * Licensing — the Places theme is per-record, not one blanket licence:
 *   CDLA-Permissive-2.0 · Apache-2.0 (Foursquare) · CC0-1.0 (AllThePlaces)
 * All three allow commercial use with attribution and none are share-alike, so
 * unlike ODbL there is no obligation to open our own database. The extractor
 * rejects any record carrying a licence outside that list, and we keep the
 * source datasets on every row so the console can attribute properly.
 *
 * What Overture does NOT give us: local-script names (`names.common` is empty
 * across both Bath and Phuket) and any kind of review score. OSM stays the
 * source for Thai/Japanese/Greek names, Google stays the source for ratings.
 * This is additive, never a replacement.
 *
 *   node ingest_overture.mjs                    # every destination in destinations.mjs
 *   node ingest_overture.mjs --only=phuket,bath
 *   node ingest_overture.mjs --region=Europe
 *   node ingest_overture.mjs --dry              # extract + build SQL, don't touch D1
 *   node ingest_overture.mjs --enrich-only      # never insert, only fill gaps
 *   node ingest_overture.mjs --min-confidence=0.5
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DESTINATIONS, bySlug } from './destinations.mjs';

const DB = 'num-db';
const OUT = 'sql';
const TMP = '/tmp/num-overture';
const STATE = '.overture_state.json';
const ROWS_PER_STMT = 100;
const MATCH_METRES = 180;

const argv = process.argv.slice(2);
const flag = k => argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const has  = k => argv.includes(`--${k}`);
const ONLY = flag('only')?.split(',').map(s => s.trim()).filter(Boolean);
const REGION = flag('region');
const RELEASE = flag('release') || '2026-07-22.0';
const MINCONF = Number(flag('min-confidence') || 0);
const DRY = has('dry'), ENRICH_ONLY = has('enrich-only'), FORCE = has('force');

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const saveState = () => writeFileSync(STATE, JSON.stringify(state, null, 1));

// ── category normalisation ───────────────────────────────────────────
// Overture uses a Foursquare-derived vocabulary. Map the ones that matter onto
// the words `places.js` already searches for; titleise the long tail, which is
// mostly "italian_restaurant" / "sushi_restaurant" shapes that match anyway.
const CATMAP = {
  restaurant: 'Restaurant', eat_and_drink: 'Restaurant', fast_food_restaurant: 'Street food',
  food_court: 'Street food', food_stand: 'Street food', street_vendor: 'Street food',
  cafe: 'Café', coffee_shop: 'Café', tea_room: 'Café', bakery: 'Bakery',
  breakfast_and_brunch_restaurant: 'Café · breakfast',
  desserts: 'Dessert', ice_cream_shop: 'Dessert', juice_bar_and_smoothies: 'Café',
  bar: 'Bar', pub: 'Bar', beer_bar: 'Bar', wine_bar: 'Bar', cocktail_bar: 'Bar',
  brewery: 'Bar · brewery', sports_bar: 'Bar', night_club: 'Nightlife',
  dance_club: 'Nightlife', karaoke: 'Nightlife', lounge: 'Bar · lounge',

  hotel: 'Hotel', resort: 'Resort', hostel: 'Hostel', accommodation: 'Hotel',
  bed_and_breakfast: 'Guesthouse', guest_house: 'Guesthouse',
  holiday_rental_home: 'Apartment', vacation_rental: 'Apartment', motel: 'Hotel',

  spas: 'Massage & spa', spa: 'Massage & spa', massage: 'Massage & spa',
  massage_therapy: 'Massage & spa', beauty_and_spa: 'Beauty & spa',
  beauty_salon: 'Beauty & spa', hair_salon: 'Beauty & spa', barber: 'Beauty & spa',
  nail_salon: 'Beauty & spa', tattoo_and_piercing: 'Tattoo & piercing',

  landmark_and_historical_building: 'Attraction', monument: 'Attraction',
  buddhist_temple: 'Attraction · temple', hindu_temple: 'Attraction · temple',
  church_cathedral: 'Attraction · church', mosque: 'Attraction · mosque',
  shrine: 'Attraction · temple', religious_organization: 'Attraction · place of worship',
  museum: 'Museum', art_gallery: 'Gallery', art_museum: 'Museum',
  history_museum: 'Museum', aquarium: 'Aquarium', zoo: 'Zoo',
  theme_park: 'Theme park', water_park: 'Water park', amusement_park: 'Theme park',
  park: 'Attraction · park', garden: 'Attraction · garden', beach: 'Attraction · beach',
  scenic_lookout: 'Viewpoint', observation_deck: 'Viewpoint',
  performing_arts_venue: 'Theatre', theatre: 'Theatre', movie_theatre: 'Cinema',
  cinema: 'Cinema', casino: 'Nightlife · casino', night_market: 'Market',

  tours: 'Tours & travel', travel: 'Tours & travel', travel_services: 'Tours & travel',
  travel_agency: 'Tours & travel', tour_operator: 'Tours & travel',
  boat_charter: 'Boat charter', boat_rental: 'Boat charter', marina: 'Marina & charters',
  scuba_diving_center: 'Diving', dive_shop: 'Diving',
  car_rental: 'Vehicle rental', motorcycle_rental: 'Vehicle rental',
  bicycle_rental: 'Vehicle rental', rental: 'Vehicle rental',
  taxi_service: 'Transport', transportation: 'Transport', airport: 'Transport',

  shopping: 'Shopping', shopping_center: 'Shopping · mall', department_store: 'Shopping',
  clothing_store: 'Shopping · clothing', jewelry_store: 'Shopping · jewellery',
  flowers_and_gifts_shop: 'Souvenirs & gifts', gift_shop: 'Souvenirs & gifts',
  souvenir_shop: 'Souvenirs & gifts', cosmetic_and_beauty_supplies: 'Shopping · beauty',
  convenience_store: 'Convenience', grocery_store: 'Supermarket', supermarket: 'Supermarket',
  farmers_market: 'Market', market: 'Market', tailor: 'Tailor',
  pharmacy: 'Pharmacy', drugstore: 'Pharmacy',

  gym: 'Gym & fitness', fitness_centre: 'Gym & fitness', yoga_studio: 'Gym & fitness',
  active_life: 'Sports activity', sports_club: 'Gym & fitness', golf_course: 'Golf',
  golf: 'Golf', surf_shop: 'Watersports', water_sports: 'Watersports',
  climbing_gym: 'Gym & fitness', martial_arts_dojo: 'Gym & fitness',
};

// Real businesses, but never somewhere a traveller should be sent.
const DROP = new Set([
  'automotive', 'automotive_repair', 'motorcycle_repair', 'car_dealer', 'car_wash',
  'gas_station', 'auto_parts', 'tyre_shop', 'towing_service', 'parking',
  'hardware_store', 'building_supply_store', 'furniture_store', 'home_improvement',
  'mobile_phone_store', 'electronics', 'computer_repair', 'office_supplies',
  'real_estate_agent', 'insurance_agency', 'bank', 'banks', 'atm', 'storage_facility',
  'funeral_home', 'veterinarian', 'pet_store', 'laundry_service', 'dry_cleaning',
  'moving_company', 'freight', 'wholesaler', 'warehouse', 'factory',
]);

const titled = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const category = c => {
  if (!c) return 'Business';
  if (DROP.has(c)) return null;
  return CATMAP[c] || titled(c);
};

// ── matching against what we already hold ────────────────────────────
const STOP = /\b(the|ltd|limited|plc|llp|co|company|and|of|at)\b/g;
const norm = s => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/['’`]/g, '')
  .replace(/[^a-z0-9฀-๿]+/g, ' ').replace(STOP, ' ')
  .replace(/\s+/g, ' ').trim();

const metres = (aLat, aLng, bLat, bLng) => {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (bLat - aLat) * toR, dLng = (bLng - aLng) * toR;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

const pid = (source, name, lat, lng) =>
  createHash('sha1').update(`${source}|${String(name).toLowerCase().trim()}|${(+lat).toFixed(4)}|${(+lng).toFixed(4)}`)
    .digest('hex').slice(0, 20);

function existing(slug) {
  const out = execFileSync('npx', ['wrangler@latest', 'd1', 'execute', DB, '--remote', '--json',
    `--command=SELECT id,name,lat,lng FROM places WHERE dest='${slug}'`],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: process.env });
  const json = JSON.parse(out.slice(out.indexOf('[')));
  const rows = json[0]?.results || json.result?.[0]?.results || [];
  const index = new Map();
  for (const r of rows) {
    const k = norm(r.name); if (!k) continue;
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(r);
  }
  return { count: rows.length, index };
}

function matchTo(index, name, lat, lng) {
  const k = norm(name); if (!k) return null;
  let best = null, bestD = Infinity;
  for (const r of index.get(k) || []) {
    const d = metres(lat, lng, r.lat, r.lng);
    if (d < bestD) { bestD = d; best = r; }
  }
  return best && bestD <= MATCH_METRES ? best : null;
}

// ── SQL ──────────────────────────────────────────────────────────────
const q = v => (v == null || v === '') ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'";
const num = v => (v == null || v === '' || isNaN(v)) ? 'NULL' : Number(v);
const COLS = '(id,name,category,lat,lng,cell_lat,cell_lng,dest,area,country,region,phone,website,email,address,rating,reviews,confidence,source,status)';
const tuple = p => '(' + [
  q(p.id), q(p.name), q(p.category), num(p.lat), num(p.lng), p.cell_lat, p.cell_lng,
  q(p.dest), q(p.area), q(p.country), q(p.region), q(p.phone), q(p.website), q(p.email),
  q(p.address), 'NULL', 0, num(p.confidence), q(p.source), q('unclaimed'),
].join(',') + ')';

function d1(file) {
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

function upsertDestination(d, count) {
  const f = `${OUT}/_ovt_cmd.sql`;
  writeFileSync(f, `UPDATE destinations SET place_count=${count}, live=1, last_ingest_at=datetime('now') WHERE slug=${q(d.slug)};`);
  d1(f);
}

// ── run ──────────────────────────────────────────────────────────────
let targets = DESTINATIONS;
if (ONLY) targets = ONLY.map(s => bySlug[s]).filter(Boolean);
if (REGION) targets = targets.filter(d => d.region.toLowerCase() === REGION.toLowerCase());
if (!FORCE && !ONLY) targets = targets.filter(d => !state[d.slug]?.ok);
if (!targets.length) { console.log('Nothing to do (use --force to re-ingest).'); process.exit(0); }

mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });
console.log(`Overture ${RELEASE} · ${targets.length} destination(s)\n`);

let totNew = 0, totFill = 0;
for (const [i, d] of targets.entries()) {
  console.log(`[${i + 1}/${targets.length}] ${d.name} (${d.country})`);
  const nd = `${TMP}/${d.slug}.ndjson`;
  try {
    execFileSync('python3', [new URL('./overture_extract.py', import.meta.url).pathname,
      `--bbox=${d.bbox.join(',')}`, `--out=${nd}`, `--release=${RELEASE}`,
      `--min-confidence=${MINCONF}`], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });

    const raw = readFileSync(nd, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const { count, index } = existing(d.slug);
    console.log(`    ${count} places already held`);

    const inserts = [], updates = [], seen = new Set(), usedIds = new Set();
    let dropped = 0;
    for (const r of raw) {
      const cat = category(r.category);
      if (cat === null) { dropped++; continue; }
      const lat = +r.lat, lng = +r.lng;
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !r.name) continue;

      const website = r.website || null, phone = r.phone || null, email = r.email || null;
      const address = [r.addr, r.locality, r.postcode].filter(Boolean).join(', ') || null;

      const hit = matchTo(index, r.name, lat, lng);
      if (hit) {
        if (usedIds.has(hit.id)) continue;
        usedIds.add(hit.id);
        // Gap-fill only: never overwrite anything a human or Google already gave us.
        if (!website && !phone && !email && !address && r.confidence == null) continue;
        updates.push(`UPDATE places SET `
          + `phone=COALESCE(NULLIF(phone,''),${q(phone)}), `
          + `website=COALESCE(NULLIF(website,''),${q(website)}), `
          + `email=COALESCE(NULLIF(email,''),${q(email)}), `
          + `address=COALESCE(NULLIF(address,''),${q(address)}), `
          + `confidence=COALESCE(confidence,${num(r.confidence)}), `
          + `updated_at=datetime('now') WHERE id=${q(hit.id)};`);
        continue;
      }
      if (ENRICH_ONLY) continue;

      const id = pid('ovt', r.name, lat, lng);
      if (seen.has(id)) continue; seen.add(id);
      inserts.push({
        id, name: String(r.name).trim(), category: cat,
        lat: +lat.toFixed(5), lng: +lng.toFixed(5),
        cell_lat: Math.floor(lat * 10), cell_lng: Math.floor(lng * 10),
        dest: d.slug, area: r.locality || null, country: d.country, region: d.region,
        phone, website, email, address, confidence: r.confidence ?? null,
        source: 'overture',
      });
    }

    const stmts = [];
    for (let k = 0; k < inserts.length; k += ROWS_PER_STMT)
      stmts.push(`INSERT OR IGNORE INTO places ${COLS} VALUES\n`
        + inserts.slice(k, k + ROWS_PER_STMT).map(tuple).join(',\n') + ';');
    stmts.push(...updates);
    const file = `${OUT}/ovt_${d.slug}.sql`;
    writeFileSync(file, stmts.join('\n') + '\n');
    console.log(`    ${raw.length} extracted · ${dropped} off-limits categories dropped`);
    console.log(`    ${inserts.length} new · ${updates.length} gap-filled → ${file}`);

    if (!DRY && stmts.length) {
      d1(file);
      upsertDestination(d, count + inserts.length);
    }
    totNew += inserts.length; totFill += updates.length;
    state[d.slug] = { ok: !DRY, added: inserts.length, filled: updates.length, at: new Date().toISOString() };
    saveState();
    rmSync(nd, { force: true });
    console.log(`    ✓ ${DRY ? 'built' : 'written to D1'}\n`);
  } catch (e) {
    console.log(`    ✗ ${d.slug}: ${e.message}\n`);
    state[d.slug] = { ok: false, error: e.message };
    saveState();
  }
}
console.log(`\n✅ Overture: ${totNew} new places, ${totFill} existing places gap-filled.`);
console.log('   Attribution: © Overture Maps Foundation — data from Meta, Microsoft, Foursquare, AllThePlaces and others.');
