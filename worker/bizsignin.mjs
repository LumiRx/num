/**
 * A link in the welcome email that actually opens the dashboard.
 *
 * ── THE JOURNEY THIS REPAIRS ─────────────────────────────────────────────
 *
 * A business claims its listing, proves control with a one-time code, gets
 * approved, and receives the welcome email. That email links to
 * `/api/biz/console?q=<their own name>` — a SEARCH BOX, prefilled. To reach
 * the dashboard they were just told is theirs they must: find themselves in
 * the results, press claim, wait for a second one-time code, and enter it.
 *
 * They already did all of that. We are asking a restaurant owner to prove,
 * for a second time, the thing we emailed them to say we had confirmed.
 *
 * ── WHY THIS IS NOT THE THING bizonboard.mjs REFUSED ─────────────────────
 *
 * `bizonboard.mjs` says, correctly: "No key in the URL, ever — a link that
 * authorised anything would be a credential in an inbox, in a forwarded email
 * and in every referrer." That reasoning is about the numbiz_ KEY, which is
 * permanent, grants edit rights forever, and is shown exactly once.
 *
 * This is a different object and the difference is the whole design:
 *
 *   · SINGLE USE. Consumed on the first click. A forwarded email carries a
 *     dead link, which is strictly better than a forwarded email carrying a
 *     live six-digit code — the threat model people accept today.
 *   · SHORT-LIVED. Fourteen days, because a business owner reads an email on
 *     Sunday, not on the minute it lands. Expiry is checked on use.
 *   · STORED HASHED. Only a SHA-256 of the token is written, so the database
 *     cannot mint one and neither can anyone reading a backup.
 *   · IT LEAVES THE ADDRESS BAR IMMEDIATELY. The handler redirects to the
 *     ordinary `?s=` session URL, so the one-time token is never the page's
 *     own address, never in a referrer from that page, and never in a
 *     bookmark.
 *   · IT GRANTS A SESSION, NOT A KEY. Twelve hours, read-and-edit on that one
 *     listing, exactly what the code-entry path already grants. The permanent
 *     key is still shown once, still only on the verify path.
 *
 * The honest summary: this is a magic link, it carries the risks magic links
 * carry, and it replaces a flow whose risks were the same and whose friction
 * cost us the businesses it was meant to protect.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_biz_signin_links (
  token_hash  TEXT PRIMARY KEY,
  place_id    TEXT NOT NULL,
  business_id TEXT,
  purpose     TEXT NOT NULL DEFAULT 'welcome',
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bizsignin_place ON num_biz_signin_links(place_id, created_at);
`;

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** SHA-256, hex. The table never holds a usable token. */
export async function hashToken(token) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token))));
}

export const DEFAULT_TTL_DAYS = 14;

/**
 * Mint one. Returns the token exactly once — the caller puts it in the email
 * and then it is unrecoverable, same discipline as the business key.
 */
export async function mintSigninLink(env, { placeId, businessId = null, purpose = 'welcome', ttlDays = DEFAULT_TTL_DAYS } = {}) {
  if (!env?.DB || !placeId) return null;
  await ensure(env);
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare(
    `INSERT INTO num_biz_signin_links (token_hash, place_id, business_id, purpose, expires_at)
     VALUES (?1, ?2, ?3, ?4, datetime('now', ?5))`,
  ).bind(
    await hashToken(token), String(placeId), businessId ? String(businessId) : null,
    String(purpose).slice(0, 24), `+${Math.max(1, Number(ttlDays) || DEFAULT_TTL_DAYS)} days`,
  ).run();
  return token;
}

/**
 * Spend one.
 *
 * The UPDATE is the check: `used_at IS NULL` in the WHERE clause means the
 * database decides who wins a race, not this function. Reading first and
 * writing second would let two simultaneous clicks both succeed — which is
 * the difference between "single use" and "single use most of the time".
 *
 * Returns `{ ok, place_id }`, or a reason. The reasons are distinct because a
 * business needs to be told which of them happened: an expired link and an
 * already-used link need different next sentences.
 */
export async function spendSigninLink(env, token) {
  if (!env?.DB || !token) return { ok: false, reason: 'missing' };
  await ensure(env);
  const h = await hashToken(token);

  const upd = await env.DB.prepare(
    `UPDATE num_biz_signin_links SET used_at = datetime('now')
      WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > datetime('now')`,
  ).bind(h).run().catch(() => null);

  if (upd?.meta?.changes) {
    const row = await env.DB.prepare(
      'SELECT place_id, business_id, purpose FROM num_biz_signin_links WHERE token_hash = ?1',
    ).bind(h).first().catch(() => null);
    return row?.place_id
      ? { ok: true, place_id: row.place_id, business_id: row.business_id ?? null, purpose: row.purpose }
      : { ok: false, reason: 'missing' };
  }

  // It did not apply. Say WHY, because "that link did not work" is the least
  // useful sentence available and this is somebody's first minute with NUM.
  const row = await env.DB.prepare(
    'SELECT used_at, expires_at FROM num_biz_signin_links WHERE token_hash = ?1',
  ).bind(h).first().catch(() => null);
  if (!row) return { ok: false, reason: 'missing' };
  if (row.used_at) return { ok: false, reason: 'used' };
  return { ok: false, reason: 'expired' };
}

/** The wording a business sees for each failure. One sentence, then a way out. */
export const SIGNIN_MESSAGE = Object.freeze({
  used: 'That sign-in link has already been used — they only work once, on purpose. '
    + 'Find your listing below and we will send you a fresh code.',
  expired: 'That sign-in link has expired. Find your listing below and we will send you a fresh code.',
  missing: 'That sign-in link is not one of ours. Find your listing below to sign in.',
});

/** The full URL for an email. */
export const signinUrl = (origin, token) =>
  `${String(origin || 'https://app.itsnum.com').replace(/\/+$/, '')}/api/biz/console?t=${encodeURIComponent(token)}`;
