/**
 * Signing in to /ops with an email link instead of a key.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * 14 Sep 2026. Five sign-in attempts in one evening, every one recorded ok=0,
 * and the operator locked out of his own console. The page was not at fault:
 * ADMIN_KEY is a Worker secret, so when the value in someone's head stops
 * matching the value in the Worker there is no way to compare them, no way to
 * read either one back, and no way in. The only remedy was to overwrite the
 * secret and hope the next guess matched.
 *
 * A credential nobody can read, that has to be remembered exactly, with no
 * recovery path, is the wrong shape for a door a person uses. So the human
 * door is now an emailed link to an address on an allowlist -- the same
 * mechanism the business console has used since it was built, and one where
 * "I cannot get in" is answered by opening your inbox.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────
 *
 * It does not remove ADMIN_KEY. Scripts, the growth Worker's /api/admin/*
 * routes and every X-Admin-Key caller still depend on it, and it stays as the
 * break-glass door for when mail itself is the thing that is broken. What
 * changes is that a person is no longer required to type it.
 *
 * The session it produces is the SAME signed session the key path mints, so
 * isAdmin, the ops page and every admin route are untouched by this file.
 */

export const ADMIN_MAGIC_TTL_S = 20 * 60;   // a link is useful for one sitting

const nowSec = () => Math.floor(Date.now() / 1000);

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newToken(bytes = 24) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const lc = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Who may ask for a link.
 *
 * ADMIN_EMAILS (comma separated) if set, otherwise ADMIN_EMAIL, which this
 * Worker already carries. Empty means nobody -- the same fail-closed rule
 * worker/adminkey.mjs applies to an unset key, and for the same reason: an
 * admin door with no allowlist configured is a door for everyone.
 */
export function adminEmails(env) {
  const raw = env?.ADMIN_EMAILS || env?.ADMIN_EMAIL || '';
  return String(raw).split(',').map(lc).filter(Boolean);
}

export const TABLE = `
CREATE TABLE IF NOT EXISTS num_admin_magic (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL,
  created_ip TEXT
);`;

let tableReady = false;
async function ensure(env) {
  if (tableReady) return;
  await env.DB.prepare(TABLE.trim()).run();
  tableReady = true;
}

/**
 * Mint a link and mail it. Returns what happened, never whether the address
 * was on the list: the reply is identical either way, because a door that
 * says "not an admin" is a door that tells you which address to attack.
 */
export async function startAdminMagic(env, req, origin) {
  let email = '';
  try { email = lc((await req.formData()).get('email')); } catch { /* invalid form */ }

  const allowed = adminEmails(env);
  if (!email || !allowed.includes(email)) return { ok: true, sent: false };

  await ensure(env);
  const token = newToken();
  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO num_admin_magic (token_hash,email,expires_at,created_at,created_ip)
     VALUES (?1,?2,?3,?4,?5)`,
  ).bind(await sha256hex(token), email, t + ADMIN_MAGIC_TTL_S, t,
         req.headers.get('CF-Connecting-IP') || null).run();

  const link = `${origin}/api/admin/magic?t=${encodeURIComponent(token)}`;
  const { send } = await import('./mailer.mjs');
  const out = await send(env, {
    // `bulk` here means "no blind copies", which is the only thing it controls
    // in mailer.normalise. This Worker sets MAIL_BCC to a SHARED inbox, and
    // every message it sends is copied there. A single-use admin sign-in link
    // copied to a second mailbox is a second way into the console — the exact
    // property this door exists to keep to one person. Nothing else the Worker
    // mails is a credential, which is why the default is right for them and
    // wrong for this.
    bulk: true,
    // This Worker's default Reply-To is on a DIFFERENT domain from the From
    // address. Harmless on ordinary mail, a phishing signal on a message whose
    // whole content is "click this link to get in" — a filter reads From on one
    // domain, Reply-To on another, and a single bare URL. Keep this one
    // consistent with itself.
    replyTo: 'hello@itsnum.com',
    to: email,
    subject: 'Your NUM Ops sign-in link',
    text: `Open the operator console:\n\n${link}\n\n`
        + `This link works once and expires in 20 minutes.\n`
        + `If you did not ask for it, someone knows an admin address — nothing else.\n`,
  });

  return { ok: true, sent: true, mailed: !!out?.ok, error: out?.ok ? null : (out?.error || 'mail refused') };
}

/** Redeem exactly once. The caller mints the session. */
export async function redeemAdminMagic(env, token) {
  const tok = String(token ?? '').slice(0, 80);
  if (!tok) return { ok: false, reason: 'that link carried no token' };
  await ensure(env);

  const hash = await sha256hex(tok);
  const row = await env.DB.prepare(
    'SELECT token_hash,email,expires_at,used_at FROM num_admin_magic WHERE token_hash = ?1',
  ).bind(hash).first().catch(() => null);

  // Three sentences, not one. Only one of them means "ask for another link".
  if (!row) return { ok: false, reason: 'that link is not one we issued' };
  if (row.used_at) return { ok: false, reason: 'that link has already been used' };
  if (row.expires_at < nowSec()) return { ok: false, reason: 'that link has expired' };

  // Burn first: if two taps race, only the one that changed a row proceeds.
  const burn = await env.DB.prepare(
    'UPDATE num_admin_magic SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL',
  ).bind(hash, nowSec()).run().catch(() => null);
  if (!burn?.meta?.changes) return { ok: false, reason: 'that link has already been used' };

  // Re-checked at redeem, not only at mint: an address removed from the
  // allowlist in the twenty minutes since must not still let someone in.
  if (!adminEmails(env).includes(lc(row.email))) {
    return { ok: false, reason: 'that address is no longer an operator' };
  }
  return { ok: true, email: row.email };
}
