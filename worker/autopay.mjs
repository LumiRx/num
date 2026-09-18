/**
 * autopay.mjs — "NUM just pays", with a ceiling the member set and a tap that
 * never goes away.
 *
 * ── WHY THIS IS NOT THE DEFAULT, AND NEVER WILL BE ───────────────────────
 *
 * A standing instruction to move somebody's money is the most dangerous thing
 * in this codebase. It is opt-in, it carries a cap the member chose, every
 * attempt is written down, and the one-tap path (BillSheet) stays exactly
 * where it was. If every line below failed at once, the worst outcome is a
 * guest tapping to pay — which is what they do today.
 *
 * ── THE ARCHITECTURAL PROBLEM, AND WHY IT IS SOLVED THIS WAY ─────────────
 *
 * NUM's bills are DIRECT charges on the venue's own Stripe account
 * (worker/billpay.mjs), because that is what keeps NUM out of the flow of
 * funds. But a card saved for a member is saved on NUM's PLATFORM customer.
 * A platform payment method cannot be charged on a connected account.
 *
 * The obvious fix — destination charges — is the one thing we refuse: it runs
 * the guest's money through NUM's balance and makes NUM the merchant of
 * record, which is precisely the posture billqr.mjs, money.mjs and
 * commission.mjs are all written around.
 *
 * Stripe's documented answer is CLONING. The platform PaymentMethod is cloned
 * onto the venue's connected account for one charge, and the clone is consumed
 * by that charge. So:
 *
 *   · the card is entered ONCE, on NUM, authenticated (3DS) at save time
 *   · nothing persistent is ever left on a venue's account
 *   · the charge is still a direct charge; the venue is still merchant of
 *     record; NUM still takes only an application fee
 *
 * ── THE LIMITATION, STATED RATHER THAN DISCOVERED ────────────────────────
 *
 * Stripe: "If your platform is in a different country than your connected
 * accounts, the setup performed on your platform might not be sufficient" —
 * a US-saved card may not carry the authentication a UK or Thai acquirer
 * wants, and the issuer can demand it on any merchant-initiated charge
 * regardless. When that happens the PaymentIntent comes back needing action
 * and THIS CODE DOES NOT RETRY. It reports `tap` and the guest pays the way
 * they always could. An auto-pay that silently retries is an auto-pay that
 * eventually charges the wrong thing twice.
 */

import { stripeCall } from './pay.mjs';

/** Nothing above this may ever be auto-paid, whatever a member types. */
export const HARD_CAP_MINOR = 50_000;
/** Attempts per member per day. A compromised session must not be able to drain a card. */
export const MAX_PER_DAY = 6;

export const autopayReady = (env) => !!env?.STRIPE_SECRET_KEY;

/**
 * The words a member agrees to. Stripe requires the mandate to state what is
 * being authorised, how often, and how the amount is decided — so it says all
 * three, in a sentence a person can actually read, and it is stored with the
 * row rather than living only in a screen somebody redesigns later.
 */
export function mandateText({ capMinor, currency }) {
  const cap = (Number(capMinor) / 100).toFixed(2);
  return [
    `I authorise NUM to pay restaurant and venue bills on my behalf using this card,`,
    `up to ${currency} ${cap} per bill, when I have opened that bill in NUM.`,
    `The amount is whatever the venue has put on the bill. Bills above the limit,`,
    `and anything my bank asks me to confirm, still need a tap. I can turn this off`,
    `in NUM at any time.`,
  ].join(' ');
}

export async function settingsFor(env, memberId) {
  if (!env?.DB || !memberId) return null;
  const row = await env.DB.prepare(
    `SELECT member_id, stripe_customer_id, payment_method_id, cap_minor, currency, state,
            mandate_at, last_used_at
       FROM num_member_autopay WHERE member_id = ?1`,
  ).bind(String(memberId)).first().catch(() => null);
  return row ?? null;
}

/**
 * Start the opt-in: a platform Customer and a SetupIntent whose client secret
 * the app confirms with the Payment Element. Confirming on the client is what
 * runs 3DS, and 3DS at save time is the whole reason a later off-session
 * charge has any chance of being exempted.
 */
