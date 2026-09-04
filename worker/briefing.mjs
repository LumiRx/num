// Num speaks first.
//
// Everything on the thread screen waits to be asked. worker/nudge.mjs is the
// one exception and it needs a push subscription, of which there are two.
// This is the channel that always works: the moment the app opens. If the
// person has something coming up, Num says so before the composer is
// touched — the way the friend who lives there texts "still on for
// tomorrow?" rather than waiting to be asked.
//
// ── Rules, inherited from nudge.mjs ──────────────────────────────────────
//
//   1. Only about something the person actually HAS: a plan with a date. No
//      "haven't seen you in a while", no engagement bait, ever.
//   2. One line. The composer is still the product; this is the doorman.
//   3. Nothing here is ever shared-cached. The suggest endpoint is public
//      and cached for a minute because its answer is the same for everyone
//      in a city. The moment a member id is involved that stops being true.
//
// Days are judged in the member's destination timezone where we know it,
// and in Asia/Bangkok otherwise — Num's centre of gravity today.

const DEFAULT_TZ = 'Asia/Bangkok';

/** YYYY-MM-DD for `now` plus `days`, in a timezone. en-CA formats that way. */
export function dayIn(tz, days = 0, now = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || DEFAULT_TZ }).format(new Date(now + days * 86_400_000));
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TZ }).format(new Date(now + days * 86_400_000));
  }
}

/**
 * The line, from the plans a member is on. Pure, so it is testable without
 * a database: `plans` is `[{ title, dest, starts_on, starts_time, state }]`.
 */
export function briefingLine(plans, { tz = DEFAULT_TZ, now = Date.now() } = {}) {
  const today = dayIn(tz, 0, now);
  const tomorrow = dayIn(tz, 1, now);
  const live = (plans ?? []).filter((p) => p && p.starts_on && p.state !== 'done');
  const pick = (day) => live.find((p) => p.starts_on === day);
  const when = (p) => (p.starts_time ? ` at ${p.starts_time}` : '');
  const where = (p) => (p.dest ? ` in ${p.dest}` : '');

  const t = pick(today);
  if (t) return `${t.title}${where(t)} is today${when(t)}. Want me to sort a car, or check the booking?`;
  const tm = pick(tomorrow);
  if (tm) return `${tm.title}${where(tm)} is tomorrow${when(tm)}. Anything you want lined up before then?`;

  // This week, nearest first — only when it is within six days, because a
  // plan a month out is not news.
  const soon = live
    .filter((p) => p.starts_on > tomorrow && p.starts_on <= dayIn(tz, 6, now))
    .sort((a, b) => (a.starts_on < b.starts_on ? -1 : 1))[0];
  if (soon) return `${soon.title}${where(soon)} is coming up on ${soon.starts_on}. Say the word and I’ll start on the details.`;
  return null;
}

/** The member's dated plans, oldest start first. Never throws. */
export async function plansFor(env, memberId) {
  if (!memberId || !env?.DB) return [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT p.title, p.dest, p.starts_on, p.starts_time, p.state
         FROM num_plans p JOIN num_plan_members m ON m.plan_id = p.id
        WHERE m.member_id = ?1 AND p.starts_on IS NOT NULL AND p.state <> 'done'
        ORDER BY p.starts_on ASC LIMIT 12`,
    ).bind(String(memberId).slice(0, 64)).all();
    return results ?? [];
  } catch (e) {
    console.warn('[briefing] plansFor failed:', e?.message ?? e);
    return [];
  }
}

export async function briefingFor(env, { memberId, tz } = {}) {
  if (!memberId) return null;
  const plans = await plansFor(env, memberId);
  return briefingLine(plans, { tz });
}
