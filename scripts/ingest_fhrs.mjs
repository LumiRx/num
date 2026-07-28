#!/usr/bin/env node
/**
 * NUM · UK Food Standards Agency (FHRS) ingestion → Cloudflare D1
 *
 * Source: api.ratings.food.gov.uk — Open Government Licence v3.0.
 *   • No API key, no registration, no scraping.
 *   • Every food business in England, Scotland, Wales and Northern Ireland,
 *     with a government-issued hygiene rating (0–5), phone, address, postcode.
 *
 * Two jobs, both of which we care about:
 *   1. ENRICH — fill hygiene rating / phone / address on places we already hold.
 *   2. ACQUIRE — insert food businesses the OSM pull missed entirely.
 *
 * IMPORTANT — hygiene is NOT a star rating.
 *   It goes in `places.hygiene`, never in `places.rating`. `rating` means
 *   "customers liked it"; hygiene means "the council inspected the kitchen".
 *   Presenting one as the other would mislead a guest, so they stay separate.
 *
 * Attribution required by OGL v3.0 (already in the console footer):
 *   "Contains public sector information licensed under the Open Government Licence v3.0"
 *
 *   node ingest_fhrs.mjs                    # every GB destination in destinations.mjs
 *   node ingest_fhrs.mjs --only=bath,london
 *   node ingest_fhrs.mjs --dry              # fetch + build SQL, don't touch D1
 *   node ingest_fhrs.mjs --no-new           # enrich only, never insert
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DESTINATIONS, bySlug } from './destinations.mjs';

const DB = 'num-db';
const API = 'https://api.ratings.food.gov.uk';
const UA = 'NUM-by-5arz/1.0 (info@5arz.com)';
const OUT = 'sql';
const STATE = '.fhrs_state.json';
const ROWS_PER_STMT = 100;
const MATCH_METRES = 180;      // same business, sloppier coordinates
const STEP_MILES = 4;          // API radius per sweep point
const PAGE_SIZE = 5000;

const argv = process.argv.slice(2);
const flag = k => argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const has  = k => argv.includes(`--${k}`);
const ONLY = flag('only')?.split(',').map(s => s.trim()).filter(Boolean);
const DRY = has('dry'), NO_NEW = has('no-new');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const saveState = () => writeFileSync(STATE, JSON.stringify(state, null, 1));

// ── which FHRS business types are worth showing a traveller ──────────
// Everything else (manufacturers, hospitals, schools, distributors, farms)
// is a food business but not somewhere a guest would ever be sent.
const TYPE_MAP = {
  'Restaurant/Cafe/Canteen': 'Restaurant',
  'Pub/bar/nightclub': 'Bar',
  'Takeaway/sandwich shop': 'Street food',
  'Mobile caterer': 'Street food',
  'Hotel/bed & breakfast/guest house': 'Hotel',
  'Retailers - supermarkets/hypermarkets': 'Supermarket',
  'Retailers - other': 'Convenience',
  'Other catering premises': null,
  'Distributors/Transporters': null,
  'Farmers/growers': null,
  'Importers/Exporters': null,
  'Manufacturers/packers': null,
  'School/college/university': null,
  'Hospitals/Childcare/Caring Premises': null,
};
// Types we will happily *enrich* (a hygiene score is useful on anything we
// already list) but never *insert* on their own.
const INSERTABLE = t => Boolean(TYPE_MAP[t]);

// ── name matching ────────────────────────────────────────────────────
const STOP = /\b(the|ltd|limited|plc|llp|co|company|restaurant|cafe|caf|bar|pub|hotel|takeaway|shop|store|and|of|at)\b/g;
const norm = s => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/['’`]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').replace(STOP, ' ')
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

// ── FHRS API ─────────────────────────────────────────────────────────
async function fhrs(path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`${API}${path}`, {
        headers: { 'x-api-version': '2', accept: 'application/json', 'User-Agent': UA },
      });
      if (res.status === 429 || res.status >= 500) {
        const wait = 5000 * (attempt + 1);
        console.log(`    ⏳ ${res.status} — backing off ${wait / 1000}s`);
        await sleep(wait); continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.log(`    ⚠ ${e.message} (attempt ${attempt + 1}/5)`);
      await sleep(4000 * (attempt + 1));
    }
  }
  throw new Error('FHRS unreachable');
}

/** Sweep a bbox with overlapping radius searches; the API has no bbox mode.
 *  Central London holds ~23k food businesses inside a 4-mile circle, so every
 *  point has to be paged out or we would silently keep only the first 5,000. */
