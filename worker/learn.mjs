/**
 * What NUM learns from a visit, and where it changes what NUM does next.
 *
 * Until today nothing NUM recorded ever changed NUM's behaviour. num_asks and
 * num_place_impressions were write-only: the ranker in ai/places.js has never
 * read either of them, so a place NUM had recommended four hundred times and
 * a place it had never mentioned scored identically. That is not a learning
 * system; it is a log.
 *
 * This is the first closed loop, and it is deliberately the smallest honest
 * one:
 *
 *     a guest asks → NUM recommends → the guest goes → the guest rates it
 *       → the rating changes what the next guest is shown.
 *
 * ── why ratings and not clicks
 *
 * The tempting signal is engagement: what got tapped, what got booked. It is
 * abundant, it is already logged, and it measures the wrong thing. A place
 * with a striking photo gets tapped; a place at the top of the list gets
 * tapped; and a ranker trained on taps learns to promote whatever it already
 * promoted. A rating is given AFTER the meal by somebody who went, which is
 * the only signal here that knows how the evening actually went.
 *
 * ── why it is capped, and why the cap is not symmetric
 *
 * Being disliked by our own guests costs a place more than being liked earns
 * it. A concierge's job is not to find the very best table; it is to never
 * send somebody somewhere bad. So the penalty reaches -1.5 and the bonus
 * stops at +1.0.
 *
 * ── why it is materialised
 *
 * The ranker scores rows inside a single SQL query over `places`, and `places`
 * holds 2,529,721 of them. A correlated subquery into num_ratings per row
 * would be paid on every recommendation for every guest for the sake of a
 * number that changes a few times a day. A column, refreshed on a cron, costs
 * one read.
 *
 * ── what cannot happen here
 *
 * Nothing in this file may take money as an input. Placement is not for sale
 * — gate.test.mjs fails the build if the merchant page even implies it is —
 * and the ONLY way a place moves up in this file is that people who went
 * there said it was good. learn.test.mjs asserts the score has no term that
 * money can reach.
 */

/** Below this many ratings an average is noise wearing a statistic's costume. */
export const MIN_RATINGS = 5;

/** The neutral point. A place rated exactly this moves neither way. */
export const NEUTRAL = 4.0;

/** How much one star of difference is worth in the ranking score. */
export const WEIGHT = 0.75;

/**
 * The most our own guests may lift a place, and the most they may sink one.
 *
 * Exactly two to one, and the asymmetry is the point. A perfect 5.0 is one
 * star above neutral, so the lift caps out at 0.75 all by itself — MAX_LIFT
 * is the arithmetic ceiling written down, not a separate limit. The sink cap
 * BINDS: it is reached at an average of 2.0, and everything below that is
 * treated the same, because the difference between a place our guests rate
 * 1.4 and one they rate 1.9 is not a difference worth ranking.
 */
export const MAX_LIFT = 0.75;   // = (5 - NEUTRAL) * WEIGHT
export const MAX_SINK = -1.5;   // = (2 - NEUTRAL) * WEIGHT

const COLUMNS = [
  'ALTER TABLE places ADD COLUMN num_rating REAL',
  'ALTER TABLE places ADD COLUMN num_rating_n INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE places ADD COLUMN num_rated_at TEXT',
];

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  for (const sql of COLUMNS) await env.DB.prepare(sql).run().catch(() => {});
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_places_numrating ON places(num_rating_n)',
  ).run().catch(() => {});
  ready = true;
}
export const _resetSchemaCache = () => { ready = false; };

/**
 * The SQL term the ranker adds to a place's score.
 *
 * Exported as a string rather than inlined in ai/places.js so that the rule
 * and the test that guards the rule read the same characters. A copy in two
 * files is a rule in one file and a comment in the other.
 */
export const SCORE_TERM = `CASE WHEN COALESCE(num_rating_n,0) >= ${MIN_RATINGS}
    THEN MAX(${MAX_SINK}, MIN(${MAX_LIFT}, (COALESCE(num_rating, ${NEUTRAL}) - ${NEUTRAL}) * ${WEIGHT}))
    ELSE 0 END`;

/** The same arithmetic in JavaScript, so a test can check the SQL agrees. */
export function lift(avg, n) {
  if (!Number.isFinite(avg) || !Number.isFinite(n) || n < MIN_RATINGS) return 0;
  return Math.max(MAX_SINK, Math.min(MAX_LIFT, (avg - NEUTRAL) * WEIGHT));
}

/**
 * Fold every rating NUM's own guests have left into the places table.
 *
 * Idempotent and total rather than incremental: it recomputes the average
 * from num_ratings each time. An incremental counter drifts the moment a
 * rating is edited or a row is deleted for a takedown request, and drift in
 * this number is invisible — nobody can tell a wrong average from a right one
 * by looking at it.
 *
 * Only places that HAVE ratings are touched. Writing 0 across two and a half
 * million rows to express "nobody has rated this" is a table rewrite in
 * exchange for information COALESCE already supplies.
 */
export async function rollupRatings(env, { limit = 5000 } = {}) {
  if (!env?.DB) return { ok: false, error: 'no_db' };
  await ensure(env);
  try {
    const { results } = await env.DB.prepare(
      `SELECT place_id, ROUND(AVG(stars), 2) AS avg, COUNT(stars) AS n
         FROM num_ratings
        WHERE place_id IS NOT NULL AND stars IS NOT NULL
        GROUP BY place_id
        ORDER BY MAX(created_at) DESC
        LIMIT ?1`,
    ).bind(Math.max(1, limit)).all();

    const rows = results || [];
    if (!rows.length) return { ok: true, places: 0, ratings: 0 };

    // One batch, so a half-applied rollup cannot leave some places scored on
    // this week's ratings and others on last month's.
    await env.DB.batch(rows.map((r) => env.DB.prepare(
      `UPDATE places SET num_rating = ?2, num_rating_n = ?3, num_rated_at = datetime('now')
        WHERE id = ?1`,
    ).bind(r.place_id, r.avg, r.n)));

    return {
      ok: true,
      places: rows.length,
      ratings: rows.reduce((a, r) => a + r.n, 0),
      counted: rows.filter((r) => r.n >= MIN_RATINGS).length,
    };
  } catch (e) {
    console.warn('[learn.rollupRatings]', e?.message ?? e);
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * What the loop is currently doing, in numbers a human can check.
 *
 * A learning system nobody can inspect is a learning system nobody can catch
 * being wrong. This is what the console shows.
 */
export async function learningState(env) {
  if (!env?.DB) return null;
  await ensure(env);
  try {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS rated_places,
              SUM(CASE WHEN num_rating_n >= ${MIN_RATINGS} THEN 1 ELSE 0 END) AS counting,
              MAX(num_rated_at) AS last_rollup
         FROM places WHERE COALESCE(num_rating_n,0) > 0`,
    ).first();
    const t = await env.DB.prepare(
      'SELECT COUNT(*) AS ratings, COUNT(DISTINCT place_id) AS places FROM num_ratings',
    ).first();
    return {
      ratings_collected: t?.ratings ?? 0,
      places_with_a_rating: r?.rated_places ?? 0,
      places_changing_the_ranking: r?.counting ?? 0,
      min_ratings_to_count: MIN_RATINGS,
      last_rollup: r?.last_rollup ?? null,
    };
  } catch (e) {
    console.warn('[learn.learningState]', e?.message ?? e);
    return null;
  }
}
