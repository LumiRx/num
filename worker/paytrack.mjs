/**
 * Every step of a bill, written down.
 *
 * ── WHAT THIS EXISTS TO FIX ──────────────────────────────────────────────
 *
 * num_pay_events already recorded scans. It recorded nothing else that
 * matters, because everything else happens on the other Worker: the /p/ page
 * lives on num-growth and logs a scan, and then the guest picks a rail, a
 * Checkout session opens on num-app, Stripe settles it, the till closes or
 * refuses — and not one of those was written anywhere.
 *
 * So the system could not answer "how many people who scanned actually paid,
 * and by what" about itself. That is the same shape of blindness as a bill
 * with no payer: not a missing dashboard, a missing fact.
 *
 * ── THREE RULES ──────────────────────────────────────────────────────────
 *
 * 1. IT NEVER BREAKS A PAYMENT. Every call is wrapped and returns null on
 *    failure. A guest's money must never fail to move because we could not
 *    write a row about it, and a webhook that 500s over analytics makes
 *    Stripe retry a settled bill.
 *
 * 2. THE VOCABULARY IS CLOSED. An unknown kind is dropped with a warning
 *    rather than inserted. A typo that quietly invents a new funnel stage
 *    nobody counts is worse than a missing event, because the funnel then
 *    looks complete and is not.
 *
 * 3. A REASON IS NOT A PLACE TO PUT SECRETS. `detail` is clipped and scrubbed
 *    of anything shaped like a credential or a Stripe object id before it is
 *    stored, because these rows are read by venue staff in a console and the
 *    reasons come from vendors we do not control.
 */

/**
 * The funnel, in order, as data. Anything not in here is not an event.
 *
 * The first four are written by num-growth on the /p/ page; the rest by
 * num-app, where the money is. Keeping them in ONE table is the whole point —
 * a funnel split across two tables is two funnels that disagree.
 */
export const KINDS = Object.freeze({
  scan: 'the code was opened',
  tap_through: 'the guest left for the venue\'s own payment page',
  receipt_view: 'a settled bill was reopened',
  retired_view: 'a replaced code was opened',
  unknown_token: 'a code that is not ours',
  rail_chosen: 'a rail was picked in the app',
  checkout_opened: 'a Stripe session was created on the venue account',
  checkout_refused: 'the session could not be created, and why',
  paid: 'the webhook settled the bill',
  autopay_paid: 'the standing mandate paid it without a tap',
  autopay_refused: 'the mandate declined to, and why',
  split: 'the bill was divided into shares',
  share_paid: 'one share of a split landed',
  till_closed: 'the check was closed in the venue POS',
  till_failed: 'the bill is paid and the check is still open',
  photo_read: 'a paper bill was read by the model',
});

/** Reasons arrive from Stripe, from tills, from us. None may carry a secret. */
const SECRETISH = /\b(sk_[A-Za-z0-9_]+|rk_[A-Za-z0-9_]+|whsec_[A-Za-z0-9_]+|acct_[A-Za-z0-9]+|cs_[A-Za-z0-9_]+|pi_[A-Za-z0-9_]+|seti_[A-Za-z0-9_]+|Bearer\s+\S+)/g;

export function scrub(text) {
  if (text == null) return null;
  return String(text).replace(SECRETISH, '[redacted]').trim().slice(0, 160) || null;
}

/**
 * Record one step. Fire-and-forget by design: callers do not await a decision
 * from this, they await the write only so a Worker does not exit mid-insert.
 */
export async function track(env, { token, businessId = null, kind, rail = null, memberId = null, detail = null, amountMinor = null } = {}) {
  if (!env?.DB || !token || !kind) return null;
  if (!(kind in KINDS)) {
    console.warn('[paytrack] refusing an unknown event kind:', String(kind).slice(0, 40));
    return null;
  }
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO num_pay_events (token, business_id, kind, billable, day, created_at, rail, member_id, detail, amount_minor)
       VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(
      String(token).toUpperCase(), businessId ?? '', kind, now.slice(0, 10), now,
      rail ? String(rail).slice(0, 40) : null,
      memberId ? String(memberId).slice(0, 64) : null,
      scrub(detail),
      Number.isFinite(amountMinor) ? Math.round(amountMinor) : null,
    ).run();
    return true;
  } catch (e) {
    // Almost always "no such column" before migration 0047 has run. Logged
    // once per event rather than thrown, because a missing funnel is an
    // inconvenience and a failed payment is not.
    console.warn('[paytrack]', kind, 'not recorded:', String(e?.message ?? e).slice(0, 120));
    return null;
  }
}

