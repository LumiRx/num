#!/usr/bin/env node
/**
 * NUM · is this business actually still there? — and can it be booked?
 *
 * Dre, 11 Aug 2026: "we dont need ratings for los angeles, have the locations
 * first is important. we need to filter to find which businesses are open
 * actually. so we dont waste data."
 *
 * ── ONE CRAWL, FOUR ANSWERS, NO API BILL ─────────────────────────────────
 *
 * Los Angeles has 90,263 places and 69,693 of them publish a website. That
 * website is the cheapest and most authoritative source we have, and it costs
 * nothing to read — it is the business's own front page, fetched the same way
 * every search engine and chat app fetches it. One pass gives us all four
 * things the LA launch actually needs:
 *
 *   1. LIVENESS   — the domain resolves and serves a real page. A restaurant
 *                   that closed two years ago usually stops paying for DNS
 *                   long before OSM notices, so this is the single best free
 *                   signal for "still trading".
 *   2. HOURS      — schema.org openingHoursSpecification, published by the
 *                   venue itself, folded into the 168-bit mask. LA has hours
 *                   for 3,798 of 90,263 places today. This is how that number
 *                   moves without buying anything.
 *   3. BOOKING    — which platform they take reservations on, and their ref
 *                   on it. You cannot integrate a bookings API before you
 *                   know who uses which platform, and nobody has that list.
 *                   This builds it.
 *   4. PHONE      — filled in where OSM had none.
 *
 * Ratings are deliberately NOT here. Locations and liveness first.
 *
 * ── DEAD MEANS DEAD, NOT "DIDN'T ANSWER" ─────────────────────────────────
 *
 * The dangerous failure is marking a thriving business dead because its host
 * returned 403 to a crawler, and then quietly deleting it from Los Angeles.
 * So `alive = 0` requires real evidence: DNS failure, refused connection,
 * 404/410, or a recognisable parked-domain page. A 403, a 429, a 5xx or a
 * timeout mean UNKNOWN — the row keeps `alive = NULL`, is retried later, and
 * is never hidden from a guest on the strength of a bot wall.
 *
 * Resumable: every outcome writes `alive_checked_at`, so re-running picks up
 * where it stopped. Transport failures deliberately do NOT write it.
 *
 *   node scripts/enrich_liveness.mjs --dest=los-angeles --limit=2000 --dry
 *   node scripts/enrich_liveness.mjs --dest=los-angeles --limit=20000
 *   node scripts/enrich_liveness.mjs --dest=los-angeles --recheck=90   # refresh stale rows
 */
import { execFileSync } from 'node:child_process';
import { parseHours, parseSchemaHours, toHex } from '../worker/hours.mjs';
import { detectBooking } from '../worker/booking.mjs';

const DB = 'num-db';
const argv = process.argv.slice(2);
const flag = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const has = (k) => argv.includes(`--${k}`);
const DESTS = (flag('dest') || '').split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(flag('limit') || 2000);
const RECHECK = Number(flag('recheck') || 0); // days; 0 = only never-checked rows
const DRY = has('dry');
const CONCURRENCY = Number(flag('concurrency') || 16);
const TIMEOUT = 8000;

const UA = 'NUM-concierge/1.0 (business liveness check; https://itsnum.com; info@5arz.com)';
// Parked-domain and expired-listing tells. Matched against the whole page, so
// they must be phrases a real business would never print.
const PARKED = /(this domain (?:is|may be) for sale|buy this domain|domain (?:parking|expired)|godaddy\.com\/domainsearch|sedoparking|hugedomains|namecheap parking|website coming soon|under construction|account suspended|default web site page)/i;
const CLOSED = /(permanently closed|we (?:have|are) closed(?: (?:down|for good|permanently))|has closed its doors|no longer in business|thank you for \d+ (?:wonderful )?years)/i;

const sql = (q) => {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', q], {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  });
  return JSON.parse(out)[0].results;
};
const sqlWrite = (q) => execFileSync('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--command', q], {
  encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
});
const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

function ensureColumns() {
  const cols = sql("SELECT name FROM pragma_table_info('places')").map((r) => r.name);
  const wanted = [
    ['alive', 'INTEGER'],           // 1 trading · 0 gone · NULL unknown
    ['alive_checked_at', 'TEXT'],
    ['hours_mask', 'TEXT'],         // 42 hex chars — the whole week
    ['booking_platform', 'TEXT'],
    ['booking_ref', 'TEXT'],
  ];
  for (const [name, type] of wanted) {
    if (!cols.includes(name)) {
      console.log(`  + adding column places.${name}`);
      if (!DRY) sqlWrite(`ALTER TABLE places ADD COLUMN ${name} ${type}`);
    }
  }
  if (!DRY && !cols.includes('alive')) {
    // The index the concierge query and the public API both lean on.
    sqlWrite("CREATE INDEX IF NOT EXISTS idx_places_open ON places(dest, alive, category)");
  }
}

/** Every JSON-LD block on the page, flattened — @graph and arrays included. */
function jsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        out.push(node);
        if (Array.isArray(node['@graph'])) stack.push(...node['@graph']);
      }
    } catch { /* a malformed block is not a reason to lose the good ones */ }
  }
  return out;
}

