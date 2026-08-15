/**
 * What Num earns when a booking actually happens.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * `num_business_settings` has carried `commission_bp` (1000 = 10%),
 * `booking_fee_cs` ($2.00) and `delivery_fee_cs` ($5.00) since the schema was
 * written. `grep commission_bp worker/ src/` returned **zero hits** on
 * 11 Aug 2026. The merchant invite already promises "10% only on completed
 * bookings" — so every table Num has ever confirmed has been free to the
 * venue, and we have been quietly under-delivering on our own offer in the
 * merchant's favour.
 *
 * ── WHY NOT 10% ACROSS THE BOARD ─────────────────────────────────────────
 *
 * Because a reservation and a sale are different things, and one rate prices
 * both wrong. A restaurant table is a LEAD: the venue may well have filled
 * that seat anyway, and the industry pays $1–3 per cover for it (OpenTable,
 * TheFork). Ten percent of a $300 dinner is $30 for a walk-in they might have
 * had — nobody signs that twice. A tour booking is a SALE, made and paid
 * through the channel, and the industry rate is 20–30% (Viator, GetYourGuide,
 * Klook). Charging 10% there leaves half the money on the table.
 *
 * So: flat per-cover on reservations, percentage on sales. Every rate below
 * sits inside its category's market band, because a rate a merchant can
 * check against a competitor is a rate that survives the second conversation.
 *
 * ── ACCRUAL, NOT COLLECTION ──────────────────────────────────────────────
 *
 * Nothing here charges anybody. It writes a row saying what is owed, and an
 * invoice is raised later against rows a merchant can audit. Two reasons, and
 * the second is the real one:
 *
 *   1. §8 — money never rests with us.
 *   2. At the moment a venue confirms a table we know a party of four is
 *      coming. We do NOT know what they spent, and we will not know until
 *      somebody tells us. A percentage of an unknown number is a guess, and
 *      billing a guess to a merchant is how you lose a merchant. Percentage
 *      lines are therefore written as `awaiting_value` and are not billable
 *      until a real amount arrives. Flat fees bill immediately, because a
 *      flat fee needs no amount.
 */

/** Basis points → percent, for humans reading a log line. */
const pct = (bp) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`;

/**
 * Category rates. `bp` is basis points of the transaction value; `flat_cs` is
 * cents per confirmed booking. A category uses ONE of them, never both.
 *
 * Market bands these sit inside, so the numbers can be defended:
 *   reservations  $1–3/cover      (OpenTable, TheFork)
 *   activities    20–30%          (Viator, GetYourGuide, Klook)
 *   stays         15–25%          (Booking.com, Expedia)
 *   delivery      15–30%          (DoorDash, Uber Eats)
 *   appointments  10–20%          (Booksy, Mindbody, Fresha)
 */
export const RATES = Object.freeze({
  // A table is a lead, not a sale. Flat, per confirmed booking.
  reservation: { flat_cs: 200, label: 'confirmed table', note: '$2 per confirmed booking' },
  // Sold and paid through the channel. Percentage, at the low end of the band
  // — we are new and the first hundred merchants are worth more than the rate.
  activity: { bp: 2000, label: 'activity booking', note: '20% of the booking value' },
  stay: { bp: 1500, label: 'stay', note: '15% of the booking value' },
  appointment: { bp: 1500, label: 'appointment', note: '15% of the service value' },
  // On top of the courier's own fee, which Num passes through at cost.
  delivery: { bp: 1000, flat_cs: 0, label: 'delivery', note: '10% of the order value' },
});

/**
 * Which rate applies to a place.
 *
 * Falls back to `reservation` — deliberately the CHEAPEST line and the only
 * flat one. An unrecognised category should under-bill, never over-bill: a
 * merchant who finds an unexpected charge stops trusting the whole ledger,
 * and one $2 line is a cheaper mistake than one 20% line.
 */
export function categoryFor(place = {}) {
  const c = String(place.category ?? '').toLowerCase();
  if (/hotel|guesthouse|hostel|resort|apartment|villa/.test(c)) return 'stay';
  if (/tour|activity|diving|charter|golf|theme park|water park|cooking|excursion/.test(c)) return 'activity';
  if (/spa|massage|beauty|salon|barber|nail|tattoo|clinic|gym|fitness|yoga/.test(c)) return 'appointment';
  if (/delivery|courier/.test(c)) return 'delivery';
  return 'reservation';
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_commissions (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  business_id TEXT,
  place_id TEXT,
  venue_name TEXT,
  member_id TEXT,
  dest TEXT,
  category TEXT NOT NULL,
  kind TEXT NOT NULL,
  rate_bp INTEGER,
  flat_cs INTEGER,
  basis_cs INTEGER,
  amount_cs INTEGER,
  currency TEXT NOT NULL DEFAULT 'usd',
  state TEXT NOT NULL DEFAULT 'accrued',
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  invoiced_at TEXT,
  note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_booking ON num_commissions(booking_id);
CREATE INDEX IF NOT EXISTS idx_comm_biz ON num_commissions(business_id, state, created_at);
`;
let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

/**
 * A merchant's own negotiated terms, if they have any.
 *
 * `num_business_settings` is the merchant's contract. When a row exists it
 * WINS over the category default — a rate agreed in a conversation must not
 * be silently overwritten by a code change six months later. Missing table or
 * missing row is the normal case and is not an error.
 */
