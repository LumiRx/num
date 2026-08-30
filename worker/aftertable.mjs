/**
 * After the table: how was it, and would you like to leave something.
 *
 * The Uber shape — one screen after the thing happened — applied to a
 * restaurant. Schema and the full reasoning: migrations/0009.
 *
 * Three things live here and they are deliberately kept apart:
 *
 *   rating   — how it was. Cannot be bought, cannot be earned by tipping.
 *   tip      — the server's money. NUM takes none of it and never holds it.
 *   priority — the guest paying to be seated sooner. The venue keeps 40%.
 *
 * The one line to remember from all of it: a tip is not revenue. It passes
 * through this file and never touches num_commissions.
 */

/** The most a guest may ever be asked for priority seating. Dre's ceiling. */
export const PRIORITY_MAX_CS = 2000;   // $20.00

/** The venue's default share of a priority fee. 4000bp = 40%. */
export const PRIORITY_SHARE_BPS = 4000;

/**
 * How many NUM ratings a place needs before NUM shows an average.
 *
 * Below this the number is noise wearing the costume of a statistic: three
 * ratings averaging 4.7 reads identically to three hundred and is worth
 * nothing like as much. Venues are shown their own ratings from the first
 * one — that is feedback, not a score — but guests see nothing until there
 * is something to see.
 */
