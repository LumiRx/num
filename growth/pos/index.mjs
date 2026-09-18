/**
 * pos — reading a venue's own till, and closing a check in it when a guest
 * pays through NUM.
 *
 * ── WHY AN ADAPTER REGISTRY AND NOT "THE POS INTEGRATION" ────────────────
 *
 * Every product that does this well — sunday, me&u, qlub — integrates with
 * whatever the venue already runs rather than replacing it; qlub lists 106.
 * NUM is not going to build a point of sale. A POS is kitchen printers,
 * modifiers, staff clock-in, stock and a hardware call-out at 11pm on a
 * Saturday; all NUM wants from it is one number.
 *
 * So this is the same honesty mechanism as payouts/rails.mjs and
 * worker/payrails.mjs: an adapter that is not `ready` for THIS venue cannot
 * be called, and a venue with no adapter falls back to what already works —
 * staff typing the figure into the console (growth/qrsystem.mjs billForTable).
 * Nothing here is ever the only way to get a bill.
 *
 * ── WHAT A CHECK IS, ONCE IT LEAVES A VENDOR ─────────────────────────────
 *
 * Normalised on the way out, because the second adapter is what makes or
 * breaks this shape and Square, Clover and Lightspeed disagree about
 * everything except the money:
 *
 *   { ref, name, amount_minor, currency, opened_at, vendor }
 *
 * `name` is whatever the till calls it — Square has no table field at all,
 * only a free-text `ticket_name`, so NUM shows the venue what the till says
 * and lets a human match it to a table. Guessing which check belongs to
 * table 7 and then charging a guest for it is the one failure this must not
 * have.
 *
 * ── TOKENS ARE CIPHERTEXT ────────────────────────────────────────────────
 *
 * A Square access token can create payments on that merchant's own account.
 * Stored in the clear, one D1 export is every connected venue at once. So
 * they are encrypted at rest under POS_TOKEN_KEY with AES-GCM and this module
 * is the only thing that ever sees them decrypted. No POS_TOKEN_KEY means no
 * POS: `posReady` is false and the console says so, rather than writing a
 * bearer token into a database in plaintext because a secret was missing.
 */

import * as square from './square.mjs';
import * as clover from './clover.mjs';

export const ADAPTERS = Object.freeze({ square, clover });

export const vendors = () => Object.keys(ADAPTERS);
export const adapterFor = (vendor) => ADAPTERS[String(vendor ?? '').toLowerCase()] ?? null;

/** Readiness is derived from what is configured, never from a flag. */
export function posReady(env, vendor) {
  const a = adapterFor(vendor);
  if (!a) return false;
  return !!env?.POS_TOKEN_KEY && a.ready(env);
}
export function posNeeds(env, vendor) {
  const a = adapterFor(vendor);
  if (!a) return ['no such POS vendor'];
  return [!env?.POS_TOKEN_KEY && 'POS_TOKEN_KEY (encrypts merchant tokens at rest)', ...a.needs(env)].filter(Boolean);
}

/* ── encryption at rest ──────────────────────────────────────────────────── */

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(env) {
  if (!env?.POS_TOKEN_KEY) throw new Error('POS_TOKEN_KEY is not set');
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.POS_TOKEN_KEY));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function seal(env, plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), new TextEncoder().encode(String(plain)));
  return `${b64(iv)}.${b64(ct)}`;
}

/**
 * Returns null on anything that does not decrypt — a rotated key, a truncated
 * column, a value written by a different app. Null means "reconnect", which
 * is recoverable; throwing here would take the whole console page down.
 */
export async function unseal(env, blob) {
  if (!blob || typeof blob !== 'string' || !blob.includes('.')) return null;
  try {
    const [iv, ct] = blob.split('.');
    const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct));
    return new TextDecoder().decode(out);
  } catch {
    return null;
  }
}

/* ── the venue's connection ──────────────────────────────────────────────── */

/**
 * What NUM has on file for this venue, tokens decrypted, plus whether the
 * access token is still alive. A missing table (before migration 0039) reads
 * as "no POS", which is the truth, not a 500 on the console.
 */
export async function connectionFor(env, businessId) {
  if (!env?.DB || !businessId) return null;
  const row = await env.DB.prepare(
    `SELECT business_id, vendor, merchant_id, location_id, token_enc, refresh_enc, expires_at, state, last_error, connected_at
       FROM num_business_pos WHERE business_id = ?1`,
  ).bind(String(businessId)).first().catch(() => null);
  if (!row) return null;
  const token = await unseal(env, row.token_enc);
  const refresh = await unseal(env, row.refresh_enc);
  const expired = row.expires_at ? Date.parse(row.expires_at) < Date.now() : false;
  return {
    business_id: row.business_id, vendor: row.vendor, merchant_id: row.merchant_id,
    location_id: row.location_id, token, refresh, expires_at: row.expires_at,
    state: row.state, last_error: row.last_error, connected_at: row.connected_at,
    expired,
    // `usable` is the only thing callers should branch on. A connection whose
    // key no longer decrypts has a row and no token — it is NOT usable, and
    // saying so is how a venue finds out to reconnect instead of wondering why
    // no checks ever appear.
    usable: row.state === 'active' && !!token && !expired,
  };
}

