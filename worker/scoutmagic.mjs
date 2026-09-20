/**
 * SIGNING IN AS A NUM EXPERT.
 *
 * ── WHAT THIS REPLACES, AND WHY IT HAD TO GO ─────────────────────────────
 *
 * 16 Sep 2026. `/api/scouts/me?code=FARMER` returned an Expert's entire
 * record — name, country, rate card, paperwork status, earnings — to anyone
 * who sent that one query string. No session, no token, no email check.
 *
 * The code was never a secret and was never meant to be one. It is a REFERRAL
 * identifier: printed on an NFC card, handed across counters, spelled aloud in
 * loud bars (the alphabet excludes 0/1/O/I/L for exactly that reason), and
 * sitting in a public URL at `itsnum.com/s/FARMER`. It is also short and
 * human-readable — ADAM, FARMER — so it is guessable by a person and
 * enumerable by a script.
 *
 * Using a public identifier as a password is the whole bug. Nothing could be
 * MOVED through that door — it is read-only and triggers no payout — but what
 * sat behind it was a 1099 contractor's earnings and tax paperwork, readable
 * by anyone who glanced at their card. With two people that was a small
 * problem. Dre is adding four more.
 *
 * ── THE DOOR THAT REPLACES IT ────────────────────────────────────────────
 *
 * An emailed link to the address already on the Expert's own row. Same shape
 * as `adminmagic.mjs`, which replaced the ops console's unreadable shared key
 * for the same reason: a credential a person cannot recover is a credential
 * that eventually locks out the person who needs it. "I cannot get in" is now
 * answered by opening your inbox.
 *
 * ── THE KEY IS THE ADMIN KEY, WITH THE SPACES HELD APART ─────────────────
 *
 * Signing uses `env.ADMIN_KEY`, which this Worker already carries, so nobody
 * has to run `wrangler secret put` before four contractors can log in. That is
 * only safe because the two token spaces are separated: an admin session is
 * signed over `payload`, an Expert session over `expert.v1|payload`. The same
 * key produces different signatures for the two, so an Expert token can never
 * verify as an admin token and no forgery crosses between them. The claims
 * carry `kind: 'expert'` as well, and it is CHECKED rather than assumed — a
 * label nobody reads is decoration.
 *
 * If the Expert programme ever outgrows this, the change is one secret and one
 * constant, and it is written here so the next person finds the argument
 * rather than re-deriving it.
 */

/** A link is useful for one sitting. Long enough to walk to a laptop. */
export const EXPERT_MAGIC_TTL_S = 20 * 60;
/** The session itself. Experts check earnings occasionally, not daily. */
export const EXPERT_SESSION_HOURS = 24 * 30;

/** Domain separation. Never remove this: it is what keeps the two doors apart. */
const SESSION_LABEL = 'expert.v1|';

const nowSec = () => Math.floor(Date.now() / 1000);
const lc = (s) => String(s ?? '').trim().toLowerCase();

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newToken(bytes = 24) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b64url(b);
}

