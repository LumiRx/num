/**
 * What NUM handed out on somebody's behalf — the statement you can send them.
 *
 * ── WHY THIS IS AN ENDPOINT AND NOT A QUERY SOMEBODY REMEMBERS ───────────
 *
 * "Keep track of any of those usages" is only half done when the data exists.
 * A number that requires someone to remember a JOIN is a number nobody looks
 * at, and the first time it matters is the moment a scout asks whether their
 * hotels are being used — which is exactly the moment you do not want to be
 * writing SQL.
 *
 * ── THE ONE THING THIS MUST NEVER DO ─────────────────────────────────────
 *
 * It must never call a handoff a booking.
 *
 * A handoff is A LINK NUM PUT IN FRONT OF A GUEST. Whether anybody followed
 * it happens on somebody else's domain and NUM never sees it. Whether anybody
 * BOOKED is known only to the hotel and, weeks later and net of
 * cancellations, to the affiliate network.
 *
 * So every field below is named for what it actually counts, `owed_minor` is
 * read from num_scout_earnings rather than computed from traffic, and the
 * response carries the disclaimer as DATA — because a caller that renders
 * this into an email to a scout must not have to remember to add it.
 *
 * Getting this wrong is not a reporting bug. Telling someone "you generated
 * 40 bookings" when you mean "we showed your hotels 40 times" is a number
 * they will do arithmetic on, and the conversation when the money does not
 * follow is one nobody recovers from.
 */

import { adminGuard } from './adminkey.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

/** Said once, in the payload, so no caller has to remember it. */
export const MEANING = {
  handoff: 'A link NUM put in front of a guest. NOT a click and NOT a booking — '
    + 'the tap happens on the booking platform\'s domain and NUM never sees it.',
  earned: 'Money NUM has actually collected, from num_scout_earnings. A handoff '
    + 'count is not revenue and the two must never be added together.',
  owed: 'What is accrued to this scout. A finder\'s fee is released only once '
    + 'that venue has produced its gate in real revenue to NUM.',
};

/**
 * GET /api/admin/scout-usage?code=ADAM&days=30
 *
 * Omit `code` for every scout. `days` is clamped to 1..365.
 *
 * Never throws on a missing table: a scout programme that has not been
 * migrated yet should report zeroes, not a 500 on an admin page.
 */
