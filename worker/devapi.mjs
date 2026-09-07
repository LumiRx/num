/**
 * NUM FOR AI — the self-serve developer API.
 *
 * ── What this is for (7 Sep 2026) ─────────────────────────────────────────
 *
 * Dre: "let them sign up for our api for their users, for their own
 * information for the local areas."
 *
 * Num already answers "what is good near me" better than almost anything, in
 * 77 destinations, from a directory it verifies itself. Until now the only way
 * to reach that was to be a Num guest. This lets somebody else's product — a
 * hotel app, a travel agent's assistant, another AI — sign up in a minute, get
 * a key, and serve their own users local information.
 *
 * It is a second business on the same asset. The directory does not cost more
 * to read twice, and every developer who builds on it is a distribution
 * channel that costs us nothing to acquire.
 *
 * ── FOUR RULES, and each one is here because the alternative bites ────────
 *
 * 1. THE KEY IS NEVER STORED. We keep a SHA-256 hash and the last four
 *    characters. A key is shown exactly once, at creation. If our database
 *    leaks, it leaks a list of hashes, and nobody's integration is
 *    compromised. Storing keys in plaintext is the single most common way a
 *    developer API becomes an incident, and it is entirely avoidable.
 *
 * 2. READ-ONLY, AND NO PEOPLE. The scopes below cover places, events and
 *    answers. There is NO scope for bookings, orders, members, or anything
 *    carrying a person — because a key that can be pasted into someone's
 *    hobby project must not be able to make a stranger's phone ring or read
 *    a guest's address. That is not a limitation to lift later; it is what
 *    makes issuing a key in one click defensible at all.
 *
 * 3. EVERY KEY IS ATTRIBUTABLE AND REVOCABLE. One row, one owner, one email,
 *    a live call count and an off switch. An anonymous key is a key you can
 *    only turn off by turning everybody off.
 *
 * 4. THE FREE TIER IS REAL AND THE CAP IS HONEST. 1,000 calls a day, stated
 *    up front, counted per UTC day, and the refusal says when it resets. A
 *    limit somebody discovers by failing is a limit that costs us a developer.
 */

const DAY = () => new Date().toISOString().slice(0, 10);
const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n));
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/**
 * What a developer key may do. Read-only, and nothing that touches a person.
 *
 * Adding a scope here is a decision about what a stranger's script may do with
 * our directory and our partners' phone numbers. It is not a config change.
 */
export const SCOPES = Object.freeze({
  'places:read': 'Verified places near a point — name, category, address, opening hours, link.',
  'events:read': 'What is on in a destination, from the event sources Num has connected.',
  'answer': 'Ask Num a travel question in words and get a concierge answer back.',
});

/** Scopes a key gets by default. Same as the full list today, deliberately. */
export const DEFAULT_SCOPES = Object.freeze(Object.keys(SCOPES));

/** Calls per UTC day on the free tier. */
export const FREE_DAILY = 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_dev_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  tail TEXT NOT NULL,
  app_name TEXT NOT NULL,
  email TEXT NOT NULL,
  website TEXT,
  scopes TEXT NOT NULL,
  daily_cap INTEGER NOT NULL DEFAULT ${FREE_DAILY},
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS num_dev_usage (
  key_id TEXT NOT NULL, day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);
