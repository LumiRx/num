/**
 * The Friday pack draw.
 *
 * MOVED FROM growth/ ON 13 SEP. The entries are written by num-app
 * (worker/giveaway.mjs, from both the SMS webhook and the app's reply path) and
 * the person who runs the draw is signed into the ops console, which is also
 * num-app. The draw living in the other worker meant the one button that could
 * run it would have had to reach across a deploy boundary — and a handler in a
 * worker whose route pattern does not carry the path is exactly how
 * /friday-rules, /api/pay/* and /p/* each shipped broken. num-growth keeps the
 * public rules page and nothing else.
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

/*
 * ── THE SCHEMA LIVES IN A MIGRATION, NOT HERE — 13 SEP ───────────────────
 *
 * This file used to carry its own `CREATE TABLE IF NOT EXISTS
 * num_giveaway_draws (id, drawn_at, period_start, period_end, …)` and run it on
 * every draw. Migration 0023 had already created a table of that name with a
 * different shape, so the statement was a **silent no-op** and the INSERT that
 * followed would have failed on `no such column: drawn_at`. The draw could not
 * have run even if it had had a route — which it did not.
 *
 * Worse, `eligibleMembers` ended in `.catch(() => ({ results: [] }))`. A failed
 * read came back as "nobody entered", and `runDraw` then returned the perfectly
 * calm `why: 'nobody used Num in that period'`. **A broken query would have
 * looked like a quiet week.** For a promotion, that is the worst available
 * failure: it is indistinguishable from an honest empty draw, so nobody
 * investigates, and the entrants who did enter are simply never drawn.
 *
 * Both are fixed. 0026 owns the tables; a failed read throws.
 */

/**
 * Everyone in this week's draw, by `entrant_key`.
 *
 * Keyed on the entrant rather than the member because entries arrive through
 * two doors and 73% of members have no phone — see worker/giveaway.mjs. The key
 * is `phone:+44…` for anyone we hold a number for and `member:mem_…` otherwise,
 * so one human is one row however they entered.
 *
 * NO SILENT CATCH. If this query fails the draw must stop, not report an empty
 * week. `growth/readfail.mjs` exists for exactly this class of bug.
 */
export async function eligibleEntrants(env, { weekStart } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT entrant_key
       FROM num_giveaway_entrants
      WHERE week_start = ?1
      ORDER BY entrant_key`,
  ).bind(weekStart).all();
  return (results ?? []).map((r) => r.entrant_key).filter(Boolean);
}

/** Who to tell, and how, once the keys are drawn. */
export async function winnerContacts(env, { weekStart, keys }) {
  if (!keys?.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT entrant_key, MAX(phone) AS phone, MAX(member_id) AS member_id
       FROM num_giveaway_entrants
      WHERE week_start = ?1
      GROUP BY entrant_key`,
  ).bind(weekStart).all();
  const by = new Map((results ?? []).map((r) => [r.entrant_key, r]));
  return keys.map((k) => ({
    entrant_key: k,
    phone: by.get(k)?.phone ?? null,
    member_id: by.get(k)?.member_id ?? null,
  }));
}

/**
 * Run one draw and record it.
 *
 * Idempotent on the draw id, which is the period — running it twice on the same
 * Friday must not produce a second set of winners. `INSERT OR IGNORE` plus a
 * read-back, rather than a check-then-write, because two clicks a second apart
 * would both pass a check.
 */
