/**
 * CROSS-ANALYSIS — what the cheap brains agree on, kept as evidence.
 *
 * Dre, 8 Sep 2026: "we have these brains at least for the picks we can
 * utlize them and cross analyze to build our database... we need to make
 * sure its not reliant on our claude account to work."
 *
 * ── THE IDEA ─────────────────────────────────────────────────────────────
 *
 * Every time Num answers "where should we eat", it shows one brain a list of
 * verified places and takes that brain's three. The other brains never see
 * the list. But their opinion is nearly free, and INDEPENDENT AGREEMENT is
 * evidence of a kind we cannot buy: when four models that share no training
 * run, no vendor and no prompt history all reach for the same Koreatown
 * restaurant out of twelve candidates, that convergence says something a
 * scraped category tag never will.
 *
 * So this replays real guest questions — after the guest has been answered,
 * on a cron, never on their turn — against the cheap brains, and records
 * where they converge.
 *
 * ── WHY IT CANNOT TOUCH ANTHROPIC ────────────────────────────────────────
 *
 * This is the requirement, not a preference. Claude is the brain that runs
 * out; when it does, Dre cannot ship. A background enrichment job that
 * competes with him for the same credit balance would take the product down
 * to make the directory prettier — exactly backwards.
 *
 * The guarantee is STRUCTURAL, not configured. `callProse` in brains.mjs has
 * no Anthropic path at all: it handles workers-ai and openai-compatible and
 * then throws. So even a bug that let an Anthropic brain into the voter list
 * would produce a thrown error and a skipped vote, never a charge. `voters()`
 * filters `kind === 'anthropic'` on top of that, and a test asserts both.
 *
 * ── WHY THE BALLOT USES NUMBERS, NOT IDS ─────────────────────────────────
 *
 * A brain is shown "1. Bestia / 2. Gjelina / ..." and answers with numbers.
 * Small models handle a short numbered list far better than opaque ids — but
 * the real reason is that a number outside 1..N is unparseable, so a voter
 * CANNOT name a place that was not on its ballot. The same discipline as
 * resolvePicks, enforced one layer earlier: the model never supplies an
 * identifier, only a choice among identifiers we supplied.
 *
 * ── THE DENOMINATOR IS THE WHOLE POINT ───────────────────────────────────
 *
 * On 7 Sep we found `ORDER BY reviews DESC` had been a no-op for months
 * because 123 of 313,248 restaurants carried a review count. The lesson was
 * that a number nobody checked the coverage of is worse than no number.
 *
 * So a vote count is never stored alone. `rounds` counts every ballot a
 * place APPEARED on; `agreements` counts the rounds where two or more brains
 * independently chose it. A place picked 3 times is meaningless until you
 * know whether it was offered 4 times or 400. `strength()` refuses to
 * answer below MIN_ROUNDS rather than return a confident-looking fraction
 * built on two observations.
 */
import { BRAINS, callProse } from './brains.mjs';

/**
 * Two brains, or it did not happen.
 *
 * One model liking a place is that model's taste, and we already have that —
 * it is what the live answer is made of. The new information is CONCURRENCE,
 * so one vote is deliberately worth nothing here.
 */
export const MIN_AGREEMENT = 2;

/** Below this many appearances, a rate is noise wearing a percentage sign. */
export const MIN_ROUNDS = 5;

/** How many places a voter may name. Three, like a real answer. */
export const MAX_PICKS = 3;

/** Candidates on a ballot. Enough to make a choice mean something. */
export const BALLOT_SIZE = 12;

/** Questions replayed per cron tick. Small on purpose — this is background. */
export const ASKS_PER_TICK = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_place_consensus (
  place_id TEXT NOT NULL,
  dest TEXT NOT NULL,
  cat TEXT NOT NULL DEFAULT '',
  rounds INTEGER NOT NULL DEFAULT 0,
  votes INTEGER NOT NULL DEFAULT 0,
  agreements INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (place_id, cat)
);
CREATE INDEX IF NOT EXISTS idx_consensus_dest ON num_place_consensus(dest, cat);
CREATE TABLE IF NOT EXISTS num_consensus_rounds (
  ask_id INTEGER PRIMARY KEY,
  dest TEXT,
  cat TEXT,
  voters INTEGER NOT NULL DEFAULT 0,
  candidates INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const readied = new WeakSet();
async function ensure(env) {
  if (!env?.DB || readied.has(env.DB)) return;
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run();
  }
  readied.add(env.DB);
}

