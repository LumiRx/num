#!/usr/bin/env node
/**
 * NUM · whole-country place ingestion → Cloudflare D1
 *
 * `ingest_global.mjs` asks Overpass one question per destination and keeps
 * whatever sits inside a rectangle somebody drew round a city. That is the
 * right tool for "add Kyoto". It is the wrong tool for "every business on the
 * island", because most of the island is not inside any city rectangle.
 *
 * This walks a country as a grid instead, quarters any square too dense for
 * Overpass to answer in one go, and hands every place to the destination a
 * traveller would actually name for it.
 *
 *   node scripts/ingest_cover.mjs --country=TW --dry
 *   node scripts/ingest_cover.mjs --country=TW
 *   node scripts/ingest_cover.mjs --country=TW --from-cache=tw-raw.ndjson.gz
 *
 * Flags
 *   --country=XX      ISO-2. Needs a cover in coverplan.mjs and destinations
 *                     in destinations.mjs.
 *   --step=0.25       starting square size in degrees. Dense squares subdivide
 *                     themselves; this is only where they start.
 *   --core            the narrow "somewhere to spend money" selector instead of
 *                     every named business.
 *   --from-cache=F    read raw OSM elements from a .ndjson or .ndjson.gz file
 *                     instead of calling Overpass. Walking the island takes
 *                     hours and the write takes minutes; this lets the two
 *                     happen on different machines, or lets a failed write be
 *                     retried without asking OSM for the same data twice.
 *   --dry             build the SQL, write nothing.
 *   --restart         forget the tile state and start over.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { DESTINATIONS } from './destinations.mjs';
import { localName as pickLocalName } from './localname.ingest.mjs';
import { CORE_QUERY, FULL_QUERY, assignDest, normalise, tiles } from './osmplace.mjs';
import { buildSql, gridFor, registerDestinationsSql, COVER } from './coverplan.mjs';

const DB = 'num-db';
const OUT = 'sql/cover';
const ROWS_PER_FILE = 5000;
const CAP = 20000;      // Overpass answers no more than this, and does not say what it dropped
const MIN_STEP = 0.02;  // ~2km. Below this a square is a city block.

// Ordered by what actually answered on 30 Aug 2026: overpass-api.de and
// kumi.systems were both refusing every request from this network that day,
// which is exactly why this is a list and not a constant.
const OVERPASS = (process.env.OVERPASS_ENDPOINTS || [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

const argv = process.argv.slice(2);
const flag = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const has = (k) => argv.includes(`--${k}`);
const COUNTRY = (flag('country') || '').toUpperCase();
const STEP = Number(flag('step') || 0.25);
const CACHE = flag('from-cache');
const DRY = has('dry');
const CORE = has('core');
const RESTART = has('restart');
const STATE_FILE = `.ingest_cover_${COUNTRY || 'none'}.json`;

if (!COUNTRY || !COVER[COUNTRY]) {
  console.error(`--country=XX is required, and must be one of: ${Object.keys(COVER).join(', ')}`);
  process.exit(1);
}
const dests = DESTINATIONS.filter((d) => String(d.country).toUpperCase() === COUNTRY);
if (!dests.length) {
  console.error(`No destinations for ${COUNTRY} in destinations.mjs. Add them first — every place needs a home.`);
  process.exit(1);
}

if (RESTART && existsSync(STATE_FILE)) rmSync(STATE_FILE);
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { tiles: {}, counts: {} };
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(bbox) {
  const body = 'data=' + encodeURIComponent((CORE ? CORE_QUERY : FULL_QUERY)(bbox.join(',')));
  let lastErr = 'unknown';
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'NUM-by-5arz/1.0 (info@5arz.com)' },
        body,
      });
      if (!res.ok) { lastErr = `HTTP ${res.status}`; await sleep(7000 * (attempt + 1)); continue; }
      return await res.json();
    } catch (e) { lastErr = e.message; await sleep(6000 * (attempt + 1)); }
  }
  throw new Error(`Overpass unreachable: ${lastErr}`);
}

function d1(file) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      execFileSync('npx', ['wrangler@latest', 'd1', 'execute', DB, '--remote', `--file=${file}`, '-y'],
        { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, encoding: 'utf8' });
      return;
    } catch (e) {
      lastErr = e;
      const detail = (e.stderr || e.stdout || '').toString().trim().split('\n').slice(-2).join(' | ');
      console.log(`    ! d1 execute failed (${attempt}/4)${detail ? ': ' + detail : ''}`);
      if (attempt < 4) execFileSync('sleep', ['8']);
    }
  }
  throw lastErr;
}

// ── the shared middle: elements in, rows out ─────────────────────────
mkdirSync(OUT, { recursive: true });
let batch = [];
let fileNo = 0;
let written = 0;
let rejected = 0;
const seen = new Set();

function flush(force = false) {
  if (!batch.length || (!force && batch.length < ROWS_PER_FILE)) return;
  const file = `${OUT}/${COUNTRY}-${String(fileNo++).padStart(4, '0')}.sql`;
  writeFileSync(file, buildSql(batch));
  if (!DRY) d1(file);
  written += batch.length;
  console.log(`  -> ${DRY ? 'built' : 'wrote'} ${batch.length} (${written} total) ${file}`);
  batch = [];
  saveState();
}

/** One batch of raw OSM elements → rows on the queue. Returns how many it kept. */
function absorb(els) {
  let kept = 0;
  for (const el of els) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) { rejected++; continue; }
    const d = assignDest(lat, lng, dests);
    if (!d) { rejected++; continue; }
    const p = normalise(el, d, pickLocalName);
    if (!p) { rejected++; continue; }
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    batch.push(p);
    state.counts[d.slug] = (state.counts[d.slug] || 0) + 1;
    kept++;
  }
  return kept;
}

