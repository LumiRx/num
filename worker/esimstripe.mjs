// Stripe for eSIMs: a hosted Checkout page per order, and refunds.
//
// Why Checkout (Stripe's own page) and not a card form in our app:
//   - Apple Pay and Google Pay appear there with no domain registration,
//     because the page is on Stripe's domain;
//   - card numbers never touch Num's servers;
//   - it works the same from a text message, a web page or the app.
//
// Num is the SELLER of the eSIM (unlike flights, where the partner sells and
// Num never touches the money). This is Num's own product sold at Num's own
// price: the money that lands is revenue, not somebody else's funds held in
// transit. Stripe's restricted-business list does not include eSIMs or data.
//
// Speaks to Stripe through pay.mjs's one client (stripeCall), per the rule in
// that file: two Stripe clients means two opinions about timeouts and errors.

async function call(env, path, body, idem, deps = {}) {
  if (!env?.STRIPE_SECRET_KEY) return { ok: false, error: 'STRIPE_SECRET_KEY is not set' };
  const stripeCall = deps.stripeCall ?? (await import('./pay.mjs')).stripeCall;
  try {
    return { ok: true, data: await stripeCall(env, path, body, idem) };
  } catch (e) {
    return { ok: false, status: e?.status ?? 0, error: String(e?.message ?? e) };
  }
}

export const CHECKOUT_TTL_S = 2 * 3600; // Stripe allows 30 min to 24 h

export function checkoutParams(order, { origin, cancelUrl, now = Date.now() }) {
  const installUrl = `${origin}/esim/o/${order.token}`;
  return {
    mode: 'payment',
    // Instant methods only. Card includes Apple Pay and Google Pay (Stripe
    // renders both from 'card' on its hosted page). Left to the Dashboard,
    // Checkout may also offer a bank debit, which completes as "unpaid" and
    // settles days later; pay.mjs ignores unpaid sessions, so that money would
    // land against an order that had already expired. An eSIM is delivered
    // in seconds, so only a payment that is final in seconds is offered.
    payment_method_types: ['card'],
    client_reference_id: order.id,
    success_url: `${installUrl}?paid=1`,
    cancel_url: cancelUrl || `${origin}/esim${order.country ? `/${order.country.toLowerCase()}` : ''}`,
    expires_at: Math.floor(now / 1000) + CHECKOUT_TTL_S,
    submit_type: 'pay',
    locale: 'auto',
    customer_email: order.email || undefined,
    phone_number_collection: { enabled: order.phone ? 'false' : 'true' },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: order.price_cs,
          product_data: {
            name: `Num eSIM · ${order.dest_label} · ${order.plan_label}`,
            description: 'Data-only eSIM for a phone that supports eSIM and is carrier-unlocked. Your install link appears the moment you pay.',
          },
        },
      },
    ],
    metadata: { num_esim: order.id, kind: 'esim' },
    payment_intent_data: {
      metadata: { num_esim: order.id, kind: 'esim' },
      statement_descriptor_suffix: 'ESIM',
    },
  };
}

export async function createCheckout(env, order, { origin, cancelUrl, attempt = 0, now = Date.now(), ...deps } = {}) {
  const r = await call(env, '/checkout/sessions', checkoutParams(order, { origin, cancelUrl, now }), `esim_cs_${order.id}_${attempt}`, deps);
  if (!r.ok) return r;
  return { ok: true, id: r.data.id, url: r.data.url };
}

/** Full refund of an eSIM payment. Idempotent per order. */
export async function refundOrder(env, order, deps = {}) {
  if (!order?.stripe_pi) return { ok: false, error: 'no payment intent on order' };
  const r = await call(env, '/refunds', { payment_intent: order.stripe_pi, reason: 'requested_by_customer', metadata: { num_esim: order.id } }, `esim_refund_${order.id}`, deps);
  return r.ok ? { ok: true, id: r.data.id, status: r.data.status } : r;
}

/** Refund one payment intent in full, under an idempotency key of the caller's choosing. */
export async function refundPayment(env, paymentIntent, orderId, { reason = 'requested_by_customer', key, ...deps } = {}) {
  const r = await call(env, '/refunds', { payment_intent: paymentIntent, reason, metadata: { num_esim: orderId } }, key || `esim_pi_refund_${paymentIntent}`, deps);
  return r.ok ? { ok: true, id: r.data.id } : r;
}

/** Refund a second payment made for an order that was already paid. */
export function refundDuplicate(env, paymentIntent, orderId, deps = {}) {
  return refundPayment(env, paymentIntent, orderId, { reason: 'duplicate', key: `esim_dup_${paymentIntent}`, ...deps });
}

/**
 * Does this completed Checkout Session pay exactly this order?
 * The amount is checked against the server's price, never taken from Stripe
 * as the truth about what the order should have cost.
 */
export function sessionPays(session, order) {
  if (!session || !order) return { ok: false, reason: 'missing' };
  if (session.metadata?.num_esim !== order.id && session.client_reference_id !== order.id) return { ok: false, reason: 'wrong_order' };
  if (session.payment_status !== 'paid') return { ok: false, reason: `payment_status_${session.payment_status}` };
  if (String(session.currency).toLowerCase() !== 'usd') return { ok: false, reason: 'currency' };
  if (Number(session.amount_total) !== Number(order.price_cs)) return { ok: false, reason: `amount_${session.amount_total}_expected_${order.price_cs}` };
  return { ok: true };
}