export async function handleScoutUsage(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  // OPEN TO THE INTERNET UNTIL 3 SEP 2026. This endpoint answered 200 to
  // anybody who guessed the path, and it carries scout names, referral codes,
  // commission terms and money owed — somebody else's deal, and ours.
  const denied = adminGuard(request, env, CORS);
  if (denied) return denied;
  if (!env?.DB) return json({ error: 'Directory unavailable.' }, 503);

  const url = new URL(request.url);
  const code = String(url.searchParams.get('code') || '').trim().toUpperCase().slice(0, 40) || null;
  // Nonsense input falls back to the DEFAULT rather than clamping to the
  // minimum. `days=-5` clamped to 1 reports almost no activity, which on a
  // page about whether somebody's hotels are being used reads as "nothing is
  // happening" rather than as "you typed something odd". `window_days` is
  // echoed in the response either way, so the caller can always see what was
  // actually asked.
  const asked = Number(url.searchParams.get('days'));
  const days = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 365) : 30;
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const safe = async (stmt, fallback) => {
    try { return await stmt; } catch (e) {
      console.warn('[scoutusage]', e?.message ?? e);
      return fallback;
    }
  };

  // ── the scouts, and what they were promised ───────────────────────────
  const scouts = await safe(
    env.DB.prepare(
      `SELECT id, name, code, status, finder_cents, finder_gate_minor,
              share_bps, sub_share_bps, term_months
         FROM num_scouts ${code ? 'WHERE code = ?1' : ''}
        ORDER BY name`,
    ).bind(...(code ? [code] : [])).all().then((r) => r.results ?? []),
    [],
  );
  if (!scouts.length) return json({ ok: true, window_days: days, scouts: [], meaning: MEANING });

  const ids = scouts.map((s) => s.id);
  const marks = ids.map((_, i) => `?${i + 1}`).join(',');

  // ── what was handed out ───────────────────────────────────────────────
  //
  // Grouped by PLACE, not by host. `synxis.com` is one engine a thousand
  // hotels share, so a per-host total cannot tell a scout which of their
  // venues is working — which is the only thing they actually want to know.
  const handoffs = await safe(
    env.DB.prepare(
      `SELECT a.scout_id, a.place_id,
              COALESCE(p.name, '(delisted)') AS name,
              a.dest AS dest,
              COUNT(*)                 AS handoffs,
              SUM(a.tagged)            AS earning_handoffs,
              COUNT(DISTINCT a.host)   AS hosts,
              MAX(a.ts)                AS last_ts
         FROM num_affiliate_clicks a
         LEFT JOIN places p ON p.id = a.place_id
        WHERE a.scout_id IN (${marks}) AND a.event = 'handoff' AND a.ts >= ?${ids.length + 1}
        GROUP BY a.scout_id, a.place_id
        ORDER BY handoffs DESC`,
    ).bind(...ids, since).all().then((r) => r.results ?? []),
    [],
  );

  // ── what they introduced ──────────────────────────────────────────────
  const places = await safe(
    env.DB.prepare(
      `SELECT scout_id, state, COUNT(*) AS n
         FROM num_scout_places WHERE scout_id IN (${marks}) GROUP BY scout_id, state`,
    ).bind(...ids).all().then((r) => r.results ?? []),
    [],
  );

  // ── what they are actually owed ───────────────────────────────────────
  //
  // Read, never derived. The whole reason num_scout_earnings exists is that
  // money owed is a ledger entry with a state, not a multiplication anyone
  // can redo differently.
  const earnings = await safe(
    env.DB.prepare(
      `SELECT scout_id, state, currency, SUM(amount_minor) AS minor, COUNT(*) AS n
         FROM num_scout_earnings WHERE scout_id IN (${marks})
        GROUP BY scout_id, state, currency`,
    ).bind(...ids).all().then((r) => r.results ?? []),
    [],
  );

  const by = (rows, id) => rows.filter((r) => r.scout_id === id);

  return json({
    ok: true,
    window_days: days,
    generated_at: new Date().toISOString(),
    meaning: MEANING,
    scouts: scouts.map((s) => {
      const hs = by(handoffs, s.id);
      const st = Object.fromEntries(by(places, s.id).map((r) => [r.state, r.n]));
      return {
        name: s.name,
        code: s.code,
        status: s.status,
        // The rates THIS scout was promised, not the programme's current
        // ones. Locked at sign-up; people are owed what they were told.
        terms: {
          finder: s.finder_cents,
          finder_gate: s.finder_gate_minor,
          share_bps: s.share_bps,
          sub_share_bps: s.sub_share_bps,
          term_months: s.term_months,
        },
        introduced: st,
        // Deliberately not called "clicks" or "bookings". See MEANING.
        handoffs: hs.reduce((n, r) => n + r.handoffs, 0),
        // How many of those went out through a programme that can pay us. A
        // handoff on an unconfigured host earns nobody anything — not NUM and
        // therefore not the scout — and hiding that behind one total is how a
        // scout is told their hotels are working when no money can arrive.
        earning_handoffs: hs.reduce((n, r) => n + (r.earning_handoffs ?? 0), 0),
        venues_used: hs.length,
        by_venue: hs.slice(0, 50).map((r) => ({
          place_id: r.place_id,
          name: r.name,
          dest: r.dest,
          handoffs: r.handoffs,
          earning_handoffs: r.earning_handoffs ?? 0,
          last_handoff: r.last_ts ? new Date(r.last_ts * 1000).toISOString() : null,
        })),
        earned: by(earnings, s.id).map((r) => ({
          state: r.state, currency: r.currency, minor: r.minor, entries: r.n,
        })),
      };
    }),
  });
}
