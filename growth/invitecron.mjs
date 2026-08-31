/**
 * The automated merchant-invite drain.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Sending 14,433 queued invites has, until now, meant a human running
 * scripts/send_invites.mjs by hand, watching a terminal, and re-running it
 * tomorrow. That does not scale to "every single business on our contact
 * list, continuously through the day" — and running an LLM in a loop to
 * decide when to send the next batch would spend tokens on a decision that is
 * pure arithmetic. So this is a Cloudflare Worker Cron Trigger: `scheduled()`
 * in worker.js calls `drainInvites()` on the SAME 15-minute tick the host-
 * invite drain already runs on. It costs zero Claude/Anthropic tokens per
 * send — the only ongoing cost is Cloudflare's own (Workers + D1 + Resend),
 * which is what the rest of this worker already runs on.
 *
 * Every safety rail below is ported from scripts/send_invites.mjs, which a
 * human read and ran by hand for the first waves. Nothing here is new policy
 * — it is the same policy, running on a timer instead of a terminal.
 *
 * ── WHY THAILAND IS NOT IN SEND_WINDOWS ───────────────────────────────────
 *
 * The Thai invite copy has not been read by a Thai speaker (open item, see
 * claude/num-VENUE-OUTREACH-EMAIL-2026-08-25.md). 5,593 Phuket businesses sit
 * behind that copy. A destination that is not a key in SEND_WINDOWS is never
 * selected, at any hour, on any day — failing closed, the same way
 * `bookdesk.mjs`'s `partnerMayBeTexted()` refuses a number with no consent
 * row rather than guessing. Add `'phuket'` to SEND_WINDOWS once a Thai
 * speaker has signed off the copy; nothing else needs to change.
 */

import { generateInvite, riskOf, excludeReason, isFreemail } from '../scripts/invite_gen.mjs';
import { INVITE_TEMPLATE } from './invitetemplate.mjs';
import { sendBatch } from './resend.mjs';

/* ── schema ──────────────────────────────────────────────────────────────── */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_invites (
  token TEXT PRIMARY KEY,
  lead_id TEXT,
  email TEXT NOT NULL,
  business_name TEXT,
  category TEXT,
  dest TEXT,
  country TEXT,
  risk TEXT,
  subject TEXT,
  batch TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  sent_at TEXT,
  provider_id TEXT,
  error TEXT,
  open_count INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT,
  click_count INTEGER NOT NULL DEFAULT 0,
  clicked_at TEXT,
  unsubscribed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
// accounts/invites.js (the num-accounts Worker) reads and writes open_count,
// opened_at, click_count, clicked_at and unsubscribed_at, and was deployed
// before this table's CREATE statement lived anywhere in the repo — the live
// table may already exist, narrower, from whenever it was first hand-created.
// Each ADD COLUMN is therefore its own statement, swallowed on "duplicate
// column name", exactly like commission.mjs's MIGRATIONS array.
const MIGRATIONS = [
  'ALTER TABLE num_invites ADD COLUMN open_count INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE num_invites ADD COLUMN opened_at TEXT',
  'ALTER TABLE num_invites ADD COLUMN click_count INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE num_invites ADD COLUMN clicked_at TEXT',
  'ALTER TABLE num_invites ADD COLUMN unsubscribed_at TEXT',
];

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.prepare(SCHEMA.trim()).run();
  for (const m of MIGRATIONS) await env.DB.prepare(m).run().catch(() => {});
  // Defence in depth against the race the CLI tool's own comment admits to
  // (see send_invites.mjs's claimSql note): a UNIQUE index makes a second
  // INSERT for the same address fail outright instead of relying only on the
  // SELECT-time LEFT JOIN to have noticed in time. Fails soft — if duplicate
  // emails already exist in a live table, the index simply does not get
  // created, and the SELECT-time check (unchanged) still applies.
  await env.DB.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_email ON num_invites(email)',
  ).run().catch(() => {});
  // accounts/invites.js's unsubscribe handler already writes
  // `leads.status = 'opted_out'`, in production, whether or not that column
  // was ever formally migrated in — this makes the drain self-healing on a
  // `leads` table that predates it.
  await env.DB.prepare('ALTER TABLE leads ADD COLUMN status TEXT').run().catch(() => {});
  ready = true;
}
/** Test hook — mirrors commission.mjs's _resetSchemaCache. */
export const _resetSchemaCache = () => { ready = false; };

