// Location grounding for /api/num — THE SAME BRAIN as the LINE texting
// concierge: identical D1 database (num-db) and identical retrieval code
// (../ai/places.js). The app worker binds the database read-only-in-spirit;
// all writes stay with the num-ai worker.
import { resolveLocation, nearbyPlaces, destinationGuide, detectCat } from '../ai/places.js';
import { showtimesFor } from './showtimes.mjs';
import { cityEventsFor, wantsEvents } from './cityevents.mjs';

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
export async function groundRequest(env, { userText, statedPlace, cf, fix = null, member = null }) {
  const none = { place: null, partners: [], disclosures: '', guide: null, buzz: [], events: [] };
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

    const [{ rows }, guide, buzz, showtimes, events] = await Promise.all([
      nearbyPlaces(env, loc, userText, 6).catch(() => ({ rows: [] })),
      destinationGuide(env, loc.dest.slug).catch(() => null),
      recentBuzz(env, loc.dest.slug).catch(() => []),
      // Only on a movie ask, and dark without a SERPAPI_KEY secret — the
      // model's honest "no live times" flow stays the fallback either way.
      detectCat(userText) === 'cinema'
        ? showtimesFor(env, loc.label || loc.dest.name).catch(() => null)
        : Promise.resolve(null),
      // Only on a "what's on" ask. Unconditional would put a festival list in
      // front of someone who asked for a taxi, and this block competes with
      // the partner block for the model's attention.
      wantsEvents(userText)
        ? cityEventsFor(env, loc.dest.slug).catch(() => [])
        : Promise.resolve([]),
    ]);

    // A venue can have published something about itself that a guest has to
    // know before they arrive rather than when they do — Arroyo del Sol is
    // clothing optional. This annotates the rows some ordinary piece of
    // ranking already chose; it never adds one, and it never removes one
    // except on a family ask, where naming it at all is the mistake.
    const { annotate, allowedFor, disclosureBlock } = await import('./venuedisclosure.mjs');
    const annotated = allowedFor(await annotate(env, rows ?? []), { member, userText });

    // OUR OWN LIST FIRST; A LIVE SEARCH ONLY WHEN IT IS EMPTY.
    //
    // num_city_events covers 25 of 77 live destinations, so a guest in the
    // other 52 asking what is on gets nothing — and a concierge that shrugs is
    // the one thing this product cannot be. events.tm.mjs has been a complete
    // Ticketmaster search this whole time with nothing calling it.
    //
    // Curated rows always win: they are verified, grounded against places we
    // hold, and safe to state outright. The search runs only when we have
    // none, is cached per destination, and arrives in its OWN block with its
    // own provenance — two levels of confidence must not share a heading.
    let searchedEvents = null;
    if (wantsEvents(userText) && !(events ?? []).length) {
      const { searchEvents } = await import('./eventsearch.mjs');
      searchedEvents = await searchEvents(env, {
        dest: loc.dest.slug,
        lat: loc.dest.lat, lng: loc.dest.lng,
        country: loc.dest.country,
      }).catch(() => null);
    }

    return {
      place: {
        name: loc.dest.name,
        slug: loc.dest.slug,
        country: loc.dest.country,
        // ── WHY BOTH country AND country_code ────────────────────────────
        //
        // `loc.dest.country` has always held an ISO-3166 alpha-2 code ('TH'),
        // despite the name. Every partner rail asks for `country_code`,
        // because that is what the field is. Publishing both keeps the older
        // readers working and stops the next integration from reading
        // `country`, getting 'TH', and assuming it is a country NAME.
        country_code: loc.dest.country,
        // ── AND WHY COORDINATES ──────────────────────────────────────────
        //
        // These were dropped here for a long time and it was invisible,
        // because nothing downstream wanted them. The moment rails did, three
        // of them failed silently and identically: Ticketmaster refused to
        // search without a coordinate, and Viator and Localrent quietly fell
        // back to matching place NAMES — the exact guesswork the coordinate
        // path exists to replace.
        //
        // `loc.lat` is where the traveller actually is (a GPS fix, or the IP
        // guess). `loc.dest.lat` is the city centre, which is the right
        // fallback rather than nothing: "what is on in Edinburgh" is a
        // perfectly good question to answer from the middle of Edinburgh.
        lat: loc.lat ?? loc.dest.lat ?? null,
        lng: loc.lng ?? loc.dest.lng ?? null,
        tz: loc.dest.tz,
        label: loc.label,
        precise: loc.precise,
        // IP geo is a guess (VPNs, roaming SIMs) — the model should confirm
        // it in passing rather than treat it as fact.
        inferred: loc.source === 'ip_location',
      },
      partners: annotated,
      // Facts these venues have published about themselves that a guest has to
      // hear BEFORE they picture the trip. Empty for almost every answer.
      disclosures: disclosureBlock(annotated),
      guide,
      buzz,
      showtimes,
      events,
      // Its own field, never merged into `events` — the two carry different
      // levels of confidence and the block that renders them says so.
      searchedEvents,
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
