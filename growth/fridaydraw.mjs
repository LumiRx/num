/**
 * The Friday pack draw.
 *
 * ── THE PROPERTY THAT MATTERS: ANYONE CAN CHECK IT ───────────────────────
 *
 * A draw run by a person picking names is indistinguishable, from the outside,
 * from a draw that was rigged. Ten winners a week, chosen by the company giving
 * out the prizes, is exactly the shape people are right to be suspicious of.
 *
 * So the draw is a PURE FUNCTION of two things: the list of eligible members and
 * a random seed. Both are recorded at the time. Feed the same seed and the same
 * list back in and you get the same ten winners, forever. That is what turns
 * "trust us" into something a member could verify if they cared to — and the
 * Official Rules promise exactly this, in clause 7.
 *
 * The seed is generated ONCE per draw and stored. It is never derived from the
 * member list, because a seed computed from the thing it selects can be steered
 * by adding or removing one row.
 *
 * ── WHAT WE CANNOT CHECK AT DRAW TIME, AND WHY THAT IS FINE ──────────────
 *
 * The rules limit the draw to US and UK residents aged 18 or over. `num_members`
 * records NEITHER. There is a `dest`, but that is where somebody is travelling,
 * not where they live — a Californian asking about Bangkok has `dest = bangkok`.
 * There is no date of birth at all.
 *
 * Filtering on `dest` would be worse than not filtering: it would look like
 * eligibility enforcement, pass an audit at a glance, and be wrong about most
 * people. So eligibility is verified where it CAN be verified — at claim, from
 * the winner, before anything ships. A winner who cannot confirm 18+ and a US or
 * UK address forfeits and the prize is redrawn. That is the ordinary shape of a
 * sweepstakes and it is what clause 8 of the rules describes.
 *
 * The draw therefore selects from everyone who used Num that week, and the
 * eligibility gate sits after it, not before.
 */

/** Ten packs, one each. Dre, 12 Sep 2026: "10 packs 1 per person so 10 winners". */
export const WINNERS_PER_DRAW = 10;

/** Accounts that must never win. */
export const EXCLUDED_PREFIXES = Object.freeze(['zztest_']);

/**
 * A deterministic pseudo-random source.
 *
 * mulberry32: small, fast, and — the only property that matters here —
 * identical everywhere, forever. `Math.random()` cannot be used for a draw
 * anyone may want to re-check, because nothing about it can be reproduced.
 */
export function rng(seedStr) {
  // FNV-1a over the seed string, so any seed shape produces a 32-bit state.
  let h = 2166136261;
  for (const ch of String(seedStr)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Choose the winners.
 *
 * A Fisher-Yates shuffle over a SORTED copy of the ids. Sorting first is not
 * cosmetic: without it the result depends on the order the database happened to
 * return rows in, and the draw stops being reproducible the moment an index
 * changes. Same seed plus same set of ids must always give the same winners,
 * including on a different machine a year later.
 */
export function pickWinners(memberIds, count = WINNERS_PER_DRAW, seed = '') {
  const ids = [...new Set((memberIds ?? []).filter(Boolean).map(String))]
    .filter((id) => !EXCLUDED_PREFIXES.some((p) => id.startsWith(p)))
    .sort();
  const n = Math.min(Math.max(0, Math.floor(count)), ids.length);
  if (!n) return [];
  const rand = rng(seed);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, n);
}

/** A fresh seed. Random, recorded, and never derived from the entrant list. */
export const newSeed = () => `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID()}`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_giveaway_draws (
  id TEXT PRIMARY KEY,
  drawn_at TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  seed TEXT NOT NULL,
  -- The window as TIMESTAMPS as well as text. A redraw has to re-query the
  -- same pool weeks later, and it cannot do that from a date string.
  period_start_ts INTEGER NOT NULL DEFAULT 0,
  period_end_ts INTEGER NOT NULL DEFAULT 0,
  eligible_count INTEGER NOT NULL,
  winners TEXT NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS num_giveaway_claims (
  draw_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'won',
  claimed_at TEXT,
  forfeited_at TEXT,
  reason TEXT,
  PRIMARY KEY (draw_id, member_id)
);
`;

/**
 * Everyone who used Num in the window.
 *
 * `synthetic = 0` matters: 88 of the 633 asks on record are our own probes, and
 * a test account winning a prize is the fastest way to make the draw look rigged.
 */
export async function eligibleMembers(env, { startTs, endTs }) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT a.member_id AS id
       FROM num_asks a
       JOIN num_members m ON m.id = a.member_id
      WHERE a.member_id IS NOT NULL
        AND COALESCE(a.synthetic, 0) = 0
        AND a.ts >= ?1 AND a.ts <= ?2
      ORDER BY a.member_id`,
  ).bind(startTs, endTs).all().catch(() => ({ results: [] }));
  return (results ?? []).map((r) => r.id);
}

