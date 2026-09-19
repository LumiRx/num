/**
 * When the venue's money actually lands.
 *
 * ── THE QUESTION THIS ANSWERS ────────────────────────────────────────────
 *
 * Under direct charges the money goes into the VENUE's own Stripe balance and
 * pays out on the VENUE's own schedule to the VENUE's own bank. That is the
 * design, it is what keeps NUM out of the flow of funds, and it is not
 * changing. What it costs is visibility: a venue watches NUM bills settle and
 * has nowhere in the product that says when the money arrives. "Where is it"
 * is the first question a new venue asks and it had no answer.
 *
 * ── WHY THIS IS TWO NUMBERS AND WILL NEVER BE ONE ────────────────────────
 *
 * A Stripe payout is the venue's WHOLE balance. It carries their own card
 * sales, their own refunds and their own adjustments alongside anything that
 * came through NUM — and at a venue doing any real trade, most of it is not
 * NUM's. So "your NUM money arrives Tuesday" is false twice over: the payout
 * is not NUM's, and it is not only from NUM.
 *
 * What NUM can say exactly is what its own settled bills came to, because it
 * settled them. What Stripe can say exactly is what is being paid out and
 * when. Those are different facts about different sets of money, and the
 * console shows them side by side and never adds them together — the same
 * rule that keeps Stars and USDC apart in the wallet, for the same reason: a
 * total of two things that are not the same thing is a number nobody can
 * check.
 *
 * ── AND NUM CANNOT MOVE ANY OF IT ────────────────────────────────────────
 *
 * There is no function here that pays, delays, accelerates or reverses a
 * payout, and there never should be. This module records something that
 * happened somewhere else.
 */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** The payout events worth listening to. Anything else Stripe sends is ignored. */
export const PAYOUT_EVENTS = Object.freeze(['payout.created', 'payout.paid', 'payout.failed', 'payout.updated', 'payout.canceled']);

/** Which venue does this connected account belong to? */
export async function businessForAccount(env, accountId) {
  if (!env?.DB || !accountId) return null;
  const row = await env.DB.prepare(
    'SELECT business_id FROM num_business_rails WHERE stripe_account_id = ?1',
  ).bind(String(accountId)).first().catch(() => null);
  return row?.business_id ?? null;
}

/**
 * Record a payout exactly as Stripe reports it.
 *
 * The status is copied, never inferred. A payout that failed must not read as
 * arriving, and a payout in transit must not read as paid — a venue planning
 * around money that is not coming is worse off than one who knows.
 */
export async function recordPayout(env, event) {
  const p = event?.data?.object ?? {};
  if (!p?.id) return { ok: false, reason: 'not a payout' };
  const businessId = await businessForAccount(env, event?.account);
  if (!businessId) return { ok: false, reason: 'no venue for that account' };

  const arrives = Number.isFinite(Number(p.arrival_date))
    ? new Date(Number(p.arrival_date) * 1000).toISOString().slice(0, 10)
    : null;

  try {
    await env.DB.prepare(
      `INSERT INTO num_business_payouts (id, business_id, account_id, amount_minor, currency, status, arrives_on, failure)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         arrives_on = COALESCE(excluded.arrives_on, num_business_payouts.arrives_on),
         failure = excluded.failure,
         updated_at = datetime('now')`,
    ).bind(
      String(p.id), businessId, String(event?.account ?? ''),
      Math.round(Number(p.amount) || 0),
      String(p.currency ?? 'usd').toUpperCase(),
      String(p.status ?? 'pending'),
      arrives,
      p.failure_message ? String(p.failure_message).slice(0, 200) : null,
    ).run();
    return { ok: true, business_id: businessId, status: p.status ?? 'pending' };
  } catch (e) {
    // The table arrives with migration 0056. A payout we failed to write down
    // is a missing row on a screen, never a failed webhook.
    console.warn('[payout] not recorded:', String(e?.message ?? e).slice(0, 120));
    return { ok: false, reason: 'could not record' };
  }
}

/** The venue's recent payouts, newest first. Stripe's words, not ours. */
export async function payoutsFor(env, businessId, { limit = 12 } = {}) {
  if (!env?.DB || !businessId) return [];
  const n = Math.min(Math.max(1, Math.floor(Number(limit) || 12)), 50);
  const out = await env.DB.prepare(
    `SELECT id, amount_minor, currency, status, arrives_on, failure, created_at
       FROM num_business_payouts WHERE business_id = ?1
      ORDER BY created_at DESC LIMIT ?2`,
  ).bind(businessId, n).all().catch(() => null);
  return out?.results ?? [];
}

/**
 * What NUM's own settled bills came to over a window.
 *
 * Only bills NUM actually settled, and stated in the bill's own currency
 * rather than summed across currencies — a venue that took dollars and baht
 * has two totals, and one number would be neither of them.
 *
 * `fee_minor` is what NUM took at source, shown because a venue should be able
 * to see it without asking, and because it is the difference between the
 * figure on the bill and the figure that reached their balance.
 */
export async function numSettled(env, businessId, { days = 30 } = {}) {
  if (!env?.DB || !businessId) return [];
  const n = Math.min(Math.max(1, Math.floor(Number(days) || 30)), 365);
  const out = await env.DB.prepare(
    `SELECT currency,
            COUNT(*) AS bills,
            SUM(CAST(ROUND(CAST(amount AS REAL) * 100) AS INTEGER)) AS gross_minor,
            SUM(COALESCE(application_fee_minor, 0)) AS fee_minor
       FROM num_paylinks
      WHERE business_id = ?1 AND settled_at IS NOT NULL
        AND COALESCE(one_time,0) = 1
        AND split_at IS NULL
        AND settled_at > datetime('now', ?2)
      GROUP BY currency`,
  ).bind(businessId, `-${n} days`).all().catch(() => null);

  return (out?.results ?? []).map((r) => ({
    currency: String(r.currency || 'THB').toUpperCase(),
    bills: Number(r.bills) || 0,
    gross_minor: Number(r.gross_minor) || 0,
    fee_minor: Number(r.fee_minor) || 0,
    // What reached the venue's own balance from these bills, before Stripe's
    // own processing fee — which is the venue's cost on their own account and
    // is not ours to state.
    net_minor: (Number(r.gross_minor) || 0) - (Number(r.fee_minor) || 0),
  }));
}

/**
 * Both halves, for the console, deliberately unsummed.
 *
 * A split bill is counted once, on the parent, which is where the money and
 * the commission both sit — counting the shares as well would double a
 * venue's takings on their own screen.
 */
export async function moneyView(env, businessId, { days = 30 } = {}) {
  const [payouts, settled] = await Promise.all([
    payoutsFor(env, businessId),
    numSettled(env, businessId, { days }),
  ]);
  return {
    days,
    // Stripe's, covering everything the venue sells.
    payouts,
    // NUM's, covering only bills NUM settled.
    through_num: settled,
    note: 'A Stripe payout is your whole balance — your own card sales as well as anything through NUM. The two are shown apart because they are not the same money.',
  };
}

export async function handleMoney(request, env, businessId) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);
  if (!businessId) return json({ error: 'which venue?' }, 400);
  return json({ ok: true, ...(await moneyView(env, businessId)) });
}
