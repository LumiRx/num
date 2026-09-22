/**
 * alerttriage.mjs — is this actually worth waking Dre up?
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 * Dre, 12 Sep 2026: "lets make sure that when num is texting me udpates
 * theyre accurate we have our agents anazlyze it befoer texting me to make
 * sure its serious."
 *
 * The same evening his phone said "🔴 NUM IS DOWN" because one outreach email
 * bounced. Every real check was green. A person reading that alert would have
 * spotted it in two seconds; the code could not, because nothing in the path
 * was allowed to think.
 *
 * ── THE RULE THAT OUTRANKS EVERY OTHER ───────────────────────────────────
 * **A judge that can fail silent is worse than no judge at all.**
 *
 * This sits in the alert path, and the alert path's whole job is to work when
 * other things do not — including when the AI does not. So every failure mode
 * here resolves to SEND:
 *
 *   · no brain configured        → send
 *   · brain errors               → send
 *   · brain times out            → send
 *   · brain answers gibberish    → send
 *   · database unreachable       → send
 *   · anything throws, anywhere  → send
 *
 * There is exactly one path to silence: a brain that answered, in time, in the
 * expected shape, saying this can wait. Everything else rings.
 *
 * ── AND IT CANNOT JUDGE THE THINGS THAT MATTER MOST ──────────────────────
 * Four classes bypass triage entirely, chosen by Dre:
 *
 *   alert_undelivered  nothing carried an alert. Once that is true, every
 *                      green light everywhere is an unverified claim — and
 *                      the judge might be the broken thing.
 *   d1_write           signup, plans, Stars and memory are silently broken.
 *   brain_down         Num cannot answer anyone. Note the circularity: if the
 *                      brain is down, the TRIAGE brain is down. Asking it
 *                      would be asking a dead model whether it is dead.
 *   pay                money. A missed renewal is revenue nobody notices later.
 *
 * plus anything recorded `critical`.
 *
 * ── AND IT DOES NOT USE THE CLAUDE ACCOUNT ───────────────────────────────
 * Same structural rule as the consensus engine: `voters(env)` returns only
 * brains whose kind is not 'anthropic'. When Dre maxes his Anthropic tokens —
 * which is one of the things he most needs to be told about — the judge has
 * to still be standing.
 */

import { voters } from './consensus.mjs';

/** How long the judge gets. Past this it is not answering and the alert goes. */
export const TRIAGE_TIMEOUT_MS = 6000;

/**
 * Kinds that are never judged. Matched on the alert's `kind` OR on the text,
 * because several callers pass the default kind 'alert' and put the real
 * subject in the message.
 */
export const NEVER_GATED = Object.freeze([
  'alert_undelivered',
  'brain_down',
  // Whether anybody can sign in is not a judgement call. On 20 Sep 2026
  // sign-in was dead for nine hours on the biggest traffic day Num has
  // had; no model should be given the option of holding that for a digest.
  'sms_down',
  'd1_write',
  'pay',
  // The morning digest itself. Judging a summary of things already judged
  // not urgent is circular, and the one outcome it can produce — holding the
  // digest for tomorrow's digest — is the bug where nothing is ever told.
  'digest',
]);

/** Text fingerprints of the same four, for callers that do not set a kind. */
const NEVER_GATED_TEXT = [
  /alert_undelivered/i,
  /\bd1_write\b/i,
  /could not be told|nobody was successfully told|no channel accepted/i,
  /^\[pay\]/im,
  /brain(s)?[ _-]?(down|state)/i,
  /^\[SIGN-IN DOWN\]/im,
  /NUM IS DOWN[\s\S]*\b(d1_write|brain|site_public)\b/i,
];

/** The one-word answers the judge is allowed to give. */
const PAGE = 'page';
const DIGEST = 'digest';

/**
 * Does this skip the judge entirely?
 *
 * Deliberately generous: when in doubt this returns true, because a bypass
 * costs one text and a wrong gate costs an outage nobody heard about.
 */
export function mustPage({ kind = '', text = '', severity = '' } = {}) {
  if (String(severity).toLowerCase() === 'critical') return 'critical';
  const k = String(kind).toLowerCase();
  if (NEVER_GATED.some((n) => k.includes(n))) return `kind:${k}`;
  const t = String(text);
  for (const re of NEVER_GATED_TEXT) if (re.test(t)) return `text:${re.source.slice(0, 24)}`;
  return null;
}

