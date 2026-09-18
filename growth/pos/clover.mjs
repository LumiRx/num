/**
 * clover — the second till, and the one that proves the registry was worth it.
 *
 * Square and Clover agree about almost nothing. Square searches orders with a
 * POST and a filter object; Clover uses a GET and a query string. Square's
 * external payment is a first-class thing with its own source_id; Clover logs
 * an external tender against a merchant-configured tender id you have to look
 * up first. Square gives a net amount due; Clover gives a total and a list of
 * payments and leaves the subtraction to you. All of that is contained in this
 * file, and growth/pos/index.mjs never learns any of it.
 *
 * ── THE TENDER LOOKUP IS NOT OPTIONAL ────────────────────────────────────
 *
 * Clover will not accept a payment without a tender id, and the ids are per
 * merchant — there is no constant to hardcode. So the adapter reads the
 * merchant's own tender list and picks a non-card, non-cash one to log against
 * ("External Payment" if the merchant has it). If the merchant has nothing
 * suitable, the adapter says so rather than guessing: logging a NUM payment as
 * CASH would corrupt that venue's own cash-up at the end of the night, which
 * is worse than not closing the check.
 *
 * ── SAME LIMITATION AS SQUARE, FOR A DIFFERENT REASON ────────────────────
 *
 * Clover Dining keeps its table map in a private schema that the REST Orders
 * API does not expose, so an order fetched here carries no table. NUM shows
 * whatever the order's title says and a human matches it. Guessing would mean
 * charging a guest for somebody else's dinner.
 *
 * ── TOKENS EXPIRE, AND SO DO THE REFRESH TOKENS ──────────────────────────
 *
 * v2 OAuth returns access_token_expiration AND refresh_token_expiration, both
 * unix seconds. A refresh token that has itself expired cannot be refreshed
 * from — that venue has to reconnect, and index.mjs marks it needs_reauth
 * rather than retrying into a wall.
 */

const HOSTS = Object.freeze({
  sandbox: { auth: 'https://sandbox.dev.clover.com', api: 'https://apisandbox.dev.clover.com' },
  na: { auth: 'https://www.clover.com', api: 'https://api.clover.com' },
  eu: { auth: 'https://www.eu.clover.com', api: 'https://api.eu.clover.com' },
  la: { auth: 'https://www.la.clover.com', api: 'https://api.la.clover.com' },
});

export const label = 'Clover';
export const SELLER_NOTE = 'NUM logs the payment against an external tender on your Clover account, so your own cash-up is not affected.';

export const ready = (env) => !!(env?.CLOVER_APP_ID && env?.CLOVER_APP_SECRET);
export const needs = (env) => [
  !env?.CLOVER_APP_ID && 'CLOVER_APP_ID (Clover developer dashboard → your app)',
  !env?.CLOVER_APP_SECRET && 'CLOVER_APP_SECRET',
].filter(Boolean);

const region = (env) => HOSTS[String(env?.CLOVER_REGION || (env?.CLOVER_SANDBOX === '1' ? 'sandbox' : 'na'))] ?? HOSTS.na;

/**
 * Clover's authorize URL does NOT take a redirect_uri — the callback is set on
 * the app in Clover's dashboard. It comes back with `code` AND `merchant_id`,
 * which is where the merchant id comes from; there is no "who am I" call.
 */
export function authorizeUrl(env, { state } = {}) {
  if (!ready(env)) return null;
  const q = new URLSearchParams({ client_id: env.CLOVER_APP_ID, state: String(state) });
  return `${region(env).auth}/oauth/v2/authorize?${q}`;
}

async function call(env, path, { method = 'GET', body = null, token = null, base = null } = {}) {
  const res = await fetch(`${base ?? region(env).api}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      // Clover asks for an identifiable agent, and an unidentified one is the
      // first thing their support asks about when a merchant reports a problem.
      'User-Agent': 'NUM/1.0 (itsnum.com)',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(parsed?.message || parsed?.error?.message || `Clover ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return parsed;
}

/** Unix seconds → the ISO string index.mjs stores and compares. */
const iso = (unixSeconds) => (Number.isFinite(Number(unixSeconds)) && Number(unixSeconds) > 0
  ? new Date(Number(unixSeconds) * 1000).toISOString()
  : null);

export async function exchangeCode(env, { code, merchantId = null } = {}) {
  const t = await call(env, '/oauth/v2/token', {
    method: 'POST',
    body: { client_id: env.CLOVER_APP_ID, client_secret: env.CLOVER_APP_SECRET, code },
  });
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? null,
    expires_at: iso(t.access_token_expiration),
    refresh_expires_at: iso(t.refresh_token_expiration),
    merchant_id: merchantId ?? t.merchant_id ?? null,
  };
}

export async function refresh(env, refreshToken) {
  const t = await call(env, '/oauth/v2/refresh', {
    method: 'POST',
    body: { client_id: env.CLOVER_APP_ID, refresh_token: refreshToken },
  });
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? refreshToken,
    expires_at: iso(t.access_token_expiration),
    refresh_expires_at: iso(t.refresh_token_expiration),
  };
}

