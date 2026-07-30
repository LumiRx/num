#!/usr/bin/env node
/**
 * NUM · free photo enrichment for the places directory.
 *
 * Two legitimate, free sources — no API key, no scraping of anyone's gallery:
 *
 *   1. The venue's OWN og:image / twitter:image. This is the picture the
 *      business publishes for link previews; every chat app and search engine
 *      fetches it the same way. Best hit rate for restaurants, bars, hotels.
 *   2. Wikimedia Commons geosearch (CC-licensed, attribution stored). Used
 *      ONLY for landmark-ish categories with a tight radius — a geotagged
 *      photo near a small bar is usually a photo of the street, not the bar.
 *
 * Attribution and licence are stored alongside every Commons photo because
 * CC requires it; the UI shows them.
 *
 *   node scripts/enrich_photos.mjs --dest=los-angeles --limit=400
 *   node scripts/enrich_photos.mjs --dest=miami,new-york --limit=200 --dry
 */
import { execFileSync } from 'node:child_process';

const DB = 'num-db';
const argv = process.argv.slice(2);
const flag = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const has = (k) => argv.includes(`--${k}`);
const DESTS = (flag('dest') || '').split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(flag('limit') || 250);
const DRY = has('dry');
const CONCURRENCY = 6;

const UA = 'NUM-concierge/1.0 (link preview + Commons geosearch; https://itsnum.com; info@5arz.com)';
// Categories where a geotagged Commons photo plausibly IS the place.
const LANDMARK = /attraction|museum|gallery|viewpoint|landmark|theme park|zoo|aquarium|park|beach|temple|place of worship|theatre|monument/i;
// Filenames that are branding, not a photo of the venue.
const LOGO_RE = /logo|favicon|icon[-_.]|sprite|placeholder|default[-_.]og/i;

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

async function ensureColumns() {
  const cols = sql("SELECT name FROM pragma_table_info('places')").map((r) => r.name);
  const wanted = [
    ['photo_url', 'TEXT'], ['photo_attr', 'TEXT'], ['photo_license', 'TEXT'],
    ['photo_source', 'TEXT'], ['photo_checked_at', 'TEXT'],
  ];
  for (const [name, type] of wanted) {
    if (!cols.includes(name)) {
      console.log(`  + adding column places.${name}`);
      if (!DRY) sqlWrite(`ALTER TABLE places ADD COLUMN ${name} ${type}`);
    }
  }
}

const fetchText = async (url, bytes = 250_000) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, bytes));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** The venue's own link-preview image. */
async function fromWebsite(site) {
  const html = await fetchText(site);
  if (!html) return null;
  const pats = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)/i,
  ];
  for (const re of pats) {
    const m = html.match(re);
    if (!m) continue;
    let url = m[1].trim().replace(/&amp;/g, '&');
    if (url.startsWith('//')) url = 'https:' + url;
    if (url.startsWith('/')) {
      try { url = new URL(url, site).href; } catch { continue; }
    }
    if (!/^https?:\/\//i.test(url)) continue;
    if (LOGO_RE.test(url)) continue;               // branding, not the venue
    if (url.length > 500) continue;
    return { url, source: 'website', attr: null, license: 'venue link-preview image' };
  }
  return null;
}

/** Geotagged CC photo from Wikimedia Commons — landmarks only, tight radius. */
async function fromCommons(lat, lng) {
  const api =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=geosearch' +
    `&ggscoord=${lat}|${lng}&ggsradius=120&ggslimit=3&ggsnamespace=6` +
    '&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=900';
  const raw = await fetchText(api, 400_000);
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  const pages = Object.values(data?.query?.pages ?? {});
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii?.thumburl) continue;
    if (LOGO_RE.test(ii.thumburl)) continue;
    const md = ii.extmetadata ?? {};
    const strip = (s) => (s ? String(s).replace(/<[^>]*>/g, '').trim().slice(0, 200) : null);
    return {
      url: ii.thumburl,
      source: 'wikimedia',
      attr: strip(md.Artist?.value) || 'Wikimedia Commons',
      license: strip(md.LicenseShortName?.value) || 'CC',
    };
  }
  return null;
}

async function enrichDest(dest) {
  // Highest-value first: what Num actually recommends (rated, then reviewed).
  const rows = sql(
    `SELECT id, name, category, website, lat, lng FROM places
     WHERE dest=${q(dest)} AND photo_checked_at IS NULL
       AND ((website IS NOT NULL AND website != '') OR category LIKE '%Attraction%' OR category LIKE '%Museum%' OR category LIKE '%Gallery%' OR category LIKE '%Viewpoint%')
     ORDER BY (rating IS NULL), rating DESC, reviews DESC
     LIMIT ${LIMIT}`,
  );
  console.log(`\n${dest}: ${rows.length} candidates`);
  if (!rows.length) return { found: 0, checked: 0 };

  let found = 0, checked = 0;
  const updates = [];
  const queue = [...rows];

  const worker = async () => {
    while (queue.length) {
      const p = queue.shift();
      checked++;
      let hit = null;
      if (p.website) hit = await fromWebsite(p.website);
      if (!hit && LANDMARK.test(p.category || '')) hit = await fromCommons(p.lat, p.lng);
      if (hit) {
        found++;
        updates.push(
          `UPDATE places SET photo_url=${q(hit.url)}, photo_attr=${q(hit.attr)}, photo_license=${q(hit.license)}, ` +
            `photo_source=${q(hit.source)}, photo_checked_at=datetime('now') WHERE id=${q(p.id)}`,
        );
      } else {
        updates.push(`UPDATE places SET photo_checked_at=datetime('now') WHERE id=${q(p.id)}`);
      }
      if (checked % 25 === 0) process.stdout.write(`    ${checked}/${rows.length} checked, ${found} photos\r`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`    ${checked}/${rows.length} checked, ${found} photos found`);
  if (!DRY && updates.length) {
    for (let i = 0; i < updates.length; i += 40) {
      sqlWrite(updates.slice(i, i + 40).join('; '));
      process.stdout.write(`    writing ${Math.min(i + 40, updates.length)}/${updates.length}\r`);
    }
    console.log(`    ✓ written to D1                    `);
  }
  return { found, checked };
}

const dests = DESTS.length ? DESTS : sql('SELECT slug FROM destinations WHERE live=1').map((r) => r.slug);
await ensureColumns();
let tf = 0, tc = 0;
for (const d of dests) {
  const { found, checked } = await enrichDest(d);
  tf += found; tc += checked;
}
console.log(`\n✅ ${tf} photos across ${tc} places checked${DRY ? ' (dry run)' : ''}`);
