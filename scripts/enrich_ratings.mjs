#!/usr/bin/env node
/**
 * NUM · rating enrichment for a destination → Cloudflare D1
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * 11 Aug 2026, sizing the LA launch. Los Angeles has 90,263 places — three
 * times Phuket — and ZERO of them have a rating. That sounds survivable
 * until you look at what it does to the ranking. top_places scores on
 * rating + hygiene + confidence + contact + claimed; with rating and hygiene
 * both null in LA, only the contact signal is live, and 64,929 LA places
 * have both a phone and a website. They tie. The "top 30" the concierge
 * reads for Los Angeles is not a ranking — it is an arbitrary sample of
 * sixty-five thousand equally-scored rows, and the scores prove it: 31
 * distinct values across 270 rows, everything bunched at 27–28.
 *
 * Phuket works on 542 ratings out of 30,543. The blocker in LA was never
 * volume. It is that nothing tells us which of the 90,263 is any good.
 *
 * ── WHAT IT BUYS, AND WHAT IT COSTS ──────────────────────────────────────
 *
 * Google Places API (New) searchText, one request per place, field-masked to
 * the four fields we need. That is the Text Search Pro SKU: about $32 per
 * 1,000 requests at list price. Enriching all 90,263 LA rows would be
 * roughly $2,900 and most of it would be wasted on places no guest will ever
 * be shown.
 *
 * So this does NOT enrich everything. It spends the money where the
 * concierge actually looks: a quota per (bucket, area) pair, so the budget
 * buys COVERAGE — a rated café in Silver Lake and a rated café in Venice —
 * rather than four thousand rated restaurants downtown. ~4,000 rows is
 * roughly $130 and is enough to make every bucket in every neighbourhood
 * rank on something real.
 *
 * The script prints the request count and the estimated bill and refuses to
 * spend without --go. Nothing about a paid API call should be a surprise.
 *
 * ── WHY THE MATCH GUARD IS STRICT ────────────────────────────────────────
 *
 * A wrong rating is worse than no rating. Num quotes numbers to guests who
 * act on them, and the prompt now permits quoting a rating ONLY if it is in
 * the verified block — which means whatever lands in this column is
 * repeated verbatim to a paying user. So a result is accepted only if the
 * returned name genuinely resembles ours AND the coordinates are within
 * 150 m. Everything else is recorded as checked-and-unmatched, so we never
 * pay for the same miss twice.
 *
 *   GOOGLE_PLACES_API_KEY=… node scripts/enrich_ratings.mjs --dest=los-angeles --dry
 *   GOOGLE_PLACES_API_KEY=… node scripts/enrich_ratings.mjs --dest=los-angeles --limit=4000 --go
 *
 * Then rebuild the ranking, which is the step that makes any of it visible:
 *   npx wrangler d1 execute num-db --remote --file scripts/rank_top_places.sql
 */
import { execFileSync } from 'node:child_process';

const DB = 'num-db';
const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
// $32 per 1,000 Text Search Pro requests (list price, Aug 2026). Used only to
// print an estimate — it is not authoritative and the invoice wins.
const USD_PER_1K = 32;

const argv = process.argv.slice(2);
const flag = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const has = (k) => argv.includes(`--${k}`);
const DESTS = (flag('dest') || '').split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(flag('limit') || 4000);
// Per (bucket, area) quota. Coverage beats depth: a rated place in every
// neighbourhood is worth more than a deep bench in one.
const PER_CELL = Number(flag('per-cell') || 40);
const GO = has('go');
const KEY = process.env.GOOGLE_PLACES_API_KEY || '';
const CONCURRENCY = 5;

const sql = (q) => {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', q], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out)[0].results;
};
const sqlWrite = (q) => execFileSync('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--command', q], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

