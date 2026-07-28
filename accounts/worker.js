/**
 * NUM accounts — magic-link sign-in for HQ admins and business partners.
 * Mounted at itsnum.com/api/accounts* (see wrangler.jsonc). Separate Worker
 * from num-console; the console calls these endpoints from the browser.
 *
 * Tables (D1 "num-db"): businesses, accounts, magic_links, sessions.
 * Secret needed: RESEND_API_KEY  →  npx wrangler secret put RESEND_API_KEY --name num-accounts
 *
 * Endpoints:
 *   POST  /login              { email }              → always {ok:true}; emails a link if the account exists+active
 *   GET   /verify?token=...   (browser navigates here from the email) → sets session cookie, redirects to /console/
 *   GET   /me                                          → current session's account, or {signed_in:false}
 *   POST  /logout                                      → clears the session
 *   GET   /admin/list                                  → all accounts (admin only)
 *   POST  /admin/create       { email, display_name, role, permissions?, business_id? } → new pending account (admin only)
 *   POST  /admin/invite       { id }                   → sends that account its first/next magic link (admin only)
 *   PATCH /admin/:id          { status?, role?, permissions?, display_name?, email? }    → edit an account (admin only)
 *
 * Also mounted here, on a route of its own (itsnum.com/api/master*):
 *   GET   /api/master         [?fresh=1]              → the whole master database, one payload (admin only)
 */

import { handleMaster } from './master.js';
import { handleUnsubscribe, handleOpenPixel, handleClaimClick } from './invites.js';

const FROM = 'Num by 5arz <info@5arz.com>';
const REPLY_TO = 'info@5arz.com';
const SITE = 'https://itsnum.com';
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;        // 15 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}
function nowISO() { return new Date().toISOString(); }

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}
function sessionCookie(token, maxAgeSec) {
  return `num_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}
function clearSessionCookie() {
  return `num_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function sendMagicLinkEmail(env, account, token) {
  const link = `${SITE}/api/accounts/verify?token=${token}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [account.email],
      reply_to: REPLY_TO,
      subject: 'Your Num sign-in link',
      html: `<p>Hi ${account.display_name || 'there'},</p>
<p><a href="${link}">Click here to sign in to Num</a></p>
<p>This link works once and expires in 15 minutes. If you didn't request it, you can ignore this email.</p>`,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${errText.slice(0, 200)}`);
  }
}

async function getSessionAccount(env, request) {
  const token = parseCookies(request).num_session;
  if (!token) return null;
  const sess = await env.DB.prepare('SELECT * FROM sessions WHERE token = ?').bind(token).first();
  if (!sess || new Date(sess.expires_at) < new Date()) return null;
  const account = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(sess.account_id).first();
  if (!account || account.status !== 'active') return null;
  return account;
}
async function requireAdmin(env, request) {
  const account = await getSessionAccount(env, request);
  if (!account) return null;
  const perms = JSON.parse(account.permissions || '[]');
  if (account.role !== 'admin' && perms.indexOf('admin') === -1) return null;
  return account;
}

async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') === -1) return json({ error: 'invalid_email' }, 400);

  // Same response whether or not the account exists — don't leak who has access.
  const account = await env.DB.prepare('SELECT * FROM accounts WHERE lower(email) = ?').bind(email).first();
  if (account && account.status !== 'disabled') {
    const token = crypto.randomUUID();
    const expires = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString();
    await env.DB.prepare('INSERT INTO magic_links (token, account_id, expires_at) VALUES (?, ?, ?)')
      .bind(token, account.id, expires).run();
    try { await sendMagicLinkEmail(env, account, token); }
    catch (e) { console.log('Resend send failed: ' + e.message); }
    if (account.status === 'pending_contact') {
      await env.DB.prepare("UPDATE accounts SET status = 'invited' WHERE id = ?").bind(account.id).run();
    }
  }
  return json({ ok: true, message: 'If that email has Num access, a sign-in link is on its way.' });
}

async function handleVerify(env, url) {
  const token = url.searchParams.get('token') || '';
  const link = token && await env.DB.prepare('SELECT * FROM magic_links WHERE token = ?').bind(token).first();
  if (!link) return new Response('This link is invalid. Ask for a new one from the sign-in screen.', { status: 400 });
  if (link.used_at) return new Response('This link has already been used. Ask for a new one from the sign-in screen.', { status: 400 });
  if (new Date(link.expires_at) < new Date()) return new Response('This link has expired. Ask for a new one from the sign-in screen.', { status: 400 });

  await env.DB.prepare('UPDATE magic_links SET used_at = ? WHERE token = ?').bind(nowISO(), token).run();
  const account = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(link.account_id).first();
  if (!account || account.status === 'disabled') return new Response('This account is not active.', { status: 403 });

  await env.DB.prepare("UPDATE accounts SET status = 'active', last_login_at = ? WHERE id = ?")
    .bind(nowISO(), account.id).run();

  const sessToken = crypto.randomUUID();
  const sessExpires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await env.DB.prepare('INSERT INTO sessions (token, account_id, expires_at, user_agent) VALUES (?, ?, ?, ?)')
    .bind(sessToken, account.id, sessExpires, '').run();

  return new Response(null, {
    status: 302,
    headers: { Location: '/console/', 'Set-Cookie': sessionCookie(sessToken, SESSION_TTL_MS / 1000) },
  });
}

