// WHO MAY ASK THE CONCIERGE.
//
// 18 Sep 2026. /api/num answered anyone who could POST to it, and at volume
// that meant NUM doing real work — a lane, a brain, a place lookup — for
// people it could never answer back. A booking cannot be confirmed to a
// stranger, a table cannot be held for one, and nothing can be sent when it
// moves. So the app now requires a proved channel before it will send
// (src/lib/gate.ts), and this is the same rule where it cannot be bypassed.
//
// ── WHAT IS DELIBERATELY STILL OPEN ──────────────────────────────────────
//
// itsnum.com/ask/ is a live landing page whose own headline says "No signup,
// no app store", written for cold Reddit traffic on Thai mobile data. It is
// the top of the funnel and it posts to this same endpoint. Gating it would
// either kill the funnel or make the page a lie, so requests from the site's
// own origins pass. That allowance is spoofable by anybody who can set a
// header — which changes nothing, because what they would gain by spoofing it
// is exactly what /ask gives them for free anyway. The per-IP limiter in
// guard.mjs is what stands between that door and abuse, not this function.
//
// The health probe passes too (X-Num-Probe), or /api/health would go red on a
// verdict about its own gate — and that endpoint went green for the first
// time in two weeks this morning.
//
// ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
//
// It is not a check inside handleNum(). WhatsApp turns, the hosted MCP server
// (worker/partnermcp.mjs) and concierge_answer all call handleNum directly
// with their own subjects and their own authorisation; a gate in there would
// break three working channels to close one door. This runs at the HTTP
// boundary, on the browser path only.
import { hasVerifiedContact } from './membercontact.mjs';

/** The site's own pages. `capacitor://localhost` is the native app, which is gated. */
const SITE_HOSTS = new Set(['itsnum.com', 'www.itsnum.com']);

/** Lookups a day for a member who has proved nothing. Generous, and finite. */
export const BROWSE_CAP = 25;

const hostOf = (v) => { try { return new URL(String(v)).hostname.toLowerCase(); } catch { return ''; } };

/** True when this request came from the marketing site rather than the app. */
export function fromSite(request) {
  const origin = request?.headers?.get?.('Origin');
  const referer = request?.headers?.get?.('Referer');
  return SITE_HOSTS.has(hostOf(origin)) || SITE_HOSTS.has(hostOf(referer));
}

/**
 * The App Store Connect grant, recognised again here.
 *
 * `worker/social.mjs` lets the reviewer in without setting `phone_verified`,
 * on purpose — we never texted that number. So the row this function is
 * handed looks unverified, and the reviewer would be refused by the very
 * honesty of our own database. The grant's own secrets are the witness: a
 * member id if one is pinned, otherwise the phone the grant is bound to. With
 * no secrets set — the default — this returns false and nothing changes.
 */
export function reviewerRow(env, row) {
  if (!row) return false;
  const until = String(env?.REVIEW_ACCESS_UNTIL ?? '').trim();
  if (!until || !Number.isFinite(Date.parse(until)) || Date.parse(until) < Date.now()) return false;
  const pinned = String(env?.REVIEW_DEMO_MEMBER ?? '').trim();
  if (pinned) return row.id === pinned;
  const phone = String(env?.REVIEW_DEMO_PHONE ?? '').trim();
  return !!phone && String(row.phone ?? '') === phone;
}

/**
 * May this request ask?
 *
 * Returns `{ ok: true }`, or `{ ok: false, reason }` where the reason is for
 * our logs — the sentence the person reads is written at the call site, in
 * the app's own voice.
 *
 * A database that will not answer fails CLOSED here, and that is the
 * deliberate choice: the alternative is a gate that disappears exactly when
 * D1 is unwell, which is when a flood is most likely to be what made it
 * unwell. `/ask` and the probe are already past by then.
 */
export async function maySend(env, request, body) {
  if (request?.headers?.get?.('X-Num-Probe') === '1') return { ok: true, reason: 'probe' };
  if (fromSite(request)) return { ok: true, reason: 'site' };

  const id = String(body?.state?.me?.id ?? body?.state?.meId ?? body?.me ?? '').trim();
  if (!id) return { ok: false, reason: 'no_member' };
  if (!env?.DB) return { ok: false, reason: 'no_db' };

  // The columns this table ACTUALLY has, checked against production before
  // this shipped: there is no `apple_sub` on num_members — Apple subjects live
  // in their own table (worker/social.mjs num_apple_identities), and that
  // table does not exist at all until the first Apple sign-in creates it. A
  // single joined query would therefore have thrown on a database where
  // nobody has used Apple yet, and this function fails closed, which would
  // have meant nobody could send. Two queries, and only the first one is
  // allowed to be fatal.
  const row = await env.DB.prepare(
    'SELECT id, phone, phone_verified, email, email_verified FROM num_members WHERE id = ?1',
  ).bind(id).first();
  if (!row) return { ok: false, reason: 'unknown_member' };
  if (hasVerifiedContact(row)) return { ok: true, reason: 'verified' };

  // An Apple or Google identity is reachable by construction — the provider
  // holds the verified address. A missing table means no such member exists,
  // which is "no provider", not an outage.
  const provider = await env.DB
    .prepare('SELECT 1 AS has_provider FROM num_apple_identities WHERE member_id = ?1 LIMIT 1')
    .bind(id).first().catch(() => null);
  if (provider?.has_provider) return { ok: true, reason: 'provider' };

  if (reviewerRow(env, row)) return { ok: true, reason: 'review' };

  /* ── LOOKING IS NOT SENDING (20 Sep 2026) ───────────────────────────────
   *
   * `browse` is set by the app on an ask that is a lookup — a feature-page
   * search, "tell me about this place", a trip check. The gate above exists
   * so that NUM never does work it cannot deliver; a search has nothing to
   * deliver, so refusing it protects nobody and, in production, it stopped
   * the flight and stay widgets from searching at all.
   *
   * THE FLAG IS SET BY THE CLIENT AND IS THEREFORE NOT A SECURITY CONTROL.
   * Nor is anything else in this file — `fromSite()` above is one header
   * away for anybody who wants it, and that was already true and already
   * accepted. What actually stands between this door and abuse is the per-IP
   * limiter in guard.mjs and the cap below: a member who has not proved a
   * number or an address gets BROWSE_CAP lookups a day and then meets the
   * same sheet as before. A member id is still required, so an anonymous
   * device gains nothing.
   *
   * The cap fails OPEN, deliberately and in the small direction: if the ask
   * log cannot be counted we let one lookup through rather than telling a
   * signed-in member their search is broken because our own telemetry is. */
  if (body?.browse === true) {
    const spent = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM num_asks WHERE member_id = ?1 AND ts > datetime('now', '-1 day')")
      .bind(id).first().catch(() => null);
    const n = Number(spent?.n ?? 0);
    if (!Number.isFinite(n) || n < BROWSE_CAP) return { ok: true, reason: 'browse' };
    return { ok: false, reason: 'browse_cap' };
  }

  return { ok: false, reason: 'unverified' };
}

/** What the app is told. One sentence, and the word it can branch on. */
export const VERIFY_TO_SEND = {
  error: 'verify_to_send',
  message: 'Verify a number or an email and NUM will answer — it has to be able to reach you back.',
};