/** Provenance columns. Google requires attribution; we also need to not re-pay. */
function ensureColumns() {
  const cols = sql("SELECT name FROM pragma_table_info('places')").map((r) => r.name);
  for (const [name, type] of [['rating_source', 'TEXT'], ['rating_checked_at', 'TEXT']]) {
    if (!cols.includes(name)) {
      console.log(`  + adding column places.${name}`);
      if (GO) sqlWrite(`ALTER TABLE places ADD COLUMN ${name} ${type}`);
    }
  }
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const metres = (a, b, c, d) => {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (c - a) * r, dLng = (d - b) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const tokens = (s) => String(s || '').toLowerCase().normalize('NFKD').split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Is this the same place?
 *
 * OSM and Google disagree constantly about suffixes — "Guisados" vs
 * "Guisados Tacos", "The Ivy" vs "The Ivy Restaurant" — so the shorter name's
 * words must all appear in the longer one, as WORDS.
 *
 * Plain substring containment was the first attempt and it is wrong in a way
 * that costs a guest: "Cafe" is a substring of "Cafeteria Nine", and "Bar" of
 * "Barney's Beanery", so a generic OSM name would have inherited a stranger's
 * rating. Token subset rejects both.
 *
 * A single shared word must also be distinctive — six characters or more —
 * or "Sushi" would match "Sushi Zo". Two words is enough on its own.
 */
const sameName = (a, b) => {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const set = new Set(long);
  if (!short.every((t) => set.has(t))) return false;
  return short.length >= 2 || short[0].length >= 6;
};

async function lookup(place) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY,
      // Field mask keeps this on the cheap SKU. Asking for more fields than
      // we store would cost more per call for data we then throw away.
      'X-Goog-FieldMask': 'places.displayName,places.rating,places.userRatingCount,places.location',
    },
    body: JSON.stringify({
      textQuery: place.name,
      maxResultCount: 1,
      locationBias: { circle: { center: { latitude: place.lat, longitude: place.lng }, radius: 200 } },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  const hit = j.places?.[0];
  if (!hit) return null;
  const name = hit.displayName?.text ?? '';
  const d = metres(place.lat, place.lng, hit.location?.latitude ?? 0, hit.location?.longitude ?? 0);
  if (!sameName(place.name, name) || d > 150) return { rejected: true, name, d: Math.round(d) };
  if (typeof hit.rating !== 'number') return null;
  return { rating: hit.rating, reviews: hit.userRatingCount ?? 0, name, d: Math.round(d) };
}

async function run(dest) {
  console.log(`\n── ${dest} ────────────────────────────────────────────`);
  const [{ n, rated }] = sql(
    `SELECT COUNT(*) n, SUM(rating IS NOT NULL) rated FROM places WHERE dest=${q(dest)}`,
  );
  console.log(`  ${n} places, ${rated} already rated`);

  // Candidates: a real, contactable business, not yet rated, not yet checked.
  // Ordered so the per-cell quota below gets the strongest of each group —
  // hours present is the best available proxy for "somebody maintains this
  // listing" when no rating exists to say so.
  const rows = sql(`
    SELECT id, name, category, area, lat, lng
      FROM places
     WHERE dest=${q(dest)}
       AND rating IS NULL
       AND rating_checked_at IS NULL
       AND name IS NOT NULL AND name <> ''
       AND (website IS NOT NULL AND website <> '' OR phone IS NOT NULL AND phone <> '')
     ORDER BY (hours IS NULL), (website IS NULL), (phone IS NULL), name
     LIMIT ${LIMIT * 6}
  `);

  // Spread the budget across (category, area) rather than letting one dense
  // neighbourhood eat it.
  const seen = new Map();
  const picked = [];
  for (const r of rows) {
    const cell = `${r.category ?? '?'}|${r.area ?? '?'}`;
    const c = seen.get(cell) ?? 0;
    if (c >= PER_CELL) continue;
    seen.set(cell, c + 1);
    picked.push(r);
    if (picked.length >= LIMIT) break;
  }

  const bill = ((picked.length / 1000) * USD_PER_1K).toFixed(2);
  console.log(`  ${picked.length} candidates across ${seen.size} category/area cells`);
  console.log(`  ≈ $${bill} at $${USD_PER_1K}/1,000 requests`);
  if (!GO) {
    console.log('  DRY RUN — nothing requested, nothing written. Re-run with --go to spend.');
    return;
  }
  if (!KEY) { console.error('  ! GOOGLE_PLACES_API_KEY is not set'); return; }

  const now = new Date().toISOString();
  let matched = 0, rejected = 0, missing = 0, failed = 0;
  const writes = [];
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < picked.length) {
      const p = picked[i++];
      try {
        const hit = await lookup(p);
        if (hit?.rating != null) {
          matched++;
          writes.push(
            `UPDATE places SET rating=${hit.rating}, reviews=${hit.reviews}, ` +
            `rating_source='google', rating_checked_at=${q(now)} WHERE id=${q(p.id)}`,
          );
        } else {
          // Checked and found nothing usable. Recorded so the next run does
          // not pay to learn the same thing again.
          hit?.rejected ? rejected++ : missing++;
          writes.push(`UPDATE places SET rating_checked_at=${q(now)} WHERE id=${q(p.id)}`);
        }
      } catch (e) {
        // NOT marked as checked: a transport failure is not an answer, and
        // marking it would permanently skip a place we never actually asked
        // about.
        failed++;
        if (failed < 5) console.warn('  !', p.name, String(e.message).slice(0, 120));
      }
      if ((matched + rejected + missing) % 250 === 0) process.stdout.write('.');
    }
  }));

  for (let k = 0; k < writes.length; k += 50) {
    sqlWrite(writes.slice(k, k + 50).join('; '));
  }
  console.log(`\n  rated ${matched} · name/distance rejected ${rejected} · no rating ${missing} · errors ${failed}`);
  console.log('  Now rebuild the ranking, or none of this is visible to a guest:');
  console.log('    npx wrangler d1 execute num-db --remote --file scripts/rank_top_places.sql');
}

if (!DESTS.length) {
  console.error('usage: enrich_ratings.mjs --dest=los-angeles [--limit=4000] [--per-cell=40] [--go]');
  process.exit(1);
}
ensureColumns();
for (const d of DESTS) await run(d);