export const MIN_RATINGS = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_ratings (
  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, business_id TEXT,
  place_id TEXT, member_ref TEXT,
  stars INTEGER CHECK (stars IS NULL OR stars BETWEEN 1 AND 5),
  comment TEXT, lang TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (booking_id)
);
CREATE TABLE IF NOT EXISTS num_tips (
  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, business_id TEXT, place_id TEXT,
  amount_cs INTEGER NOT NULL CHECK (amount_cs > 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  for_whom TEXT,
  rail TEXT NOT NULL DEFAULT 'venue' CHECK (rail IN ('venue','paylink','cash','other')),
  rail_ref TEXT,
  state TEXT NOT NULL DEFAULT 'recorded' CHECK (state IN ('recorded','settled','failed','void')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), settled_at TEXT,
  UNIQUE (booking_id)
);
CREATE TABLE IF NOT EXISTS num_venue_payouts (
  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, business_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('priority_seating','adjustment')),
  gross_cs INTEGER NOT NULL CHECK (gross_cs >= 0),
  share_bps INTEGER NOT NULL CHECK (share_bps BETWEEN 0 AND 10000),
  amount_cs INTEGER NOT NULL CHECK (amount_cs >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  state TEXT NOT NULL DEFAULT 'accrued' CHECK (state IN ('accrued','payable','paid','void')),
  void_reason TEXT, payout_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT,
  CHECK (kind = 'adjustment' OR amount_cs <= gross_cs),
  UNIQUE (booking_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_ratings_biz ON num_ratings(business_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tips_biz ON num_tips(business_id, created_at);
CREATE INDEX IF NOT EXISTS idx_venue_payouts_biz ON num_venue_payouts(business_id, state);
`;

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.batch(
    SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)),
  );
  ready = true;
}
export const _resetSchemaCache = () => { ready = false; };

const id = (p) => `${p}_${Math.random().toString(36).slice(2, 12)}`;
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.trunc(Number(v) || 0)));

/* ── how it was ─────────────────────────────────────────────────────────── */

/**
 * Record a guest's rating of a completed booking.
 *
 * Stars and comment are independent and either may be absent: a guest who
 * only wanted to say "the terrace was closed" has told the venue something
 * useful without scoring it, and a guest who gave four stars and no words has
 * too. Recording a null rating as three stars — the tempting default — would
 * invent an opinion nobody held.
 *
 * @returns {Promise<object|null>}
 */
export async function rate(env, {
  bookingId, businessId = null, placeId = null, memberRef = null,
  stars = null, comment = null, lang = null,
} = {}) {
  if (!env?.DB || !bookingId) return null;

  const s = stars == null ? null : clampInt(stars, 1, 5);
  const text = comment == null ? null : String(comment).slice(0, 2000).trim() || null;
  // Nothing said is not a rating. Writing an empty row would put a venue's
  // response rate up and tell it nothing.
  if (s == null && !text) return null;

  try {
    await ensure(env);
    const rid = id('rt');
    await env.DB.prepare(
      `INSERT INTO num_ratings (id,booking_id,business_id,place_id,member_ref,stars,comment,lang)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
       ON CONFLICT(booking_id) DO UPDATE SET
         stars   = COALESCE(excluded.stars, num_ratings.stars),
         comment = COALESCE(excluded.comment, num_ratings.comment)`,
    ).bind(rid, String(bookingId), businessId, placeId, memberRef, s, text, lang).run();
    return { id: rid, stars: s, comment: text };
  } catch (e) {
    console.warn('[aftertable.rate]', e?.message ?? e);
    return null;
  }
}

/**
 * What NUM's own guests say about a place.
 *
 * Returned separately from places.rating, which is crawled from the open web.
 * Merging them would let eleven of ours quietly overwrite four hundred of
 * Google's and present a thin sample with the authority of a thick one.
 *
 * `show` is false until MIN_RATINGS exist. The average is still returned so a
 * venue can see its own feedback from the first rating; `show` is the guest-
 * facing gate.
 */
export async function ratingFor(env, { placeId = null, businessId = null } = {}) {
  if (!env?.DB || (!placeId && !businessId)) return null;
  try {
    await ensure(env);
    const r = await env.DB.prepare(
      `SELECT COUNT(stars) AS n, AVG(stars) AS avg FROM num_ratings
        WHERE stars IS NOT NULL AND (?1 IS NOT NULL AND place_id = ?1
                                  OR ?2 IS NOT NULL AND business_id = ?2)`,
    ).bind(placeId, businessId).first();
    const n = r?.n ?? 0;
    return {
      n,
      avg: n ? Math.round((r.avg + Number.EPSILON) * 10) / 10 : null,
      show: n >= MIN_RATINGS,
    };
  } catch (e) {
    console.warn('[aftertable.ratingFor]', e?.message ?? e);
    return null;
  }
}

/* ── the server's money ─────────────────────────────────────────────────── */

/**
 * Record a tip. NUM takes NOTHING from it and never holds it.
 *
 * See migrations/0009 for the law. The short version: a tip is the server's
 * money, 29 U.S.C. §203(m)(2)(B) says no employer, manager or supervisor may
 * keep any part of it, and a platform that skims tips becomes the story
 * rather than the product. There is no commission parameter on this function
 * and no fee column on the table, so there is nowhere to put the number even
 * if somebody later wanted to.
 *
 * `rail` says where the money actually moved — the venue's own paylink, the
 * bill QR, or cash in a hand. NUM records that it happened. It does not
 * carry it, because carrying other people's money is money transmission and
 * every table in this schema is built to avoid exactly that.
 *
 * @returns {Promise<object|null>}
 */
export async function tip(env, {
  bookingId, businessId = null, placeId = null,
  amountCs, currency = 'usd', forWhom = null,
  rail = 'venue', railRef = null,
} = {}) {
  if (!env?.DB || !bookingId) return null;
  const amount = Math.trunc(Number(amountCs) || 0);
  if (amount <= 0) return null;               // not a tip
  if (!['venue', 'paylink', 'cash', 'other'].includes(rail)) return null;

  try {
    await ensure(env);
    const tid = id('tp');
    await env.DB.prepare(
      `INSERT INTO num_tips (id,booking_id,business_id,place_id,amount_cs,currency,for_whom,rail,rail_ref)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
       ON CONFLICT(booking_id) DO UPDATE SET
         amount_cs = excluded.amount_cs,
         for_whom  = COALESCE(excluded.for_whom, num_tips.for_whom),
         rail_ref  = COALESCE(excluded.rail_ref, num_tips.rail_ref)`,
    ).bind(
      tid, String(bookingId), businessId, placeId, amount, currency,
      forWhom == null ? null : String(forWhom).slice(0, 120), rail, railRef,
    ).run();
    // Deliberately returns no fee, no net, no share. There isn't one.
    return { id: tid, amount_cs: amount, currency, rail };
  } catch (e) {
    console.warn('[aftertable.tip]', e?.message ?? e);
    return null;
  }
}


/* ── whether to ask at all ──────────────────────────────────────────────── */

/**
 * Should NUM offer this venue's guests the chance to leave something?
 *
 * The gate is on the OFFER, never on tip() itself. tip() records money that
 * has already moved; a flag must not be able to make NUM forget that it did.
 * What a flag may decide is whether NUM asks — and the default is no.
 *
 * Off until a human at the venue turns it on and accepts the undertaking in
 * migrations/0010: a tip NUM prompts for and the venue does not pass on is a
 * tip NUM helped take, and 29 U.S.C. §203(m)(2)(B) is unambiguous about who
 * that money belongs to. See growth/venuesettings.mjs.
 */
export async function tipsOffered(env, place = {}, businessId = null) {
  if (!env?.DB || !businessId) return false;
  const { foodAndDrink } = await import('./commission.mjs');
  if (!foodAndDrink(place)) return false;
  try {
    await ensure(env);
    const s = await env.DB.prepare(
      'SELECT COALESCE(f_tips,0) AS on_ FROM num_business_settings WHERE business_id = ?1',
    ).bind(businessId).first();
    return s?.on_ === 1;
  } catch (e) {
    console.warn('[aftertable.tipsOffered]', e?.message ?? e);
    return false;
  }
}

/* ── priority seating ───────────────────────────────────────────────────── */

/**
 * What a guest may be asked for priority seating at this place, and what the
 * venue keeps of it.
 *
 * Returns null when the venue has not switched it on — which is the default,
 * and stays the default. Priority seating is something a venue opts into,
 * because it is the venue that has to honour it.
 *
 * IT MUST NOT AFFECT RANKING. See migrations/0009 and priority.test.mjs. The
 * guest is paying for a better table at a place they already chose, not for
 * that place to be chosen. One word apart, and the word is who pays.
 */
export async function prioritySeating(env, place = {}, businessId = null) {
  if (!env?.DB || !businessId) return null;
  // A per-cover upgrade at a venue with no covers is not a product.
  const { foodAndDrink } = await import('./commission.mjs');
  if (!foodAndDrink(place)) return null;

  try {
    await ensure(env);
    const s = await env.DB.prepare(
      `SELECT COALESCE(f_priority_seating,0) AS on_, COALESCE(priority_max_cs,0) AS max_cs,
              COALESCE(priority_share_bps,${PRIORITY_SHARE_BPS}) AS share_bps
         FROM num_business_settings WHERE business_id = ?1`,
    ).bind(businessId).first();
    if (!s || s.on_ !== 1) return null;

    // Clamped in code as well as in the CHECK: a settings row written before
    // the constraint existed, or by a future migration that forgets it, must
    // not be able to bill a guest $200 for a table.
    const maxCs = clampInt(s.max_cs, 0, PRIORITY_MAX_CS);
    if (maxCs <= 0) return null;
    return {
      max_cs: maxCs,
      share_bps: clampInt(s.share_bps, 0, 10000),
      note: `up to $${(maxCs / 100).toFixed(maxCs % 100 ? 2 : 0)} for priority seating`,
    };
  } catch (e) {
    console.warn('[aftertable.prioritySeating]', e?.message ?? e);
    return null;
  }
}

/**
 * A guest paid for priority seating: record what the venue is owed.
 *
 * The mirror of accrue(). That writes what a venue owes NUM; this writes what
 * NUM owes a venue, in its own table, because netting the two produces one
 * number nobody can audit.
 *
 * Idempotent by (booking, kind) for the same reason every other write here
 * is: the confirmation link is a URL on a phone and it gets tapped twice.
 *
 * @returns {Promise<object|null>}
 */
export async function accruePriority(env, {
  bookingId, businessId, grossCs, shareBps = null, currency = 'usd',
} = {}) {
  if (!env?.DB || !bookingId || !businessId) return null;
  const gross = clampInt(grossCs, 0, PRIORITY_MAX_CS);
  if (gross <= 0) return null;

  const bps = clampInt(shareBps ?? PRIORITY_SHARE_BPS, 0, 10000);
  // Rounded DOWN. A rounding error should land in the payer's favour, not
  // silently make NUM owe a fraction of a cent more than it collected — the
  // amount_cs <= gross_cs constraint would reject the row anyway, and losing
  // a booking's payout to a constraint violation is worse than losing a cent.
  const amount = Math.floor((gross * bps) / 10000);

  try {
    await ensure(env);
    const pid = id('vp');
    await env.DB.prepare(
      `INSERT OR IGNORE INTO num_venue_payouts
         (id,booking_id,business_id,kind,gross_cs,share_bps,amount_cs,currency)
       VALUES (?1,?2,?3,'priority_seating',?4,?5,?6,?7)`,
    ).bind(pid, String(bookingId), String(businessId), gross, bps, amount, currency).run();
    return { id: pid, gross_cs: gross, share_bps: bps, amount_cs: amount, currency };
  } catch (e) {
    console.warn('[aftertable.accruePriority]', e?.message ?? e);
    return null;
  }
}

/**
 * What a venue is owed, in a sentence it can check.
 *
 * Kept next to the numbers for the same reason feeSentence() is: a price
 * written by hand into an email drifts the day the number changes, silently,
 * in an artefact nobody re-reads.
 */
export const prioritySentence = (maxCs = PRIORITY_MAX_CS, bps = PRIORITY_SHARE_BPS) =>
  `Guests may pay up to $${(clampInt(maxCs, 0, PRIORITY_MAX_CS) / 100).toFixed(0)} for priority seating, ` +
  `and you keep ${bps / 100}% of it. It never changes where you appear.`;
