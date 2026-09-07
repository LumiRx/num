/**
 * A COURIER FOR A BUSINESS THAT HAS NO DRIVER.
 *
 * ── The gap this closes (7 Sep 2026) ──────────────────────────────────────
 *
 * Delivery has been all-or-nothing for a partner: either you employ somebody
 * to drive, or you cannot take a delivery order at all. That excludes almost
 * every small business we sign — a café, a florist, a shop with two people
 * behind the counter. They have the goods and the guest; what they lack is a
 * van.
 *
 * DoorDash Drive is a courier between two addresses, and Num already holds the
 * account. So the business ticks a box, and a courier turns up.
 *
 * ── WHO PAYS, decided 7 Sep ───────────────────────────────────────────────
 *
 * NUM PAYS DOORDASH AND ADDS THE FEE TO THE GUEST'S ORDER.
 *
 * The business never opens a DoorDash account, never handles a courier
 * invoice, and never fronts a penny — because the alternative ("connect your
 * own Drive credentials") is a developer task, and asking a florist to do a
 * developer task is the polite way of saying no.
 *
 * Two consequences we take on deliberately:
 *   · NUM CARRIES THE FLOAT, and the loss when an order is cancelled after a
 *     courier is already moving. That is a real cost and it is the price of
 *     the business having no setup to do.
 *   · NUM TAKES NO COMMISSION ON THE COURIER FEE. It is a cost passed through
 *     at what it cost, exactly like the partner's own delivery fee, which
 *     commission has never touched either. Marking up a courier would make the
 *     honest option the expensive one, and the business would go back to
 *     turning delivery orders away.
 *
 * ── THE CANNABIS RULE IS CODE, NOT A FOOTNOTE ─────────────────────────────
 *
 * DoorDash couriers do not carry cannabis. Not "prefer not to" — their terms
 * forbid it, in every market, whatever the local law says, and LA Cannabis
 * Club is one of our live delivery partners.
 *
 * If that rule lived only in a help page, the failure mode is a licensed
 * dispensary dispatching a courier who refuses the pickup, with a paid order
 * sitting on the counter and a guest waiting. So `eligible()` refuses a
 * regulated business before a quote is ever requested, and says why. Their own
 * driver is the only lawful route and the console tells them so.
 */
import { driveReady, quote as driveQuote, accept as driveAccept, status as driveStatus } from './doordash.mjs';

/** Trades a third-party courier will not carry, whatever the local law says. */
export const COURIER_REFUSES = Object.freeze(['cannabis']);

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/**
 * May this business dispatch a courier for this order?
 *
 * Returns a REASON on refusal, always — a greyed-out button with no
 * explanation is how a partner decides the feature is broken.
 */
export function eligible({ env = {}, business = {}, order = {} } = {}) {
  if (!driveReady(env)) {
    return { ok: false, why: 'Courier delivery isn’t switched on yet. Your own driver still works as normal.' };
  }
  if (COURIER_REFUSES.includes(String(business.regulated ?? '').toLowerCase())) {
    return {
      ok: false,
      regulated: true,
      why: 'Third-party couriers won’t carry cannabis anywhere, whatever the local law allows — so this order has to go out with your own driver. Everything else about the order works the same.',
    };
  }
  if (!business.address) return { ok: false, why: 'Add your pickup address in your profile and a courier can collect from you.' };
  if (!business.phone) return { ok: false, why: 'Add a phone number the courier can call if they can’t find you.' };
  if (!order.address) return { ok: false, why: 'This order has no delivery address.' };
  // A courier is dispatched against an order the business has COMMITTED to.
  // Quoting one for an order still sitting unaccepted invites a dispatch for
  // something nobody has agreed to make.
  if (!['accepted', 'preparing'].includes(String(order.status))) {
    return { ok: false, why: 'Accept the order first — then a courier can be sent for it.' };
  }
  return { ok: true };
}

/** The Drive payload for an order. Pure, so the mapping is testable on its own. */
export function driveRequest({ business, order, reference }) {
  return {
    external_delivery_id: String(reference),
    pickup_address: business.address,
    pickup_business_name: clip(business.name, 60),
    pickup_phone_number: business.phone,
    pickup_instructions: clip(`Num order ${order.short_code}. Collect from the counter.`, 200),
    dropoff_address: order.address,
    dropoff_phone_number: order.phone ?? business.phone,
    dropoff_instructions: clip(order.note, 200) ?? undefined,
    // What the courier is carrying, in money, so Drive prices the risk
    // correctly. The GOODS only — never the courier fee itself, which would
    // be charging insurance on the delivery of the delivery.
    order_value: Number(order.subtotal_cs) || 0,
  };
}