async function termsFor(env, businessId) {
  if (!businessId) return null;
  try {
    const r = await env.DB.prepare(
      'SELECT commission_bp, booking_fee_cs, delivery_fee_cs FROM num_business_settings WHERE business_id = ?1',
    ).bind(businessId).first();
    return r ?? null;
  } catch {
    return null; // table not deployed in this environment
  }
}

/**
 * Record what a confirmed booking earns.
 *
 * IDEMPOTENT BY BOOKING ID. The venue's confirmation link is a URL on a phone;
 * it gets tapped twice, forwarded, and opened by link previewers. A unique
 * index on booking_id means the second write is a no-op rather than a second
 * charge — billing a merchant twice for one table is the fastest way to lose
 * them, and it would be invisible to us until they complained.
 *
 * Never throws: a booking must complete even if the ledger write fails. Money
 * we forgot to record is recoverable; a guest who lost their table is not.
 *
 * @returns {Promise<object|null>} the accrual, or null if nothing was owed.
 */
export async function accrue(env, {
  bookingId, place = {}, venueName = null, memberId = null, dest = null,
  valueCents = null, source = 'bookdesk', currency = 'usd',
} = {}) {
  if (!env?.DB || !bookingId) return null;
  try {
    await ensure(env);
    const category = categoryFor(place);
    const rate = RATES[category] ?? RATES.reservation;
    const terms = await termsFor(env, place.business_id ?? null);

    // Merchant terms win where they exist.
    const flat_cs = terms?.booking_fee_cs ?? rate.flat_cs ?? null;
    const rate_bp = terms?.commission_bp ?? rate.bp ?? null;

    let kind, amount_cs, state, note;
    if (rate_bp) {
      if (Number.isFinite(valueCents) && valueCents > 0) {
        kind = 'percent';
        amount_cs = Math.round((valueCents * rate_bp) / 10000);
        state = 'accrued';
        note = `${pct(rate_bp)} of ${(valueCents / 100).toFixed(2)}`;
      } else {
        // The honest state. We know a booking happened; we do not know what it
        // was worth, and a percentage of an unknown number is a guess. This
        // row is a claim to be completed, not an invoice.
        kind = 'percent';
        amount_cs = null;
        state = 'awaiting_value';
        note = `${pct(rate_bp)} — booking value not yet known`;
      }
    } else if (flat_cs > 0) {
      kind = 'flat';
      amount_cs = flat_cs;
      state = 'accrued';
      note = `flat ${(flat_cs / 100).toFixed(2)} per confirmed booking`;
    } else {
      return null; // this merchant owes nothing — an agreed zero is valid
    }

    const id = `cm_${bookingId}`;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO num_commissions
         (id, booking_id, business_id, place_id, venue_name, member_id, dest,
          category, kind, rate_bp, flat_cs, basis_cs, amount_cs, currency, state, source, note)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`,
    ).bind(
      id, String(bookingId), place.business_id ?? null, place.id ?? null,
      venueName ?? place.name ?? null, memberId, dest, category, kind,
      rate_bp ?? null, flat_cs ?? null, valueCents ?? null, amount_cs,
      currency, state, source, note,
    ).run();
    return { id, category, kind, amount_cs, state, note };
  } catch (e) {
    console.warn('[commission]', e?.message ?? e);
    return null;
  }
}

/**
 * Fill in the value of a booking we could only accrue as `awaiting_value`.
 * Called when an amount finally arrives — a merchant reporting it, a payment
 * landing, or an operator entering it.
 */
export async function settleValue(env, bookingId, valueCents) {
  if (!env?.DB || !bookingId || !Number.isFinite(valueCents) || valueCents <= 0) return null;
  try {
    await ensure(env);
    const row = await env.DB.prepare(
      "SELECT * FROM num_commissions WHERE booking_id = ?1 AND state = 'awaiting_value'",
    ).bind(String(bookingId)).first();
    if (!row) return null;
    const amount = Math.round((valueCents * (row.rate_bp ?? 0)) / 10000);
    await env.DB.prepare(
      "UPDATE num_commissions SET basis_cs=?2, amount_cs=?3, state='accrued', note=?4 WHERE id=?1",
    ).bind(row.id, valueCents, amount, `${pct(row.rate_bp)} of ${(valueCents / 100).toFixed(2)}`).run();
    return { id: row.id, amount_cs: amount };
  } catch (e) {
    console.warn('[commission settle]', e?.message ?? e);
    return null;
  }
}

/** What a merchant owes, itemised — the thing an invoice is built from. */
export async function statement(env, businessId, { since = null } = {}) {
  if (!env?.DB || !businessId) return { lines: [], total_cs: 0, awaiting: 0 };
  await ensure(env);
  const { results = [] } = await env.DB.prepare(
    `SELECT id, booking_id, venue_name, category, kind, rate_bp, amount_cs, state, created_at, note
       FROM num_commissions
      WHERE business_id = ?1 AND (?2 IS NULL OR created_at >= ?2)
      ORDER BY created_at DESC LIMIT 500`,
  ).bind(String(businessId), since).all();
  return {
    lines: results,
    // Only 'accrued' counts toward money. Rows awaiting a value are shown
    // separately and deliberately NOT summed — a total that silently includes
    // guesses is worse than no total.
    total_cs: results.filter((r) => r.state === 'accrued').reduce((n, r) => n + (r.amount_cs ?? 0), 0),
    awaiting: results.filter((r) => r.state === 'awaiting_value').length,
  };
}

/** Human-readable terms, for the merchant page and the invite. */
export const termsText = () =>
  Object.entries(RATES).map(([k, v]) => `${k}: ${v.note}`).join(' · ') +
  ' — charged only on bookings the venue confirms.';
