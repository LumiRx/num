/**
 * The record of a room NUM actually took.
 *
 * worker/liteapi.mjs talks to the supplier. This file is what NUM remembers
 * afterwards, and the two jobs are separate on purpose: the supplier's answer
 * is a response, and a reservation is a fact somebody will ask about in March.
 *
 * ── WHAT THIS FILE REFUSES ────────────────────────────────────────────────
 *
 * A payment instrument. Card, token, IBAN, billing address — a write carrying
 * one is REJECTED, not stripped. travelreferral.mjs makes the identical
 * refusal and states the reason better than I can: a field that is quietly
 * dropped is a field somebody will later "fix".
 *
 * The guest pays through Nuitée's SDK on their own device. Nuitée is merchant
 * of record. NUM holds no passenger money, so an adequate California
 * seller-of-travel bond is zero dollars (§17550.11). Every line below exists to
 * keep that sentence true under pressure.
 *
 * `transactionId` is stored and is not an exception to this. It is a checkout
 * SESSION reference minted by prebook and spent by book — it cannot be charged,
 * it expires, and the booking cannot complete without it.
 *
 * ── WHY THE PUBLIC PRICE IS STORED ────────────────────────────────────────
 *
 * Rates expire in about twenty minutes. So "did this member actually pay less
 * than the public price that night" is unanswerable a day later unless the
 * public price was written down at the time. NUM should be able to evidence
 * every saving it ever implied — and a saving NUM cannot evidence is one NUM
 * should not claim.
 */

/** House convention, defined locally like every other module here — there is
 *  no shared ids.mjs and inventing one for this file would be the wrong place
 *  to start. */
const uid = (p) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;

/** Same shape as travelreferral.mjs. Kept as its own copy so neither file's
 *  refusal can be weakened by a change made for the other one's benefit. */
export const PAYMENT_KEYS =
  /(card|cvv|cvc|\bpan\b|payment_method|paymentmethod|payment_token|stripe|iban|sort_code|account_number|routing|exp_month|exp_year|expiry|cardholder|billing_address)/i;

const paymentFieldIn = (obj, depth = 0) => {
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  for (const [k, v] of Object.entries(obj)) {
    // `transactionId` is a session reference, not an instrument — and it does
    // not match the pattern above. Nothing here special-cases it, which is the
    // point: if it ever DID look like an instrument, this would refuse it.
    if (PAYMENT_KEYS.test(k)) return k;
    const nested = paymentFieldIn(v, depth + 1);
    if (nested) return nested;
  }
  return null;
};

/** Throws rather than returns, because every caller's correct response is to stop. */
export function refusePaymentFields(payload) {
  const found = paymentFieldIn(payload);
  if (found) {
    const err = new Error(
      `A stay record may not carry payment details (found "${found}"). The guest pays the supplier directly; `
      + 'NUM holds no passenger money and storing an instrument here would end that.',
    );
    err.status = 400;
    err.code = 'payment_field_refused';
    throw err;
  }
  return true;
}

const cs = (amount) => (amount == null || !Number.isFinite(Number(amount)) ? null : Math.round(Number(amount) * 100));

export async function ensure(env) {
  // Matches the migration; present so a fresh database and a test both work
  // without the migration runner. The migration is still the source of truth —
  // see worker/migrations/0052_stay_bookings.sql for the reasoning.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS num_stay_bookings (
       id TEXT PRIMARY KEY, member_id TEXT NOT NULL, client_reference TEXT NOT NULL,
       prebook_id TEXT, transaction_id TEXT, booking_id TEXT, supplier_booking_id TEXT,
       hotel_confirmation_code TEXT, hotel_id TEXT, hotel_name TEXT, room_name TEXT,
       board_type TEXT, checkin TEXT NOT NULL, checkout TEXT NOT NULL,
       adults INTEGER NOT NULL DEFAULT 2, children_ages TEXT, rooms INTEGER NOT NULL DEFAULT 1,
       guest_nationality TEXT, currency TEXT, total_cs INTEGER, public_total_cs INTEGER,
       margin_pct REAL, fees_at_hotel_cs INTEGER DEFAULT 0, was_member_rate INTEGER NOT NULL DEFAULT 0,
       refundable INTEGER, cancel_by TEXT, cancel_policy TEXT,
       status TEXT NOT NULL DEFAULT 'held',
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  ).run();
  await env.DB.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_stay_bookings_client_ref ON num_stay_bookings (client_reference)',
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS num_stay_events (
       id INTEGER PRIMARY KEY AUTOINCREMENT, stay_id TEXT NOT NULL, event TEXT NOT NULL,
       detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  ).run();
}

