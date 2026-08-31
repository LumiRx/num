/**
 * NUM · does the brain actually answer?
 *
 * ── WHY THIS EXISTS — 31 Aug 2026 ────────────────────────────────────────
 *
 * At 13:33:23 both Anthropic brains failed with a 403. They were stood down
 * for an hour. At 14:33 the cooldown lapsed and the health check went green —
 * and nothing had been proved. No call had succeeded. No call had even been
 * attempted. The dashboard said "ok" because a timer expired.
 *
 * The check that was supposed to cover this read, in full:
 *
 *     if (!env.ANTHROPIC_API_KEY) return { ok: false, … };
 *     return { ok: true };
 *
 * That is a configuration check wearing a health check's clothes. It answers
 * "is a key set" and is then reported as though it answered "does the brain
 * work". Every outage in this file's history has had that shape: a green light
 * that means we stopped looking. The 4 Aug redirect loop ran 288 clean checks
 * through a dead site; the SMS outage ran 1,166; this one ran twelve red and
 * then went green on a timer with the problem unproven either way.
 *
 * So: ask it. One token, and only when the answer is not already known.
 *
 * ── WHY IT IS ALMOST ALWAYS FREE ─────────────────────────────────────────
 *
 * A brain that is answering real turns needs no probe — the turns ARE the
 * probe, and `recordSuccess` already writes that down. A probe is worth
 * spending only in the one window where we are blind: a brain has a recorded
 * failure, its cooldown has run out, and the next thing to discover the truth
 * would otherwise be a guest's question. In that window we send one token
 * instead of a guest.
 *
 * Normal operation: zero calls, zero cost. After a failure: one tiny call per
 * five-minute tick until it answers or confirms it is still broken. Neither
 * outcome is a guess, and that is the whole point.
 */

import { classify } from './brainstate.mjs';

/** The smallest possible real call. One token out, no tools, no system prompt. */
const PROBE_MAX_TOKENS = 1;

/** Brains this module knows how to reach. Anything else is skipped, not guessed at. */
const PROBEABLE = new Set(['claude', 'haiku']);

/** The dated model id each Anthropic brain answers on. */
const MODEL_FOR = (env, brainId) => (brainId === 'haiku'
  ? (env.NUM_HAIKU_MODEL || 'claude-haiku-4-5-20251001')
  : (env.NUM_MODEL || 'claude-opus-5'));

/**
 * Call a brain for real, cheaply. Returns what happened, never throws.
 *
 * The error string is built to the same shape `brains.mjs` produces, so
 * `classify` reads a probe failure exactly as it reads a live one — a probe
 * that classified differently from production would be a second opinion about
 * a system that already has one, and the two would drift.
 */
export async function probeBrain(env, brainId, { fetchImpl = fetch } = {}) {
  if (!PROBEABLE.has(brainId)) return { probed: false, reason: 'not probeable' };
  if (!env?.ANTHROPIC_API_KEY) return { probed: false, reason: 'no key configured' };

  const started = Date.now();
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_FOR(env, brainId),
        max_tokens: PROBE_MAX_TOKENS,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // The BODY comes back, not just the status. Distinguishing a vendor
      // permission error from an edge refusal depends entirely on the shape of
      // the body, and a probe that discarded it would reproduce the mistake
      // this whole change is about.
      const body = await res.text().catch(() => '');
      const err = new Error(`${res.status} ${body}`.slice(0, 300));
      err.status = res.status;
      return { probed: true, ok: false, status: res.status, class: classify(err), error: err.message, ms: Date.now() - started };
    }
    return { probed: true, ok: true, ms: Date.now() - started };
  } catch (e) {
    const err = new Error(String(e?.message ?? e).slice(0, 300));
    return { probed: true, ok: false, class: classify(err), error: err.message, ms: Date.now() - started };
  }
}

/**
 * Which brains are currently unproven — carrying a failure whose cooldown has
 * already lapsed, so the next real guest would be the one to find out.
 *
 * Deliberately NOT "everything that ever failed": a brain still inside its
 * cooldown is being left alone on purpose, and probing it would defeat the
 * back-off that exists to stop us hammering a vendor that already said no.
 */
export function unproven(rows, now = Math.floor(Date.now() / 1000)) {
  return (rows ?? [])
    .filter((r) => PROBEABLE.has(r.brain))
    .filter((r) => Number(r.fails) > 0 && Number(r.cooldown_until ?? 0) <= now)
    .map((r) => r.brain);
}

/**
 * The cron pass. Find the unproven brains, ask each one, and write down what
 * actually happened.
 *
 * A success clears the standing failure through the ordinary path, so a brain
 * that quietly recovered stops being reported as broken within five minutes
 * instead of at the next guest's expense. A failure re-records — which also
 * re-arms the cooldown, so a genuinely dead brain is not probed every tick.
 */
export async function proveBrains(env, { now = Math.floor(Date.now() / 1000), fetchImpl = fetch } = {}) {
  if (!env?.DB) return { checked: 0, recovered: [], still_down: [] };
  const { results } = await env.DB.prepare(
    'SELECT brain, fails, class, cooldown_until FROM num_brain_state WHERE fails > 0',
  ).all().catch(() => ({ results: [] }));

  const todo = unproven(results, now);
  if (!todo.length) return { checked: 0, recovered: [], still_down: [] };

  const state = await import('./brainstate.mjs');
  const recovered = [];
  const stillDown = [];

  for (const brain of todo) {
    const out = await probeBrain(env, brain, { fetchImpl });
    if (!out.probed) continue;
    if (out.ok) {
      // Hand `recordSuccess` the shape it expects: it only writes when there
      // is a standing failure to clear, and it decides that from this map.
      await state.recordSuccess(env, brain, new Map([[brain, { fails: 1, cooling: false }]]));
      recovered.push(brain);
    } else {
      const err = new Error(out.error ?? 'probe failed');
      err.status = out.status;
      await state.recordFailure(env, brain, err);
      stillDown.push({ brain, class: out.class, error: out.error });
    }
  }
  return { checked: todo.length, recovered, still_down: stillDown };
}
