// eSIM pricing — undercut the market, never lose money by accident.
//
// Dre's brief (21 Sep): "price it better than everyone else, we just want
// the user." Wholesale eSIM data costs a fraction of retail, so a thin margin
// over true cost is already far below the big brands. What must never happen
// is a sale that loses money because nobody counted the card fee.
//
// All money is integer US cents. The price is always computed on the server
// from the supplier's cost; a client never names its own price.
//
//   break-even  = the price at which, after the card fee, we recover cost
//   target      = break-even + a thin cushion (refunds, disputes, cost drift)
//   subsidy     = only when ESIM_MAX_LOSS_CS is set: a deliberate, bounded
//                 loss per sale to win the traveller. Default 0 = never.

export const STRIPE_MIN_CS = 50; // Stripe's minimum charge in USD

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Pricing knobs, read from env with safe defaults. */
export function pricingConfig(env = {}) {
  return {
    // Card fee model. Stripe US: 2.9% + 30c, +1.5% for cards issued outside
    // the US — most travellers. Priced for the worse case.
    feePct: num(env.ESIM_FEE_PCT, 4.4),
    feeFixedCs: num(env.ESIM_FEE_FIXED_CS, 30),
    marginPct: num(env.ESIM_MARGIN_PCT, 10),
    minMarginCs: num(env.ESIM_MIN_MARGIN_CS, 25),
    maxLossCs: num(env.ESIM_MAX_LOSS_CS, 0),
  };
}

/** Estimated card fee on a charge of `priceCs`. */
export function feeFor(priceCs, cfg) {
  return Math.ceil((priceCs * cfg.feePct) / 100 + cfg.feeFixedCs);
}

/** Lowest price that recovers cost after the card fee. */
export function breakEvenCs(costCs, cfg) {
  return Math.ceil((costCs + cfg.feeFixedCs) / (1 - cfg.feePct / 100));
}

/** Round UP to the next price ending in 9 (x.x9): 437 -> 439, 440 -> 449. */
export function roundUp9(cs) {
  return Math.ceil((cs + 1) / 10) * 10 - 1;
}

/** Round DOWN to the previous price ending in 9: 1100 -> 1099, 1095 -> 1089. */
export function roundDown9(cs) {
  return Math.floor((cs + 1) / 10) * 10 - 1;
}

/**
 * Price one plan.
 * @param {{costCs:number, retailCs?:number|null}} plan  supplier cost, and the
 *        supplier's own suggested retail if it publishes one
 * @returns {{ok:boolean, priceCs:number, costCs:number, breakEvenCs:number,
 *            feeCs:number, marginCs:number, subsidised:boolean,
 *            cappedAtRetail:boolean, reason?:string}}
 */
export function priceFor(plan, env = {}) {
  const cfg = pricingConfig(env);
  const costCs = Math.ceil(Number(plan?.costCs));
  if (!Number.isFinite(costCs) || costCs <= 0) {
    return { ok: false, reason: 'no_cost', priceCs: 0, costCs: 0, breakEvenCs: 0, feeCs: 0, marginCs: 0, subsidised: false, cappedAtRetail: false };
  }
  const be = breakEvenCs(costCs, cfg);
  let price;
  let subsidised = false;
  if (cfg.maxLossCs > 0) {
    // Deliberate subsidy: charge less than break-even, by at most maxLoss.
    price = Math.max(STRIPE_MIN_CS, be - cfg.maxLossCs);
    subsidised = price < be;
  } else {
    const cushion = Math.max(cfg.minMarginCs, Math.ceil((costCs * cfg.marginPct) / 100));
    price = be + cushion;
  }
  price = Math.max(STRIPE_MIN_CS, roundUp9(price));

  // Never charge more than the supplier's own suggested retail. If even
  // break-even sits above it, the plan is not worth listing: we would be
  // the expensive option, which is the opposite of the brief.
  let cappedAtRetail = false;
  const retailCs = Number(plan?.retailCs);
  if (Number.isFinite(retailCs) && retailCs > 0 && price >= retailCs) {
    const under = roundDown9(retailCs - 1);
    const floor = subsidised ? price : be;
    if (under >= floor && under >= STRIPE_MIN_CS) {
      price = under;
      cappedAtRetail = true;
    } else {
      return { ok: false, reason: 'above_retail', priceCs: price, costCs, breakEvenCs: be, feeCs: feeFor(price, cfg), marginCs: 0, subsidised, cappedAtRetail: false };
    }
  }

  const feeCs = feeFor(price, cfg);
  return { ok: true, priceCs: price, costCs, breakEvenCs: be, feeCs, marginCs: price - costCs - feeCs, subsidised, cappedAtRetail };
}

/** Format integer cents as "$4.99". */
export function usd(cs) {
  const n = Math.max(0, Math.round(Number(cs) || 0));
  return `$${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
}