export async function beginSetup(env, memberId) {
  if (!autopayReady(env)) return { ok: false, reason: 'payments are not configured' };
  const existing = await settingsFor(env, memberId);
  let customer = existing?.stripe_customer_id ?? null;
  try {
    if (!customer) {
      const c = await stripeCall(env, '/customers', { 'metadata[num_member_id]': String(memberId) }, `autopay-cust-${memberId}`);
      customer = c.id;
    }
    const si = await stripeCall(env, '/setup_intents', {
      customer,
      usage: 'off_session',
      'payment_method_types[0]': 'card',
      'metadata[num_member_id]': String(memberId),
    });
    await env.DB.prepare(
      `INSERT INTO num_member_autopay (member_id, stripe_customer_id, state)
       VALUES (?1, ?2, 'pending')
       ON CONFLICT(member_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id, updated_at = datetime('now')`,
    ).bind(String(memberId), customer).run();
    return { ok: true, client_secret: si.client_secret, customer };
  } catch (e) {
    console.warn('[autopay] setup', e?.message);
    return { ok: false, reason: 'could not start card setup just now' };
  }
}

/**
 * Turn it on. The cap is clamped here, on the server — a cap that only exists
 * in a form field is not a cap.
 */
export async function enable(env, memberId, { paymentMethodId, capMinor, currency = 'USD' } = {}) {
  if (!env?.DB || !memberId) return { ok: false, reason: 'missing member' };
  if (!paymentMethodId) return { ok: false, reason: 'no card was saved' };
  // Refuse a non-positive limit rather than flooring it. A member who typed 0
  // means "do not pay anything without asking me", and quietly turning that
  // into a one-cent ceiling would leave auto-pay ON for somebody who was
  // trying to switch it off.
  const asked = Math.round(Number(capMinor));
  if (!Number.isFinite(asked) || asked <= 0) return { ok: false, reason: 'set a limit above zero, or leave auto-pay off' };
  const cap = Math.min(asked, HARD_CAP_MINOR);
  const cur = String(currency).toUpperCase();
  const text = mandateText({ capMinor: cap, currency: cur });
  await env.DB.prepare(
    `INSERT INTO num_member_autopay (member_id, payment_method_id, cap_minor, currency, state, mandate_text, mandate_at, updated_at)
     VALUES (?1,?2,?3,?4,'on',?5,datetime('now'),datetime('now'))
     ON CONFLICT(member_id) DO UPDATE SET
       payment_method_id = excluded.payment_method_id, cap_minor = excluded.cap_minor,
       currency = excluded.currency, state = 'on', mandate_text = excluded.mandate_text,
       mandate_at = datetime('now'), updated_at = datetime('now')`,
  ).bind(String(memberId), String(paymentMethodId), cap, cur, text).run();
  return { ok: true, cap_minor: cap, currency: cur, mandate: text };
}

/** Off is immediate and needs no reason. */
export async function disable(env, memberId) {
  await env.DB.prepare(
    `UPDATE num_member_autopay SET state = 'off', updated_at = datetime('now') WHERE member_id = ?1`,
  ).bind(String(memberId)).run();
  return { ok: true };
}

async function todayCount(env, memberId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM num_autopay_attempts
      WHERE member_id = ?1 AND created_at > datetime('now','-1 day')`,
  ).bind(String(memberId)).first().catch(() => null);
  return Number(row?.n ?? 0);
}

/**
 * May this bill be paid without a tap?
 *
 * Every no is a specific no, because the app has to say which one it is: "over
 * your limit" and "your bank wants to check" are different sentences and a
 * guest deserves the right one.
 */
export async function eligible(env, memberId, bill) {
  const s = await settingsFor(env, memberId);
  if (!s || s.state !== 'on') return { ok: false, why: 'off' };
  if (!s.payment_method_id || !s.stripe_customer_id) return { ok: false, why: 'no_card' };
  if (!bill?.amount_minor) return { ok: false, why: 'no_amount' };
  if (String(bill.currency).toUpperCase() !== String(s.currency).toUpperCase()) {
    // A cap in dollars says nothing about a bill in baht. Rather than convert
    // — which would make NUM the one deciding an exchange rate — this asks for
    // a tap, which is the honest answer.
    return { ok: false, why: 'other_currency' };
  }
  if (bill.amount_minor > Number(s.cap_minor)) return { ok: false, why: 'over_cap', cap_minor: Number(s.cap_minor) };
  if (await todayCount(env, memberId) >= MAX_PER_DAY) return { ok: false, why: 'too_many_today' };
  return { ok: true, settings: s };
}

async function record(env, { memberId, bill, state, reason = null, intent = null }) {
  await env.DB.prepare(
    `INSERT INTO num_autopay_attempts (id, member_id, token, business_id, amount_minor, currency, state, reason, payment_intent_id)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
  ).bind(
    `ap_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`,
    String(memberId), bill.token, bill.business_id, bill.amount_minor,
    String(bill.currency).toUpperCase(), state, reason, intent,
  ).run().catch((e) => console.warn('[autopay] could not record the attempt', e?.message));
}