/**
 * Clover has one merchant per token, so there is no location list to pick
 * from. Reported as a single "location" so the console can render one shape
 * for every vendor rather than branching per till.
 */
export async function locations(env, conn) {
  const m = await call(env, `/v3/merchants/${encodeURIComponent(conn.merchant_id)}`, { token: conn.token });
  return [{ id: m.id, name: m.name ?? m.id, currency: m.currency ?? null, status: 'ACTIVE' }];
}

/** The merchant's own tender ids. Cached per call, never guessed, never hardcoded. */
export async function tenders(env, conn) {
  const out = await call(env, `/v3/merchants/${encodeURIComponent(conn.merchant_id)}/tenders`, { token: conn.token });
  return out.elements ?? [];
}

/**
 * Pick the tender to log a NUM payment against.
 *
 * Prefers one the merchant has named for external payments, then any custom
 * tender that is neither card nor cash. NEVER falls back to cash: a NUM
 * payment logged as cash means a till that says there should be money in the
 * drawer that is not there, and somebody counts it at 1am.
 */
export function pickTender(list) {
  const rows = (list ?? []).filter((t) => t && t.id && t.enabled !== false);
  const named = rows.find((t) => /external|third[\s-]?party|other|num/i.test(String(t.label ?? '')));
  if (named) return named;
  const custom = rows.find((t) => {
    const key = String(t.labelKey ?? '');
    const lab = String(t.label ?? '');
    return !/CASH|CREDIT|DEBIT|CARD/i.test(key + ' ' + lab);
  });
  return custom ?? null;
}

/**
 * Open checks.
 *
 * Clover gives a `total` and, expanded, the payments already on the order. The
 * amount NUM wants is what is STILL DUE, so the payments are subtracted here —
 * exactly the same rule as Square's net_amount_due_money, arrived at the hard
 * way. An order that owes nothing is not an open check.
 */
export async function openChecks(env, conn) {
  if (!conn.merchant_id) {
    const e = new Error('no Clover merchant on this connection');
    e.status = 400;
    throw e;
  }
  const q = 'filter=' + encodeURIComponent('state=open') + '&expand=payments&limit=100';
  const out = await call(env, `/v3/merchants/${encodeURIComponent(conn.merchant_id)}/orders?${q}`, { token: conn.token });
  const currency = conn.currency || 'USD';
  return (out.elements ?? []).map((o) => {
    const total = Number(o.total ?? 0);
    const paid = (o.payments?.elements ?? []).reduce((n, p) => n + (Number(p.amount) || 0), 0);
    return {
      vendor: 'clover',
      ref: o.id,
      // Whatever staff typed. Clover Dining's table map is private to the app,
      // so this is all there is — NUM shows it and does not interpret it.
      name: o.title || o.note || null,
      amount_minor: total - paid,
      currency: String(o.currency ?? currency).toUpperCase(),
      opened_at: Number.isFinite(Number(o.createdTime)) ? new Date(Number(o.createdTime)).toISOString() : null,
      version: null,
    };
  }).filter((c) => c.amount_minor > 0);
}

/**
 * Log the payment and close the check.
 *
 * `externalPaymentId` is the NUM bill token, which is what makes this
 * idempotent from Clover's side as well as ours: a retried Stripe webhook
 * carries the same token, and a merchant must never see two payments for one
 * dinner.
 */
export async function recordExternalPayment(env, conn, { orderId, amountMinor, currency = 'USD', reference, feeMinor = null } = {}) {
  if (!orderId) {
    const e = new Error('no Clover order to close');
    e.status = 400;
    throw e;
  }
  const amount = Math.round(Number(amountMinor) || 0);
  if (!(amount > 0)) {
    const e = new Error('a check cannot be closed for nothing');
    e.status = 400;
    throw e;
  }
  const tender = pickTender(await tenders(env, conn));
  if (!tender) {
    const e = new Error('this Clover account has no external tender for NUM to log against — add one in Clover under Setup → Tenders');
    e.status = 409;
    throw e;
  }

  const pay = await call(env, `/v3/merchants/${encodeURIComponent(conn.merchant_id)}/orders/${encodeURIComponent(orderId)}/payments`, {
    method: 'POST',
    token: conn.token,
    body: {
      tender: { id: tender.id },
      amount,
      externalPaymentId: String(reference).slice(0, 64),
      note: feeMinor ? `NUM ${reference} (fee ${feeMinor})` : `NUM ${reference}`,
      offline: false,
    },
  });
  return {
    payment_id: pay?.id ?? null,
    tender: tender.label ?? tender.id,
    // Clover closes the order itself once it is fully paid; it does not answer
    // with a state here, so this reports what it knows rather than claiming.
    order_state: null,
    closed: !!pay?.id,
  };
}
