/**
 * NUM · an Expert's own list.
 *
 * The round the office hands out is one half. This is the other: the shop on
 * the corner that is not in the places directory, the owner who said come back
 * Friday, the place that turned out to be shut. Before this, all of that lived
 * in somebody's phone and the office could only see the list it gave them.
 *
 * ── WHAT A LEAD IS NOT ────────────────────────────────────────────────────
 *
 * Read the head of migrations/0036_scout_leads.sql before changing anything
 * here. The short version, because it is the rule that matters:
 *
 *   A LEAD EARNS NOTHING, SPENDS NO CAP, AND RESERVES NOTHING.
 *
 * It is a note to self that the office can also see. The moment it becomes
 * money is `introduce()` in scouts.mjs, against a real place, first-come
 * decided by UNIQUE(place_id) — exactly as it was before this file existed.
 *
 * `promote()` below is the one bridge, and it is deliberately thin: it calls
 * the same introduce() everyone else calls and records the result. It has no
 * special powers and cannot skip the cap, the ownership check, or first-come.
 */

const uid = (p) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

export const STATES = Object.freeze(['to_visit', 'visited', 'interested', 'signed_up', 'not_now', 'dead']);

/** What each one means, in the words the page is allowed to use. */
export const STATE_MEANING = Object.freeze({
  to_visit: 'On your list. Not been yet.',
  visited: 'You went. Nothing decided.',
  interested: 'They want it — go back and finish it.',
  signed_up: 'They said they would sign up. Not money until they produce revenue.',
  not_now: 'A no for now. Worth another try later.',
  dead: 'Shut, wrong place, or a firm no.',
});

/**
 * How many open leads one Expert may hold.
 *
 * Not a fraud control — a lead is worth nothing, so there is nothing to farm.
 * It is a ceiling on a text field that anyone with a card code can write to,
 * and a hint that a list of two thousand is not a list anybody works.
 */
export const MAX_LEADS = 500;

/**
 * Name plus house number, lowercased.
 *
 * Enough that "Joe's Tacos, 114 Main St" typed twice on two days collapses,
 * and loose enough that two genuinely different branches on the same street
 * stay separate. Not clever on purpose: a fuzzy key that silently merges two
 * real shops loses one of them, and nobody would ever find out.
 */
export function dedupeKey({ name, address } = {}) {
  // Everything that is not a letter or a digit comes out entirely, rather
  // than becoming a space: somebody thumbing "joes tacos" into a phone on a
  // street should land on the row they made yesterday as "Joe's Tacos".
  const n = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const num = /(\d+)/.exec(String(address || '').split(',')[0] || '');
  return `${n}|${num ? num[1] : ''}`;
}

export async function addLead(env, { scoutId, now = new Date(), ...lead } = {}) {
  if (!env?.DB || !scoutId) return { ok: false, why: 'no database' };

  const name = clip(String(lead.name || '').replace(/\s+/g, ' ').trim(), 120);
  if (!name) return { ok: false, why: 'what is the place called?' };

  const count = await env.DB.prepare(
    "SELECT COUNT(*) n FROM num_scout_leads WHERE scout_id=?1 AND state NOT IN ('dead','signed_up')",
  ).bind(scoutId).first().catch(() => null);
  if (Number(count?.n ?? 0) >= MAX_LEADS) {
    return { ok: false, why: `you already have ${MAX_LEADS} open leads — close some first` };
  }

  const state = STATES.includes(lead.state) ? lead.state : 'to_visit';
  const key = dedupeKey({ name, address: lead.address });
  const id = uid('sl');

  try {
    await env.DB.prepare(
      `INSERT INTO num_scout_leads
         (id, scout_id, name, category, phone, website, address, area, dest, country,
          lat, lng, source, place_id, state, note, dedupe_key, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`,
    ).bind(
      id, scoutId, name, clip(lead.category, 60), clip(lead.phone, 32), clip(lead.website, 200),
      clip(lead.address, 200), clip(lead.area, 60), clip(lead.dest, 60), clip(lead.country, 2),
      lead.lat == null || lead.lat === '' ? null : Number(lead.lat),
      lead.lng == null || lead.lng === '' ? null : Number(lead.lng),
      lead.source === 'round' ? 'round' : 'expert',
      clip(lead.placeId ?? lead.place_id, 60),
      state, clip(lead.note, 500), key, now.toISOString(),
    ).run();
    return { ok: true, id, state, note: STATE_MEANING[state] };
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) {
      // Adding the same shop twice is a person being thorough, not an error.
      const had = await env.DB.prepare(
        'SELECT id, state FROM num_scout_leads WHERE scout_id=?1 AND dedupe_key=?2',
      ).bind(scoutId, key).first().catch(() => null);
      return { ok: true, already: true, id: had?.id ?? null, state: had?.state ?? null,
        why: 'that one is already on your list' };
    }
    return { ok: false, why: 'could not save that' };
  }
}