async function handleMe(env, request) {
  const account = await getSessionAccount(env, request);
  if (!account) return json({ signed_in: false });
  return json({
    signed_in: true,
    email: account.email,
    display_name: account.display_name,
    role: account.role,
    permissions: JSON.parse(account.permissions || '[]'),
    business_id: account.business_id,
    status: account.status,
  });
}

async function handleLogout(env, request) {
  const token = parseCookies(request).num_session;
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}

async function handleAdminList(env, request) {
  const admin = await requireAdmin(env, request);
  if (!admin) return json({ error: 'forbidden' }, 403);
  const { results } = await env.DB.prepare(
    'SELECT id, email, display_name, role, permissions, business_id, status, created_at, last_login_at FROM accounts ORDER BY created_at DESC'
  ).all();
  return json({ accounts: results });
}

async function handleAdminCreate(env, request) {
  const admin = await requireAdmin(env, request);
  if (!admin) return json({ error: 'forbidden' }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const email = body.email ? String(body.email).trim().toLowerCase() : null;
  const role = String(body.role || 'merchant');
  const permissions = JSON.stringify(Array.isArray(body.permissions) ? body.permissions : [role]);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO accounts (id, email, display_name, role, permissions, business_id, status, invited_by)
     VALUES (?, ?, ?, ?, ?, ?, 'pending_contact', ?)`
  ).bind(id, email, body.display_name || '', role, permissions, body.business_id || null, admin.email).run();
  return json({ ok: true, id });
}

async function handleAdminInvite(env, request) {
  const admin = await requireAdmin(env, request);
  if (!admin) return json({ error: 'forbidden' }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const account = body.id && await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(body.id).first();
  if (!account) return json({ error: 'not_found' }, 404);
  if (!account.email) return json({ error: 'no_email', message: 'Add an email to this account first.' }, 400);
  const token = crypto.randomUUID();
  const expires = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString();
  await env.DB.prepare('INSERT INTO magic_links (token, account_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, account.id, expires).run();
  await sendMagicLinkEmail(env, account, token);
  await env.DB.prepare("UPDATE accounts SET status = 'invited' WHERE id = ?").bind(account.id).run();
  return json({ ok: true });
}

async function handleAdminUpdate(env, request, id) {
  const admin = await requireAdmin(env, request);
  if (!admin) return json({ error: 'forbidden' }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const fields = [], values = [];
  if (body.status) { fields.push('status = ?'); values.push(body.status); }
  if (body.role) { fields.push('role = ?'); values.push(body.role); }
  if (body.permissions) { fields.push('permissions = ?'); values.push(JSON.stringify(body.permissions)); }
  if (body.display_name !== undefined) { fields.push('display_name = ?'); values.push(body.display_name); }
  if (body.email !== undefined) { fields.push('email = ?'); values.push(body.email ? String(body.email).trim().toLowerCase() : null); }
  if (!fields.length) return json({ error: 'no_fields' }, 400);
  values.push(id);
  await env.DB.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    try {
      // The master dashboard lives on this Worker rather than its own because
      // the admin session check lives here; a separate Worker would mean a
      // second copy of it, and two copies of an auth check drift.
      if (url.pathname.indexOf('/api/master') === 0) {
        if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
        return await handleMaster(env, request, requireAdmin);
      }

      const path = url.pathname.replace(/^\/api\/accounts/, '') || '/';

      // Invite endpoints — no session required, the token is the authorisation.
      // These run from an email client before anyone has ever signed in.
      // POST is accepted on /unsubscribe for RFC 8058 one-click.
      if (path === '/unsubscribe' && (method === 'GET' || method === 'POST')) return await handleUnsubscribe(env, request, url);
      if (path === '/i.gif' && method === 'GET') return await handleOpenPixel(env, url);
      if (path === '/claim' && method === 'GET') return await handleClaimClick(env, url);

      if (path === '/' && method === 'GET') return json({ ok: true, service: 'num-accounts' });
      if (path === '/login' && method === 'POST') return await handleLogin(request, env);
      if (path === '/verify' && method === 'GET') return await handleVerify(env, url);
      if (path === '/me' && method === 'GET') return await handleMe(env, request);
      if (path === '/logout' && method === 'POST') return await handleLogout(env, request);
      if (path === '/admin/list' && method === 'GET') return await handleAdminList(env, request);
      if (path === '/admin/create' && method === 'POST') return await handleAdminCreate(env, request);
      if (path === '/admin/invite' && method === 'POST') return await handleAdminInvite(env, request);
      if (path.indexOf('/admin/') === 0 && method === 'PATCH') return await handleAdminUpdate(env, request, path.slice('/admin/'.length));
      return json({ error: 'not_found' }, 404);
    } catch (err) {
      return json({ error: 'server_error', message: String((err && err.message) || err) }, 500);
    }
  },
};
