/**
 * Sign-up milestones, and the mystery bonus behind each one.
 *
 * ── WHAT DRE DECIDED, 19 SEP 2026 ────────────────────────────────────────
 *
 * The bonus is a MYSTERY and **nothing is guaranteed**. NUM decides what each
 * rung is worth when somebody reaches it — a trip, a ride, clothes, something
 * from a brand, Stars — and gets in touch. That is a real choice with a real
 * upside: a surprise is worth more than a number everybody has already
 * calculated, and it leaves room to give somebody something that actually
 * suits them.
 *
 * ── SO EVERY WORD ON THESE RUNGS IS WRITTEN TO A RULE ────────────────────
 *
 * Nothing here may promise a specific prize, and nothing here may say
 * "guaranteed", "you will receive", or name a thing NUM has not got. A
 * discretionary reward described in the language of a guarantee is just a
 * guarantee you have not funded, and the first person who reaches a rung and
 * gets nothing will say so to every other ambassador.
 *
 * What the copy DOES say, at every rung, is the one thing that is certainly
 * true: the 20% share is the programme, and these are on top of it. Somebody
 * who never receives a mystery bonus has still not been lied to.
 *
 * ── AND THE REAL RISK IS NOT THE PROMISE, IT IS THE SILENCE ──────────────
 *
 * Reaching a rung writes a ROW (see 0053) that sits in `reached` until a
 * human moves it. The danger with a discretionary reward is not that NUM
 * chooses something cheap — it is that nobody notices at all, and three weeks
 * of silence teaches an ambassador the milestones are decoration. The row is
 * the thing that makes the discretion honest: "who are we behind on" is one
 * query, and `openMilestones()` below is that query.
 */

/**
 * The ladder.
 *
 * `1` is deliberately the first rung. The moment that matters most in this
 * whole programme is the first time a real person joins through somebody's
 * link — that is when they find out it works at all, and it is the cheapest
 * possible moment to make somebody feel something.
 *
 * The gaps widen because the work does: 1 to 5 is a group chat, 100 to 250 is
 * months of posting.
 */
export const TIERS = [
  { tier: 1, name: 'Your first', blurb: 'Somebody joined NUM because of you. That is the hard one.' },
  { tier: 5, name: 'Five', blurb: 'Five people, and a link that is clearly working.' },
  { tier: 10, name: 'Ten', blurb: 'Ten. This is where the share starts being worth checking.' },
  { tier: 25, name: 'Twenty-five', blurb: 'Twenty-five people who travel. That is an audience, not an accident.' },
  { tier: 50, name: 'Fifty', blurb: 'Fifty.' },
  { tier: 100, name: 'One hundred', blurb: 'A hundred people brought to NUM by one person.' },
  { tier: 250, name: 'Two hundred and fifty', blurb: 'Very few people will ever see this rung.' },
];

/** THE SENTENCE. One place, so it cannot drift into a promise on one screen
 *  and stay honest on another. Every surface that shows a milestone shows
 *  this with it, and a test asserts the words it must not contain. */
export const MYSTERY_LINE =
  'Each one unlocks a mystery bonus. We decide what it is when you get there and we come to you — '
  + 'it might be a trip, a ride, something to wear, something from a brand we work with, or Stars. '
  + 'It is a surprise, nothing is committed in advance, and some rungs may pass without one. '
  + 'Your 20% share is the programme and it is unaffected; these are on top of it.';

/** Which rungs a count has passed. */
export function tiersReached(count) {
  const n = Number(count) || 0;
  return TIERS.filter((t) => n >= t.tier).map((t) => t.tier);
}

/** The next rung and how far off it is, for a progress bar that means something. */
export function nextTier(count) {
  const n = Number(count) || 0;
  const next = TIERS.find((t) => n < t.tier);
  if (!next) return null;
  const prev = [...TIERS].reverse().find((t) => n >= t.tier);
  const floor = prev ? prev.tier : 0;
  return {
    ...next,
    to_go: next.tier - n,
    // Progress within THIS rung, not from zero. At 26 of 50 a bar drawn from
    // zero reads as half done when the person is one person into a long climb;
    // drawn from 25 it reads as 4%, which is the truth and is still motivating
    // because the next rung is the one they are actually walking to.
    pct: Math.max(0, Math.min(100, Math.round(((n - floor) / (next.tier - floor)) * 100))),
  };
}

const nowIso = () => new Date().toISOString();
const rid = () => 'ms_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/**
 * Record every rung this ambassador has newly passed.
 *
 * Returns the tiers that were written THIS call — so the caller knows what to
 * tell them about, and a recount on a quiet Tuesday tells them about nothing.
 * The unique index is what guarantees that; INSERT OR IGNORE leans on it
 * rather than on a SELECT that could race with itself.
 *
 * Never throws. A milestone that cannot be recorded must not be able to break
 * a signup, which is the event that usually triggers it.
 */
export async function recordMilestones(env, { ambassadorId, count } = {}) {
  if (!env?.DB || !ambassadorId) return [];
  const fresh = [];
  try {
    for (const t of TIERS) {
      if ((Number(count) || 0) < t.tier) break;
      const res = await env.DB.prepare(
        `INSERT OR IGNORE INTO num_ambassador_milestones
           (id, ambassador_id, tier, referred_count, state, reached_at, created_at)
         VALUES (?1,?2,?3,?4,'reached',?5,?5)`,
      ).bind(rid(), ambassadorId, t.tier, Number(count) || 0, nowIso()).run();
      if (Number(res?.meta?.changes ?? 0) > 0) fresh.push(t);
    }
  } catch (e) {
    console.warn('[milestones]', e?.message ?? e);
  }
  return fresh;
}

/** What one ambassador has reached, for their own screen. */
export async function milestonesFor(env, ambassadorId) {
  if (!env?.DB || !ambassadorId) return [];
  try {
    const { results = [] } = await env.DB.prepare(
      `SELECT tier, state, reward_kind, reward_note, reached_at, sent_at
         FROM num_ambassador_milestones WHERE ambassador_id = ?1 ORDER BY tier ASC`,
    ).bind(ambassadorId).all();
    return results;
  } catch { return []; }
}

/**
 * Everything NUM still owes somebody. The whole point of the table.
 *
 * `declined` and `sent` are done. Anything else is a person waiting, and the
 * `days_waiting` column is there so that "we are three weeks behind on four
 * people" is a fact somebody can see rather than a thing that is discovered
 * when one of them posts about it.
 */
export async function openMilestones(env, limit = 200) {
  if (!env?.DB) return [];
  try {
    const { results = [] } = await env.DB.prepare(
      `SELECT m.id, m.tier, m.state, m.referred_count, m.reached_at, m.reward_kind, m.reward_note,
              a.id AS ambassador_id, a.name, a.email, a.city, a.country, a.code,
              CAST(julianday('now') - julianday(m.reached_at) AS INTEGER) AS days_waiting
         FROM num_ambassador_milestones m
         JOIN num_ambassadors a ON a.id = m.ambassador_id
        WHERE m.state IN ('reached','chosen')
        ORDER BY m.reached_at ASC LIMIT ?1`,
    ).bind(limit).all();
    return results;
  } catch { return []; }
}
