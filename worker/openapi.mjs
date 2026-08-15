/**
 * The open-business and bookings API.
 *
 * Dre, 11 Aug 2026: "yes open business and bookings api for as many places as
 * we can set up."
 *
 * Two questions, answered over HTTP for anyone we let in:
 *
 *   GET /api/open        which businesses are open, right now, near here
 *   POST /api/book/link  give me a booking page for this one, prefilled
 *
 * ── WHY THIS IS READ-ONLY AND LINK-ONLY ──────────────────────────────────
 *
 * There is no POST that takes a reservation, and that is not an omission.
 * Num does not hold a table at Bestia; it hands a guest a Resy page with the
 * party size and time already in it. An API that returned `{"booked": true}`
 * would be a lie told to another company's product, which then tells it to a
 * traveller standing outside a restaurant. When a real write API lands with a
 * platform, `mode` flips from "deeplink" to "api" for that platform and every
 * caller can see it change. Until then the field says deeplink, out loud,
 * on every response.
 *
 * No money moves through here and no personal data goes in — a booking link
 * needs a party size and a time, not a name, and the endpoint refuses to
 * carry more than that. Nothing here can be turned into a payment surface by
 * a caller who guesses at parameters.
 *
 * ── "OPEN" HAS THREE VALUES ──────────────────────────────────────────────
 *
 * open_now is true, false, or null, and null is the common case: 86,465 of
 * Los Angeles's 90,263 places have no verified hours yet. Callers get the
 * three states explicitly, and `?open=now` filters to true only — never to
 * "true or unknown", which would quietly promise something we have not
 * checked.
 */
import { openNow, hoursLeft } from './hours.mjs';
import { bookingLink, PLATFORMS } from './booking.mjs';
import { tag } from './affiliate.mjs';
import { ATTRIBUTION, partnerFrom } from './partnermcp.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Partner-Key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

const COLS = `id, name, name_local, category, area, dest, lat, lng, phone, website, address,
              hours, hours_mask, rating, reviews, alive, booking_platform, booking_ref`;

/** Destination timezone — needed before "open now" means anything. */
async function tzFor(env, dest) {
  const r = await env.DB.prepare('SELECT tz FROM destinations WHERE slug = ?1').bind(dest).first();
  return r?.tz ?? null;
}

function shape(r, tz) {
  const open = openNow(r.hours_mask, tz);
  const link = bookingLink(r);
  return {
    place_id: String(r.id),
    name: r.name,
    name_local: r.name_local || undefined,
    category: r.category || undefined,
    area: r.area || undefined,
    address: r.address || undefined,
    phone: r.phone || undefined,
    website: r.website || undefined,
    rating: r.rating ?? undefined,
    reviews: r.reviews ?? undefined,
    hours: r.hours || undefined,
    // true / false / null — null means "we have not verified this venue's
    // hours", NOT "closed". Callers that collapse it to false will hide most
    // of a city; callers that collapse it to true will send people to locked
    // doors. It is documented here because both mistakes are easy.
    open_now: open,
    closes_in_hours: open ? hoursLeft(r.hours_mask, tz) : undefined,
    // Positive evidence from the venue's own website: 1 trading, 0 gone,
    // null never checked.
    trading: r.alive === 1 ? true : r.alive === 0 ? false : null,
    booking: link
      ? { platform: r.booking_platform, label: link.label, kind: link.kind, mode: link.mode }
      : null,
  };
}

/**
 * GET /api/open
 *   dest      required — destination slug
 *   category  optional — exact category
 *   near      optional — area/neighbourhood substring
 *   q         optional — free text over name and cuisine
 *   open      optional — "now" to return only verified-open venues
 *   bookable  optional — "1" to return only venues with a booking platform
 *   limit     optional — 1..50, default 20
 */