async function record(env, stayId, event, detail) {
  await env.DB.prepare('INSERT INTO num_stay_events (stay_id, event, detail) VALUES (?1,?2,?3)')
    .bind(stayId, event, detail == null ? null : JSON.stringify(detail)).run();
}

/**
 * A reference the supplier sees and the database enforces.
 *
 * Idempotency is not a nicety here. A retried tap on one bar of signal is the
 * ordinary case, and the cost of getting it wrong is a second room nobody
 * wanted and a second charge.
 */
export const newClientReference = () => `num-${uid('stay')}`;

/**
 * Write the HELD row, at prebook — before anybody pays.
 *
 * Deliberately not at book. If the row is only written on success, a booking
 * that the supplier confirmed and whose response NUM failed to read is a room
 * that exists with nothing in NUM pointing at it. Writing first means the worst
 * case is a held row that never became a booking, which is visible and
 * reconcilable. The other way round is a guest with a reservation NUM denies.
 */
export async function hold(env, {
  memberId, clientReference, prebook, option, query, marginPct, wasMemberRate = false,
}) {
  refusePaymentFields({ prebook, option, query });
  await ensure(env);
  const id = uid('stay');
  await env.DB.prepare(
    `INSERT INTO num_stay_bookings
       (id, member_id, client_reference, prebook_id, transaction_id, hotel_id, hotel_name,
        room_name, board_type, checkin, checkout, adults, children_ages, rooms,
        guest_nationality, currency, total_cs, public_total_cs, margin_pct,
        fees_at_hotel_cs, was_member_rate, refundable, cancel_by, cancel_policy, status)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,'held')`,
  ).bind(
    id, memberId, clientReference, prebook?.prebookId ?? null, prebook?.transactionId ?? null,
    option?.hotelId ?? null, option?.hotel ?? option?.hotelName ?? null,
    option?.room ?? option?.roomName ?? null, option?.boardType ?? null,
    query.checkin, query.checkout,
    Number(query.adults) || 2, JSON.stringify(query.childrenAges ?? []), Number(query.rooms) || 1,
    query.guestNationality ?? null,
    prebook?.currency ?? option?.currency ?? null,
    cs(prebook?.total ?? option?.total), cs(option?.publicTotal),
    marginPct ?? null, cs(option?.payAtHotel) ?? 0, wasMemberRate ? 1 : 0,
    option?.refundable == null ? null : option.refundable ? 1 : 0,
    option?.cancelBy ?? null,
    JSON.stringify(prebook?.cancelPolicies ?? option?.cancelPolicies ?? []),
  ).run();
  await record(env, id, 'held', { prebookId: prebook?.prebookId ?? null });
  if (prebook?.priceChanged) await record(env, id, 'price_moved', { difference: prebook.priceDifference ?? null });
  return { id, clientReference };
}

/** The supplier confirmed. Cache the status; the event row is the truth. */
export async function confirm(env, stayId, booking) {
  refusePaymentFields(booking);
  await env.DB.prepare(
    `UPDATE num_stay_bookings
        SET booking_id=?2, supplier_booking_id=?3, hotel_confirmation_code=?4,
            total_cs=COALESCE(?5, total_cs), currency=COALESCE(?6, currency),
            status='confirmed', updated_at=datetime('now')
      WHERE id=?1`,
  ).bind(
    stayId, booking?.bookingId ?? null, booking?.supplierBookingId ?? null,
    booking?.hotelConfirmationCode ?? null, cs(booking?.total), booking?.currency ?? null,
  ).run();
  await record(env, stayId, 'confirmed', { bookingId: booking?.bookingId ?? null });
  return { id: stayId, status: 'confirmed' };
}

/**
 * It did not complete.
 *
 * A failure is recorded with the SUPPLIER'S OWN WORDS. "Rate no longer
 * available" is something a guest can act on; "booking failed" is something
 * they have to ring somebody about.
 */
export async function fail(env, stayId, why) {
  await env.DB.prepare(
    "UPDATE num_stay_bookings SET status='failed', updated_at=datetime('now') WHERE id=?1",
  ).bind(stayId).run();
  await record(env, stayId, 'failed', { why: String(why ?? '').slice(0, 500) });
  return { id: stayId, status: 'failed' };
}

export async function cancelled(env, stayId, detail) {
  await env.DB.prepare(
    "UPDATE num_stay_bookings SET status='cancelled', updated_at=datetime('now') WHERE id=?1",
  ).bind(stayId).run();
  await record(env, stayId, 'cancelled', detail ?? null);
  return { id: stayId, status: 'cancelled' };
}

