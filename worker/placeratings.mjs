// Real ratings for the places NUM recommends.
//
// 17 Sep 2026: of 2,715,566 mapped places, 542 carried a rating. The ranking
// in ai/places.js therefore ordered restaurants by "has a phone" and "has a
// website" and distance — near-random among the plausible, and the SAME
// near-random list every time, which is what "the recommendations are not
// great" and "it keeps suggesting the same two" both meant.
//
// This module fills the gap where it matters: the first time a neighbourhood
// is asked about a kind of place, ONE Google Maps search — Places API, direct,
// no reseller — brings back the twenty best-known places there
// with their rating and review count. Each is matched to our own row by name
// and distance and the rating is written onto it. From then on the ranking
// has something real to rank by, for everyone, for as long as the row lives.
// One search per ~1 km cell per category per 30 days; a cell that was asked
// yesterday costs nothing today.
//
// Never creates places. A Google result with no row of ours is a gap in the
// map, logged, not a recommendation: NUM only recommends what it has mapped.
import { haversine } from '../ai/places.js';

const CELL_KM = 1;
const TTL_DAYS = 30;

/** Rough cell key — ~1 km at the equator, a little finer north. */
export const cellOf = (lat, lng) => `${Math.round(lat * 100)}_${Math.round(lng * 100)}`;

/** The search phrase Google understands for each of our categories. */
export const QUERY_FOR = Object.freeze({
  restaurant: 'restaurants', cafe: 'cafes', bar: 'bars', night_club: 'nightclubs', live_music: 'live music venues', seafood: 'seafood restaurants', breakfast: 'breakfast',
  dessert: 'dessert', spa: 'massage spa', hotel: 'hotels', attraction: 'attractions', market: 'markets',
  shopping: 'shopping', gym: 'gym', golf: 'golf', pharmacy: 'pharmacy', cinema: 'cinema', tailor: 'tailor',
  rental: 'scooter rental', diving: 'diving', boat: 'boat tours', tour: 'tours', watersports: 'water sports', beach: 'beach',
});

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and')
  .replace(/\b(the|restaurant|cafe|bar|bangkok|phuket|london|co|ltd)\b/g, '').replace(/[^a-z0-9฀-๿぀-ヿ一-鿿]+/g, ' ').trim();

/** Same place? Same-ish name within 250 m, or a name contained in the other within 120 m. */
export function sameVenue(a, b) {
  const na = norm(a.name), nb = norm(b.name);
  if (!na || !nb) return false;
  const km = haversine(a.lat, a.lng, b.lat, b.lng);
  if (na === nb) return km <= 0.4;
  if (km <= 0.12 && (na.includes(nb) || nb.includes(na))) return true;
  const ta = new Set(na.split(' ').filter((w) => w.length > 2)), tb = new Set(nb.split(' ').filter((w) => w.length > 2));
  const shared = [...ta].filter((w) => tb.has(w)).length;
  return km <= 0.25 && shared >= 2 && shared >= Math.min(ta.size, tb.size) - 1;
}