async function hmac(env, data) {
  const secret = env?.ADMIN_KEY;
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

/** Constant-time compare — a length-independent early exit leaks the key. */
function safeEq(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export const TABLE = `
CREATE TABLE IF NOT EXISTS num_scout_magic (
  token_hash TEXT PRIMARY KEY,
  scout_id   TEXT NOT NULL,
  email      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL,
  created_ip TEXT
);`;

let tableReady = false;
export async function ensureMagicTable(env) {
  if (tableReady) return;
  await env.DB.prepare(TABLE.trim()).run();
  tableReady = true;
}

/** Reset for tests, which use a fresh in-memory database each time. */
export function __resetMagicTable() { tableReady = false; }

/**
 * Ask for a link.
 *
 * The reply is IDENTICAL whether or not the address belongs to an Expert.
 * Anything else turns this endpoint into a way to ask "is this person one of
 * Num's contractors?" — which is both a privacy answer we do not owe and a
 * list worth harvesting. `sent: true` means "we have dealt with it", never
 * "that address exists".
 */
export async function startExpertMagic(env, { email, ip = null, origin } = {}) {
  const em = lc(email);
  if (!em || !env?.DB) return { ok: true, sent: true, mailed: false };

  const scout = await env.DB.prepare(
    "SELECT id, email, status FROM num_scouts WHERE email_lc = ?1",
  ).bind(em).first().catch(() => null);

  // A paused, ended or blocked Expert is not a sign-in. Same silent reply.
  if (!scout || scout.status !== 'active') return { ok: true, sent: true, mailed: false };

  await ensureMagicTable(env);
  const token = newToken();
  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO num_scout_magic (token_hash,scout_id,email,expires_at,created_at,created_ip)
     VALUES (?1,?2,?3,?4,?5,?6)`,
  ).bind(await sha256hex(token), scout.id, em, t + EXPERT_MAGIC_TTL_S, t, ip).run();

  const link = `${origin}/api/scouts/magic?t=${encodeURIComponent(token)}`;
  let mailed = false;
  let error = null;
  try {
    const { send } = await import('./mailer.mjs');
    const out = await send(env, {
      // `bulk` means "no blind copies" in mailer.normalise. This Worker copies
      // ordinary mail to a SHARED inbox, and a single-use sign-in link copied
      // to a second mailbox is a second way into someone's earnings — the one
      // property this door exists to keep to one person.
      bulk: true,
      // From and Reply-To on the same domain. A message whose whole content is
      // "click this link to get in" reads as phishing to a filter when those
      // two disagree, and this is the one message that must not land in spam.
      replyTo: 'hello@itsnum.com',
      to: scout.email,
      subject: 'Your Num Expert sign-in link',
      text: `Open your Num Expert dashboard:\n\n${link}\n\n`
          + `This link works once and expires in 20 minutes.\n`
          + `If you did not ask for it, you can ignore this — nothing has changed.\n`,
    });
    mailed = !!out?.ok;
    error = out?.ok ? null : (out?.error || 'mail refused');
  } catch (e) {
    error = String(e?.message ?? e);
  }
  return { ok: true, sent: true, mailed, error };
}

/**
 * Redeem exactly once.
 *
 * Three different sentences, because only one of them means "ask for another
 * link" and a person staring at a dead link deserves to know which.
 */
export async function redeemExpertMagic(env, token) {
  const tok = String(token ?? '').slice(0, 80);
  if (!tok || !env?.DB) return { ok: false, reason: 'that link carried no token' };
  await ensureMagicTable(env);

  const hash = await sha256hex(tok);
  const row = await env.DB.prepare(
    'SELECT token_hash, scout_id, email, expires_at, used_at FROM num_scout_magic WHERE token_hash = ?1',
  ).bind(hash).first().catch(() => null);

  if (!row) return { ok: false, reason: 'that link is not one we issued' };
  if (row.used_at) return { ok: false, reason: 'that link has already been used' };
  if (row.expires_at < nowSec()) return { ok: false, reason: 'that link has expired' };

  // Burn FIRST: if a mail client prefetches the link and the person then taps
  // it, only the request that actually changed a row proceeds.
  const burn = await env.DB.prepare(
    'UPDATE num_scout_magic SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL',
  ).bind(hash, nowSec()).run().catch(() => null);
  if (!burn?.meta?.changes) return { ok: false, reason: 'that link has already been used' };

  // Re-read the Expert at redeem, not only at mint. Somebody paused in the
  // twenty minutes since must not still get in on a link already in flight.
  const scout = await env.DB.prepare(
    'SELECT id, status FROM num_scouts WHERE id = ?1',
  ).bind(row.scout_id).first().catch(() => null);
  if (!scout || scout.status !== 'active') {
    return { ok: false, reason: 'that account is no longer active' };
  }
  return { ok: true, scoutId: scout.id, email: row.email };
}

/** A signed, expiring session for ONE Expert. */
export async function mintExpertSession(env, scoutId) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    kind: 'expert',
    sid: scoutId,
    exp: Date.now() + EXPERT_SESSION_HOURS * 3600_000,
  })));
  const sig = await hmac(env, SESSION_LABEL + payload);
  return sig ? `${payload}.${sig}` : null;
}

/** Read it back, or null. `kind` is checked, not merely carried. */
export async function expertClaims(env, token) {
  const [payload, sig] = String(token ?? '').split('.');
  if (!payload || !sig) return null;
  const expect = await hmac(env, SESSION_LABEL + payload);
  if (!expect || !safeEq(sig, expect)) return null;
  try {
    const c = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (c.kind !== 'expert' || typeof c.sid !== 'string' || !c.sid) return null;
    return typeof c.exp === 'number' && c.exp > Date.now() ? c : null;
  } catch {
    return null;
  }
}

/** Pull our cookie out of a Cookie header without a parser. */
export function expertCookie(cookieHeader) {
  const m = /(?:^|;\s*)num_expert_session=([^;]+)/.exec(String(cookieHeader ?? ''));
  return m ? decodeURIComponent(m[1]) : null;
}

/** The scout id this request proves it is, or null. */
export async function expertFromRequest(env, request) {
  const tok = expertCookie(request?.headers?.get?.('Cookie'));
  if (!tok) return null;
  const claims = await expertClaims(env, tok);
  return claims?.sid ?? null;
}

export const SESSION_COOKIE = (token) =>
  `num_expert_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${EXPERT_SESSION_HOURS * 3600}`;