/**
 * The evidence behind a stay, written after the hold.
 *
 * Separate from hold() on purpose. hold() must land the moment a prebook
 * succeeds — it is the row that proves NUM tried — and it must not grow a
 * dependency on a second supplier call that might be slow or absent. So the
 * evidence is a follow-up UPDATE: if the price-index lookup or the content
 * fetch fails, the booking is still recorded and the columns stay NULL, which
 * reads correctly as "we did not have a second reference" rather than as a
 * reference that agreed.
 *
 * `loyaltyDisclosed` is the one worth being strict about. NULL means the
 * question never arose because it was not a chain property; 0 means it WAS a
 * chain and the warning was not shown, which is a row somebody should be
 * unhappy about.
 */
export async function recordEvidence(env, stayId, {
  publicRefCs = null, publicRefVerdict = null, publicRefGapPct = null,
  hotelChain = null, loyaltyDisclosed = null,
  checkinFrom = null, checkoutBefore = null, placeResolution = null,
} = {}) {
  await env.DB.prepare(
    `UPDATE num_stay_bookings
        SET public_ref_cs = COALESCE(?2, public_ref_cs),
            public_ref_verdict = COALESCE(?3, public_ref_verdict),
            public_ref_gap_pct = COALESCE(?4, public_ref_gap_pct),
            hotel_chain = COALESCE(?5, hotel_chain),
            loyalty_disclosed = COALESCE(?6, loyalty_disclosed),
            checkin_from = COALESCE(?7, checkin_from),
            checkout_before = COALESCE(?8, checkout_before),
            place_resolution = COALESCE(?9, place_resolution),
            updated_at = datetime('now')
      WHERE id = ?1`,
  ).bind(
    stayId,
    publicRefCs, publicRefVerdict, publicRefGapPct, hotelChain,
    loyaltyDisclosed == null ? null : (loyaltyDisclosed ? 1 : 0),
    checkinFrom, checkoutBefore, placeResolution,
  ).run();
  return { id: stayId };
}

/**
 * Every stay where the two public-price references disagreed.
 *
 * The report that answers "is our saving claim sound". A steady trickle is
 * normal — these are two caches of a moving number. A cluster on one chain or
 * one market is a data problem, and it is cheaper to find here than in a
 * complaint.
 */
export async function disagreements(env, { limit = 50 } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT id, hotel_name, hotel_chain, checkin, currency, total_cs,
            public_total_cs, public_ref_cs, public_ref_gap_pct, created_at
       FROM num_stay_bookings
      WHERE public_ref_verdict = 'disagreed'
      ORDER BY public_ref_gap_pct DESC
      LIMIT ?1`,
  ).bind(Math.min(200, Math.max(1, limit))).all();
  return results ?? [];
}

/**
 * What the wallet shows.
 *
 * NOT `.catch(() => ({ results: [] }))`. A failed read here would render as
 * "you have no bookings" to somebody who has one, which is worse than an error.
 */
export async function forMember(env, memberId, { limit = 25 } = {}) {
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT id, hotel_name, room_name, checkin, checkout, currency, total_cs,
            fees_at_hotel_cs, refundable, cancel_by, hotel_confirmation_code, status, created_at
       FROM num_stay_bookings
      WHERE member_id = ?1
      ORDER BY created_at DESC
      LIMIT ?2`,
  ).bind(memberId, Math.min(100, Math.max(1, limit))).all();
  return (results ?? []).map((r) => ({
    id: r.id,
    hotel: r.hotel_name,
    room: r.room_name,
    checkin: r.checkin,
    checkout: r.checkout,
    currency: r.currency,
    total: r.total_cs == null ? null : r.total_cs / 100,
    payAtHotel: r.fees_at_hotel_cs ? r.fees_at_hotel_cs / 100 : null,
    refundable: r.refundable == null ? null : !!r.refundable,
    cancelBy: r.cancel_by,
    confirmationCode: r.hotel_confirmation_code,
    status: r.status,
    // Deliberately absent: public_total_cs, margin_pct, was_member_rate. The
    // wall in liteapi.mjs holds here too — what NUM earned is not a field on a
    // guest's own receipt.
  }));
}

export async function byId(env, stayId, memberId) {
  await ensure(env);
  return env.DB.prepare(
    'SELECT * FROM num_stay_bookings WHERE id = ?1 AND member_id = ?2',
  ).bind(stayId, memberId).first();
}

/** The audit view. Server-side only — this is the one that carries the margin. */
export async function auditFor(env, stayId) {
  await ensure(env);
  const row = await env.DB.prepare('SELECT * FROM num_stay_bookings WHERE id = ?1').bind(stayId).first();
  if (!row) return null;
  const { results } = await env.DB.prepare(
    'SELECT event, detail, created_at FROM num_stay_events WHERE stay_id = ?1 ORDER BY id',
  ).bind(stayId).all();
  return { booking: row, events: results ?? [] };
}
