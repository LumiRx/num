// Check the money BEFORE it moves — and when it's wrong, say what's right.
//
// The $1-for-★5,000 bug was not a missing `if`. It was a missing IDEA: every
// money route was validating its inputs privately, in its own style, with its
// own gaps, and `/api/pay/request` simply forgot one. This file is the idea —
// one place that answers "is this transaction correct?" for every money path,
// so a new route can't quietly ship without the check.
//
// ── The rule ─────────────────────────────────────────────────────────────
//
// A transaction is CORRECT when the amount is one WE derived from our own
// price list or our own ledger. A client may say WHICH thing it wants. It may
// never say what that thing costs or what it is owed.
//
// ── Why it suggests instead of only refusing ─────────────────────────────
//
// A bare "invalid" is useless to an honest client with a stale price list and
// equally useless to the user staring at a failed payment. Every refusal here
// carries `correction` — the transaction we WOULD accept — so the caller can
// show "that pack is $1,425, continue?" rather than a dead end. Refusing well
// is a feature; refusing silently is how the $1 bug survived review.

/** Star packs. The single source of price truth for anything Stars-related. */
export const STAR_PACKS = Object.freeze({ 500: 15000, 1000: 29500, 5000: 142500 });

/**
 * The currencies we accept, each with its own floor and ceiling.
 *
 * The bounds MUST be per-currency: `amount_cents` means hundredths of
 * whatever the currency is, so 2,000,000 is $20,000 in USD and about $570 in
 * THB satang. One shared ceiling calibrated for dollars would refuse a
 * perfectly normal ฿30,000 dinner for eight — and one shared floor would let
 * through charges Stripe itself rejects.
 *
 * More importantly: BEFORE this table existed, `currency` was passed from
 * the client straight to Stripe with no check at all. A tier priced as 898
 * (US cents, $8.98) charged with currency 'thb' becomes ฿8.98 — about 25
 * US cents. Same integer, 97% discount. The currency is part of the price
 * and gets exactly the same scrutiny as the number.
 */
export const CURRENCIES = Object.freeze({
  usd: { min: 50, max: 2_000_000, symbol: '$', name: 'US dollars' },       // Stripe's USD floor · $20k ceiling
  thb: { min: 2_000, max: 70_000_000, symbol: '฿', name: 'Thai baht' },    // ฿20 floor · ฿700k (~$20k) ceiling
});

