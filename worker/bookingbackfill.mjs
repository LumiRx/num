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

/**
 * Outcomes that are an ANSWER, and outcomes that are just a bad moment.
 *
 * ── FOUND IN THE FIRST LIVE TICK, 7 Sep 2026 ──────────────────────────────
 *
 * Forty venues checked. Two came back HTTP 429 — rate-limited — and one 403.
 * Every one of them was written down as checked, which in the first version
 * meant NEVER LOOKED AT AGAIN. A restaurant that happened to be busy at the
 * moment we knocked would have been recorded as having no booking system, for
 * ever, and its guests sent to a phone number instead of its reservation page.
 *
 * That is the quietest kind of data bug: nothing errors, the job reports
 * progress, and the directory fills with confident wrong answers.
 *
 * So: `none`, `found`, `http-404` and `no-site` are answers — the site was
 * read, or it genuinely is not there. Everything else is a bad moment, and a
 * bad moment earns another look later.
 */
export const FINAL = Object.freeze(['found', 'none', 'http-404', 'no-site']);
export const isFinal = (outcome) => FINAL.includes(String(outcome ?? ''));

/** How long before a bad moment is worth another try, and how many times. */
export const RETRY_AFTER_DAYS = 7;
export const MAX_ATTEMPTS = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_booking_scan (
  place_id TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  outcome TEXT NOT NULL,
  platform TEXT,
  attempts INTEGER NOT NULL DEFAULT 1
);
`;
// Per DATABASE, not a module-level boolean — see the same note in devapi.mjs.
const readied = new WeakSet();
async function ensure(env) {
  if (!env?.DB || readied.has(env.DB)) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  // The table shipped without `attempts`. Duplicate-column on a re-run is the
  // expected no-op — the same lazy migration pattern used across this Worker.
  await env.DB.prepare('ALTER TABLE num_booking_scan ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1').run().catch(() => {});
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
 *
 * ── AND ROUND-ROBIN ACROSS CITIES (added after 160 live rows) ─────────────
 *
 * Ordering by reviews ALONE had an obvious flaw the moment real data arrived:
 * 144 of the first 160 venues checked were in Phuket, 16 in Lisbon, and
 * nowhere else had been touched. Phuket's restaurants carry high review
 * counts, so a global sort simply worked through Phuket — and Los Angeles,
 * London and New York, where OpenTable and Resy penetration is far higher and
 * where a booking link is worth the most, sat behind it for weeks.
 *
 * So the queue takes the top few venues from EVERY destination each tick,
 * ranked within that destination. Every city advances together, the famous
 * places everywhere get done first, and no single city can block the rest.
 * Same total work; the difference is only which order the value arrives in,
 * and that turns out to be the whole game.
 */
export async function candidates(env, { limit = 40 } = {}) {
  await ensure(env);
  const FINAL_MARKS = FINAL.map((_, i) => `?${i + 2}`).join(',');
  // `rank` is the venue's position WITHIN its own destination. Taking the top
  // few from every city each tick is what stops one city eating the queue.
  const { results } = await env.DB.prepare(
    `WITH queue AS (
       SELECT p.id, p.name, p.website, p.dest, COALESCE(p.reviews, 0) AS rv,
              ROW_NUMBER() OVER (PARTITION BY p.dest ORDER BY COALESCE(p.reviews, 0) DESC) AS rank
         FROM places p
         LEFT JOIN num_booking_scan s ON s.place_id = p.id
        WHERE p.website IS NOT NULL AND p.website <> ''
          AND (p.booking_platform IS NULL OR p.booking_platform = '')
          AND (p.category LIKE '%restaurant%' OR p.category LIKE '%bar%' OR p.category LIKE '%cafe%'
               OR p.category LIKE '%food%' OR p.category LIKE '%dining%')
          AND (
            s.place_id IS NULL
            OR (
              -- A bad moment, cooled off, and not yet given up on. See FINAL.
              s.outcome NOT IN (${FINAL_MARKS})
              AND COALESCE(s.attempts, 1) < ?${2 + FINAL.length}
              AND s.checked_at < datetime('now', ?${3 + FINAL.length})
            )
          )
     )
     SELECT id, name, website, dest FROM queue
      ORDER BY rank ASC, rv DESC
      LIMIT ?1`,
  ).bind(limit, ...FINAL, MAX_ATTEMPTS, `-${RETRY_AFTER_DAYS} days`).all().catch(() => ({ results: [] }));
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
      `INSERT INTO num_booking_scan (place_id, outcome, platform, attempts) VALUES (?1,?2,?3,1)
       ON CONFLICT(place_id) DO UPDATE SET outcome=?2, platform=?3, checked_at=datetime('now'),
                                           attempts = COALESCE(attempts, 1) + 1`,
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
            (SELECT COUNT(*) FROM num_booking_scan WHERE outcome NOT IN ('found','none','http-404','no-site')) retrying,
            (SELECT COUNT(*) FROM places WHERE booking_platform IS NOT NULL AND booking_platform<>'') bookable`,
  ).first().catch(() => null);
  return {
    checked: Number(r?.checked ?? 0),
    found: Number(r?.found ?? 0),
    // Named separately so a wall of rate-limits is visible rather than
    // hiding inside "checked" and looking like progress.
    retrying: Number(r?.retrying ?? 0),
    bookable: Number(r?.bookable ?? 0),
    note: 'Found means the venue advertises a booking system on its own site. Num links guests straight to that page — it does not book through it.',
  };
}
