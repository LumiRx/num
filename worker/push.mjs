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
  title TEXT NOT NULL, subtitle TEXT, body TEXT, url TEXT, tag TEXT,
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

// ALL THREE, or push is a lie. VAPID_PUBLIC_KEY was missing from this check
// while vapidHeader() interpolates it into every request — so with it unset
// the header read `k=undefined`, every push service rejected the send, wake()
// swallowed the failure, notify() still reported success, and /api/version
// cheerfully said `push: true`. Silent, total, and invisible from every
// surface we had. The predicate now covers what the code actually uses.
export const pushReady = (env) => !!(env.VAPID_PRIVATE_KEY && env.VAPID_PUBLIC_KEY && env.VAPID_SUBJECT);

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
export async function notify(env, { memberId, kind, title, subtitle, body, url, tag, ctx }) {
  if (!env.DB || !memberId) return { sent: 0 };
  await ensure(env);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO num_notifications (id, member_id, kind, title, subtitle, body, url, tag) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)',
  ).bind(id, memberId, kind, clip(title, 120), clip(subtitle, 120), clip(body, 300), clip(url, 300), clip(tag, 60) ?? kind).run();

  // ── WHY notify() FANS OUT TO NATIVE ITSELF (14 Sep 2026) ────────────────
  //
  // notifyAll() was written to do this. It had forty-two sibling call sites and
  // zero of its own: every real notification in the product called notify(),
  // which woke web-push subscriptions and nothing else. The whole APNs sender
  // was reachable only from its tests.
  //
  // The fix is not "change forty-two call sites to say notifyAll" — that is a
  // rule nobody can keep, and the forty-third will be written next week. There
  // is one door, and the door goes everywhere.
  const native = await pushNative(env, { memberId, title, subtitle, body, url, kind, notifId: id, tag })
    .catch((e) => {
      console.warn('[push] native fan-out failed', e?.message ?? e);
      return { sent: 0, error: String(e?.message ?? e) };
    });

  if (!pushReady(env)) {
    if (!native.sent) {
      console.warn(`[push] NOBODY REACHED for member ${String(memberId).slice(0, 8)}… (no web keys, no native tokens) — it will only show when they next open Num`);
    }
    return { sent: 0, native, reached: native.sent || 0, queued: id, note: 'web push keys not configured' };
  }

  const { results: subs } = await env.DB.prepare('SELECT endpoint FROM num_push_subs WHERE member_id=?1 AND fails < 5').bind(memberId).all();
  const send = Promise.all((subs ?? []).map((s) => wake(env, s.endpoint)));
  if (ctx?.waitUntil) ctx.waitUntil(send);
  else await send;

  const web = (subs ?? []).length;
  const reached = web + (native.sent || 0);
  // Said out loud, because "queued" on its own is what let 116 of 117
  // notifications look fine while reaching nobody.
  if (!reached) {
    console.warn(
      `[push] NOBODY REACHED for member ${String(memberId).slice(0, 8)}… ` +
      `(web subs: 0, native tokens: 0) — it will only show when they next open Num`,
    );
  }
  return { sent: web, native, reached, queued: id };
}

/**
 * Queue a notification and reach every device — web AND native.
 *
 * Use this rather than notify() for anything new. notify() keeps its exact
 * behaviour so nothing that already calls it changes, and this wraps it.
 *
 * The two channels are independent on purpose. Web push needs VAPID keys; APNs
 * needs an Apple key. Either can be configured without the other, and a member
 * with both a browser and the app should hear once on each rather than have one
 * silently win. What must never happen is the thing that was happening: a
 * notification written to the table, nothing configured to carry it, and a
 * cheerful success returned.
 */
/** Kept as the name some callers and tests already use. notify() is now the
 *  one door and does the whole fan-out, so this is a straight alias — calling
 *  the old two-step here would send every native push twice. */
export const notifyAll = (env, opts) => notify(env, opts);

/**
 * Send to this member's Apple devices.
 *
 * Records the outcome per token: a success refreshes last_ok, a dead token is
 * disabled with Apple's own reason on it, and anything else increments fails.
 * A token Apple has told us is gone must stop being used — retrying it forever
 * is what gets a provider throttled and buries the real failures in noise.
 */