export async function runDraw(env, { weekStart: ws, seed = null } = {}) {
  if (!env?.DB) return { ok: false, why: 'no database' };
  if (!Number.isFinite(Number(ws))) return { ok: false, why: 'a period is required' };
  const week = Math.floor(Number(ws));
  const id = `draw_${week}`;

  const existing = await env.DB.prepare('SELECT * FROM num_giveaway_results WHERE id = ?1')
    .bind(id).first();
  if (existing) {
    return {
      ok: true, already: true, id,
      seed: existing.seed,
      eligible_count: existing.eligible_count,
      winners: JSON.parse(existing.winners),
    };
  }

  const eligible = await eligibleEntrants(env, { weekStart: week });
  const useSeed = seed || newSeed();
  const winners = pickWinners(eligible, WINNERS_PER_DRAW, useSeed);
  if (!winners.length) return { ok: false, why: 'nobody entered that period', eligible_count: 0 };

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO num_giveaway_results
       (id, week_start, drawn_at, seed, eligible_count, winners, note)
     VALUES (?1,?2,?3,?4,?5,?6,?7)`,
  ).bind(
    id, week, now, useSeed, eligible.length, JSON.stringify(winners),
    // Written into the row so a future reader knows the gate is downstream and
    // does not conclude the draw ignored its own rules.
    'eligibility (18+, US/UK) is verified at claim, not at draw — see growth/fridaydraw.mjs',
  ).run();

  const contacts = await winnerContacts(env, { weekStart: week, keys: winners });
  for (const c of contacts) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO num_giveaway_claims (draw_id, entrant_key, phone, member_id, state)
       VALUES (?1,?2,?3,?4,'won')`,
    ).bind(id, c.entrant_key, c.phone, c.member_id).run();
  }

  // Read back rather than returning what we meant to write: if another request
  // won the race, these are the winners that actually stand.
  const row = await env.DB.prepare('SELECT * FROM num_giveaway_results WHERE id = ?1')
    .bind(id).first();
  return {
    ok: true, id, week_start: week,
    seed: row?.seed ?? useSeed,
    eligible_count: row?.eligible_count ?? eligible.length,
    winners: row ? JSON.parse(row.winners) : winners,
    contacts,
  };
}

/**
 * A winner who cannot confirm 18+ and a US or UK address forfeits.
 *
 * The redraw excludes everyone already drawn for that period, so a forfeit can
 * never hand the same person a second prize and can never re-offer a prize to
 * someone who already forfeited it.
 */
export async function forfeitAndRedraw(env, { drawId, entrantKey, reason = 'not eligible' } = {}) {
  if (!env?.DB || !drawId || !entrantKey) return { ok: false, why: 'draw and entrant are required' };
  const draw = await env.DB.prepare('SELECT * FROM num_giveaway_results WHERE id = ?1')
    .bind(drawId).first();
  if (!draw) return { ok: false, why: 'unknown draw' };

  await env.DB.prepare(
    `UPDATE num_giveaway_claims SET state='forfeited', forfeited_at=?3, reason=?4
      WHERE draw_id=?1 AND entrant_key=?2 AND state='won'`,
  ).bind(drawId, entrantKey, new Date().toISOString(), String(reason).slice(0, 200)).run();

  const { results } = await env.DB.prepare(
    'SELECT entrant_key FROM num_giveaway_claims WHERE draw_id = ?1',
  ).bind(drawId).all();
  const alreadyDrawn = new Set((results ?? []).map((r) => r.entrant_key));

  // The same window the original draw used, so the replacement comes from the
  // same pool of people rather than from whoever happens to be active today.
  const pool = (await eligibleEntrants(env, { weekStart: draw.week_start }))
    .filter((k) => !alreadyDrawn.has(k));

  // A different seed, derived from the original plus who forfeited, so the
  // redraw is still reproducible but is not the same shuffle continuing.
  const replacement = pickWinners(pool, 1, `${draw.seed}:redraw:${entrantKey}`)[0] ?? null;
  if (!replacement) return { ok: true, replaced: null, why: 'no one left to redraw' };

  const [c] = await winnerContacts(env, { weekStart: draw.week_start, keys: [replacement] });
  await env.DB.prepare(
    `INSERT OR IGNORE INTO num_giveaway_claims (draw_id, entrant_key, phone, member_id, state)
     VALUES (?1,?2,?3,?4,'won')`,
  ).bind(drawId, replacement, c?.phone ?? null, c?.member_id ?? null).run();
  return { ok: true, replaced: replacement };
}
