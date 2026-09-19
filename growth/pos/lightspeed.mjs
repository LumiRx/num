/**
 * lightspeed — Lightspeed Restaurant K-Series, and the first till that knows
 * which table it is talking about.
 *
 * ── WHY THIS ONE IS WORTH BUILDING ───────────────────────────────────────
 *
 * Square and Clover both have the same hole, for different reasons: neither
 * exposes the table. Square has no table field at all, only a free-text
 * ticket name; Clover keeps its Dining table map in a private schema. So on
 * both, NUM shows staff what the till says and a human matches it to the
 * table, because guessing means charging a guest for somebody else's dinner.
 *
 * K-Series is keyed BY TABLE — `GET /o/op/1/order/table/{n}/getCheck` — and
 * the check it returns carries `salesEntries`, the actual lines the guest
 * ordered, with names, quantities and unit amounts. That is the whole of
 * worker/billitems.mjs arriving for free: a venue on K-Series never types a
 * bill, and the guest sees what they ate rather than a number.
 *
 * ── THREE THINGS THAT WILL BITE, WRITTEN DOWN BEFORE THEY DO ─────────────
 *
 * 1. THE AMOUNTS ARE MAJOR UNITS. `currentAmount` is 24.5, not 2450. Square
 *    and Clover both speak integer minor units and the rest of NUM does too,
 *    so every figure crossing this boundary is converted exactly once, here,
 *    and the conversion is rounded rather than truncated. A cent lost per
 *    check is a venue short at the end of a night.
 *
 * 2. THE CHECK CARRIES NO CURRENCY. There is no currency field on the
 *    response at all. It comes from the venue's own profile and never from
 *    the till — the same rule billphoto.mjs follows for a photographed bill,
 *    and for the same reason: a bill printed with a bare number in Bangkok
 *    must not become dollars.
 *
 * 3. `endpointId` IS REQUIRED TO PAY. The pay call takes a webhook endpoint
 *    id, so a venue that has connected but has no endpoint registered cannot
 *    be paid through. The adapter refuses with that reason rather than
 *    sending a call it knows will fail.
 *
 * ── WHAT IS NOT CONFIRMED ────────────────────────────────────────────────
 *
 * The production API host is not stated in the public docs — only the trial
 * host, api.trial.lsk.lightspeed.app, is published. The production value
 * below is the obvious sibling and is NOT verified. It is a named constant
 * and overridable by env for exactly that reason, and `ready()` does not
 * depend on it being right: the first real connection will prove or disprove
 * it in one call, and a wrong host fails loudly at connect time rather than
 * quietly at pay time.
 *
 * Sources: api-docs.lsk.lightspeed.app — Get All Open Checks
 * (operation-apegetcheck), Get Open Check by Table (operation-apechecklookup),
 * Apply a Payment (operation-apemakepayment), and /authentication.
 */

const AUTH = 'https://auth.lsk-prod.app/realms/k-series/protocol/openid-connect';
const HOSTS = Object.freeze({
  prod: 'https://api.lsk.lightspeed.app',
  trial: 'https://api.trial.lsk.lightspeed.app',
});

export const label = 'Lightspeed Restaurant';
export const SELLER_NOTE =
  'NUM reads the open check for the table and logs the payment against it as a third-party payment. '
  + 'Your own cash-up is not affected, and the guest sees the items already on the check.';

export const ready = (env) => !!(env?.LIGHTSPEED_CLIENT_ID && env?.LIGHTSPEED_CLIENT_SECRET);
export const needs = (env) => [
  !env?.LIGHTSPEED_CLIENT_ID && 'LIGHTSPEED_CLIENT_ID (Lightspeed developer portal → your app)',
  !env?.LIGHTSPEED_CLIENT_SECRET && 'LIGHTSPEED_CLIENT_SECRET',
].filter(Boolean);

const host = (env) => HOSTS[String(env?.LIGHTSPEED_ENV || 'prod')] ?? HOSTS.prod;

