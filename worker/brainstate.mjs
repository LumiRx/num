/**
 * Which brains are worth trying right now.
 *
 * On 2026-08-06 every brain in the chain failed at once and `/api/num`
 * answered "That one slipped away from me" with **HTTP 200**. The fallback
 * worked exactly as designed — a degraded answer instead of a dead end — and
 * because it was a 200, every monitor we had reported the product healthy
 * while it was answering nobody's question. The chain protected the user from
 * the outage and hid it from us.
 *
 * Two things follow, and this file is the first.
 *
 * ── WHY STATE AT ALL ──────────────────────────────────────────────────────
 *
 * `ask()` used to try every brain on every turn, in the same order, forever.
 * When a brain is rate-limited or out of credit, that is not a coin flip that
 * might land differently in four seconds — it is a condition with a duration.
 * Retrying it on the next turn costs a round trip, adds latency to a guest who
 * is already waiting, and on metered brains can deepen the very quota problem
 * that caused it. So a brain that fails for a *durable* reason is stood down
 * for a while, and the turn moves straight to one that can answer.
 *
 * ── THE RULE THAT MATTERS MOST ────────────────────────────────────────────
 *
 * **Never cool down the last brain.** A circuit breaker that opens on
 * everything converts a partial outage into a total one, by our own hand. If
 * every brain is in cooldown, `plan()` returns the whole chain anyway and lets
 * them fail honestly. Refusing to try is worse than trying and failing: one
 * of them may have recovered, and we would never find out.
 *
 * ── WHY D1 AND NOT MEMORY ─────────────────────────────────────────────────
 *
 * Worker isolates are created and destroyed constantly. An in-memory breaker
 * resets every few requests, which means it never actually opens under real
 * traffic — it would look like it worked in testing and do nothing in
 * production. State has to outlive the isolate.
 *
 * Writes happen on transitions only: a failure, or a success that clears a
 * standing failure. A healthy brain answering normally writes nothing.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_brain_state (
  brain TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  class TEXT,
  last_error TEXT,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS num_brain_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brain TEXT NOT NULL,
  class TEXT,
  error TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_events_ts ON num_brain_events(ts);
`;

let ready = false;
async function ensure(env) {
  if (ready) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

/**
 * What kind of failure was that?
 *
 * The class decides how long we stand a brain down, so guessing generously is
 * expensive in both directions: too long and we stop using a brain that works,
 * too short and we hammer a quota that is already exhausted.
 *
 *   quota     — out of credit, or a hard spend/usage cap. Minutes at best,
 *               usually longer, and retrying costs money or deepens the cap.
 *   rate      — too many requests per unit time. Short and self-healing.
 *   auth      — a key that is wrong, revoked or expired. No amount of waiting
 *               fixes this; a human must act, so stand it down hard and shout.
 *   model     — the model name is not recognised. Also needs a human, and
 *               retrying is pure waste.
 *   transient — timeouts, 5xx, socket errors. Genuinely worth another go.
 */
export function classify(err) {
  const m = String(err?.message ?? err ?? '').toLowerCase();
  const status = Number(err?.status ?? err?.statusCode ?? 0);

  if (status === 401 || status === 403 || /unauthor|forbidden|invalid.*(api.?key|token)|authentication/.test(m)) return 'auth';
  if (/model.*(not found|does not exist|unknown|invalid)|no such model|404.*model/.test(m)) return 'model';
  if (status === 402 || /credit|quota|billing|insufficient funds|spend limit|usage limit|out of (credits|tokens)|neuron/.test(m)) return 'quota';
  if (status === 429 || /rate.?limit|too many requests|overloaded|capacity|throttl/.test(m)) return 'rate';
  return 'transient';
}

/** How long a brain stands down, by class and by how many times it has failed in a row. */
const BASE_COOLDOWN_SEC = { auth: 3600, model: 3600, quota: 900, rate: 60, transient: 20 };
const MAX_COOLDOWN_SEC = 3600;

export function cooldownFor(cls, fails) {
  const base = BASE_COOLDOWN_SEC[cls] ?? BASE_COOLDOWN_SEC.transient;
  // Back off on repeats, but never past an hour — a brain that recovered
  // quietly should be found again within one shift, not one day.
  return Math.min(MAX_COOLDOWN_SEC, Math.round(base * Math.pow(2, Math.max(0, fails - 1))));
}