/**
 * Run one draw and record it.
 *
 * Idempotent on the draw id, which is the period — running it twice on the same
 * Friday must not produce a second set of winners. `INSERT OR IGNORE` plus a
 * read-back, rather than a check-then-write, because two clicks a second apart
 * would both pass a check.
 */
export async function runDraw(env, { periodStart, periodEnd, startTs, endTs, seed = null } = {}) {
  if (!env?.DB) return { ok: false, why: 'no database' };
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)
    .map((s) => env.DB.prepare(s)));

  const id = `draw_${periodEnd}`;
  const existing = await env.DB.prepare('SELECT * FROM num_giveaway_draws WHERE id = ?1')
    .bind(id).first().catch(() => null);
  if (existing) {
    return {
      ok: true, already: true, id,
      seed: existing.seed,
      eligible_count: existing.eligible_count,
      winners: JSON.parse(existing.winners),
    };
  }

  const eligible = await eligibleMembers(env, { startTs, endTs });
  const useSeed = seed || newSeed();
  const winners = pickWinners(eligible, WINNERS_PER_DRAW, useSeed);
  if (!winners.length) return { ok: false, why: 'nobody used Num in that period', eligible_count: 0 };

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO num_giveaway_draws
       (id, drawn_at, period_start, period_end, seed, period_start_ts, period_end_ts,
        eligible_count, winners, note)
     VALUES (?1,?2,?3,?4,?5,?9,?10,?6,?7,?8)`,
  ).bind(
    id, now, periodStart, periodEnd, useSeed, eligible.length, JSON.stringify(winners),
    // Written into the row so a future reader knows the gate is downstream and
    // does not conclude the draw ignored its own rules.
    'eligibility (18+, US/UK) is verified at claim, not at draw — see growth/fridaydraw.mjs',
    startTs, endTs,
  ).run();

  for (const m of winners) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO num_giveaway_claims (draw_id, member_id, state) VALUES (?1,?2,'won')",
    ).bind(id, m).run().catch(() => {});
  }

  // Read back rather than returning what we meant to write: if another request
  // won the race, these are the winners that actually stand.
  const row = await env.DB.prepare('SELECT * FROM num_giveaway_draws WHERE id = ?1')
    .bind(id).first().catch(() => null);
  return {
    ok: true, id,
    seed: row?.seed ?? useSeed,
    eligible_count: row?.eligible_count ?? eligible.length,
    winners: row ? JSON.parse(row.winners) : winners,
  };
}

/**
 * A winner who cannot confirm 18+ and a US or UK address forfeits.
 *
 * The redraw excludes everyone already drawn for that period, so a forfeit can
 * never hand the same person a second prize and can never re-offer a prize to
 * someone who already forfeited it.
 */
export async function forfeitAndRedraw(env, { drawId, memberId, reason = 'not eligible' } = {}) {
  if (!env?.DB || !drawId || !memberId) return { ok: false, why: 'draw and member are required' };
  const draw = await env.DB.prepare('SELECT * FROM num_giveaway_draws WHERE id = ?1')
    .bind(drawId).first().catch(() => null);
  if (!draw) return { ok: false, why: 'unknown draw' };

  await env.DB.prepare(
    `UPDATE num_giveaway_claims SET state='forfeited', forfeited_at=?3, reason=?4
      WHERE draw_id=?1 AND member_id=?2 AND state='won'`,
  ).bind(drawId, memberId, new Date().toISOString(), String(reason).slice(0, 200)).run();

  const { results } = await env.DB.prepare(
    'SELECT member_id FROM num_giveaway_claims WHERE draw_id = ?1',
  ).bind(drawId).all().catch(() => ({ results: [] }));
  const alreadyDrawn = new Set((results ?? []).map((r) => r.member_id));

  // The same window the original draw used, so the replacement comes from the
  // same pool of people rather than from whoever happens to be active today.
  const pool = (await eligibleMembers(env, {
    startTs: Number(draw.period_start_ts) || 0,
    endTs: Number(draw.period_end_ts) || 9e18,
  })).filter((id) => !alreadyDrawn.has(id));

  // A different seed, derived from the original plus who forfeited, so the
  // redraw is still reproducible but is not the same shuffle continuing.
  const replacement = pickWinners(pool, 1, `${draw.seed}:redraw:${memberId}`)[0] ?? null;
  if (!replacement) return { ok: true, replaced: null, why: 'no one left to redraw' };

  await env.DB.prepare(
    "INSERT OR IGNORE INTO num_giveaway_claims (draw_id, member_id, state) VALUES (?1,?2,'won')",
  ).bind(drawId, replacement).run();
  return { ok: true, replaced: replacement };
}