/** Majors to minors, once, at the boundary. Rounded — never truncated. */
export const toMinor = (amount) => Math.round(Number(amount ?? 0) * 100);
/** And back, for the one call that speaks majors. */
export const toMajor = (minor) => Number((Math.round(Number(minor ?? 0)) / 100).toFixed(2));

export function authorizeUrl(env, { state, origin } = {}) {
  const u = new URL(`${AUTH}/auth`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', String(env?.LIGHTSPEED_CLIENT_ID ?? ''));
  u.searchParams.set('redirect_uri', `${origin}/biz/pos/callback?vendor=lightspeed`);
  // orders-api is the one that carries business data, menus, orders AND the
  // payment operation. Nothing else is asked for: an integration that reads a
  // check should not also be able to edit the menu.
  u.searchParams.set('scope', 'orders-api');
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

async function token(env, form) {
  const res = await fetch(`${AUTH}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: String(env?.LIGHTSPEED_CLIENT_ID ?? ''),
      client_secret: String(env?.LIGHTSPEED_CLIENT_SECRET ?? ''),
      ...form,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body?.error_description || body?.error || `Lightspeed auth ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return {
    token: body.access_token,
    refresh: body.refresh_token ?? null,
    // Keycloak returns lifetimes in seconds, not an absolute time.
    expiresAt: body.expires_in ? new Date(Date.now() + Number(body.expires_in) * 1000).toISOString() : null,
  };
}

export async function exchangeCode(env, { code, origin } = {}) {
  if (!code) {
    const e = new Error('Lightspeed sent no code back');
    e.status = 400;
    throw e;
  }
  return token(env, {
    grant_type: 'authorization_code',
    code: String(code),
    redirect_uri: `${origin}/biz/pos/callback?vendor=lightspeed`,
  });
}

export async function refresh(env, refreshToken) {
  if (!refreshToken) {
    const e = new Error('no refresh token — this venue has to reconnect');
    e.status = 401;
    throw e;
  }
  return token(env, { grant_type: 'refresh_token', refresh_token: String(refreshToken) });
}

async function call(env, path, { token: bearer, method = 'GET', body = null, query = null } = {}) {
  const u = new URL(host(env) + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v != null) u.searchParams.set(k, String(v));
  const res = await fetch(u, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(out?.message || out?.error || `Lightspeed ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return out;
}

/**
 * The venue's business locations.
 *
 * K-Series calls them businessLocationIds and every other call needs one, so
 * a venue that has connected but not chosen a location cannot be read from.
 */
export async function locations(env, conn) {
  const out = await call(env, '/o/fin/1/businessLocation', { token: conn.token }).catch(() => null);
  const list = Array.isArray(out) ? out : (out?.businessLocations ?? []);
  return list.map((b) => ({
    id: String(b.businessLocationId ?? b.id ?? ''),
    name: b.name ?? b.businessName ?? 'Location',
  })).filter((b) => b.id);
}

/**
 * Every open check at this location, with its table and its lines.
 *
 * `currentAmount` is what is currently owed and `paidAmount` what has already
 * been put against it, so the outstanding figure is the difference — the same
 * subtraction Clover needs and Square does for us.
 */
/**
 * Turn K-Series checks into the shape growth/pos/index.mjs speaks.
 *
 * ONE mapper, used by both the all-tables read and the single-table read, so
 * the two can never drift into disagreeing about what a check is.
 */
function mapChecks(checks) {
  return (checks ?? []).map((c) => {
    const qtyOf = (e) => Math.max(1, Math.round(Number(e?.quantity ?? 1)));
    return {
      vendor: 'lightspeed',
      ref: String(c.uuid ?? c.tableNumber ?? ''),
      // The first till that can answer this. Square has no table field and
      // Clover hides its table map, so both make a human match the check.
      table: c.tableNumber != null ? String(c.tableNumber) : null,
      name: c.tableNumber != null ? `Table ${c.tableNumber}` : (c.name || null),
      amount_minor: toMinor(c.currentAmount) - toMinor(c.paidAmount ?? 0),
      // NEVER from the till: there is no currency on this response at all.
      // The caller fills it from the venue's own profile.
      currency: null,
      opened_at: c.openDate ?? null,
      guests: Number.isFinite(Number(c.clientCount)) ? Number(c.clientCount) : null,
      staff: c.staffName ?? null,
      // The bill, already itemised, straight off the till.
      items: (c.salesEntries ?? []).map((e, i) => ({
        pos: i,
        name: String(e.name ?? e.sku ?? 'Item').slice(0, 80),
        qty: qtyOf(e),
        unit_minor: toMinor(e.unitAmount),
        line_minor: toMinor(e.unitAmount) * qtyOf(e),
      })),
    };
  });
}

/**
 * Every open check at this location, with its table and its lines.
 *
 * `currentAmount` is what is currently owed and `paidAmount` what has already
 * been put against it, so the outstanding figure is the difference — the same
 * subtraction Clover needs and Square does for us.
 */
export async function openChecks(env, conn) {
  if (!conn.location_id) {
    const e = new Error('no Lightspeed location is chosen yet');
    e.status = 400;
    throw e;
  }
  const out = await call(env, '/o/op/1/order/table/getCheck', {
    token: conn.token,
    query: { businessLocationId: conn.location_id },
  });
  return mapChecks(Array.isArray(out) ? out : (out?.checks ?? []))
    .filter((c) => c.amount_minor > 0);
}

/** One table's open check, when the guest scanned that table's own code. */
export async function checkForTable(env, conn, tableNumber) {
  if (!conn.location_id) {
    const e = new Error('no Lightspeed location is chosen yet');
    e.status = 400;
    throw e;
  }
  const out = await call(env, `/o/op/1/order/table/${encodeURIComponent(tableNumber)}/getCheck`, {
    token: conn.token,
    query: { businessLocationId: conn.location_id },
  });
  const one = Array.isArray(out) ? out[0] : out;
  if (!one) return null;
  return mapChecks([one])[0] ?? null;
}

/**
 * Tell the till the guest paid through NUM.
 *
 * `thirdPartyPaymentReference` is the NUM bill token and Lightspeed enforces
 * its uniqueness itself, rejecting a repeat with "reference has already been
 * used". That is the idempotency Square and Clover need an explicit key for,
 * and it is the right behaviour on a webhook Stripe retries — so a duplicate
 * is reported as already-closed rather than raised as a failure.
 */
export async function recordExternalPayment(env, conn, { amountMinor, reference, tableNumber = null } = {}) {
  const amount = Math.round(Number(amountMinor) || 0);
  if (!(amount > 0)) {
    const e = new Error('a check cannot be closed for nothing');
    e.status = 400;
    throw e;
  }
  if (!reference) {
    const e = new Error('no NUM reference to log against the check');
    e.status = 400;
    throw e;
  }
  if (!conn.webhook_id) {
    // Refused rather than attempted: the pay call requires it and would fail
    // anyway, and a refusal that names the reason is worth more than a 400
    // from a vendor.
    const e = new Error('this Lightspeed location has no webhook endpoint registered, so it cannot take a third-party payment');
    e.status = 400;
    throw e;
  }
  try {
    await call(env, '/o/op/1/pay', {
      token: conn.token,
      method: 'POST',
      body: {
        thirdPartyPaymentReference: String(reference).slice(0, 50),
        endpointId: String(conn.webhook_id),
        businessLocationId: Number(conn.location_id),
        // The one call in this file that speaks major units.
        paymentAmount: toMajor(amount),
        ...(tableNumber != null ? { tableNumber: Number(tableNumber) } : {}),
      },
    });
    return { payment_id: String(reference), closed: true };
  } catch (e) {
    if (/already been used/i.test(e?.message ?? '')) {
      // Stripe delivered the webhook twice. The check is closed; that is a
      // success with a different shape, not a failure to report to a venue.
      return { payment_id: String(reference), closed: true, already: true };
    }
    throw e;
  }
}
