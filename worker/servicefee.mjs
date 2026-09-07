/**
 * WHO PAYS NUM, AND WHO NEVER DOES.
 *
 * ── THE CHANGE, 7 SEP 2026 ──────────────────────────────────────────────
 * There was a £5 per-booking fee, charged to the host on confirm. It is GONE.
 *
 * It was removed for a reason worth keeping written down, because someone will
 * propose it again: a per-booking fee is a tax on the host using the product.
 * Every confirm cost them money, so the rational move was to confirm less in
 * NUM and keep the rest on WhatsApp — which starves the system of exactly the
 * data that makes it useful, to collect five pounds. And it could not even be
 * collected: most hosts sit on the free plan because no plan caps clients, a
 * free host has no card on file, and the invoicing sweep skipped them.
 *
 * NUM's host revenue is now ONE line: **the subscription.** Want more? Upgrade.
 * That is the whole model, and it has the property the per-booking fee never
 * had — the host's incentive and ours point the same way. We earn more when
 * they need more reach, not when they do more work.
 *
 * ── WHAT REMAINS TRUE ───────────────────────────────────────────────────
 *   1. THE SUBSCRIPTION — flat, monthly, per host. Never priced per client: a
 *      concierge's book is what they spent years building, and charging per
 *      head makes their first instinct to keep clients out of NUM.
 *   2. TIERED ACCESS — the same host paying more unlocks more of the tool.
 *      Capability, never headroom.
 *   3. THE SUPPLIER COMMISSION — our ~10% from the venue, hotel or driver on a
 *      booking we made. worker/commission.mjs. The traveller never sees it.
 *
 * And the rule that outranks all three: **a VIP host's client is never charged
 * by NUM, for anything, on any plan.** That has not moved and must not.
 */

/**
 * The per-booking fee, in minor units. ZERO, and deliberately still exported.
 *
 * Deleting the constant would have meant hunting every caller in two workers
 * in one pass and hoping. Exporting 0 makes every existing call site correct
 * by arithmetic: nothing accrues, `worker/hostmoney.mjs`'s invoicing sweep
 * selects `WHERE booking_fee_minor > 0` and therefore finds nothing, and no
 * host can be billed for work. A test pins it at 0 so it cannot drift back up
 * without someone deciding to.
 */
export const BOOKING_FEE_MINOR = 0;

/** Older name, same zero. */
export const MEMBER_SERVICE_FEE_MINOR = 0;

/**
 * Does this member belong to a VIP host's book right now? Returns the host id,
 * or false.
 *
 * Still here, and still worth having: it is how the app answers "who looks
 * after me", how a client's page finds their host, and how we know not to
 * offer someone an introduction they already have. It simply no longer decides
 * who is charged, because nobody is.
 *
 * `status = 'active'` only. A paused client is one the host has stepped back
 * from, and a removed one has gone.
 */
export async function memberHasHost(env, memberId) {
  if (!memberId) return false;
  const row = await env.DB.prepare(
    "SELECT host_id FROM num_host_clients WHERE member_id = ? AND status = 'active' LIMIT 1"
  ).bind(String(memberId)).first().catch(function () { return null; });
  return row ? String(row.host_id) : false;
}

/**
 * What NUM charges for arranging this: nothing, on either side.
 *
 * The shape is kept so callers do not need rewriting, and so the answer can be
 * shown to a person rather than assumed. `payer: "nobody"` is a real state, not
 * a null — it is the thing we want a host and a client to both be told.
 */
export async function bookingFeeFor(env, memberId) {
  const hostId = await memberHasHost(env, memberId);
  return {
    fee_minor: 0,
    payer: "nobody",
    host_id: hostId || null,
    member_pays_minor: 0,
    why: hostId
      ? "Nothing to pay. Your VIP host subscribes to NUM; you are never charged."
      : "Nothing to pay. NUM does not charge a booking fee.",
  };
}

/** Older name, same answer. */
export async function serviceFeeFor(env, memberId) {
  const f = await bookingFeeFor(env, memberId);
  return { fee_minor: 0, exempt: true, why: f.why };
}
