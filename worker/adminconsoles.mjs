/**
 * "Open that venue's console" -- the door /ops never had.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * NUM has three consoles and the operator could only enter one of them.
 *
 *   /ops             admin session, minted from ADMIN_KEY      (app worker)
 *   /biz             a venue's email session, or its console_key  (growth)
 *   /host/?k=        a host's console_key                         (growth)
 *
 * So "check the business console works" meant finding a real venue's permanent
 * console_key and putting it in a URL. That key never expires, it is owner-level
 * on every endpoint that guards itself with bizAuth, and a URL carrying it
 * leaks into history, referrers and screenshots. Doing that routinely, from an
 * admin page, would have made the leak a habit.
 *
 * Instead this mints a SINGLE-USE token with a five-minute life. The operator
 * is sent to itsnum.com/o/<token>; the growth worker burns it and grants a
 * short session scoped to that one business. The permanent key is never handled.
 *
 * ── WHY THE TWO WORKERS DO NOT TALK TO EACH OTHER ────────────────────────
 *
 * /ops runs on app.itsnum.com and holds NO admin key -- only a minted session
 * token the app worker can verify. It therefore cannot call growth's
 * ADMIN_KEY-gated endpoints, and giving the browser the real key to fix that
 * would be strictly worse than the problem being solved.
 *
 * Both workers bind the same D1 (num-db). The table IS the handoff. No shared
 * secret crosses the browser, no CORS, and the row left behind is the audit
 * trail.
 */

const OPEN_TTL_S = 300;          // clicked from the page it was minted on
const SITE = 'https://itsnum.com';

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

/**
 * Everything an operator can open, and nothing else.
 *
 * Inactive businesses are listed but not openable: a console that refuses on
 * arrival reads as broken software, while a row that says WHY it cannot be
 * opened answers the question the operator actually had.
 */
export async function listConsoles(env) {
  const biz = await env.DB.prepare(
    'SELECT id, name, status FROM businesses ORDER BY (status = \'active\') DESC, name',
  ).all().catch(() => ({ results: [] }));

  const hosts = await env.DB.prepare(
    'SELECT id, name, email FROM num_hosts ORDER BY name',
  ).all().catch(() => ({ results: [] }));

  const recent = await env.DB.prepare(
    `SELECT kind, target_name, created_at, used_at
       FROM num_admin_console_opens ORDER BY created_at DESC LIMIT 10`,
  ).all().catch(() => ({ results: [] }));

  return {
    site: SITE,
    ttl_s: OPEN_TTL_S,
    businesses: biz.results || [],
    hosts: hosts.results || [],
    recent: recent.results || [],
  };
}

/**
 * Mint one open link. The caller is already past the admin gate.
 *
 * The target is looked up rather than trusted: an id that does not name a real
 * business or host must fail HERE, at the moment the operator can still read
 * the reason, not thirty seconds later on a page that says "sign in".
 */
export async function mintConsoleOpen(env, request) {
  let body;
  try { body = await request.json(); } catch { return { ok: false, error: 'that request was not readable' }; }

  const kind = String(body?.kind || '');
  const id = String(body?.id || '').slice(0, 80);
  if (kind !== 'biz' && kind !== 'host') return { ok: false, error: 'kind must be "biz" or "host"' };
  if (!id) return { ok: false, error: 'no id was given' };

  const row = kind === 'biz'
    ? await env.DB.prepare('SELECT id, name, status FROM businesses WHERE id = ?1')
        .bind(id).first().catch(() => null)
    : await env.DB.prepare('SELECT id, name FROM num_hosts WHERE id = ?1')
        .bind(id).first().catch(() => null);

  if (!row) {
    return { ok: false, error: kind === 'biz' ? 'no business has that id' : 'no host has that id' };
  }
  // A suspended venue's console is suspended for a reason, and an admin
  // preview is not a way around it.
  if (kind === 'biz' && row.status !== 'active') {
    return { ok: false, error: `that business is "${row.status}", not active -- its console does not open for anyone` };
  }

  const token = newToken();
  const t = nowSec();

  await env.DB.prepare(
    `INSERT INTO num_admin_console_opens
       (token_hash, kind, target_id, target_name, expires_at, created_at, created_ip)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(
    await sha256hex(token), kind, row.id, row.name || null,
    t + OPEN_TTL_S, t, request.headers.get('cf-connecting-ip') || null,
  ).run();

  return { ok: true, url: `${SITE}/o/${token}`, expires_in: OPEN_TTL_S, kind, name: row.name || row.id };
}
