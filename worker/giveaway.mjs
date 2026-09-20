/**
 * The Friday pack draw — the entry period, the entry itself, and one identity
 * for a person however they entered.
 *
 * Entry is deliberately NOT "text us to enter". It is "be a member who sends the
 * code in the app, OR text the keyword". Two routes into one table, because a
 * draw with a single mechanism is a draw that is broken whenever that mechanism
 * is.
 *
 * That is not caution for its own sake. Num's US A2P registration was rejected
 * once early on, and outbound sends failed 30034 for most of the product's
 * life — but NOT because the registration was still outstanding: brand and
 * campaign were approved on 28 Jul 2026, and the failures were a bare `From:`
 * being sent instead of the Messaging Service that carries the campaign
 * (worker/twiliosender.mjs). Two doors still earn their place: the fix
 * depends on one secret being set correctly on every sending worker, and a
 * draw with a single mechanism is broken whenever that mechanism is.
 * Inbound texts arrive regardless — the block was on us REPLYING —
 * so somebody can text the keyword, be entered correctly, and receive nothing.
 * If texting were the only route, that silence would look exactly like a scam.
 * With both routes live, the entry is real whether or not the confirmation lands,
 * and the Official Rules can say so truthfully.
 *
 * ── ONE PERSON, ONE TICKET ───────────────────────────────────────────────
 *
 * Two doors is only fair if they cannot both be walked through. Until 13 Sep the
 * key was (phone, week_start), which had two problems at once:
 *
 *   1. 107 of 147 members have no phone at all (12 Sep contact audit). A
 *      phone-keyed draw silently excludes three quarters of the people it exists
 *      to reward.
 *   2. `phone` was NOT NULL, so the app path could not write a row at all — and
 *      it was wired live, against columns that did not exist, failing on every
 *      single attempt.
 *
 * So the identity is `entrant_key`, and the app path resolves the member's phone
 * BEFORE building it. Somebody with a number on file gets `phone:+44…` whichever
 * door they use, and the unique index collapses the second attempt into the
 * first. Somebody without one gets `member:mem_…`, which is still exactly one
 * ticket. Nobody holds two.
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

/** The Thursday 23:59:59 UTC that closes the period `weekStart` opened. */
export const weekEnd = (start) => start + WEEK - 1;

/** The keyword. Single word, no collision with STOP/HELP/START handling. */
export const ENTRY_KEYWORD = 'PACKS';

/** E.164, the only shape a phone may take here. */
export const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * The one identity a draw entry is counted by.
 *
 * Phone wins whenever we have one, because it is the identity BOTH doors can
 * produce — that is the entire point. Returns null when we have neither, and the
 * caller must refuse rather than invent a key: an entry nobody can be identified
 * by is an entry that cannot be drawn, told, or verified at claim.
 */
export function entrantKey({ phone = null, memberId = null } = {}) {
  const p = String(phone ?? '').trim();
  if (E164.test(p)) return `phone:${p}`;
  const m = String(memberId ?? '').trim();
  if (m) return `member:${m}`;
  return null;
}

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
 * Record an entry. Idempotent within a period by (entrant_key, week_start).
 *
 * Never throws. An entry is a nice thing to have and must never be the reason a
 * text goes unanswered — the SMS caller replies whatever happens here, because
 * from the entrant's side a silent failure and a successful entry look identical
 * and only one of them is honest. The APP caller does the opposite and reports
 * the failure, because there it can.
 *
 * @returns {Promise<{ok:boolean, created?:boolean, week?:number, key?:string, error?:string}>}
 */
export async function enter(env, { phone = null, memberId = null, source = 'sms', now = null } = {}) {
  if (!env?.DB) return { ok: false, error: 'no DB' };

  const p = String(phone ?? '').trim();
  if (p && !E164.test(p)) return { ok: false, error: 'phone must be E.164' };

  const key = entrantKey({ phone: p, memberId });
  if (!key) return { ok: false, error: 'no phone and no member — nothing to enter' };

  const week = weekStart(now ?? Math.floor(Date.now() / 1000));
  try {
    const ins = await env.DB.prepare(
      `INSERT INTO num_giveaway_entrants
         (id, entrant_key, phone, member_id, week_start, source, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,unixepoch())
       ON CONFLICT(entrant_key, week_start) DO NOTHING`,
    ).bind(
      `ge_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
      key,
      E164.test(p) ? p : null,
      memberId ? String(memberId) : null,
      week,
      String(source).slice(0, 24),
    ).run();
    return { ok: true, created: (ins?.meta?.changes ?? 0) > 0, week, key };
  } catch (e) {
    console.warn('[giveaway] entry write failed', e?.message ?? e);
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * The number of people in the current period.
 *
 * Counts DISTINCT entrant_key rather than rows, so it agrees with the unique
 * index even if a future path ever writes past it. This number is shown to
 * entrants, so it has to be the same number the draw will use.
 */
export async function eligibleCount(env, now = null) {
  if (!env?.DB) return 0;
  const week = weekStart(now ?? Math.floor(Date.now() / 1000));
  const row = await env.DB.prepare(
    'SELECT COUNT(DISTINCT entrant_key) AS n FROM num_giveaway_entrants WHERE week_start = ?1',
  ).bind(week).first().catch(() => null);
  return Number(row?.n ?? 0);
}

/**
 * The phone we hold for a member, if any, so an in-app entry keys the same way
 * a text from that person would.
 *
 * Deliberately does NOT require phone_verified. An unverified number is still
 * the same human walking through two doors, and treating it as a different
 * person would hand them two tickets — which is the exact unfairness this
 * function exists to prevent. Verification matters at CLAIM, where the prize is.
 */
export async function phoneForMember(env, memberId) {
  if (!env?.DB || !memberId) return null;
  // NO .catch(() => null) HERE, deliberately. A member who genuinely has no
  // number and a read that failed are different facts, and collapsing them is
  // how one person ends up holding two tickets: a failed lookup would key them
  // `member:…` this week while their text keyed them `phone:…`, and the unique
  // index cannot collapse two different keys. The caller refuses the entry
  // rather than guess. `growth/readfail.mjs` makes the same argument at length.
  const row = await env.DB.prepare('SELECT phone FROM num_members WHERE id = ?1')
    .bind(String(memberId)).first();
  const p = String(row?.phone ?? '').trim();
  return E164.test(p) ? p : null;
}
