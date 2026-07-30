// Location grounding for /api/num — THE SAME BRAIN as the LINE texting
// concierge: identical D1 database (num-db) and identical retrieval code
// (../ai/places.js). The app worker binds the database read-only-in-spirit;
// all writes stay with the num-ai worker.
import { resolveLocation, nearbyPlaces, destinationGuide } from '../ai/places.js';

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
export async function groundRequest(env, { userText, statedPlace, cf }) {
  const none = { place: null, partners: [], guide: null, buzz: [] };
  if (!env?.DB) return none; // local dev without the binding — Claude flies on general knowledge

  try {
    // The user's stated location (from onboarding) is prepended so the shared
    // named-destination detector sees it even when the new message doesn't
    // repeat the city.
    const text = statedPlace ? `${statedPlace}. ${userText}` : userText;
    const loc = await resolveLocation(env, { text, guest: null, cf });

    // Only trust a resolution that traces back to something REAL: a place the
    // user named, live coordinates, or a previous session. The resolver's
    // Phuket fallback surfaces as source 'default' — or 'city_centre' after
    // it backfills coordinates — and must never reach the app's brain.
    const TRUSTED = new Set(['named', 'named_area', 'shared_location', 'ip_location', 'last_seen']);
    if (!loc?.dest || !TRUSTED.has(loc.source)) return none;

    const [{ rows }, guide, buzz] = await Promise.all([
      nearbyPlaces(env, loc, userText, 6).catch(() => ({ rows: [] })),
      destinationGuide(env, loc.dest.slug).catch(() => null),
      recentBuzz(env, loc.dest.slug).catch(() => []),
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
