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
/** Cents → the way a merchant writes it: `$2`, not `$2.00`; `$2.50` when it is. */
const money = (cs) => `$${cs % 100 ? (cs / 100).toFixed(2) : cs / 100}`;

/**
 * Build one rate, deriving its human `note` from its machine numbers.
 *
 * `note` used to be typed out beside `bp` — and a hand-typed number beside a
 * machine one is two prices that agree only until somebody edits one. Halving
 * `bp` while the note still read "15%" would have quoted merchants a rate the
 * ledger had stopped using, silently, in outbound email. So the sentence is
 * now COMPUTED and only `basis` — the noun the rate applies to — is written by
 * hand, because a noun cannot disagree with an integer.
 */
/**
 * What a venue owes when Num did NOT send the guest.
 *
 * ── WHY THIS IS $2 AND NOT 3% ────────────────────────────────────────────
 *
 * Dre, 12 Sep 2026: 10% felt high enough to scare venues off, and PayPal
 * charges about 3%, so why not 3%?
 *
 * Because PayPal's 3% buys something we do not sell. Checked the same day:
 * PayPal takes 2.29% + $0.09 on a QR payment and 3.49% + $0.49 on online
 * checkout — that is the price of MOVING MONEY. Num never holds this money;
 * `payGo` 302s the guest to the venue's own Stripe or PayPal link. So the venue
 * pays their processor ~2.9% whether we exist or not, and 3% from us would be
 * stacked on top: roughly 6% all-in, for a guest we did not send, on a payment
 * we did not process. That is the invoice a venue cancels over, and they would
 * be right.
 *
 * It is also uncollectable at the bottom end. We invoice rather than deduct, so
 * 3% of a $40 bill is a $1.20 line item, and chasing $1.20 costs more than
 * $1.20. Collection cost is per invoice, not per dollar.
 *
 * $2 flat is the honest shape: it covers what the line costs to carry, it is
 * the same floor venues already accept for a confirmed table, and because it
 * does NOT scale it can never read as a tax on their own regulars — which is
 * the objection that actually causes churn. On an $80 dinner it is 2.5%, inside
 * the band Dre named. On a $500 dinner it is still $2, not $15.
 *
 * 3% becomes correct the day Num processes the payment itself, because then it
 * REPLACES the processor's fee instead of stacking on it, and undercuts the
 * 3.49% the venue pays today. Until then this is flat.
 *
 * Before 12 Sep 2026 this case was free. Free was defensible and generous; it
 * was also the only path on the bill QR that earned nothing, while carrying the
 * same support and invoicing cost as one that earns.
 */
export const PAYMENT_ONLY_FLAT_CS = 200;

const rate = ({ basis, flatBasis, ...r }) =>
  Object.freeze({
    ...r,
    basis,
    flatBasis,
    // A rate can now carry BOTH numbers — see `reservation` below — and when
    // it does, the sentence has to carry both too. Quoting only the percentage
    // to a venue that will actually be billed the flat fee is the same drift
    // this function was written to stop, one level up.
    note: r.bp && r.flat_cs
      ? `${pct(r.bp)} of ${basis}, or ${money(r.flat_cs)} per ${flatBasis ?? basis} if we cannot see it`
      : r.bp ? `${pct(r.bp)} of ${basis}` : `${money(r.flat_cs)} per ${basis}`,
  });

export const RATES = Object.freeze({
  // A table is priced two ways, and which one applies is not a policy choice —
  // it is a fact about whether NUM can see what the guest spent.
  //
  //   10% of the bill   when the venue is on something that reports it
  //   $2 per table      when it is not
  //
  // Until 26 Aug 2026 this line was $2 flat everywhere except Thailand, while
  // the business page, the merchant invite and the Thai rate card all promised
  // 10%. Two prices in public, one in the ledger. This is the published one.
  //
  // The flat fee is not a lesser alternative, it is the FLOOR. A percentage of
  // a bill nobody reported is zero, and a venue that takes fifty NUM tables
  // and never once tells us the total should not be free. $2 also sits inside
  // the $1–3/cover band OpenTable and TheFork charge, so a venue that never
  // connects anything is still paying a rate it can check against a
  // competitor.
  reservation: rate({
    bp: 1000, flat_cs: 200, label: 'confirmed table',
    basis: 'the bill', flatBasis: 'confirmed table',
  }),
  // Sold and paid through the channel. Percentage, at the low end of the band
  // — we are new and the first hundred merchants are worth more than the rate.
  activity: rate({ bp: 2000, label: 'activity booking', basis: 'the booking value' }),
  stay: rate({ bp: 1500, label: 'stay', basis: 'the booking value' }),
  appointment: rate({ bp: 1500, label: 'appointment', basis: 'the service value' }),
  // On top of the courier's own fee, which Num passes through at cost.
  delivery: rate({ bp: 1000, flat_cs: 0, label: 'delivery', basis: 'the order value' }),
});