// ── mode: replay a cached harvest ────────────────────────────────────
if (CACHE) {
  if (!existsSync(CACHE)) { console.error(`--from-cache=${CACHE} does not exist`); process.exit(1); }
  console.log(`${COUNTRY}: replaying ${CACHE}, ${dests.length} destinations${DRY ? ', DRY' : ''}\n`);
  const raw = CACHE.endsWith('.gz') ? createReadStream(CACHE).pipe(createGunzip()) : createReadStream(CACHE);
  const rl = createInterface({ input: raw, crlfDelay: Infinity });
  let lines = 0, bad = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    lines++;
    let el;
    try { el = JSON.parse(line); } catch { bad++; continue; }
    absorb([el]);
    flush();
  }
  flush(true);
  console.log(`\n${lines} elements read${bad ? `, ${bad} unparseable` : ''}; ${written} places written, ${rejected} not places.`);
} else {
  // ── mode: walk the country ─────────────────────────────────────────
  const start = gridFor(COUNTRY, STEP).filter((t) => !state.tiles[t.bbox.join(',')]);
  const queue = start.map((t) => ({ ...t, step: STEP }));
  console.log(`${COUNTRY}: ${queue.length} squares at ${STEP}°, ${dests.length} destinations, `
    + `${CORE ? 'core' : 'full'} selector${DRY ? ', DRY' : ''}\n`);
  let walked = 0;
  while (queue.length) {
    const t = queue.shift();
    const key = t.bbox.join(',');
    walked++;
    let j;
    try { j = await overpass(t.bbox); } catch (e) { console.log(`  x ${key}: ${e.message}`); continue; }
    const els = j.elements || [];
    // A square at the cap has not been answered, it has been truncated — and
    // Overpass does not say which places it dropped. So quarter it and ask again.
    if (els.length >= CAP && t.step > MIN_STEP) {
      const half = t.step / 2;
      const kids = tiles(t.bbox, half);
      console.log(`  / ${key} at the cap — splitting into ${kids.length} squares of ${half}°`);
      for (const b of kids) queue.unshift({ ...t, bbox: b, step: half });
      await sleep(1200);
      continue;
    }
    if (els.length >= CAP) console.log(`  ! ${key} is at the cap at ${t.step}° — some places here are not ingested.`);
    const kept = absorb(els);
    state.tiles[key] = kept;
    if (kept) console.log(`  ${walked} ${key}  ${kept} (queue ${queue.length})`);
    flush();
    saveState();
    await sleep(1100);
  }
  flush(true);
  console.log(`\n${walked} squares walked, ${written} places written, ${rejected} elements were not places.`);
}

// ── register the destinations ────────────────────────────────────────
/**
 * A place with no row in `destinations` is invisible: the hub does not list
 * it, destpage.mjs will not build it, and the concierge cannot resolve its
 * name. The count written here is read back from `places` rather than
 * counted in this process, so a partial run reports what is actually in the
 * database instead of what this run happened to send.
 */
if (!DRY) {
  const f = `${OUT}/_destinations.sql`;
  writeFileSync(f, registerDestinationsSql(dests));
  d1(f);
  console.log(`\nregistered ${dests.length} ${COUNTRY} destinations with counts read back from places`);
}

const byDest = Object.entries(state.counts).sort((a, b) => b[1] - a[1]);
for (const [slug, n] of byDest) console.log(`  ${slug.padEnd(18)} ${n.toLocaleString()}`);
console.log('\nRe-run any time — ids are stable and the write is an upsert, so nothing duplicates');
console.log('and nothing a place has earned (rating, photo, claim, booking link) is overwritten.');
