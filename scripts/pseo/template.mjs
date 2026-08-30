/**
 * The set page, rendered.
 *
 * Modelled exactly on /phuket/beaches/, which was written by hand in August
 * 2026 and is the proof that this shape works: a census nobody else publishes,
 * with a human line on top of the ones worth picking out.
 *
 * The order of the page is the argument it makes:
 *
 *   1. the count, stated plainly in the H1 — the claim only a complete
 *      directory can make
 *   2. the concierge's picks, with the judgement a machine cannot write
 *   3. the rest of the census, so the count in the H1 is verifiable by
 *      scrolling rather than merely asserted
 *   4. one thing worth knowing, written by a person
 *   5. the way out — ask NUM, which answers with today's season and the
 *      reader's actual location, which a static page cannot
 *
 * Nothing here invents a fact. Every name, coordinate and local-language
 * spelling comes from the directory; every sentence of judgement comes from
 * the take file. If a place has no judgement written for it, it appears in the
 * census with its coordinates and nothing else, rather than with a generated
 * sentence that would read like knowledge and be none.
 */

import { localNameFor } from './localname.mjs';

export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * JSON-LD, safe to sit inside a <script> block.
 *
 * JSON.stringify does not escape "<", so a place name containing the six
 * characters `</script>` — and these names were crawled off the open web, so
 * one eventually will — closes the block early and everything after it is
 * parsed as HTML. Escaping the three characters that can start a tag or a
 * comment is the fix the schema.org docs and every framework use.
 */
export const jsonld = (o) => JSON.stringify(o)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

const coord = (lat, lng) => `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`;

/**
 * A take is written in a text editor, so *nasoni* means italics.
 *
 * Applied AFTER esc(), never before: the take file is trusted to be written
 * by a colleague, but "trusted" and "allowed to inject arbitrary HTML into
 * every page on the site" are not the same sentence, and the order of these
 * two calls is the whole difference.
 */
const em = (escaped) => String(escaped).replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

/** schema.org type for a set, so the markup says what the things ARE. */
const SCHEMA_TYPE = {
  beaches: 'Beach', parks: 'Park', museums: 'Museum', galleries: 'Museum',
  temples: 'PlaceOfWorship', churches: 'Church', mosques: 'Mosque',
  synagogues: 'PlaceOfWorship', 'places-of-worship': 'PlaceOfWorship',
  monasteries: 'PlaceOfWorship', theatres: 'PerformingArtsTheater',
  cinemas: 'MovieTheater', 'music-venues': 'MusicVenue', hostels: 'Hostel',
  guesthouses: 'BedAndBreakfast', resorts: 'Resort', inns: 'Hotel',
  lodges: 'Hotel', campgrounds: 'Campground', 'metro-stations': 'SubwayStation',
  'train-stations': 'TrainStation', 'bus-stations': 'BusStation',
  'airport-terminals': 'Airport', markets: 'ShoppingCenter',
  'flea-markets': 'ShoppingCenter', bookshops: 'BookStore',
  vegan: 'Restaurant', vegetarian: 'Restaurant', halal: 'Restaurant',
  seafood: 'Restaurant', 'health-food': 'Restaurant', 'street-food': 'Restaurant',
  breweries: 'BarOrPub', 'beer-gardens': 'BarOrPub', 'whisky-bars': 'BarOrPub',
  'sake-bars': 'BarOrPub', 'gay-bars': 'BarOrPub', 'irish-pubs': 'BarOrPub',
  'hotel-bars': 'BarOrPub', 'cocktail-bars': 'BarOrPub', 'shisha-bars': 'BarOrPub',
  'jazz-bars': 'BarOrPub', wineries: 'Winery', zoos: 'Zoo', aquariums: 'Aquarium',
  'theme-parks': 'AmusementPark', 'water-parks': 'AmusementPark',
  golf: 'GolfCourse', 'tennis-courts': 'TennisComplex', pools: 'PublicSwimmingPool',
  playgrounds: 'Playground', 'dog-parks': 'Park', 'national-parks': 'Park',
  'bowling': 'BowlingAlley', 'tattoo-studios': 'TattooParlor',
};

/**
 * The full page.
 *
 * @param {object} o
 * @param {{slug:string,name:string,country:string}} o.dest
 * @param {object} o.set     the candidate row from candidates.json
 * @param {object} o.take    the parsed take
 * @param {Array}  o.places  every place in the set, from the directory
 * @param {Array}  o.related sibling sets in the same destination, for linking
 */
