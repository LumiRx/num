// Taking money for a flight.
//
// ── THE ORDER IS THE WHOLE DESIGN ────────────────────────────────────────
//
//   AUTHORIZE  →  ISSUE THE TICKET  →  CAPTURE
//
// Not charge-then-issue. A fare can fail to ticket after the money is taken —
// the seat goes while the traveller is typing, the fare rules reject the
// passenger, the GDS times out. If Num has already captured, the traveller is
// $515 down, holding no ticket, waiting five to ten working days for a refund
// they have to ask for. That is the single worst thing this product could do
// to somebody, and it is entirely avoidable: Stripe's manual capture puts a
// HOLD on the card, and a hold that is cancelled disappears without any money
// ever having moved.
//
// So `capture()` cannot be called without the issued reference. Not by
// convention — the function will not run without it. The failure it prevents
// is the one where somebody is under pressure, the ticket has not issued yet,
// and capturing "just to be safe" looks like the careful option.
//
// ── AND THE ORDER MATTERS THE OTHER WAY TOO ──────────────────────────────
//
// Authorising costs nothing and can be undone. Issuing costs a real ticket.
// So the hold goes first: if the card declines, nobody has spent an airline's
// inventory, and the traveller finds out before their seat is gone.
//
// ── WHAT NUM BECOMES BY DOING THIS ───────────────────────────────────────
//
// Charging the traveller directly makes Num the MERCHANT OF RECORD on the
// transaction. That is a real change of posture, not a payment detail:
//
//   · Chargebacks land on Num, not on a partner. A disputed $515 flight is
//     $515 plus Stripe's dispute fee, and travel has one of the highest
//     dispute rates of any category.
//   · The §8 posture ("money never rests with us") that affiliate.mjs and
//     commission.mjs are both written around no longer holds for this flow.
//     It still holds everywhere else; this is the one exception and it should
//     stay the one exception.
//   · Seller-of-travel registration (California §17550 et seq., and the
//     Florida and Washington equivalents) applies to whoever takes the money
//     for air transport. That is a filing, not a code change.
//
// None of that is a reason not to do it. It is a reason for it to be written
// down here rather than discovered in a dispute.

import { stripeCall } from './pay.mjs';

/* ── READINESS ───────────────────────────────────────────────────────────
   Derived, never a flag. This codebase has now been bitten twice by a
   configured-but-not-working credential — a Twilio SID with the wrong prefix
   and a Resend key authorised for no domain — and both times the check that
   would have caught it was "is the secret set". */

export const stripeReady = (env) => !!env?.STRIPE_SECRET_KEY;

export const liveMode = (env) => String(env?.STRIPE_SECRET_KEY || '').startsWith('sk_live_');

/**
 * Apple Pay needs the domain REGISTERED with Stripe, separately from any key.
 * An unregistered domain does not error — the Apple Pay button simply never
 * appears, on the one platform where most travel booking happens. So this
 * asks Stripe, rather than trusting a variable.
 *
 * @returns {Promise<{ok:boolean, domains?:string[], why?:string}>}
 */
export async function applePayReady(env, domain) {
  if (!stripeReady(env)) return { ok: false, why: 'STRIPE_SECRET_KEY is not set' };
  const want = String(domain || env?.SITE_DOMAIN || 'app.itsnum.com').replace(/^https?:\/\//, '');
  try {
    const res = await fetch('https://api.stripe.com/v1/payment_method_domains', {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, why: body?.error?.message ?? `Stripe ${res.status}` };
    const domains = (body.data ?? []).filter((d) => d.enabled).map((d) => d.domain_name);
    return domains.includes(want)
      ? { ok: true, domains }
      : {
        ok: false,
        domains,
        why: `${want} is not a registered Apple Pay domain. Register it — Stripe Dashboard → Settings → `
          + 'Payment methods → Apple Pay → Add domain, or POST /v1/payment_method_domains. Until then the '
          + 'Apple Pay button silently does not render and nobody reports a bug, they just do not pay.',
      };
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e) };
  }
}

/* ── IDEMPOTENCY ─────────────────────────────────────────────────────────
   Derived from the booking, not from a random value, because the retry that
   matters is the one where the first attempt's response was lost. A random
   key on the retry produces a SECOND authorisation for the same trip — two
   holds on a card for one flight. */
