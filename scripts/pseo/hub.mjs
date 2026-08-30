/**
 * The hub, and the sitemaps that tell Google where the spokes are.
 *
 * The guide's hub-and-spoke rule is not decoration. A set page that nothing
 * links to is a doorway page by Google's own definition however good its
 * content is, and the only thing standing between 2,910 candidate pages and
 * that label is that each one is reachable, links to its siblings, and links
 * back up to something a human would actually browse.
 *
 * Two sitemaps, not one:
 *
 *   /sitemap.xml         the 27 hand-written pages, unchanged
 *   /sitemap-guides.xml  the generated set pages
 *   /sitemap_index.xml   points at both
 *
 * Segmenting them is what makes indexation legible. One mixed sitemap gives a
 * single Coverage number in Search Console that blends a hand-written pricing
 * page with a generated census, and when that number moves there is no way to
 * tell which half moved. Split, the indexation rate of the generated set is
 * readable on its own — which is the number that decides whether this whole
 * strategy is working or quietly earning a penalty.
 */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SITE = 'https://itsnum.com';

/** /sitemap-guides.xml — every generated set page. */
export function guidesSitemap(built, today) {
  const urls = built.map((b) =>
    `  <url><loc>${SITE}${esc(b.path)}</loc><lastmod>${today}</lastmod>` +
    `<changefreq>monthly</changefreq><priority>0.7</priority></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}/guides/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>
${urls}
</urlset>
`;
}

/** /sitemap_index.xml — the two segments. */
export function sitemapIndex(today) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${SITE}/sitemap.xml</loc><lastmod>${today}</lastmod></sitemap>
  <sitemap><loc>${SITE}/sitemap-guides.xml</loc><lastmod>${today}</lastmod></sitemap>
</sitemapindex>
`;
}

/**
 * /guides/ — the page a person would actually browse, which is the test.
 *
 * Grouped by destination rather than by kind of place, because that is how
 * somebody planning a trip thinks, and because it makes the shape of the
 * coverage honest: a city with two guides looks like a city with two guides.
 */
export function hubPage(built, candidates, dests, today) {
  const byDest = new Map();
  for (const b of built) {
    if (!byDest.has(b.dest)) byDest.set(b.dest, []);
    byDest.get(b.dest).push(b);
  }
  const cities = [...byDest.entries()]
    .map(([slug, rows]) => ({
      slug,
      name: dests.get(slug)?.name || slug,
      rows: rows.sort((a, b) => a.title.localeCompare(b.title)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const total = built.length;
  const places = built.reduce((a, b) => a + b.places, 0);

  const body = cities.map((c) => `
  <h2>${esc(c.name)}</h2>
  <ul class="also">
${c.rows.map((r) => `    <li><a href="${esc(r.path)}">${esc(r.title[0].toUpperCase() + r.title.slice(1))}</a> <span class="geo">${r.places}</span></li>`).join('\n')}
  </ul>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NUM guides — every one we have mapped in full</title>
<meta name="description" content="Complete, counted lists from NUM's directory of ${Number(2529721).toLocaleString('en-GB')} places — every beach, every viewpoint, every luggage locker in a city, with coordinates.">
<link rel="canonical" href="${SITE}/guides/">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta property="og:type" content="website"><meta property="og:site_name" content="NUM">
<meta property="og:title" content="NUM guides — mapped in full">
<meta property="og:url" content="${SITE}/guides/">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site.css">
<script src="/num-capture.js" data-page="guides" defer></script>
<style>.prose{max-width:72ch}.also{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 0;padding:0;list-style:none}
.also a{font-size:14px;text-decoration:none;border:1px solid var(--line,#e0ddd4);border-radius:999px;padding:6px 14px}
.also .geo{color:var(--ink2);font-size:12px}.prose h2{margin-top:34px;font-size:19px}</style>
</head>
<body>
<nav class="nav"><div class="wrap row">
  <a class="brand" href="/"><span class="dot"></span>NUM <small>travel concierge</small></a>
  <div class="navlinks">
    <a href="/what-we-do/">What we do</a><a href="/app/">Get the app</a>
    <a href="/how-it-works/">How it works</a><a href="/destinations/">Destinations</a>
    <a class="btn pri" href="/get/" style="padding:10px 18px;font-size:14px">Ask NUM</a>
  </div>
  <button class="menu-btn" aria-label="Menu">&#9776;</button>
</div></nav>
<header class="wrap" style="padding-top:56px;padding-bottom:8px">
  <span class="pill">&#10022; From NUM's directory</span>
  <h1 class="h1" style="margin-top:18px;max-width:20ch">Mapped in full.</h1>
  <p class="sub" style="max-width:62ch">Most travel lists are a top ten written from a desk. These are complete:
  every one we hold, counted, with coordinates &mdash; and a line from the concierge on the ones worth
  going out of your way for. ${total} guide${total === 1 ? '' : 's'} so far, covering ${places.toLocaleString('en-GB')} places.</p>
</header>
<section class="wrap prose">
${body}
  <h2 style="margin-top:44px">Why these and not everything</h2>
  <p>NUM's directory holds 2,529,721 places across 77 destinations. Only some of that
  makes a guide worth publishing: the set has to be small enough to list completely, so the
  count in the headline is something you can check by scrolling, and somebody here has to have
  something worth saying about it. Where we have the places but not the judgement, there is no
  page &mdash; ${(candidates - total).toLocaleString('en-GB')} sets are mapped and waiting on that.</p>
  <p style="margin-top:26px"><a class="btn pri" href="/get/">Ask NUM about anywhere else</a></p>
</section>
<footer class="wrap" style="padding:48px 0;color:var(--ink2);font-size:14px">
  &copy; 2026 NUM &middot; by 5arz &nbsp;&middot;&nbsp;
  <a href="/destinations/">All destinations</a> &nbsp;&middot;&nbsp;
  <a href="/how-it-works/">How NUM works</a>
</footer>
</body>
</html>
`;
}