async function sweep(bbox) {
  const [s, w, n, e] = bbox;                     // destinations.mjs order: S,W,N,E
  const midLat = (s + n) / 2;
  const stepKm = STEP_MILES * 1.609 * 1.35;      // 1.35 → deliberate overlap, no gaps
  const dLat = stepKm / 111;
  const dLng = stepKm / (111 * Math.max(0.2, Math.cos(midLat * Math.PI / 180)));
  const found = new Map();
  const points = [];
  for (let la = s + dLat / 2; la < n + dLat; la += dLat)
    for (let lo = w + dLng / 2; lo < e + dLng; lo += dLng) points.push([la, lo]);

  for (const [i, [la, lo]] of points.entries()) {
    const base = `/Establishments?latitude=${la.toFixed(5)}&longitude=${lo.toFixed(5)}`
      + `&maxDistanceLimit=${STEP_MILES}&pageSize=${PAGE_SIZE}`;
    let page = 1, pages = 1;
    do {
      const j = await fhrs(`${base}&pageNumber=${page}`);
      const list = j.establishments || [];
      // totalPages is expressed in pages of pageSize; trust it but cap the walk
      pages = Math.min(Math.ceil((j.meta?.totalCount || list.length) / PAGE_SIZE) || 1, 40);
      for (const est of list) {
        if (!est.FHRSID || found.has(est.FHRSID)) continue;
        found.set(est.FHRSID, est);
      }
      if (!list.length) break;
      page++;
      if (page <= pages) await sleep(350);
    } while (page <= pages);
    if ((i + 1) % 5 === 0 || i === points.length - 1)
      console.log(`    sweep ${i + 1}/${points.length} · ${found.size} establishments`);
    await sleep(350);                            // be a good citizen
  }
  return [...found.values()];
}

// ── read what we already hold, so we enrich instead of duplicating ───
function existing(slug) {
  const out = execFileSync('npx', ['wrangler@latest', 'd1', 'execute', DB, '--remote', '--json',
    `--command=SELECT id,name,lat,lng,phone,address FROM places WHERE dest='${slug}'`],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: process.env });
  const json = JSON.parse(out.slice(out.indexOf('[')));
  const rows = json[0]?.results || json.result?.[0]?.results || [];
  const index = new Map();                       // normName → [rows]
  for (const r of rows) {
    const k = norm(r.name); if (!k) continue;
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(r);
  }
  return { rows, index };
}

function matchTo(index, est, lat, lng) {
  const k = norm(est.BusinessName); if (!k) return null;
  let best = null, bestD = Infinity;
  for (const r of index.get(k) || []) {
    const d = metres(lat, lng, r.lat, r.lng);
    if (d < bestD) { bestD = d; best = r; }
  }
  if (best && bestD <= MATCH_METRES) return best;
  // a shorter FHRS name inside a longer listed name (and vice versa) is common:
  // "Amritsr" vs "Amritsr Restaurant Patong Beach Road"
  for (const [key, rowsForKey] of index) {
    if (key.length < 5) continue;
    if (!(key.startsWith(k + ' ') || k.startsWith(key + ' '))) continue;
    for (const r of rowsForKey) {
      const d = metres(lat, lng, r.lat, r.lng);
      if (d < bestD) { bestD = d; best = r; }
    }
  }
  return best && bestD <= MATCH_METRES ? best : null;
}