/* ── pacing: which destinations, which days, how many ─────────────────────── */

/**
 * UTC hour ranges approximating "mid-morning, the recipient's own timezone" —
 * the ramp plan's own words. DST shifts these by up to an hour twice a year;
 * accepted rather than solved, the same way the ramp plan's day-of-week gate
 * (below) is Tue–Thu in UTC, not in each recipient's own calendar day, which
 * can disagree by up to a few hours near midnight UTC. Both are documented
 * approximations, not silent ones.
 */
export const SEND_WINDOWS = Object.freeze({
  edinburgh: Object.freeze({ utcHours: [8, 9, 10, 11] }),    // ~9am-12pm BST/GMT
  'los-angeles': Object.freeze({ utcHours: [16, 17, 18, 19] }), // ~9am-12pm PT
});

/**
 * Which days may send.
 *
 * Was Tue/Wed/Thu, ported from the ramp plan. Widened to every day on 30 Aug
 * 2026, and the distinction is worth stating because it is easy to widen the
 * wrong thing: Tue-Thu is an OPEN-RATE convention, not a deliverability one.
 * The number that protects the domain is messages PER DAY, and that is the
 * ramp, which is untouched. Sending 50 on a Saturday and 50 on a Sunday is
 * exactly as safe as sending 50 on a Tuesday — it is simply 2.3x the weekly
 * throughput for the same daily volume and the same reputation risk.
 *
 * The cost is real but small: weekend mail is opened later and by fewer
 * people. Against a queue of 14,403 that is the right trade.
 */
const SEND_DAYS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);

/**
 * Which destinations are open for sending at this exact UTC moment, or []
 * when none are (the wrong day, or between windows).
 */
export function openDestinations(now) {
  if (!SEND_DAYS.includes(now.getUTCDay())) return [];
  const hour = now.getUTCHours();
  return Object.entries(SEND_WINDOWS)
    .filter(([, w]) => w.utcHours.includes(hour))
    .map(([dest]) => dest);
}

/**
 * The five-week ramp from claude/num-VENUE-OUTREACH-EMAIL-2026-08-25.md,
 * ported to code instead of a human's calendar reminder. `afterDays` counts
 * whole days since `env.INVITE_RAMP_START` (a UTC date, "YYYY-MM-DD").
 */
const RAMP = Object.freeze([
  { afterDays: 0, dailyCap: 50 },
  { afterDays: 7, dailyCap: 150 },
  { afterDays: 14, dailyCap: 400 },
  { afterDays: 21, dailyCap: 800 },
  { afterDays: 28, dailyCap: 1500 },
]);

/** Today's daily cap, given how many whole days have passed since launch. */
export function dailyCap(env, now) {
  const startStr = env?.INVITE_RAMP_START;
  const start = startStr ? new Date(`${startStr}T00:00:00Z`) : now;
  const days = Math.max(0, Math.floor((now - start) / 86400000));
  let cap = RAMP[0].dailyCap;
  for (const r of RAMP) if (days >= r.afterDays) cap = r.dailyCap;
  return cap;
}

/**
 * How many 15-minute cron ticks remain TODAY that fall inside any
 * destination's send window, counting from the next tick after `now`.
 *
 * This is what makes sending actually spread across the day rather than
 * exhausting a small daily cap in the window's first few minutes: the
 * per-tick budget below is `remaining ÷ this`, so an early-ramp cap of 50
 * lands in roughly even pieces across the ~32 ticks (two 4-hour windows) it
 * has to work with, not as 40 in the first tick and 10 in the second.
 */
