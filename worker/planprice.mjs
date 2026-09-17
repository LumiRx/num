/**
 * Plan prices, per currency — one table the page, the checkout and the
 * webhook all read.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * Until now a plan had exactly one price: bizbilling.mjs stated 999 and
 * pay.mjs defaulted `currency = 'usd'`, so every business on earth was
 * charged $9.99 and the page said so. hostmoney.mjs did the same in GBP.
 * That was honest but it wasn't local, and /hosts/ advertising £9.99 to a
 * Thai host who would then be charged in pounds is the same class of bug
 * commission.mjs was rewritten to kill in September: one number meaning
 * different prices depending on who read it.
 *
 * ── WHY A FIXED TABLE AND NOT AN FX RATE ─────────────────────────────────
 *
 * Deliberately NOT computed from a live rate, for exactly the reason
 * FLOOR_BY_CURRENCY in commission.mjs isn't:
 *
 *   "A floor that moves with the baht is a floor a venue cannot predict."
 *
 * A subscription is worse than a floor, because it recurs. A price that
 * drifts with the market re-prices a merchant every month, makes the page
 * disagree with the card statement the moment a rate moves, and turns a
 * renewal into a support ticket. So these are prices a human chose, rounded
 * to numbers a merchant recognises as a price rather than a conversion —
 * ฿349, not ฿347.12.
 *
 * ── THE RULE THAT KEEPS THE WEBHOOK HONEST ───────────────────────────────
 *
 * pay.mjs's `tierPaidRight()` refuses to grant a tier unless the Stripe
 * session's amount AND currency match what the server says the plan costs.
 * Before this file there was one number to compare against. Now there are
 * four per plan, so the webhook MUST look the price up in the currency the
 * session was actually created in — `priceFor(kind, tier, session.currency)`
 * — or every non-USD purchase would be rejected as an underpayment and
 * refunded. That is the single most breakable seam in the whole change, and
 * it is why the lookup lives here rather than being inlined twice.
 *
 * ── AND WHY THE CLIENT NEVER PICKS ───────────────────────────────────────
 *
 * bizbilling.mjs's header says it plainly: "prices are decided HERE, never
 * by the client." The same now goes for the currency. It is derived from
 * Cloudflare's own country header on the request, never from a body field
 * or a query param, because a currency a caller can choose is a discount a
 * caller can choose — pick THB, pay ฿349, get a plan advertised at $50.
 */
import { currencyForCountry, DEFAULT_CURRENCY } from './commission.mjs';

/**
 * Prices in the MINOR UNITS of each currency (cents, pence, satang), which
 * is what Stripe's `unit_amount` wants and what `tierPaidRight` compares.
 *
 * `biz` is NUM for Business (was USD-only). `host` is NUM for VIP hosts
 * (was GBP-only). They carry the same numerals on purpose: the Sept 15 rate
 * card set both ladders at 9.99 / 19.99 / 50 and a host who also runs a
 * venue should not have to reconcile two different prices for "Pro".
 *
 * THB is the one that isn't a numeral match, because ฿9.99 is 30 cents and
 * ฿999 is $29. These are the round baht prices nearest the dollar ones.
 */
export const PLAN_PRICES = Object.freeze({
  biz: Object.freeze({
    small: Object.freeze({ USD: 999, GBP: 999, EUR: 999, THB: 34900, MNT: 3500000 }),
    pro: Object.freeze({ USD: 1999, GBP: 1999, EUR: 1999, THB: 69900, MNT: 7000000 }),
    full: Object.freeze({ USD: 5000, GBP: 5000, EUR: 5000, THB: 175000, MNT: 17500000 }),
  }),
  host: Object.freeze({
    small: Object.freeze({ USD: 999, GBP: 999, EUR: 999, THB: 34900, MNT: 3500000 }),
    pro: Object.freeze({ USD: 1999, GBP: 1999, EUR: 1999, THB: 69900, MNT: 7000000 }),
    full: Object.freeze({ USD: 5000, GBP: 5000, EUR: 5000, THB: 175000, MNT: 17500000 }),
  }),
});

/** Currencies this table actually prices. Anything else falls to USD. */
export const PRICED_CURRENCIES = Object.freeze(['USD', 'GBP', 'EUR', 'THB', 'MNT']);

const SYMBOL = Object.freeze({ USD: '$', GBP: '£', EUR: '€', THB: '฿', MNT: '₮' });

/** Zero-decimal currencies would break /100. None of ours are, but say so. */
const MINOR_PER_MAJOR = 100;

/**
 * The currency to price this visitor in.
 *
 * Reads Cloudflare's country, which is on `request.cf.country` on a Worker
 * and mirrored into the `CF-IPCountry` header. Falls through to USD, never
 * to "no currency" — a page that can't name a price can't sell a plan.
 *
 * `env.PLAN_CURRENCY_FORCE` exists for one reason: testing a checkout in a
 * currency you aren't sitting in, without a VPN. It is not a customer-facing
 * override and nothing reads it from a request.
 */
export function currencyForRequest(request, env) {
  const forced = String(env?.PLAN_CURRENCY_FORCE ?? '').toUpperCase();
  if (PRICED_CURRENCIES.includes(forced)) return forced;
  const country = request?.cf?.country
    || request?.headers?.get?.('CF-IPCountry')
    || '';
  const cur = currencyForCountry(country);
  // commission.mjs prices more countries than this table does. An EUR
  // country it knows and we don't is still EUR; anything else is USD.
  return PRICED_CURRENCIES.includes(cur) ? cur : DEFAULT_CURRENCY;
}

/**
 * What `kind`'s `tier` costs in `currency`, in minor units.
 * Returns null for a plan that has no price (the free tier, a typo), which
 * callers must treat as "not purchasable" rather than "free".
 */
export function priceFor(kind, tier, currency) {
  const row = PLAN_PRICES[kind]?.[String(tier ?? '').toLowerCase()];
  if (!row) return null;
  const cur = String(currency ?? '').toUpperCase();
  return row[cur] ?? row[DEFAULT_CURRENCY] ?? null;
}

/**
 * The price written the way the buyer will see it, e.g. "$9.99", "฿349".
 * Trailing ".00" is dropped because "฿349.00" and "£50.00" read like a form
 * field, not a price — the same reason commission.mjs's money() trims.
 */
export function formatPrice(minorUnits, currency) {
  const cur = String(currency ?? DEFAULT_CURRENCY).toUpperCase();
  const n = Number(minorUnits);
  if (!Number.isFinite(n)) return '';
  const major = n / MINOR_PER_MAJOR;
  const body = Number.isInteger(major)
    ? major.toLocaleString('en-US')
    : major.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${SYMBOL[cur] ?? ''}${body}`;
}

/** Everything a page or an API needs to render one plan's price. */
export function priceBlock(kind, tier, currency) {
  const cents = priceFor(kind, tier, currency);
  if (cents == null) return null;
  const cur = String(currency ?? DEFAULT_CURRENCY).toUpperCase();
  // Lowercase on the way out: HOST_CURRENCY was 'gbp', Stripe wants 'gbp',
  // and hostmoney.test.mjs asserts 'gbp'. The table is keyed uppercase for
  // readability; every caller-facing surface speaks the lowercase Stripe
  // code, so no existing client comparison breaks.
  return { price_cents: cents, currency: cur.toLowerCase(), display: formatPrice(cents, cur) };
}
