/**
 * CAN A MACHINE READ THIS SITE, AND DOES IT SAY WHAT WE CLAIM IT SAYS?
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 *
 * robots.txt opens by telling every crawler what to expect from the site.
 * On 19 Sep 2026 the first line said "Structured data on every page" and 16
 * crawlable pages carried no JSON-LD at all — /host/, which was taking live
 * host signups, had no description, no canonical and no structured data. A
 * crawler could disprove the claim in one fetch, on a site whose entire
 * position is "verified, real, checked".
 *
 * Fourteen crawlable pages were in no sitemap, including /host/,
 * /business/pricing/ and /ulaanbaatar/ — an actual destination.
 *
 * None of it was anybody's fault in particular, and that is the point: there
 * was no way to see it. Nothing renders robots.txt, nothing type-checks a
 * <link rel=canonical>, and the feedback loop on a missing sitemap entry is a
 * report that comes back thin three weeks later.
 *
 *   node scripts/crawlability.mjs           report, exit 1 on a gap
 *   node scripts/crawlability.mjs --json    machine-readable
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PUB = join(ROOT, 'public');

/** Paths robots.txt tells crawlers not to fetch — judged by nothing below. */
export function disallowed(robots = readFileSync(join(PUB, 'robots.txt'), 'utf8')) {
  const star = robots.split(/^User-agent:\s*\*\s*$/mi)[1] ?? '';
  return [...star.matchAll(/^Disallow:\s*(\S+)\s*$/gim)].map((m) => m[1]);
}

export function pages(dir = PUB, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) pages(p, out);
    else if (name === 'index.html' || /\.html$/.test(name)) out.push(p);
  }
  return out;
}

export const urlOf = (p) => ('/' + relative(PUB, p)).replace(/index\.html$/, '').replace(/\.html$/, '');

/**
 * Read one attribute, honouring whichever quote opened it.
 *
 * The first version of this used [^"']+ for the value and reported every
 * /agents/ page as missing its description — because the text is "Add NUM's
 * travel places MCP server", and the apostrophe ended the match. Eleven
 * perfectly good pages were condemned by a character class. Match the
 * delimiter that opened the value, and only that one.
 */
const attr = (html, re) => { const m = html.match(re); return m ? m[2] : null; };
export const descOf = (h) => attr(h, /<meta[^>]*?name=["']description["'][^>]*?content=("|')([\s\S]*?)\1/i);
export const canonOf = (h) => attr(h, /<link[^>]*?rel=["']canonical["'][^>]*?href=("|')([\s\S]*?)\1/i);
export const hasLd = (h) => /application\/ld\+json/i.test(h);

/**
 * A page that says noindex is not a gap, it is a decision.
 *
 * The first run of this reported /host/ as missing a description, a canonical
 * and structured data, and I said so out loud before checking. /host/ carries
 * `<meta name="robots" content="noindex,nofollow">` — it is a signup surface
 * that is deliberately not in the index, along with /desk/, /here/, /my-host/,
 * /get/ and /join/. Demanding canonicals from pages that have opted out is how
 * an audit trains people to ignore it.
 */
export const noindex = (h) => {
  const m = h.match(/<meta[^>]*?name=["']robots["'][^>]*?content=("|')([\s\S]*?)\1/i);
  return !!m && /\bnoindex\b/i.test(m[2]);
};
export const titleOf = (h) => { const m = h.match(/<title[^>]*>([\s\S]*?)<\/title>/i); return m ? m[1].trim() : null; };

export function sitemapUrls(pub = PUB) {
  const urls = new Set();
  for (const f of readdirSync(pub).filter((n) => /^sitemap.*\.xml$/.test(n))) {
    const s = readFileSync(join(pub, f), 'utf8');
    if (/<sitemapindex/i.test(s)) continue;               // an index lists sitemaps, not pages
    for (const m of s.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      urls.add(m[1].replace(/^https:\/\/itsnum\.com/, '').replace(/\/$/, '') || '/');
    }
  }
  return urls;
}

/**
 * Pages that exist to be crawled. /404 is excluded — it is reachable and must
 * never be in a sitemap — as are the flyers, which are print collateral with
 * their own noindex, and anything robots.txt already refuses.
 */
export const PRINT_ONLY = ['/flyers/'];

export function audit() {
  const dis = disallowed();
  const maps = sitemapUrls();
  const rows = [];
  for (const p of pages()) {
    const u = urlOf(p);
    if (u === '/404' || u === '/404.html') continue;
    if (dis.some((d) => u.startsWith(d))) continue;
    const h = readFileSync(p, 'utf8');
    if (noindex(h)) continue;                            // opted out, not overlooked
    const print = PRINT_ONLY.some((d) => u.startsWith(d));
    rows.push({
      url: u,
      title: !!titleOf(h),
      desc: (descOf(h) || '').trim().length >= 20,
      canon: !!canonOf(h),
      ld: hasLd(h),
      inMap: maps.has(u.replace(/\/$/, '') || '/'),
      print,
    });
  }
  const dead = [...maps].filter((u) => {
    const clean = u.replace(/\/$/, '');
    return !existsSync(join(PUB, clean, 'index.html')) && !existsSync(join(PUB, `${clean}.html`)) && clean !== '';
  });
  return { rows, dead };
}

const FIELDS = [
  ['title', 'no <title>'],
  ['desc', 'no meta description'],
  ['canon', 'no canonical'],
  ['ld', 'no structured data'],
  ['inMap', 'in no sitemap'],
];

const isCli = !!process.argv[1] && process.argv[1].endsWith('crawlability.mjs');
if (isCli) {
  const { rows, dead } = audit();
  const real = rows.filter((r) => !r.print);
  const out = { pages: real.length, gaps: {}, dead_sitemap_urls: dead };
  for (const [k, label] of FIELDS) out.gaps[label] = real.filter((r) => !r[k]).map((r) => r.url);

  if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); }
  else {
    console.log(`${real.length} crawlable pages (flyers excluded: print collateral)\n`);
    for (const [, label] of FIELDS) {
      const bad = out.gaps[label];
      console.log(`${String(bad.length).padStart(3)}  ${label}${bad.length ? '\n       ' + bad.join(' ') : ''}`);
    }
    if (dead.length) console.log(`\n${dead.length} sitemap URL(s) point at a page that does not exist:\n  ${dead.join(' ')}`);
  }
  const total = FIELDS.reduce((n, [, l]) => n + out.gaps[l].length, 0) + dead.length;
  process.exit(total ? 1 : 0);
}