// ── SQL ──────────────────────────────────────────────────────────────
const q = v => (v == null || v === '') ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'";
const num = v => (v == null || v === '' || isNaN(v)) ? 'NULL' : Number(v);
const COLS = '(id,name,category,lat,lng,cell_lat,cell_lng,dest,area,country,region,phone,address,rating,reviews,hygiene,source,status)';
const tuple = p => '(' + [
  q(p.id), q(p.name), q(p.category), num(p.lat), num(p.lng), p.cell_lat, p.cell_lng,
  q(p.dest), q(p.area), q(p.country), q(p.region), q(p.phone), q(p.address),
  'NULL', 0, num(p.hygiene), q('fhrs'), q('unclaimed'),
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

// ── run ──────────────────────────────────────────────────────────────
let targets = DESTINATIONS.filter(d => d.country === 'United Kingdom' || d.country === 'UK' || d.country === 'GB');
if (ONLY) targets = ONLY.map(s => bySlug[s]).filter(Boolean);
if (!targets.length) {
  console.error('No UK destinations selected. FHRS only covers England, Scotland, Wales and Northern Ireland.');
  process.exit(1);
}
console.log(`FHRS · ${targets.length} destination(s): ${targets.map(d => d.slug).join(', ')}\n`);

let totEnrich = 0, totNew = 0;
for (const [i, d] of targets.entries()) {
  console.log(`[${i + 1}/${targets.length}] ${d.name}`);
  try {
    const ests = await sweep(d.bbox);
    console.log(`    ${ests.length} establishments from FSA`);
    const { rows, index } = existing(d.slug);
    console.log(`    ${rows.length} places already held`);

    const updates = [], inserts = [], usedIds = new Set();
    for (const est of ests) {
      const lat = +est.geocode?.latitude, lng = +est.geocode?.longitude;
      const rv = parseInt(est.RatingValue, 10);
      const hyg = Number.isInteger(rv) && rv >= 0 && rv <= 5 ? rv : null;   // "Pass"/"Exempt" → null
      const phone = (est.Phone || '').trim() || null;
      const addr = [est.AddressLine1, est.AddressLine2, est.AddressLine3, est.AddressLine4, est.PostCode]
        .map(s => (s || '').trim()).filter(Boolean).join(', ') || null;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const hit = matchTo(index, est, lat, lng);
      if (hit && !usedIds.has(hit.id)) {
        usedIds.add(hit.id);
        if (hyg == null && !phone && !addr) continue;
        updates.push(`UPDATE places SET `
          + `hygiene=${num(hyg)}, `
          + `phone=COALESCE(NULLIF(phone,''),${q(phone)}), `
          + `address=COALESCE(NULLIF(address,''),${q(addr)}), `
          + `updated_at=datetime('now') WHERE id=${q(hit.id)};`);
        continue;
      }
      if (NO_NEW || !INSERTABLE(est.BusinessType)) continue;
      inserts.push({
        id: pid('fhrs', est.BusinessName, lat, lng),
        name: String(est.BusinessName).trim(),
        category: TYPE_MAP[est.BusinessType],
        lat: +lat.toFixed(5), lng: +lng.toFixed(5),
        cell_lat: Math.floor(lat * 10), cell_lng: Math.floor(lng * 10),
        dest: d.slug, area: (est.AddressLine3 || est.AddressLine2 || '').trim() || null,
        country: d.country, region: d.region, phone, address: addr, hygiene: hyg,
      });
    }

    mkdirSync(OUT, { recursive: true });
    const stmts = [];
    for (let k = 0; k < inserts.length; k += ROWS_PER_STMT)
      stmts.push(`INSERT OR IGNORE INTO places ${COLS} VALUES\n`
        + inserts.slice(k, k + ROWS_PER_STMT).map(tuple).join(',\n') + ';');
    stmts.push(...updates);
    const file = `${OUT}/fhrs_${d.slug}.sql`;
    writeFileSync(file, stmts.join('\n') + '\n');
    console.log(`    ${updates.length} enriched · ${inserts.length} new → ${file}`);

    if (!DRY && stmts.length) d1(file);
    totEnrich += updates.length; totNew += inserts.length;
    state[d.slug] = { ok: !DRY, enriched: updates.length, added: inserts.length, at: new Date().toISOString() };
    saveState();
    console.log(`    ✓ ${DRY ? 'built' : 'written to D1'}\n`);
  } catch (e) {
    console.log(`    ✗ ${d.slug}: ${e.message}\n`);
    state[d.slug] = { ok: false, error: e.message };
    saveState();
  }
}
console.log(`\n✅ FHRS: ${totEnrich} places enriched with a hygiene rating, ${totNew} new food businesses added.`);
console.log('   Attribution: Contains public sector information licensed under the Open Government Licence v3.0.');