export async function pushNative(env, { memberId, title, subtitle, body, url, kind, tag, notifId, badge }) {
  if (!env.DB || !memberId) return { sent: 0 };
  const { apnsReady, sendApns, apnsMissing } = await import('./apns.mjs');
  if (!apnsReady(env)) {
    return { sent: 0, note: `APNs not configured — missing ${apnsMissing(env).join(', ')}` };
  }

  const { results: tokens } = await env.DB.prepare(
    `SELECT id, token, platform, environment, bundle_id FROM num_push_tokens
      WHERE member_id = ?1 AND disabled_at IS NULL AND fails < 5`
  ).bind(memberId).all().catch((e) => {
    console.warn('[push] token read failed (is 0023 applied?)', e?.message ?? e);
    return { results: [] };
  });

  let sent = 0;
  const dead = [];
  for (const t of tokens ?? []) {
    if (t.platform !== 'ios') continue; // Android goes through FCM, a later build.
    const r = await sendApns(env, {
      token: t.token,
      environment: t.environment,
      bundleId: t.bundle_id,
      title, subtitle, body, url, kind, notifId,
      collapseId: tag || kind,
      badge,
    });

    if (r.ok) {
      sent++;
      await env.DB.prepare("UPDATE num_push_tokens SET last_ok = datetime('now'), fails = 0 WHERE id = ?1")
        .bind(t.id).run().catch(() => {});
      continue;
    }

    // A token for the other environment is not a failure worth counting. Left
    // alone so that configuring the matching key later simply starts working.
    if (r.reason === 'WrongEnvironmentForKey') {
      console.warn(`[push] skipping ${t.environment} token — the configured APNs key serves the other environment`);
      continue;
    }

    if (r.dead) {
      dead.push(r.reason);
      await env.DB.prepare(
        "UPDATE num_push_tokens SET disabled_at = datetime('now'), disabled_reason = ?1 WHERE id = ?2"
      ).bind(`apns:${r.reason}`, t.id).run().catch(() => {});
      continue;
    }

    console.warn(`[push] APNs ${r.status} ${r.reason} for token ${String(t.token).slice(0, 8)}…`);
    await env.DB.prepare('UPDATE num_push_tokens SET fails = fails + 1 WHERE id = ?1')
      .bind(t.id).run().catch(() => {});
  }
  return { sent, tokens: (tokens ?? []).length, dead };
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
        'SELECT id, kind, title, subtitle, body, url, tag FROM num_notifications WHERE member_id=?1 AND delivered_at IS NULL ORDER BY rowid LIMIT 5',
      ).bind(me).all();
      if (results?.length) {
        await env.DB.prepare(
          `UPDATE num_notifications SET delivered_at = datetime('now') WHERE id IN (${results.map((_, i) => '?' + (i + 1)).join(',')})`,
        ).bind(...results.map((r) => r.id)).run();
      }
      return json({ notifications: results ?? [] });
    }

    /* ── THE ROUTE THAT DID NOT EXIST ─────────────────────────────────────
     *
     * src/lib/native.ts has POSTed here since the native shell shipped. There
     * was no handler, so every iPhone user who granted notification permission
     * had that permission thrown away — and the client's catch swallowed the
     * 404, so nothing anywhere said so.
     *
     * Upsert on the token, never insert blindly: a device that re-registers
     * (app update, reinstall, token rotation) must update its row. A second row
     * for the same device means every notification arrives twice, which is worse
     * than not arriving.
     */
    if (path === '/native' && post) {
      const b = await readBody(request);
      const token = clip(b.token, 200);
      const me = clip(b.me, 64);
      const platform = b.platform === 'android' ? 'android' : b.platform === 'ios' ? 'ios' : null;

      if (!token || !me) return json({ ok: false, error: 'token and me required' }, 400);
      if (!platform) return json({ ok: false, error: "platform must be 'ios' or 'android'" }, 400);

      // A device token is hex from Apple. Refusing anything else keeps junk out
      // of a table whose whole job is to be dialled.
      if (platform === 'ios' && !/^[0-9a-fA-F]{32,200}$/.test(token)) {
        return json({ ok: false, error: 'that does not look like an APNs token' }, 400);
      }

      // Which APNs door this token belongs to. A sandbox token sent to the
      // production host fails with BadDeviceToken, and that single mismatch is
      // the commonest reason someone concludes push is broken. The client says
      // so when it knows; production is the safe default for a shipped app.
      const environment = b.environment === 'sandbox' ? 'sandbox' : 'production';

      try {
        await env.DB.prepare(
          `INSERT INTO num_push_tokens
             (id, member_id, token, platform, environment, bundle_id, app_version, device_model, created_at, updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,datetime('now'),datetime('now'))
           ON CONFLICT(token) DO UPDATE SET
             member_id       = excluded.member_id,
             platform        = excluded.platform,
             environment     = excluded.environment,
             bundle_id       = COALESCE(excluded.bundle_id, num_push_tokens.bundle_id),
             app_version     = COALESCE(excluded.app_version, num_push_tokens.app_version),
             device_model    = COALESCE(excluded.device_model, num_push_tokens.device_model),
             updated_at      = datetime('now'),
             fails           = 0,
             disabled_at     = NULL,
             disabled_reason = NULL`
        ).bind(
          crypto.randomUUID(), me, token, platform, environment,
          clip(b.bundle_id, 120) || env.APNS_BUNDLE_ID || null,
          clip(b.app_version, 40), clip(b.device_model, 80),
        ).run();
      } catch (e) {
        // Loud. A token we cannot store is a person we can never reach, and the
        // old behaviour — a silent 404 — is exactly what this route exists to end.
        console.warn('[push] could not store native token:', e?.message ?? e);
        return json({ ok: false, error: 'could not store that token', detail: String(e?.message ?? e).slice(0, 200) }, 503);
      }

      const { apnsReady, apnsMissing } = await import('./apns.mjs');
      return json({
        ok: true,
        // Honest about whether this token can actually be used yet, rather than
        // a bare ok that means "stored and unusable".
        sendable: apnsReady(env),
        ...(apnsReady(env) ? {} : { note: `stored, but sending needs ${apnsMissing(env).join(', ')}` }),
      });
    }

    /* Marking one read.
     *
     * read_at has existed on num_notifications since the table was created and
     * NOTHING has ever written it — so "0 of 117 read" was unknowable rather
     * than true. Without this, there is no way to tell a suggestion somebody was
     * glad to get from one that annoyed them, and no honest basis for sending
     * more of either.
     *
     * `acted` is the stronger signal: they did not just see it, they tapped
     * through. That is the number worth optimising, and the only one that says a
     * notification earned its interruption.
     */
    if (path === '/read' && post) {
      const b = await readBody(request);
      const me = clip(b.me, 64);
      const ids = Array.isArray(b.ids) ? b.ids.slice(0, 50).map((x) => clip(x, 64)).filter(Boolean)
        : (clip(b.id, 64) ? [clip(b.id, 64)] : []);
      if (!me) return json({ ok: false, error: 'me required' }, 400);
      if (!ids.length) return json({ ok: false, error: 'id or ids required' }, 400);

      // member_id is in the WHERE clause, so one person cannot mark another's
      // notifications read even knowing the id.
      const col = b.acted ? 'acted_at' : 'read_at';
      try {
        // Always set read_at: an acted notification was necessarily read. Setting
        // only acted_at would leave a tapped notification looking unseen.
        const setCol = col === 'read_at' ? '' : `, ${col} = COALESCE(${col}, datetime('now'))`;
        const r = await env.DB.prepare(
          `UPDATE num_notifications
              SET read_at = COALESCE(read_at, datetime('now'))${setCol}
            WHERE member_id = ?1 AND id IN (${ids.map((_, i) => '?' + (i + 2)).join(',')})`
        ).bind(me, ...ids).run();
        return json({ ok: true, marked: r?.meta?.changes ?? 0, acted: !!b.acted });
      } catch (e) {
        console.warn('[push] read mark failed (is 0023 applied?)', e?.message ?? e);
        return json({ ok: false, error: 'could not record that', detail: String(e?.message ?? e).slice(0, 200) }, 503);
      }
    }

    // Everything recent, for an in-app list.
    if (path === '/history') {
      const me = url.searchParams.get('me');
      if (!me) return json({ error: 'me required' }, 400);
      const { results } = await env.DB.prepare(
        'SELECT id, kind, title, subtitle, body, url, created_at, read_at FROM num_notifications WHERE member_id=?1 ORDER BY rowid DESC LIMIT 30',
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
