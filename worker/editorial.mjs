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
 * A CLOSURE DOES NOT FADE.
 *
 * Everything else here decays, and it should: a 2021 star says little about
 * the kitchen in 2026. But a hotel that shut in 2020 is still shut, and under
 * a uniform curve its -100 aged out to nothing — meaning the two permanently
 * closed properties in this seed (The Roosevelt, The Standard Hollywood)
 * scored exactly zero and were free to be recommended again.
 *
 * Recommending somewhere that no longer exists is the worst thing a concierge
 * can do. It is the one judgement that is not a judgement at all but a fact
 * about the world, and facts do not expire on a schedule.
 */
export const isPermanent = (r) => Number(r?.weight) === WEIGHTS.closed;

/** A row's weight as it counts today: decayed, unless it is permanent. */
export function liveWeight(r, now = new Date()) {
  const w = Number(r?.weight) || 0;
  if (!w) return 0;
  return isPermanent(r) ? w : w * decay(r?.awarded_on, now);
}

/**
 * The net editorial points for one venue, from all of its rows.
 *
 * ONE RULE, DELIBERATELY SIMPLE: the strongest live positive, plus every live
 * loss. Positives do not stack.
 *
 * Stacking was the first version and it was wrong twice over. It let a venue
 * with five write-ups of the same award bury a better one with a single
 * quieter mention — and, worse, it could not be expressed in the SQL that
 * actually does the ranking, so the number here and the number a guest felt
 * would have drifted apart with nobody watching.
 *
 * Agreement between critics is not lost by this. It is already priced into
 * the weights: consensus_3plus is worth 24 and consensus_2 is worth 15,
 * decided when the row was written by someone who read the sources.
 *
 * Losses stack in full, and are applied after. Being stripped twice is twice
 * the warning. This expression is mirrored exactly in rank_top_places.sql.
 */
export function scoreFor(rows, now = new Date()) {
  let best = 0;
  let losses = 0;
  for (const r of rows ?? []) {
    if (!r || !r.source) continue; // unsourced rows may not score — see 0046
    const live = liveWeight(r, now);
    if (live < 0) losses += live;
    else if (live > best) best = live;
  }
  return Math.round((best + losses) * 100) / 100;
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
    const v = liveWeight(r, now);
    if (v > live) { live = v; top = r; }
  }
  if (!top || live < SAYABLE) return null;
  const year = String(top.awarded_on).slice(0, 4);
  return `${top.accolade}, ${year} (${top.source})`;
}

/** Rows that say a venue has been stripped of something or has closed. */
export function warnings(rows, now = new Date()) {
  return (rows ?? [])
    .filter((r) => r && liveWeight(r, now) < 0)
    .map((r) => `${r.accolade} — ${r.source}, ${String(r.awarded_on).slice(0, 4)}`);
}

/* ── THE SAME JUDGEMENT, WHERE THE ANSWER IS ACTUALLY BUILT ───────────── */

/**
 * How much a point of editorial weight is worth to the LIVE nearby ranker.
 *
 * Two rankers exist and they are on different scales. `rank_top_places.sql`
 * builds a pre-ranked shelf on a 0-150 scale where a rating is worth 40. The
 * nearby query in ai/places.js ranks the rows that actually answer a guest,
 * and it works in stars: a rating is 0-5, a heavily reviewed place gets 1.4,
 * a claimed listing 1.5.
 *
 * Until 19 Sep 2026 the editorial layer was wired only into the first one.
 * So the shelf knew Le Bernardin from Dunkin' and Mandarin Oriental from the
 * Hilton, and the query a guest's question actually ran had never heard of
 * any of it — which is exactly why a 2.5-star hotel came back for "somewhere
 * downtown". The layer was right and it was not plugged in.
 *
 * 12 puts it on the star scale honestly:
 *   three Michelin stars / Keys  45 -> +3.75   (beats every other term)
 *   No. 1-10 on a 50 Best list   42 -> +3.50
 *   one star                     28 -> +2.33
 *   two publications agreeing    15 -> +1.25   (about a claimed listing)
 *   one city critic               8 -> +0.67   (a nudge, not a claim)
 *   a stripped star             -30 -> -2.50
 *   permanently closed         -100 -> -8.33   (nothing recovers from this)
 *
 * The expression mirrors scoreFor() exactly — strongest live positive plus
 * every live loss, closures exempt from decay — because three copies of one
 * rule is one rule and two comments.
 */
export const POINTS_PER_STAR = 12;

/** The SQL, built from the constants above so the rule lives in one place. */
export const SCORE_TERM = `(
    COALESCE((SELECT MAX(e.weight * MIN(1.0,
               (1461.0 - (julianday('now') - julianday(e.awarded_on))) / 913.0))
        FROM num_editorial e
       WHERE e.place_id = places.id AND e.weight > 0
         AND e.source IS NOT NULL AND e.source <> ''
         AND julianday('now') - julianday(e.awarded_on) < 1461.0), 0)
  + COALESCE((SELECT SUM(CASE WHEN e.weight = ${WEIGHTS.closed} THEN e.weight
                              ELSE e.weight * MIN(1.0,
               (1461.0 - (julianday('now') - julianday(e.awarded_on))) / 913.0) END)
        FROM num_editorial e
       WHERE e.place_id = places.id AND e.weight < 0
         AND e.source IS NOT NULL AND e.source <> ''
         AND (e.weight = ${WEIGHTS.closed}
              OR julianday('now') - julianday(e.awarded_on) < 1461.0)), 0)
  ) / ${POINTS_PER_STAR}.0`;

/** The same arithmetic in JS, so a test can check the SQL agrees. */
export const stars = (rows, now = new Date()) => scoreFor(rows, now) / POINTS_PER_STAR;

/**
 * A CLOSURE IS A FILTER, NOT A PENALTY.
 *
 * The first version of the term above scored a closure at -100 and let the
 * ranking sort it out. It does not sort it out: a closed THREE-STAR nets
 * 45 - 100 = -55, which is -4.58 stars, and a complete claimed listing with
 * five thousand reviews is worth +8.35. The closed restaurant lands within
 * half a star of an ordinary open one, and half a star is not a margin to
 * bet a guest's evening on.
 *
 * `alive = 0` is already an exclusion in ai/places.js, and for exactly this
 * reason: it means NUM fetched the venue's own site and found it gone, which
 * is positive evidence, not a quality signal. A sourced closure row says the
 * same thing from a dated news report. So it gets the same treatment.
 *
 * Unsourced rows do not exclude, for the same reason they do not score: a
 * claim NUM cannot attribute is a claim it must not act on.
 */
export const CLOSED_PREDICATE = `NOT EXISTS (
  SELECT 1 FROM num_editorial e
   WHERE e.place_id = places.id
     AND e.weight = ${WEIGHTS.closed}
     AND e.source IS NOT NULL AND e.source <> '')`;

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
