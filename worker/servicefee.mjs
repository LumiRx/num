/**
 * WHO PAYS THE £5, AND WHY IT IS NEVER THE HOST'S CLIENT.
 *
 * NUM has four revenue lines. Keeping them apart matters more than any of
 * them individually, because two of them touch people who are not our
 * customers, and the moment those blur we are billing a concierge's private
 * client — the exact thing /hosts/ promises we will not do.
 *
 *   1. THE PLATFORM FEE — one flat monthly fee for a VIP host to be on NUM.
 *      Not priced per client. Ever. A concierge's book is the thing they
 *      spent years building; charging per head charges them for their own
 *      success, and makes their first instinct to keep clients OUT of NUM,
 *      which breaks the product long before it improves the invoice.
 *
 *   2. TIERED ACCESS — the same host, paying more, unlocks more of the tool:
 *      texts and calendar, then the host network and introductions, then
 *      products and Ghost Message. Tiers buy CAPABILITY, never headroom.
 *
 *   3. THE SUPPLIER COMMISSION — our ~10% from the venue, hotel or driver.
 *      Already live in worker/commission.mjs. The traveller never sees it.
 *
 *   4. THE BOOKING FEE — £5 per booking NUM arranges. This file is about the
 *      one question that matters here: who it lands on.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────
 * The booking fee is paid by WHOEVER NUM'S CUSTOMER IS IN THAT RELATIONSHIP.
 *
 *   • Member has a VIP host  → THE HOST pays it. The client pays NUM nothing
 *     and never sees a NUM line item, because the host is the one with the
 *     commercial relationship and the one we are actually working for.
 *   • Member has no host     → THE MEMBER pays it. For that person NUM *is*
 *     the concierge, and there is nobody else to pay for the work.
 *
 * Somebody always pays £5 for the arranging. It is simply never two people,
 * and never the person a host is protecting.
 *
 * ── THE CONFLICT THIS CREATES, NAMED OUT LOUD ───────────────────────────
 * NUM collects the fee from an unhosted member directly, and from a host on
 * behalf of a hosted one. Those are the same £5, which is the point: we have
 * NO revenue reason to prefer one over the other, and therefore no reason to
 * introduce fewer people to hosts than we should.
 *
 * That symmetry is load-bearing. If either number ever moves independently,
 * the recommendation engine acquires a financial opinion about who a member
 * should be looked after by — and nobody will notice for a year. The guard is
 * structural: /api/host/nearby in growth/worker.js ranks strictly by distance
 * and by the host's own stated radius, with no revenue term, no scoring and
 * no suppression, and there is a test asserting it stays that way.
 */

/** The fee, in minor units. ONE number for both sides of the rule above —
 *  see the conflict note. If this ever becomes two numbers, or a percentage,
 *  read that paragraph again before you change it. */
export const BOOKING_FEE_MINOR = 500;

/** Kept as the old name so existing callers do not silently read undefined. */
export const MEMBER_SERVICE_FEE_MINOR = BOOKING_FEE_MINOR;

/**
 * Does this member belong to a VIP host's book right now?
 *
 * `status = 'active'` only. A paused client is one the host has stepped back
 * from and is not paying for, so the fee returns to the member — which is
 * also why pausing has to stay a deliberate act in the console and never a
 * side effect of anything else.
 */
export async function memberHasHost(env, memberId) {
  if (!memberId) return false;
  const row = await env.DB.prepare(
    "SELECT host_id FROM num_host_clients WHERE member_id = ? AND status = 'active' LIMIT 1"
  ).bind(String(memberId)).first().catch(function () { return null; });
  return row ? String(row.host_id) : false;
}

/**
 * Who is billed for arranging this, how much, and why.
 *
 * The reason travels with the number so that no surface has to reinvent the
 * explanation, and so a member is never shown a charge without being told
 * what it is for.
 */
export async function bookingFeeFor(env, memberId) {
  const hostId = await memberHasHost(env, memberId);
  return hostId
    ? {
        fee_minor: BOOKING_FEE_MINOR,
        payer: "host",
        host_id: hostId,
        member_pays_minor: 0,
        why: "Your VIP host is billed for this. NUM does not charge you.",
      }
    : {
        fee_minor: BOOKING_FEE_MINOR,
        payer: "member",
        host_id: null,
        member_pays_minor: BOOKING_FEE_MINOR,
        why: "A booking fee for arranging this. Members looked after by a VIP host never pay it — their host is billed instead.",
      };
}

/** Older name, same answer, shaped the way the first caller expected it. */
export async function serviceFeeFor(env, memberId) {
  const f = await bookingFeeFor(env, memberId);
  return { fee_minor: f.member_pays_minor, exempt: f.payer === "host", why: f.why };
}