export const authKey = (bookingRef) => `flightauth_${bookingRef}`;
export const captureKey = (bookingRef) => `flightcap_${bookingRef}`;

/* ── STATE ───────────────────────────────────────────────────────────────
   Mirrors Stripe's own PaymentIntent statuses rather than inventing parallel
   names, so a support conversation with Stripe and a row in our ledger use
   the same word for the same thing. */
export const PAY = Object.freeze({
  NONE: 'none',
  AUTHORIZING: 'authorizing',
  AUTHORIZED: 'requires_capture', // Stripe's own name for a live hold
  CAPTURED: 'succeeded',
  VOIDED: 'canceled',
  REFUNDED: 'refunded',
  FAILED: 'failed',
});

/** What the traveller is actually charged, itemised so it can be shown. */
export function amountFor(offer) {
  const fare = Number(offer?.fare_cs ?? 0);
  const tax = Number(offer?.tax_cs ?? 0);
  const fee = Number(offer?.fee_cs ?? 0);
  const total = fare + tax + fee;
  return {
    fare_cs: fare,
    tax_cs: tax,
    fee_cs: fee,
    total_cs: total,
    currency: String(offer?.currency ?? 'USD').toLowerCase(),
    // Stated separately because the fee is Num's and the rest is not. A
    // traveller disputing a charge is owed a breakdown, and so is Num's own
    // reconciliation.
    ours_cs: fee,
    passthrough_cs: fare + tax,
  };
}

/**
 * Zero-decimal currencies. JPY 515 is ¥515, not ¥5.15, and sending 51500
 * charges somebody a hundred times the fare. Stripe's list, short form.
 */
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
export const toStripeAmount = (cs, currency) =>
  (ZERO_DECIMAL.has(String(currency).toLowerCase()) ? Math.round(Number(cs) / 100) : Math.round(Number(cs)));

/**
 * STEP 1 — put a hold on the card.
 *
 * `capture_method: manual` is the entire point of this function. Everything
 * else here is bookkeeping.
 *
 * `automatic_payment_methods` turns on whatever the traveller's device can
 * actually use — Apple Pay and Google Pay included — without Num enumerating
 * card brands. On a phone, in a travel app, that is most of the conversion.
 *
 * @returns {Promise<{ok:boolean, intentId?:string, clientSecret?:string, ...}>}
 */
export async function authorize(env, booking, { ref, memberId = null } = {}) {
  if (!stripeReady(env)) return { ok: false, error: 'stripe_not_configured', message: 'Stripe is not connected.' };
  if (!ref) return { ok: false, error: 'no_ref', message: 'A booking reference is required before money is touched.' };

  const a = amountFor(booking?.offer);
  if (!(a.total_cs > 0)) return { ok: false, error: 'zero_amount', message: 'Refusing to authorise a zero or negative amount.' };

  const o = booking?.offer ?? {};
  try {
    const pi = await stripeCall(env, '/payment_intents', {
      amount: toStripeAmount(a.total_cs, a.currency),
      currency: a.currency,
      // THE LINE THIS FILE EXISTS FOR.
      capture_method: 'manual',
      automatic_payment_methods: { enabled: true },
      description: `Num flight ${o.origin}-${o.dest} ${o.depart_date}`,
      // What a traveller sees on their statement. 22 characters, and it must
      // say Num — an unrecognised descriptor is the most common reason a
      // legitimate charge is disputed.
      statement_descriptor_suffix: 'FLIGHT',
      metadata: {
        // The key the webhook handler in pay.mjs looks for. Without it a
        // refunded or disputed flight resolves to "unknown payment" and the
        // ledger row stays `succeeded` forever while the money is clawed
        // back. It must match recordPayment's id exactly.
        num_payment_id: `pay_${ref}`,
        num_booking_ref: ref,
        route: `${o.origin}-${o.dest}`,
        depart: o.depart_date ?? '',
        passengers: String(booking?.passengers?.length ?? 1),
        member_id: memberId ?? '',
        fare_cs: String(a.fare_cs),
        tax_cs: String(a.tax_cs),
        num_fee_cs: String(a.fee_cs),
      },
      ...(booking?.contact?.email ? { receipt_email: booking.contact.email } : {}),
    }, authKey(ref));

    return {
      ok: true,
      intentId: pi.id,
      clientSecret: pi.client_secret,
      status: pi.status,
      amount: a,
      live: liveMode(env),
    };
  } catch (e) {
    return { ok: false, error: 'authorize_failed', message: String(e?.message ?? e) };
  }
}