/**
 * The walk-in fee, in a sentence a merchant can read.
 *
 * NOT a RATES entry, and that is the point. Every key in RATES is a thing a
 * venue IS — a restaurant, a hotel, a spa — and `feeSentence()` derives the key
 * from the venue's own category. "Payment" is not a kind of venue, it is a fact
 * about one bill, so a `payment` row in RATES would be a category no place
 * could ever have. `scripts/invite_fee.test.mjs` asserts every RATES key
 * produces a quotable sentence, and it was right to reject this one.
 *
 * Computed from the constant for the same reason every other note is: a price
 * typed into merchant copy by hand drifts the day the number changes, silently,
 * in an artefact nobody re-reads.
 */
export const PAYMENT_ONLY_SENTENCE =
  `${money(PAYMENT_ONLY_FLAT_CS)} per bill settled through Num by a guest we did not refer `
  + '— flat, never a percentage.';

/**
 * Per-country overrides on the table above.
 *
 * Empty since 26 Aug 2026, and deliberately kept.
 *
 * It used to hold one entry: TH at 10% of the bill, because Thai venues were
 * the only ones on Num's bill QR and therefore the only ones whose bill Num
 * could see. That is now the rule everywhere — 10% when the value is
 * reported, $2 when it is not — so the override says nothing the base line
 * does not.
 *
 * The warning it carried is worth keeping, because it is the trap this
 * mechanism sets. Before today, giving a country a `bp` did not add 10% — it
 * REMOVED the flat fee, because rate_bp took precedence unconditionally and
 * every reservation in that country was written `awaiting_value`. A venue on
 * the QR paid 10% of a real number; a venue that never scanned it paid
 * NOTHING, forever, and the ledger looked healthy the whole time. `accrue`
 * below no longer works that way: the flat fee is a floor, not an
 * alternative. Keep it that way if you add an entry here.
 */
const COUNTRY_RATES = Object.freeze({});

/** ISO country for a booking, from the place if we have it. */
function countryOf(place = {}) {
  const c = place?.country;
  return typeof c === 'string' && c.length === 2 ? c.toUpperCase() : null;
}

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

/**
 * Is this a bar or a restaurant — somewhere with a bill and a server?
 *
 * The $2 floor, tips and priority seating are all scoped to these, on Dre's
 * call (26 Aug 2026), and the scoping is right: $2 per confirmed table is a
 * per-cover fee, and a per-cover fee means nothing at a venue with no covers.
 *
 * An UNRECOGNISED category counts as food and drink, deliberately. That is
 * what `reservation` has always meant — it is the fallback for a messy
 * crawled category string, and the overwhelming majority of those rows are
 * restaurants. Excluding them would leave a whole class of venue on a
 * percentage of a bill nobody reports, which is a fee of zero.
 */
export function foodAndDrink(place = {}) {
  return categoryFor(place) === 'reservation';
}

/**
 * The rate that WILL apply to a place, before any merchant-specific terms.
 *
 * Pure — no database, no await. It exists as its own function for one reason:
 * the merchant invite has to quote the same number the ledger will later
 * charge. Until 25 Aug 2026 the invite hardcoded "10% only when a booking
 * actually happens" while `stay` billed 15%, so every hotel we invited was
 * told a rate a third below the one it would be invoiced. A second copy of a
 * price is a promise waiting to be broken; there is now one copy and both the
 * invite and `accrue` read it.
 *
 * A country override REPLACES the base line rather than merging into it.
 * Merging would leave the base `flat_cs` sitting underneath a new `bp`, and
 * since rate_bp wins at billing time, the flat fee would become dead config
 * that reads as if it still applies. Replacing keeps the row honest.
 *
 * @param {object} place       needs at minimum { category, country }
 * @param {string|null} categoryIn  an explicit RATES key from a caller that
 *   already knows what it is selling. An UNKNOWN explicit category yields no
 *   rate at all rather than falling back to `reservation` — that fallback
 *   exists to under-bill an unrecognised restaurant $2, and $2 is a silently
 *   wrong answer for a $4,000 holiday.
 */
