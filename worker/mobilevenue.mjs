/**
 * A VENUE THAT MOVES.
 *
 * ── WHY THE DIRECTORY CANNOT ALREADY DO THIS ─────────────────────────────
 *
 * Every place in NUM is a fixed point: `places.lat/lng` are NOT NULL, the
 * concierge finds things with a grid-cell prefilter and a haversine, and both
 * assume the answer is still true tomorrow. That assumption holds for a
 * restaurant and is false for a taco truck, a market stall, a beach vendor, or
 * a boat that changes mooring.
 *
 * Hugo's Tacos is the first one: two Hugo's Restaurant sites run on Resy, and
 * the tacos side has no booking system at all because there is nothing to
 * book — there is a truck, and the only question a guest has is where it is
 * standing right now.
 *
 * That question is one Google Maps genuinely cannot answer, which is the
 * interesting part. A pin on a map is a claim about a permanent thing. Nobody
 * is going to update a Google listing at 11am because they parked on Abbot
 * Kinney, and if they did, nobody would remove it at 3pm when they left.
 *
 * ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ─────────────────────────────
 *
 * A STALE PIN IS A LIE, AND A LIE ABOUT A LOCATION COSTS SOMEBODY A JOURNEY.
 *
 * Sending a guest to an empty kerb is worse than never listing the truck. They
 * do not conclude "the truck moved"; they conclude NUM is wrong about things,
 * and they are right.
 *
 * So a position is not a coordinate. It is a coordinate WITH AN EXPIRY that
 * the operator set themselves — "parked here till 3" — and the moment that
 * passes, `positionOf` stops returning coordinates at all. Not stale ones
 * flagged as stale. None. The fields are absent, so no caller can pass them to
 * a map by accident, and no prompt can read them back to a guest.
 *
 * What survives expiry is the HISTORY, which is honest and useful: "not parked
 * anywhere right now — yesterday it was in Venice until 3". That keeps the
 * business discoverable and tells the guest exactly what we do and do not
 * know.
 *
 * ── AND WHY THE OPERATOR SETS THE EXPIRY, NOT US ─────────────────────────
 *
 * A fixed timeout would be a guess about somebody else's day. A lunch pitch is
 * two hours, a festival is ten, a night market is five. The driver knows and we
 * do not, so they say, and the number they give is the number we honour. The
 * only opinion this file has is a ceiling (MAX_DWELL_MIN), because "parked here
 * till next Tuesday" is a typo rather than a plan.
 */

export const MIN_DWELL_MIN = 15;
/**
 * Twelve hours. Longer than any real pitch and short enough that a mistyped
 * expiry cannot outlive the day it was made in. A vendor who genuinely stands
 * somewhere for a week is not mobile, and should be listed as a fixed place.
 */
export const MAX_DWELL_MIN = 720;
export const DEFAULT_DWELL_MIN = 180;