/**
 * STEP 3 — take the money, once a ticket exists.
 *
 * `issuedReference` is required and checked. There is no code path here that
 * captures without one, because "capture first, sort the ticket out after" is
 * exactly the shortcut somebody reaches for when a booking is going wrong,
 * and it is the shortcut that leaves a traveller out of pocket.
 */
export async function capture(env, { intentId, issuedReference, amountCs = null, currency = 'usd' }) {
  if (!stripeReady(env)) return { ok: false, error: 'stripe_not_configured' };
  if (!intentId) return { ok: false, error: 'no_intent' };
  if (!issuedReference) {
    return {
      ok: false,
      error: 'not_issued',
      message: 'Refusing to capture: no ticket has been issued. Authorise, issue, then capture — '
        + 'capturing first means a traveller who paid for a flight that does not exist.',
    };
  }
  try {
    const pi = await stripeCall(
      env,
      `/payment_intents/${encodeURIComponent(intentId)}/capture`,
      // Capturing less than authorised is allowed and sometimes right (a fare
      // that repriced down). Capturing MORE is not possible, which is another
      // reason the hold goes on the full amount first.
      amountCs == null ? {} : { amount_to_capture: toStripeAmount(amountCs, currency) },
      captureKey(issuedReference),
    );
    return { ok: pi.status === 'succeeded', status: pi.status, intentId: pi.id, captured_cs: pi.amount_received };
  } catch (e) {
    return { ok: false, error: 'capture_failed', message: String(e?.message ?? e) };
  }
}

/**
 * The unhappy path, and the reason the hold exists.
 *
 * Issuing failed. Cancel the authorisation and no money ever moved. The
 * traveller sees a pending amount disappear rather than a refund arrive next
 * week, which is a completely different conversation to have with somebody.
 */
export async function voidAuth(env, intentId, reason = 'abandoned') {
  if (!stripeReady(env)) return { ok: false, error: 'stripe_not_configured' };
  if (!intentId) return { ok: false, error: 'no_intent' };
  const allowed = new Set(['duplicate', 'fraudulent', 'requested_by_customer', 'abandoned']);
  try {
    const pi = await stripeCall(env, `/payment_intents/${encodeURIComponent(intentId)}/cancel`, {
      cancellation_reason: allowed.has(reason) ? reason : 'abandoned',
    });
    return { ok: pi.status === 'canceled', status: pi.status };
  } catch (e) {
    return { ok: false, error: 'void_failed', message: String(e?.message ?? e) };
  }
}

/** After capture, the only way back is a refund. Slower, and visible to them. */
export async function refund(env, { intentId, amountCs = null, currency = 'usd', reason = 'requested_by_customer' }) {
  if (!stripeReady(env)) return { ok: false, error: 'stripe_not_configured' };
  try {
    const r = await stripeCall(env, '/refunds', {
      payment_intent: intentId,
      ...(amountCs == null ? {} : { amount: toStripeAmount(amountCs, currency) }),
      reason: ['duplicate', 'fraudulent', 'requested_by_customer'].includes(reason) ? reason : 'requested_by_customer',
    });
    return { ok: r.status === 'succeeded' || r.status === 'pending', status: r.status, refundId: r.id };
  } catch (e) {
    return { ok: false, error: 'refund_failed', message: String(e?.message ?? e) };
  }
}

/* ── THE WHOLE TRANSACTION, IN ONE PLACE ─────────────────────────────────
   Callers get this rather than the three steps, so the order cannot be got
   wrong by a caller in a hurry. The three are still exported because a
   support tool legitimately needs to capture or void on its own. */

/**
 * Authorise, issue, capture — and unwind cleanly at every point it can fail.
 *
 * @param {Function} issueFn  async () => ({ok, reference, ...}) — injected so
 *                            this file never imports an issuer and the whole
 *                            sequence is testable without either service.
 */
