// Location grounding for /api/num — THE SAME BRAIN as the LINE texting
// concierge: identical D1 database (num-db) and identical retrieval code
// (../ai/places.js). The app worker binds the database read-only-in-spirit;
// all writes stay with the num-ai worker.
import { resolveLocation, nearbyPlaces, destinationGuide, detectCat } from '../ai/places.js';
import { showtimesFor } from './showtimes.mjs';

/**
 * Resolve where the user is and pull verified partners for their ask.
 *
 * Resolution order (inside resolveLocation, shared with the texts):
 *   destination named in the text → live coords (Cloudflare IP geo) →
 *   last-seen → Phuket default. That default exists for the LINE flow;
 *   the app must NEVER assume it — so a 'default' resolution is treated
 *   as "location unknown" and returns no place at all.
 *
 * @returns {Promise<{place: object|null, partners: array, guide: string|null}>}
 */
export async function groundRequest(env, { userText, statedPlace, cf, fix = null }) {
  const none = { place: null, partners: [], guide: null, buzz: [] };
  if (!env?.DB) return none; // local dev without the binding — Claude flies on general knowledge

  try {
    // The user's stated location (from onboarding) is prepended so the shared
    // named-destination detector sees it even when the new message doesn't
    // repeat the city.
    const text = statedPlace ? `${statedPlace}. ${userText}` : userText;
    // A GPS fix from the device is the strongest signal there is — it beats
    // both the IP guess and a stale "last seen". Passed as a guest with live
    // coordinates, which the resolver already treats as shared_location.
    // last_loc_at must be set or the resolver's 24h freshness check drops it —
    // this fix was taken seconds ago, so "now" is the honest timestamp.
    const guest = fix
      ? { last_lat: fix.lat, last_lng: fix.lng, last_loc_at: new Date().toISOString().slice(0, 19).replace('T', ' ') }
      : null;
    const loc = await resolveLocation(env, { text, guest, cf });

    // Only trust a resolution that traces back to something REAL: a place the
    // user named, live coordinates, or a previous session. The resolver's
    // Phuket fallback surfaces as source 'default' — or 'city_centre' after
    // it backfills coordinates — and must never reach the app's brain.
    const TRUSTED = new Set(['named', 'named_area', 'shared_location', 'ip_location', 'last_seen']);

    // The guest named a place we don't cover ("horse races in Delmar").
    // Returning `none` here would be almost right — the model would answer
    // from general knowledge — but it also hides WHY there are no partners,
    // and the prompt would happily fall back to asserting the IP city. Pass
    // the place through, flagged, with no partners: the model answers about
    // the place the guest actually asked about, honestly, with nothing local
    // attached. Never substitute where they are for where they asked.
    if (loc?.source === 'unsupported' && loc.unsupported) {
      return { ...none, place: { name: loc.unsupported, unsupported: true } };
    }

    if (!loc?.dest || !TRUSTED.has(loc.source)) return none;

    const [{ rows }, guide, buzz, showtimes] = await Promise.all([
      nearbyPlaces(env, loc, userText, 6).catch(() => ({ rows: [] })),
      destinationGuide(env, loc.dest.slug).catch(() => null),
      recentBuzz(env, loc.dest.slug).catch(() => []),
      // Only on a movie ask, and dark without a SERPAPI_KEY secret — the
      // model's honest "no live times" flow stays the fallback either way.
      detectCat(userText) === 'cinema'
        ? showtimesFor(env, loc.label || loc.dest.name).catch(() => null)
        : Promise.resolve(null),
    ]);

    return {
      place: {
        name: loc.dest.name,
        slug: loc.dest.slug,
        country: loc.dest.country,
        tz: loc.dest.tz,
        label: loc.label,
        precise: loc.precise,
        // IP geo is a guess (VPNs, roaming SIMs) — the model should confirm
        // it in passing rather than treat it as fact.
        inferred: loc.source === 'ip_location',
      },
      partners: rows ?? [],
      guide,
      buzz,
      showtimes,
    };
  } catch (err) {
    // Grounding is an enhancement, never a dependency — a D1 hiccup must not
    // take the concierge down.
    console.warn('[grounding]', err?.message ?? err);
    return none;
  }
}

/**
 * What num-scout found lately for this destination: openings, launches and
 * "best of" lists from the city food press. Same table every channel reads.
 */
async function recentBuzz(env, slug, limit = 6) {
  const { results } = await env.DB.prepare(
    `SELECT title, url, publisher, kind, COALESCE(published_at, seen_at) AS at
       FROM buzz WHERE dest = ?1
       ORDER BY at DESC LIMIT ?2`,
  )
    .bind(slug, limit)
    .all();
  return results ?? [];
}