/** Change what an Expert thinks of one of their own leads. */
export async function updateLead(env, { scoutId, id, state, note, now = new Date() } = {}) {
  if (!env?.DB || !scoutId || !id) return { ok: false, why: 'which lead?' };
  if (state != null && !STATES.includes(state)) return { ok: false, why: 'not a state' };

  // scout_id in the WHERE, always: a lead id is guessable enough that the
  // owner has to be part of the lookup rather than checked after it.
  const res = await env.DB.prepare(
    `UPDATE num_scout_leads
        SET state = COALESCE(?3, state),
            note  = COALESCE(?4, note),
            updated_at = ?5
      WHERE id = ?1 AND scout_id = ?2`,
  ).bind(id, scoutId, state ?? null, note == null ? null : clip(note, 500), now.toISOString()).run();

  if (!res?.meta?.changes) return { ok: false, why: 'not one of yours' };
  return { ok: true, state, note: state ? STATE_MEANING[state] : null };
}

/**
 * An Expert's list, and what it adds up to.
 *
 * Counted separately from `businesses` on the dashboard, and never summed with
 * it. Twelve leads and one introduction is one introduction — showing "13"
 * anywhere would be the same lie as counting signatures as revenue.
 */
export async function leadsFor(env, scoutId) {
  const { results = [] } = await env.DB.prepare(
    `SELECT id, name, category, phone, address, area, state, note, place_id,
            scout_place_id, source, created_at, updated_at
       FROM num_scout_leads WHERE scout_id=?1
      ORDER BY CASE state WHEN 'interested' THEN 0 WHEN 'to_visit' THEN 1
                          WHEN 'visited' THEN 2 WHEN 'signed_up' THEN 3
                          WHEN 'not_now' THEN 4 ELSE 5 END,
               COALESCE(updated_at, created_at) DESC
      LIMIT 600`,
  ).bind(scoutId).all().catch(() => ({ results: [] }));

  const byState = {};
  for (const s of STATES) byState[s] = 0;
  for (const r of results) byState[r.state] = (byState[r.state] ?? 0) + 1;

  return {
    total: results.length,
    byState,
    meaning: STATE_MEANING,
    list: results,
    note: 'Your own list. Adding a place here does not reserve it and does not earn anything — '
      + 'the money starts when a business you introduced produces revenue.',
  };
}

/**
 * Turn a lead into a real introduction, once there is a place to bind it to.
 *
 * Thin on purpose. It calls the same introduce() as every other path, so the
 * monthly cap, the already-on-Num check and first-come all apply exactly as
 * they would have. A lead being older than somebody else's introduction does
 * not beat it, and it must not: that would make typing a reservation.
 */
export async function promoteLead(env, { scoutId, id, placeId, now = new Date() } = {}) {
  if (!env?.DB || !scoutId || !id) return { ok: false, why: 'which lead?' };

  const lead = await env.DB.prepare(
    'SELECT * FROM num_scout_leads WHERE id=?1 AND scout_id=?2',
  ).bind(id, scoutId).first().catch(() => null);
  if (!lead) return { ok: false, why: 'not one of yours' };
  if (lead.scout_place_id) return { ok: true, already: true, id: lead.scout_place_id };

  const pid = clip(placeId ?? lead.place_id, 60);
  if (!pid) return { ok: false, why: 'no listing to attach this to yet' };

  const { introduce } = await import('./scouts.mjs');
  const r = await introduce(env, {
    scoutId,
    placeId: pid,
    bizName: lead.name,
    dest: lead.dest,
    country: lead.country,
    lat: lead.lat,
    lng: lead.lng,
    now,
  });
  if (!r.ok) return r;

  await env.DB.prepare(
    'UPDATE num_scout_leads SET place_id=?3, scout_place_id=?4, updated_at=?5 WHERE id=?1 AND scout_id=?2',
  ).bind(id, scoutId, pid, r.id ?? null, now.toISOString()).run().catch(() => {});

  return { ok: true, introduced: true, scout_place_id: r.id ?? null, note: r.note };
}
