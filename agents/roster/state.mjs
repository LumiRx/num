/**
 * The preconditions in a charter, resolved from what is actually true.
 *
 * charter().requires lists names — 'a2p_approved', 'resend_key_present' — and
 * until now a caller passed a `state` object saying whether each held. That is
 * a flag a human sets, and a flag a human sets is a flag a human sets wrongly.
 *
 * Today made the case better than any argument could. A2P had been approved
 * since 28 July. The code that attaches the campaign shipped on 25 August. The
 * secret was set. And every message was still failing, because the value
 * pasted into TWILIO_MESSAGING_SERVICE_SID began `PN` — a Phone Number SID,
 * not a Messaging Service SID. Anybody asked "is A2P approved?" would have
 * said yes, truthfully, and been wrong about the only thing that mattered.
 *
 * So preconditions are DERIVED. Each one is a question with a checkable
 * answer, and each returns the reason when the answer is no — because an agent
 * that silently declines to run is indistinguishable from an agent that is
 * broken.
 *
 * The rule for adding one: it must be answerable from config or the database
 * without asking a person. If the only way to know is to ask somebody, it is
 * not a precondition, it is a decision, and it belongs in the charter's
 * `never` list instead.
 */

/** MG + 32 hex. An account SID starts AC, a campaign CM, a brand BN, a number PN. */
export const MESSAGING_SERVICE_RE = /^MG[0-9a-f]{32}$/i;

/**
 * Every precondition the roster knows how to answer.
 * Each: (env, db) → { ok, why? }
 */
export const RESOLVERS = Object.freeze({

  /**
   * Not "has the campaign been approved" — that has been true since 28 July
   * and was never the blocker. The question that decides whether a US text
   * arrives is whether this deployment can ASSOCIATE a message with the
   * approved campaign, and that is true only when a well-formed Messaging
   * Service SID is present. A bare number is rejected with the same 30034 an
   * unregistered brand gets, which is how a month was lost.
   */
  a2p_approved: (env) => {
    const svc = String(env?.TWILIO_MESSAGING_SERVICE_SID || '').trim();
    if (!svc) {
      return { ok: false, why: 'TWILIO_MESSAGING_SERVICE_SID is not set, so US texts go out as a bare number and are rejected 30034 even with the campaign approved' };
    }
    if (!MESSAGING_SERVICE_RE.test(svc)) {
      return { ok: false, why: `TWILIO_MESSAGING_SERVICE_SID is ${svc.slice(0, 2)}… — a Messaging Service SID starts MG. AC is an account, CM a campaign, BN a brand, PN a phone number` };
    }
    return { ok: true };
  },

  twilio_configured: (env) => {
    if (!env?.TWILIO_SID || !env?.TWILIO_TOKEN) return { ok: false, why: 'TWILIO_SID or TWILIO_TOKEN is missing' };
    if (!env?.TWILIO_FROM) return { ok: false, why: 'TWILIO_FROM is missing — no sender' };
    return { ok: true };
  },

  resend_key_present: (env) =>
    (env?.RESEND_KEY || env?.RESEND_API_KEY)
      ? { ok: true }
      : { ok: false, why: 'RESEND_KEY is not bound on this worker' },

  /**
   * The A2P lesson, a second time, on the other channel.
   *
   * `resend_key_present` above answers "is a secret bound", and on 30 Aug 2026
   * it answered YES while every single send was being refused:
   *
   *   resend 403 — This API key is not authorized to send emails from itsnum.com
   *
   * The key was set. The domain was verified. SPF, DKIM and the SES feedback MX
   * were all live in DNS. The key was simply a restricted sending key with no
   * authorised domain attached, and asking "is the key present" could never
   * have found that. The cron fired every five minutes for five days, failed
   * every time, and the only evidence was the `error` column nobody read.
   *
   * So this precondition is answered by what HAPPENED, not by what is
   * configured. `facts` comes from sendFacts() below — a query, not a flag —
   * and the question is whether the last attempt actually left the building.
   */
  send_path_proven: (_env, facts = {}) => {
    if (facts.lastSendError) {
      return { ok: false, why: `the last outbound attempt failed: ${facts.lastSendError}` };
    }
    if (facts.lastSendAt === null) {
      return { ok: false, why: 'no invite has ever been sent successfully, so the send path is unproven rather than working' };
    }
    return { ok: true };
  },

  lead_batch_configured: (env) =>
    env?.INVITE_LEAD_BATCH
      ? { ok: true }
      : { ok: false, why: 'INVITE_LEAD_BATCH names no batch, so there is nothing to send' },

  inbox_configured: (env) =>
    env?.INBOUND_MAIL_READY || env?.RESEND_KEY || env?.RESEND_API_KEY
      ? { ok: true }
      : { ok: false, why: 'no inbound mail path configured' },

  /**
   * Per-recipient rather than global, so it is answered at send time against
   * the row in front of us. Present here so the name resolves; a charter
   * carrying it is telling the reader that the agent must check consent for
   * each recipient, which its own select() is responsible for doing.
   */
  consent_row_present: () => ({ ok: true, note: 'checked per recipient at send time, not globally' }),
});

