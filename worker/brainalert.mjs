/**
 * TELL DRE WHEN A BRAIN GOES DARK.
 *
 * Dre, 8 Sep 2026: "lets make sure i alwyas get a text if it goes down."
 *
 * ── WHY THIS DID NOT EXIST, AND WHY THAT WAS THE WORST PLACE FOR A GAP ────
 *
 * brainstate.mjs has recorded every failure since August. brainprobe.mjs
 * quietly re-tests cooling brains and recovers them. Both worked. Neither
 * ever told a human anything — so the 5 and 6 Sep outages were found the way
 * outages are always found without alerting: by a person opening the app and
 * noticing. The detection was already built. The sentence was missing.
 *
 * ── THE ONE RULE THAT SHAPES EVERYTHING HERE ─────────────────────────────
 *
 * The alert must work when the thing that is broken is the model. So there is
 * no model in this path: it reads a table, compares it to a threshold, and
 * hands a string to health.alert() — Twilio, webhook, email. If every brain
 * on earth is down, this still sends.
 *
 * ── THREE SEVERITIES, AND ONLY TWO OF THEM ARE WORTH A PHONE BUZZING ──────
 *
 *   blackout    No structured brain is healthy. Nothing can produce a card,
 *               a booking or an action — the product is visibly broken to a
 *               guest right now. Texts hourly until it clears.
 *
 *   needs_human No amount of waiting fixes it: the key is dead, the account
 *               is out of credit, or the model name is wrong. brainprobe will
 *               retry this forever and never succeed. THIS is the one Dre
 *               actually asked for — it is the state he was in on Friday, and
 *               the state where he cannot ship. Texts once a day per brain.
 *
 *   degraded    A brain is cooling on a timeout or a rate limit. The chain is
 *               doing exactly what it was built to do and a guest sees
 *               nothing. Recorded, never texted. An alert that fires when
 *               nothing is wrong trains its reader to ignore it, and then the
 *               real one arrives to an audience of nobody.
 *
 * ── RECOVERY IS ALSO NEWS ────────────────────────────────────────────────
 *
 * Without an all-clear, the only way to learn it is over is to go and look —
 * which is the behaviour this file exists to replace. So a brain that comes
 * back sends exactly one message saying so.
 */
import { report } from './brainstate.mjs';
import { chain } from './brains.mjs';

/** Failure classes that a human, not time, has to fix. */
export const NEEDS_HUMAN = Object.freeze(['auth', 'model']);

