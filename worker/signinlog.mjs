/**
 * Where sign-in dies.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * On 23 Aug 2026 the production numbers looked like this: ~30 unique website
 * visitors a week, a working install funnel, 4–7 attributed asks a day, 131
 * member rows — and the last person to complete phone verification did so on
 * 4 JULY. Seven weeks. Nothing anywhere said so, and nothing could say WHY,
 * because the only durable record of a sign-in attempt was its side effect:
 * `phone_verified` flipping to 1. A step that never happens leaves no trace at
 * all, so the failure was invisible in exactly proportion to how total it was.
 *
 * Worse, the two explanations are opposite and were indistinguishable:
 *
 *   · the code is never SENT   → a provider or compliance problem (A2P 10DLC
 *     rejected every Programmable Messaging send with 30034 for weeks), or
 *   · the code is sent and never ENTERED → a product problem: the sheet, the
 *     keyboard, the copy, the wait.
 *
 * One is fixed in a Twilio console and one is fixed in the app. Guessing wrong
 * costs a week. So every attempt writes a row here, whichever way it ends.
 *
 * ── WHAT IS AND IS NOT STORED ────────────────────────────────────────────
 *
 * A member id, a stage, an outcome, a reason code and a timestamp. NO phone
 * number, NO code, NO IP. The reason is a short provider code (`30034`,
 * `60200`) or one of our own words — enough to group by, never enough to
 * identify anybody. A diagnostic table that quietly becomes a second copy of
 * the member register is a liability that outlives the bug it was added for.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_signin_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT,
  stage TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  via TEXT,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signin_ts ON num_signin_events(ts);
CREATE INDEX IF NOT EXISTS idx_signin_stage ON num_signin_events(stage, outcome);
`;

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}
/** Test seam: the module-level cache must not leak between test cases. */
export const _resetForTests = () => { ready = false; };

/** `send` — we tried to deliver a code. `check` — somebody offered one back. */
export const STAGES = Object.freeze(['send', 'check']);
export const OUTCOMES = Object.freeze(['ok', 'failed', 'wrong_code', 'capped', 'expired']);

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/**
 * Record one sign-in attempt. Never throws, never awaited on the hot path by
 * the caller's own logic.
 *
 * A logging failure must never cost somebody their sign-in — which is the
 * whole reason this is a separate table and not a column on num_members. A
 * write that contends with the member row is a write that can block the thing
 * it is measuring.
 */
export async function logSignin(env, { memberId, stage, outcome, reason, via } = {}) {
  if (!env?.DB) return { logged: 0 };
  if (!STAGES.includes(stage) || !OUTCOMES.includes(outcome)) {
    // A typo'd stage would create a bucket nobody queries and would look like
    // silence — the exact failure mode this file exists to end.
    console.warn('[signin] refusing to log an unknown stage/outcome', stage, outcome);
    return { logged: 0 };
  }
  try {
    await ensure(env);
    await env.DB.prepare(
      'INSERT INTO num_signin_events (member_id, stage, outcome, reason, via) VALUES (?1,?2,?3,?4,?5)',
    ).bind(clip(memberId, 60), stage, outcome, clip(reason, 40), clip(via, 20)).run();
    return { logged: 1 };
  } catch (e) {
    console.warn('[signin] log write failed', e?.message ?? e);
    return { logged: 0 };
  }
}

/** Fire-and-forget where there is an execution context, awaited where there is not. */
export function noteSignin(env, ctx, fields) {
  const p = logSignin(env, fields).catch(() => ({ logged: 0 }));
  if (ctx?.waitUntil) { ctx.waitUntil(p); return null; }
  return p;
}

/**
 * The funnel, per day: codes we tried to send, codes that went, codes offered
 * back, codes accepted.
 *
 * `sent` versus `entered` is the whole diagnostic. Sent high and entered zero
 * is a product problem. Sent zero is a provider problem. Both were true at
 * different points this month and they need different people.
 */
export async function signinFunnel(env, days = 14) {
  if (!env?.DB) return [];
  try {
    await ensure(env);
    const { results } = await env.DB.prepare(
      `SELECT substr(ts,1,10) day,
              SUM(CASE WHEN stage='send'  THEN 1 ELSE 0 END) send_attempts,
              SUM(CASE WHEN stage='send'  AND outcome='ok' THEN 1 ELSE 0 END) sent,
              SUM(CASE WHEN stage='check' THEN 1 ELSE 0 END) entered,
              SUM(CASE WHEN stage='check' AND outcome='ok' THEN 1 ELSE 0 END) verified
         FROM num_signin_events
        WHERE ts > datetime('now', ?1)
        GROUP BY day ORDER BY day DESC`,
    ).bind(`-${Math.max(1, Math.min(90, Number(days) || 14))} days`).all();
    return results ?? [];
  } catch { return []; }
}

/** Why sends are failing, most common first. The provider code is the answer. */
export async function signinReasons(env, days = 14) {
  if (!env?.DB) return [];
  try {
    await ensure(env);
    const { results } = await env.DB.prepare(
      `SELECT stage, outcome, COALESCE(reason,'—') reason, COALESCE(via,'—') via, COUNT(*) n
         FROM num_signin_events
        WHERE ts > datetime('now', ?1) AND outcome <> 'ok'
        GROUP BY stage, outcome, reason, via ORDER BY n DESC LIMIT 20`,
    ).bind(`-${Math.max(1, Math.min(90, Number(days) || 14))} days`).all();
    return results ?? [];
  } catch { return []; }
}
