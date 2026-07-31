// Which rail actually moves the money, and whether we can move it at all.
//
// The registry below is the honesty mechanism, the same one the concierge uses
// for cars and food: an adapter that is not `ready` cannot be executed, so the
// system can never record a payout as sent when nothing left the building.
// Right now every adapter is unready, which matches reality — there are no
// Stripe Connect accounts and no crypto signer configured.

/**
 * A rail becomes live by giving it credentials. Nothing else changes: the
 * queue, the approvals and the audit trail already work.
 */
export const ADAPTERS = {
  usdc_base: {
    label: 'USDC on Base',
    ready: (env) => !!(env.USDC_SIGNER_KEY && env.USDC_RPC_URL),
    // The only rail with a destination already on file for real members.
    needs: 'USDC_SIGNER_KEY + USDC_RPC_URL (a funded treasury wallet and an RPC endpoint)',
    async send() {
      throw new Error('usdc_base is not configured');
    },
  },
  stripe_connect: {
    label: 'Stripe Connect',
    ready: (env) => !!env.STRIPE_SECRET_KEY,
    needs: 'STRIPE_SECRET_KEY, plus each member completing Connect onboarding',
    async send() {
      throw new Error('stripe_connect is not configured');
    },
  },
  wise: { label: 'Wise', ready: (env) => !!env.WISE_API_TOKEN, needs: 'WISE_API_TOKEN', async send() { throw new Error('wise is not configured'); } },
  paypal: { label: 'PayPal Payouts', ready: (env) => !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET), needs: 'PAYPAL_CLIENT_ID + PAYPAL_SECRET', async send() { throw new Error('paypal is not configured'); } },
  thunes: { label: 'Thunes', ready: (env) => !!env.THUNES_API_KEY, needs: 'THUNES_API_KEY — the answer for Asia, which Stripe does not cover', async send() { throw new Error('thunes is not configured'); } },
};

export const railReady = (env, rail) => !!ADAPTERS[rail]?.ready(env);

export const readyRails = (env) => Object.keys(ADAPTERS).filter((r) => ADAPTERS[r].ready(env));

/** One Star is one US dollar. Stated once, here, so it is never re-guessed. */
export const STAR_CENTS = 100;

/**
 * Choose the rail for a payout.
 *
 * Order of preference: a rail the member already has a working destination for,
 * then whatever the country table allows, lowest `priority` first. A rail is
 * only offered if the member can actually receive on it — a country row saying
 * "US → stripe_connect" is worthless when the member never onboarded.
 */
export function chooseRail({ member, methods = [], countryRails = [], amountCents, env = {} }) {
  const enabled = methods.filter((m) => m.status === 'enabled');
  const candidates = [];

  for (const m of enabled) {
    const row = countryRails.find((r) => r.rail === m.rail);
    candidates.push({
      rail: m.rail,
      method_id: m.id,
      destination: m.external_id,
      priority: row?.priority ?? 5, // a destination we hold beats a table row we do not
      min: row?.min_amount_cents ?? 100,
      max: row?.max_amount_cents ?? 1_000_000,
      have_destination: true,
    });
  }
  for (const r of countryRails) {
    if (candidates.some((c) => c.rail === r.rail)) continue;
    candidates.push({
      rail: r.rail,
      method_id: null,
      destination: null,
      priority: r.priority,
      min: r.min_amount_cents,
      max: r.max_amount_cents,
      have_destination: false,
    });
  }

  const usable = candidates
    .filter((c) => amountCents >= c.min && amountCents <= c.max)
    .sort((a, b) => Number(b.have_destination) - Number(a.have_destination) || a.priority - b.priority);

  const chosen = usable[0] ?? null;
  return {
    chosen,
    // Everything considered, so an operator can see WHY something was picked.
    considered: candidates.map((c) => ({ ...c, ready: railReady(env, c.rail) })),
    blocked_reason: chosen
      ? null
      : candidates.length
        ? `No rail accepts ${(amountCents / 100).toFixed(2)} for ${member?.country ?? 'this country'}.`
        : `No rail is configured for ${member?.country ?? 'this country'}, and the member has no payout destination on file.`,
  };
}