CREATE INDEX IF NOT EXISTS idx_num_dev_keys_email ON num_dev_keys(email);
`;
// Readiness is tracked PER DATABASE, not as a module-level boolean.
//
// A bare `let ready = false` is the usual shape and it is subtly wrong: the
// flag outlives the database it describes. In production that never shows,
// because an isolate has one DB for its whole life. In a test — and in any
// future where this Worker talks to a second database — the first `ensure()`
// sets the flag and every later database is used without ever being created.
// The WeakSet costs nothing and cannot be wrong.
const readied = new WeakSet();
async function ensure(env) {
  if (!env?.DB || readied.has(env.DB)) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  readied.add(env.DB);
}

/** SHA-256, hex. The only form of a key that ever touches storage. */
export async function hashKey(key) {
  const bytes = new TextEncoder().encode(String(key));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A new key. Prefixed so that a key found in a log or a public repo is
 * instantly recognisable as ours — which is what lets a secret scanner tell
 * somebody they have leaked it before anybody else notices.
 */
export function mintKey() {
  const raw = crypto.getRandomValues(new Uint8Array(24));
  const body = [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `num_live_${body}`;
}

const EMAIL_OK = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;

/**
 * Sign up and get a key.
 *
 * The key is in the response and NOWHERE ELSE, ever again. That is said in the
 * response itself, because a developer who assumes they can come back for it
 * is a support ticket we cannot resolve.
 */
export async function issue(env, { app_name, email, website } = {}) {
  await ensure(env);
  const name = clip(app_name, 80);
  const mail = clip(email, 160)?.toLowerCase();
  if (!name) return { ok: false, error: 'What is the app called?', status: 400 };
  if (!mail || !EMAIL_OK.test(mail)) return { ok: false, error: 'A working email, so we can reach you if something changes.', status: 400 };

  // A soft cap on keys per email. Not security — anybody determined can use
  // another address — but it stops a loop from filling the table by accident,
  // which is the failure that actually happens.
  const mine = await env.DB.prepare("SELECT COUNT(*) n FROM num_dev_keys WHERE email=?1 AND revoked_at IS NULL")
    .bind(mail).first().catch(() => ({ n: 0 }));
  if (Number(mine?.n ?? 0) >= 5) {
    return { ok: false, status: 429, error: 'That address already has five active keys. Revoke one, or write to us if you need more.' };
  }

  const key = mintKey();
  const id = `dk_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await env.DB.prepare(
    `INSERT INTO num_dev_keys (id, key_hash, tail, app_name, email, website, scopes, daily_cap)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
  ).bind(id, await hashKey(key), key.slice(-4), name, mail, clip(website, 200), DEFAULT_SCOPES.join(' '), FREE_DAILY).run();

  return {
    ok: true,
    key,
    key_id: id,
    scopes: DEFAULT_SCOPES,
    daily_cap: FREE_DAILY,
    // Said here rather than in a docs page nobody reads at the moment it
    // matters, which is this one.
    keep_it: 'This key is shown once and is not stored anywhere we can read it back. Save it now. If you lose it, revoke it and take another.',
    how: 'Send it as the header  Authorization: Bearer <key>  on any Num developer endpoint.',
  };
}

/**
 * Is this key good for this call?
 *
 * Returns a verdict rather than throwing, in the same shape the rest of the
 * codebase uses, so a caller can turn a refusal into a sentence a developer
 * can act on instead of a bare 401.
 */
export async function check(env, request, scope) {
  await ensure(env);
  const header = request?.headers?.get?.('Authorization') ?? '';
  const key = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim();
  if (!key) return { ok: false, status: 401, error: 'Send your key as  Authorization: Bearer <key>. Get one free at itsnum.com/for-ai/.' };

  const row = await env.DB.prepare(
    'SELECT id, app_name, scopes, daily_cap, revoked_at FROM num_dev_keys WHERE key_hash=?1',
  ).bind(await hashKey(key)).first().catch(() => null);
  // The same sentence for "no such key" and "wrong key", on purpose: telling
  // the difference is telling somebody whether a guessed key exists.
  if (!row) return { ok: false, status: 401, error: 'That key is not one of ours.' };
  if (row.revoked_at) return { ok: false, status: 401, error: 'That key has been revoked.' };
  if (scope && !String(row.scopes).split(' ').includes(scope)) {
    return { ok: false, status: 403, error: `That key does not carry the "${scope}" scope.` };
  }

  const day = DAY();
  const used = await env.DB.prepare('SELECT calls FROM num_dev_usage WHERE key_id=?1 AND day=?2')
    .bind(row.id, day).first().catch(() => null);
  const calls = Number(used?.calls ?? 0);
  if (calls >= Number(row.daily_cap)) {
    return {
      ok: false, status: 429,
      error: `You have used all ${row.daily_cap} calls for today. The count resets at 00:00 UTC.`,
      used: calls, cap: Number(row.daily_cap),
    };
  }
  return { ok: true, key_id: row.id, app: row.app_name, used: calls, cap: Number(row.daily_cap), left: Number(row.daily_cap) - calls };
}

/**
 * Count a call. Called AFTER the work succeeded, so a developer is never
 * billed a call against a request we failed to serve.
 */
export async function countCall(env, keyId) {
  if (!keyId || !env?.DB) return;
  await ensure(env);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO num_dev_usage (key_id, day, calls) VALUES (?1,?2,1)
       ON CONFLICT(key_id, day) DO UPDATE SET calls = calls + 1`,
    ).bind(keyId, DAY()),
    env.DB.prepare("UPDATE num_dev_keys SET last_used_at = datetime('now') WHERE id=?1").bind(keyId),
  ]).catch(() => {});
}

