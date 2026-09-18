/**
 * connect — a venue plugging its OWN Stripe account into NUM.
 *
 * Standard accounts by OAuth. The venue clicks "Connect with Stripe" in the
 * console, signs in (or opens an account in its own country in ten minutes),
 * and Stripe hands NUM an `stripe_user_id` (acct_…). From then on a bill code
 * can carry a Checkout Session created ON that account (worker/billpay.mjs).
 * The venue keeps its dashboard, its payouts, its disputes and its own bank.
 * NUM keeps an application fee and nothing else.
 *
 * ── STATE IS SIGNED, NOT STORED ──────────────────────────────────────────
 *
 * The callback must not trust a business id from the query string: anyone
 * could connect THEIR Stripe account to SOMEONE ELSE'S venue and take that
 * venue's guests' money. So `state` is an HMAC over the business id and a
 * timestamp, keyed by a secret only this Worker holds, and the callback
 * refuses anything it did not sign in the last 30 minutes.
 *
 * ── READINESS, DERIVED ───────────────────────────────────────────────────
 *
 * Needs STRIPE_CLIENT_ID (the platform's ca_… id) and STRIPE_SECRET_KEY (the
 * platform key, for the token exchange) on num-growth. Neither present means
 * the console says so and shows no button — never a button that 500s.
 */

const OAUTH_AUTHORIZE = 'https://connect.stripe.com/oauth/authorize';
const OAUTH_TOKEN = 'https://connect.stripe.com/oauth/token';
const API = 'https://api.stripe.com/v1';
const STATE_TTL_S = 30 * 60;

export const connectReady = (env) => !!(env?.STRIPE_CLIENT_ID && env?.STRIPE_SECRET_KEY);
export const connectNeeds = (env) => [
  !env?.STRIPE_CLIENT_ID && 'STRIPE_CLIENT_ID (platform ca_… id, Stripe dashboard → Connect → Settings)',
  !env?.STRIPE_SECRET_KEY && 'STRIPE_SECRET_KEY on num-growth (token exchange)',
].filter(Boolean);

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function mac(env, msg) {
  const secret = env.CONNECT_STATE_SECRET || env.STRIPE_SECRET_KEY;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}

export async function signState(env, businessId, ts = Math.floor(Date.now() / 1000)) {
  const body = `${businessId}.${ts}`;
  return `${body}.${await mac(env, body)}`;
}

export async function verifyState(env, state, nowS = Math.floor(Date.now() / 1000)) {
  const parts = String(state ?? '').split('.');
  if (parts.length !== 3) return null;
  const [businessId, ts, sig] = parts;
  if (!/^\d+$/.test(ts) || nowS - Number(ts) > STATE_TTL_S || Number(ts) > nowS + 60) return null;
  const want = await mac(env, `${businessId}.${ts}`);
  if (want.length !== sig.length) return null;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return d === 0 ? businessId : null;
}

/** Where the console sends the owner. */
export async function startUrl(env, businessId, { origin }) {
  if (!connectReady(env)) return null;
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: env.STRIPE_CLIENT_ID,
    scope: 'read_write',
    state: await signState(env, businessId),
    redirect_uri: `${origin}/biz/connect/callback`,
  });
  return `${OAUTH_AUTHORIZE}?${q}`;
}

/**
 * The callback. Exchanges the code, reads the account's real capabilities
 * (charges_enabled is Stripe's word, not ours), and records the connection.
 * Returns what happened in plain words for the console to show.
 */
export async function finishConnect(env, { code, state, error, error_description } = {}) {
  if (error) return { ok: false, reason: error_description || error };
  const businessId = await verifyState(env, state);
  if (!businessId) return { ok: false, reason: 'this connect link has expired or was not issued by NUM — start again from the console' };
  if (!code) return { ok: false, reason: 'Stripe sent no code' };
  if (!connectReady(env)) return { ok: false, reason: 'connect is not configured on this worker' };

  const tok = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_secret: env.STRIPE_SECRET_KEY }),
    signal: AbortSignal.timeout(20_000),
  });
  const t = await tok.json().catch(() => ({}));
  if (!tok.ok || !t.stripe_user_id) return { ok: false, reason: t.error_description || t.error || `Stripe ${tok.status}` };

  const acct = await fetchAccount(env, t.stripe_user_id);
  await saveConnection(env, businessId, acct);
  return { ok: true, business_id: businessId, account: acct };
}

export async function fetchAccount(env, accountId) {
  const r = await fetch(`${API}/accounts/${encodeURIComponent(accountId)}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(20_000),
  });
  const a = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(a?.error?.message || `Stripe ${r.status}`);
  return {
    id: a.id, charges_enabled: !!a.charges_enabled, payouts_enabled: !!a.payouts_enabled,
    country: a.country || null, default_currency: (a.default_currency || '').toUpperCase() || null,
    business_name: a.business_profile?.name || a.settings?.dashboard?.display_name || null,
  };
}

/** Upsert into num_business_rails (migration 0035). */
export async function saveConnection(env, businessId, acct) {
  await env.DB.prepare(
    `INSERT INTO num_business_rails (business_id, stripe_account_id, stripe_charges_enabled, stripe_country, stripe_default_currency, connected_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'))
     ON CONFLICT(business_id) DO UPDATE SET
       stripe_account_id = excluded.stripe_account_id,
       stripe_charges_enabled = excluded.stripe_charges_enabled,
       stripe_country = excluded.stripe_country,
       stripe_default_currency = excluded.stripe_default_currency,
       connected_at = COALESCE(num_business_rails.connected_at, excluded.connected_at),
       updated_at = datetime('now')`,
  ).bind(businessId, acct.id, acct.charges_enabled ? 1 : 0, acct.country, acct.default_currency).run();
}

/** Re-read charges_enabled — a venue finishing Stripe's checks later flips it without reconnecting. */
export async function refreshConnection(env, businessId) {
  const row = await env.DB.prepare('SELECT stripe_account_id FROM num_business_rails WHERE business_id = ?1')
    .bind(businessId).first().catch(() => null);
  if (!row?.stripe_account_id || !env.STRIPE_SECRET_KEY) return null;
  const acct = await fetchAccount(env, row.stripe_account_id);
  await saveConnection(env, businessId, acct);
  return acct;
}

/** The venue's own opt-outs. Only rails NUM knows; anything else is dropped. */
export async function setRailsOff(env, businessId, ids, known) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((id) => known.includes(id)))];
  await env.DB.prepare(
    `INSERT INTO num_business_rails (business_id, rails_off, updated_at) VALUES (?1, ?2, datetime('now'))
     ON CONFLICT(business_id) DO UPDATE SET rails_off = excluded.rails_off, updated_at = datetime('now')`,
  ).bind(businessId, JSON.stringify(clean)).run();
  return clean;
}

/** Disconnect: forget the account here (the venue revokes NUM in its own dashboard too). */
export async function disconnect(env, businessId) {
  await env.DB.prepare(
    `UPDATE num_business_rails SET stripe_account_id = NULL, stripe_charges_enabled = 0, updated_at = datetime('now') WHERE business_id = ?1`,
  ).bind(businessId).run();
}
