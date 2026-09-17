/**
 * What each kind of account is holding or owes — one shape, three sources.
 *
 * ── WHY ONE MODULE ───────────────────────────────────────────────────────
 *
 * "Show me my balance" means a different thing to each of NUM's three kinds
 * of account, and before this the answer lived nowhere a person could reach:
 *
 *   · a TRAVELLER holds Stars. The balance was readable in account.mjs for
 *     one screen and nowhere else.
 *   · a BUSINESS owes commission on bookings NUM completed for it. That was
 *     only ever visible to 5arz staff in the admin console.
 *   · a HOST owes booking fees that have not been invoiced yet. Computed
 *     only inside the monthly invoicing sweep, for the sweep's own use.
 *
 * Three different questions with three different answers is fine. Three
 * different call sites, each re-deriving its own arithmetic, is how two of
 * them end up disagreeing with the invoice. So the arithmetic is here, once.
 *
 * ── THE RULE ABOUT DIRECTION ─────────────────────────────────────────────
 *
 * `held` is theirs. `owed` is ours. They are never netted against each other
 * and never added: a traveller with 500 Stars and a business owing $40 are
 * not the same kind of number, and a single "balance: 460" would be a
 * sentence nobody could check. Every amount carries its own currency, for
 * the same reason worker/planprice.mjs exists.
 */
import { formatPrice } from './planprice.mjs';
import { CENTS_PER_STAR } from './preflight.mjs';

const money = (minor, currency) => ({
  minor: Number(minor) || 0,
  currency: String(currency ?? 'usd').toLowerCase(),
  display: formatPrice(Number(minor) || 0, String(currency ?? 'usd').toUpperCase()),
});

/**
 * A traveller's Stars.
 *
 * Shown with what they are worth at the peg, because "you have 500 Stars" is
 * only a number — and NOT as a cash balance, because bought Stars are not
 * cashable and saying "$500" beside them would imply they are. The wording
 * follows the same line /api/pay/status already publishes.
 */
async function memberBalance(env, memberId, currency) {
  const row = await env.DB.prepare('SELECT stars FROM num_star_balances WHERE member_id=?1')
    .bind(memberId).first().catch(() => null);
  const stars = Number(row?.stars ?? 0);
  const tier = await env.DB.prepare('SELECT tier, renews_at FROM num_memberships WHERE member_id=?1')
    .bind(memberId).first().catch(() => null);
  return {
    kind: 'member',
    held: {
      stars,
      // The peg, stated so the number means something. Worth, not value:
      // Stars spend inside NUM and bought ones never cash out.
      worth: money(stars * CENTS_PER_STAR, 'usd'),
      note: stars ? 'Stars spend inside NUM — on errands, tabs, tables and bounties. Never on travel.' : null,
    },
    owed: null,
    plan: tier?.tier ?? 'free',
    renews_at: tier?.renews_at ?? null,
  };
}

/**
 * What a business owes NUM: commission on bookings that completed.
 *
 * Read from num_business_revenue, which is what the webhook and the booking
 * path already write to — not recomputed from bookings, because a second
 * implementation of a commission rate is a second answer to "what do I owe".
 */
async function bizBalance(env, businessId) {
  const { revenueFor } = await import('./bizrevenue.mjs');
  const rev = await revenueFor(env, businessId).catch(() => ({ total_minor: 0, rows: [] }));
  // Grouped by currency, never summed across them.
  const byCurrency = {};
  for (const r of rev.rows ?? []) {
    const cur = String(r.currency ?? 'usd').toLowerCase();
    byCurrency[cur] = (byCurrency[cur] ?? 0) + Number(r.amount_minor ?? 0);
  }
  const plan = await env.DB.prepare('SELECT tier, renews_at FROM num_business_subscriptions WHERE business_id=?1')
    .bind(businessId).first().catch(() => null);
  return {
    kind: 'biz',
    held: null,
    owed: {
      by_currency: Object.entries(byCurrency).map(([cur, minor]) => money(minor, cur)),
      note: Object.keys(byCurrency).length
        ? 'Commission on bookings NUM completed for you. Your listing is free; this is only ever on business we sent.'
        : 'Nothing owed. You are only charged when a booking NUM sent you completes.',
    },
    plan: plan?.tier ?? 'free',
    renews_at: plan?.renews_at ?? null,
  };
}

/**
 * What a host owes: booking fees not yet invoiced.
 *
 * The same query the monthly sweep in hostmoney.mjs runs, minus the sweep —
 * `fee_invoiced_at IS NULL` is what "not yet billed" means there, so it is
 * what it means here. A host seeing a different number from their invoice is
 * the failure this shares a query to avoid.
 */
async function hostBalance(env, hostId) {
  const host = await env.DB.prepare('SELECT tier, plan_status, plan_renews_at, currency FROM num_hosts WHERE id=?1')
    .bind(hostId).first().catch(() => null);
  const { HOST_CURRENCY } = await import('./hostmoney.mjs');
  const cur = host?.currency || HOST_CURRENCY;
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(booking_fee_minor), 0) AS pence, COUNT(*) AS n
       FROM num_host_requests
      WHERE host_id = ?1 AND status IN ('confirmed','done')
        AND booking_fee_minor > 0 AND fee_invoiced_at IS NULL`,
  ).bind(hostId).first().catch(() => null);
  const pence = Number(row?.pence ?? 0);
  return {
    kind: 'host',
    held: null,
    owed: {
      by_currency: pence ? [money(pence, cur)] : [],
      jobs: Number(row?.n ?? 0),
      note: pence
        ? 'Fees on jobs you posted to other hosts. You keep 100% of your own work.'
        : 'Nothing owed. Your plan is the whole of what you pay NUM.',
    },
    plan: host?.tier ?? 'free',
    plan_status: host?.plan_status ?? 'none',
    renews_at: host?.plan_renews_at ?? null,
  };
}

/**
 * The balance for one account. Never throws — a balance is something shown
 * beside the real content of a page, and a page must not 500 over it.
 */
export async function balanceFor(env, kind, id, currency = 'USD') {
  if (!env?.DB || !id) return null;
  try {
    if (kind === 'member') return await memberBalance(env, id, currency);
    if (kind === 'biz') return await bizBalance(env, id);
    if (kind === 'host') return await hostBalance(env, id);
    return null;
  } catch (err) {
    console.warn('[balances] unavailable for', kind, err?.message ?? err);
    return null;
  }
}
