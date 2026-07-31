// Push notifications — the thing that turns Num from something you open into
// something that reaches you.
//
// Design decision worth stating: **we send an empty push.** No payload, no
// encryption. The push arrives as a bare wake-up, and the service worker then
// fetches the actual content from us over HTTPS.
//
// That is not laziness, it is better on three counts:
//   · Apple, Google and Mozilla's push servers never see what the message says.
//   · No 4KB payload ceiling, so a notification can carry a whole plan change.
//   · The content is fetched at DISPLAY time, so a notification that is already
//     stale — a table released, a friend who cancelled — corrects itself
//     instead of lying on the lock screen.
//
// The cost is one round trip when the phone wakes, which nobody notices.

const b64urlToBytes = (s) => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const bytesToB64url = (b) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const readBody = async (req) => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_push_subs (
  endpoint TEXT PRIMARY KEY, member_id TEXT, ua TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), last_ok TEXT, fails INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_member ON num_push_subs(member_id);
CREATE TABLE IF NOT EXISTS num_notifications (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL, kind TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT, url TEXT, tag TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT, read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_member ON num_notifications(member_id, id);
`;
let ready = false;
async function ensure(env) {
  if (ready) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

export const pushReady = (env) => !!(env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);

/**
 * The VAPID JWT that proves to a push service we are who we say we are.
 * ES256 over {aud, exp, sub}, signed with the private key.
 */
async function vapidHeader(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64url(
    new TextEncoder().encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })),
  );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    b64urlToBytes(env.VAPID_PRIVATE_KEY),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${header}.${payload}`));
  return `vapid t=${header}.${payload}.${bytesToB64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

/**
 * Queue a notification and wake every device this member has.
 *
 * `tag` collapses: a second "your table moved" replaces the first on the lock
 * screen rather than stacking. Nobody wants four notifications about one table.
 */
export async function notify(env, { memberId, kind, title, body, url, tag, ctx }) {
  if (!env.DB || !memberId) return { sent: 0 };
  await ensure(env);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO num_notifications (id, member_id, kind, title, body, url, tag) VALUES (?1,?2,?3,?4,?5,?6,?7)',
  ).bind(id, memberId, kind, clip(title, 120), clip(body, 300), clip(url, 300), clip(tag, 60) ?? kind).run();

  if (!pushReady(env)) return { sent: 0, queued: id, note: 'push keys not configured — it will show next time they open Num' };

  const { results: subs } = await env.DB.prepare('SELECT endpoint FROM num_push_subs WHERE member_id=?1 AND fails < 5').bind(memberId).all();
  const send = Promise.all((subs ?? []).map((s) => wake(env, s.endpoint)));
  if (ctx?.waitUntil) ctx.waitUntil(send);
  else await send;
  return { sent: (subs ?? []).length, queued: id };
}

/** A bare push: no body, just "there is something for you". */
async function wake(env, endpoint) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidHeader(env, endpoint),
        TTL: '86400',
        Urgency: 'normal',
        'Content-Length': '0',
      },
    });
    if (res.status === 404 || res.status === 410) {
      // The subscription is dead — the app was uninstalled or the browser
      // rotated it. Delete rather than retry forever.
      await env.DB.prepare('DELETE FROM num_push_subs WHERE endpoint=?1').bind(endpoint).run();
      return false;
    }
    if (!res.ok) {
      await env.DB.prepare('UPDATE num_push_subs SET fails = fails + 1 WHERE endpoint=?1').bind(endpoint).run();
      return false;
    }
    await env.DB.prepare("UPDATE num_push_subs SET last_ok = datetime('now'), fails = 0 WHERE endpoint=?1").bind(endpoint).run();
    return true;
  } catch (err) {
    console.warn('[push] wake failed', err?.message ?? err);
    return false;
  }
}

// ── routes ────────────────────────────────────────────────────────────────

export async function handlePush(request, env, path, ctx) {
  if (!env.DB) return json({ error: 'push needs the database binding' }, 503);
  await ensure(env);
  const url = new URL(request.url);
  const post = request.method === 'POST';

  try {
    // What the app needs to decide whether to even ask for permission.
    if (path === '/config') {
      return json({ enabled: pushReady(env), public_key: env.VAPID_PUBLIC_KEY ?? null });
    }

    if (path === '/subscribe' && post) {
      const b = await readBody(request);
      const endpoint = clip(b.subscription?.endpoint, 500);
      if (!endpoint) return json({ error: 'subscription required' }, 400);
      await env.DB.prepare(
        `INSERT INTO num_push_subs (endpoint, member_id, ua) VALUES (?1,?2,?3)
         ON CONFLICT(endpoint) DO UPDATE SET member_id=excluded.member_id, fails=0`,
      ).bind(endpoint, clip(b.me, 40), clip(request.headers.get('User-Agent'), 200)).run();
      return json({ ok: true });
    }

    if (path === '/unsubscribe' && post) {
      const b = await readBody(request);
      await env.DB.prepare('DELETE FROM num_push_subs WHERE endpoint=?1').bind(clip(b.endpoint, 500) ?? '').run();
      return json({ ok: true });
    }

    // The service worker calls this when a push wakes it. Content lives here,
    // not in the push, so it is always current at the moment it is shown.
    if (path === '/pending') {
      const me = url.searchParams.get('me');
      if (!me) return json({ notifications: [] });
      const { results } = await env.DB.prepare(
        'SELECT id, kind, title, body, url, tag FROM num_notifications WHERE member_id=?1 AND delivered_at IS NULL ORDER BY rowid LIMIT 5',
      ).bind(me).all();
      if (results?.length) {
        await env.DB.prepare(
          `UPDATE num_notifications SET delivered_at = datetime('now') WHERE id IN (${results.map((_, i) => '?' + (i + 1)).join(',')})`,
        ).bind(...results.map((r) => r.id)).run();
      }
      return json({ notifications: results ?? [] });
    }

    // Everything recent, for an in-app list.
    if (path === '/history') {
      const me = url.searchParams.get('me');
      if (!me) return json({ error: 'me required' }, 400);
      const { results } = await env.DB.prepare(
        'SELECT id, kind, title, body, url, created_at, read_at FROM num_notifications WHERE member_id=?1 ORDER BY rowid DESC LIMIT 30',
      ).bind(me).all();
      return json({ notifications: results ?? [] });
    }

    // A real end-to-end test the operator can fire at their own phone.
    if (path === '/test' && post) {
      const b = await readBody(request);
      if (!env.ADMIN_KEY || request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) return json({ error: 'unauthorized' }, 401);
      const out = await notify(env, {
        memberId: clip(b.me, 40),
        kind: 'test',
        title: b.title ?? 'Num',
        body: b.body ?? 'If you can read this, push is working.',
        url: '/?app',
        ctx,
      });
      return json(out);
    }

    return json({ error: 'not found' }, 404);
  } catch (err) {
    console.error('[push]', path, err?.message ?? err);
    return json({ error: 'that didn’t go through' }, 500);
  }
}
