/**
 * FINDING OUT WHICH BOOKING SYSTEM A RESTAURANT ALREADY USES.
 *
 * ── The measurement that produced this file (7 Sep 2026) ──────────────────
 *
 * Dre asked to "connect table bookings — OpenTable and other booking apps".
 * The first thing to say is that nobody can: OpenTable, Resy, Tock and
 * SevenRooms have no public write API, at any price, for anyone. Access is a
 * negotiated commercial partnership, and the data it grants is scoped to that
 * partnership. That is a conversation, not a build.
 *
 * The second thing is much more interesting. Num does not need their API to
 * send a guest to the right booking page — `bookingLink()` has done that since
 * August. It needs to KNOW which system a venue runs on. And the directory
 * says:
 *
 *     places with a phone number ............ 1,861,063
 *     places with a booking platform ................ 17
 *
 * Seventeen. The deeplink feature works and fires almost never, because
 * nothing has ever gone and looked. `detectBooking()` — the function that
 * reads a page and recognises an OpenTable or Resy widget — has existed the
 * whole time and has never been run across the directory.
 *
 * So this is not a new capability. It is switching on one we already built and
 * then never pointed at anything.
 *
 * ── Why this is allowed, and worth saying plainly ─────────────────────────
 *
 * We are not scraping a booking system. We fetch the RESTAURANT'S OWN
 * homepage — a page they publish for customers — and notice that it links to
 * their booking widget. That is the same thing a person does when they look at
 * a restaurant's site to find the "Book a table" button. Nothing is read from
 * OpenTable, no availability is queried, no account is used.
 *
 * ── How it behaves ────────────────────────────────────────────────────────
 *
 * Slowly and politely, forever. A batch per cron tick, one fetch per venue,
 * a short timeout, and a permanent mark on every row it has looked at so the
 * next tick moves on rather than re-reading the same hundred sites. A venue
 * with no booking system gets marked as checked too — "we looked and there was
 * nothing" is a result, and not recording it is how a crawler loops.
 */
import { detectBooking } from './booking.mjs';

/** Marked into booking_platform when a site was read and had no booking system. */
export const NONE = '-';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_booking_scan (
  place_id TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  outcome TEXT NOT NULL,
  platform TEXT
);
`;
// Per DATABASE, not a module-level boolean — see the same note in devapi.mjs.
const readied = new WeakSet();
async function ensure(env) {
  if (!env?.DB || readied.has(env.DB)) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  readied.add(env.DB);
}

/**
 * Venues worth looking at, MOST-RECOMMENDED FIRST.
 *
 * Only places with a website (nothing to read otherwise), only ones we have
 * not already checked, and restaurants and bars before anything else — a
 * hotel's booking engine is already handled by the stay platforms and a
 * museum does not take reservations.
 *
 * ── WHY THE ORDER IS THE WHOLE DESIGN (7 Sep 2026) ────────────────────────
 *
 * The first live tick checked 40 venues and found 1. That rate is not a bug —
 * this directory is heavy in Bangkok, Manila and Taipei, where most
 * street-level restaurants genuinely run no booking system at all — but it
 * sets the arithmetic:
 *
 *     348,408 to check ÷ 40 a tick × 5 minutes  ≈  30 days
 *
 * A month is fine for a background job and completely wrong as a plan,
 * because it treats every row as equally worth knowing. It is not. A guest is
 * shown three places, and those three are the well-reviewed ones — the exact
 * places most likely to run OpenTable or Resy AND the only ones whose booking
 * link anybody will ever tap.
 *
 * So the queue is ordered by review count. The first day covers the venues
 * Num actually recommends; the long tail fills in behind it over the month
 * and nobody is waiting on it. Same total work, most of the value in the
 * first afternoon.
 *
 * `reviews` is nullable across much of the directory, hence COALESCE — a row
 * with no review count sorts last rather than sorting unpredictably.
 */
export async function candidates(env, { limit = 40 } = {}) {
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.website, p.dest
       FROM places p
       LEFT JOIN num_booking_scan s ON s.place_id = p.id
      WHERE p.website IS NOT NULL AND p.website <> ''
        AND (p.booking_platform IS NULL OR p.booking_platform = '')
        AND s.place_id IS NULL
        AND (p.category LIKE '%restaurant%' OR p.category LIKE '%bar%' OR p.category LIKE '%cafe%'
             OR p.category LIKE '%food%' OR p.category LIKE '%dining%')
      ORDER BY COALESCE(p.reviews, 0) DESC
      LIMIT ?1`,
  ).bind(limit).all().catch(() => ({ results: [] }));
  return results ?? [];
}

