/**
 * Marking a referral as earned.
 *
 * `/ref/signup` writes a conversion row with `verified=0` and
 * `reward_status='pending'`, and a comment promising that "rewards are granted
 * on verified conversions". That grant was never built: `reward_status` appears
 * exactly twice in the codebase — that comment, and the INSERT that writes
 * 'pending'. No UPDATE existed anywhere, so five real referrals sat pending
 * indefinitely and would have stayed pending even after SMS verification
 * started working.
 *
 * This module writes the earning half only. It marks the conversion earned in
 * num-db and stops there. It deliberately does NOT credit Stars, because
 * `member_finance.stars_earned` lives in the separate 5arz-ledger database
 * which the payout desk owns — `wrangler.app.jsonc` says so in as many words,
 * and AGENTS.md §8 makes the ledger the single source of truth for money.
 * Crossing that boundary from the app is how two systems start disagreeing
 * about what somebody is owed.
 */

// Both triggers count, whichever lands first.
//
// `phone_verified` was the original intent and is the stronger identity proof,
// but it depends on A2P 10DLC approval that has never arrived — gating solely
// on it is what left these rewards stranded. `first_ask` proves the referred
// person actually used the product, which is the thing the reward is really
// for; a bare signup is just a filled-in form. Accepting either means the loop
// turns today and still tightens automatically once SMS works.
export const EARN_TRIGGERS = ['phone_verified', 'first_ask'];

let ready = false;
async function ensure(env) {
  if (ready) return;
  // Added by migration rather than a schema rewrite: the existing rows are the
  // evidence of what already happened and must survive. They simply carry a
  // null trigger, which reads correctly as "earned before we recorded why".
  await env.DB.prepare('ALTER TABLE num_referral_conversions ADD COLUMN earned_at INTEGER').run().catch(() => {});
  await env.DB.prepare('ALTER TABLE num_referral_conversions ADD COLUMN earned_via TEXT').run().catch(() => {});
  ready = true;
}

/**
 * Mark this member's referral conversion earned, if they have a pending one.
 *
 * Idempotent by construction: the WHERE clause only matches a row that has not
 * already been marked, so calling it on every message is a no-op after the
 * first time. That matters because the honest place to call it is the hot path
 * — checking first would cost a read on every request to save a write that
 * almost never happens.
 *
 * Never throws. A referral bookkeeping failure must not break somebody's
 * question to their concierge, and it must not fail a verification.
 */
export async function markReferralEarned(env, memberId, trigger) {
  if (!env?.DB || !memberId || !EARN_TRIGGERS.includes(trigger)) return { earned: false };
  try {
    await ensure(env);
    const res = await env.DB.prepare(
      `UPDATE num_referral_conversions
          SET verified = 1,
              reward_status = 'earned',
              earned_at = unixepoch(),
              earned_via = ?2
        WHERE member_ref = ?1
          AND COALESCE(verified, 0) = 0`,
    ).bind(memberId, trigger).run();
    // D1 reports rows_written; treat any positive count as "this call is the
    // one that earned it", which is what an alert or a thank-you should hang
    // off rather than firing on every subsequent no-op.
    const changed = res?.meta?.changes ?? res?.meta?.rows_written ?? 0;
    return { earned: changed > 0, trigger };
  } catch (err) {
    console.warn('[referral] mark earned failed', err?.message ?? err);
    return { earned: false, error: String(err?.message ?? err) };
  }
}

/**
 * What the payout desk needs to pay people, and nothing else.
 *
 * Deliberately a read: this Worker names who is owed what, and the desk — the
 * only thing holding the ledger — decides and records the payment. Keeping the
 * app on the reading side of that line is what stops two systems disagreeing
 * about a balance.
 *
 * `reward_cs` is in cents. Stars are whole units worth STAR_CENTS (100) each,
 * so the desk divides by 100; every configured reward is a multiple of 100, and
 * anything that is not should be refused rather than rounded — rounding money
 * silently is how a ledger stops reconciling.
 */
export async function earnedAwaitingPayout(env, limit = 200) {
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT v.id, v.code, v.member_ref, v.reward_cs, v.earned_via,
            datetime(v.earned_at,'unixepoch') AS earned_at,
            c.owner_id AS payee_member_id
       FROM num_referral_conversions v
       JOIN num_referral_codes c ON c.code = v.code
      WHERE v.reward_status = 'earned'
        AND c.owner_type = 'member'
      ORDER BY v.earned_at
      LIMIT ?1`,
  ).bind(limit).all();
  return (results ?? []).map((r) => ({
    ...r,
    stars: r.reward_cs % 100 === 0 ? r.reward_cs / 100 : null,
    note: r.reward_cs % 100 === 0 ? null : 'reward_cs is not a whole number of Stars — refer to the desk, do not round',
  }));
}