async function ensure(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS num_rating_runs (
    cell TEXT NOT NULL, cat TEXT NOT NULL, ts INTEGER NOT NULL, found INTEGER, matched INTEGER, PRIMARY KEY (cell, cat))`).run();
}

/** Has this cell been rated for this category within the TTL? */
export async function isFresh(env, cell, cat) {
  const row = await env.DB.prepare('SELECT ts FROM num_rating_runs WHERE cell = ?1 AND cat = ?2').bind(cell, cat).first();
  return !!row && Date.now() - Number(row.ts) < TTL_DAYS * 86400000;
}

/** Google's own Places endpoint. No reseller in the middle. */
const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

/**
 * One Google Maps search around the point — against Google directly.
 *
 * ── WHY THIS MOVED OFF SERPAPI (21 Sep 2026, Dre's call) ─────────────────
 *
 * "We aren't using SerpAPI right now, use Google Maps."
 *
 * SerpAPI was a scraper in front of Google Maps, and by the time this changed
 * it had refused **440 searches since 18 September** — every one a 429, plan
 * spent. Three days with no rating written anywhere, while the ranking in
 * ai/places.js quietly fell back to distance and whether a row has a phone.
 *
 * `scripts/enrich_ratings.mjs` has talked to Google directly since 11 August
 * on `GOOGLE_PLACES_API_KEY`. Two paths to the same data, one of them dead,
 * two different keys. Now there is one key and one road.
 *
 * ── THE FIELD MASK IS THE BILL ───────────────────────────────────────────
 *
 * Places API charges by the fields asked for. These four are the Essentials
 * + Pro tier and nothing more — `priceLevel` and `primaryType` came back from
 * SerpAPI for free, were assigned to a variable here, and were never read by
 * anything. Asking Google for them would move every call to a dearer SKU to
 * populate two fields we then throw away, so they are gone.
 */
export async function searchMaps(env, { lat, lng, q, fetchImpl = fetch }) {
  if (!env.GOOGLE_PLACES_API_KEY) return [];
  const res = await fetchImpl(PLACES_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY,
      'X-Goog-FieldMask': 'places.displayName,places.rating,places.userRatingCount,places.location',
    },
    body: JSON.stringify({
      textQuery: q,
      maxResultCount: 20,
      // A ~1.5 km circle, which is the same ground the match below covers.
      // `locationBias` rather than `locationRestriction`: a well-known place
      // just outside the circle is still the place somebody means.
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 1500 } },
    }),
    signal: AbortSignal.timeout(8000),
  });
  // The status is kept in the message because the ledger below reads it:
  // 429 is a spent quota and 401/403 a bad key, and those are the two that
  // need a human. Everything else is weather.
  if (!res.ok) throw new Error(`google places ${res.status}`);
  const body = await res.json();
  return (body?.places ?? []).map((r) => ({
    name: r.displayName?.text ?? '',
    rating: Number(r.rating) || null,
    reviews: Number(r.userRatingCount) || 0,
    lat: Number(r.location?.latitude),
    lng: Number(r.location?.longitude),
  })).filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lng) && r.rating);
}

/**
 * Rate the places around a point for one category. Returns what it did.
 * Safe to call on every ask: it returns at once when the cell is fresh, and
 * the caller should run it under waitUntil or a short timeout.
 */
export async function enrichCell(env, { lat, lng, cat, fetchImpl = fetch }) {
  if (!env?.DB || !env?.GOOGLE_PLACES_API_KEY || !Number.isFinite(lat) || !Number.isFinite(lng)) return { skipped: 'no-key' };
  const q = QUERY_FOR[cat ?? 'restaurant'] ?? 'restaurants';
  const cell = cellOf(lat, lng);
  await ensure(env);
  if (await isFresh(env, cell, cat ?? 'restaurant')) return { skipped: 'fresh' };
  // Claim the cell first so two concurrent asks do not both pay.
  await env.DB.prepare('INSERT OR REPLACE INTO num_rating_runs (cell, cat, ts, found, matched) VALUES (?1, ?2, ?3, NULL, NULL)').bind(cell, cat ?? 'restaurant', Date.now()).run();

  let found;
  try { found = await searchMaps(env, { lat, lng, q, fetchImpl }); } catch (err) {
    const msg = String(err?.message ?? err);
    console.warn('[ratings] search failed', msg);
    await env.DB.prepare('DELETE FROM num_rating_runs WHERE cell = ?1 AND cat = ?2').bind(cell, cat ?? 'restaurant').run();

    // ── A REFUSAL IS NOT A HICCUP, AND SOMEBODY HAS TO BE TOLD ────────────
    //
    // 17 Sep 2026 22:33 was the last rating this product recorded. Every
    // search since has come back 429, and the only trace was this
    // console.warn — which nobody reads, because reading it means already
    // suspecting the thing it would tell you. Meanwhile /api/features
    // reported `ratings: on`, because the key was set, and the registry
    // exists precisely so an operator does not have to guess.
    //
    // 429 and 401/403 are the two that mean a human must act: the plan is
    // spent, or the key is wrong. Everything else — a timeout, a 5xx, a
    // dropped connection — is weather, and recording weather is how a ledger
    // becomes noise.
    //
    // LOW severity, deliberately. `summary()` counts anything above low as
    // `actionable`, and an untold actionable failure makes /api/health say
    // DOWN. Ranking that has quietly got duller is a chore with a known
    // remedy, not an outage — and the night of 17 Sep was spent teaching this
    // ledger not to cry wolf. It lands in `chores`, in the digest, and in the
    // admin failures list, where the remedy is written out in full.
    if (/\b(429|401|403)\b/.test(msg)) {
      try {
        const { record } = await import('./failures.mjs');
        await record(env, {
          kind: 'ratings_refused',
          subject: msg.slice(0, 80),
          detail: 'Google Maps ratings are not being fetched, so places rank on weaker signals and '
            + 'the "Real ratings" feature is on in name only. 429 = the Google Places quota or '
            + 'billing is spent; 401/403 = GOOGLE_PLACES_API_KEY is wrong, revoked, or restricted '
            + 'to the wrong API. Fix it in the Google Cloud console, then confirm with: '
            + 'SELECT cell, cat, found, matched FROM num_rating_runs ORDER BY ts DESC LIMIT 5 — '
            + 'a row newer than the incident means it is fixed. Nothing else breaks meanwhile.',
          severity: 'low',
        });
      } catch { /* the ledger must never be the reason an ask fails */ }
    }
    return { error: msg };
  }

  /* ── A SEARCH THAT WORKED CLOSES THE ROW THAT SAID THEY DON'T ─────────
   *
   * The refusal row is keyed on the message, so moving provider on 21 Sep
   * would have left `f_ratings_refused|serpapi 429` open for ever — a ledger
   * entry about a system that no longer exists, sitting in the chores count
   * and the morning digest, outliving the thing it described.
   *
   * That is the same shape as the alert row that held /api/health at DOWN
   * for thirty hours the night before: a record of a past failure with no
   * way to end. A search coming back is the proof, so it is what closes it —
   * every open ratings_refused row, whatever provider raised it. */
  try {
    const { open: openFailures, resolve: resolveFailure } = await import('./failures.mjs');
    for (const r of await openFailures(env, { limit: 50 })) {
      if (r.kind === 'ratings_refused') await resolveFailure(env, r.kind, r.subject);
    }
  } catch { /* the ledger must never be the reason an ask fails */ }

  // Our rows within ~1.5 km of the point.
  const dLat = 1.5 / 111, dLng = 1.5 / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  const { results: ours } = await env.DB.prepare(
    `SELECT id, name, lat, lng, rating, reviews FROM places
      WHERE cell_lat BETWEEN ?1 AND ?2 AND cell_lng BETWEEN ?3 AND ?4 AND (alive IS NULL OR alive = 1)`,
  ).bind(Math.floor((lat - dLat) * 10), Math.floor((lat + dLat) * 10), Math.floor((lng - dLng) * 10), Math.floor((lng + dLng) * 10)).all();

  let matched = 0;
  const now = Date.now();
  for (const g of found) {
    const hit = (ours ?? []).find((o) => sameVenue(o, g));
    if (!hit) continue;
    try {
      await env.DB.prepare('UPDATE places SET rating = ?1, reviews = ?2, rating_source = ?3, rated_at = ?4 WHERE id = ?5')
        .bind(g.rating, g.reviews, 'google_maps', now, hit.id).run();
      matched++;
    } catch (err) {
      // Older schema without the two columns: keep the rating, drop the provenance.
      if (/no such column/i.test(String(err?.message))) {
        await env.DB.prepare('UPDATE places SET rating = ?1, reviews = ?2 WHERE id = ?3').bind(g.rating, g.reviews, hit.id).run();
        matched++;
      } else throw err;
    }
  }
  await env.DB.prepare('UPDATE num_rating_runs SET found = ?3, matched = ?4 WHERE cell = ?1 AND cat = ?2').bind(cell, cat ?? 'restaurant', found.length, matched).run();
  console.log(`[ratings] ${cell} ${cat ?? 'restaurant'}: ${found.length} found, ${matched} matched`);
  return { found: found.length, matched };
}