/**
 * What the database says about whether NUM's outbound mail actually works.
 *
 * The one query this file needs, kept here rather than in the agent, because
 * "did the last send leave the building" is a question about the roster's
 * preconditions and not about any one agent's job.
 *
 * Deliberately reads the LATEST attempt rather than a success rate: a send
 * path that worked in July and has failed every time since is broken now, and
 * an average over the month would report it as mostly fine.
 *
 * @param {{prepare:Function}} db a D1 binding
 * @returns {Promise<{lastSendAt:string|null, lastSendError:string|null, failedSince:number}>}
 */
export async function sendFacts(db) {
  if (!db?.prepare) return {};
  const last = await db.prepare(
    "SELECT status, error, COALESCE(sent_at, queued_at) AS at FROM num_invites ORDER BY COALESCE(sent_at, queued_at) DESC LIMIT 1",
  ).first();
  const sent = await db.prepare(
    "SELECT MAX(sent_at) AS at FROM num_invites WHERE status = 'sent'",
  ).first();
  const failed = await db.prepare(
    "SELECT COUNT(*) AS n FROM num_invites WHERE status = 'failed'",
  ).first();
  return {
    lastSendAt: sent?.at ?? null,
    lastSendError: last?.status === 'failed' ? (last.error || 'failed with no error recorded') : null,
    failedSince: Number(failed?.n || 0),
  };
}

/**
 * Answer every precondition a charter names.
 *
 * `facts` is derived — sendFacts() above, or an equivalent query — never a
 * flag a person set. That distinction is the whole reason this file exists:
 * a human asked "is A2P approved?" answered yes, truthfully, for a month while
 * every message failed.
 *
 * @returns {{ok:boolean, state:object, blocked:Array<{name,why}>}}
 */
export function resolve(ch, env = {}, facts = {}) {
  const state = {};
  const blocked = [];
  for (const name of ch.requires) {
    const fn = RESOLVERS[name];
    if (!fn) {
      blocked.push({ name, why: `no resolver knows how to answer "${name}" — add one to state.mjs or drop it from the charter` });
      continue;
    }
    const r = fn(env, facts);
    state[name] = r.ok ? 1 : 0;
    if (!r.ok) blocked.push({ name, why: r.why });
  }
  return { ok: blocked.length === 0, state, blocked };
}

/**
 * One line per agent: can it run, and if not, what exactly would fix it.
 *
 *   node agents/roster/state.mjs
 *
 * Reads process.env, so it reports on the machine it is run from rather than
 * on production — useful for a dry check, not a substitute for the health
 * endpoint, which reads the deployed bindings.
 */
export function report(roster, env, facts = {}) {
  return roster.map((ch) => {
    const r = resolve(ch, env, facts);
    return { id: ch.id, ok: r.ok, blocked: r.blocked };
  });
}