export function ticksRemainingToday(now) {
  let count = 0;
  const t = new Date(now);
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(Math.ceil(t.getUTCMinutes() / 15) * 15);
  const endOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  for (let ms = t.getTime(); ms < endOfDay; ms += 15 * 60 * 1000) {
    const x = new Date(ms);
    if (openDestinations(x).length) count++;
  }
  return count;
}

/* ── the drain itself ──────────────────────────────────────────────────── */

/**
 * The candidate rows for one drain tick, straight off `leads` — before
 * `selectBatch`'s in-memory filters (wrong audience, tier, domain dedupe)
 * ever run.
 *
 * Split out from `drainInvites` on purpose: the exclusions this SQL enforces
 * — never a lead already in num_invites (any status, ever), never a
 * suppressed address, never an opted-out lead, never outside this batch or
 * today's open destinations — are the ones a `UNIQUE(email)` index on
 * num_invites CANNOT independently prove, because a table that already had
 * data before that index existed masks exactly this query being wrong. A
 * test can now seed `num_invites`/`num_suppressions`/`leads` and assert on
 * what THIS returns, without a send ever having to happen.
 */
export async function candidateRows(env, dests, limit) {
  const destList = dests.map((d) => q(d.toLowerCase())).join(',');
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.name, l.category, l.dest, l.area, l.country, l.email, l.website, l.address
       FROM leads l
       LEFT JOIN num_invites i ON lower(i.email) = lower(l.email)
       LEFT JOIN num_suppressions s ON lower(s.email) = lower(l.email)
      WHERE l.batch = ?1
        AND l.email IS NOT NULL AND l.email <> '' AND l.email LIKE '%@%'
        AND lower(l.dest) IN (${destList})
        AND (l.status IS NULL OR l.status <> 'opted_out')
        AND i.token IS NULL
        AND s.email IS NULL
      -- Business domains first, freemail last.
      --
      -- 7,651 of the 14,403 addresses in this batch are gmail, yahoo, hotmail
      -- or outlook — 53%. Cold mail to a consumer mailbox is judged by that
      -- mailbox's provider far more harshly than mail to a company domain, and
      -- a complaint from a Gmail user costs a sending domain more than a
      -- complaint from anywhere else. Sending the business half FIRST means
      -- the reputation being built during the ramp is built on the traffic
      -- most likely to be welcomed, and the riskiest half is sent last, from
      -- a domain that by then has weeks of clean history behind it.
      --
      -- It also front-loads the leads most likely to convert: an address at a
      -- restaurant's own domain is far more likely to reach whoever can
      -- actually claim the listing than the owner's personal Gmail.
      ORDER BY (l.priority IS NULL), l.priority,
               CASE WHEN lower(l.email) LIKE '%@gmail.com'
                      OR lower(l.email) LIKE '%@yahoo.%'
                      OR lower(l.email) LIKE '%@hotmail.%'
                      OR lower(l.email) LIKE '%@outlook.%'
                      OR lower(l.email) LIKE '%@icloud.com'
                      OR lower(l.email) LIKE '%@qq.com'
                      OR lower(l.email) LIKE '%@163.com'
                     THEN 1 ELSE 0 END,
               l.name
      LIMIT ?2`,
  ).bind(env.INVITE_LEAD_BATCH, limit).all();
  return results ?? [];
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * One cron tick's worth of sending.
 *
 * @param {object} env    needs DB, RESEND_KEY, MAIL_FROM, SITE,
 *                         INVITE_LEAD_BATCH, INVITE_RAMP_START,
 *                         INVITE_SEND_BUDGET (a per-tick ceiling, independent
 *                         of the ramp's daily cap — a safety valve against a
 *                         bug in the ramp math ever sending hundreds in one
 *                         request)
 * @param {{scheduledTime?: number}} event   the Cron Trigger event
 */
/**
 * Failures that are about NUM rather than about the recipient.
 *
 * A bounce, a rejected address, a full mailbox — those are facts about the
 * lead and the row should stay `failed` forever. An invalid key, an
 * unauthorised domain, a missing provider or a rate limit are facts about us,
 * and burning a business over one is throwing away something we cannot get
 * back to fix a problem that has nothing to do with them.
 */
export const OUR_FAULT = /\b(401|403|429|5\d\d)\b|api key|not authorized|unauthori[sz]ed|invalid.*key|no RESEND_KEY|no_email_provider|domain config|rate.?limit/i;

export async function drainInvites(env, event = {}) {
  if (!env?.DB) return { sent: 0, reason: 'no DB' };
  if (!env.INVITE_LEAD_BATCH) return { sent: 0, reason: 'INVITE_LEAD_BATCH not set' };
  await ensure(env);

  const now = new Date(event.scheduledTime || Date.now());
  const dests = openDestinations(now);
  if (!dests.length) return { sent: 0, reason: 'outside every destination’s send window' };

  // ── THE CIRCUIT BREAKER ────────────────────────────────────────────────
  //
  // A failed invite marks its row `failed` FOREVER, and `candidateRows`
  // excludes any lead that already has a row. That permanence is deliberate
  // and correct — a bounce must never become a retry loop that emails the
  // same business twice — but it assumes the failure was about the RECIPIENT.
  //
  // When the failure is about US, the same mechanism becomes a shredder. On
  // 27–30 Aug 2026 the credential was dead (403, then 401) and this cron ran
  // every five minutes into it, permanently burning real businesses at six a
  // tick. 46 were gone by breakfast; 80 by the evening. Every one of them was
  // a lead that had never been contacted and now never could be.
  //
  // So: if the last attempt failed for a reason that is plainly ours, claim
  // nothing. A queue that waits is recoverable. A queue that burns is not.
  const last = await env.DB.prepare(
    "SELECT status, error FROM num_invites WHERE status = 'failed' ORDER BY queued_at DESC LIMIT 1",
  ).first().catch(() => null);
  if (last?.error && OUR_FAULT.test(last.error)) {
    return { sent: 0, reason: 'send path is broken — refusing to burn leads', error: String(last.error).slice(0, 200) };
  }

  const today = now.toISOString().slice(0, 10);
  const sentRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM num_invites WHERE status = 'sent' AND substr(sent_at, 1, 10) = ?1",
  ).bind(today).first().catch(() => null);
  const sentToday = sentRow?.n ?? 0;

  const cap = dailyCap(env, now);
  const remainingToday = cap - sentToday;
  if (remainingToday <= 0) return { sent: 0, reason: 'daily ramp cap reached', cap, sentToday };

  const ticksLeft = Math.max(1, ticksRemainingToday(now));
  const evenShare = Math.ceil(remainingToday / ticksLeft);
  const hardCeiling = Math.max(1, Number(env.INVITE_SEND_BUDGET) || 25);
  const tick = Math.max(1, Math.min(evenShare, remainingToday, hardCeiling));

  const rows = await candidateRows(env, dests, tick * 12);
  const batch = selectBatch(rows, tick);
  if (!batch.length) return { sent: 0, reason: 'no eligible candidates', dests, tick };

  const base = env.SITE || 'https://itsnum.com';
  const drafts = batch.map((lead) => {
    const token = crypto.randomUUID();
    return { lead, token, draft: generateInvite(lead, { template: INVITE_TEMPLATE, token, base }) };
  });

  // Ledger before send — an insert that fails (the UNIQUE index above firing
  // on a race) drops that one recipient from THIS tick rather than aborting
  // the batch; it is picked up again, correctly excluded, next tick.
  const claimed = [];
  for (const { lead, token, draft } of drafts) {
    const ins = await env.DB.prepare(
      `INSERT INTO num_invites
         (token, lead_id, email, business_name, category, dest, country, risk, subject, batch, status)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'queued')`,
    ).bind(
      token, String(lead.id ?? ''), lead.email, lead.name, lead.category ?? null,
      lead.dest ?? null, lead.country ?? null, riskOf(lead.country), draft.subject,
      env.INVITE_LEAD_BATCH,
    ).run().catch(() => null);
    if (ins?.meta?.changes) claimed.push({ lead, token, draft });
  }
  if (!claimed.length) return { sent: 0, reason: 'lost every race to a concurrent tick', attempted: drafts.length };

  const messages = claimed.map(({ lead, token, draft }) => ({
    __idem: 'invite-' + token,
    from: env.MAIL_FROM || 'NUM <info@itsnum.com>',
    to: [lead.email],
    // Not hardcoded any more. info@itsnum.com's MX points at an SES inbound
    // host with no receipt rule set, so it rejects at the SMTP layer: every
    // business that hit reply on one of the 1,051 invites already sent got a
    // bounce, and so did anyone using the mailto unsubscribe below — which is
    // one of the two opt-out routes CAN-SPAM and PECR require us to honour.
    replyTo: [env.MAIL_REPLY_TO || 'info@itsnum.com'],
    subject: draft.subject,
    html: draft.html,
    text: draft.text,
    headers: {
      'List-Unsubscribe': `<${draft.fields.unsub_url}>, <mailto:${env.MAIL_REPLY_TO || 'info@itsnum.com'}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    tags: [
      { name: 'kind', value: 'merchant_invite' },
      { name: 'dest', value: String(lead.dest || 'unknown').toLowerCase().replace(/[^a-z0-9_-]+/g, '-') },
    ],
  }));

  const res = await sendBatch(env, messages);
  if (!res.ok) {
    // Resend's batch endpoint is all-or-nothing (see resend.mjs). Reverting
    // to 'failed' rather than deleting the row keeps the permanent-exclusion
    // guarantee: a bounce or an outage on our side must not turn into a
    // retry loop that eventually emails the same business twice.
    await env.DB.batch(claimed.map(({ token }) =>
      env.DB.prepare("UPDATE num_invites SET status='failed', error=?1 WHERE token=?2")
        .bind(String(res.error || 'send failed').slice(0, 300), token),
    )).catch(() => {});
    return { sent: 0, failed: claimed.length, error: res.error, dests, tick };
  }

  await env.DB.batch(claimed.map(({ token }, i) =>
    env.DB.prepare("UPDATE num_invites SET status='sent', sent_at=datetime('now'), provider_id=?1 WHERE token=?2")
      .bind(res.ids[i] || null, token),
  )).catch(() => {});

  return { sent: claimed.length, dests, tick, cap, sentToday: sentToday + claimed.length };
}

/**
 * The same local filters scripts/send_invites.mjs applies after its D1 read:
 * wrong-audience exclusion, jurisdiction tier ceiling (fixed at 'ok' here —
 * the automated drain never reaches for 'care'/'hold' without a human
 * changing this file), and one address per domain per tick, freemail-aware.
 *
 * Kept as a small pure function, apart from drainInvites, so it is testable
 * without a database.
 */
export function selectBatch(rows, limit) {
  const seenEmail = new Set();
  const seenDomain = new Set();
  const out = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    const email = String(r.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) continue;
    if (excludeReason(r)) continue;
    if (riskOf(r.country) !== 'ok') continue;
    if (seenEmail.has(email)) continue;
    const domain = email.split('@')[1];
    if (!isFreemail(domain) && seenDomain.has(domain)) continue;
    seenEmail.add(email);
    seenDomain.add(domain);
    out.push({ ...r, email });
  }
  return out;
}
