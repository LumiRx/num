/**
 * billqr.mjs — the per-bill payment code, and the only reason a percentage
 * commission on a restaurant is collectable at all.
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────
 * A table QR in `num_paylinks` defaults to `amount_mode = 'open'`. On an open
 * code the guest is handed the venue's own PromptPay QR and types the figure
 * into their own banking app. Num records a scan. **Num never learns the
 * amount.** The pay page says so in as many words: "The amount is on your bill
 * — you'll confirm it on the venue's payment page."
 *
 * So "put the venue on our QR so we can see the bill" does not work with a
 * per-TABLE code. It needs a per-BILL code:
 *
 *   1. guest asks for the bill
 *   2. staff taps the table in Num and types 2,400
 *   3. Num mints a ONE-TIME, FIXED-AMOUNT paylink for exactly that figure
 *   4. guest scans and pays the venue on the venue's own rails
 *   5. Num generated the figure, so Num has it → settleValue() → invoice
 *
 * ── WHAT THIS IS STILL NOT ──────────────────────────────────────────────
 * Not a payment processor. Num does not hold, route, touch or deduct from the
 * money — the guest pays the venue directly and Num invoices separately. That
 * is not a limitation to be engineered away later: collecting the payment and
 * remitting the remainder would make Num a payment facilitator, which in
 * Thailand needs an E-Payment Licence, THB 10m paid-up capital, a resident
 * Thai director and (5arz being foreign-owned) a Foreign Business Licence.
 * The same "money never rests with us" rule sizes the California seller-of-
 * travel surety bond at zero. Keep it.
 *
 * ── WHY A VENUE CANNOT QUIETLY UNDER-REPORT ─────────────────────────────
 * The figure on the code is the figure the guest pays. Showing 800 to a table
 * that owes 2,400 means asking your own customer to pay the wrong amount, and
 * that guest is a Num member whose booking and check-in scan are both logged.
 * That is what makes this stronger than a self-report box in a dashboard.
 */

import { settleValue, accrue } from './commission.mjs';
import { quote } from '../growth/crypto.mjs';

/** Unambiguous when read aloud or typed off a printed slip: no 0/O, no 1/I/L. */
const ALPHABET = '23456789ACDEFGHJKMNPQRTUVWXY';

function token(n = 10) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let out = '';
  for (const x of b) out += ALPHABET[x % ALPHABET.length];
  return out;
}

/**
 * Parse a staff-entered bill into minor units.
 *
 * Deliberately strict. A mistyped amount is not a rounding error — it is the
 * number a guest is about to be asked to pay and the number Num will invoice
 * a percentage of. Silently coercing "2,4OO" into something is worse than
 * refusing it.
 */
export function parseAmount(input, { max = 10_000_000 } = {}) {
  if (input == null) return { ok: false, reason: 'no amount' };
  const raw = String(input).trim().replace(/[, ]/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(raw)) return { ok: false, reason: 'not a plain amount' };
  const minor = Math.round(Number(raw) * 100);
  if (!Number.isFinite(minor) || minor <= 0) return { ok: false, reason: 'must be more than zero' };
  if (minor > max) return { ok: false, reason: 'above the per-bill ceiling' };
  return { ok: true, minor, display: (minor / 100).toFixed(2) };
}

/**
 * Mint a one-time bill code.
 *
 * `target` is the venue's OWN payment identity — a PromptPay id or their own
 * payment URL — copied from an existing active paylink for that business. It
 * is never taken from the caller: a bill code that could be pointed anywhere
 * is the exact attack the paylink design already refuses (targets are
 * immutable; re-pointing means retiring and re-issuing, both key-gated).
 */