async function check(place) {
  let url = String(place.website || '').trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = String(e?.cause?.code ?? e?.message ?? '');
    // DNS gone or nothing listening: the strongest free evidence a business
    // has stopped trading. A timeout is NOT that — slow hosts are still hosts.
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ERR_INVALID_URL|ENOTFOUND/.test(msg)) return { alive: 0, why: 'dns' };
    return { unknown: true, why: msg.slice(0, 40) || 'fetch' };
  }
  clearTimeout(timer);

  if (res.status === 404 || res.status === 410) return { alive: 0, why: `http${res.status}` };
  // 403/429/5xx: a bot wall or a bad afternoon, not a closed business.
  if (!res.ok) return { unknown: true, why: `http${res.status}` };

  let html = '';
  try {
    const reader = res.body?.getReader?.();
    if (reader) {
      const dec = new TextDecoder();
      let got = 0;
      // 400 KB is well past every <head> and most footers; whole-site reads
      // would make this crawl cost real bandwidth for no extra signal.
      while (got < 400_000) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        html += dec.decode(value, { stream: true });
      }
      reader.cancel().catch(() => {});
    } else {
      html = (await res.text()).slice(0, 400_000);
    }
  } catch { return { unknown: true, why: 'body' }; }

  if (PARKED.test(html)) return { alive: 0, why: 'parked' };
  if (CLOSED.test(html)) return { alive: 0, why: 'says-closed' };

  const out = { alive: 1, why: 'ok' };
  for (const node of jsonLd(html)) {
    if (!out.mask && node.openingHoursSpecification) {
      const m = parseSchemaHours(node.openingHoursSpecification);
      if (m) out.mask = toHex(m);
    }
    if (!out.mask && node.openingHours) {
      const m = parseHours([].concat(node.openingHours).join('; '));
      if (m) out.mask = toHex(m);
    }
    if (!out.phone && typeof node.telephone === 'string') out.phone = node.telephone.slice(0, 40);
    // A ReserveAction target is the venue naming its own booking page.
    const act = [].concat(node.potentialAction ?? []).find((a) => /Reserve|Order/i.test(a?.['@type'] ?? ''));
    const target = act?.target?.urlTemplate ?? act?.target?.url ?? act?.target;
    if (typeof target === 'string') out.bookingHint = target;
  }
  const b = detectBooking(html, out.bookingHint ?? res.url);
  if (b) { out.booking = b.platform; out.ref = b.ref; }
  return out;
}

async function run(dest) {
  console.log(`\n── ${dest} ──────────────────────────────────────────────`);
  const stale = RECHECK
    ? `OR alive_checked_at < datetime('now', '-${RECHECK} days')`
    : '';
  const rows = sql(`
    SELECT id, name, website, hours, phone
      FROM places
     WHERE dest=${q(dest)}
       AND website IS NOT NULL AND website <> ''
       AND (alive_checked_at IS NULL ${stale})
     ORDER BY (hours IS NULL), name
     LIMIT ${LIMIT}
  `);
  console.log(`  ${rows.length} sites to check · concurrency ${CONCURRENCY} · no API spend`);
  if (DRY) {
    console.log('  DRY RUN — showing the first 3 only, nothing written.');
    for (const r of rows.slice(0, 3)) console.log('   ', r.name, '→', JSON.stringify(await check(r)));
    return;
  }

  const now = new Date().toISOString();
  const writes = [];
  const tally = { alive: 0, dead: 0, unknown: 0, hours: 0, booking: 0, phone: 0 };
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < rows.length) {
      const r = rows[i++];
      const res = await check(r).catch(() => ({ unknown: true, why: 'threw' }));
      const set = [`alive_checked_at=${q(now)}`];
      if (res.unknown) {
        tally.unknown++;
        // Still stamped: without it the same unreachable host is retried on
        // every run forever and the crawl never finishes.
      } else {
        set.push(`alive=${res.alive}`);
        res.alive ? tally.alive++ : tally.dead++;
      }
      // Never overwrite hours we already hold — OSM's are often hand-checked.
      if (res.mask) { set.push(`hours_mask=${q(res.mask)}`); tally.hours++; }
      if (res.booking) { set.push(`booking_platform=${q(res.booking)}`, `booking_ref=${q(res.ref)}`); tally.booking++; }
      if (res.phone && !r.phone) { set.push(`phone=${q(res.phone)}`); tally.phone++; }
      writes.push(`UPDATE places SET ${set.join(', ')} WHERE id=${q(r.id)}`);
      if (writes.length % 200 === 0) process.stdout.write('.');
    }
  }));

  for (let k = 0; k < writes.length; k += 50) sqlWrite(writes.slice(k, k + 50).join('; '));

  // Backfill the mask for rows whose OSM `hours` string we can already parse
  // — free, local, and it is the bulk of what exists today.
  const local = sql(`
    SELECT id, hours FROM places
     WHERE dest=${q(dest)} AND hours IS NOT NULL AND hours <> '' AND hours_mask IS NULL
     LIMIT 20000
  `);
  const backfill = [];
  for (const r of local) {
    const m = parseHours(r.hours);
    if (m) backfill.push(`UPDATE places SET hours_mask=${q(toHex(m))} WHERE id=${q(r.id)}`);
  }
  for (let k = 0; k < backfill.length; k += 50) sqlWrite(backfill.slice(k, k + 50).join('; '));

  console.log(`\n  trading ${tally.alive} · gone ${tally.dead} · unknown ${tally.unknown}`);
  console.log(`  hours from sites ${tally.hours} · from existing strings ${backfill.length} · booking links ${tally.booking} · phones ${tally.phone}`);
  console.log(`  storage added ≈ ${Math.round(((tally.hours + backfill.length) * 42 + tally.booking * 24) / 1024)} KB`);
}

if (!DESTS.length) {
  console.error('usage: enrich_liveness.mjs --dest=los-angeles [--limit=2000] [--recheck=90] [--dry]');
  process.exit(1);
}
ensureColumns();
for (const d of DESTS) await run(d);
