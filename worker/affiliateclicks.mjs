/**
 * What Num actually hands away, and to whom.
 *
 * ── THE FINDING THIS FIXES ───────────────────────────────────────────────
 *
 * `affiliate.mjs` can tag an outbound link. Nothing anywhere recorded that it
 * had. The nightly analytics run says so out loud (scripts/nightly-analytics.mjs,
 * metric `affiliate_clicks`): "grep for INSERT in that file returns nothing".
 * So even with every programme approved, the first question finance would ask
 * — how much traffic did we send, and where — had no answer, and the second —
 * which programme should we apply for next — had no evidence behind it.
 *
 * ── WHAT A ROW MEANS, EXACTLY ────────────────────────────────────────────
 *
 * A row is a LINK NUM PUT IN FRONT OF A GUEST. It is NOT a verified tap.
 * The tap happens in the guest's browser, on somebody else's domain, and we
 * never see it — pretending otherwise would make this table the same kind of
 * lie that `num_place_impressions` was built to avoid.
 *
 * `event` therefore has two values and they must never be summed as one:
 *
 *   handoff — Num offered this link in a reply or an API response. This is
 *             every row today.
 *   tap     — the guest is known to have followed it. Reserved. Nothing
 *             writes this yet; when the client reports taps it lands here and
 *             the ratio between the two becomes the honest click-through rate.
 *
 * Read `handoff` as the denominator, never as a click. The affiliate network's
 * own dashboard is the only source of truth for money; this table exists to
 * tell us what we sent, so that a payout can be sanity-checked against it and
 * so an untagged host with real volume becomes a visible, rankable to-do.
 *
 * ── COST ─────────────────────────────────────────────────────────────────
 *
 * One batched INSERT per answered turn, never awaited on the request path
 * (call it inside ctx.waitUntil). Deduplicated per call so six identical
 * provider links in one reply are one row each, not one per render. At ~32
 * asks/day this is a few hundred rows a week.
 */

import { attributionsFor } from './sourcing.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_affiliate_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  programme TEXT,
  tagged INTEGER NOT NULL DEFAULT 0,
  event TEXT NOT NULL DEFAULT 'handoff',
  surface TEXT,
  kind TEXT,
  member_id TEXT,
  dest TEXT,
  -- WHICH VENUE, not just which host. synxis.com is one booking engine a
  -- thousand hotels share, and without this column a link handed out for a hotel
  -- somebody sourced is indistinguishable from one that came off OSM.
  place_id TEXT,
  -- Who was credited with introducing that venue AT THE TIME OF THE HANDOFF.
  -- Copied, not joined, for the same reason every rate in num_scout_places is
  -- copied: this is a record of what happened, and it must keep saying what it
  -- said even after an introduction is transferred, ended or voided.
  scout_id TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_affclick_host_ts ON num_affiliate_clicks(host, ts);
