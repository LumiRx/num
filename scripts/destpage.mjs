#!/usr/bin/env node
/**
 * A destination page, built from what the database actually holds.
 *
 *   node scripts/destpage.mjs --only=taipei,tainan     # named destinations
 *   node scripts/destpage.mjs --country=TW             # a whole country
 *   node scripts/destpage.mjs --missing                # every dest with no page
 *   node scripts/destpage.mjs --dry                    # print, write nothing
 *
 * ── WHY A GENERATOR AND NOT NINE HAND-WRITTEN PAGES ──────────────────────
 *
 * Four destinations out of eighty-six have a page: Edinburgh, London,
 * Bangkok and Phuket. Taiwan is not behind, the other eighty-two are. Writing
 * nine Taiwanese pages by hand would have fixed the smallest part of that and
 * left the shape of the problem exactly as it was.
 *
 * ── EVERY NUMBER ON THE PAGE IS READ, NOT WRITTEN ────────────────────────
 *
 * The counts, the categories and the neighbourhoods all come out of `places`
 * at build time. That is the difference between a page that is true and a
 * page that was true once: nothing here can drift from the directory, because
 * nothing here is typed by hand.
 *
 * It also means these pages cannot be generated for a destination that has no
 * data — `--missing` skips anything under MIN_PLACES rather than publishing a
 * page that says "0 restaurants". A thin page is worse than no page; Google
 * calls the first one a doorway and the second one nothing at all.
 *
 * ── AND WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────
 *
 * No invented editorial. No "Taipei is a vibrant city of contrasts". The page
 * says what Num holds, what people ask it, and how to use it — all of which
 * is checkable. A generated paragraph of travel writing would be the one
 * thing on the page nobody could verify, and `invent_fact` applies to our own
 * marketing as much as to a concierge reply.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const arg = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? null;

/** Below this a page has nothing to say, and saying it anyway is a doorway page. */
export const MIN_PLACES = 120;

/** Categories that describe a trip, in the order a traveller cares about them. */
export const HERO_CATEGORIES = [
  'Restaurant', 'Street food', 'Café', 'Bar', 'Hotel', 'Attraction',
  'Market', 'Dessert', 'Bakery', 'Shopping', 'Beauty & spa', 'Museum',
];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = (x) => Number(x).toLocaleString('en-GB');

export function d1(sql) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'num-db', '--remote', '--json', '--command', sql], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0]?.results ?? [];
}

/**
 * The FAQ block, built from the categories this place actually has.
 *
 * Questions a traveller would really type, answered with a real number. A
 * question the data cannot answer is not asked.
 */
export function faqFor(dest, cats) {
  const by = Object.fromEntries(cats.map((c) => [c.category, c.n]));
  const qs = [];
  if (by.Restaurant) {
    qs.push([
      `How many restaurants does NUM know in ${dest.name}?`,
      `${n(by.Restaurant)}, from the open map data NUM builds its directory on. NUM does not list all of them at you — `
      + 'it picks the one that fits what you asked for, and says why.',
    ]);
  }
  if (by['Street food'] || by.Market) {
    qs.push([
      `Does NUM cover street food and markets in ${dest.name}?`,
      `Yes — ${n(by['Street food'] ?? 0)} street-food spots and ${n(by.Market ?? 0)} markets. Ask it what is open now `
      + 'and it will answer for the hour you are actually standing in.',
    ]);
  }
  if (by.Hotel) {
    qs.push([
      `Can NUM book a hotel in ${dest.name}?`,
      `NUM knows ${n(by.Hotel)} places to stay here. It cannot issue the booking itself — it takes you to whoever can, `
      + 'and it tells you that is what it is doing.',
    ]);
  }
  qs.push([
    `What language can I message NUM in for ${dest.name}?`,
    'Whatever you write in. NUM answers in the language of your message — and in the script you used, which for '
    + 'Chinese means Traditional stays Traditional.',
  ]);
  qs.push([
    `Does it cost anything?`,
    'Not for travellers. Businesses list free and pay only on a booking NUM completes, out of their side, never added '
    + 'to your bill.',
  ]);
  return qs;
}