export function rateFor(place = {}, categoryIn = null) {
  const category = categoryIn ?? categoryFor(place);
  const base = RATES[category] ?? (categoryIn ? {} : RATES.reservation);
  return { category, rate: COUNTRY_RATES[countryOf(place)]?.[category] ?? base };
}

/**
 * What this place will actually be charged, in a sentence a merchant can read.
 *
 * This is the ONLY place an outbound fee promise should come from. Write the
 * number into an email template by hand and it drifts the day a rate changes,
 * silently, in an artefact nobody re-reads.
 */
export function feeSentence(place = {}) {
  const { rate } = rateFor(place);
  // Both numbers, always, for a rate that carries both. A venue quoted only
  // "10% of the bill" and then invoiced $2 has been told one price and charged
  // another, which is the exact failure this function exists to prevent — and
  // quoting only "$2" would understate what a venue on a POS will actually
  // pay. `note` is the rate's OWN words, so it stays right when the numbers
  // move.
  if (rate.bp && rate.flat_cs) {
    return `${rate.note}. Only on bookings NUM completes.`;
  }
  if (rate.bp) return `${rate.note}, charged only when the booking completes.`;
  // Flat fees bill on confirmation, not completion — see `accrue`. Saying
  // "completes" here would promise a later trigger than the ledger uses.
  if (rate.flat_cs > 0) return `${rate.note} — nothing at all if nothing books.`;
  return 'No fee.';
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
// Added 18 Aug with travel referrals. `invoiced_at` said we had ASKED for the
// money; nothing said it had ARRIVED, so "what is still owed" was a question
// this table could not answer — which is fine while the counterparty is a
// restaurant paying $2 and untenable when it is an agency paying 10% of a
// holiday. Separate from SCHEMA for the reason bookdesk.mjs:96 states: CREATE
// TABLE IF NOT EXISTS will not add a column to a table that already exists.
const MIGRATIONS = [
  'ALTER TABLE num_commissions ADD COLUMN paid_at TEXT',
  'ALTER TABLE num_commissions ADD COLUMN paid_cs INTEGER',
  // Added 22 Aug with weekly statements. Without it "which lines are on which
  // invoice" is unanswerable, and the same dinner gets invoiced twice the
  // following Monday — the fastest way to lose a merchant is to bill them for
  // something they have already paid.
  'ALTER TABLE num_commissions ADD COLUMN invoice_id TEXT',
  // Added 26 Aug with the 10%/$2 split. A row that lapsed to the flat fee has
  // to say so, or "why is this $2 when my rate is 10%" has no answer and the
  // merchant is right to distrust the rest of the invoice.
  'ALTER TABLE num_commissions ADD COLUMN lapsed_at TEXT',
];

/**
 * Per-venue walk-in fee, so a promise already made can be kept.
 *
 * The invite email every existing venue received says, in these words:
 *
 *   "You pay 10% only when a booking actually happens."
 *
 * A guest who was already in the building and paid by QR is not a booking. So
 * the walk-in fee introduced on 12 Sep 2026 cannot be charged to a venue that
 * was invited on that sentence without Num having quoted one price and billed
 * another — which is the failure this whole file is written against.
 *
 * Dre's call the same day: honour it. The six businesses signed up as of
 * 12 Sep 2026 keep free walk-ins for good; new venues are invited on copy that
 * states the fee before they sign.
 *
 * Held as DATA rather than a date check in code, because a cutoff computed at
 * runtime silently re-prices a grandfathered venue the moment somebody edits
 * the constant, and because a venue asking "why me and not them" deserves an
 * answer that can be read out of a row. NULL means the default applies; 0 means
 * this venue was promised free walk-ins.
 */
const WALKIN_MIGRATIONS = [
  'ALTER TABLE num_business_settings ADD COLUMN walkin_fee_cs INTEGER',
];
let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  // One at a time, each failure swallowed: "duplicate column name" is the
  // expected result on every run after the first.
  for (const m of MIGRATIONS) await env.DB.prepare(m).run().catch(() => {});
  for (const m of WALKIN_MIGRATIONS) await env.DB.prepare(m).run().catch(() => {});
  ready = true;
}
/** Test hook — a fresh in-memory database per suite needs the schema again. */
export const _resetSchemaCache = () => { ready = false; };

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
      // f_bill_value is the whole question: does anything this venue uses tell
      // NUM what the guest actually spent? A bill QR, a connected POS, a
      // merchant who reports totals. When it is 0 there is no number to take
      // a percentage of, and the flat fee is the honest charge.
      `SELECT commission_bp, booking_fee_cs, delivery_fee_cs,
              COALESCE(f_bill_value, 0) AS f_bill_value
         FROM num_business_settings WHERE business_id = ?1`,
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
  category: categoryIn = null, rateBp = null,
} = {}) {
  if (!env?.DB || !bookingId) return null;
  try {
    await ensure(env);
    // An explicit category is a caller that already knows what it is selling —
    // a travel referral is priced by a signed partner agreement, not by the
    // venue-category table. It must NOT fall through to `reservation`: that
    // fallback exists to UNDER-bill an unrecognised restaurant $2, and $2 is a
    // silently wrong answer for a $4,000 holiday. So an unknown explicit
    // category yields no default rate at all, and the caller's rateBp is the
    // only thing that can produce a line.
    const { category, rate } = rateFor(place, categoryIn);
    const terms = await termsFor(env, place.business_id ?? null);

    // Merchant terms win where they exist — and an explicitly passed rate wins
    // over both, because it came from the agreement this booking was made
    // under and is already recorded on the referral row.
    const flat_cs = terms?.booking_fee_cs ?? rate.flat_cs ?? null;
    const rate_bp = rateBp ?? terms?.commission_bp ?? rate.bp ?? null;

    // Can anything this venue uses tell us what the guest spent?
    //
    // Three ways yes: the caller already handed us the amount; the venue is
    // flagged as reporting bill values; or the caller passed an explicit
    // rateBp, which only happens for a signed agreement that prices a known
    // sum. Anything else is a venue with no seating or billing system yet, and
    // for them a percentage is a percentage of nothing.
    const haveValue = Number.isFinite(valueCents) && valueCents > 0;
    const canSeeValue = haveValue || terms?.f_bill_value === 1 || rateBp != null;

    // Only a category whose OWN rate carries a flat line has anywhere to fall
    // back to. Today that is `reservation` alone, and the distinction is
    // load-bearing: an activity, a stay and an appointment are SALES, made and
    // paid through the channel, so their value is knowable by definition and
    // `awaiting_value` is the right place for them to wait. Gating those on
    // `canSeeValue` would drop a $4,000 holiday to a $2 table fee.
    //
    // Read off the rate card, not off the merchant's settings: every row in
    // num_business_settings carries booking_fee_cs = 200 by default, so a dive
    // shop that happens to have a settings row would otherwise sprout a floor
    // it was never sold.
    // …and only for a bar or a restaurant. $2 per confirmed table is a
    // per-cover fee, and a per-cover fee means nothing at a venue with no
    // covers. Scoped on Dre's call, 26 Aug 2026.
    const hasFloor = (rate.flat_cs ?? 0) > 0 && foodAndDrink(place);

    let kind, amount_cs, state, note;
    if (rate_bp && (canSeeValue || !hasFloor)) {
      if (haveValue) {
        kind = 'percent';
        amount_cs = Math.round((valueCents * rate_bp) / 10000);
        state = 'accrued';
        note = `${pct(rate_bp)} of ${(valueCents / 100).toFixed(2)}`;
      } else {
        // The honest state. We know a booking happened; we do not know what it
        // was worth, and a percentage of an unknown number is a guess. This
        // row is a claim to be completed, not an invoice.
        //
        // It is only reachable for a venue that DOES report values, so the
        // number is expected rather than hoped for. If it never turns up,
        // lapseAwaitingValue() below drops the row to the flat fee rather than
        // leaving it worth nothing for ever.
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
    // `rate_bp` and `category` are part of the RETURN, not just the row,
    // because the settle email picks its sentence from them. It used to say
    // "NUM's 10%" to everyone, including the two venues on 15%.
    return { id, category, kind, rate_bp: rate_bp ?? null, amount_cs, state, note };
  } catch (e) {
    console.warn('[commission]', e?.message ?? e);
    return null;
  }
}

/**
 * Record the flat fee on a bill Num did not earn.
 *
 * A SEPARATE FUNCTION, ON PURPOSE. The obvious implementation was to call
 * accrue() with `category: 'payment'`, and it would have been wrong in a way
 * nobody would have noticed until a merchant complained: accrue() resolves its
 * rate as `rateBp ?? terms?.commission_bp ?? rate.bp`, and every venue we have
 * carries `commission_bp = 1000`. So the merchant-terms override would have
 * reached straight past a flat-only rate card and billed 10% of the bill on
 * exactly the path that is supposed to be flat.
 *
 * There is no percentage anywhere in this function, so no override can
 * resurrect one. That is the whole reason it is not a parameter.
 *
 * IDEMPOTENT ON THE BILL TOKEN. `num_commissions.booking_id` is NOT NULL with a
 * unique index, so a walk-in borrows it as `bill:<token>`: unique because the
 * token is, and it keeps the guard the table already enforces rather than
 * inventing a second one. Nothing joins this column to num_bookings — `owed`
 * and `invoiceVenue` select by business_id — so these lines invoice exactly
 * like any other.
 *
 * Never throws. A guest's payment must not fail because our ledger did.
 *
 * @returns {Promise<object|null>} the accrual, or null if nothing was owed.
 */
export async function accrueBillPayment(env, {
  token, businessId = null, placeId = null, venueName = null,
  valueCents = null, currency = 'usd', source = 'billqr',
} = {}) {
  if (!env?.DB || !token) return null;
  try {
    await ensure(env);

    // A venue promised free walk-ins keeps them. See WALKIN_MIGRATIONS: NULL is
    // "charge the default", 0 is "we told this venue it would be free".
    const own = businessId
      ? await env.DB
        .prepare('SELECT walkin_fee_cs FROM num_business_settings WHERE business_id = ?1')
        .bind(String(businessId)).first().catch(() => null)
      : null;
    const amount_cs = Number.isFinite(own?.walkin_fee_cs)
      ? own.walkin_fee_cs
      : PAYMENT_ONLY_FLAT_CS;
    // An agreed zero is valid and must leave NO row. A $0 line on a statement
    // reads as a charge a venue has to query before believing it is nothing.
    if (!(amount_cs > 0)) return null;
    const id = `cm_bill_${token}`;
    const basis = Number.isFinite(valueCents) && valueCents > 0 ? valueCents : null;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO num_commissions
         (id, booking_id, business_id, place_id, venue_name, category, kind,
          rate_bp, flat_cs, basis_cs, amount_cs, currency, state, source, note)
       VALUES (?1,?2,?3,?4,?5,'payment','flat',NULL,?6,?7,?8,?9,'accrued',?10,?11)`,
    ).bind(
      id, `bill:${token}`, businessId, placeId, venueName,
      amount_cs, basis, amount_cs, currency, source,
      // Says WHY it is flat, because this is the line a venue queries. A
      // merchant on a 10% rate seeing $2 deserves the reason in the row, not
      // in a support reply.
      `flat ${(amount_cs / 100).toFixed(2)} — bill paid through Num, guest not referred by Num`,
    ).run();
    // rate_bp is null and stated so. A flat line that reported a rate would
    // let outbound copy quote a percentage on a bill that has none.
    return { id, category: 'payment', kind: 'flat', rate_bp: null, amount_cs, state: 'accrued' };
  } catch (e) {
    console.warn('[commission]', e?.message ?? e);
    return null;
  }
}

/**
 * Drop stale `awaiting_value` rows to the flat fee.
 *
 * A percentage line sits at `awaiting_value` until somebody reports what the
 * guest spent. Usually somebody does. Sometimes the POS is disconnected, the
 * bill QR goes unscanned for a month, or the venue simply stops reporting —
 * and the row then sits at NULL for ever, invoiced never, while the ledger
 * shows a healthy count of accruals worth nothing.
 *
 * That was the real cost of the old Thailand override, and it is the failure
 * mode of any percentage on a number you cannot compel. So after `days` the
 * claim converts to the flat fee: the venue took a real booking and owes the
 * floor for it, which is the same $2 a venue with no system pays.
 *
 * Conservative on purpose:
 *   - never touches a row already invoiced or paid
 *   - never raises a charge, only ever writes the flat floor
 *   - says so in `note` and stamps `lapsed_at`, so a merchant asking "why is
 *     this $2 when my rate is 10%" gets an answer instead of a shrug
 *
 * @returns {Promise<{lapsed:number}|null>}
 */
export async function lapseAwaitingValue(env, { days = 30, flatCs = null } = {}) {
  if (!env?.DB) return null;
  try {
    await ensure(env);
    const floor = Number.isFinite(flatCs) && flatCs > 0
      ? flatCs
      : (RATES.reservation.flat_cs ?? 0);
    if (floor <= 0) return { lapsed: 0 };

    const r = await env.DB.prepare(
      `UPDATE num_commissions
          SET kind      = 'flat',
              amount_cs = ?1,
              state     = 'accrued',
              lapsed_at = datetime('now'),
              note      = 'no bill value reported within ' || ?2 ||
                          ' days — flat floor applied'
        WHERE state = 'awaiting_value'
          AND invoiced_at IS NULL
          AND paid_at IS NULL
          AND created_at < datetime('now', '-' || ?2 || ' days')`,
    ).bind(floor, days).run().catch(async () => (
      // paid_at only exists after the MIGRATIONS above have run against this
      // database. An older one still deserves the sweep.
      env.DB.prepare(
        `UPDATE num_commissions
            SET kind='flat', amount_cs=?1, state='accrued',
                note='no bill value reported — flat floor applied'
          WHERE state='awaiting_value' AND invoiced_at IS NULL
            AND created_at < datetime('now', '-' || ?2 || ' days')`,
      ).bind(floor, days).run()
    ));

    return { lapsed: r?.meta?.changes ?? 0 };
  } catch (e) {
    console.warn('[commission.lapse]', e?.message ?? e);
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
    return {
      id: row.id,
      amount_cs: amount,
      category: row.category ?? null,
      kind: 'percent',
      rate_bp: row.rate_bp ?? null,
    };
  } catch (e) {
    console.warn('[commission settle]', e?.message ?? e);
    return null;
  }
}

/**
 * Record that money actually arrived against a line.
 *
 * IDEMPOTENT AND MONOTONIC, on purpose. An operator reconciling a monthly
 * remittance runs this twice, and a partner sometimes pays in two parts. So the
 * amount passed REPLACES the recorded figure rather than adding to it — running
 * it again with the same number changes nothing, and running it with a larger
 * number is the second instalment. Addition would double the receipt on the
 * second run and nobody would notice until the year end.
 *
 * A payment of zero clears the mark rather than recording a payment of nothing,
 * which is how a mistaken entry is undone without a database console.
 */
export async function markPaid(env, bookingId, paidCents) {
  if (!env?.DB || !bookingId || !Number.isFinite(paidCents) || paidCents < 0) return null;
  try {
    await ensure(env);
    const res = await env.DB.prepare(
      `UPDATE num_commissions
          SET paid_cs = ?2, paid_at = CASE WHEN ?2 > 0 THEN datetime('now') ELSE NULL END
        WHERE booking_id = ?1`,
    ).bind(String(bookingId), Math.round(paidCents)).run();
    return { booking_id: String(bookingId), paid_cs: Math.round(paidCents), changed: (res?.meta?.changes ?? 0) > 0 };
  } catch (e) {
    console.warn('[commission paid]', e?.message ?? e);
    return null;
  }
}

/**
 * Every line that is owed and has not arrived — the collections list.
 *
 * `awaiting_value` rows are INCLUDED and carry a null amount. They are the ones
 * most likely to be forgotten, because there is no number next to them, and a
 * list that hides the awkward rows is a list that agrees with you.
 */
export async function unpaid(env, { source = null, since = null } = {}) {
  if (!env?.DB) return [];
  try {
    await ensure(env);
    const { results = [] } = await env.DB.prepare(
      `SELECT id, booking_id, business_id, venue_name, member_id, category, kind, rate_bp,
              amount_cs, paid_cs, currency, state, source, created_at, note
         FROM num_commissions
        WHERE (paid_cs IS NULL OR paid_cs < COALESCE(amount_cs, 0))
          AND (?1 IS NULL OR source = ?1)
          AND (?2 IS NULL OR created_at >= ?2)
        ORDER BY created_at DESC LIMIT 500`,
    ).bind(source, since).all();
    return results;
  } catch (e) {
    console.warn('[commission unpaid]', e?.message ?? e);
    return [];
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
