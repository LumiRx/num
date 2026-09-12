/**
 * crashlog.mjs — what broke, on whose phone, in their words and the machine's.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * 12 Sep 2026. Dre: "we need to fix the qr scan. when i tried to scan someone
 * can it said num stopped working." That sentence is the error boundary's
 * "Num stopped short." card, reported back the way a person reads it.
 *
 * And that was the entire evidence. The boundary caught the error, drew a
 * recovery card, called `gtag` — and gtag is analytics, which we cannot query
 * from here, on a device we do not have, for a build that has since changed.
 * So the only way to act on it was to guess which component threw, ship a
 * guess, and ask him to try again. That is the most expensive debugging loop
 * there is and he is the one paying for it.
 *
 * A crash the operator cannot read is a crash that gets fixed by guesswork.
 * This is one table and one route so the NEXT one arrives with the message,
 * the component that threw, the route it happened on and the phone it
 * happened on.
 *
 * ── WHAT IT DELIBERATELY DOES NOT COLLECT ────────────────────────────────
 * No member id, no name, no phone, no message content, no URL query string —
 * a connect code or a pay amount lives in the query and none of it helps fix
 * a render bug. The path is kept, the query is dropped. What lands here is
 * what an engineer needs and nothing a person would mind us having.
 *
 * ── WHY IT CANNOT BECOME A DENIAL-OF-SERVICE ─────────────────────────────
 * A crash loop is the normal shape of this bug: the app crashes, reloads,
 * crashes again. So the same fingerprint from the same device is written once
 * per window rather than once per crash, and the row carries a count. Ten
 * thousand rows saying the same thing is not ten thousand times the signal.
 */

/** How long the same fingerprint from the same device stays de-duplicated. */
export const DEDUPE_MINUTES = 30;

/** Nothing longer than this is stored, per field. Stacks are the long one. */
export const LIMITS = Object.freeze({ message: 300, stack: 1200, component: 900, path: 120, ua: 200, build: 40 });

const clip = (v, n) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, n) : null;
};

/**
 * The path, with the query thrown away.
 *
 * `/?c=ABCD2345` is a connect code and `/?p=mem_x&a=5000` is a payment
 * request. Neither helps fix a render crash and both are somebody's business.
 */
export function safePath(raw) {
  const s = String(raw ?? '');
  const cut = s.split(/[?#]/)[0];
  return clip(cut || '/', LIMITS.path);
}

/**
 * What makes two crashes "the same crash".
 *
 * Message plus the first frame of the stack. Not the whole stack: minified
 * bundles produce frames that differ by a column number between two reloads
 * of the identical build, and a fingerprint that changes every time
 * de-duplicates nothing.
 */
export function fingerprint({ message, stack }) {
  const first = String(stack ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
  return `${String(message ?? '').slice(0, 120)}|${first.slice(0, 120)}`;
}

let ready = new WeakSet();

/** Reset for tests. Production never calls this. */
export function __resetReady() { ready = new WeakSet(); }

export async function ensure(env) {
  if (!env?.DB || ready.has(env.DB)) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS num_app_crashes (
       id           INTEGER PRIMARY KEY AUTOINCREMENT,
       fingerprint  TEXT NOT NULL,
       device_hash  TEXT NOT NULL,
       message      TEXT,
       stack        TEXT,
       component    TEXT,
       path         TEXT,
       build        TEXT,
       ua           TEXT,
       surface      TEXT,
       times        INTEGER NOT NULL DEFAULT 1,
       first_at     TEXT NOT NULL DEFAULT (datetime('now')),
       last_at      TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  ).run();
  await env.DB.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS num_app_crashes_key ON num_app_crashes (fingerprint, device_hash, path)',
  ).run().catch(() => {});
  ready.add(env.DB);
}

/** A stable, non-identifying handle for "the same phone", good for one day. */
export async function deviceHash(ua, ip) {
  const material = `${String(ua ?? '')}|${String(ip ?? '')}|${new Date().toISOString().slice(0, 10)}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Record one crash. Returns what happened so the route can say so in a test.
 *
 * Never throws: this runs inside an error handler on a device that is already
 * having a bad time, and a failure here must not become a second failure.
 */
export async function record(env, input = {}, meta = {}) {
  if (!env?.DB) return { ok: false, reason: 'no database' };
  const message = clip(input.message, LIMITS.message);
  if (!message) return { ok: false, reason: 'no message' };
  try {
    await ensure(env);
    const fp = fingerprint({ message, stack: input.stack });
    const dev = await deviceHash(meta.ua, meta.ip);
    const path = safePath(input.path);

    const hit = await env.DB.prepare(
      `SELECT id, times FROM num_app_crashes
        WHERE fingerprint=?1 AND device_hash=?2 AND path=?3
          AND last_at > datetime('now', ?4)`,
    ).bind(fp, dev, path, `-${DEDUPE_MINUTES} minutes`).first();

    if (hit?.id) {
      await env.DB.prepare(
        "UPDATE num_app_crashes SET times = times + 1, last_at = datetime('now') WHERE id = ?1",
      ).bind(hit.id).run();
      return { ok: true, deduped: true, times: Number(hit.times) + 1 };
    }

    await env.DB.prepare(
      `INSERT INTO num_app_crashes (fingerprint, device_hash, message, stack, component, path, build, ua, surface)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    ).bind(
      fp, dev, message,
      clip(input.stack, LIMITS.stack),
      clip(input.component, LIMITS.component),
      path,
      clip(input.build, LIMITS.build),
      clip(meta.ua, LIMITS.ua),
      clip(input.surface, 40),
    ).run();
    return { ok: true, recorded: true };
  } catch (e) {
    console.warn('[crashlog] could not record', e?.message ?? e);
    return { ok: false, reason: 'write failed' };
  }
}

/** The last crashes, worst first. For the ops console and for asking D1 directly. */
export async function recent(env, { limit = 30 } = {}) {
  if (!env?.DB) return [];
  await ensure(env).catch(() => {});
  const { results } = await env.DB.prepare(
    `SELECT message, component, path, ua, build, times, first_at, last_at
       FROM num_app_crashes ORDER BY last_at DESC LIMIT ${Math.max(1, Math.min(200, limit | 0))}`,
  ).all().catch(() => ({ results: [] }));
  return results ?? [];
}

/**
 * POST /api/crash — the route the boundary calls.
 *
 * Always answers 200 with `{ok:true}`, whatever happened. The caller is an
 * error handler; telling it the error report failed gives it something new to
 * fail at, and there is nothing useful it could do with the news.
 */
export async function handleCrash(request, env) {
  let body = {};
  try { body = await request.json(); } catch { /* a crash report with no body is still a crash */ }
  const out = await record(env, body, {
    ua: request.headers.get('User-Agent'),
    ip: request.headers.get('CF-Connecting-IP'),
  });
  // `ok` last, deliberately: `out.ok` is whether the WRITE worked, and the
  // caller must not be told its error report failed. Spreading it after
  // `ok: true` would let a failed write answer `ok: false`, which is exactly
  // the news an error handler can do nothing with.
  return new Response(JSON.stringify({ ...out, ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