export function render(dest, cats, areas, total) {
  const faq = faqFor(dest, cats);
  const hero = HERO_CATEGORIES.map((c) => ({ c, v: cats.find((x) => x.category === c)?.n })).filter((x) => x.v);
  const title = `${dest.name} — what NUM knows | NUM`;
  const desc = `NUM holds ${n(total)} places in ${dest.name}. Message it in any language and it answers with a real `
    + 'place, open now, and books it.';

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map(([q, a]) => ({
      '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };
  // Place + geo, so an assistant answering "what covers Taipei" has coordinates
  // and a country to cite rather than a name it has to guess about.
  const place = {
    '@context': 'https://schema.org',
    '@type': 'TouristDestination',
    name: dest.name,
    address: { '@type': 'PostalAddress', addressCountry: dest.country },
    geo: { '@type': 'GeoCoordinates', latitude: dest.lat, longitude: dest.lng },
    url: `https://itsnum.com/${dest.slug}/`,
    touristType: 'Independent travellers',
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://itsnum.com/${dest.slug}/">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="https://itsnum.com/${dest.slug}/">
<meta property="og:type" content="website">
<script type="application/ld+json">${JSON.stringify(place)}</script>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>
:root{--ink:#1B1E27;--muted:#5A5F70;--rule:#E4E6F0;--accent:#4C51A1;--bg:#FBFBFE;--card:#fff}
@media(prefers-color-scheme:dark){:root{--ink:#ECEDF3;--muted:#9AA0B4;--rule:#2A2E3C;--accent:#A9AEEA;--bg:#14161C;--card:#1B1E27}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:40px 20px 80px}
a{color:var(--accent)}
.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
h1{font-size:clamp(28px,5vw,40px);line-height:1.1;letter-spacing:-.02em;margin:0 0 14px;text-wrap:balance}
h2{font-size:20px;letter-spacing:-.01em;margin:38px 0 12px}
p{margin:0 0 14px;max-width:62ch}
.stat{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:22px 0}
.stat div{background:var(--card);border:1px solid var(--rule);border-radius:8px;padding:12px 14px}
.stat b{display:block;font-size:22px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat span{font-size:12px;color:var(--muted)}
.areas{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 14px;padding:0;list-style:none}
.areas li{background:var(--card);border:1px solid var(--rule);border-radius:999px;padding:4px 11px;font-size:13px}
details{border-top:1px solid var(--rule);padding:12px 0}
summary{cursor:pointer;font-weight:600}
details p{margin:10px 0 0;color:var(--muted)}
.cta{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:11px 20px;border-radius:999px;font-weight:600;margin-top:8px}
footer{margin-top:48px;padding-top:18px;border-top:1px solid var(--rule);font-size:13px;color:var(--muted)}
.gtx{position:fixed;right:14px;bottom:14px;z-index:9999;background:rgba(255,255,255,.92);border:1.5px solid #DDE0FB;border-radius:999px;padding:7px 14px;box-shadow:0 10px 30px rgba(76,81,161,.20);backdrop-filter:blur(10px);font-size:13px}
@media(prefers-color-scheme:dark){.gtx{background:rgba(26,29,34,.92);border-color:#2B2F36}}
.gtx .goog-te-gadget{font-size:0}.gtx .goog-te-combo{font:inherit;border:0;background:transparent;color:inherit}
body{top:0!important}.skiptranslate iframe{display:none!important}
</style>
</head>
<body>
<div class="wrap">
<p class="eyebrow">NUM · ${esc(dest.country)}</p>
<h1>A concierge that already knows ${esc(dest.name)}</h1>
<p>NUM holds <strong>${n(total)} places</strong> in ${esc(dest.name)}. You message it the way you would message a
friend who lives there — in any language — and it answers with one place, open now, and offers to book it.</p>
<p><a class="cta" href="/app/">Message NUM</a></p>

<h2>What is in the ${esc(dest.name)} directory</h2>
<div class="stat">
${hero.map((h) => `<div><b>${n(h.v)}</b><span>${esc(h.c)}</span></div>`).join('\n')}
</div>
<p>Built from open map data, kept current, and never ranked by who paid — because nobody can pay.
Placement is not for sale on NUM.</p>

${areas.length ? `<h2>Where NUM looks in ${esc(dest.name)}</h2>
<ul class="areas">${areas.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}

<h2>Questions about NUM in ${esc(dest.name)}</h2>
${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n')}

<h2>For businesses in ${esc(dest.name)}</h2>
<p>If you run somewhere here, the listing already exists. Claiming it is free, it stays free, and NUM is paid only
when it completes a booking for you — out of our side, never added to the guest's bill.
<a href="/claim/">Claim your listing</a>.</p>

<footer>NUM is a 5arz Inc. product. <a href="/">Home</a> · <a href="/destinations/">All destinations</a> ·
<a href="/business/">For business</a> · <a href="/privacy/">Privacy</a></footer>
</div>
<div id="gtx" class="gtx"></div>
<script>function gtInit(){try{new google.translate.TranslateElement({pageLanguage:'en',layout:google.translate.TranslateElement.InlineLayout.SIMPLE},'gtx')}catch(e){}}</script>
<script src="https://translate.google.com/translate_a/element.js?cb=gtInit" defer></script>
</body>
</html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  const country = arg('country');
  const missing = argv.includes('--missing');

  let where = '1=1';
  if (only) where = `slug IN (${only.map((s) => `'${s.replace(/'/g, "''")}'`).join(',')})`;
  else if (country) where = `country = '${country.replace(/'/g, "''")}'`;

  const dests = d1(`SELECT slug,name,country,lat,lng FROM destinations WHERE ${where} ORDER BY slug`);
  let built = 0;
  let skipped = 0;

  for (const dest of dests) {
    if (missing && existsSync(`public/${dest.slug}/index.html`)) { skipped += 1; continue; }
    const [{ total } = {}] = d1(`SELECT COUNT(*) AS total FROM places WHERE dest='${dest.slug}'`);
    if (!total || total < MIN_PLACES) {
      console.log(`  skip   ${dest.slug.padEnd(16)} ${total ?? 0} places — under ${MIN_PLACES}`);
      skipped += 1;
      continue;
    }
    const cats = d1(`SELECT category, COUNT(*) AS n FROM places WHERE dest='${dest.slug}' AND category IS NOT NULL GROUP BY category ORDER BY n DESC LIMIT 40`);
    const areas = d1(`SELECT area, COUNT(*) AS n FROM places WHERE dest='${dest.slug}' AND area IS NOT NULL GROUP BY area ORDER BY n DESC LIMIT 14`)
      .map((r) => r.area).filter(Boolean);

    const html = render(dest, cats, areas, total);
    if (DRY) { console.log(`  would  ${dest.slug.padEnd(16)} ${n(total)} places, ${cats.length} categories, ${areas.length} areas`); built += 1; continue; }
    mkdirSync(`public/${dest.slug}`, { recursive: true });
    writeFileSync(`public/${dest.slug}/index.html`, html);
    console.log(`  built  ${dest.slug.padEnd(16)} ${n(total)} places, ${cats.length} categories, ${areas.length} areas`);
    built += 1;
  }
  console.log(`\n${DRY ? 'DRY RUN — ' : ''}${built} page(s), ${skipped} skipped`);
}