const money = (cents, currency = 'usd') =>
  `${CURRENCIES[currency]?.symbol ?? '$'}${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The verdict shape every caller gets back.
 *   ok:true                        → proceed with `amount_cents`
 *   ok:false + correction          → refuse, but offer the corrected version
 *   ok:false + no correction       → refuse outright, `reason` says why
 */
const pass = (amountCents, note = null) => ({ ok: true, amount_cents: amountCents, note });
const fail = (reason, correction = null) => ({ ok: false, reason, correction });

/**
 * Check a payment before a Stripe session exists.
 *
 * `intent` is what the client asked for. Everything about the MONEY is
 * recomputed here from `ref`; `intent.amount_cents` is treated as a claim to
 * be checked, never as an input to trust.
 */
export function checkPayment(intent = {}) {
  const ref = String(intent.ref ?? '');
  const claimed = Number(intent.amount_cents);

  // The currency is checked FIRST, because every bound below depends on it.
  // Unknown currency is a refusal, not a default: silently falling back to
  // USD would re-open the exact confusion this exists to close.
  const currency = String(intent.currency ?? 'usd').toLowerCase();
  const cur = CURRENCIES[currency];
  if (!cur) {
    return fail(
      `We take ${Object.values(CURRENCIES).map((c) => c.name).join(' and ')} — not "${String(intent.currency)}".`,
      { currency: 'usd', says: 'Charge it in US dollars?' },
    );
  }

  // Anything priced from OUR list is priced in US cents. Accepting the same
  // integer under another currency is the 97%-discount hole — so our own
  // SKUs are pinned to USD no matter what the client sent.
  if ((/^(stars|tier):/).test(ref) && currency !== 'usd') {
    return fail(
      'Memberships and Stars are priced in US dollars.',
      { currency: 'usd', says: 'Continue in USD?' },
    );
  }

  // ── Stars: priced entirely by us ───────────────────────────────────────
  const pack = /^stars:(\d{1,7})$/.exec(ref);
  if (pack) {
    const n = Number(pack[1]);
    const priced = STAR_PACKS[n];
    if (!priced) {
      const options = Object.keys(STAR_PACKS).map(Number).sort((a, b) => a - b);
      // Suggest the nearest real pack rather than just saying no — someone
      // asking for ★9,999,999 has a broken client or bad intentions, but
      // someone asking for ★750 probably just wants the ★1,000 pack.
      // On a tie, offer the CHEAPER pack. Suggesting the bigger one when both
      // are equally close reads as an upsell at the moment someone is already
      // confused about a price, and being wrong in the customer's favour is
      // the right direction to be wrong in.
      const nearest = options.reduce(
        (best, o) => (Math.abs(o - n) < Math.abs(best - n) ? o : best),
        options[0],
      );
      return fail(
        `★${n.toLocaleString()} isn’t one of our packs.`,
        { ref: `stars:${nearest}`, amount_cents: STAR_PACKS[nearest], stars: nearest,
          says: `The closest pack is ★${nearest.toLocaleString()} for ${money(STAR_PACKS[nearest])}.` },
      );
    }
    if (Number.isFinite(claimed) && claimed !== priced) {
      // THE $1 BUG, caught by name. Not an error to log quietly — a
      // correction to hand back, so an honest stale client can retry right.
      return fail(
        `★${n.toLocaleString()} costs ${money(priced)}, not ${money(claimed)}.`,
        // `says` is what the app puts ON THE BUTTON, so it is an instruction,
        // not a repeat of the sentence above it.
        { ref, amount_cents: priced, stars: n, says: `Continue at ${money(priced)}?` },
      );
    }
    return pass(priced, `★${n.toLocaleString()} pack`);
  }

  // ── Everything else: a bill, a booking, a deposit ──────────────────────
  // These DO carry a real amount from the app, because the amount comes from
  // a venue's bill rather than our price list. They still get bounds and a
  // sanity check, because a typo'd zero is somebody's rent.
  if (!Number.isFinite(claimed) || claimed <= 0) {
    return fail('A payment needs a positive amount.');
  }
  const rounded = Math.round(claimed);
  if (rounded < cur.min) {
    return fail(
      `${money(rounded, currency)} is below the ${money(cur.min, currency)} minimum a card payment can take.`,
      { amount_cents: cur.min, says: `The smallest card payment is ${money(cur.min, currency)}.` },
    );
  }
  if (rounded > cur.max) {
    return fail(
      `${money(rounded, currency)} is over the ${money(cur.max, currency)} ceiling — that needs a human to approve.`,
      { amount_cents: cur.max, says: `Anything above ${money(cur.max, currency)} goes through us directly.` },
    );
  }
  return { ...pass(rounded), currency };
}

/**
 * Check a Stars movement before any balance changes.
 *
 * `available` is what the LEDGER says, computed by the caller from the
 * database — never sent by the client. When someone asks for more than they
 * have, the correction is the amount they could actually move, which is the
 * difference between "declined" and "you can send ★40 of that now".
 */
/**
 * Did a signed Stripe session pay the RIGHT money for a tier?
 *
 * Pure so it can be tested as behaviour rather than as source text — the
 * first guard on this was a regex over pay.mjs, and a `true ||` mutation
 * sailed straight past it. A signature proves money moved; this proves the
 * right money moved, and it is the only check standing between fifty cents
 * and a $28.98 membership.
 */
export function tierPaidRight(session, owedCents) {
  return Number.isFinite(owedCents)
    && Number(session?.amount_total) === owedCents
    && String(session?.currency ?? '').toLowerCase() === 'usd';
}

export function checkStars({ amount, available, label = 'move', max = 1_000_000 } = {}) {
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n <= 0) return fail(`How many Stars should I ${label}?`);
  if (n > max) {
    return fail(
      `★${n.toLocaleString()} is over the ★${max.toLocaleString()} limit for a single ${label}.`,
      { amount: max, says: `The most in one go is ★${max.toLocaleString()}.` },
    );
  }
  if (Number.isFinite(available) && n > available) {
    return available > 0
      ? fail(
          `You have ★${Number(available).toLocaleString()}, not ★${n.toLocaleString()}.`,
          { amount: Math.floor(available), says: `You can ${label} ★${Math.floor(available).toLocaleString()} right now.` },
        )
      : fail(`There’s nothing available to ${label} yet.`);
  }
  return { ok: true, amount: n };
}

/**
 * Turn any verdict into the JSON body a route returns on refusal. Keeping the
 * shape identical everywhere means the app can render one correction UI
 * instead of one per endpoint.
 */
export const refusal = (verdict) => ({
  ok: false,
  error: verdict.correction?.says ? `${verdict.reason} ${verdict.correction.says}` : verdict.reason,
  correction: verdict.correction ?? null,
});
