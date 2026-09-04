/**
 * One agent per business.
 *
 * ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ─────────────────────────
 *
 * `num_business_profiles.owner_agent` has existed since the 31 Jul migration
 * and nothing in this repo has ever read or written it. Whoever wrote that
 * column expected this file. This is it.
 *
 * IT IS: a durable record, per business, that carries what NUM knows about
 * that business, what is outstanding, and what it wants a human to do next —
 * so the answer to "where are we with Suay Restaurant" does not depend on
 * somebody remembering a conversation from three weeks ago.
 *
 * IT IS NOT: something that talks to a business on its own. Every message this
 * file produces is a DRAFT with `ai_generated: true` on it, in the same shape
 * and for the same reason as bizdossier.mjs. The bar set by bizonboard.mjs —
 * "every sentence has to be true on the day it is sent" — cannot be met by a
 * model writing unreviewed to a real restaurant. An agent that emails merchants
 * by itself is one hallucinated commission rate away from a contract dispute,
 * and NUM would find out about it from the merchant.
 *
 * So the agent proposes; a person sends. The moment a channel exists that is
 * safe to automate — a reply to the business's own question, say — it goes
 * behind its own flag, the way BIZ_ONBOARD_EMAIL gates the one email that does
 * send today.
 *
 * ── HOW IT REPORTS UP ─────────────────────────────────────────────────────
 *
 * Each agent produces a report; `rollup()` folds every report into one brief
 * for the overall NUM brain and for the ops console. The rollup is what makes
 * these agents a system rather than 200 disconnected notes: it is the only
 * place that can see "eleven businesses are all waiting on the same switch",
 * which is one action, not eleven.
 */
import { readinessFor, roster, debts } from './bizreadiness.mjs';
import { NOT_PROBE } from './asks.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_business_agents (
  business_id    TEXT PRIMARY KEY,
  agent_id       TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'active',
  brief          TEXT,
  brief_at       TEXT,
  report         TEXT,
  report_at      TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS num_business_agent_notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  body         TEXT NOT NULL,
  ai_generated INTEGER NOT NULL DEFAULT 1,
  sent_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bizagent_notes ON num_business_agent_notes(business_id, created_at);
`;

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.batch(
    SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)),
  );
  ready = true;
}

/**
 * The agent's id, derived from the business id rather than generated.
 *
 * A random id means a second run creates a second agent, and then two records
 * disagree about the same business with nothing to say which is current. A
 * derived id makes `ensureAgent` genuinely idempotent and makes the join
 * legible to anyone reading the database by hand.
 */
export const agentIdFor = (businessId) =>
  `bizagent_${String(businessId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)}`;

/**
 * Create this business's agent if it has none, and write `owner_agent`.
 *
 * The profile UPDATE is not fatal: a business can have an agent record before
 * it has a profile row (that is precisely the state `account` on the readiness
 * checklist reports), and refusing to create the agent in that case would deny
 * an agent to exactly the businesses whose setup is most incomplete.
 */
export async function ensureAgent(env, businessId, { name } = {}) {
  if (!env?.DB || !businessId) return { ok: false, error: 'no business' };
  await ensure(env);
  const id = String(businessId);
  const agentId = agentIdFor(id);

  const existing = await env.DB.prepare(
    'SELECT agent_id, state FROM num_business_agents WHERE business_id = ?1',
  ).bind(id).first().catch(() => null);

  if (!existing) {
    const label = String(name ?? '').trim()
      || (await env.DB.prepare('SELECT name FROM businesses WHERE id = ?1').bind(id).first()
        .catch(() => null))?.name
      || id;
    await env.DB.prepare(
      `INSERT INTO num_business_agents (business_id, agent_id, name)
       VALUES (?1, ?2, ?3) ON CONFLICT(business_id) DO NOTHING`,
    ).bind(id, agentId, String(label).slice(0, 120)).run();
  }

  // The column this whole file exists to finally use. Written every time
  // rather than only on create, so a profile that arrives after the agent
  // still ends up pointing at it.
  await env.DB.prepare(
    'UPDATE num_business_profiles SET owner_agent = ?2, updated_at = CAST(strftime(\'%s\',\'now\') AS INTEGER) WHERE business_id = ?1',
  ).bind(id, agentId).run().catch(() => {});

  return { ok: true, agent_id: agentId, created: !existing };
}

/**
 * Everything this agent knows about its business, assembled fresh.
 *
 * Deliberately NOT cached into the `brief` column and read from there: the
 * column is a snapshot for the console to show without doing nine reads, and
 * anything that makes a decision calls this instead. A cached brief that
 * decides something is a decision made on last week's world.
 */
export async function agentBrief(env, businessId) {
  const readiness = await readinessFor(env, businessId);
  if (!readiness) return null;
  await ensure(env);

  const [bookings, asks, notes] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM num_booking_requests WHERE place_id = ?1`,
    ).bind(readiness.place_id ?? '').first().catch(() => null),
    readiness.dest
      ? env.DB.prepare(
        `SELECT COUNT(*) AS n FROM num_asks WHERE dest = ?1 AND ts >= datetime('now','-30 days') AND ${NOT_PROBE}`,
      ).bind(readiness.dest).first().catch(() => null)
      : Promise.resolve(null),
    env.DB.prepare(
      `SELECT kind, body, sent_at, created_at FROM num_business_agent_notes
        WHERE business_id = ?1 ORDER BY id DESC LIMIT 10`,
    ).bind(String(businessId)).all().catch(() => ({ results: [] })),
  ]);

  return {
    agent_id: readiness.agent_id ?? agentIdFor(businessId),
    business_id: readiness.business_id,
    name: readiness.name,
    where: readiness.dest,
    vertical: readiness.vertical,
    stage: readiness.stage,
    checklist: readiness.checklist,
    outstanding: readiness.outstanding,
    // Measured or absent — never estimated. Same contract as bizdash.mjs.
    booking_requests_all_time: bookings?.n ?? null,
    asks_in_destination_30d: asks?.n ?? null,
    // Details the agent found and is waiting on the owner to confirm. Kept
    // separate from `outstanding` on purpose: this is not something they
    // forgot to do, it is a question we asked them.
    awaiting_confirmation: await (async () => {
      try { return (await (await import('./bizenrich.mjs')).pendingFor(env, businessId)).length; }
      catch { return 0; }
    })(),
    history: notes?.results ?? [],
  };
}

