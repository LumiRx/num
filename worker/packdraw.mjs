/**
 * Entering the Friday pack draw by texting Num a code.
 *
 * ── WHY A CODE, WHEN "USED NUM THIS WEEK" ALREADY WORKED ─────────────────
 *
 * The first design entered every member who sent Num any message that week.
 * It needed nothing from anybody, which sounds like an advantage and is not.
 *
 * It entered people who did not know they had entered. That is a poor
 * experience — a prize arriving unasked-for is confusing — and it is a weak
 * legal position, because a sweepstakes rests on an entrant choosing to enter.
 * It also gave us nothing to point at afterwards: "they asked Num about dinner"
 * is not an entry anybody can see, and a draw nobody can see the entries for is
 * a draw nobody can check.
 *
 * A code fixes all three. Sending PACKS is unambiguous, deliberate, timestamped,
 * and countable. Dre asked for exactly this on 12 Sep 2026 — "give them a code
 * to text num so we know theyre entering in" — and it is the better mechanism,
 * not just the requested one.
 *
 * The cost is honest: fewer people will send a code than passively qualify. At
 * 21 active members that may mean a handful of entries against ten prizes, so
 * early weeks will have very short odds. That is fine, and better than handing
 * prizes to people who never asked for one.
 *
 * ── THE MESSAGE MUST *BE* THE CODE ───────────────────────────────────────
 *
 * Not contain it. "What are booster packs?" and "where can I buy packs in
 * Bangkok" are questions about the product we just added a card-shop search
 * for — entering them in a prize draw because the word appeared is exactly the
 * class of error the card-shop classifier exists to avoid, one layer up.
 */

import { eligibleCount, enter, phoneForMember } from './giveaway.mjs';

/**
 * What a member sends. Short, unambiguous, hard to type by accident.
 *
 * `growth/fridayrules.mjs` publishes this same word in clause 3, and the two
 * are asserted equal in packdraw.test.mjs — a rules page naming one code while
 * the service accepts another is a promotion whose published terms are false.
 */
export const ENTRY_CODE = 'PACKS';

/**
 * The entry period, named by the Thursday it closes on.
 *
 * The rules define a week as Friday 00:00 UTC to the following Thursday 23:59
 * UTC, so the closing Thursday names the period — and a member who enters on
 * Friday and one who enters the following Wednesday land in the same draw,
 * which is the whole point.
 *
 * This is a LABEL, shown to a member and printed on the rules page. It is not
 * the key. The key is `week_start`, the opening Friday as an epoch integer,
 * computed by `giveaway.weekStart()` — see the note on `recordEntry`.
 */
export function weekKeyFor(now = new Date()) {
  const d = new Date(now);
  const day = d.getUTCDay();              // Sun 0 … Thu 4, Fri 5, Sat 6
  const untilThursday = (4 - day + 7) % 7; // Thursday itself → 0
  d.setUTCDate(d.getUTCDate() + untilThursday);
  return d.toISOString().slice(0, 10);
}

/**
 * Is this message an entry?
 *
 * The whole message, allowing for surrounding punctuation and whitespace and
 * any case. Nothing else counts — see the header.
 */
export function isEntry(text) {
  const t = String(text ?? '')
    .trim()
    .replace(/^[\s"\'.,!¡¿?()\[\]-]+|[\s"\'.,!¡¿?()\[\]-]+$/g, '')
    .toUpperCase();
  return t === ENTRY_CODE;
}

/**
 * Record an in-app entry.
 *
 * ── THIS FILE NO LONGER OWNS A TABLE, AND THAT IS THE FIX ────────────────
 *
 * It used to carry its own `CREATE TABLE IF NOT EXISTS num_giveaway_entries`
 * keyed (week_key, member_id), and its own INSERT against those columns. The
 * table already existed, created by migration 0023 with a different shape, so
 * the CREATE was a silent no-op and **every in-app entry failed on
 * `no such column: week_key`** in production 0.8.290. Meanwhile the SMS door
 * wrote the real shape and worked, so entries accumulated in a table the app
 * could not write to and the draw could not read.
 *
 * Two modules owning one table is the whole bug. There is now exactly one
 * writer — `worker/giveaway.mjs` — and this file calls it.
 *
 * ── WHY THE PHONE LOOKUP COMES FIRST ─────────────────────────────────────
 *
 * A person who has texted PACKS and then sends it in the app must end up with
 * one ticket, not two. Resolving their number before building the key means
 * both doors produce `phone:+44…` and the unique index collapses the second.
 * A member with no number on file keys as `member:mem_…` — still one ticket,
 * and still able to enter, which matters because 73% of members have no phone.
 */
export async function recordEntry(env, { memberId, now = new Date(), source = 'app' } = {}) {
  if (!env?.DB) return { ok: false, why: 'no database' };
  if (!memberId) return { ok: false, why: 'sign in first', needsAccount: true };

  // If we cannot READ the member's number we must not fall back to keying on
  // the member id: they may already hold a phone-keyed entry from a text, and
  // two different keys are two tickets. Refuse, and let them try again.
  let phone = null;
  try {
    phone = await phoneForMember(env, memberId);
  } catch (e) {
    console.warn('[packdraw] phone lookup failed', e?.message ?? e);
    return { ok: false, why: 'could not record that entry' };
  }

  const res = await enter(env, {
    phone,
    memberId,
    source,
    now: Math.floor(new Date(now).getTime() / 1000),
  });

  if (!res.ok) return { ok: false, why: 'could not record that entry' };
  return { ok: true, already: res.created === false, weekKey: weekKeyFor(now) };
}

/**
 * How many are in this week's draw. Shown to the member, so it must be real.
 *
 * Reads through the same counter the draw uses, so the number a member is told
 * and the number the draw runs on cannot disagree.
 */
export async function entryCount(env, now = new Date()) {
  return eligibleCount(env, Math.floor(new Date(now).getTime() / 1000));
}

/**
 * What Num says back.
 *
 * Every reply carries the terms and the rules link, because the reply IS the
 * moment somebody enters and it is the only place we can be sure they see them.
 * A promotion whose conditions live only on a page nobody opened is a promotion
 * whose conditions were never communicated.
 */
export function entryReply({ already = false, count = 0, weekKey = '' } = {}) {
  const head = already
    ? "You're already in this week's draw — one entry each, however many times you send it."
    : "You're in. Ten packs go out this Friday, one each to ten people.";
  const many = count > 0
    ? ` ${count} ${count === 1 ? 'person has' : 'people have'} entered so far.`
    : '';
  return `${head}${many}\n\nWinners are drawn at random on Friday${weekKey ? ` ${weekKey}` : ''} and told right here. `
    + 'US and UK, 18 or over — we\'ll check before anything ships. '
    + 'Full rules: itsnum.com/friday-rules';
}

/** Somebody sent the code without an account. */
export const NEEDS_ACCOUNT_REPLY =
  'Almost — the draw is for Num members, and you\'re not signed in on this device. '
  + 'Sign in or make an account (it takes a minute and costs nothing), then send PACKS again. '
  + 'Full rules: itsnum.com/friday-rules';