export async function mintBillCode(env, {
  businessId, bookingId = null, amount, currency = 'THB', label = null,
  resourceId = null, issuedBy = null,
} = {}) {
  if (!env?.DB || !businessId) return { ok: false, reason: 'missing business' };

  const amt = parseAmount(amount);
  if (!amt.ok) return { ok: false, reason: amt.reason };

  // A table must belong to the venue that is billing for it. Without this a
  // caller holding one venue's session could mint a bill against another
  // venue's table and the money would follow the wrong sticker.
  if (resourceId) {
    const own = await env.DB.prepare(
      'SELECT id FROM num_resources WHERE id = ?1 AND business_id = ?2',
    ).bind(resourceId, businessId).first().catch(() => null);
    if (!own) return { ok: false, reason: 'that table does not belong to this venue' };
  }

  // Inherit the venue's own payment target from a live code they already have.
  // No source code, no bill code — we will not invent a destination for money.
  //
  // Prefer the sticker on THIS table. A venue with two payment identities — the
  // beach bar and the restaurant on separate PromptPay ids — must not have a
  // beach-bar bill land in the restaurant's account, which is exactly what
  // "newest active code" would do.
  const src = await env.DB.prepare(
    `SELECT kind, target, promptpay_kind, crypto_asset, currency FROM num_paylinks
      WHERE business_id = ?1 AND state = 'active' AND COALESCE(one_time,0) = 0
      ORDER BY (resource_id IS NOT NULL AND resource_id = ?2) DESC, created_at DESC
      LIMIT 1`,
  ).bind(businessId, resourceId).first().catch(() => null);
  if (!src?.target) {
    return { ok: false, reason: 'this venue has no active payment code to inherit from' };
  }

  // A crypto bill is quoted in the token at mint time and the figure is
  // stamped on the code. Quoting at render time would mean the amount moved
  // between the guest opening the page and paying it, on a rail where the
  // wrong amount cannot be corrected afterwards.
  let cq = null;
  if (src.kind === 'crypto') {
    cq = quote(env, src.crypto_asset || 'usdc-base', amt.minor, src.currency || currency);
    if (!cq.ok) return { ok: false, reason: cq.reason };
  }

  const t = token();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO num_paylinks
       (token, business_id, label, kind, target, promptpay_kind, crypto_asset,
        amount_mode, amount, currency, state, created_at, booking_id, one_time,
        resource_id, issued_by, crypto_base_units, crypto_quote)
     VALUES (?1,?2,?3,?4,?5,?6,?7,'fixed',?8,?9,'active',?10,?11,1,?12,?13,?14,?15)`,
  ).bind(
    t, businessId, label ?? (bookingId ? `Bill · ${bookingId}` : 'Bill'),
    src.kind, src.target, src.promptpay_kind ?? null, src.crypto_asset ?? null,
    amt.display, src.currency || currency, now, bookingId,
    resourceId, issuedBy,
    cq ? cq.base_units : null,
    cq ? JSON.stringify({ asset: cq.asset, chain: cq.chain, display: cq.display,
                          rate: cq.rate, rate_source: cq.rate_source, at: cq.quoted_at }) : null,
  ).run();

  return {
    ok: true,
    token: t,
    amount_minor: amt.minor,
    amount: amt.display,
    currency: src.currency || currency,
    resource_id: resourceId,
    crypto: cq || null,
    url: `${env.SITE || 'https://itsnum.com'}/p/${t}`,
  };
}

/**
 * Mark a bill code settled and push its value into the commission ledger.
 *
 * Idempotent on purpose. A guest can scan the same code twice, a network can
 * retry, and a venue can tap "paid" more than once — none of which may bill
 * the merchant twice. `settled_at` is the guard: the UPDATE only matches a row
 * that has not settled, and the ledger is only touched when that UPDATE
 * actually changed something.
 */
export async function settleBillCode(env, tokenValue, { settledBy = null } = {}) {
  if (!env?.DB || !tokenValue) return { ok: false, reason: 'missing token' };

  const row = await env.DB.prepare(
    `SELECT token, business_id, booking_id, amount, currency, amount_mode, state, settled_at
       FROM num_paylinks WHERE token = ?1`,
  ).bind(tokenValue).first().catch(() => null);

  if (!row) return { ok: false, reason: 'unknown code' };
  if (row.state !== 'active') return { ok: false, reason: 'code is not active' };
  if (row.amount_mode !== 'fixed') {
    // An open code carries no amount. Settling one would push `null` into the
    // ledger and read as a zero-value bill.
    return { ok: false, reason: 'not a bill code — no amount to report' };
  }
  if (row.settled_at) return { ok: true, already: true, booking_id: row.booking_id };

  const now = new Date().toISOString();
  const flip = await env.DB.prepare(
    `UPDATE num_paylinks SET settled_at = ?2, settled_by = ?3
      WHERE token = ?1 AND settled_at IS NULL`,
  ).bind(tokenValue, now, settledBy).run();
  if (!flip?.meta?.changes) return { ok: true, already: true, booking_id: row.booking_id };

  // No booking means a walk-in paying through the venue's code. Founder
  // decision: NUM-referred walk-ins are never charged, so there is nothing to
  // bill — but the settle still stands so the code cannot be reused.
  if (!row.booking_id) return { ok: true, settled: true, billed: false, reason: 'no booking — walk-ins are free' };

  const amt = parseAmount(row.amount);
  if (!amt.ok) return { ok: true, settled: true, billed: false, reason: 'stored amount unreadable' };

  let out = await settleValue(env, row.booking_id, amt.minor).catch(() => null);

  // settleValue only fills a line that is already waiting for a value. If the
  // upstream accrual never happened — the booking was confirmed before the
  // ledger was wired, or that write was lost — the money silently vanishes:
  // a real guest NUM sent, a real bill they paid, and nothing owed. So create
  // the line here instead. accrue() is idempotent on booking_id, so this
  // cannot double-charge a booking that did accrue normally.
  if (!out) {
    const biz = await env.DB.prepare(
      `SELECT b.id, b.name, p.country
         FROM businesses b
         LEFT JOIN num_business_profiles p ON p.business_id = b.id
        WHERE b.id = ?1`,
    ).bind(row.business_id).first().catch(() => null);

    out = await accrue(env, {
      bookingId: row.booking_id,
      place: { business_id: row.business_id, country: biz?.country ?? null },
      venueName: biz?.name ?? null,
      valueCents: amt.minor,
      currency: (row.currency || 'THB').toLowerCase(),
      category: 'reservation',
      source: 'billqr',
    }).catch(() => null);
  }

  return { ok: true, settled: true, billed: !!out, booking_id: row.booking_id, commission: out };
}
