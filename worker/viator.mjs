// Viator — the first rail that answers "what should we actually DO here?"
//
// ── WHY THIS ONE, OUT OF EVERYTHING RESEARCHED ───────────────────────────
//
// Num's specialists already talk about tours, islands, kids' afternoons and
// day trips. It has never been able to see one. Every other candidate in that
// category is gated on traffic we do not have (GetYourGuide wants 100k monthly
// visits, Tiqets wants 200 orders a month) or is a sales cycle. Viator issues
// a Basic Access key from the dashboard the moment the account exists — no
// minimum, no call, no queue — and it is the only single API whose inventory
// covers Phuket, Bangkok, Edinburgh and Los Angeles at once, which happens to
// be exactly the four places Num's traffic comes from.
//
// ── WHAT BASIC ACCESS IS, AND WHAT IT IS NOT ─────────────────────────────
//
// It searches. It does not book. That distinction is the same one Sabre
// forced on us and it has to be respected in exactly the same way: Num may
// state a real price, a real rating and a real duration as fact, and must
// never say "booked". The purchase happens on Viator's own page, through the
// attributed link, and the commission accrues there.
//
// This is not a lesser outcome. A concierge that says "Phang Nga by longtail,
// 4.8 from 2,100 reviews, about £38, leaves 07:30 — here's the page" has done
// the entire job except the tapping. The failure mode we are avoiding is the
// one from 18 Aug: claiming the tapping too.
//
// ── THE DESTINATION PROBLEM ──────────────────────────────────────────────
//
// Num knows places as (name, lat, lng). Viator knows them as numeric
// destination IDs, and the search filter takes the ID and nothing else. So
// every search needs a resolve step first, against a taxonomy of thousands of
// destinations that changes rarely.
//
// Fetching that taxonomy per request would be absurd — it is a large payload
// and it is the same answer every time. It is cached in module scope for the
// life of the isolate, with a TTL so a long-lived isolate eventually notices a
// new destination. The cache is deliberately NOT a Map keyed by query: it is
// the whole taxonomy, resolved locally, because a name miss should cost
// nothing rather than another round trip.
//
// Matching is by normalised name with a parent-name tiebreak. "Kata" must not
// resolve to Kathmandu — that exact bug cost us a beach in August — so a match
// shorter than four characters is refused outright rather than fuzzily
// accepted, and we prefer an exact normalised hit over any prefix hit.

const BASE = 'https://api.viator.com/partner';

/** The taxonomy is stable for days; an hour is generous and still bounded. */
const TAXONOMY_TTL_MS = 60 * 60 * 1000;

/** Never resolve a place name this short — it is how a beach becomes a country. */
export const MIN_NAME_LEN = 4;

export const viatorReady = (env) => !!env?.VIATOR_API_KEY;

const headers = (env, lang = 'en-US') => ({
  'exp-api-key': env.VIATOR_API_KEY,
  Accept: 'application/json;version=2.0',
  'Accept-Language': lang,
  'Content-Type': 'application/json',
});

/**
 * Strip a place name down to something two sources can agree on.
 * Diacritics, punctuation and the words that differ between gazetteers.
 */