export const VIA = Object.freeze(['link', 'sms', 'console', 'admin']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_mobile_venues (
  place_id     TEXT PRIMARY KEY,
  business_id  TEXT,
  name         TEXT,
  kind         TEXT NOT NULL DEFAULT 'truck',
  home_dest    TEXT,
  social_url   TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS num_venue_positions (
  place_id    TEXT PRIMARY KEY,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  accuracy_m  REAL,
  label       TEXT,
  valid_until TEXT NOT NULL,
  set_by      TEXT,
  set_via     TEXT NOT NULL DEFAULT 'link',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only. This is what answers "where were they yesterday" once the
-- current position has expired, and it is the operator's own record of where
-- they have stood — which is worth more to them than it is to us.
CREATE TABLE IF NOT EXISTS num_venue_position_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id    TEXT NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  label       TEXT,
  valid_until TEXT NOT NULL,
  set_by      TEXT,
  set_via     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vposlog_place ON num_venue_position_log(place_id, created_at DESC);
`;

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}
export function __resetReady() { ready = false; }

const clip = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/** A coordinate we are willing to put in front of a guest, or null. */
export function coord(lat, lng) {
  const a = Number(lat); const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < -90 || a > 90 || b < -180 || b > 180) return null;
  // Null Island. A device that has failed to get a fix reports 0,0 far more
  // often than anybody is genuinely in the Gulf of Guinea, and a pin there is
  // the most obviously wrong answer this system could give.
  if (Math.abs(a) < 0.0001 && Math.abs(b) < 0.0001) return null;
  return { lat: a, lng: b };
}

export async function registerMobile(env, placeId, { businessId = null, name = null, kind = 'truck', homeDest = null, socialUrl = null } = {}) {
  if (!env?.DB || !placeId) return { ok: false, error: 'no_place' };
  await ensure(env);
  await env.DB.prepare(
    `INSERT INTO num_mobile_venues (place_id, business_id, name, kind, home_dest, social_url)
     VALUES (?1,?2,?3,?4,?5,?6)
     ON CONFLICT(place_id) DO UPDATE SET
       business_id = COALESCE(excluded.business_id, num_mobile_venues.business_id),
       name        = COALESCE(excluded.name, num_mobile_venues.name),
       kind        = excluded.kind,
       home_dest   = COALESCE(excluded.home_dest, num_mobile_venues.home_dest),
       social_url  = COALESCE(excluded.social_url, num_mobile_venues.social_url),
       active      = 1,
       updated_at  = datetime('now')`,
  ).bind(String(placeId), clip(businessId, 64), clip(name, 160), clip(kind, 24), clip(homeDest, 40), clip(socialUrl, 300)).run();
  return { ok: true };
}

/**
 * Record where they are, and until when.
 *
 * Refuses rather than rounds. A bad coordinate, a dwell outside the bounds, an
 * unknown channel — each comes back as a named error, because every one of
 * them ends with a guest standing somewhere the truck is not.
 */
export async function setPosition(env, placeId, {
  lat, lng, accuracy = null, label = null, minutes = DEFAULT_DWELL_MIN, by = null, via = 'link',
} = {}) {
  if (!env?.DB || !placeId) return { ok: false, error: 'no_place' };
  const c = coord(lat, lng);
  if (!c) return { ok: false, error: 'bad_coordinates' };
  if (!VIA.includes(via)) return { ok: false, error: 'bad_channel' };

  const mins = Math.round(Number(minutes));
  if (!Number.isFinite(mins) || mins < MIN_DWELL_MIN || mins > MAX_DWELL_MIN) {
    return { ok: false, error: 'bad_dwell', allowed: [MIN_DWELL_MIN, MAX_DWELL_MIN] };
  }

  // A phone that reports a 5km accuracy radius has not found itself; it has
  // guessed from a cell tower. Telling a guest the truck is within 5km of a
  // point is not an answer, so it is refused and the driver is asked again.
  const acc = accuracy == null ? null : Number(accuracy);
  if (acc != null && Number.isFinite(acc) && acc > 2000) {
    return { ok: false, error: 'position_too_vague', accuracy_m: Math.round(acc) };
  }

  await ensure(env);
  const until = new Date(Date.now() + mins * 60000).toISOString().slice(0, 19).replace('T', ' ');

  await env.DB.prepare(
    `INSERT INTO num_venue_positions (place_id, lat, lng, accuracy_m, label, valid_until, set_by, set_via)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
     ON CONFLICT(place_id) DO UPDATE SET
       lat=excluded.lat, lng=excluded.lng, accuracy_m=excluded.accuracy_m,
       label=excluded.label, valid_until=excluded.valid_until,
       set_by=excluded.set_by, set_via=excluded.set_via, created_at=datetime('now')`,
  ).bind(String(placeId), c.lat, c.lng, acc, clip(label, 120), until, clip(by, 80), via).run();

  await env.DB.prepare(
    `INSERT INTO num_venue_position_log (place_id, lat, lng, label, valid_until, set_by, set_via)
     VALUES (?1,?2,?3,?4,?5,?6,?7)`,
  ).bind(String(placeId), c.lat, c.lng, clip(label, 120), until, clip(by, 80), via).run().catch(() => {});

  /* ── AND THE DIRECTORY ROW MOVES WITH IT ───────────────────────────
   *
   * This is what makes a moving venue findable without touching the search at
   * all. ai/places.js finds things with a bounding box over `places.lat/lng`
   * and a haversine; point those columns at the pitch and the truck turns up
   * in "what's near me" exactly like everything else, with no second code
   * path to keep in step — and a second proximity search is a second set of
   * rules about what "near" means.
   *
   * The dangerous half is the other direction: once these columns move, the
   * directory says the truck is on Abbot Kinney until somebody changes them
   * back, which nobody will. That is the stale pin this whole file exists to
   * prevent, and it is why `hideExpired` is not optional — the expiry lives
   * in num_venue_positions, and any list of places has to be run through it
   * before a guest sees it.
   *
   * Best-effort on purpose: a directory that would not take the update must
   * not stop the driver from being recorded as parked. The position table is
   * the source of truth about where they are; `places` is an index.
   */
  await env.DB.prepare(
    'UPDATE places SET lat = ?2, lng = ?3, area = COALESCE(?4, area) WHERE id = ?1',
  ).bind(String(placeId), c.lat, c.lng, clip(label, 120)).run().catch(() => {});

  return { ok: true, until, minutes: mins, lat: c.lat, lng: c.lng };
}

/** They have packed up before the time they said. */
export async function clearPosition(env, placeId, { by = null } = {}) {
  if (!env?.DB || !placeId) return { ok: false };
  await ensure(env);
  // Expired rather than deleted: the log keeps the history either way, and a
  // row that expired at a known moment is more honest than one that vanished.
  await env.DB.prepare(
    "UPDATE num_venue_positions SET valid_until = datetime('now'), set_by = COALESCE(?2, set_by) WHERE place_id = ?1",
  ).bind(String(placeId), clip(by, 80)).run().catch(() => {});
  return { ok: true };
}

/**
 * Where are they, right now?
 *
 * THE COORDINATES ARE PRESENT ONLY WHEN `state === 'parked'`. On every other
 * state there are no lat/lng fields at all — not null ones, absent ones. A
 * caller that forgets to check the state cannot silently render a pin from
 * last Tuesday, because there is nothing there to render.
 *
 *   parked      standing somewhere now, and they said so
 *   expired     the time they gave has passed; `last` says where it was
 *   never       registered as mobile and has never posted a position
 *   not_mobile  an ordinary fixed place; this file has no opinion about it
 */
export async function positionOf(env, placeId) {
  if (!env?.DB || !placeId) return { state: 'not_mobile' };
  await ensure(env);

  const v = await env.DB.prepare('SELECT * FROM num_mobile_venues WHERE place_id = ?1 AND active = 1')
    .bind(String(placeId)).first().catch(() => null);
  if (!v) return { state: 'not_mobile' };

  const p = await env.DB.prepare('SELECT * FROM num_venue_positions WHERE place_id = ?1')
    .bind(String(placeId)).first().catch(() => null);

  const base = { state: 'never', place_id: String(placeId), name: v.name, kind: v.kind, social_url: v.social_url };
  if (!p) return base;

  if (p.valid_until > nowIso()) {
    return {
      ...base,
      state: 'parked',
      lat: p.lat,
      lng: p.lng,
      accuracy_m: p.accuracy_m,
      label: p.label,
      until: p.valid_until,
      since: p.created_at,
      set_via: p.set_via,
    };
  }

  return {
    ...base,
    state: 'expired',
    // Deliberately NO lat/lng. See the note above this function.
    last: { label: p.label, until: p.valid_until, set_via: p.set_via },
  };
}

/**
 * The sentence a concierge is allowed to say about a moving venue.
 *
 * Generated here rather than in a prompt, because this is the one place that
 * knows whether the coordinates are still true, and a model handed a position
 * object will describe whatever fields it finds.
 */
export function sayWhere(pos, { name = null } = {}) {
  const who = name || pos?.name || 'It';
  switch (pos?.state) {
    case 'parked':
      return pos.label
        ? `${who} is parked at ${pos.label} until ${pos.until.slice(11, 16)}.`
        : `${who} is parked right now, until ${pos.until.slice(11, 16)}.`;
    case 'expired':
      return pos.last?.label
        ? `${who} is not parked anywhere right now. Last time it was at ${pos.last.label}.`
        : `${who} is not parked anywhere right now.`;
    case 'never':
      return `${who} moves around and has not said where it is yet.`;
    default:
      return null;
  }
}

/**
 * Moving venues standing within `km` of a point, right now.
 *
 * The expiry is in the WHERE clause and not in a filter afterwards, because a
 * list that is correct only if every caller remembers to filter it is a list
 * that will one day be rendered raw.
 *
 * A bounding box first, haversine after — the same shape ai/places.js already
 * uses, so the cost of this is a rounding error next to the main search.
 */
export async function parkedNear(env, { lat, lng, km = 5, limit = 20 } = {}) {
  const c = coord(lat, lng);
  if (!env?.DB || !c) return [];
  await ensure(env);

  const dLat = km / 111;
  const dLng = km / (111 * Math.max(0.05, Math.cos((c.lat * Math.PI) / 180)));
  const { results } = await env.DB.prepare(
    `SELECT p.place_id, p.lat, p.lng, p.label, p.valid_until, v.name, v.kind, v.social_url
       FROM num_venue_positions p
       JOIN num_mobile_venues v ON v.place_id = p.place_id AND v.active = 1
      WHERE p.valid_until > datetime('now')
        AND p.lat BETWEEN ?1 AND ?2
        AND p.lng BETWEEN ?3 AND ?4
      LIMIT 200`,
  ).bind(c.lat - dLat, c.lat + dLat, c.lng - dLng, c.lng + dLng).all();

  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  return (results ?? [])
    .map((r) => {
      const dla = rad(r.lat - c.lat); const dlo = rad(r.lng - c.lng);
      const h = Math.sin(dla / 2) ** 2
        + Math.cos(rad(c.lat)) * Math.cos(rad(r.lat)) * Math.sin(dlo / 2) ** 2;
      return { ...r, km: Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10 };
    })
    .filter((r) => r.km <= km)
    .sort((a, b) => a.km - b.km)
    .slice(0, limit);
}

/**
 * Take out of a list of places every moving venue that is not parked right now.
 *
 * THIS IS NOT OPTIONAL AND IT IS NOT A TIDY-UP. `setPosition` writes the pitch
 * into `places.lat/lng` so the ordinary proximity search can find the truck.
 * The cost of that trick is that those columns keep saying Abbot Kinney long
 * after the truck has gone, because nothing moves them back. This is what
 * moves them back, logically: any list of places shown to a guest runs through
 * here first, and a venue whose operator's own expiry has passed drops out.
 *
 * Fixed places are untouched — the overwhelming majority of every list — and
 * the whole thing is one indexed query against the handful of registered
 * mobile venues, not a lookup per row.
 *
 * On any failure it returns the list UNCHANGED rather than empty. A broken
 * filter that silently blanks the recommendations is a worse outcome than a
 * truck shown at yesterday's kerb, and an empty answer is the failure mode
 * this codebase has already banned in writing for list queries.
 */
export async function hideExpired(env, rows, { idOf = (r) => r?.id } = {}) {
  if (!env?.DB || !Array.isArray(rows) || !rows.length) return rows;
  try {
    await ensure(env);
    const { results } = await env.DB.prepare(
      `SELECT v.place_id,
              (SELECT p.valid_until FROM num_venue_positions p WHERE p.place_id = v.place_id) AS valid_until
         FROM num_mobile_venues v WHERE v.active = 1`,
    ).all();
    if (!results?.length) return rows;
    const now = nowIso();
    const stale = new Set(
      results.filter((r) => !r.valid_until || r.valid_until <= now).map((r) => String(r.place_id)),
    );
    if (!stale.size) return rows;
    return rows.filter((r) => !stale.has(String(idOf(r))));
  } catch (e) {
    console.warn('[mobilevenue] hideExpired failed, list left as it was:', String(e).slice(0, 160));
    return rows;
  }
}

/** Where they have stood lately — theirs to see, and the answer to "yesterday?" */
export async function recentPitches(env, placeId, { limit = 10 } = {}) {
  if (!env?.DB || !placeId) return [];
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT lat, lng, label, valid_until, set_via, created_at
       FROM num_venue_position_log WHERE place_id = ?1
      ORDER BY created_at DESC LIMIT ?2`,
  ).bind(String(placeId), limit).all();
  return results ?? [];
}

/**
 * The token in the driver's saved link.
 *
 * The same HMAC shape bookdesk.mjs uses for confirm links, and for the same
 * reason: the person who needs to act is standing in a truck, and a password
 * between them and a four-second job means the job does not get done. The link
 * authorises one thing — saying where THIS venue is — and nothing else.
 *
 * It is a bearer token in a bookmark, which is a real exposure: whoever holds
 * it can move the pin. That is worth it here, and it is worth it precisely
 * because of the expiry rule. The worst a stolen link can do is put the truck
 * somewhere it is not for a few hours, which is bad; it cannot read a guest,
 * take a payment, or change anything that lasts.
 */
export async function hereToken(env, placeId) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env?.ADMIN_KEY ?? 'dev'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`here:${placeId}`));
  return [...new Uint8Array(mac)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hereLink(env, placeId) {
  const site = env?.SITE || 'https://itsnum.com';
  return `${site}/here/?p=${encodeURIComponent(placeId)}&t=${await hereToken(env, placeId)}`;
}

/** Constant-time-ish compare, so a wrong token cannot be found by timing. */
export function sameToken(a, b) {
  const x = String(a ?? ''); const y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