export async function saveConnection(env, businessId, { vendor, merchantId = null, locationId = null, token = null, refresh = null, expiresAt = null, state = 'active' } = {}) {
  const [token_enc, refresh_enc] = await Promise.all([seal(env, token), seal(env, refresh)]);
  await env.DB.prepare(
    `INSERT INTO num_business_pos (business_id, vendor, merchant_id, location_id, token_enc, refresh_enc, expires_at, state, last_error, connected_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,NULL,datetime('now'),datetime('now'))
     ON CONFLICT(business_id) DO UPDATE SET
       vendor = excluded.vendor,
       merchant_id = COALESCE(excluded.merchant_id, num_business_pos.merchant_id),
       location_id = COALESCE(excluded.location_id, num_business_pos.location_id),
       token_enc = COALESCE(excluded.token_enc, num_business_pos.token_enc),
       refresh_enc = COALESCE(excluded.refresh_enc, num_business_pos.refresh_enc),
       expires_at = COALESCE(excluded.expires_at, num_business_pos.expires_at),
       state = excluded.state,
       last_error = NULL,
       connected_at = COALESCE(num_business_pos.connected_at, excluded.connected_at),
       updated_at = datetime('now')`,
  ).bind(String(businessId), vendor, merchantId, locationId, token_enc, refresh_enc, expiresAt, state).run();
}

/** Say what went wrong where a venue can read it, and stop using a dead token. */
export async function markBroken(env, businessId, reason, state = 'needs_reauth') {
  await env.DB.prepare(
    `UPDATE num_business_pos SET state = ?2, last_error = ?3, updated_at = datetime('now') WHERE business_id = ?1`,
  ).bind(String(businessId), state, String(reason ?? '').slice(0, 300)).run().catch(() => null);
}

export async function disconnect(env, businessId) {
  await env.DB.prepare(
    `UPDATE num_business_pos SET state = 'revoked', token_enc = NULL, refresh_enc = NULL, updated_at = datetime('now') WHERE business_id = ?1`,
  ).bind(String(businessId)).run();
}

/**
 * Keep the token alive. Square's tokens expire; a refresh that fails is a
 * venue that must reconnect, and it is marked as such rather than retried
 * into a rate limit.
 */
export async function withFreshToken(env, conn) {
  if (!conn) return null;
  if (conn.token && !conn.expired) return conn;
  const a = adapterFor(conn.vendor);
  if (!a?.refresh || !conn.refresh) {
    await markBroken(env, conn.business_id, 'the connection expired and there is nothing to refresh it with');
    return null;
  }
  try {
    const t = await a.refresh(env, conn.refresh);
    await saveConnection(env, conn.business_id, {
      vendor: conn.vendor, merchantId: t.merchant_id ?? conn.merchant_id, locationId: conn.location_id,
      token: t.access_token, refresh: t.refresh_token ?? conn.refresh, expiresAt: t.expires_at ?? null,
    });
    return await connectionFor(env, conn.business_id);
  } catch (e) {
    await markBroken(env, conn.business_id, e?.message ?? 'refresh failed');
    return null;
  }
}

/* ── the two things NUM actually wants ───────────────────────────────────── */

/**
 * Open checks, normalised. Throws nothing: a venue console asking "what is
 * open right now" gets either checks or a reason, never an exception and
 * never a fabricated list.
 */
export async function openChecks(env, businessId) {
  const conn0 = await connectionFor(env, businessId);
  if (!conn0) return { ok: false, reason: 'no till is connected' };
  if (!posReady(env, conn0.vendor)) return { ok: false, reason: `${conn0.vendor} is not switched on for NUM yet`, needs: posNeeds(env, conn0.vendor) };
  const conn = await withFreshToken(env, conn0);
  if (!conn?.usable) return { ok: false, reason: 'the till connection needs reconnecting', reconnect: true };
  try {
    const checks = await adapterFor(conn.vendor).openChecks(env, conn);
    return { ok: true, vendor: conn.vendor, checks };
  } catch (e) {
    await markBroken(env, businessId, e?.message ?? 'read failed', e?.status === 401 ? 'needs_reauth' : 'active');
    return { ok: false, reason: 'could not read the till just now' };
  }
}

/**
 * Tell the till the money arrived elsewhere, so the check closes.
 *
 * This is the half that makes a POS integration worth having: without it the
 * guest has paid and the check sits open on the venue's screen, and a member
 * of staff has to remember to clear it. With it the till closes the check
 * with NUM's reference on it.
 *
 * Reported honestly on failure. A guest's payment has ALREADY happened by the
 * time this runs — so a failure here must never look like a failed payment,
 * and must never be retried in a way that could double-close.
 */
export async function recordExternalPayment(env, businessId, payment) {
  const conn0 = await connectionFor(env, businessId);
  if (!conn0) return { ok: false, reason: 'no till is connected' };
  const conn = await withFreshToken(env, conn0);
  if (!conn?.usable) return { ok: false, reason: 'the till connection needs reconnecting', reconnect: true };
  try {
    const out = await adapterFor(conn.vendor).recordExternalPayment(env, conn, payment);
    return { ok: true, vendor: conn.vendor, ...out };
  } catch (e) {
    await markBroken(env, businessId, e?.message ?? 'could not close the check', e?.status === 401 ? 'needs_reauth' : 'active');
    return { ok: false, reason: e?.message ?? 'the till would not take the payment' };
  }
}