let ready = new WeakSet();
/** Reset for tests. Production never calls this. */
export function __resetReady() { ready = new WeakSet(); }

async function ensure(env) {
  if (!env?.DB || ready.has(env.DB)) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS num_alert_triage (
       id        INTEGER PRIMARY KEY AUTOINCREMENT,
       kind      TEXT,
       subject   TEXT,
       body      TEXT,
       decision  TEXT NOT NULL,
       why       TEXT,
       judge     TEXT,
       sent      INTEGER NOT NULL DEFAULT 0,
       digested  INTEGER NOT NULL DEFAULT 0,
       at        TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  ).run().catch(() => {});
  ready.add(env.DB);
}

/**
 * How many times this same subject has already been held back.
 *
 * Handed to the judge as context, not applied as a rule. A thing that keeps
 * being "not urgent" every day for a week usually is urgent, and the judge is
 * allowed to say so — Dre asked for it to be able to promote, not only to
 * quieten.
 */
async function heldBefore(env, subject) {
  if (!env?.DB || !subject) return 0;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) n FROM num_alert_triage
      WHERE subject = ?1 AND decision = 'digest' AND at > datetime('now','-14 days')`,
  ).bind(String(subject).slice(0, 200)).first().catch(() => null);
  return Number(row?.n ?? 0);
}

const SYSTEM = [
  'You are the on-call filter for NUM, a travel concierge. An automated alert is about to be',
  'texted to the founder, at any hour. Your only job is to decide whether it earns that.',
  '',
  'PAGE means: something a paying guest, a partner business, or the money is actually affected',
  'right now, or will be within the hour, and a person has to act.',
  'DIGEST means: true and worth recording, but it can wait for the morning summary.',
  '',
  'Examples of DIGEST: one email bounced; a business signed up; a listing needs a look;',
  'a cosmetic or reporting problem; good news; a threshold crossed with no user impact.',
  'Examples of PAGE: guests cannot get answers; bookings are failing; money did not move;',
  'data is being lost; a security or access problem; the same fault escalating.',
  '',
  'When you are not sure, answer PAGE. A missed real outage is far worse than one extra text.',
  '',
  'Answer with exactly one line: PAGE <reason> or DIGEST <reason>. Under 15 words of reason.',
].join('\n');

/**
 * Ask the judge. Returns null on ANY doubt, which the caller reads as "send".
 */
async function askJudge(env, { text, kind, held }) {
  const panel = voters(env);
  if (!panel.length) return null;

  const { callProse } = await import('./brains.mjs');
  const context = [
    `Alert kind: ${kind || 'alert'}`,
    held > 0 ? `This exact alert has been held back ${held} time(s) in the last fortnight.` : null,
    '',
    'The alert:',
    String(text).slice(0, 1200),
  ].filter((l) => l !== null).join('\n');

  // First brain that answers wins. Not a vote: this is in the hot path of an
  // outage and three round trips is three chances to be too late.
  for (const brain of panel.slice(0, 2)) {
    try {
      const out = await Promise.race([
        callProse(env, brain, {
          system: SYSTEM,
          messages: [{ role: 'user', content: context }],
          maxTokens: 60,
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('triage timeout')), TRIAGE_TIMEOUT_MS)),
      ]);
      const line = String(out?.text ?? '').trim();
      // Parsed strictly and from the FRONT. A model that rambles before its
      // verdict has not answered in the shape asked for, and an answer we have
      // to go hunting in is an answer we should not act on.
      const m = /^\s*(PAGE|DIGEST)\b[:\-—\s]*(.*)$/is.exec(line);
      if (!m) continue;
      return {
        decision: m[1].toLowerCase() === DIGEST ? DIGEST : PAGE,
        why: (m[2] || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        judge: brain.id,
      };
    } catch (e) {
      console.warn('[alerttriage]', brain.id, e?.message ?? e);
      // Next brain, then send. Never silence on an error.
    }
  }
  return null;
}

/**
 * THE DECISION. Returns `{ send, why, judge, bypass }`.
 *
 * `send` is true unless a judge explicitly and successfully said otherwise.
 */
export async function triage(env, { text, kind = 'alert', subject = '', severity = '' } = {}) {
  const bypass = mustPage({ kind, text, severity });
  if (bypass) return { send: true, bypass, why: 'never gated', judge: null };

  let verdict = null;
  try {
    await ensure(env);

    // ── AN ALL-CLEAR FOLLOWS THE ALARM IT ANSWERS ─────────────────────────
    //
    // "✅ Num is healthy again." reads to a judge like good news that can
    // wait, and on its own it can. But if Dre was texted at 2am that the
    // product was down, leaving him to find out at breakfast that it came
    // back is worse than the original alert — he spends the night assuming
    // the worst. So the all-clear inherits the alarm's urgency: sent if
    // anything was paged in the last day, judged like anything else if not.
    if (/healthy again|recovered|back up|all clear/i.test(String(text))) {
      const paged = await env?.DB?.prepare(
        "SELECT 1 FROM num_alert_triage WHERE sent = 1 AND at > datetime('now','-24 hours') LIMIT 1",
      ).first().catch(() => null);
      if (paged) return { send: true, bypass: 'all-clear for a page already sent', why: '', judge: null };
    }

    const held = await heldBefore(env, subject || String(text).slice(0, 100));
    verdict = await askJudge(env, { text, kind, held });
  } catch (e) {
    console.warn('[alerttriage] fell open —', e?.message ?? e);
    verdict = null;
  }

  const send = verdict ? verdict.decision === PAGE : true;
  const why = verdict?.why || (verdict ? '' : 'no judge answered — sent by default');

  // Written down either way. A held-back alert that leaves no trace is the
  // product deciding what its owner is allowed to know.
  try {
    await env?.DB?.prepare(
      `INSERT INTO num_alert_triage (kind, subject, body, decision, why, judge, sent)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`,
    ).bind(
      String(kind).slice(0, 40),
      String(subject || text).slice(0, 200),
      String(text).slice(0, 1000),
      send ? PAGE : DIGEST,
      String(why).slice(0, 200),
      verdict?.judge ?? null,
      send ? 1 : 0,
    ).run();
  } catch { /* the ledger is not allowed to stop the alert */ }

  return { send, why, judge: verdict?.judge ?? null, bypass: null };
}

/**
 * The morning summary of everything held back.
 *
 * "Not urgent" must never mean "never told". This is the other half of the
 * bargain: the judge may keep the phone quiet overnight only because this
 * runs in the morning.
 *
 * Returns null when there is nothing to say — a digest that arrives every day
 * saying "nothing" is a digest people stop opening.
 */
export async function digestText(env, { hours = 24 } = {}) {
  if (!env?.DB) return null;
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT id, kind, subject, why, at FROM num_alert_triage
      WHERE sent = 0 AND digested = 0 AND at > datetime('now', ?1)
      ORDER BY at ASC LIMIT 40`,
  ).bind(`-${Math.max(1, Math.min(168, hours | 0))} hours`).all().catch(() => ({ results: [] }));
  const rows = results ?? [];
  if (!rows.length) return null;

  const lines = rows.map((r) => `• ${String(r.subject ?? '').split('\n')[0].slice(0, 90)}`);
  const text = `🗒 Num overnight — ${rows.length} thing(s) held back, none urgent:\n\n`
    + `${lines.join('\n')}\n\nFull detail: /api/admin/failures`;
  return { text, ids: rows.map((r) => r.id), count: rows.length };
}

/** Mark a digest as delivered so tomorrow's does not repeat it. */
export async function markDigested(env, ids = []) {
  if (!env?.DB || !ids.length) return;
  const marks = ids.map((_, i) => `?${i + 1}`).join(',');
  await env.DB.prepare(`UPDATE num_alert_triage SET digested = 1 WHERE id IN (${marks})`)
    .bind(...ids).run().catch(() => {});
}

/**
 * Send the morning digest. Called from the cron, once a day.
 *
 * Goes out through `alert()` like anything else, and is itself never judged:
 * 'digest' is on NEVER_GATED, because a summary of things already judged not
 * urgent cannot be judged again — the only verdict that path could produce is
 * "hold it for tomorrow's digest", which is how nothing is ever told.
 */
export async function sendDigest(env) {
  const d = await digestText(env);
  if (!d) return { sent: false, reason: 'nothing held back' };
  const { alert } = await import('./health.mjs');
  await alert(env, d.text, { kind: 'digest', subject: 'overnight digest' });
  await markDigested(env, d.ids);
  return { sent: true, count: d.count };
}
