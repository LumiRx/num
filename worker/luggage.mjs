// Luggage storage — the gap-day answer.
//
// Small rail, real question. "We check out at eleven and fly at nine" is one
// of the few genuinely stressful hours in a trip, and the answer is a shop or
// hotel two streets away that will take the bags for £6. Num knowing that is
// worth more than its commission.
//
// Bounce gives a single affiliate link rather than an API, and their city
// pages accept it as a query parameter — so `bounce.com/city/phuket?ref=...`
// lands on the right city AND attributes. That is the whole integration.
//
// ── WHY THE CITY LIST IS SHORT AND HAND-CHECKED ──────────────────────────
//
// Bounce claims 4,000+ cities and there is no sitemap or API to enumerate
// them. A guessed slug 404s — verified: /city/nowhere-xyz returns 404 while
// /city/phuket, /city/bangkok, /city/edinburgh and /city/los-angeles all
// return 200. A 404 carrying our referral code is worse than a generic link,
// so only slugs somebody has actually fetched go in CITIES, and everything
// else falls back to the plain referral link, which always works and lets the
// traveller search themselves.
//
// Growing this list means fetching the page first. That is the whole rule.

/** Verified 200 by fetch on 30 Aug 2026. Add nothing here unfetched. */
export const CITIES = Object.freeze({
  phuket: 'phuket',
  bangkok: 'bangkok',
  edinburgh: 'edinburgh',
  'los-angeles': 'los-angeles',
});

export const luggageReady = (env) => !!env?.BOUNCE_REF;

const slug = (name) => String(name ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * The link. A verified city page when we have one, the generic referral
 * otherwise — never a guessed slug.
 */
export function luggageLink(env, place) {
  if (!luggageReady(env)) return null;
  const ref = String(env.BOUNCE_REF);
  const city = CITIES[slug(place?.name)] || CITIES[slug(place?.city)] || null;
  return city
    ? `https://bounce.com/city/${city}?ref=${encodeURIComponent(ref)}&utm_medium=link&utm_source=affiliates`
    : `https://go.bounce.com/${encodeURIComponent(ref)}`;
}

/**
 * The gate. Deliberately about BAGS, not about checking out — "what time do we
 * check out" is a question about the hotel, and answering it with a luggage
 * shop would be answering a question nobody asked.
 */
export const wantsLuggage = (text) => {
  const s = String(text ?? '');
  return /\b(luggage|bags?|suitcases?|backpacks?|rucksacks?)\b.{0,30}\b(stor(?:e|age)|drop|leave|keep|lock|hold|somewhere)\b/i.test(s)
    || /\b(stor(?:e|age)|drop|leave|lock)\b.{0,20}\b(luggage|bags?|suitcases?|backpacks?|rucksacks?)\b/i.test(s)
    || /\bleft luggage\b|\bbag drop\b|\blocker/i.test(s);
};

export function luggageBlock(url, place) {
  if (!url) return '';
  return (
    `\n\nLUGGAGE STORAGE: Bounce has vetted shops, cafés and hotels that hold bags by the day` +
    `${place?.name ? ` in ${place.name}` : ''} — ${url}\n` +
    'You CANNOT see live prices, availability or opening hours through this, so quote none of them; ' +
    'the page has the real ones. Two things worth saying because they are what people get wrong: ' +
    'their hotel will almost always hold bags for free on the day of checkout, so offer that FIRST ' +
    'and only reach for this when they have checked out somewhere that will not, or they are nowhere ' +
    'near the hotel. And bags must be collected before the shop closes, which is the trap on a late flight.'
  );
}
