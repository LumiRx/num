/**
 * square — the first till NUM can read.
 *
 * Chosen first because it is the only one of the three US leaders a developer
 * can reach without a partner agreement: Square's OAuth and Orders API are
 * self-serve, Toast requires an application and a certification process, and
 * Clover's Dining app keeps its table map in a private schema. Square is also
 * where Dre's first pilot venue is.
 *
 * ── TWO THINGS A VENUE MUST BE TOLD BEFORE SWITCHING THIS ON ─────────────
 *
 * 1. SQUARE CHARGES THEM 1%. An Orders API order paid by an external payment
 *    costs the seller 1% of the order. That is Square's fee, not NUM's, and a
 *    venue discovering it on a statement is a venue that turns NUM off. It is
 *    surfaced as `SELLER_NOTE` and printed in the console beside the switch.
 *
 * 2. SQUARE HAS NO TABLE. There is no table field on an Order — only
 *    `ticket_name`, free text a member of staff typed. So NUM shows the
 *    ticket name the till reports and a human matches it. This module NEVER
 *    guesses which check belongs to which table: matching the wrong check
 *    means charging a guest for somebody else's dinner, which is worse than
 *    typing a figure by hand.
 *
 * ── WHY autocomplete:false THEN PayOrder ─────────────────────────────────
 *
 * Square's own guidance: create the external payment with `autocomplete` off
 * so it lands APPROVED, then `PayOrder` with that payment id, which is what
 * actually moves the order to COMPLETED. Calling CreatePayment alone leaves
 * the money recorded and the check still open — the exact half-finished state
 * this integration exists to prevent.
 */

const PROD = 'https://connect.squareup.com';
const SANDBOX = 'https://connect.squareupsandbox.com';
/** Pinned, not floating. An API version that moves on its own is a Saturday outage. */
export const SQUARE_VERSION = '2026-09-16';

export const label = 'Square';
export const SELLER_NOTE = 'Square charges you 1% of any order paid outside Square. That is Square’s fee, not NUM’s.';

export const ready = (env) => !!(env?.SQUARE_APP_ID && env?.SQUARE_APP_SECRET);
export const needs = (env) => [
  !env?.SQUARE_APP_ID && 'SQUARE_APP_ID (Square Developer Console → application ID)',
  !env?.SQUARE_APP_SECRET && 'SQUARE_APP_SECRET',
].filter(Boolean);

const base = (env) => (env?.SQUARE_SANDBOX === '1' ? SANDBOX : PROD);

/** The scopes NUM asks for, and nothing beyond them. */
export const SCOPES = Object.freeze(['ORDERS_READ', 'ORDERS_WRITE', 'PAYMENTS_WRITE', 'MERCHANT_PROFILE_READ']);

export function authorizeUrl(env, { state, origin }) {
  if (!ready(env)) return null;
  const q = new URLSearchParams({
    client_id: env.SQUARE_APP_ID,
    scope: SCOPES.join('+'),
    session: 'false',
    state: String(state),
    redirect_uri: `${origin}/biz/pos/callback`,
  });
  // Square wants scope separated by + and URLSearchParams escapes it to %2B.
  return `${base(env)}/oauth2/authorize?${q.toString().replace(/scope=([^&]*)/, (_, v) => `scope=${v.replace(/%2B/g, '+')}`)}`;
}