/**
 * What would a courier cost for this order?
 *
 * A quote is free and commits nobody, which is why the console asks for one
 * before showing a button: a partner deciding whether to send a courier should
 * see the actual number, not a promise to reveal it after they commit.
 */
export async function quoteFor(env, { business, order }) {
  const gate = eligible({ env, business, order });
  if (!gate.ok) return gate;
  const reference = `num_${order.id}`;
  let q;
  try {
    q = await driveQuote(env, driveRequest({ business, order, reference }));
  } catch (e) {
    return { ok: false, why: 'The courier service didn’t answer just now. Try again in a moment, or send your own driver.', detail: clip(e?.message, 140) };
  }
  if (q?._error || !Number.isFinite(Number(q?.fee))) {
    // The vendor's own words are for our logs, never for the partner's screen.
    console.warn('[courier] quote refused', q?._error ?? q?._status ?? 'no fee');
    return { ok: false, why: 'No courier is available for that address right now.' };
  }
  return {
    ok: true,
    quote_id: q.id ?? q.external_delivery_id ?? reference,
    fee_cs: Math.round(Number(q.fee)),
    currency: q.currency ?? 'USD',
    pickup_eta: q.pickup_time_estimated ?? null,
    dropoff_eta: q.dropoff_time_estimated ?? null,
    // Said in the console next to the number, so nobody has to work out
    // whether we are taking a cut of it.
    note: 'Num pays the courier and adds this to the guest’s total. No commission is taken on it.',
  };
}

/**
 * Accept the quote — the point a courier is actually dispatched and the point
 * Num becomes liable for the fee.
 *
 * The caller records the fee against the order; this function's only job is
 * the dispatch and reporting what happened, so a failure here can never leave
 * a fee on an order with no courier behind it.
 */
export async function dispatch(env, { business, order, quoteId }) {
  const gate = eligible({ env, business, order });
  if (!gate.ok) return gate;
  if (!quoteId) return { ok: false, why: 'Get a quote first — a courier is only ever sent against a price you have seen.' };
  try {
    const d = await driveAccept(env, quoteId);
    if (d?._error) {
      console.warn('[courier] dispatch refused', d._error, d._status);
      return { ok: false, why: 'The courier service turned that down. Nothing was charged and no courier is coming.' };
    }
    return {
      ok: true,
      delivery_id: d?.id ?? quoteId,
      tracking_url: d?.tracking_url ?? null,
      fee_cs: Number.isFinite(Number(d?.fee)) ? Math.round(Number(d.fee)) : null,
      pickup_eta: d?.pickup_time_estimated ?? null,
    };
  } catch (e) {
    return { ok: false, why: 'The courier service didn’t answer. No courier is coming — send your own driver or try again.', detail: clip(e?.message, 140) };
  }
}

/** Where is the courier? Best-effort; a tracking failure never breaks a page. */
export async function track(env, deliveryId) {
  if (!deliveryId || !driveReady(env)) return null;
  try {
    const d = await driveStatus(env, deliveryId);
    return d?._error ? null : { state: d?.delivery_status ?? null, tracking_url: d?.tracking_url ?? null, courier: d?.dasher_name ?? null };
  } catch { return null; }
}

/**
 * What the guest's total becomes once a courier is on it.
 *
 * Separated out and pure because it is the money, and money that is computed
 * inline in a handler is money nobody can test. Commission is unchanged: it is
 * charged on GOODS, never on either delivery fee.
 */
export function totalWithCourier({ subtotal_cs = 0, delivery_fee_cs = 0, courier_fee_cs = 0 }) {
  const sub = Math.max(0, Math.round(Number(subtotal_cs) || 0));
  const own = Math.max(0, Math.round(Number(delivery_fee_cs) || 0));
  const cour = Math.max(0, Math.round(Number(courier_fee_cs) || 0));
  return {
    subtotal_cs: sub,
    // The business's own delivery fee is REPLACED, not stacked. A guest
    // charged the shop's £3 and the courier's £7 for one journey has been
    // charged twice for the same thing, and would be right to say so.
    delivery_fee_cs: cour > 0 ? cour : own,
    courier_fee_cs: cour,
    total_cs: sub + (cour > 0 ? cour : own),
    commissionable_cs: sub,
  };
}