CREATE INDEX IF NOT EXISTS idx_affclick_ts ON num_affiliate_clicks(ts);
`;

/**
 * The table already exists in production, so CREATE TABLE IF NOT EXISTS will
 * not add the two new columns to it — the statement succeeds and does nothing.
 * These run separately and are expected to fail with "duplicate column" on
 * every deploy after the first. That failure is the success case; anything
 * that treated it as an error would make the worker refuse to start.
 */
const MIGRATIONS = [
  'ALTER TABLE num_affiliate_clicks ADD COLUMN place_id TEXT',
  'ALTER TABLE num_affiliate_clicks ADD COLUMN scout_id TEXT',
  // ORDER MATTERS, and it is the reason these two indexes are down here
  // instead of up in SCHEMA with the others. A partial index names the column
  // in its WHERE clause, so on the table that is already in production it
  // would be created before the ALTER that adds the column — and because
  // SCHEMA runs as one batch, that single failure would roll back the whole
  // batch and leave the click log writing nothing at all.
  //
  // The whole point of the two columns: "what did we hand out for this
  // scout's venues, and when" has to be one index seek, not a table scan, or
  // the first statement anybody asks for is the one nobody runs.
  'CREATE INDEX IF NOT EXISTS idx_affclick_scout ON num_affiliate_clicks(scout_id, ts) WHERE scout_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_affclick_place ON num_affiliate_clicks(place_id, ts) WHERE place_id IS NOT NULL',
];

let ready = false;
async function ensure(env) {
  if (ready) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  // Sequential and individually swallowed: one batch would roll the whole
  // thing back the first time a column already existed, which is always.
  //
  // try/catch rather than `.catch()` on purpose. A D1 stand-in that does not
  // implement `run` throws a TypeError SYNCHRONOUSLY, which no `.catch()` on
  // the returned promise can see — and that TypeError would escape ensure(),
  // be swallowed by the caller, and silently turn the click log off.
  for (const m of MIGRATIONS) {
    try { await env.DB.prepare(m).run(); } catch { /* already applied */ }
  }
  ready = true;
}

/** Test seam: the module-level cache must not leak between test cases. */
export const _resetForTests = () => { ready = false; };

/** Only the two values the schema comment promises. Anything else is a bug. */
const EVENTS = new Set(['handoff', 'tap']);

/**
 * Record outbound links Num handed over.
 *
 * @param env    Worker env; needs `env.DB`. No DB, no row, no error.
 * @param links  `[{ host, programme, tagged, kind, placeId }]` — the shape
 *               `affiliate.tagged()` already returns, plus the service kind and
 *               (where the link is for one specific venue) that venue's id.
 *               `placeId` is what makes a handoff attributable to the person
 *               who introduced the place; omit it for city-level provider
 *               links, which belong to nobody in particular.
 * @param meta   `{ memberId, dest, surface, event }`.
 *
 * Never throws. A bookkeeping failure must not cost somebody their answer,
 * and it must not cost them their LINK either — this runs after the URL has
 * already been decided and cannot change it.
 */
export async function recordHandoffs(env, links = [], meta = {}) {
  if (!env?.DB || !Array.isArray(links) || !links.length) return { logged: 0 };

  const event = EVENTS.has(meta.event) ? meta.event : 'handoff';
  const surface = meta.surface ? String(meta.surface).slice(0, 40) : null;
  const memberId = meta.memberId ?? null;
  const dest = meta.dest ? String(meta.dest).slice(0, 60) : null;

  // Same host offered twice in one reply is one handoff, not two. Without
  // this, a reply that lists Grab under both "ride" and "food" doubles that
  // host's apparent volume and misranks the next programme to apply for.
  const seen = new Set();
  const rows = [];
  for (const l of links) {
    const host = String(l?.host ?? '').toLowerCase().slice(0, 120);
    if (!host) continue; // a malformed URL has no host to attribute
    const kind = l?.kind ? String(l.kind).slice(0, 24) : null;
    const placeId = l?.placeId == null ? null : String(l.placeId).slice(0, 120);
    // THE PLACE IS PART OF THE DEDUPE KEY, and it has to be. Two different
    // hotels booked through the same engine share a host and a kind, so
    // without this a reply offering one of Adam's hotels and one of nobody's
    // — both synxis.com, both 'stay' — would collapse to a single row and
    // silently drop whichever attribution came second. The dedupe exists to
    // stop one link being counted twice, not to merge two venues into one.
    const dedupe = `${host}|${kind}|${placeId ?? ''}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    rows.push({
      host,
      programme: l?.programme ? String(l.programme).slice(0, 120) : null,
      tagged: l?.tagged ? 1 : 0,
      kind,
      placeId,
      // A caller that has already resolved the introduction passes it through
      // rather than making this file ask again for something it was just told.
      scoutId: l?.scoutId ? String(l.scoutId).slice(0, 64) : null,
    });
  }
  if (!rows.length) return { logged: 0 };

  // Who is credited with each venue, resolved ONCE for the whole reply rather
  // than once per link. Callers may pass a scoutId they already know (the
  // booking handler has usually just looked the place up); anything they did
  // not resolve is looked up here, because the alternative is a call site
  // that forgets and an attribution that is lost for good. A lookup failure
  // costs an attribution, never a row: an unattributed handoff is still the
  // evidence that the handoff happened.
  let credited = new Map();
  const needing = rows.filter((r) => r.placeId && !r.scoutId).map((r) => r.placeId);
  if (needing.length) {
    credited = await attributionsFor(env, needing).catch(() => new Map());
  }

  try {
    await ensure(env);
    const ts = Math.floor(Date.now() / 1000);
    const stmt = env.DB.prepare(
      `INSERT INTO num_affiliate_clicks
         (host, programme, tagged, event, surface, kind, member_id, dest, place_id, scout_id, ts)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
    );
    let attributed = 0;
    await env.DB.batch(
      rows.map((r) => {
        const scoutId = r.scoutId
          ?? (r.placeId ? (credited.get(r.placeId)?.scoutId ?? null) : null);
        if (scoutId) attributed += 1;
        return stmt.bind(
          r.host, r.programme, r.tagged, event, surface, r.kind, memberId, dest,
          r.placeId, scoutId, ts,
        );
      }),
    );
    return { logged: rows.length, attributed };
  } catch (e) {
    console.warn('[affiliate] click log write failed', e?.message ?? e);
    return { logged: 0, error: String(e?.message ?? e) };
  }
}

/**
 * Run `recordHandoffs` off the request path.
 *
 * `ctx` is not available everywhere `tagged()` is (the partner MCP calls the
 * booking handler in-process with no execution context). Where there is a ctx
 * this is fire-and-forget; where there is not, the promise is awaited, because
 * an un-awaited promise after the response has been returned is cancelled by
 * the runtime and the row silently never lands.
 */
export function logHandoffs(env, ctx, links, meta) {
  const p = recordHandoffs(env, links, meta).catch(() => ({ logged: 0 }));
  if (ctx?.waitUntil) { ctx.waitUntil(p); return null; }
  return p;
}