/**
 * Read one venue's own page and see what it says about booking.
 *
 * Never throws. A site that is slow, dead, or hostile is a row we mark as
 * looked-at and move past — the alternative is a backfill that stops on the
 * first restaurant with an expired certificate.
 */
export async function scanOne(env, place, { fetchImpl } = {}) {
  const doFetch = fetchImpl ?? ((...a) => fetch(...a));
  const url = String(place?.website ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return { id: place?.id, outcome: 'no-site' };
  try {
    const res = await doFetch(url, {
      // Said honestly. A crawler that hides what it is has already decided it
      // is doing something it should not.
      headers: { 'User-Agent': 'NumBot/1.0 (+https://itsnum.com/for-ai/) booking-link discovery' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { id: place.id, outcome: `http-${res.status}` };
    // A homepage is enough — the booking widget is in the header or the hero.
    // Reading further costs bandwidth for both of us and finds nothing new.
    const html = (await res.text()).slice(0, 220_000);
    const found = detectBooking(html, res.url || url);
    return found
      ? { id: place.id, outcome: 'found', platform: found.platform, ref: found.ref }
      : { id: place.id, outcome: 'none' };
  } catch (e) {
    return { id: place.id, outcome: 'unreachable', why: String(e?.message ?? e).slice(0, 80) };
  }
}

/**
 * One tick of the backfill.
 *
 * Every venue looked at is recorded, whatever the outcome, so the next tick
 * advances. Only a real find writes to `places` — a failed fetch must never
 * overwrite a platform somebody set by hand.
 */
export async function backfillBookings(env, { limit = 40, fetchImpl } = {}) {
  await ensure(env);
  const rows = await candidates(env, { limit });
  if (!rows.length) return { looked: 0, found: 0, done: true };

  const results = [];
  for (const place of rows) {
    // Sequential on purpose. Forty parallel fetches from one Worker is a
    // burst that looks like an attack to a small restaurant's host, and this
    // job has no deadline — it runs every tick, forever.
    results.push(await scanOne(env, place, { fetchImpl }));
  }

  const stmts = [];
  for (const r of results) {
    if (!r?.id) continue;
    stmts.push(env.DB.prepare(
      `INSERT INTO num_booking_scan (place_id, outcome, platform) VALUES (?1,?2,?3)
       ON CONFLICT(place_id) DO UPDATE SET outcome=?2, platform=?3, checked_at=datetime('now')`,
    ).bind(r.id, r.outcome, r.platform ?? null));
    if (r.outcome === 'found') {
      // Only ever fills a BLANK. A platform recorded by hand, or by a partner
      // telling us directly, outranks anything a crawler guessed.
      stmts.push(env.DB.prepare(
        `UPDATE places SET booking_platform=?2, booking_ref=?3
          WHERE id=?1 AND (booking_platform IS NULL OR booking_platform='')`,
      ).bind(r.id, r.platform, r.ref));
    }
  }
  try {
    if (stmts.length) await env.DB.batch(stmts);
  } catch (e) {
    console.error('[bookingbackfill] batch failed', e?.message ?? e);
    return { looked: results.length, found: 0, error: true };
  }

  const found = results.filter((r) => r.outcome === 'found').length;
  return { looked: results.length, found, done: false };
}

/** How far along, for the operator page. */
export async function progress(env) {
  await ensure(env);
  const r = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM num_booking_scan) checked,
            (SELECT COUNT(*) FROM num_booking_scan WHERE outcome='found') found,
            (SELECT COUNT(*) FROM places WHERE booking_platform IS NOT NULL AND booking_platform<>'') bookable`,
  ).first().catch(() => null);
  return {
    checked: Number(r?.checked ?? 0),
    found: Number(r?.found ?? 0),
    bookable: Number(r?.bookable ?? 0),
    note: 'Found means the venue advertises a booking system on its own site. Num links guests straight to that page — it does not book through it.',
  };
}