/**
 * What happened to ONE bill, in order.
 *
 * This is the question a person actually asks: a guest says they paid, the
 * venue says they did not, and somebody has to find out which is true. A
 * count cannot answer that; a trail can.
 */
export async function trailFor(env, token) {
  if (!env?.DB || !token) return [];
  const out = await env.DB.prepare(
    `SELECT kind, rail, detail, member_id, amount_minor, created_at
       FROM num_pay_events WHERE token = ?1 ORDER BY created_at, id LIMIT 200`,
  ).bind(String(token).toUpperCase()).all().catch(() => null);
  return (out?.results ?? []).map((r) => ({
    kind: r.kind,
    what: KINDS[r.kind] ?? r.kind,
    rail: r.rail ?? null,
    detail: r.detail ?? null,
    member_id: r.member_id ?? null,
    amount_minor: r.amount_minor ?? null,
    at: r.created_at,
  }));
}

/**
 * The funnel for one venue.
 *
 * Deliberately NOT a conversion percentage computed here. Scans and payments
 * are counted over the same window but they are not the same population — a
 * guest can scan on Monday and pay on Tuesday, and a bill can be paid in the
 * app without the /p/ page ever being opened. Dividing one by the other
 * produces a number that looks like a rate and is not one, and a venue would
 * make decisions on it. So the counts are returned and the reading is left to
 * whoever knows what they are looking at.
 */
export async function funnelFor(env, businessId, { days = 30 } = {}) {
  if (!env?.DB || !businessId) return null;
  const n = Math.min(Math.max(1, Math.floor(Number(days) || 30)), 365);

  const byKind = await env.DB.prepare(
    `SELECT kind, COUNT(*) n FROM num_pay_events
      WHERE business_id = ?1 AND created_at > datetime('now', ?2)
      GROUP BY kind`,
  ).bind(businessId, `-${n} days`).all().catch(() => null);
  if (!byKind?.results) return null;

  const byRail = await env.DB.prepare(
    `SELECT rail, kind, COUNT(*) n FROM num_pay_events
      WHERE business_id = ?1 AND rail IS NOT NULL AND created_at > datetime('now', ?2)
      GROUP BY rail, kind`,
  ).bind(businessId, `-${n} days`).all().catch(() => ({ results: [] }));

  // The refusals, named. A funnel that says forty people dropped is
  // interesting; one that says forty dropped because Pay by Bank is not
  // switched on in this venue's own Stripe account is something to go and fix.
  const why = await env.DB.prepare(
    `SELECT kind, rail, detail, COUNT(*) n FROM num_pay_events
      WHERE business_id = ?1 AND detail IS NOT NULL
        AND kind IN ('checkout_refused','autopay_refused','till_failed')
        AND created_at > datetime('now', ?2)
      GROUP BY kind, rail, detail ORDER BY n DESC LIMIT 12`,
  ).bind(businessId, `-${n} days`).all().catch(() => ({ results: [] }));

  const counts = {};
  for (const k of Object.keys(KINDS)) counts[k] = 0;
  for (const r of byKind.results) counts[r.kind] = Number(r.n) || 0;

  const rails = {};
  for (const r of byRail.results ?? []) {
    const key = r.rail;
    rails[key] = rails[key] ?? { chosen: 0, opened: 0, paid: 0, refused: 0 };
    if (r.kind === 'rail_chosen') rails[key].chosen += Number(r.n) || 0;
    if (r.kind === 'checkout_opened') rails[key].opened += Number(r.n) || 0;
    if (r.kind === 'paid' || r.kind === 'autopay_paid' || r.kind === 'share_paid') rails[key].paid += Number(r.n) || 0;
    if (r.kind === 'checkout_refused' || r.kind === 'autopay_refused') rails[key].refused += Number(r.n) || 0;
  }

  return {
    days: n,
    counts,
    rails,
    refusals: (why.results ?? []).map((r) => ({ kind: r.kind, rail: r.rail, detail: r.detail, n: Number(r.n) || 0 })),
  };
}