/**
 * What this agent reports upward.
 *
 * Short on purpose. A report that lists everything is a report nobody reads,
 * and the rollup below has to fold two hundred of these into one page. Three
 * fields: where they are, what we owe them, what they owe us.
 */
export async function agentReport(env, businessId) {
  const brief = await agentBrief(env, businessId);
  if (!brief) return null;
  return {
    agent_id: brief.agent_id,
    business_id: brief.business_id,
    name: brief.name,
    stage: brief.stage,
    we_owe: brief.outstanding.ours.map((c) => c.id),
    they_owe: brief.outstanding.theirs.map((c) => c.id),
    cannot_see: brief.outstanding.unknown,
    // The one sentence a human should read first.
    headline: headline(brief),
  };
}

function headline(brief) {
  const ours = brief.outstanding.ours;
  const theirs = brief.outstanding.theirs;
  if (ours.length) return `Waiting on us: ${ours.map((c) => c.label.toLowerCase()).join(', ')}.`;
  if (theirs.length) return `Waiting on them: ${theirs.map((c) => c.label.toLowerCase()).join(', ')}.`;
  if (brief.stage === 'operating') return 'Set up and operating. Nothing outstanding.';
  return 'Nothing outstanding that we can see.';
}

/**
 * A draft message to the business — stored, never sent.
 *
 * `sent_at` stays null until a human sends it and records that. The row is the
 * proposal; sending is a separate, deliberate act with its own audit trail,
 * exactly as bizdossier stores AI promo ideas as drafts for Dre's call.
 */
export async function draftNudge(env, businessId) {
  const brief = await agentBrief(env, businessId);
  if (!brief) return null;
  const theirs = brief.outstanding.theirs;
  if (!theirs.length) return null; // Never draft a message with nothing to ask for.
  await ensure(env);

  const asks = theirs.map((c) => `· ${c.label} — ${c.why}`).join('\n');
  const body = [
    `${brief.name} is live on NUM. Two or three things are still missing before a`,
    'traveller who asks about you gets a complete answer:',
    '',
    asks,
    '',
    'You can set all of these yourself at https://app.itsnum.com/api/biz/console',
  ].join('\n');

  await env.DB.prepare(
    'INSERT INTO num_business_agent_notes (business_id, kind, body, ai_generated) VALUES (?1, ?2, ?3, 1)',
  ).bind(String(businessId), 'nudge_draft', body).run().catch(() => {});
  return { business_id: String(businessId), kind: 'nudge_draft', body, ai_generated: true, sent_at: null };
}