export async function handleOpen(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (!env.DB) return json({ error: 'Directory unavailable.' }, 503);
  const url = new URL(request.url);
  const dest = String(url.searchParams.get('dest') || '').trim().toLowerCase();
  if (!dest) return json({ error: 'dest is required. GET /api/open?dest=los-angeles' }, 400);

  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50);
  // A business whose own website is a dead domain or a 404 is excluded here,
  // not ranked down. Unknown (never checked) stays in — most of the directory
  // has never been crawled and hiding it would return an empty city.
  const where = ['dest = ?1', '(alive IS NULL OR alive = 1)'];
  const bind = [dest];
  const add = (clause, ...v) => { where.push(clause.replace(/\?n/g, `?${bind.length + 1}`)); bind.push(...v); };
  if (url.searchParams.get('category')) add('category = ?n COLLATE NOCASE', url.searchParams.get('category'));
  if (url.searchParams.get('near')) add('area LIKE ?n COLLATE NOCASE', `%${url.searchParams.get('near')}%`);
  if (url.searchParams.get('q')) add('(name LIKE ?n COLLATE NOCASE OR cuisine LIKE ?n COLLATE NOCASE)', `%${url.searchParams.get('q')}%`);
  if (url.searchParams.get('bookable') === '1') where.push("booking_platform IS NOT NULL AND booking_ref IS NOT NULL");
  const wantOpen = url.searchParams.get('open') === 'now';
  if (wantOpen) where.push('hours_mask IS NOT NULL');

  const tz = await tzFor(env, dest);
  if (wantOpen && !tz) {
    // Without a timezone "open now" is unanswerable, and answering anyway
    // would mean applying UTC to Los Angeles.
    return json({ error: `No timezone on record for "${dest}", so open-now cannot be computed.` }, 422);
  }

  // Over-fetch, because the open-now filter runs in JS: SQLite has no IANA
  // timezone database, so the local hour cannot be computed in SQL.
  const rows = await env.DB.prepare(
    `SELECT ${COLS} FROM places WHERE ${where.join(' AND ')}
      ORDER BY (COALESCE(rating,0) * 2)
             + (CASE WHEN booking_ref IS NOT NULL THEN 1.5 ELSE 0 END)
             + (CASE WHEN hours_mask IS NOT NULL THEN 1 ELSE 0 END)
             + (CASE WHEN website IS NOT NULL AND website <> '' THEN 0.5 ELSE 0 END)
             + (CASE WHEN phone IS NOT NULL AND phone <> '' THEN 0.5 ELSE 0 END) DESC
      LIMIT ${wantOpen ? limit * 8 : limit}`,
  ).bind(...bind).all();

  let places = (rows.results ?? []).map((r) => shape(r, tz));
  if (wantOpen) places = places.filter((p) => p.open_now === true);
  places = places.slice(0, limit);

  return json({
    destination: dest,
    timezone: tz ?? null,
    count: places.length,
    // Said plainly so nobody reads a short list as "the city is empty".
    coverage_note: wantOpen
      ? 'Only venues whose opening hours Num has verified can appear here. Many real businesses are missing because their hours are unknown, not because they are shut.'
      : 'open_now is true, false, or null. null means Num has not verified this venue\'s hours — it is not a claim that they are closed.',
    places,
    attribution: ATTRIBUTION,
  });
}

/**
 * POST /api/book/link — a booking page, prefilled.
 * Body: { place_id, party?, date? "YYYY-MM-DD", time? "HH:MM" }
 *
 * Returns a URL. It does NOT reserve anything, and says so in the response so
 * a calling product cannot honestly render "Booked".
 */
export async function handleBookLink(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'POST a JSON body.' }, 405);
  if (!env.DB) return json({ error: 'Directory unavailable.' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); }
  const id = String(body?.place_id ?? '').slice(0, 120);
  if (!id) return json({ error: 'place_id is required.' }, 400);

  const r = await env.DB.prepare(`SELECT ${COLS} FROM places WHERE id = ?1`).bind(id).first();
  if (!r) return json({ error: 'No such place.' }, 404);

  const link = bookingLink(r, { party: body?.party, date: body?.date, time: body?.time });
  // Tagged LAST, on a URL already chosen on merit. See affiliate.mjs — there
  // is no path by which a referral rate can reach the ranking, and there must
  // never be one.
  if (link) link.url = tag(link.url, env, { extra: r.dest });
  if (!link) {
    // An honest refusal beats a dead button. The phone number is the real
    // fallback and most venues in the directory have one.
    return json({
      place_id: id,
      name: r.name,
      bookable: false,
      reason: 'Num holds no booking platform for this venue.',
      phone: r.phone || undefined,
      website: r.website || undefined,
      attribution: ATTRIBUTION,
    }, 200);
  }

  const tz = await tzFor(env, r.dest);
  return json({
    place_id: id,
    name: r.name,
    bookable: true,
    platform: r.booking_platform,
    label: link.label,
    // "deeplink" is load-bearing: it is the difference between handing over a
    // filled-in form and holding a table. Anything rendering this response as
    // a confirmation is misreading it.
    mode: link.mode,
    booked: false,
    disclosure: 'This is a prefilled booking page, not a reservation. The guest completes it on ' +
      `${link.label}. Num has not held a table.`,
    url: link.url,
    open_now: openNow(r.hours_mask, tz),
    attribution: ATTRIBUTION,
  });
}

/** GET /api/book/platforms — what Num can hand off to, and how. */
export function handlePlatforms() {
  return json({
    platforms: Object.entries(PLATFORMS).map(([id, p]) => ({ id, label: p.label, kind: p.kind, mode: p.mode })),
    note: 'mode "deeplink" means Num prefills the venue\'s own booking page and the guest completes it. ' +
      'No platform is "api" yet — when one is, this list changes and so does the behaviour.',
    attribution: ATTRIBUTION,
  });
}

/** Attribution for the caller, so partner usage stays auditable. */
export const callerOf = partnerFrom;