export async function purchase(env, booking, { ref, memberId = null, issueFn }) {
  const auth = await authorize(env, booking, { ref, memberId });
  if (!auth.ok) return { ok: false, stage: 'authorize', ...auth };

  // The hold is live from here. Every exit below must either capture it or
  // cancel it — an authorisation left hanging holds a traveller's money for
  // up to seven days and then expires silently.
  let issued;
  try {
    issued = await issueFn();
  } catch (e) {
    await voidAuth(env, auth.intentId, 'abandoned');
    return { ok: false, stage: 'issue', error: 'issue_threw', message: String(e?.message ?? e), voided: true };
  }

  if (!issued?.ok || !issued?.reference) {
    const v = await voidAuth(env, auth.intentId, 'abandoned');
    return {
      ok: false,
      stage: 'issue',
      error: issued?.error ?? 'issue_failed',
      message: issued?.message ?? 'The ticket could not be issued, so the hold on the card was cancelled. No money moved.',
      voided: v.ok,
      intentId: auth.intentId,
    };
  }

  const cap = await capture(env, {
    intentId: auth.intentId,
    issuedReference: issued.reference,
    currency: auth.amount.currency,
  });

  if (!cap.ok) {
    // The ticket EXISTS and the money did not arrive. Never void here — that
    // would give away a ticket. This is a human's problem and it must be
    // loud.
    console.error(`[flightpay] TICKET ISSUED, CAPTURE FAILED — ref ${ref}, pnr ${issued.reference}, intent ${auth.intentId}`);
    return {
      ok: false,
      stage: 'capture',
      needsHuman: true,
      issued,
      intentId: auth.intentId,
      message: 'The ticket issued but the payment did not complete. Do not cancel the hold — that gives away a ticket.',
    };
  }

  return { ok: true, issued, intentId: auth.intentId, captured_cs: cap.captured_cs, amount: auth.amount };
}

/* ── THE LEDGER ──────────────────────────────────────────────────────────
   num_payments already exists and already has the right columns. What it has
   never had is a row that reached `paid`. */

export async function recordPayment(env, { ref, memberId, amount, intentId, state, description }) {
  if (!env?.DB) return { ok: false };
  try {
    await env.DB.prepare(
      `INSERT INTO num_payments (id, member_id, mode, ref, amount_cents, currency, description, session_id, state, paid_at)
       VALUES (?1,?2,'stripe-flight',?3,?4,?5,?6,?7,?8,?9)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, paid_at = excluded.paid_at`,
    ).bind(
      `pay_${ref}`,
      memberId ?? null,
      ref,
      amount?.total_cs ?? null,
      amount?.currency ?? 'usd',
      description ?? null,
      intentId ?? null,
      state,
      state === PAY.CAPTURED ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null,
    ).run();
    return { ok: true };
  } catch (e) {
    console.warn('[flightpay] ledger write failed', e?.message ?? e);
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/* ── WHAT THE CONCIERGE IS TOLD ──────────────────────────────────────── */
export function payBlock(booking, env) {
  const a = amountFor(booking?.offer);
  if (!(a.total_cs > 0)) return '';
  const cur = a.currency.toUpperCase();
  const m = (cs) => `${cur === 'USD' ? '$' : `${cur} `}${(cs / 100).toFixed(2)}`;
  return (
    '\n\nTAKING THE PAYMENT. Read the total back before anything happens, itemised, out loud:\n'
    + `  fare ${m(a.fare_cs)} · taxes ${m(a.tax_cs)}`
    + (a.fee_cs ? ` · Num booking fee ${m(a.fee_cs)}` : '')
    + ` · TOTAL ${m(a.total_cs)}\n`
    + (a.fee_cs
      ? `The ${m(a.fee_cs)} is ours and you say so — it is how Num gets paid for doing this. Never fold it into the fare.\n`
      : '')
    + 'They pay with Apple Pay, Google Pay or a card, in the app. Num holds the amount first and only takes it once '
    + 'the ticket is actually issued — say that, because it is the reassuring truth and most people assume the '
    + 'opposite. If the ticket cannot be issued the hold is released and nothing is taken.\n'
    + 'NOTHING HAPPENS UNTIL THEY TAP PAY. Never say paid, charged or booked until the confirmation comes back.'
  );
}