/**
 * Pay it.
 *
 * Two Stripe calls, both on the VENUE's account:
 *   1. clone the member's platform card onto that account, for this charge only
 *   2. create and confirm a PaymentIntent off-session, with NUM's fee
 *
 * The clone is consumed by the charge, so nothing of the member's is left
 * sitting on a venue's Stripe account afterwards. The idempotency key is the
 * bill token, so a double tap or a retried request pays once.
 *
 * Returns `{ ok }` on success, or `{ ok: false, tap: true }` — which the app
 * reads as "show them the buttons". It never retries and never escalates.
 */
export async function attemptAutoPay(env, { memberId, bill, venue, feeMinor = 0 } = {}) {
  const check = await eligible(env, memberId, bill);
  if (!check.ok) return { ok: false, tap: true, why: check.why, cap_minor: check.cap_minor };
  if (!venue?.stripe_account_id || !venue.stripe_charges_enabled) return { ok: false, tap: true, why: 'venue_not_connected' };

  const s = check.settings;
  const account = venue.stripe_account_id;
  let clone;
  try {
    clone = await stripeCall(env, '/payment_methods', {
      customer: s.stripe_customer_id,
      payment_method: s.payment_method_id,
    }, `autopay-clone-${bill.token}`, 'POST', { account });
  } catch (e) {
    await record(env, { memberId, bill, state: 'failed', reason: `clone: ${e?.message ?? 'refused'}` });
    return { ok: false, tap: true, why: 'card_unavailable' };
  }

  let pi;
  try {
    pi = await stripeCall(env, '/payment_intents', {
      amount: bill.amount_minor,
      currency: String(bill.currency).toLowerCase(),
      payment_method: clone.id,
      off_session: 'true',
      confirm: 'true',
      ...(feeMinor > 0 ? { application_fee_amount: feeMinor } : {}),
      'metadata[num_bill_token]': bill.token,
      'metadata[num_rail]': 'autopay',
      description: `${venue.name ?? 'Venue'} · NUM ${bill.token}`,
    }, `autopay-${bill.token}`, 'POST', { account });
  } catch (e) {
    // A 402 here is the ordinary case, not an outage: the issuer wants the
    // cardholder. Recorded, reported, and handed back to the tap.
    const why = /authentication|requires_action/i.test(e?.message ?? '') ? 'needs_authentication' : 'declined';
    await record(env, { memberId, bill, state: 'failed', reason: `${why}: ${e?.message ?? ''}`.slice(0, 200) });
    return { ok: false, tap: true, why, message: e?.message ?? null };
  }

  if (pi?.status !== 'succeeded') {
    await record(env, { memberId, bill, state: 'failed', reason: `status ${pi?.status}`, intent: pi?.id ?? null });
    return { ok: false, tap: true, why: pi?.status === 'requires_action' ? 'needs_authentication' : 'not_completed' };
  }

  await record(env, { memberId, bill, state: 'paid', intent: pi.id });
  await env.DB.prepare(
    `UPDATE num_member_autopay SET last_used_at = datetime('now') WHERE member_id = ?1`,
  ).bind(String(memberId)).run().catch(() => null);

  // NOT settled here. The Connect webhook is what writes the ledger, closes
  // the till and stamps the paylink — one settle path, whichever rail paid.
  return { ok: true, payment_intent: pi.id, amount_minor: bill.amount_minor, currency: bill.currency };
}

/* ── routes: /api/autopay/… ───────────────────────────────────────────────── */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function handleAutopay(request, env, path) {
  const url = new URL(request.url);
  const me = String(url.searchParams.get('me') ?? '').slice(0, 64);
  if (!me) return json({ error: 'who?' }, 401);

  if ((path === '/' || path === '') && request.method === 'GET') {
    const s = await settingsFor(env, me);
    return json({
      on: s?.state === 'on',
      cap_minor: s?.cap_minor ?? null,
      currency: s?.currency ?? null,
      has_card: !!s?.payment_method_id,
      hard_cap_minor: HARD_CAP_MINOR,
      max_per_day: MAX_PER_DAY,
      available: autopayReady(env),
    });
  }
  if (path === '/setup' && request.method === 'POST') {
    const out = await beginSetup(env, me);
    return json(out, out.ok ? 200 : 503);
  }
  if (path === '/enable' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const out = await enable(env, me, {
      paymentMethodId: b.payment_method_id,
      capMinor: b.cap_minor,
      currency: b.currency,
    });
    return json(out, out.ok ? 200 : 422);
  }
  if (path === '/disable' && request.method === 'POST') return json(await disable(env, me));
  return json({ error: 'not found' }, 404);
}
