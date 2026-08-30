// Ticketmaster Discovery — "what's on tonight", answered with real listings.
//
// ── WHAT THIS IS ─────────────────────────────────────────────────────────
//
// Discovery is a READ api. It finds events, venues and attractions; it cannot
// sell a ticket. Ticketmaster's Partner API does checkout and their own docs
// say it plainly: "not an open API. It is restricted to companies with whom
// Ticketmaster has existing, official distribution relationships." We have no
// such relationship, so this rail searches and hands over. Same discipline as
// Sabre and Viator: state the real thing as fact, never say booked.
//
// ── THE COVERAGE TRAP, MEASURED RATHER THAN READ ─────────────────────────
//
// Their docs list Thailand in "Supported Country Codes", which reads like
// Thailand is covered. It is not. Queried 30 Aug 2026:
//
//     countryCode=TH                    →     0 events
//     countryCode=TH&city=Bangkok       →     0 events
//     countryCode=TH&city=Phuket        →     0 events
//     countryCode=GB&city=Edinburgh     →   327 events
//     countryCode=US&city=Los Angeles   → 1,693 events
//
// The supported-country list is where tickets COULD be sold, not where they
// are. So this rail is for Edinburgh and Los Angeles, and it must stay silent
// in Phuket and Bangkok rather than telling a traveller in Thailand that
// nothing is on tonight — which would be a lie about the city rather than an
// honest gap in our data. `search()` returns `{ok:false, reason:'no_coverage'}`
// for a country Ticketmaster does not actually carry.
//
// ── WHY GEOHASH AND NOT CITY ─────────────────────────────────────────────
//
// City-name matching has the same failure mode Viator had: "Kata" is not a
// city, and neither is half of what people type. Num holds coordinates.
// Discovery takes `geoPoint` as a geohash, so we encode the coordinate and
// search a radius around it — no name matching anywhere in the path.
// (`latlong` also exists and their docs mark it deprecated.)

const BASE = 'https://app.ticketmaster.com/discovery/v2';

/** Countries where Discovery actually returned events, verified by query. */
export const REAL_COVERAGE = Object.freeze([
  'US', 'CA', 'MX', 'GB', 'IE', 'AU', 'NZ', 'DE', 'NL', 'SE', 'ES', 'FR', 'IT',
  'BE', 'DK', 'FI', 'NO', 'PL', 'AT', 'CH', 'CZ', 'PT', 'TR', 'AE', 'ZA',
]);

export const eventsReady = (env) => !!env?.TICKETMASTER_API_KEY;

export const covers = (countryCode) => REAL_COVERAGE.includes(String(countryCode || '').toUpperCase());

const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/**
 * Geohash encode. Twelve lines of bit-twiddling that remove every place-name
 * ambiguity from this rail: a coordinate cannot be misspelled.
 */
export function geohash(lat, lng, precision = 7) {
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let hash = '', bits = 0, ch = 0, even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng > mid) { ch = (ch << 1) | 1; lngMin = mid; } else { ch <<= 1; lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat > mid) { ch = (ch << 1) | 1; latMin = mid; } else { ch <<= 1; latMax = mid; }
    }
    even = !even;
    if (++bits === 5) { hash += B32[ch]; bits = 0; ch = 0; }
  }
  return hash;
}

/** Discovery wants seconds precision and a Z, and rejects milliseconds. */
export const tmTime = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Is this turn about what is on?
 *
 * Narrower than it looks. "tonight" alone is far too broad — most of what
 * people ask about tonight is dinner — so it only counts alongside something
 * event-shaped. A false positive costs every user a network round trip.
 */