export function renderSet({ dest, set, take, places, related, today }) {
  const type = SCHEMA_TYPE[set.slug] || 'TouristAttraction';
  const n = places.length;
  const title = take.title || `All ${n} ${set.title} in ${dest.name}, mapped`;

  // Picks keep the order the writer put them in — that ordering IS an opinion,
  // and re-sorting it alphabetically would throw the opinion away.
  const byName = new Map(places.map((p) => [p.name, p]));
  const picks = take.picks.map((p) => ({ ...p, place: byName.get(p.key) })).filter((p) => p.place);
  const pickedNames = new Set(picks.map((p) => p.key));
  const rest = places
    .filter((p) => !pickedNames.has(p.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));

  // Only when it is genuinely the destination's own script — see
  // localname.mjs. name_local is a grab-bag: it holds Russian for a Thai
  // beach and Spanish for a Tokyo viewing deck, and printing that as "the
  // local name" would be a small confident lie repeated across every page.
  const localName = (p) => {
    const alt = localNameFor(p, dest.country);
    return alt ? ` <span class="th">${esc(alt)}</span>` : '';
  };

  const itemList = {
    '@type': 'ItemList',
    name: `${set.title[0].toUpperCase()}${set.title.slice(1)} in ${dest.name}`,
    numberOfItems: n,
    itemListElement: [...picks.map((p) => p.place), ...rest].map((p, i) => {
      const item = {
        '@type': type,
        name: p.name,
        geo: { '@type': 'GeoCoordinates', latitude: p.lat, longitude: p.lng },
        containedInPlace: { '@type': 'City', name: dest.name },
      };
      const alt = localNameFor(p, dest.country);
      if (alt) item.alternateName = alt;
      if (p.website) item.url = p.website;
      const pick = picks.find((x) => x.key === p.name);
      if (pick) item.description = pick.value;
      return { '@type': 'ListItem', position: i + 1, item };
    }),
  };

  const graph = [itemList, {
    '@type': 'WebPage',
    '@id': `https://itsnum.com${set.path}#webpage`,
    url: `https://itsnum.com${set.path}`,
    name: title,
    description: take.sub,
    isPartOf: { '@id': 'https://itsnum.com/#website' },
    inLanguage: 'en',
    datePublished: today,
    dateModified: today,
  }];
  if (take.faq.length) {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: take.faq.map((f) => ({
        '@type': 'Question',
        name: f.key,
        acceptedAnswer: { '@type': 'Answer', text: f.value },
      })),
    });
  }

  const k = (s) => esc(s);
  const nav = `<nav class="nav"><div class="wrap row">
  <a class="brand" href="/"><span class="dot"></span>NUM <small>travel concierge</small></a>
  <div class="navlinks">
    <a href="/what-we-do/">What we do</a>
    <a href="/app/">Get the app</a><a href="/how-it-works/">How it works</a><a href="/destinations/">Destinations</a>
    <a href="/business/">For business</a>
    <a class="btn pri" href="/get/" style="padding:10px 18px;font-size:14px">Ask NUM</a>
  </div>
  <button class="menu-btn" aria-label="Menu">&#9776;</button>
</div>
<div class="mobile"><a href="/app/">Get the app</a><a href="/how-it-works/">How it works</a><a href="/destinations/">Destinations</a><a href="/business/">For business</a></div>
</nav>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${k(title)} — NUM</title>
<meta name="description" content="${k(take.sub).slice(0, 300)}">
<link rel="canonical" href="https://itsnum.com${set.path}">
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
<meta property="og:type" content="article"><meta property="og:site_name" content="NUM">
<meta property="og:title" content="${k(title)}">
<meta property="og:description" content="${k(take.sub).slice(0, 300)}">
<meta property="og:url" content="https://itsnum.com${set.path}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site.css">
<script type="application/ld+json">${jsonld({ '@context': 'https://schema.org', '@graph': graph })}</script>
<script src="/num-capture.js" data-page="set-${k(dest.slug)}-${k(set.slug)}" defer></script>
<style>.prose{max-width:72ch}.prose li{margin:10px 0;line-height:1.6}.th{color:var(--ink2);font-size:.92em}.geo{color:var(--ink2);font-size:.85em;font-family:ui-monospace,monospace}.prose h2{margin-top:40px}.also{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 0;padding:0;list-style:none}.also a{font-size:14px;text-decoration:none;border:1px solid var(--line,#e0ddd4);border-radius:999px;padding:6px 14px}</style>
</head>
<body>
${nav}
<header class="wrap" style="padding-top:56px;padding-bottom:8px">
  <span class="pill">&#10022; From NUM's directory &middot; updated ${k(today)}</span>
  <h1 class="h1" style="margin-top:18px;max-width:22ch">${k(title)}.</h1>
  <p class="sub" style="max-width:62ch">${em(k(take.sub))}</p>
</header>
<section class="wrap prose">
<h2>Where the concierge points people first</h2>
<ul>
${picks.map((p) => `  <li><b>${esc(p.place.name)}</b>${localName(p.place)} &mdash; ${em(esc(p.value))} <span class="geo">(${coord(p.place.lat, p.place.lng)})</span></li>`).join('\n')}
</ul>

${rest.length ? `<h2>The rest of the ${k(set.title)} in ${k(dest.name)} &mdash; every one we hold</h2>
<ul>
${rest.map((p) => `  <li>${esc(p.name)}${localName(p)} <span class="geo">(${coord(p.lat, p.lng)})</span></li>`).join('\n')}
</ul>` : ''}

<h2>${k(take.knowHeading || 'The one thing to know')}</h2>
<p>${em(k(take.know))}</p>

<p style="margin-top:32px"><a class="btn pri" href="/get/">${k(take.cta || `Ask NUM about ${dest.name}`)}</a></p>

${related.length ? `<h2>Also in ${k(dest.name)}</h2>
<ul class="also">
${related.map((r) => `  <li><a href="${esc(r.path)}">${esc(r.title[0].toUpperCase() + r.title.slice(1))}</a></li>`).join('\n')}
</ul>` : ''}
</section>
<footer class="wrap" style="padding:48px 0;color:var(--ink2);font-size:14px">
  &copy; 2026 NUM &middot; by 5arz &nbsp;&middot;&nbsp;
  <a href="/guides/">All NUM guides</a> &nbsp;&middot;&nbsp;
  <a href="/destinations/">All destinations</a> &nbsp;&middot;&nbsp;
  <a href="/how-it-works/">How NUM works</a>
</footer>
</body>
</html>
`;
}
