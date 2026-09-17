/**
 * The email a subscriber gets. Until 17 Sep 2026 there wasn't one.
 *
 * ── WHAT WAS ACTUALLY WRONG ──────────────────────────────────────────────
 *
 * `checkout.session.completed` granted the tier and told nobody. Members got
 * a single in-app push; business and host buyers got silence. The one place
 * that held a customer's address — `invoice.payment_failed`, which receives
 * `customer_email` — spent it on a console.warn:
 *
 *     console.warn('[pay] renewal payment failed for', sub, '— Stripe will
 *                   retry; grace covers it')
 *
 * Nobody reads a console, and a recurring charge nobody was told about is a
 * chargeback in three weeks' time, when "NUM" on a statement means nothing
 * and the cheapest way to find out is to ask the bank.
 *
 * ── WHY worker/mailer.mjs AND NOT sendEmail() ────────────────────────────
 *
 * email.mjs sends through the Cloudflare `EMAIL` binding, which accepts a
 * message and reports nothing about what happened to it. mailer.mjs exists
 * because that cost six businesses: its own header records that an ACCEPT is
 * not a delivery, and `chainFor(AUDIENCE.EXTERNAL)` is therefore Resend only,
 * which reports per-message status and bounces. A receipt is external mail by
 * definition, so it goes that way, and `recordSend` files the outcome where
 * the health endpoint already looks.
 *
 * ── THE RULE ABOUT THE NUMBER ────────────────────────────────────────────
 *
 * The price in the email is read from worker/planprice.mjs, in the currency
 * the Stripe session actually charged. It is never re-derived, defaulted or
 * rounded here. An email that disagrees with the checkout page by one
 * currency is worse than no email at all.
 */
import { priceFor, formatPrice } from './planprice.mjs';
import { composeTemplate } from './email.mjs';
import { send, recordSend, AUDIENCE } from './mailer.mjs';

const SITE = (env) => env?.SITE || 'https://itsnum.com';
const APP = (env) => env?.NUM_APP_ORIGIN || 'https://app.itsnum.com';

/** A date a person can read, from the timestamp shapes the tables hold. */
function readable(value) {
  if (!value) return 'in a month';
  const d = new Date(String(value).replace(' ', 'T') + (String(value).length === 19 ? 'Z' : ''));
  if (Number.isNaN(d.getTime())) return 'in a month';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * What this owner kind calls its tiers, and where its dashboard is.
 *
 * Three ladders, three tables, three consoles — and one shape here so the
 * webhook does not need to know which is which beyond the word it already
 * has in the `ref`.
 */
async function planFacts(env, ownerKind, tier, currency) {
  const cents = priceFor(ownerKind === 'member' ? 'biz' : ownerKind, tier, currency);
  const price = cents == null ? '' : formatPrice(cents, currency);
  if (ownerKind === 'biz') {
    const { bizTiers } = await import('./bizbilling.mjs');
    const t = bizTiers(env)[tier];
    return { plan: t?.name ? `NUM for Business — ${t.name}` : 'your NUM plan', what: t?.blurb ?? '', price, link: `${APP(env)}/api/biz/console` };
  }
  if (ownerKind === 'host') {
    const { HOST_PLANS } = await import('./hostmoney.mjs');
    const t = HOST_PLANS[tier];
    return { plan: t?.name ? `NUM for hosts — ${t.name}` : 'your NUM plan', what: '', price, link: `${SITE(env)}/host/` };
  }
  return { plan: `NUM ${tier}`, what: '', price, link: `${APP(env)}/?app` };
}

/**
 * Send one plan email. Never throws.
 *
 * The webhook's own rule, borrowed from the revenue hook beside it: a
 * courtesy must never fail a payment. A throw here would make Stripe retry
 * the charge handling forever, so everything is caught and the failure is
 * logged rather than raised.
 *
 * @param kind  'plan_receipt' | 'plan_renewal_failed' | 'plan_ended'
 */
export async function sendPlanMail(env, kind, { to, ownerKind, tier, currency = 'USD', renewsAt = null, priceOverride = null } = {}) {
  try {
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to))) {
      console.warn('[planmail] no usable address for', kind, ownerKind ?? '?');
      return { ok: false, reason: 'no_address' };
    }
    const facts = await planFacts(env, ownerKind, tier, currency);
    // A failed invoice states its own amount, and that amount is what the bank
    // declined — which may not be a current list price if a plan changed mid
    // period. The invoice wins where it has an opinion.
    if (priceOverride != null) facts.price = formatPrice(priceOverride, currency);
    const msg = composeTemplate(kind, {
      plan: facts.plan,
      price: facts.price,
      what: facts.what,
      renews: readable(renewsAt),
      link: facts.link,
    });
    if (!msg) return { ok: false, reason: 'unknown_template' };

    const out = await send(env, {
      to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    }, { audience: AUDIENCE.EXTERNAL });

    await recordSend(env, kind, out).catch(() => {});
    if (!out.ok) console.error('[planmail]', kind, 'not sent:', out.error, out.tried);
    return out;
  } catch (err) {
    console.error('[planmail] threw, swallowed so the webhook survives', err?.stack ?? err);
    return { ok: false, reason: 'threw' };
  }
}

/**
 * The address that paid.
 *
 * Stripe's own field, not a lookup: `customer_details.email` is what the
 * buyer typed into the checkout page, which is by definition the person who
 * expects the receipt. A row in our database might hold a different address
 * — a venue's published one, a host's contact — and sending a receipt for a
 * card to an address that did not present it is its own small mistake.
 */
export const payerEmail = (session) =>
  session?.customer_details?.email || session?.customer_email || null;