/**
 * The brains allowed to vote.
 *
 * Anthropic is excluded by kind, before anything else is considered. The
 * remaining filter is `ready` — a brain with no key configured would throw on
 * every ballot and drag the tick out for nothing.
 */
export function voters(env = {}) {
  return BRAINS.filter((b) => b.kind !== 'anthropic' && typeof b.ready === 'function' && b.ready(env));
}

/**
 * Render a ballot. Returns the prompt text and the id behind each number, so
 * a vote can be mapped back to a real row and nothing else.
 */
export function ballotFor({ question, dest, rows }) {
  const picked = (rows ?? []).filter((r) => r?.id != null && r?.name).slice(0, BALLOT_SIZE);
  const lines = picked.map((r, i) => {
    const bits = [r.category, r.cuisine, r.area].filter(Boolean).join(', ');
    return `${i + 1}. ${r.name}${bits ? ` — ${bits}` : ''}`;
  });
  const text =
    `A traveller in ${dest || 'this city'} asked: "${String(question ?? '').slice(0, 300)}"\n\n` +
    `Candidates:\n${lines.join('\n')}\n\n` +
    `Choose the ${MAX_PICKS} best for that traveller. ` +
    `Reply with only the numbers, best first, separated by commas. No other words.`;
  return { text, ids: picked.map((r) => String(r.id)), size: picked.length };
}

/**
 * Read a voter's reply into candidate positions.
 *
 * Anything that is not a number in 1..size is discarded silently — a brain
 * that answers in prose, invents a fourteenth candidate, or repeats itself
 * simply casts fewer valid votes. It never casts a wrong one.
 */
export function readVotes(text, size) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/\d+/g)) {
    const n = Number(m[0]);
    if (!Number.isInteger(n) || n < 1 || n > size) continue;
    if (out.includes(n)) continue;
    out.push(n);
    if (out.length >= MAX_PICKS) break;
  }
  return out;
}

/**
 * One voter, one ballot. Returns positions, or [] on any failure.
 *
 * A brain being down must never fail the round — the whole point of asking
 * several is that they do not share a failure. `callProse` throws for an
 * Anthropic brain, which is the structural guard described at the top.
 */
export async function voteWith(env, brain, ballot) {
  try {
    const out = await callProse(env, brain, {
      messages: [{ role: 'user', content: ballot.text }],
      system: 'You are a local concierge choosing between verified venues. Answer with numbers only.',
      maxTokens: 32,
    });
    return readVotes(out?.text, ballot.size);
  } catch {
    return [];
  }
}

/**
 * Count how many DISTINCT brains named each position.
 *
 * Distinct is the load-bearing word. If one brain were allowed to vote twice
 * — a retry, a duplicated entry in the voter list — its own opinion would
 * become "agreement", which is the one thing this table must never record.
 */
export function tally(ballotsByBrain) {
  const counts = new Map();
  for (const [brainId, positions] of Object.entries(ballotsByBrain ?? {})) {
    for (const p of new Set(positions ?? [])) {
      const seen = counts.get(p) ?? new Set();
      seen.add(brainId);
      counts.set(p, seen);
    }
  }
  return new Map([...counts].map(([p, set]) => [p, set.size]));
}

/**
 * How much a consensus row is worth, or null when we have not looked enough.
 *
 * Null rather than 0: "never converged" and "not enough data to say" are
 * different facts, and collapsing them is how a ranking column becomes a lie.
 */
export function strength(row) {
  const rounds = Number(row?.rounds ?? 0);
  if (!rounds || rounds < MIN_ROUNDS) return null;
  return Number(row?.agreements ?? 0) / rounds;
}

