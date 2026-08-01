// Is this person free on Thursday?
//
// The question one Num has to be able to answer about its owner before two
// agents can settle a night between them. Everything else in the negotiation —
// the options, the tally, the event that comes out the other end — is
// bookkeeping. This is the part that has to be both useful and safe.
//
// Three rules hold it up:
//
//   · A VERDICT, NEVER THE DIARY. The answer is "that evening is taken", not
//     "she is at Mama Dolores at eight". An agent that hands over its owner's
//     schedule to anyone entitled to ask a yes/no question has leaked
//     something nobody agreed to share, and no amount of it being convenient
//     makes that a different kind of leak. Titles, places and who-else-is-going
//     never cross this boundary — see `reason` below, which is a shape, not a
//     description.
//
//   · ONLY WHAT NUM ACTUALLY BROKERED. A member's personal bookings live on
//     their own device (`s.bookings` in localStorage); the Worker has never
//     seen them. So "clear" means *nothing Num knows of conflicts*, not "they
//     are definitely free", and every caller has to say it that way to the
//     human. Overclaiming here is how you get someone double-booked by their
//     own assistant, which is worse than not having asked.
//
//   · THE SAME DOOR AS INVITES. Asking whether someone is free is at least as
//     personal as asking them to dinner, so it goes through canInvite() rather
//     than inventing a second, looser policy. Friends-only by default, off
//     means off, and a member who has closed their door is not silently more
//     readable than they thought.
//
// Answered entirely server-side, which is the property the whole feature rests
// on: your friend's Num can answer this with their phone face down on a table.
import { canInvite } from './permissions.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const readBody = async (req) => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/** How long an evening plan occupies if nobody said. Matches the app's own default. */
const DEFAULT_MINUTES = 120;
const MAX_WINDOWS = 12;

const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = (v) => typeof v === 'string' && /^\d{2}:\d{2}/.test(v);
const minutes = (t) => (isTime(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);

/**
 * Do two spans on the same day collide?
 *
 * Returns null — not false — when either side has no time, because "we both
 * have something on Thursday" is genuinely a different answer from "we clash".
 * Collapsing the two would either invent conflicts that do not exist or hide
 * ones that do, and the caller needs to be able to tell them apart.
 */
function overlaps(aTime, aMins, bTime, bMins) {
  const a = minutes(aTime);
  const b = minutes(bTime);
  if (a == null || b == null) return null;
  return a < b + (bMins ?? DEFAULT_MINUTES) && b < a + (aMins ?? DEFAULT_MINUTES);
}

/**
 * Everything this member has actually committed to, as bare times.
 *
 * Deliberately selects no titles. Not because the query would be slower with
 * them, but because a field that is never read cannot be accidentally returned
 * by a later change to this file.
 */
async function commitments(env, memberId, days) {
  if (!days.length) return [];
  const marks = days.map((_, i) => `?${i + 2}`).join(',');

  const [hosting, invited, planned] = await Promise.all([
    // Hosting your own event is a commitment. Easy to miss, and the most
    // embarrassing one to get wrong.
    env.DB.prepare(
      `SELECT day, time FROM num_events
        WHERE host_id=?1 AND state='open' AND day IN (${marks})`,
    ).bind(memberId, ...days).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT e.day, e.time FROM num_event_guests g
         JOIN num_events e ON e.id = g.event_id
        WHERE g.member_id=?1 AND g.rsvp='yes' AND e.state='open' AND e.day IN (${marks})`,
    ).bind(memberId, ...days).all().catch(() => ({ results: [] })),

    // Only things that are actually settled. An 'idea' or a 'proposed' item is
    // a group thinking out loud, and treating it as a commitment would make
    // everyone permanently busy on every night anyone ever floated.
    env.DB.prepare(
      `SELECT i.day, i.time FROM num_item_attendees a
         JOIN num_plan_items i ON i.id = a.item_id
        WHERE a.member_id=?1 AND a.rsvp='going'
          AND i.status IN ('held','confirmed') AND i.day IN (${marks})`,
    ).bind(memberId, ...days).all().catch(() => ({ results: [] })),
  ]);

  return [...(hosting.results ?? []), ...(invited.results ?? []), ...(planned.results ?? [])];
}

/**
 * Answer for one member across a handful of candidate windows.
 *
 * `reason` is phrased for a human to read out loud and says only how full the
 * evening is, never with what.
 */
export async function availabilityFor(env, memberId, windows) {
  const days = [...new Set(windows.map((w) => w.day))];
  const held = await commitments(env, memberId, days);

  return windows.map((w) => {
    const sameDay = held.filter((h) => h.day === w.day);
    if (!sameDay.length) {
      return { day: w.day, time: w.time ?? null, verdict: 'clear', reason: 'Nothing on their plan.' };
    }
    const hits = sameDay.map((h) => overlaps(w.time, w.minutes, h.time, null));
    if (hits.some((x) => x === true)) {
      return { day: w.day, time: w.time ?? null, verdict: 'busy', reason: 'Already committed then.' };
    }
    if (hits.some((x) => x === null)) {
      // Something is on that day but one side has no clock time, so we cannot
      // honestly say whether it clashes. Saying so is the useful answer.
      return { day: w.day, time: w.time ?? null, verdict: 'unclear', reason: 'Something that day, no time set.' };
    }
    return { day: w.day, time: w.time ?? null, verdict: 'clear', reason: 'Free around then.' };
  });
}

/**
 * POST /api/availability
 *   { me, of, windows: [{ day, time?, minutes? }] }
 *
 * `me` is who is asking, `of` is who they are asking about. Both are required
 * even when they are the same person, so the permission check is never
 * accidentally skipped by a caller that forgot to pass one.
 */
async function ask(env, req) {
  const b = await readBody(req);
  const me = clip(b.me, 40);
  const of = clip(b.of, 40) ?? me;
  if (!me) return json({ error: 'me is required' }, 400);

  const windows = (Array.isArray(b.windows) ? b.windows : [])
    .filter((w) => w && isDay(w.day))
    .slice(0, MAX_WINDOWS)
    .map((w) => ({
      day: w.day,
      time: isTime(w.time) ? w.time.slice(0, 5) : null,
      minutes: Number.isFinite(Number(w.minutes)) ? Math.max(15, Math.min(720, Number(w.minutes))) : DEFAULT_MINUTES,
    }));
  if (!windows.length) return json({ error: 'windows must hold at least one ISO date' }, 400);

  // The door. Checked before a single row is read, so a closed member is not
  // even queried — the refusal has to be indistinguishable from having no data.
  const gate = await canInvite(env, me, of);
  if (!gate.ok) {
    return json({ error: gate.message, reason: gate.reason, remedy: gate.remedy ?? null }, 403);
  }

  const answer = await availabilityFor(env, of, windows);
  return json({
    of,
    name: gate.to?.name ?? null,
    windows: answer,
    // Said out loud, every time, so no caller can quietly treat 'clear' as a
    // guarantee. Num only sees what Num arranged.
    basis: 'What Num arranged for them. Personal bookings made elsewhere are not visible, so “clear” means nothing known conflicts — not that they are definitely free.',
  });
}

export async function handleAvailability(request, env, path) {
  if (!env.DB) return json({ error: 'availability needs the database binding' }, 503);
  try {
    if ((path === '/' || path === '' || path === '/ask') && request.method === 'POST') return await ask(env, request);
    return json({ error: 'not found' }, 404);
  } catch (err) {
    console.error('[availability]', path, err?.message ?? err);
    return json({ error: 'couldn’t work that out' }, 500);
  }
}
