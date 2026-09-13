/**
 * The Friday pack draw — entry period, entry recording, and the keyword reply.
 *
 * Entry is deliberately NOT "text us to enter". It is "be a member who used Num
 * this week, OR text the keyword". Two routes into one table, because a draw with
 * a single mechanism is a draw that is broken whenever that mechanism is.
 *
 * That is not caution for its own sake. Num's US A2P registration has been
 * rejected once and outbound sends have been failing 30034 for most of the
 * product's life. Inbound texts arrive regardless — the block is on us REPLYING —
 * so somebody can text the keyword, be entered correctly, and receive nothing.
 * If texting were the only route, that silence would look exactly like a scam.
 * With both routes live, the entry is real whether or not the confirmation lands,
 * and the Official Rules can say so truthfully.
 */

/** Entry periods open Friday 00:00 UTC and run to the following Thursday 23:59:59. */
const WEEK = 7 * 24 * 60 * 60;

/**
 * The Friday 00:00 UTC that opens the period containing `now`.
 *
 * Computed from the epoch rather than from a Date's local fields, so it cannot
 * drift with the server's timezone — a draw that opens an hour early in one
 * region and an hour late in another is an entry somebody loses.
 *
 * 1970-01-01 was a Thursday, so epoch day 0 is Thursday and day 1 is the first
 * Friday. Shifting by one day puts Friday at the start of the week.
 */
export function weekStart(nowSeconds) {
  const n = Math.floor(Number(nowSeconds) || 0);
  const shifted = n - 86400;
  return (shifted - (((shifted % WEEK) + WEEK) % WEEK)) + 86400;
}

/** The keyword. Single word, no collision with STOP/HELP/START handling. */
export const ENTRY_KEYWORD = 'PACKS';

/**
 * The confirmation text.
 *
 * Carries the brand and STOP because every message we send has to, and links the
 * rules because a promotion whose rules are not one tap away is the failure that
 * turns a free sweepstakes into an unlicensed lottery. Kept under 160 characters
 * so it is a single segment.
 */
export const ENTRY_REPLY =
  'NUM: you are entered in this week’s Friday pack draw. '
  + 'Winners are drawn Friday and told in the app. '
  + 'Rules: itsnum.com/friday-rules Reply STOP to opt out.';

/**
 * Record an entry. Idempotent within a period by (phone, week_start).
 *
 * Never throws. An entry is a nice thing to have and must never be the reason a
 * text goes unanswered — the caller replies whatever happens here, because from
 * the entrant's side a silent failure and a successful entry look identical and
 * only one of them is honest.
 *
 * @returns {Promise<{ok:boolean, created?:boolean, week?:number, error?:string}>}
 */
export async function enter(env, { phone, memberId = null, source = 'sms', now = null }) {
  if (!env?.DB) return { ok: false, error: 'no DB' };
  const p = String(phone ?? '').trim();
  if (!/^\+[1-9]\d{6,14}$/.test(p)) return { ok: false, error: 'phone must be E.164' };

  const week = weekStart(now ?? Math.floor(Date.now() / 1000));
  try {
    const ins = await env.DB.prepare(
      `INSERT INTO num_giveaway_entries (id, phone, member_id, week_start, source, created_at)
       VALUES (?1,?2,?3,?4,?5,unixepoch())
       ON CONFLICT(phone, week_start) DO NOTHING`,
    ).bind(
      `ge_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
      p,
      memberId,
      week,
      source,
    ).run();
    return { ok: true, created: (ins?.meta?.changes ?? 0) > 0, week };
  } catch (e) {
    console.warn('[giveaway] entry write failed', e?.message ?? e);
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** How many distinct people are in the current period. */
export async function eligibleCount(env, now = null) {
  if (!env?.DB) return 0;
  const week = weekStart(now ?? Math.floor(Date.now() / 1000));
  const row = await env.DB.prepare(
    'SELECT COUNT(DISTINCT phone) AS n FROM num_giveaway_entries WHERE week_start = ?1',
  ).bind(week).first().catch(() => null);
  return Number(row?.n ?? 0);
}