export const wantsEvents = (text) => {
  const s = String(text ?? '');
  return /\b(what'?s on|whats on|any events?|live music|gig|gigs|concerts?|festival|comedy (?:night|show|gig)|stand.?up|a show|the match|kick.?off|dj set|club night|theatre|theater|musical|opera|ballet)\b/i.test(s)
    || /\b(events?|shows?|tickets?)\b.{0,20}\b(tonight|tomorrow|this week|weekend)\b/i.test(s)
    || /\b(tonight|tomorrow|this week|weekend)\b.{0,20}\b(events?|shows?|gigs?|tickets?)\b/i.test(s);
};

/** Trimmed to what a concierge would actually say out loud. */
export function shape(e) {
  const start = e?.dates?.start ?? {};
  const venue = e?._embedded?.venues?.[0] ?? {};
  const cls = e?.classifications?.[0] ?? {};
  const named = (o) => (o?.name && o.name !== 'Undefined' ? o.name : null);
  const pr = Array.isArray(e?.priceRanges) ? e.priceRanges[0] : null;
  return {
    id: e?.id ?? null,
    name: e?.name ?? '',
    // dateTBD/TBA are real and common; a concierge must not print a fake time.
    date: start.dateTBA || start.dateTBD ? null : (start.localDate ?? null),
    time: start.timeTBA || start.noSpecificTime ? null : (start.localTime ?? null),
    venue: venue.name ?? null,
    genre: named(cls.genre) || named(cls.segment) || null,
    from: pr?.min ?? null,
    currency: pr?.currency ?? null,
    url: e?.url ?? null,
  };
}

/**
 * Search around a coordinate.
 *
 * @returns {{ok:true, events:object[], total:number} | {ok:false, reason:string}}
 */
export async function search(env, { lat, lng, country, days = 7, radiusMiles = 25, size = 10 }, fetchImpl = fetch) {
  if (!eventsReady(env)) return { ok: false, reason: 'not_connected' };
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, reason: 'no_coordinates' };
  // The measured check, not the documented one. See the coverage note above.
  if (country && !covers(country)) return { ok: false, reason: 'no_coverage', country };

  const now = new Date();
  const until = new Date(now.getTime() + days * 86400000);
  const qs = new URLSearchParams({
    apikey: env.TICKETMASTER_API_KEY,
    geoPoint: geohash(lat, lng),
    radius: String(radiusMiles),
    unit: 'miles',
    startDateTime: tmTime(now),
    endDateTime: tmTime(until),
    sort: 'date,asc',
    size: String(Math.min(Math.max(1, size), 20)),
  });

  let res;
  try {
    res = await fetchImpl(`${BASE}/events.json?${qs}`);
  } catch (e) {
    return { ok: false, reason: `network_${e?.message || 'error'}` };
  }
  if (!res.ok) return { ok: false, reason: `http_${res.status}` };

  const body = await res.json();
  const events = (body?._embedded?.events || []).map(shape).filter((x) => x.name && x.url);
  return { ok: true, events, total: body?.page?.totalElements ?? events.length };
}

/**
 * The prompt block.
 *
 * Note what it forbids beyond the usual: inventing a time. Discovery genuinely
 * returns events with the time unset (timeTBA, dateTBD), and a concierge who
 * fills that gap with a plausible 20:00 has invented the single fact the
 * traveller will plan their evening around.
 */
export function eventsBlock(result) {
  if (!result?.ok || !result.events?.length) return '';
  const lines = result.events.map((e) => {
    const bits = [e.name];
    if (e.venue) bits.push(e.venue);
    if (e.date) bits.push(e.time ? `${e.date} ${e.time.slice(0, 5)}` : `${e.date}, time TBC`);
    else bits.push('date TBC');
    if (e.genre) bits.push(e.genre);
    if (e.from != null) bits.push(`from ${e.currency || ''}${e.from}`);
    return `- ${bits.join(' · ')} — ${e.url}`;
  });
  return (
    "\n\nWHAT'S ON NEARBY — REAL LISTINGS, FETCHED JUST NOW:\n" +
    lines.join('\n') +
    '\nThese are live. State the name, venue, date and price exactly as written — no rounding, no hedging. ' +
    'Where a line says "time TBC" or "date TBC" that is genuinely unset: say so and never invent one, because ' +
    'the time is the fact they will build their evening around.\n' +
    'You CANNOT book or hold these — the traveller buys on the linked page. Never say booked, held or reserved. ' +
    'Pick THREE at most and say which you would take and why, the way you would for a restaurant. ' +
    'This list is not the whole city: it is ticketed events only, so bars, markets, free gigs and anything ' +
    'sold at the door are missing. If nothing here fits, say what you know about the area instead of ' +
    'implying the city is empty.'
  );
}

/**
 * The safe wrapper the request path calls. Always returns a string.
 *
 * Note the silence in an uncovered country. Telling somebody in Phuket that
 * nothing is on tonight would be a claim about Phuket, when it is only a fact
 * about Ticketmaster.
 */
export async function blockFor(env, place, text, fetchImpl = fetch) {
  if (!eventsReady(env) || !place || !wantsEvents(text)) return '';
  const lat = Number(place.lat ?? place.latitude);
  const lng = Number(place.lng ?? place.lon ?? place.longitude);
  try {
    const r = await search(env, { lat, lng, country: place.country_code }, fetchImpl);
    if (!r.ok) {
      console.log(`[ticketmaster] no block: ${r.reason}`);
      return '';
    }
    return eventsBlock(r);
  } catch (e) {
    console.log(`[ticketmaster] failed: ${e?.message || e}`);
    return '';
  }
}