/** Read the standing state for every brain. Never throws; a read failure means "no state". */
export async function load(env) {
  try {
    await ensure(env);
    const { results } = await env.DB.prepare(
      'SELECT brain, fails, class, last_error, cooldown_until FROM num_brain_state',
    ).all();
    const now = Math.floor(Date.now() / 1000);
    const map = new Map();
    for (const r of results ?? []) {
      map.set(r.brain, {
        fails: Number(r.fails) || 0,
        class: r.class ?? null,
        lastError: r.last_error ?? null,
        cooldownUntil: Number(r.cooldown_until) || 0,
        cooling: (Number(r.cooldown_until) || 0) > now,
      });
    }
    return map;
  } catch (e) {
    console.warn('[brainstate] load failed, treating all brains as healthy:', e?.message ?? e);
    return new Map();
  }
}

/**
 * Order the chain for this turn: healthy brains first, cooling ones last.
 *
 * Cooling brains are *demoted, not removed*. If the healthy ones fail we still
 * try the cooling ones rather than give up — the cooldown is a preference
 * about ordering, not a promise never to call. That is what keeps a breaker
 * from manufacturing the outage it was built to prevent.
 */
export function plan(chain, state) {
  const healthy = [];
  const cooling = [];
  for (const b of chain) (state.get(b.id)?.cooling ? cooling : healthy).push(b);
  return { order: [...healthy, ...cooling], healthy: healthy.length, cooling: cooling.length };
}

/** Record a failure and put the brain on the naughty step for a while. */
export async function recordFailure(env, brainId, err) {
  const cls = classify(err);
  try {
    await ensure(env);
    const now = Math.floor(Date.now() / 1000);
    const prev = await env.DB.prepare('SELECT fails, class FROM num_brain_state WHERE brain = ?1').bind(brainId).first();
    // Consecutive failures only count as an escalation when the cause is the
    // same. A rate limit after an auth error is a new problem, not a worse one.
    const fails = prev && prev.class === cls ? Number(prev.fails) + 1 : 1;
    const until = now + cooldownFor(cls, fails);
    const msg = String(err?.message ?? err ?? '').slice(0, 300);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO num_brain_state (brain, fails, class, last_error, cooldown_until, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(brain) DO UPDATE SET fails=?2, class=?3, last_error=?4, cooldown_until=?5, updated_at=?6`,
      ).bind(brainId, fails, cls, msg, until, now),
      env.DB.prepare('INSERT INTO num_brain_events (brain, class, error, ts) VALUES (?1,?2,?3,?4)')
        .bind(brainId, cls, msg, now),
    ]);
    return { class: cls, fails, cooldownUntil: until };
  } catch (e) {
    console.warn('[brainstate] recordFailure failed:', e?.message ?? e);
    return { class: cls, fails: 0, cooldownUntil: 0 };
  }
}

/**
 * A brain answered. Clear any standing failure.
 *
 * Only writes when there was something to clear, so the common case — a
 * healthy brain answering a normal turn — costs one indexed read and no write.
 */
export async function recordSuccess(env, brainId, state) {
  const had = state?.get(brainId);
  if (!had || (!had.fails && !had.cooling)) return;
  try {
    await ensure(env);
    await env.DB.prepare(
      'UPDATE num_brain_state SET fails = 0, class = NULL, cooldown_until = 0, updated_at = ?2 WHERE brain = ?1',
    ).bind(brainId, Math.floor(Date.now() / 1000)).run();
  } catch (e) {
    console.warn('[brainstate] recordSuccess failed:', e?.message ?? e);
  }
}

/**
 * Everything an operator needs when the chain is misbehaving, in one read.
 *
 * `needsHuman` is the field worth alerting on: auth and model failures do not
 * heal on their own, so a chain that is only "recovering" on those is a chain
 * that will still be broken tomorrow.
 */
export async function report(env) {
  const state = await load(env);
  const now = Math.floor(Date.now() / 1000);
  const brains = [...state.entries()].map(([brain, s]) => ({
    brain,
    class: s.class,
    fails: s.fails,
    cooling: s.cooling,
    seconds_left: s.cooling ? s.cooldownUntil - now : 0,
    last_error: s.lastError,
  }));
  return {
    brains,
    cooling: brains.filter((b) => b.cooling).length,
    needs_human: brains.filter((b) => b.cooling && (b.class === 'auth' || b.class === 'model')).map((b) => b.brain),
  };
}