/**
 * Give every business an agent, and refresh what each one knows.
 *
 * A sweep rather than a hook, for the reason bizonboard.mjs sets out at
 * length: the failures this codebase keeps finding are all one-shot hooks that
 * fired once into a broken channel and then believed the job was done. A sweep
 * re-reads the world each tick, so a business whose agent could not be created
 * on Tuesday simply gets one on Wednesday.
 */
export async function agentSweep(env, { limit = 25 } = {}) {
  if (!env?.DB) return { created: 0, refreshed: 0, skipped: 'no database' };
  await ensure(env);

  const { results } = await env.DB.prepare(
    `SELECT b.id, b.name FROM businesses b
      LEFT JOIN num_business_agents a ON a.business_id = b.id
      WHERE a.business_id IS NULL
      ORDER BY b.created_at ASC LIMIT ?1`,
  ).bind(limit).all().catch(() => ({ results: [] }));

  let created = 0;
  for (const row of results ?? []) {
    const out = await ensureAgent(env, row.id, { name: row.name }).catch(() => null);
    if (out?.created) created += 1;
  }

  // Refresh the stored snapshots for the agents whose brief is stalest, so the
  // console has something to render without nine reads per row. Capped per
  // tick: this runs every five minutes and a full refresh of every agent every
  // tick is a lot of reads for a number that changes daily.
  const { results: stale } = await env.DB.prepare(
    `SELECT business_id FROM num_business_agents
      WHERE state = 'active'
      ORDER BY COALESCE(brief_at, '') ASC LIMIT ?1`,
  ).bind(limit).all().catch(() => ({ results: [] }));

  let refreshed = 0;
  for (const row of stale ?? []) {
    const report = await agentReport(env, row.business_id).catch(() => null);
    if (!report) continue;
    const brief = await agentBrief(env, row.business_id).catch(() => null);
    await env.DB.prepare(
      `UPDATE num_business_agents
          SET brief = ?2, brief_at = datetime('now'),
              report = ?3, report_at = datetime('now'),
              updated_at = datetime('now')
        WHERE business_id = ?1`,
    ).bind(
      String(row.business_id),
      JSON.stringify(brief ?? {}).slice(0, 20000),
      JSON.stringify(report).slice(0, 4000),
    ).run().catch(() => {});
    refreshed += 1;
  }

  // THE AGENT BUILDS ITS BUSINESS'S PROFILE.
  //
  // This is the part that makes an agent worth having rather than a row in a
  // table: it goes and finds the details the listing is missing, writes back
  // only what the business itself published, and asks about the rest. See
  // worker/bizenrich.mjs for why those are two different actions.
  //
  // Its own failure domain and a hard cap — each business costs up to two
  // outbound fetches and one of them is metered.
  let enriched = { seen: 0, applied: 0, proposed: 0 };
  try {
    const { enrichSweep } = await import('./bizenrich.mjs');
    enriched = await enrichSweep(env, { limit: 5 });
  } catch (e) {
    console.warn('[bizagent.enrich]', e?.message ?? e);
  }

  return { created, refreshed, enriched };
}

/**
 * Every agent's report, folded into one brief.
 *
 * This is the thing the overall NUM brain and the ops console both read. The
 * `debts` grouping is the point: it turns "eleven businesses each missing a
 * welcome email" into one line of work rather than eleven errands.
 */
export async function rollup(env, { limit = 200 } = {}) {
  const r = await roster(env, { limit });
  const reports = r.businesses.map((b) => ({
    agent_id: b.agent_id ?? agentIdFor(b.business_id),
    business_id: b.business_id,
    name: b.name,
    where: b.dest,
    stage: b.stage,
    we_owe: b.outstanding.ours.map((c) => c.id),
    they_owe: b.outstanding.theirs.map((c) => c.id),
    cannot_see: b.outstanding.unknown,
  }));
  return {
    generated_at: new Date().toISOString(),
    counts: {
      ...r.counts,
      agents: reports.filter((x) => x.agent_id).length,
      agents_missing: r.businesses.filter((b) => !b.agent_id).length,
    },
    // What NUM owes, grouped by the switch that fixes it.
    our_move: debts(r),
    reports,
    prospects: r.prospects,
    stages: r.stages,
    items: r.items,
  };
}