async function call(env, path, { method = 'POST', body = null, token = null, idem = null } = {}) {
  const res = await fetch(`${base(env)}${path}`, {
    method,
    headers: {
      'Square-Version': SQUARE_VERSION,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idem ? { 'Idempotency-Key': String(idem).slice(0, 45) } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    const first = parsed?.errors?.[0];
    const err = new Error(first?.detail || first?.code || `Square ${res.status}`);
    err.status = res.status;
    err.code = first?.code ?? null;
    throw err;
  }
  return parsed;
}

export async function exchangeCode(env, { code, origin }) {
  const t = await call(env, '/oauth2/token', {
    body: {
      grant_type: 'authorization_code',
      client_id: env.SQUARE_APP_ID,
      client_secret: env.SQUARE_APP_SECRET,
      code,
      redirect_uri: `${origin}/biz/pos/callback`,
    },
  });
  return { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at ?? null, merchant_id: t.merchant_id ?? null };
}

export async function refresh(env, refreshToken) {
  const t = await call(env, '/oauth2/token', {
    body: {
      grant_type: 'refresh_token',
      client_id: env.SQUARE_APP_ID,
      client_secret: env.SQUARE_APP_SECRET,
      refresh_token: refreshToken,
    },
  });
  return { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at ?? null, merchant_id: t.merchant_id ?? null };
}

/** The seller's locations, so a venue picks which till NUM reads. */
export async function locations(env, conn) {
  const out = await call(env, '/v2/locations', { method: 'GET', token: conn.token });
  return (out.locations ?? []).map((l) => ({ id: l.id, name: l.name, currency: l.currency ?? null, status: l.status ?? null }));
}

/**
 * Open checks at this venue's location.
 *
 * `net_amount_due_money` is what NUM wants, not `total_money`: a check with a
 * deposit already on it owes less than its total, and billing a guest the
 * total would charge them twice for the deposit. Falls back to the total only
 * when Square sends no due figure.
 */
export async function openChecks(env, conn) {
  if (!conn.location_id) {
    const e = new Error('no Square location is chosen yet');
    e.status = 400;
    throw e;
  }
  const out = await call(env, '/v2/orders/search', {
    token: conn.token,
    body: {
      location_ids: [conn.location_id],
      query: { filter: { state_filter: { states: ['OPEN'] } }, sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' } },
      limit: 100,
      return_entries: false,
    },
  });
  return (out.orders ?? []).map((o) => {
    const due = o.net_amount_due_money ?? o.total_money ?? {};
    return {
      vendor: 'square',
      ref: o.id,
      // Whatever staff typed. NUM shows it; NUM does not interpret it.
      name: o.ticket_name || o.reference_id || null,
      amount_minor: Number(due.amount ?? 0),
      currency: String(due.currency ?? 'USD').toUpperCase(),
      opened_at: o.created_at ?? null,
      version: o.version ?? null,
    };
  }).filter((c) => c.amount_minor > 0);
}

/**
 * Record that the guest paid through NUM, and close the check.
 *
 * `source_fee_money` carries NUM's application fee, so the venue's own Square
 * reporting shows what it netted rather than a gross figure it has to work
 * out later.
 *
 * The idempotency key is the NUM bill token, not a random value: this is
 * called from a webhook Stripe retries, and a second delivery must not create
 * a second payment on the merchant's account.
 */
export async function recordExternalPayment(env, conn, { orderId, amountMinor, currency = 'USD', reference, feeMinor = null } = {}) {
  if (!orderId) {
    const e = new Error('no Square order to close');
    e.status = 400;
    throw e;
  }
  const money = { amount: Math.round(Number(amountMinor) || 0), currency: String(currency).toUpperCase() };
  if (!(money.amount > 0)) {
    const e = new Error('a check cannot be closed for nothing');
    e.status = 400;
    throw e;
  }
  const payment = await call(env, '/v2/payments', {
    token: conn.token,
    idem: `num-${reference}`,
    body: {
      source_id: 'EXTERNAL',
      idempotency_key: `num-${reference}`,
      amount_money: money,
      autocomplete: false,
      external_details: {
        type: 'OTHER',
        source: 'NUM',
        ...(feeMinor ? { source_fee_money: { amount: Math.round(feeMinor), currency: money.currency } } : {}),
      },
      order_id: orderId,
      location_id: conn.location_id,
    },
  });
  const paymentId = payment?.payment?.id;
  if (!paymentId) {
    const e = new Error('Square recorded no payment');
    e.status = 502;
    throw e;
  }
  // PayOrder is the half that actually closes it.
  const paid = await call(env, `/v2/orders/${encodeURIComponent(orderId)}/pay`, {
    token: conn.token,
    body: { idempotency_key: `num-pay-${reference}`, payment_ids: [paymentId] },
  });
  return { payment_id: paymentId, order_state: paid?.order?.state ?? null, closed: paid?.order?.state === 'COMPLETED' };
}
