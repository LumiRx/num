/**
 * After the visit — the screen Uber shows when the ride ends.
 *
 * worker/aftertable.mjs has held rate(), tip() and prioritySeating() since 26
 * Aug 2026 with ZERO CALL SITES. Every rule in it was tested and none of it
 * had ever run: no guest had been asked how it was, no server had been left
 * anything through NUM, and `num_ratings` was an empty table with an index on
 * it. This file is the moment those functions are reached.
 *
 * The moment is the scan. A guest who has just tapped a table QR to confirm
 * they arrived is holding an unlocked phone with a NUM page already open —
 * that is the only instant when asking costs them nothing. Asking by email
 * the next morning is a different, much worse product, and the difference is
 * entirely in the timing.
 *
 * ── the token ────────────────────────────────────────────────────────────
 *
 * A guest has no account and no session. What entitles them to rate booking X
 * is that they were standing in the venue holding the four-character code, so
 * the proof of that — a token minted at the completing scan — is what the
 * after page is addressed by. It expires, because a link that rates a
 * restaurant should not still work in November.
 *
 * ── the money ────────────────────────────────────────────────────────────
 *
 * NUM does not take a tip and does not carry one. What happens here is that
 * the amount is RECORDED, and the guest is sent to the venue's own payment
 * link to actually pay it — their rail, their bank, their money. Recording it
 * is what puts the tip on the venue's statement so a manager can see the
 * server was left something. Carrying it would be money transmission.
 */

const SCHEMA = `CREATE TABLE IF NOT EXISTS num_after_tokens (
  token       TEXT PRIMARY KEY,
  booking_id  TEXT NOT NULL,
  business_id TEXT,
  place_id    TEXT,
  member_ref  TEXT,
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  first_seen  INTEGER,
  UNIQUE (booking_id)
)`;

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.prepare(SCHEMA).run().catch(() => {});
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_after_expiry ON num_after_tokens(expires_at)',
  ).run().catch(() => {});
  ready = true;
}
export const _resetSchemaCache = () => { ready = false; };

/** No look-alikes: a guest reads this off a screen, occasionally out loud. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function afterToken(len = 22) {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

/** Three days. Long enough for "I'll do it tomorrow", short enough to expire. */
export const AFTER_TTL_S = 72 * 3600;

/**
 * Mint the link for a booking that just completed.
 *
 * Never throws and never rejects. It is called from inside the scan path, and
 * a guest standing at a host stand must have their arrival confirmed even if
 * every table in this file is missing.
 */
export async function issueAfter(env, {
  bookingId, businessId = null, placeId = null, memberRef = null, now = null,
} = {}) {
  if (!env?.DB || !bookingId) return null;
  try {
    await ensure(env);
    const t = now ?? Math.floor(Date.now() / 1000);
    const token = afterToken();
    await env.DB.prepare(
      `INSERT INTO num_after_tokens
         (token,booking_id,business_id,place_id,member_ref,issued_at,expires_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7)
       ON CONFLICT(booking_id) DO UPDATE SET expires_at = excluded.expires_at`,
    ).bind(token, String(bookingId), businessId, placeId, memberRef, t, t + AFTER_TTL_S).run();
    // A second scan of the same booking keeps the FIRST token — the guest may
    // already have it open. Read back rather than assuming the insert won.
    const row = await env.DB.prepare(
      'SELECT token FROM num_after_tokens WHERE booking_id = ?1',
    ).bind(String(bookingId)).first();
    return row?.token || token;
  } catch (e) {
    console.warn('[aftervisit.issueAfter]', e?.message ?? e);
    return null;
  }
}

/** The token's row, or null when it is unknown or out of date. */
export async function resolveAfter(env, token, { now = null } = {}) {
  if (!env?.DB || !token) return null;
  const clean = String(token).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
  if (clean.length < 16) return null;
  try {
    await ensure(env);
    const row = await env.DB.prepare(
      `SELECT token,booking_id,business_id,place_id,member_ref,expires_at,first_seen
         FROM num_after_tokens WHERE token = ?1`,
    ).bind(clean).first();
    if (!row) return null;
    const t = now ?? Math.floor(Date.now() / 1000);
    if (row.expires_at <= t) return { ...row, expired: true };
    if (!row.first_seen) {
      await env.DB.prepare('UPDATE num_after_tokens SET first_seen = ?2 WHERE token = ?1')
        .bind(clean, t).run().catch(() => {});
    }
    return { ...row, expired: false };
  } catch (e) {
    console.warn('[aftervisit.resolveAfter]', e?.message ?? e);
    return null;
  }
}

/**
 * A payment link of the venue's own that a guest can put any amount into.
 *
 * Table-specific and fixed-amount links are no good for a tip: a fixed link
 * would charge the wrong number and a one-time link is already spoken for.
 * When there is nothing suitable the answer is not a broken button — it is
 * telling the guest to hand it to their server, which is what people did
 * before any of this existed and still works.
 */
export async function tipRail(env, businessId) {
  if (!env?.DB || !businessId) return { rail: 'venue', url: null };
  try {
    const row = await env.DB.prepare(
      `SELECT token FROM num_paylinks
        WHERE business_id = ?1 AND state = 'active'
          AND COALESCE(one_time,0) = 0
          AND (amount IS NULL OR amount = '')
        ORDER BY created_at LIMIT 1`,
    ).bind(businessId).first();
    return row?.token
      ? { rail: 'paylink', url: `/p/${row.token}`, token: row.token }
      : { rail: 'venue', url: null };
  } catch (e) {
    console.warn('[aftervisit.tipRail]', e?.message ?? e);
    return { rail: 'venue', url: null };
  }
}

/**
 * What the after page should show.
 *
 * `tips` is false unless the venue switched tipping on AND accepted the
 * undertaking — see growth/venuesettings.mjs and migrations/0010. A guest is
 * never asked to leave something at a venue that has not promised it reaches
 * the staff.
 */
export async function afterState(env, token, { now = null } = {}) {
  const row = await resolveAfter(env, token, { now });
  if (!row) return { ok: false, error: 'unknown' };
  if (row.expired) return { ok: false, error: 'expired' };

  const [{ tipsOffered }, biz] = await Promise.all([
    import('../worker/aftertable.mjs'),
    row.business_id
      ? env.DB.prepare('SELECT id,name,category FROM businesses WHERE id = ?1')
          .bind(row.business_id).first().catch(() => null)
      : Promise.resolve(null),
  ]);

  const place = biz || {};
  const tips = await tipsOffered(env, place, row.business_id);
  const already = await env.DB.prepare(
    `SELECT (SELECT stars FROM num_ratings WHERE booking_id = ?1) AS stars,
            (SELECT amount_cs FROM num_tips WHERE booking_id = ?1) AS tip_cs`,
  ).bind(row.booking_id).first().catch(() => null);

  return {
    ok: true,
    token: row.token,
    booking_id: row.booking_id,
    business_id: row.business_id,
    place_id: row.place_id,
    venue: biz?.name || 'the venue',
    tips,
    rail: tips ? await tipRail(env, row.business_id) : { rail: 'venue', url: null },
    rated: already?.stars ?? null,
    tipped: already?.tip_cs ?? null,
  };
}