/**
 * Turn a key off.
 *
 * Requires the KEY itself, not the id — so the only person who can revoke a
 * key is somebody who already holds it. No account, no password, no support
 * queue standing between a developer and switching off a key they think has
 * leaked. Speed matters more than ceremony at that moment.
 */
export async function revoke(env, key) {
  await ensure(env);
  if (!key) return { ok: false, status: 400, error: 'Send the key you want to revoke.' };
  const r = await env.DB.prepare(
    "UPDATE num_dev_keys SET revoked_at = datetime('now') WHERE key_hash=?1 AND revoked_at IS NULL",
  ).bind(await hashKey(key)).run().catch(() => null);
  const done = (r?.meta?.changes ?? 0) > 0;
  return done
    ? { ok: true, note: 'That key stopped working immediately. Take another whenever you like.' }
    : { ok: false, status: 404, error: 'No active key matches that.' };
}

/** The public description of the API — what it is, free of charge, and honest about limits. */
export function overview() {
  return {
    name: 'Num for AI',
    what: 'Verified local places, live events and concierge answers across Num’s destinations, for your own users.',
    free_tier: { calls_per_day: FREE_DAILY, price: 0, note: 'No card. Sign up, get a key, build.' },
    scopes: SCOPES,
    auth: 'Authorization: Bearer <key>',
    // The limits stated where somebody decides whether to build on us, not
    // discovered later when their product depends on it.
    limits: [
      'Read-only. There is no scope that books, orders, or reads anything about a person.',
      'Places come from Num’s verified directory — if Num has not verified it, this API will not return it.',
      'Attribution: show “Places by Num” with a link back where the data appears.',
    ],
    sign_up: 'POST /api/dev/signup  { app_name, email, website }',
  };
}

export async function handleDevApi(request, env, path) {
  const post = request.method === 'POST';

  if (path === '' || path === '/' || path === '/overview') return json(overview());
  if (path === '/scopes') return json({ scopes: SCOPES, default: DEFAULT_SCOPES });

  if (path === '/signup' && post) {
    const b = await request.json().catch(() => ({}));
    const out = await issue(env, b);
    return json(out, out.ok ? 200 : (out.status ?? 400));
  }

  if (path === '/revoke' && post) {
    const b = await request.json().catch(() => ({}));
    const out = await revoke(env, clip(b.key, 120));
    return json(out, out.ok ? 200 : (out.status ?? 400));
  }

  // What is this key allowed to do, and how much of today is left? The call a
  // developer makes first, and the one that makes a 429 make sense later.
  if (path === '/me') {
    const v = await check(env, request, null);
    return json(v, v.ok ? 200 : (v.status ?? 401));
  }

  return json({ error: 'not found' }, 404);
}
