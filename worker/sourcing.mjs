/**
 * Who found this place — carried onto the link we hand away.
 *
 * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────
 *
 * `num_scout_places` has said, since migration 0006, which scout introduced
 * which venue. `num_affiliate_clicks` has recorded, since affiliateclicks.mjs,
 * every outbound link NUM put in front of a guest. The two tables have never
 * been able to see each other: the click log records a HOST (`synxis.com`) and
 * never the PLACE, so a booking handed out for a hotel somebody sourced looks
 * exactly like a booking handed out for a hotel that came off OpenStreetMap.
 *
 * That is not a wiring bug — the column did not exist. Which means that until
 * this file shipped, "did we use one of Adam's links" was a question with no
 * answer anywhere in the system, and usage that happens before a record exists
 * is usage nobody can ever reconstruct.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────
 *
 * It does not pay anybody. It does not decide a rate, it does not accrue an
 * earning, and it is not consulted before a venue is recommended. It answers
 * one question — "whose introduction was this place?" — at the moment a link
 * is handed over, so that the answer is written down while it is still true.
 *
 * Read that last sentence as the safety property. `attributionFor()` is called
 * AFTER ranking, on a place already chosen on merit, exactly like
 * `affiliate.tagged()`. There is no code path from a scout's share to a search
 * result and there must never be one: the moment a recommendation is for sale
 * the product is worth nothing, and a scout programme is not worth that.
 *
 * ── STATE MATTERS, AND SO DOES ITS ABSENCE ───────────────────────────────
 *
 * Only introductions in a live state attribute: introduced, verified,
 * activated. A `rejected` or `void` introduction resolves to NULL — a
 * reversed attribution has to stop appearing on new rows the moment it is
 * reversed, or the void is cosmetic.
 *
 * Rows already written keep the scout_id they were written with. That is
 * deliberate: the click log is a record of what we handed away and who was
 * credited at the time, not a live view of the current programme. Restating
 * history when terms change is how ledgers stop being evidence.
 */

/**
 * Live states. An introduction that has been rejected or voided attributes
 * nothing from that moment on.
 */
const LIVE = "('introduced','verified','activated')";

/**
 * Per-isolate cache. A concierge reply can hand over half a dozen links and a
 * busy destination sees the same venue many times an hour; without this, every
 * handoff is a DB round trip on a path that must never slow an answer down.
 *
 * TTL is short and misses are cached too, because the miss is the common case
 * — almost no place has a scout — and an uncached miss would mean this file
 * costs a query on nearly every link NUM ever hands out. Sixty seconds is long
 * enough to absorb a reply, short enough that a scout introduced this minute
 * starts being credited this minute rather than whenever the isolate recycles.
 */
const TTL_MS = 60 * 1000;
const MAX_ENTRIES = 500;
let cache = new Map();

/** Test seam: module-level state must not leak between cases. */
export const _resetForTests = () => { cache = new Map(); };

function remember(placeId, value) {
  // Cheapest possible bound: when it is full, drop the whole thing. An LRU
  // here would be more code than the thing it protects, and this cache is an
  // optimisation whose worst case is a query we were willing to make anyway.
  if (cache.size >= MAX_ENTRIES) cache = new Map();
  cache.set(placeId, { value, at: Date.now() });
  return value;
}

/**
 * Who is credited with introducing this place.
 *
 * @param env      Worker env; needs `env.DB`. Without one the answer is null.
 * @param placeId  `places.id`.
 * @returns `{ scoutId, scoutPlaceId, code, state }` or NULL.
 *
 * Never throws. This runs beside a link that has already been decided; a
 * bookkeeping failure must not cost a guest their booking page. A thrown
 * error here would take out `/api/book/link` for every venue in the
 * directory to protect a column that only a handful of rows use.
 */
export async function attributionFor(env, placeId) {
  const id = placeId == null ? '' : String(placeId).slice(0, 120);
  if (!id || !env?.DB) return null;

  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  try {
    const row = await env.DB.prepare(
      `SELECT sp.id AS scout_place_id, sp.scout_id, sp.state, s.code
         FROM num_scout_places sp
         JOIN num_scouts s ON s.id = sp.scout_id
        WHERE sp.place_id = ?1 AND sp.state IN ${LIVE}
        LIMIT 1`,
    ).bind(id).first();
    if (!row?.scout_id) return remember(id, null);
    return remember(id, {
      scoutId: String(row.scout_id),
      scoutPlaceId: row.scout_place_id == null ? null : String(row.scout_place_id),
      code: row.code == null ? null : String(row.code),
      state: String(row.state),
    });
  } catch (e) {
    // Missing table, missing column, D1 hiccup — all the same answer. NOT
    // cached: a schema that is mid-migration should start attributing the
    // moment it finishes, not sixty seconds later.
    console.warn('[sourcing] attribution lookup failed', e?.message ?? e);
    return null;
  }
}

/**
 * The same question for several places at once.
 *
 * One query for a whole reply instead of one per link. Returns a Map keyed by
 * place id; places with no scout are simply absent from it, so a caller can
 * ask `map.get(id) ?? null` and never has to distinguish "no scout" from "not
 * looked up".
 */
export async function attributionsFor(env, placeIds = []) {
  const out = new Map();
  if (!env?.DB || !Array.isArray(placeIds)) return out;

  const wanted = [];
  for (const raw of placeIds) {
    const id = raw == null ? '' : String(raw).slice(0, 120);
    if (!id || out.has(id) || wanted.includes(id)) continue;
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < TTL_MS) {
      if (hit.value) out.set(id, hit.value);
      continue;                       // cached miss: known to have no scout
    }
    wanted.push(id);
  }
  // Bounded on purpose. A reply that hands over more than fifty venues is a
  // bug somewhere upstream, and an unbounded IN list is an unbounded query.
  if (!wanted.length) return out;
  const ids = wanted.slice(0, 50);

  try {
    const marks = ids.map((_, i) => `?${i + 1}`).join(',');
    const { results = [] } = await env.DB.prepare(
      `SELECT sp.place_id, sp.id AS scout_place_id, sp.scout_id, sp.state, s.code
         FROM num_scout_places sp
         JOIN num_scouts s ON s.id = sp.scout_id
        WHERE sp.place_id IN (${marks}) AND sp.state IN ${LIVE}`,
    ).bind(...ids).all();

    const found = new Set();
    for (const row of results) {
      if (!row?.scout_id) continue;
      const pid = String(row.place_id);
      found.add(pid);
      out.set(pid, remember(pid, {
        scoutId: String(row.scout_id),
        scoutPlaceId: row.scout_place_id == null ? null : String(row.scout_place_id),
        code: row.code == null ? null : String(row.code),
        state: String(row.state),
      }));
    }
    // Cache the misses too, or a destination full of unsourced venues re-asks
    // this question on every single reply.
    for (const id of ids) if (!found.has(id)) remember(id, null);
  } catch (e) {
    console.warn('[sourcing] batch attribution lookup failed', e?.message ?? e);
  }
  return out;
}