export function normalise(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(city|province|prefecture|district|region|island|beach)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

let taxonomyCache = null;

/** Test seam — module-level state must not leak between cases. */
export const _resetForTests = () => { taxonomyCache = null; };

async function taxonomy(env, fetchImpl = fetch) {
  if (taxonomyCache && Date.now() - taxonomyCache.at < TAXONOMY_TTL_MS) return taxonomyCache.rows;
  const res = await fetchImpl(`${BASE}/v1/taxonomy/destinations`, { headers: headers(env) });
  if (!res.ok) throw new Error(`viator taxonomy ${res.status}`);
  const body = await res.json();
  const raw = (body?.data || body?.destinations || []).map((d) => ({
    id: d.destinationId ?? d.id,
    name: d.destinationName ?? d.name ?? '',
    parentId: d.parentId ?? null,
    type: d.destinationType ?? d.type ?? '',
    // `selectable: false` means Viator will not accept it as a search filter.
    // Undefined is treated as selectable — an older payload should degrade to
    // the previous behaviour, not to an empty result set.
    selectable: d.selectable !== false,
    lat: Number.isFinite(d.latitude) ? d.latitude : null,
    lng: Number.isFinite(d.longitude) ? d.longitude : null,
    norm: normalise(d.destinationName ?? d.name ?? ''),
  })).filter((d) => d.id && d.norm);

  // The taxonomy gives `parentId`, not a parent NAME — the first version of
  // this file assumed a name and the country tiebreak therefore never fired
  // once. Resolve it here, one pass, so `parent` means what the rest of the
  // module thinks it means.
  const byId = new Map(raw.map((d) => [d.id, d]));
  const rows = raw.map((d) => ({ ...d, parent: byId.get(d.parentId)?.name ?? '' }));

  taxonomyCache = { at: Date.now(), rows };
  return rows;
}

const R_KM = 6371;
const rad = (x) => (x * Math.PI) / 180;
/** Great-circle distance in km. Good enough to tell a beach from a country. */
export function haversine(a, b, c, d) {
  const dLat = rad(c - a), dLng = rad(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A coordinate this far from a destination is not that destination. */
export const NEAR_KM = 120;

/**
 * Place → Viator destination id, or null.
 *
 * ── WHY COORDINATES COME FIRST ───────────────────────────────────────────
 *
 * The first version of this resolver matched on name and used the country as
 * a tiebreak. That is backwards, and the taxonomy is what proved it: every
 * destination carries a latitude and longitude. Num already knows where the
 * traveller is standing to five decimal places. Matching "kata" as a STRING
 * against a list containing "Kathmandu" is guessing; asking which Viator
 * destination is nearest to 7.82N 98.30E is knowing.
 *
 * So: if we have coordinates, they decide, and the name is only used to break
 * ties between near-equidistant candidates. If we do not, we fall back to the
 * old string path with its guards intact.
 *
 * The August bug — a guest in Kata, Phuket told they were in Kathmandu — is
 * impossible on the coordinate path, because Kathmandu is 3,000km away.
 */
export function resolve(rows, place, country = '') {
  // Back-compat: this used to take a bare name string.
  const p = typeof place === 'string' ? { name: place } : (place || {});
  const q = normalise(p.name);
  const cn = normalise(country || p.country_code || p.country || '');
  const lat = Number.isFinite(p.lat) ? p.lat : null;
  const lng = Number.isFinite(p.lng) ? p.lng : null;

  // Viator rejects a destination it has marked unselectable, so a beautifully
  // resolved id we cannot search with is worse than no id at all.
  const usable = rows.filter((r) => r.selectable);
  const pool = usable.length ? usable : rows;

  // ── COORDINATE PATH ────────────────────────────────────────────────────
  if (lat != null && lng != null) {
    const near = pool
      .filter((r) => r.lat != null && r.lng != null)
      .map((r) => ({ r, km: haversine(lat, lng, r.lat, r.lng) }))
      .filter((x) => x.km <= NEAR_KM)
      .sort((a, b) => a.km - b.km);

    if (near.length) {
      // A name match among the nearby ones is the best of both signals.
      const named = q.length >= MIN_NAME_LEN ? near.filter((x) => x.r.norm === q) : [];
      if (named.length) return named[0].r.id;
      // Otherwise the nearest thing Viator will actually let us search.
      return near[0].r.id;
    }
    // Coordinates that match nothing within NEAR_KM mean Viator has no
    // destination there. Fall through: a name hit may still be right (a
    // regional parent, say), and returning null is always allowed.
  }

  // ── NAME PATH ──────────────────────────────────────────────────────────
  if (q.length < MIN_NAME_LEN) return null;

  const pick = (list) => {
    if (!list.length) return null;
    // Only a country NAME can narrow this. Num passes an ISO-3166 alpha-2
    // code ('TH'), and substring-matching a two-letter code against parent
    // names is worse than useless: 'th' is inside 'Thailand' by luck and
    // inside 'Netherlands', 'South Africa' and 'Lithuania' by accident. Viator
    // names parents in English words, so anything under four characters is a
    // code and is ignored here — the coordinate path above is what resolves
    // those, and it does it properly.
    if (cn.length >= 4) {
      const inCountry = list.filter((r) => r.parent && (normalise(r.parent).includes(cn) || cn.includes(normalise(r.parent))));
      if (inCountry.length) list = inCountry;
    }
    const broad = list.filter((r) => /region|country|island/i.test(r.type));
    return (broad[0] || list[0]).id;
  };

  const exact = pool.filter((r) => r.norm === q);
  if (exact.length) return pick(exact);

  const prefix = pool.filter((r) => r.norm.startsWith(`${q} `));
  return prefix.length ? pick(prefix) : null;
}

/**
 * Attribution.
 *
 * Viator already returns a productUrl carrying the partner id, so the correct
 * move is to USE it rather than to rebuild the URL — a hand-built link is a
 * link that silently stops paying when they change their format. We only add
 * our own campaign marker, and we add it without disturbing anything already
 * on the URL.
 */
export function attributed(productUrl, campaign = 'num') {
  if (!productUrl) return null;
  try {
    const u = new URL(productUrl);
    if (!u.searchParams.has('campaign')) u.searchParams.set('campaign', campaign);
    return u.toString();
  } catch {
    return null;
  }
}

/** What the model is allowed to see. Trimmed hard — a 40-field product is noise. */
export function shape(p) {
  // Viator's docs show pricing both as `pricing.summary.fromPrice` and as a
  // flat `pricing.fromPrice`, and duration as an integer of minutes or an
  // object. Reading only one shape is how a product silently loses its price
  // and gets dropped by the filter below, so read both and prefer the richer.
  const pr = p?.pricing ?? {};
  const price = pr?.summary?.fromPrice ?? pr?.fromPrice ?? pr?.summary?.fromPriceBeforeDiscount ?? null;
  const d = p?.duration;
  const mins = typeof d === 'number' ? d : (d?.fixedDurationInMinutes ?? d?.variableDurationFromMinutes ?? null);
  const duration = d?.description ?? (mins ? (mins >= 60 ? `${Math.round((mins / 60) * 10) / 10}h` : `${mins}m`) : null);
  const img = p?.images?.[0];
  return {
    code: p?.productCode ?? null,
    title: p?.title ?? '',
    blurb: String(p?.description ?? '').slice(0, 220),
    from: price == null ? null : Number(price),
    currency: pr?.currency ?? pr?.summary?.currency ?? null,
    rating: p?.reviews?.combinedAverageRating ?? null,
    reviews: p?.reviews?.totalReviews ?? null,
    duration,
    url: attributed(p?.productUrl),
    image: img?.variants?.slice(-1)?.[0]?.url ?? img?.url ?? null,
  };
}

/**
 * Search a destination.
 *
 * `count` is capped at 12 because everything past that is tokens the model
 * will never use — the house voice gives three options and an opinion, so
 * twelve is already four times the working set.
 *
 * Sorting defaults to TRAVELLER_RATING rather than price. A concierge that
 * leads with the cheapest thing is a comparison site; the whole promise here
 * is a pick with a reason behind it, and the reason is usually the rating.
 */
export async function search(env, { name, country = '', lat = null, lng = null, currency = 'USD', count = 12, tags = null }, fetchImpl = fetch) {
  if (!viatorReady(env)) return { ok: false, reason: 'not_connected' };

  const rows = await taxonomy(env, fetchImpl);
  const destination = resolve(rows, { name, country, lat, lng }, country);
  if (!destination) return { ok: false, reason: 'no_destination', name };

  const filtering = { destination: String(destination) };
  if (tags?.length) filtering.tags = tags;

  const res = await fetchImpl(`${BASE}/products/search`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({
      filtering,
      sorting: { sort: 'TRAVELLER_RATING', order: 'DESCENDING' },
      pagination: { start: 1, count: Math.min(Math.max(1, count), 12) },
      currency,
    }),
  });
  if (!res.ok) return { ok: false, reason: `http_${res.status}` };

  const body = await res.json();
  const products = (body?.products || []).map(shape).filter((p) => p.code && p.url);
  return { ok: true, destination, total: body?.totalCount ?? products.length, products };
}

/**
 * Is this turn about things to do?
 *
 * This gate exists for latency, not tidiness. A Viator search is two network
 * round trips on the path between a person pressing send and seeing a reply,
 * and most turns are not about activities at all — "book me a table", "what
 * time is my flight", "thanks". Firing it on every turn would tax the whole
 * conversation to serve a minority of it.
 *
 * Deliberately narrow. A false negative costs one good answer; a false
 * positive costs every user a slower app. So this matches the ways people
 * actually ask for something to DO, and stays out of the way otherwise.
 */
export const wantsActivities = (text) =>
  // Verb-shaped words take \w* rather than \b: British doubling ("snorkelling")
  // and plain gerunds ("kayaking", "sightseeing") are how people actually
  // write these, and \bsnorkel\b matches none of them.
  /\b(things? to do|what (?:is|are|s)? ?(?:there )?to do|what should we do|anything to do|activit(?:y|ies)|tours?|excursions?|day trips?|sightsee\w*|snorkel\w*|div(?:e|ing)|island[- ]hop\w*|boat trips?|kayak\w*|zip[- ]?lin\w*|cooking class\w*|elephants?|waterfalls?|temple tours?|attractions?|museums?|theme ?parks?|water ?parks?|for the kids|kids?.?friendly|family day|bored)\b/i
    .test(String(text ?? ''));

/**
 * The safe wrapper the request path calls.
 *
 * Returns a string, always. A dead Viator, a rate limit, an unresolvable
 * place, a malformed payload — every one of them ends as an empty block and
 * the concierge answers from what it already knows, which is a perfectly good
 * answer. Nothing here is allowed to turn a slow partner into a failed reply.
 */
export async function blockFor(env, place, text, fetchImpl = fetch) {
  if (!viatorReady(env) || !place?.name || !wantsActivities(text)) return '';
  try {
    const r = await search(env, {
      name: place.name,
      country: place.country_code || place.country || '',
      lat: Number(place.lat ?? place.latitude),
      lng: Number(place.lng ?? place.lon ?? place.longitude),
    }, fetchImpl);
    if (!r.ok) {
      console.log(`[viator] no block: ${r.reason}${r.name ? ` (${r.name})` : ''}`);
      return '';
    }
    return activitiesBlock(r);
  } catch (e) {
    console.log(`[viator] failed: ${e?.message || e}`);
    return '';
  }
}

/**
 * The prompt block.
 *
 * Written in the same register as airBlock() in services.mjs, and for the same
 * reason: the model needs to be told where the permission stops in the same
 * breath it is told what it can see, or it will book something.
 */
export function activitiesBlock(result) {
  if (!result?.ok || !result.products?.length) return '';
  const lines = result.products.map((p) => {
    const bits = [p.title];
    if (p.rating) bits.push(`${Number(p.rating).toFixed(1)}★${p.reviews ? ` from ${p.reviews}` : ''}`);
    if (p.from != null) bits.push(`from ${p.currency || ''}${p.from}`);
    if (p.duration) bits.push(String(p.duration));
    return `- ${bits.join(' · ')} — ${p.url}`;
  });
  return (
    '\n\nTHINGS TO DO HERE — REAL, FETCHED JUST NOW:\n' +
    lines.join('\n') +
    '\nThese are live listings with real ratings and real prices, so state them as fact — no hedging, no "around", ' +
    'no "I think". Give THREE with an opinion on which you would take and why, the way you would for a restaurant. ' +
    'You CANNOT book these: the traveller completes it on the linked page. Never say booked, held or reserved. ' +
    'Say what you have done — found it, priced it, checked the rating — and hand them the link. ' +
    'Do not invent an activity that is not in this list; if none of them fit what was asked, say so and fall back to ' +
    'what you know about the place rather than dressing a guess up as a listing.'
  );
}
