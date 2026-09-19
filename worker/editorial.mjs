/**
 * NUM · the editorial authority layer.
 *
 * What a critic said about a place, when they said it, and what that is worth
 * to the ranking today. See migrations/0046_editorial.sql for why the schema
 * carries a date and a signed weight rather than a list of good restaurants.
 */

/**
 * What each kind of accolade is worth, in the same points as the rest of
 * top_places.score (rating tops out at 40, contact completeness at 20).
 *
 * Calibrated so that a starred restaurant outranks a well-documented one:
 * before this existed, "has a phone and a website" was worth 10 and a
 * three-Michelin-star kitchen was worth nothing, which is how a 2.5-star
 * hotel came to be recommended in NUM's own voice.
 *
 * REVOCATIONS ARE THE POINT. A venue that lost a star must fall BELOW where
 * it would have sat with no accolade at all — it has been actively judged and
 * found wanting, and the guidebooks a guest already read still say otherwise.
 */
export const WEIGHTS = Object.freeze({
  michelin_3: 45,
  michelin_2: 36,
  michelin_1: 28,
  green_star: 12,
  // World's/Asia's/North America's 50 Best and equivalents.
  list_top10: 42,
  list_top50: 32,
  list_top100: 20,
  // A city's own critics. Two independent desks agreeing is the bar.
  consensus_3plus: 24,
  consensus_2: 15,
  critic_single: 8,
  // Losses.
  star_revoked: -30,
  list_dropped: -12,
  closed: -100,
});

/** Accolades below this are not worth saying out loud. */
export const SAYABLE = 15;

/**
 * How long an accolade counts for.
 *
 * Full weight for 18 months, then straight-line to nothing at 48. Guides are
 * annual, so a year-old star is current and a four-year-old one is a fact
 * about a kitchen that has probably changed hands.
 *
 * This is the mechanism that stops Masa being three-star for ever without
 * anyone remembering to clean up. Decay applies to LOSSES too — a revocation
 * from 2019 should not still be punishing a venue that has since recovered.
 */
export const FULL_MONTHS = 18;
export const ZERO_MONTHS = 48;

export function decay(awardedOn, now = new Date()) {
  const then = new Date(`${String(awardedOn).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(then.getTime())) return 0; // undated accolade scores nothing
  const months = (now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  if (months < 0) return 1; // dated in the future: a guide announced ahead of time
  if (months <= FULL_MONTHS) return 1;
  if (months >= ZERO_MONTHS) return 0;
  return (ZERO_MONTHS - months) / (ZERO_MONTHS - FULL_MONTHS);
}

/**
 * The net editorial points for one venue, from all of its rows.
 *
 * Positives do NOT stack freely: a restaurant with three stars and a 50 Best
 * place is not worth 45 + 42, it is worth the strongest claim plus a little
 * for the corroboration. Stacking is how a venue with five write-ups of the
 * same award buries a better one with a single quieter mention.
 *
 * Losses stack in full, and are applied after. Being stripped of a star twice
 * is twice the warning.
 */
export function scoreFor(rows, now = new Date()) {
  let best = 0;
  let corroboration = 0;
  let losses = 0;
  for (const r of rows ?? []) {
    if (!r || !r.source) continue; // unsourced rows may not score — see 0046
    const w = Number(r.weight) || 0;
    const live = w * decay(r.awarded_on, now);
    if (live < 0) { losses += live; continue; }
    if (live > best) { corroboration += Math.min(best, 6); best = live; }
    else corroboration += Math.min(live, 6);
  }
  return Math.round((best + Math.min(corroboration, 12) + losses) * 100) / 100;
}

/**
 * The line the concierge says.
 *
 * "Two Michelin stars, 2026" is an answer. "4.4 from 2,100 reviews" is a
 * search engine. Returns null when there is nothing worth claiming, so the
 * caller says nothing rather than reaching for filler.
 */
export function sayIt(rows, now = new Date()) {
  let top = null;
  let live = 0;
  for (const r of rows ?? []) {
    if (!r || !r.source || Number(r.weight) <= 0) continue;
    const v = Number(r.weight) * decay(r.awarded_on, now);
    if (v > live) { live = v; top = r; }
  }
  if (!top || live < SAYABLE) return null;
  const year = String(top.awarded_on).slice(0, 4);
  return `${top.accolade}, ${year} (${top.source})`;
}

/** Rows that say a venue has been stripped of something or has closed. */
export function warnings(rows, now = new Date()) {
  return (rows ?? [])
    .filter((r) => r && Number(r.weight) < 0 && decay(r.awarded_on, now) > 0)
    .map((r) => `${r.accolade} — ${r.source}, ${String(r.awarded_on).slice(0, 4)}`);
}

/* ── THE FRESHNESS QUEUE ─────────────────────────────────────────────── */

/**
 * A guest asked about somewhere. That is the demand signal.
 *
 * Deliberately cheap and deliberately not awaited by the answer path: a
 * counter must never be the reason a concierge reply is slow, and a failed
 * write here is worth exactly nothing compared to the answer.
 */
export async function noteDemand(env, dest) {
  const d = String(dest ?? '').trim().toLowerCase();
  if (!d || !env?.DB) return false;
  try {
    await env.DB.prepare(
      `INSERT INTO num_editorial_demand (dest, asks, last_ask) VALUES (?1, 1, datetime('now'))
         ON CONFLICT(dest) DO UPDATE SET asks = asks + 1, last_ask = datetime('now')`,
    ).bind(d).run();
    return true;
  } catch { return false; }
}

/** Research is stale after this long, however quiet the destination. */
export const STALE_DAYS = 90;

/**
 * Where the next research pass is worth spending.
 *
 * Ordered by demand against staleness: somewhere guests keep asking about and
 * nobody has looked at in months beats somewhere with fresher notes and no
 * visitors. Never-researched destinations sort first — no notes at all is the
 * worst state, and it is the state 74 of 77 destinations are in.
 */
export async function queue(env, limit = 10) {
  if (!env?.DB) return [];
  const rows = await env.DB.prepare(
    `SELECT dest, asks, last_ask, last_refreshed, claimed_at
       FROM num_editorial_demand
      WHERE claimed_at IS NULL
        AND (last_refreshed IS NULL OR last_refreshed < datetime('now', ?1))
      ORDER BY (last_refreshed IS NULL) DESC, asks DESC, last_refreshed ASC
      LIMIT ?2`,
  ).bind(`-${STALE_DAYS} days`, Math.max(1, Math.min(50, limit))).all().catch(() => null);
  return rows?.results ?? [];
}