/** Questions worth replaying: real, located, and not already run. */
export async function pending(env, limit = ASKS_PER_TICK) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.text, a.dest, COALESCE(a.category,'') AS cat
       FROM num_asks a
       LEFT JOIN num_consensus_rounds r ON r.ask_id = a.id
      WHERE a.dest IS NOT NULL AND a.dest <> ''
        AND a.synthetic = 0
        AND a.text IS NOT NULL AND length(a.text) > 8
        AND r.ask_id IS NULL
      ORDER BY a.id DESC
      LIMIT ${Math.max(1, limit | 0)}`,
  ).all();
  return results ?? [];
}

/** The places that ask would have been shown, ranked as the guest saw them. */
export async function candidatesFor(env, { dest, cat }) {
  const like = cat ? ' AND category LIKE ?2' : '';
  const st = env.DB.prepare(
    `SELECT id, name, category, cuisine, area FROM places
      WHERE dest = ?1 AND (alive IS NULL OR alive = 1)${like}
      ORDER BY hours_mask IS NULL, length(COALESCE(hours_mask,'')) DESC
      LIMIT ${BALLOT_SIZE}`,
  );
  const { results } = await (cat ? st.bind(dest, `%${cat}%`) : st.bind(dest)).all();
  return results ?? [];
}

/** Record one finished round. Appearances for everyone, votes for the chosen. */
export async function record(env, { askId, dest, cat, ids, counts, voterCount }) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  for (let i = 0; i < ids.length; i++) {
    const n = counts.get(i + 1) ?? 0;
    await env.DB.prepare(
      `INSERT INTO num_place_consensus (place_id, dest, cat, rounds, votes, agreements, first_seen, last_seen)
       VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?6)
       ON CONFLICT(place_id, cat) DO UPDATE SET
         rounds = rounds + 1,
         votes = votes + ?4,
         agreements = agreements + ?5,
         last_seen = ?6`,
    ).bind(ids[i], dest, cat ?? '', n, n >= MIN_AGREEMENT ? 1 : 0, now).run();
  }
  await env.DB.prepare(
    `INSERT OR REPLACE INTO num_consensus_rounds (ask_id, dest, cat, voters, candidates, ts)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(askId, dest, cat ?? '', voterCount, ids.length, now).run();
}

/**
 * One tick. Replays a few recent questions and banks what the brains agreed on.
 *
 * Every step is allowed to produce nothing. A tick that finds no questions, or
 * whose every voter is down, writes a round with zero voters and moves on —
 * silence is a result, and a background job that throws takes the cron's other
 * passengers with it.
 */
export async function runConsensus(env, { limit = ASKS_PER_TICK } = {}) {
  if (!env?.DB) return { rounds: 0, voters: 0, agreed: 0 };
  await ensure(env);
  const panel = voters(env);
  if (!panel.length) return { rounds: 0, voters: 0, agreed: 0, why: 'no voters configured' };

  const asks = await pending(env, limit);
  let agreed = 0;
  for (const ask of asks) {
    const rows = await candidatesFor(env, { dest: ask.dest, cat: ask.cat }).catch(() => []);
    // Fewer than four candidates is not a choice, it is a list. Recording
    // "agreement" there would mostly measure how short the list was.
    if (rows.length < 4) {
      await record(env, { askId: ask.id, dest: ask.dest, cat: ask.cat, ids: [], counts: new Map(), voterCount: 0 });
      continue;
    }
    const ballot = ballotFor({ question: ask.text, dest: ask.dest, rows });
    const cast = {};
    for (const brain of panel) {
      cast[brain.id] = await voteWith(env, brain, ballot);
    }
    const voted = Object.values(cast).filter((v) => v.length).length;
    const counts = tally(cast);
    await record(env, {
      askId: ask.id, dest: ask.dest, cat: ask.cat,
      ids: ballot.ids, counts, voterCount: voted,
    });
    agreed += [...counts.values()].filter((n) => n >= MIN_AGREEMENT).length;
  }
  return { rounds: asks.length, voters: panel.length, agreed };
}

/** What the panel has converged on in a destination. Read side. */
export async function consensusFor(env, { dest, cat = '', limit = 10 }) {
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT place_id, dest, cat, rounds, votes, agreements FROM num_place_consensus
      WHERE dest = ?1 AND cat = ?2 AND rounds >= ${MIN_ROUNDS}
      ORDER BY (CAST(agreements AS REAL) / rounds) DESC, votes DESC
      LIMIT ${Math.max(1, limit | 0)}`,
  ).bind(dest, cat ?? '').all();
  return (results ?? []).map((r) => ({ ...r, strength: strength(r) }));
}