/** Severity ranking, worst first. Exported so the tests cannot drift from it. */
export const LEVELS = Object.freeze(['blackout', 'needs_human', 'degraded', 'ok']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_brain_alerts (
  brain TEXT NOT NULL,
  level TEXT NOT NULL,
  window TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (brain, level, window)
);
`;
const readied = new WeakSet();
async function ensure(env) {
  if (!env?.DB || readied.has(env.DB)) return;
  for (const s of SCHEMA.split(';').map((x) => x.trim()).filter(Boolean)) {
    await env.DB.prepare(s).run();
  }
  readied.add(env.DB);
}

/**
 * What is actually wrong, from the standing state and the configured chain.
 *
 * `chain(env)` is the source of truth for which brains exist in this
 * deployment — reading the state table alone would miss a brain that has
 * never failed, and so could never notice that the ONLY structured brain is
 * the one that is down.
 */
export function assess(rep, brains) {
  const cooling = new Set((rep?.brains ?? []).filter((b) => b.cooling).map((b) => b.brain));
  const structured = (brains ?? []).filter((b) => b.structured);
  const structuredUp = structured.filter((b) => !cooling.has(b.id));
  const stuck = (rep?.brains ?? []).filter((b) => b.cooling && NEEDS_HUMAN.includes(b.class));

  // A deployment with no structured brain at all is a configuration, not an
  // outage — do not page someone about a choice they made.
  const blackout = structured.length > 0 && structuredUp.length === 0;

  return {
    level: blackout ? 'blackout' : (stuck.length ? 'needs_human' : (cooling.size ? 'degraded' : 'ok')),
    blackout,
    stuck,
    cooling: [...cooling],
    structured_up: structuredUp.map((b) => b.id),
    structured_total: structured.length,
  };
}

/**
 * The dedupe window for a severity.
 *
 * Hourly for a blackout: the product is down and a reminder is welcome.
 * Daily for needs_human: it is a task, and a task does not need re-announcing
 * twelve times an hour to stay on a list.
 */
export function windowFor(level, now = new Date()) {
  const iso = new Date(now).toISOString();
  return level === 'blackout' ? iso.slice(0, 13) : iso.slice(0, 10);
}

/** The words. Kept short — this arrives as a text on a phone. */
export function messageFor(a) {
  if (a.level === 'blackout') {
    const why = a.stuck.length
      ? a.stuck.map((b) => `${b.brain}: ${b.class}`).join(', ')
      : a.cooling.join(', ');
    return `[BRAIN DOWN] Every structured brain is cooling — NUM cannot produce cards or bookings right now. ${why}`;
  }
  return `[brain] ${a.stuck.map((b) => `${b.brain} needs you (${b.class}) — ${String(b.last_error ?? '').slice(0, 70)}`).join('; ')}`
    + ` — retrying will not fix this. ${a.structured_up.length} structured brain(s) still up.`;
}

/**
 * Send at most one message per brain per window. Returns what it sent.
 *
 * INSERT OR IGNORE against a primary key is the whole dedupe: if the row is
 * already there this window, `changes` is 0 and nothing is sent. Writing the
 * claim BEFORE sending is deliberate — a send that throws must not leave the
 * window open for a duplicate on the next tick, because a five-minute cron
 * would then send twelve.
 */
async function claimWindow(env, brain, level, window) {
  const r = await env.DB.prepare(
    'INSERT OR IGNORE INTO num_brain_alerts (brain, level, window) VALUES (?1, ?2, ?3)',
  ).bind(brain, level, window).run().catch(() => null);
  return !!r?.meta?.changes;
}

/**
 * One tick. Called from the cron, next to the probe that does the recovering.
 */
export async function alertOnBrains(env, { now = new Date(), alertFn = null } = {}) {
  if (!env?.DB) return { level: 'ok', sent: [] };
  await ensure(env);
  const rep = await report(env).catch(() => null);
  if (!rep) return { level: 'ok', sent: [], why: 'no state' };
  const a = assess(rep, chain(env));

  const send = alertFn ?? (async (text) => {
    const { alert } = await import('./health.mjs');
    return alert(env, text, { kind: 'brain_down', subject: text.slice(0, 90) });
  });

  const sent = [];

  // ── RECOVERY ─────────────────────────────────────────────────────────────
  // Anything we alerted on that is no longer cooling gets exactly one
  // all-clear, then its claim rows are cleared so the next outage alerts
  // again from scratch.
  const coolingNow = new Set(a.cooling);
  const { results: open } = await env.DB.prepare(
    "SELECT DISTINCT brain FROM num_brain_alerts WHERE level IN ('blackout','needs_human')",
  ).all().catch(() => ({ results: [] }));
  const recovered = (open ?? []).map((r) => r.brain).filter((b) => b !== '*' && !coolingNow.has(b));
  if (recovered.length) {
    await send(`[brain] back up: ${recovered.join(', ')}.`);
    sent.push({ level: 'recovered', brains: recovered });
    for (const b of recovered) {
      await env.DB.prepare('DELETE FROM num_brain_alerts WHERE brain = ?1').bind(b).run().catch(() => {});
    }
  }
  // A blackout is a state of the whole chain, not of one brain, so its claim
  // is filed under '*'. Cleared as soon as any structured brain is up again.
  if (!a.blackout) {
    await env.DB.prepare("DELETE FROM num_brain_alerts WHERE brain = '*'").run().catch(() => {});
  }

  if (a.level === 'blackout') {
    if (await claimWindow(env, '*', 'blackout', windowFor('blackout', now))) {
      await send(messageFor(a));
      sent.push({ level: 'blackout' });
    }
    return { level: a.level, sent, assessment: a };
  }

  if (a.level === 'needs_human') {
    const win = windowFor('needs_human', now);
    const fresh = [];
    for (const b of a.stuck) {
      if (await claimWindow(env, b.brain, 'needs_human', win)) fresh.push(b);
    }
    if (fresh.length) {
      await send(messageFor({ ...a, stuck: fresh }));
      sent.push({ level: 'needs_human', brains: fresh.map((b) => b.brain) });
    }
  }

  return { level: a.level, sent, assessment: a };
}
