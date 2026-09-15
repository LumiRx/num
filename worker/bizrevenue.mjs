/**
 * NUM · one event: money arrived, and this business is why.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────
 *
 * Two programmes pay people out of what a business produces:
 *
 *   · `scouts.mjs` — a Num Expert introduced the business and earns a finder's
 *     fee once it has produced its first revenue, then a share of what Num
 *     makes from it.
 *   · `bizreferral.mjs` — a member referred the business and earns 2% of
 *     bookings Num sends it, in Stars.
 *
 * Both were built, both were tested, and **neither was ever called.** Checked
 * 15 Sep 2026: `recordRevenue` had no callers and `creditBizReferral` had no
 * callers. Two complete payout systems, wired to nothing, quietly paying
 * nobody while people were being told they would earn.
 *
 * That is the shape of the bug worth naming: code that is correct, tested, and
 * unreachable looks exactly like code that works, right up until somebody asks
 * where their money is.
 *
 * So there is now ONE function for "this business produced revenue", called
 * from every place money actually settles, and the programmes hang off it. A
 * third programme added next year hooks here and nowhere else.
 *
 * ── AND IT CANNOT PAY TWICE ──────────────────────────────────────────────
 *
 * Stripe retries webhooks. A retried `checkout.session.completed` that ran
 * `recordRevenue` again would add the same money to the running total twice,
 * and could push a business over the finder gate on revenue that never
 * existed. `num_business_revenue` is the ledger AND the guard: one row per
 * (business, ref), so the second delivery of the same event writes nothing.
 *
 * It is also the answer to "where did this number come from", which is a
 * question somebody will eventually ask about a payout.
 */

const uid = (p) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;

/** Stars are whole units worth this many cents. Mirrors preflight.mjs. */
export const CENTS_PER_STAR = 100;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_business_revenue (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL,
  place_id      TEXT,
  -- What NUM collected, in minor units. Not the merchant's takings: the slice
  -- that reached NUM, which is the only thing a share may be paid out of.
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  currency      TEXT NOT NULL DEFAULT 'USD',
  source        TEXT NOT NULL,
  -- The payment processor's own id. This is what makes a retry harmless.
  ref           TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (business_id, ref)
);
CREATE INDEX IF NOT EXISTS idx_bizrev_biz ON num_business_revenue (business_id, created_at);
`;

let ensured = false;
export async function ensureRevenue(env) {
  if (ensured || !env?.DB) return;
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run().catch(() => {});
  }
  ensured = true;
}
export const _resetEnsured = () => { ensured = false; };

/** The listing this business owns, which is what a scout claim is keyed on. */
export async function placeForBusiness(env, businessId) {
  if (!env?.DB || !businessId) return null;
  const row = await env.DB.prepare(
    'SELECT place_id FROM num_place_owners WHERE business_id=?1 AND revoked_at IS NULL LIMIT 1',
  ).bind(businessId).first().catch(() => null);
  return row?.place_id ?? null;
}

/**
 * Money arrived from a business. Call this from wherever it settles.
 *
 * `ref` is required and must be the processor's own id — a Stripe session or
 * invoice id, a paylink token. Without one there is no way to tell a retry
 * from a second genuine payment, and the safe reading of that ambiguity is to
 * refuse rather than to risk paying twice on a webhook Stripe sent us again.
 *
 * Returns what it did rather than throwing: this runs inside a webhook, and a
 * thrown error there means Stripe retries forever.
 */
export async function businessEarned(env, {
  businessId, amountMinor, currency = 'USD', source = 'unknown', ref = null, now = new Date(),
} = {}) {
  const out = { ok: false, recorded: false, scout: null, referral: null };
  if (!env?.DB || !businessId || !ref) return { ...out, why: 'business and ref are required' };

  const amount = Math.round(Number(amountMinor) || 0);
  if (!(amount > 0)) return { ...out, why: 'nothing to record' };

  await ensureRevenue(env);
  const placeId = await placeForBusiness(env, businessId);

  // The ledger write is the idempotency check. If this row already exists the
  // event has been handled and nothing below runs again.
  try {
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO num_business_revenue
         (id, business_id, place_id, amount_minor, currency, source, ref, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
    ).bind(uid('rev'), businessId, placeId, amount, String(currency).toUpperCase(),
      String(source).slice(0, 40), String(ref).slice(0, 120), now.toISOString()).run();
    if (!res?.meta?.changes) return { ...out, ok: true, duplicate: true };
  } catch {
    return { ...out, why: 'could not record the revenue' };
  }

  // ── the Num Expert who introduced them ──────────────────────────────────
  if (placeId) {
    try {
      const { recordRevenue } = await import('./scouts.mjs');
      out.scout = await recordRevenue(env, { placeId, amountMinor: amount, now });
    } catch {
      // A payout programme must never be able to fail a payment webhook.
      out.scout = { ok: false, why: 'scout credit failed' };
    }
  }

  // ── the member who referred them ────────────────────────────────────────
  try {
    const { creditBizReferral } = await import('./bizreferral.mjs');
    const stars = Math.floor(amount / CENTS_PER_STAR);
    if (stars > 0) {
      out.referral = await creditBizReferral(env, { businessId, stars, ref });
    }
  } catch {
    out.referral = { credited: 0 };
  }

  return { ...out, ok: true, recorded: true, amount_minor: amount, place_id: placeId };
}

/** What a business has produced, for a console or a statement. */
export async function revenueFor(env, businessId) {
  if (!env?.DB || !businessId) return { total_minor: 0, rows: [] };
  await ensureRevenue(env);
  const { results = [] } = await env.DB.prepare(
    `SELECT amount_minor, currency, source, created_at FROM num_business_revenue
      WHERE business_id=?1 ORDER BY created_at DESC LIMIT 100`,
  ).bind(businessId).all().catch(() => ({ results: [] }));
  return {
    total_minor: results.reduce((n, r) => n + Number(r.amount_minor || 0), 0),
    rows: results,
  };
}
