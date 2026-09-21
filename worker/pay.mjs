// Taking money — the last thing standing between Num and a real booking.
//
// Two modes, because one of them works today and the other needs an account
// that does not exist yet:
//
//   LINKS   A payment link created by hand in the Stripe dashboard, pasted
//           into config here. Num hands it over. No API key, no integration,
//           works this afternoon. The limit is that the amount is fixed at
//           creation, so it only fits things with a known price.
//
//   STRIPE  A Checkout Session minted per request, for the exact amount, with
//           the booking reference attached. Needs a secret key. This is the
//           real one.
//
// The mode is decided by what is configured, not by a flag somebody has to
// remember to flip: a secret key present means sessions, otherwise links,
// and neither present means Num says plainly that it cannot take payment yet
// rather than inventing a checkout that goes nowhere.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
//
// It never sees a card number. Not in a form, not in a log, not in transit.
// Stripe Checkout is a hosted page on Stripe's domain, so the card never
// touches this Worker and PCI scope stays where it belongs. Any design where
// Num collects the digits itself would be a compliance problem wearing a
// feature's clothes — and note that Sabre's own flight check only ever asks
// for a BIN, the first six digits, which is precisely because the full number
// is somebody else's problem on purpose.

import { isIosApp, isDigitalSaleRef, IOS_NO_SALE } from './storefront.mjs';
import { checkPayment, refusal, STAR_PACKS } from './preflight.mjs';
import { alert } from './health.mjs';

import { formatPrice } from './planprice.mjs';

const STRIPE = 'https://api.stripe.com/v1';

// Whether Num can issue a ticket decides how travel settles, and therefore
// which compliance claim this endpoint is allowed to publish. One definition,
// in services.mjs, rather than a second opinion here.
import { fulfilment } from './services.mjs';

/**
 * NUM Stars have TWO POOLS, and the split is the whole design:
 *
 *   EARNED    — from work: errands run, bounties collected, tabs settled your
 *               way. Cashable to 5arz (worker/cashout.mjs). Paying someone for
 *               services they performed is what every platform with a payout
 *               does; it is not money transmission.
 *
 *   PURCHASED — bought with cash. Spends inside Num on errands, tabs and
 *               bookings. NOT cashable, ever. Cash in → cash out is precisely
 *               the money-transmitter shape, and one line of code allowing it
 *               would change what Stars legally are.
 *
 * `cashable()` therefore computes from ORIGIN (num_star_moves.kind), never
 * from the balance. Do not "simplify" it to read the balance — that silently
 * merges the pools and takes the licensing exposure with it.
 *
 * NUM Stars are still NOT the 5arz `stars_ledger`: separate system, separate
 * worker, separate economy. Cash-out is a REQUEST from here that the payout
 * desk settles there. The two ledgers must never be merged.
 */
/**
 * What Stars are and are not.
 *
 * ── 'bookings' CAME OFF THIS LIST ON 18 AUG 2026 ─────────────────────────
 *
 * Stars are bought with a card, land in Num's own Stripe balance, and are
 * spent later. A Star that settles a flight or a hotel is therefore "all sums
 * received … for travel services" under California B&P §17550.15(b), just with
 * a delay in the middle — which creates a trust obligation, which sizes a
 * surety bond under §17550.11. The whole $0-bond structure is the single
 * sentence "Num never holds traveller funds", and Star settlement of travel
 * makes that sentence false.
 *
 * `spends_on` now names TABLES rather than bookings, because that is the only
 * kind of booking Num brokers with its own money in the middle: a restaurant
 * table, billed to the venue, no transportation and no lodging, so no travel
 * services and nothing for §17550.9 to bite on. bookdesk keeps working.
 *
 * `never_spends_on` is not decoration. preflight.checkPayment refuses any
 * transaction whose ref names travel, and worker/travelspeak.test.mjs fails
 * if 'travel' or 'bookings' ever reappears above.
 */
export const STAR_POLICY = Object.freeze({
  earned_cashable: true,
  purchased_cashable: false,
  cash_out_destination: '5arz',
  spends_on: ['errands', 'tabs', 'tables', 'bounties'],
  never_spends_on: ['flights', 'hotels', 'cruises', 'rail', 'transfers', 'any travel'],
  statement: 'Stars you earn can be cashed out. Stars you buy spend inside Num — never on travel.',
});

/**
 * How travel is settled — DERIVED, because it stopped being a constant.
 *
 * This field used to read, as a frozen literal:
 *
 *   'never — the traveller pays the travel partner directly (B&P §17550.20(g)(5))'
 *
 * §17550.20(g)(5) is the California seller-of-travel exemption for somebody
 * who does not handle the money. It was true, it was published live at
 * /api/pay/status, and it was the whole basis on which Num had not registered.
 *
 * The moment Num can issue a ticket and charge a card for it, that sentence
 * becomes false — and a false compliance claim published by our own API is
 * `invent_fact` aimed at ourselves, which is the one direction nobody audits.
 * So it is computed from whether Num can actually issue, and the two claims
 * cannot both be made.
 *
 * Note what does NOT change: Stars still never buy travel. That is a separate
 * guardrail about what a purchased credit may be spent on, and it holds
 * whichever way this resolves.
 */
export function travelSettlement(env) {
  const f = fulfilment(env ?? {});

  // ── 13 SEP 2026: THE POSTURE IS PER-RAIL, NOT PER-COMPANY ──────────────
  //
  // This used to be one of two answers, chosen by whether Num was CAPABLE of
  // issuing. With LetsGo2Trip as the primary rail and Num issuing as the
  // backup, that question no longer has one answer: a deployment can route
  // almost every booking to the partner and still, on the rare one the
  // partner cannot take, charge the traveller itself and become merchant of
  // record for that sale.
  //
  // Publishing only the comfortable half of that would be exactly the
  // `invent_fact` aimed at ourselves this endpoint exists to prevent. So the
  // acting mode is stated first, and any backup that could change it is
  // stated alongside — because a registration you need for one booking a
  // month is a registration you need.
  if (f.primary === 'sabre') {
    return {
      mode: 'num_is_merchant_of_record',
      summary: 'Num charges the traveller and is the merchant of record on the ticket.',
      seller_of_travel: 'Num takes payment for air transport, so the §17550.20(g)(5) exemption does not apply. '
        + 'Registration with the California Attorney General (and the Florida and Washington equivalents) is required.',
      chargebacks: 'land on Num',
    };
  }
  // Anything that is not Num taking the money is the same published posture,
  // partner configured or not: the §17550.20(g)(5) exemption is about not
  // handling the funds, and that holds whether a partner is standing by or
  // the traveller simply books elsewhere. A third mode was drafted here and
  // removed — inventing a new legal claim is not a side effect a routing
  // change gets to have.
  {
    return {
      mode: 'direct_to_partner',
      summary: 'The traveller pays the travel partner directly. Num never holds the money.',
      seller_of_travel: f.backup === 'sabre'
        ? 'Exempt under B&P §17550.20(g)(5) for partner-issued bookings — Num does not handle those funds. '
          + 'BUT Num can issue and charge directly when the partner cannot take a booking, and the exemption '
          + 'does not apply to those. Registration is required before that backup carries a real sale.'
        : 'Exempt under B&P §17550.20(g)(5) — Num does not handle the funds.',
      chargebacks: f.backup === 'sabre'
        ? 'land on the partner, except on a Num-issued backup booking'
        : 'land on the partner',
      ...(f.backup ? { backup_issuer: f.backup } : {}),
    };
  }
}

/** Everything about Stars, plus how travel settles today. */
export const starPolicy = (env) => Object.freeze({ ...STAR_POLICY, travel_settlement: travelSettlement(env) });

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const readBody = async (req) => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/** Hand-made links, keyed by a short name. One JSON var, one paste. */
function links(env) {
  try {
    const p = JSON.parse(env.PAY_LINKS || '{}');
    return p && typeof p === 'object' ? p : {};
  } catch {
    console.warn('[pay] PAY_LINKS is not valid JSON — treating as none');
    return {};
  }
}

export const payMode = (env) => (env.STRIPE_SECRET_KEY ? 'stripe' : Object.keys(links(env)).length ? 'links' : 'none');

/**
 * THE PRICE LIST LIVES IN preflight.mjs, NOT IN THE REQUEST.
 *
 * The first version took `amount_cents` AND `ref` from the client and never
 * checked that they agreed — so `{ref:"stars:5000", amount_cents:100}` bought
 * ★5,000 for a dollar, and the webhook credited it because it reads the Stars
 * count out of `ref`. Verified against production before this fix: a live
 * Stripe session was minted for $1.00.
 *
 * Anything a customer receives must be priced by us. The client may say WHICH
 * pack; it may never say what a pack costs.
 */
// Re-exported so callers and tests have one place to read prices from.
export { STAR_PACKS };

/**
 * Stripe's API is form-encoded, including nested objects, which trips people
 * up because everything else about it looks modern. `a[b]=c` is the shape.
 */
function form(obj, prefix = '') {
  const out = [];
  // A bodyless request is a real Stripe call — DELETE /subscriptions/{id} has
  // nothing to send. Object.entries(null) throws, and because every caller
  // wraps this in a try/catch the throw surfaced as a plausible-looking
  // "Stripe refused" rather than as the programming error it was. Found by
  // worker/planmail.test.mjs, which asserted a cancellation that never fired.
  if (obj == null) return '';
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) out.push(form(v, key));
    else if (Array.isArray(v)) v.forEach((item, i) => out.push(typeof item === 'object' ? form(item, `${key}[${i}]`) : `${key}[${i}]=${encodeURIComponent(item)}`));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}

/**
 * Exported so flightpay.mjs speaks to Stripe through THIS client rather than
 * standing up a second one. Two Stripe clients means two opinions about
 * timeouts, error shape and idempotency, and the one that gets it wrong is
 * always the newer one nobody has watched fail yet.
 */
export { stripe as stripeCall, form as stripeForm };

async function stripe(env, path, body, idem, method = 'POST', { account = null } = {}) {
  const res = await fetch(`${STRIPE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Stripe's own idempotency, not ours. A retried checkout creation must
      // not leave two sessions for one booking.
      ...(idem ? { 'Idempotency-Key': idem } : {}),
      // A DIRECT CHARGE on a venue's connected account (billpay.mjs). The
      // header is the whole difference between "NUM took the money" and "the
      // venue took the money with NUM's fee on top" — see payrails.mjs.
      ...(account ? { 'Stripe-Account': account } : {}),
    },
    body: form(body),
    signal: AbortSignal.timeout(20_000),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(parsed?.error?.message ?? `Stripe ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return parsed;
}

/**
 * Who a payment belongs to — added 17 Sep 2026, and it fixes a real bug.
 *
 * `requestSubscription` bound its `ownerId` into the **member_id** column.
 * For a member that was right. For a business it wrote a biz_… id into a
 * column called member_id, and for a host a host_… id, so one column held
 * three different id namespaces and `idx_num_payments_member` indexed the
 * mixture. Nothing had noticed because no business or host subscription had
 * ever been created — the first one would have been the first corrupt row.
 *
 * It also made the thing asked for on 17 Sep impossible: a business cannot
 * be shown "every charge NUM has taken from you" when its payments are
 * filed under a column that means something else.
 *
 * So: owner_kind ('member' | 'biz' | 'host') and owner_id, set on every
 * write. member_id stays, populated only for real members, because other
 * code reads it and a column that quietly changes meaning is how this
 * started.
 */
/**
 * ORDER MATTERS HERE, and getting it wrong 500'd every payment route.
 *
 * The owner index was first written into SCHEMA, beside the member one. On a
 * database that already had num_payments — which is to say production — the
 * CREATE TABLE was a no-op, the columns did not exist yet, and CREATE INDEX
 * ON num_payments(owner_kind, owner_id) referenced columns that were not
 * there. env.DB.batch() throws on that, nothing caught it, and the Worker
 * returned a 1101 for anything that touched pay.mjs.
 *
 * Every test passed, because the test D1 shims swallow errors inside run()
 * and their fixtures create num_payments WITH the columns. It was caught by
 * calling the staged version over HTTP before it served traffic — which is
 * the entire reason that staging step exists.
 *
 * So: the columns are added first, the index after them, and both are
 * tolerant of already existing.
 */
const PAYMENT_ALTERS = [
  'ALTER TABLE num_payments ADD COLUMN owner_kind TEXT',
  'ALTER TABLE num_payments ADD COLUMN owner_id TEXT',
];
const PAYMENT_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_num_payments_owner ON num_payments(owner_kind, owner_id)',
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_payments (
  id TEXT PRIMARY KEY, member_id TEXT, mode TEXT NOT NULL, ref TEXT,
  amount_cents INTEGER, currency TEXT, description TEXT,
  session_id TEXT, url TEXT, state TEXT NOT NULL DEFAULT 'created',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT,
  owner_kind TEXT, owner_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_num_payments_member ON num_payments(member_id);
CREATE INDEX IF NOT EXISTS idx_num_payments_ref ON num_payments(ref);
CREATE TABLE IF NOT EXISTS num_star_ledger (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL, delta INTEGER NOT NULL,
  kind TEXT NOT NULL, ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_num_star_ledger_member ON num_star_ledger(member_id, created_at);
`;
const ready = new WeakSet();
async function ensure(env) {
  if (!env.DB || ready.has(env.DB)) return;
  // Wrapped, because an un-caught schema error here returns 1101 for every
  // payment route at once — which is exactly what happened on 17 Sep when an
  // index preceded its own columns.
  try {
    await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  } catch (err) {
    console.error('[pay] schema batch failed — continuing, routes must not 500 on it', err?.message ?? err);
  }
  for (const sql of PAYMENT_ALTERS) {
    await env.DB.prepare(sql).run().catch((e) => {
      const m = String(e?.message ?? e);
      if (!/duplicate column/i.test(m)) console.warn('[pay] ensure', m);
    });
  }
  // Only now that the columns exist.
  for (const sql of PAYMENT_INDEXES) {
    await env.DB.prepare(sql).run().catch((e) => console.warn('[pay] ensure index', e?.message ?? e));
  }
  // Backfill what the ref already tells us, so the history is complete rather
  // than starting today. Safe to re-run: it only fills nulls.
  await env.DB.prepare(
    `UPDATE num_payments SET owner_kind='member', owner_id=member_id
      WHERE owner_kind IS NULL AND member_id IS NOT NULL
        AND (ref IS NULL OR ref NOT LIKE 'biztier:%' AND ref NOT LIKE 'hosttier:%')`,
  ).run().catch(() => {});
  await env.DB.prepare(
    "UPDATE num_payments SET owner_kind='biz', owner_id=member_id WHERE owner_kind IS NULL AND ref LIKE 'biztier:%'",
  ).run().catch(() => {});
  await env.DB.prepare(
    "UPDATE num_payments SET owner_kind='host', owner_id=member_id WHERE owner_kind IS NULL AND ref LIKE 'hosttier:%'",
  ).run().catch(() => {});
  ready.add(env.DB);
}

/**
 * Produce something the traveller can pay with.
 *
 * Returns a URL either way, so every caller has one code path whether this is
 * a hand-made link or a real session. The difference is visible in `mode` for
 * anyone who needs to care — the confirmation copy does, because a fixed link
 * cannot promise the amount matches the booking.
 */
export async function requestPayment(env, { memberId, amountCents, currency = 'usd', description, ref, link, successUrl, cancelUrl }) {
  await ensure(env);
  const mode = payMode(env);
  const id = `pay_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

  if (mode === 'none') {
    return { ok: false, mode, error: 'No payment method is connected yet.' };
  }

  if (mode === 'links') {
    const table = links(env);
    const url = table[link ?? 'default'] ?? Object.values(table)[0];
    if (!url) return { ok: false, mode, error: 'No matching payment link is configured.' };
    await env.DB?.prepare(
      `INSERT INTO num_payments (id, member_id, mode, ref, amount_cents, currency, description, url, owner_kind, owner_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
    ).bind(id, clip(memberId, 40), 'links', clip(ref, 60), amountCents ?? null, currency, clip(description, 200), url,
      memberId ? 'member' : null, clip(memberId, 40)).run().catch(() => {});
    return {
      ok: true,
      mode,
      url,
      id,
      // Said plainly because it is true and the copy downstream depends on it:
      // a hand-made link has a price baked in at creation.
      note: 'This is a fixed payment link — check the amount on the Stripe page matches what was quoted.',
    };
  }

  const amount = Math.round(Number(amountCents));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, mode, error: 'A positive amount is required.' };

  const origin = env.NUM_APP_ORIGIN || 'https://app.itsnum.com';
  const session = await stripe(
    env,
    '/checkout/sessions',
    {
      mode: 'payment',
      success_url: successUrl || `${origin}/?paid=${id}`,
      cancel_url: cancelUrl || `${origin}/?app`,
      client_reference_id: id,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: amount,
            product_data: { name: clip(description, 120) || 'Num booking' },
          },
        },
      ],
      // The reference travels with the money, so a webhook or a dashboard row
      // can be tied back to the thing it paid for without a spreadsheet.
      metadata: { num_payment_id: id, ...(ref ? { num_ref: ref } : {}), ...(memberId ? { num_member: memberId } : {}) },
      // AND on the payment intent. Stripe does NOT copy session metadata to
      // the intent or the charge — so without this, charge.refunded arrives
      // carrying nothing, the refund handler reads undefined, and the whole
      // reclaim path is dead code. Found in self-review, not by a refund —
      // which is the only acceptable way to find it.
      payment_intent_data: {
        metadata: { num_payment_id: id, ...(ref ? { num_ref: ref } : {}), ...(memberId ? { num_member: memberId } : {}) },
      },
    },
    id,
  );

  await env.DB?.prepare(
    `INSERT INTO num_payments (id, member_id, mode, ref, amount_cents, currency, description, session_id, url, owner_kind, owner_id)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
  ).bind(id, clip(memberId, 40), 'stripe', clip(ref, 60), amount, currency, clip(description, 200), session.id, session.url,
    memberId ? 'member' : null, clip(memberId, 40)).run().catch(() => {});

  return { ok: true, mode, url: session.url, id, session_id: session.id, amount_cents: amount, currency };
}

/**
 * A RECURRING checkout — Stripe owns the schedule from here.
 *
 * Differences from requestPayment that matter:
 *   - mode 'subscription' with an inline recurring price. No Product to
 *     pre-create in the dashboard; the price is stated here, by us, in USD.
 *   - metadata rides on BOTH the session and the subscription itself
 *     (subscription_data.metadata) — invoices reference the subscription, so
 *     without that copy every later invoice.paid would arrive anonymous.
 *   - payment_intent_data is NOT sent: Stripe rejects it in subscription
 *     mode; the subscription carries the metadata instead.
 */
export async function requestSubscription(env, { memberId, businessId, hostId, amountCents, name, ref, successUrl, cancelUrl, currency = 'usd' }) {
  await ensure(env);
  const mode = payMode(env);
  if (mode !== 'stripe') {
    return { ok: false, mode, error: 'Subscriptions need the Stripe key — a fixed link cannot recur.' };
  }
  const amount = Math.round(Number(amountCents));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, mode, error: 'A positive amount is required.' };

  // A business subscription (worker/bizbilling.mjs) reuses this exact function
  // rather than a second copy of it — same reasoning as pay.mjs's own header:
  // one recurring-checkout implementation, not one per owner type. The two
  // owner kinds are told apart by WHICH metadata key carries the id
  // (num_member vs num_business), never by both at once, so the webhook can
  // never mistake a business for a member — the notify-a-member push below
  // only ever fires on num_member, and a business subscription never sets it.
  // A VIP host (worker/hostmoney.mjs) is the third owner kind, keyed on
  // num_host and priced in GBP. Same rule: exactly one metadata key.
  const ownerId = hostId || businessId || memberId || null;
  const ownerMetaKey = hostId ? 'num_host' : businessId ? 'num_business' : 'num_member';
  const cur = /^[a-z]{3}$/i.test(String(currency)) ? String(currency).toLowerCase() : 'usd';

  const id = `pay_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const origin = env.NUM_APP_ORIGIN || 'https://app.itsnum.com';
  const session = await stripe(
    env,
    '/checkout/sessions',
    {
      mode: 'subscription',
      success_url: successUrl || `${origin}/?paid=${id}`,
      cancel_url: cancelUrl || `${origin}/?app`,
      client_reference_id: id,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: cur,
            unit_amount: amount,
            recurring: { interval: 'month' },
            product_data: { name: clip(name, 120) || 'Num membership' },
          },
        },
      ],
      metadata: { num_payment_id: id, ...(ref ? { num_ref: ref } : {}), ...(ownerId ? { [ownerMetaKey]: ownerId } : {}) },
      subscription_data: {
        metadata: { num_payment_id: id, ...(ref ? { num_ref: ref } : {}), ...(ownerId ? { [ownerMetaKey]: ownerId } : {}) },
      },
    },
    id,
  );

  await env.DB?.prepare(
    `INSERT INTO num_payments (id, member_id, mode, ref, amount_cents, currency, description, session_id, url, owner_kind, owner_id)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
    // member_id gets the member and NOBODY ELSE. It used to get `ownerId`,
    // which meant a business subscription filed a biz_… id in a column named
    // member_id. The owner columns carry the truth for all three kinds.
  ).bind(id, memberId ? clip(memberId, 40) : null, 'stripe-sub', clip(ref, 60), amount, cur, clip(name, 200), session.id, session.url,
    hostId ? 'host' : businessId ? 'biz' : 'member', clip(ownerId, 40)).run().catch(() => {});

  return { ok: true, mode, url: session.url, id, session_id: session.id, amount_cents: amount, currency: cur };
}

/**
 * Stop a subscription AT PERIOD END. Never immediately: the member paid for
 * the month and keeps the month. Access ends when the paid time does, which
 * is also why this needs no membership write here — with no further
 * invoice.paid, renews_at simply expires on its own schedule.
 */
/**
 * The receipt, sent once a grant has actually succeeded.
 *
 * Deliberately AFTER the grant and conditional on it: an email saying "you're
 * on Pro" that arrives when the grant failed is worse than no email, because
 * the person then argues with a dashboard that disagrees with their inbox.
 *
 * The currency is read off the Stripe session rather than re-derived from the
 * buyer's country, because the session is what actually charged them — if a
 * VPN or a travelling card made those two differ, the receipt must match the
 * statement.
 */
async function receipt(env, session, ownerKind, tier, renewsAt) {
  const { sendPlanMail, payerEmail } = await import('./planmail.mjs');
  return sendPlanMail(env, 'plan_receipt', {
    to: payerEmail(session),
    ownerKind,
    tier,
    currency: String(session?.currency ?? 'usd').toUpperCase(),
    renewsAt,
  });
}

/**
 * Which ladder a Stripe subscription id belongs to, and at what tier.
 *
 * A sub id belongs to exactly one of the three tables — the same assumption
 * invoice.paid already makes when it tries member, then business, then host.
 * Returns nulls rather than throwing: an email with a generic plan name is
 * still worth sending, and a failed renewal must not fail on a lookup.
 */
async function ownerOfSub(env, subId) {
  if (!env?.DB || !subId) return { kind: null, tier: null };
  try {
    const m = await env.DB.prepare('SELECT tier FROM num_memberships WHERE stripe_sub=?1').bind(subId).first().catch(() => null);
    if (m?.tier) return { kind: 'member', tier: m.tier };
    const b = await env.DB.prepare('SELECT tier FROM num_business_subscriptions WHERE stripe_sub=?1').bind(subId).first().catch(() => null);
    if (b?.tier) return { kind: 'biz', tier: b.tier };
    const h = await env.DB.prepare('SELECT tier FROM num_hosts WHERE plan_sub_id=?1').bind(subId).first().catch(() => null);
    if (h?.tier) return { kind: 'host', tier: h.tier };
  } catch (err) {
    console.warn('[pay] could not identify the owner of', subId, err?.message ?? err);
  }
  return { kind: null, tier: null };
}

/**
 * Every charge NUM has taken from one owner, newest first.
 *
 * ── WHY THIS IS A FUNCTION AND NOT THREE QUERIES ─────────────────────────
 *
 * A business, a host and a traveller all want the same sentence — "what have
 * I paid you, and did it go through" — and before 17 Sep none of them could
 * get it anywhere. The only queries over num_payments in the estate were in
 * worker/console.mjs, which is the ADMIN console: 5arz staff could see every
 * payment in the system and the person who made one could see nothing.
 *
 * The Stripe billing portal shows invoices, but only for a business that has
 * a Stripe customer, only after it has been charged, and only in Stripe's
 * words. This is NUM's own record, which is what "a history in the profile"
 * has to mean.
 *
 * `state` is returned verbatim rather than prettified. A row that says
 * `created` is a checkout somebody started and never finished — which is a
 * true and useful thing to show, and 10 of the 11 payments in the table on
 * the day this was written were exactly that.
 */
export async function paymentHistory(env, ownerKind, ownerId, limit = 50) {
  if (!env?.DB || !ownerKind || !ownerId) return { ok: false, payments: [] };
  // A history is an extra on a page whose real job is something else — the
  // host's plan, the business's dashboard. If it cannot be read, the page
  // still renders and simply shows nothing, the same rule the receipt and
  // the revenue hook follow. Throwing here would 500 a plan page over a
  // missing column.
  try {
    await ensure(env);
  } catch (err) {
    console.warn('[pay] history unavailable:', err?.message ?? err);
    return { ok: false, payments: [] };
  }
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { results } = await env.DB.prepare(
    `SELECT id, ref, amount_cents, currency, description, state, mode, created_at, paid_at
       FROM num_payments
      WHERE owner_kind = ?1 AND owner_id = ?2
      ORDER BY created_at DESC
      LIMIT ${n}`,
  ).bind(ownerKind, ownerId).all().catch(() => ({ results: [] }));

  const rows = (results ?? []).map((r) => ({
    ...r,
    // The amount as the payer saw it, from the same formatter the checkout
    // page and the receipt use. A history that renders ฿349 as "349" or,
    // worse, "$349" is the bug this whole day has been about.
    display: r.amount_cents == null ? null : formatPrice(r.amount_cents, String(r.currency ?? 'usd').toUpperCase()),
  }));
  const paid = rows.filter((r) => r.state === 'paid');
  return {
    ok: true,
    payments: rows,
    // Totals per currency, never summed across them — adding baht to dollars
    // is how a number becomes a lie.
    paid_total: paid.reduce((acc, r) => {
      const cur = String(r.currency ?? 'usd').toLowerCase();
      acc[cur] = (acc[cur] ?? 0) + Number(r.amount_cents ?? 0);
      return acc;
    }, {}),
    count: rows.length,
  };
}

/**
 * Stripe's own billing page, for one customer.
 *
 * ── WHY THIS IS THE LAST PIECE, NOT THE FIRST ────────────────────────────
 *
 * There was no portal anywhere in the estate. A subscriber could start a
 * plan and cancel it, and nothing in between: no invoice, no receipt history,
 * and — the one that actually loses money — no way to replace a card before
 * it expires. A card expires on a date nobody has written down, the renewal
 * fails, and a plan somebody wanted to keep ends because the product had no
 * page for the thirty seconds of work that would have saved it.
 *
 * Stripe hosts the page itself, which is the point: card numbers never touch
 * NUM, and PCI scope stays where it already is. All we do is mint a session
 * for a customer id and hand the browser over.
 *
 * The portal's contents are configured in the Stripe dashboard, not here. If
 * it opens with nothing on it, that is the dashboard's default configuration
 * and not this function.
 */
/**
 * The portal's own configuration, stated here rather than clicked.
 *
 * ── WHY THIS IS CODE ─────────────────────────────────────────────────────
 *
 * A Stripe Customer Portal opens with whatever is configured in the Stripe
 * dashboard. With nothing configured, session creation fails outright with
 * "No configuration provided" — so the Manage billing button would have led
 * to an error, and the fix would have been a click nobody could review, in a
 * console nobody versions, that a new Stripe account would need again.
 *
 * So the configuration is made from here, once, on the first portal open
 * that finds none. What it turns on is the whole reason the button exists:
 *
 *   · payment_method_update — the one that actually saves plans. A card
 *     expires on a date nobody wrote down, and without this there is no way
 *     to replace it before the renewal fails.
 *   · invoice_history — what they paid, in Stripe's own record, beside the
 *     one NUM keeps.
 *   · subscription_cancel at period end — NOT immediate. They paid for this
 *     month; taking it away the instant they click cancel is a refund we
 *     did not offer and a month they did not get.
 *   · customer_update of email and address only. Not the tax id, not the
 *     name on the account: those are identity, and identity on NUM is
 *     changed by proving it, not by typing it into Stripe.
 */
const PORTAL_CONFIG = (origin) => ({
  business_profile: {
    headline: 'NUM — your plan, your card, your invoices.',
    privacy_policy_url: 'https://itsnum.com/privacy/',
    terms_of_service_url: 'https://itsnum.com/terms/',
  },
  default_return_url: `${origin}/api/biz/console`,
  features: {
    payment_method_update: { enabled: true },
    invoice_history: { enabled: true },
    customer_update: { enabled: true, allowed_updates: ['email', 'address'] },
    subscription_cancel: {
      enabled: true,
      mode: 'at_period_end',
      cancellation_reason: {
        enabled: true,
        options: ['too_expensive', 'missing_features', 'unused', 'customer_service', 'other'],
      },
    },
  },
});

/** Stripe says a portal has no configuration in words, not in a code. */
const NEEDS_CONFIG = /no configuration provided|default configuration has not been created/i;

export async function billingPortal(env, customerId, returnUrl) {
  if (!env.STRIPE_SECRET_KEY) return { ok: false, error: 'Stripe is not connected.' };
  if (!customerId) return { ok: false, error: 'No Stripe customer for this account yet.' };
  const origin = env.NUM_APP_ORIGIN || 'https://app.itsnum.com';
  const open = () => stripe(env, '/billing_portal/sessions', {
    customer: customerId,
    return_url: returnUrl || `${origin}/api/biz/console`,
  });
  try {
    let session;
    try {
      session = await open();
    } catch (err) {
      if (!NEEDS_CONFIG.test(String(err?.message ?? ''))) throw err;
      // First portal open on this Stripe account. Make the configuration,
      // then try again exactly once — a second failure is a real failure.
      console.log('[pay] no portal configuration on this account — creating the default one');
      await stripe(env, '/billing_portal/configurations', PORTAL_CONFIG(origin));
      session = await open();
    }
    if (!session?.url) return { ok: false, error: 'Stripe returned no portal link.' };
    return { ok: true, url: session.url };
  } catch (err) {
    console.error('[pay] billing portal failed for', customerId, err?.message);
    return { ok: false, error: 'Could not open the billing page — try again in a minute.' };
  }
}

/**
 * Create or refresh the portal configuration without waiting for a customer.
 *
 * Exposed so it can be run deliberately — from the admin console, or once
 * after a Stripe account change — rather than only discovered by the first
 * business unlucky enough to click Manage billing.
 */
export async function configurePortal(env) {
  if (!env.STRIPE_SECRET_KEY) return { ok: false, error: 'Stripe is not connected.' };
  const origin = env.NUM_APP_ORIGIN || 'https://app.itsnum.com';
  try {
    const cfg = await stripe(env, '/billing_portal/configurations', PORTAL_CONFIG(origin));
    return { ok: true, id: cfg?.id ?? null, active: cfg?.active ?? null, is_default: cfg?.is_default ?? null };
  } catch (err) {
    console.error('[pay] could not configure the portal', err?.message);
    return { ok: false, error: String(err?.message ?? err).slice(0, 200) };
  }
}

/**
 * End a subscription NOW, not at the end of its period.
 *
 * cancelSubscription() below sets cancel_at_period_end, which is right when a
 * customer chooses to stop: they paid for this month and they keep it. It is
 * WRONG when someone switches plan, because they are already paying for the
 * new one — leaving the old subscription to run means two live subscriptions
 * and two charges, of which our own table tracked exactly one.
 *
 * Stripe ends a subscription immediately on DELETE, which is why stripe()
 * above now takes a method.
 */
export async function endSubscriptionNow(env, subId) {
  if (!env.STRIPE_SECRET_KEY || !subId) return { ok: false, error: 'nothing to end' };
  try {
    await stripe(env, `/subscriptions/${encodeURIComponent(subId)}`, {}, null, 'DELETE');
    console.log('[pay] previous subscription', subId, 'ended immediately — plan switched');
    return { ok: true };
  } catch (err) {
    // Already gone is a success for our purposes: the goal is "not billing".
    if (err?.status === 404) return { ok: true, note: 'already gone' };
    // Loud, because the failure mode is a customer being charged twice.
    console.error('[pay] COULD NOT END PREVIOUS SUBSCRIPTION', subId, '— this owner may now hold two live subscriptions.', err?.message);
    return { ok: false, error: err?.message ?? 'stripe refused' };
  }
}

export async function cancelSubscription(env, subId) {
  if (!env.STRIPE_SECRET_KEY) return { ok: false, error: 'Stripe is not connected.' };
  try {
    await stripe(env, `/subscriptions/${encodeURIComponent(subId)}`, { cancel_at_period_end: true });
    return { ok: true };
  } catch (err) {
    console.error('[pay] cancel failed for', subId, err?.message);
    return { ok: false, error: 'Stripe refused the cancellation — try again, or we’ll do it by hand.' };
  }
}

// ── Stripe webhook — "paid" is something Stripe signs, not a button press ──
//
// §8 of the CTO handoff: every webhook verifies a signature. Stripe signs
// `t.payload` with the endpoint secret (HMAC-SHA256, hex, in the
// Stripe-Signature header). No secret configured means no webhook — we would
// rather not know than believe a forgery.
// Exported for billpay.mjs, whose Connect endpoint carries its own signing
// secret (Stripe signs "events on connected accounts" with a separate key).
export async function verifyStripeSig(env, payload, header, secret = env.STRIPE_WEBHOOK_SECRET) {
  if (!secret || !header) return false;
  const parts = header.split(',').map((p) => p.split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // replay window
  const enc = (s) => new TextEncoder().encode(s);
  const key = await crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return sigs.includes(hex);
}

// ── routes ────────────────────────────────────────────────────────────────

export async function handlePay(request, env, path) {
  const post = request.method === 'POST';

  if (path === '/webhook' && post) {
    const payload = await request.text();
    const ok = await verifyStripeSig(env, payload, request.headers.get('Stripe-Signature'));
    if (!ok) {
      console.warn('[pay] webhook rejected — bad or missing signature');
      return json({ error: 'bad signature' }, 400);
    }
    let event = {};
    try { event = JSON.parse(payload); } catch { return json({ error: 'bad payload' }, 400); }
    if (event.type === 'checkout.session.completed') {
      const s = event.data?.object ?? {};
      // `completed` is not `paid`. Async methods (bank debits, vouchers) fire
      // this event while the money is still in flight and can still fail —
      // crediting on the event alone hands out Stars for a payment that may
      // never land.
      if (s.payment_status && s.payment_status !== 'paid') {
        console.warn('[pay] session completed but not paid:', s.payment_status);
        return json({ received: true, ignored: 'unpaid' });
      }
      const id = s.client_reference_id || s.metadata?.num_payment_id;
      if (id) {
        await ensure(env);
        // Idempotent by construction: only a row still in 'created' flips, so
        // Stripe's at-least-once delivery can't credit the same purchase twice.
        const flip = await env.DB?.prepare(
          "UPDATE num_payments SET state='paid', paid_at=datetime('now') WHERE id=?1 AND state<>'paid'",
        ).bind(id).run().catch(() => null);
        const firstTime = (flip?.meta?.changes ?? 0) > 0;
        const memberId = s.metadata?.num_member;

        // DELIVER WHAT WAS BOUGHT. Without this a Stars purchase takes the
        // money and hands over nothing — the reason /request refuses Stars
        // until STARS_SALE_OK is set AND this path exists.
        const ref = s.metadata?.num_ref ?? '';

        // A membership is delivered the same way Stars are: only after Stripe
        // has signed for the money. Never from a client request.
        const tierMatch = /^tier:([a-z_]{2,20})$/.exec(ref);
        if (firstTime && tierMatch && memberId) {
          // The signature proves Stripe took money. It does NOT prove it took
          // the RIGHT money. checkPayment treats `tier:` as a generic bill
          // (any positive amount passes), so before this check a direct call
          // to /api/pay/request with ref "tier:pro" and fifty cents bought a
          // $28.98 membership — paid, signed, and wrong. The price check
          // belongs here because this is the only place that has both the
          // signed amount and the authoritative price list.
          const { grantTier, tiers } = await import('./membership.mjs');
          const { tierPaidRight } = await import('./preflight.mjs');
          const owed = tiers(env)[tierMatch[1]]?.price_cents;
          const paidRight = tierPaidRight(s, owed);
          if (!paidRight) {
            // Money was taken and the tier is withheld — that needs a human,
            // loudly, because the guest did pay SOMETHING.
            console.error(`[pay] TIER UNDERPAYMENT — ${ref} paid ${s.amount_total} ${s.currency}, price is ${owed} usd. Grant refused; refund ${id} and find out which client built this session.`);
          } else {
            // s.subscription is present only for mode:'subscription' sessions.
            // Storing it is what makes every later invoice.paid attributable —
            // a renewal that can't find its member extends nothing.
            const g = await grantTier(env, memberId, tierMatch[1], { source: 'stripe', ref: id, sub: s.subscription ?? null, customer: s.customer ?? null });
            console.log('[pay] tier', tierMatch[1], g.ok ? 'granted to' : 'FAILED for', memberId, s.subscription ? `(sub ${s.subscription})` : '(one-off)');
            if (g.ok) await receipt(env, s, 'member', tierMatch[1], g.renews_at ?? null);
          }
        }

        // A NUM for Business plan — the exact same shape as a member tier,
        // priced and verified the same way, just keyed on num_business
        // instead of num_member so the two owner kinds can never collide.
        const bizTierMatch = /^biztier:([a-z_]{2,20})$/.exec(ref);
        const businessId = s.metadata?.num_business;
        if (firstTime && bizTierMatch && businessId) {
          const { grantBizTier } = await import('./bizbilling.mjs');
          const { tierPaidRight } = await import('./preflight.mjs');
          const { priceFor } = await import('./planprice.mjs');
          // The price to check against MUST be read in the currency the
          // session was actually created in.
          //
          // Until 17 Sep every plan was 999/1999/5000 USD and this compared
          // against one number. Now worker/planprice.mjs prices each plan in
          // the buyer's own currency, so checking a correctly-paid ฿349
          // against 999 USD would read as an underpayment, refuse the grant
          // and refund a customer who did nothing wrong. Same seam on the
          // host block below. Session currency in, table lookup out.
          const bizPaidCur = String(s.currency ?? 'usd').toUpperCase();
          const owed = priceFor('biz', bizTierMatch[1], bizPaidCur);
          const paidRight = owed != null && tierPaidRight(s, owed, bizPaidCur);
          if (!paidRight) {
            console.error(`[pay] BIZ TIER UNDERPAYMENT — ${ref} paid ${s.amount_total} ${s.currency}, price is ${owed} ${bizPaidCur}. Grant refused; refund ${id} and find out which client built this session.`);
          } else {
            const g = await grantBizTier(env, businessId, bizTierMatch[1], { source: 'stripe', ref: id, sub: s.subscription ?? null, customer: s.customer ?? null });
            if (g.ok) await receipt(env, s, 'biz', bizTierMatch[1], g.renews_at ?? null);
            console.log('[pay] biz tier', bizTierMatch[1], g.ok ? 'granted to' : 'FAILED for', businessId, s.subscription ? `(sub ${s.subscription})` : '(one-off)');

            // ── MONEY ARRIVED FROM A BUSINESS ────────────────────────────
            //
            // The event two payout programmes were waiting on and never got.
            // Until 15 Sep 2026 neither `recordRevenue` (Num Experts) nor
            // `creditBizReferral` (member referrals) had a single caller, so
            // both were complete, tested and unreachable — which looks exactly
            // like working code until somebody asks where their money is.
            //
            // Keyed on the Stripe session id, so a retried webhook records
            // nothing the second time. See bizrevenue.mjs.
            try {
              const { businessEarned } = await import('./bizrevenue.mjs');
              const earned = await businessEarned(env, {
                businessId,
                amountMinor: s.amount_total,
                currency: s.currency ?? 'usd',
                source: 'biztier',
                ref: id,
              });
              if (earned.scout?.activated) {
                console.log('[pay] num expert activated on', businessId, '— finder fee released');
              }
            } catch (err) {
              // A payout programme must never fail a payment webhook: a throw
              // here makes Stripe retry the charge handling forever.
              console.error('[pay] business revenue hook failed', err);
            }
          }
        }

        // A VIP host plan — third owner kind, keyed on num_host, priced in
        // the buyer's currency since 17 Sep.
        // worker/hostmoney.mjs owns the prices and the grant.
        const hostTierMatch = /^hosttier:([a-z_]{2,20})$/.exec(ref);
        const hostId = s.metadata?.num_host;
        if (firstTime && hostTierMatch && hostId) {
          const { grantHostTier } = await import('./hostmoney.mjs');
          const { tierPaidRight } = await import('./preflight.mjs');
          const { priceFor } = await import('./planprice.mjs');
          // Same rule as the business block above: the host ladder is no
          // longer GBP-only, so the owed price is looked up in the currency
          // the buyer actually paid in, not in HOST_CURRENCY.
          const hostPaidCur = String(s.currency ?? 'gbp').toUpperCase();
          const owed = priceFor('host', hostTierMatch[1], hostPaidCur);
          if (owed == null || !tierPaidRight(s, owed, hostPaidCur)) {
            console.error(`[pay] HOST TIER UNDERPAYMENT — ${ref} paid ${s.amount_total} ${s.currency}, price is ${owed} ${hostPaidCur}. Grant refused; refund ${id}.`);
          } else {
            const g = await grantHostTier(env, hostId, hostTierMatch[1], { ref: id, sub: s.subscription ?? null, customer: s.customer ?? null });
            if (g.ok) await receipt(env, s, 'host', hostTierMatch[1], null);
            console.log('[pay] host tier', hostTierMatch[1], g.ok ? 'granted to' : 'FAILED for', hostId);
          }
        }

        const packMatch = /^stars:(\d{1,7})$/.exec(ref);
        if (firstTime && packMatch && memberId && env.STARS_SALE_OK === '1') {
          const n = Number(packMatch[1]);
          // VERIFY THE MONEY, exactly as the three tier branches above do.
          //
          // This branch read the pack size out of the ref and credited it,
          // and nothing here checked what was actually paid. preflight.mjs
          // does price `stars:` refs at request time, which is why it has
          // held — but that is one layer, and the tier branches learned the
          // hard way (see the note above them: ref "tier:pro" and fifty
          // cents bought a $28.98 membership) that the request layer is not
          // the one holding the money. Now that packs are priced in five
          // currencies there are five more ways for the two to disagree.
          //
          // Same rule as everywhere else: the price is looked up in the
          // currency the session actually charged.
          const { starPackPrice } = await import('./planprice.mjs');
          const { tierPaidRight } = await import('./preflight.mjs');
          const paidCur = String(s.currency ?? 'usd').toUpperCase();
          const owedStars = starPackPrice(n, paidCur);
          const starsPaidRight = owedStars != null && tierPaidRight(s, owedStars, paidCur);
          if (!starsPaidRight) {
            // Refuse the credit, but do NOT return: the rest of this event
            // still has work to do, and an early return here would also
            // swallow the member notification below. Loud, because money was
            // taken and Stars are being withheld.
            console.error(`[pay] STAR PACK UNDERPAYMENT — ${ref} paid ${s.amount_total} ${s.currency}, price is ${owedStars} ${paidCur}. Nothing credited; refund ${id}.`);
            await alert(env, `[pay] star pack underpayment on ${id} — ${ref} paid ${s.amount_total} ${s.currency}`).catch(() => {});
          }
          if (starsPaidRight) {
          await env.DB?.prepare('INSERT OR IGNORE INTO num_star_balances (member_id, stars) VALUES (?1, 0)').bind(memberId).run().catch(() => {});
          await env.DB?.prepare('UPDATE num_star_balances SET stars = stars + ?2 WHERE member_id = ?1').bind(memberId, n).run().catch(() => {});
          // num_star_moves — the SAME table every other Star movement uses.
          //
          // This wrote to a `num_star_ledger` that nothing else reads: errands,
          // social, cash-out, the console and the wallet history all read
          // num_star_moves. So a purchase left the balance correct and the
          // history blank — the one Star event a person actually paid for was
          // the one they couldn't see, and it was missing from the audit trail
          // too.
          //
          // Kind stays 'purchase', which is deliberately NOT in cashout's
          // EARNED_KINDS. Bought Stars were already un-cashable, but only by
          // accident of being in a table nobody read. Now it's on purpose.
          await env.DB?.prepare(
            "INSERT INTO num_star_moves (id, member_id, delta, kind, note, counterparty) VALUES (?1,?2,?3,'purchase',?4,NULL)",
          ).bind(`sm_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`, memberId, n, `Stripe ${id}`).run().catch((e) => console.warn('[pay] moves', e?.message));
          console.log('[pay] credited', n, 'stars to', memberId, 'for', id);
          }
        }

        if (memberId) {
          const { notify } = await import('./push.mjs');
          await notify(env, {
            memberId,
            kind: 'pay',
            title: 'Payment received',
            body: 'Stripe confirmed it — receipt is on your wallet.',
            url: '/?app',
            tag: `pay:${id}`,
          }).catch(() => {});
        }
      }
    }

    // ── Money that comes BACK ────────────────────────────────────────────
    //
    // Only `checkout.session.completed` was handled, so every payment in the
    // system was in state 'paid' forever. A refunded Star pack left the money
    // returned, the Stars still spendable, and the wallet still showing a
    // receipt — which is both a hole and a lie to the person reading it.
    //
    // Stripe is the source of truth for money, so we take its word for these
    // and write down what happened rather than deciding anything ourselves.
    // ── The renewal lifecycle. Stripe owns the schedule; we mirror it. ──────
    //
    // invoice.paid is the ONLY event that extends a membership, and
    // customer.subscription.deleted is the ONLY event that ends one early.
    // A failed renewal does neither: Stripe retries for days, the 3-day grace
    // in renewsFrom() covers the gap, and whichever side wins — the retry or
    // the cancellation — arrives here as one of these two events.
    if (event.type === 'invoice.paid') {
      const inv = event.data?.object ?? {};
      const subId = inv.subscription || inv.parent?.subscription_details?.subscription;
      if (subId) {
        const periodEnd = inv.lines?.data?.[0]?.period?.end ?? null;
        const { recordRenewal } = await import('./membership.mjs');
        const r = await recordRenewal(env, subId, periodEnd);
        if (r.ok) {
          console.log('[pay] renewal', subId, `extended to ${r.renews_at}`);
        } else {
          // Not a member subscription — a sub id belongs to exactly one of
          // the two tables, so try the business side before giving up.
          const { recordBizRenewal } = await import('./bizbilling.mjs');
          const rb = await recordBizRenewal(env, subId, periodEnd);
          if (rb.ok) console.log('[pay] renewal', subId, `extended (business) to ${rb.renews_at}`);
          else {
            const { recordHostRenewal } = await import('./hostmoney.mjs');
            const rh = await recordHostRenewal(env, subId, periodEnd);
            console.log('[pay] renewal', subId, rh.ok ? `extended (host) to ${rh.renews_at}` : 'MATCHED NO MEMBER, BUSINESS OR HOST');
          }
        }
      }
      return json({ received: true });
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data?.object ?? {};
      let endedKind = null;
      const { lapseBySub } = await import('./membership.mjs');
      const r = await lapseBySub(env, sub.id);
      if (r.ok) {
        console.log('[pay] subscription ended', sub.id, '— membership lapsed');
        endedKind = 'member';
      } else {
        const { lapseBizBySub } = await import('./bizbilling.mjs');
        const rb = await lapseBizBySub(env, sub.id);
        if (rb.ok) { console.log('[pay] subscription ended', sub.id, '— business plan lapsed'); endedKind = 'biz'; }
        else {
          const { lapseHostBySub } = await import('./hostmoney.mjs');
          const rh = await lapseHostBySub(env, sub.id);
          console.log('[pay] subscription ended', sub.id, rh.ok ? '— host plan lapsed' : '— no membership, business or host plan held it');
          if (rh.ok) endedKind = 'host';
        }
      }
      // Stripe puts the payer's address on the subscription's customer, not on
      // the subscription, so this is best-effort: no address, no email, and
      // the lapse itself is unaffected.
      if (endedKind) {
        const { sendPlanMail } = await import('./planmail.mjs');
        await sendPlanMail(env, 'plan_ended', {
          to: sub.customer_email ?? sub.metadata?.num_email ?? null,
          ownerKind: endedKind,
          tier: null,
          currency: String(sub.currency ?? 'usd').toUpperCase(),
        });
      }
      return json({ received: true });
    }

    /**
     * customer.subscription.updated — the event nothing handled.
     *
     * Everything that happens to a subscription on Stripe's side arrives
     * here: a plan changed in the dashboard, a proration, a card entering
     * `past_due`, a cancellation scheduled for the end of the period. None of
     * it reached D1, so our tables described the subscription as it was on the
     * day it was created and disagreed with Stripe quietly from then on.
     *
     * Deliberately NARROW. It moves two facts and no more:
     *
     *   · the period end, so `renews_at` matches what Stripe will actually
     *     charge and the 3-day grace keeps meaning what it means
     *   · a subscription set to cancel at period end, which is recorded so a
     *     console can say "ends on the 14th" instead of "renews on the 14th"
     *
     * It does NOT re-grant or change a tier from this event. A tier is
     * granted only after a signed payment of the right amount — that is the
     * rule the whole webhook is built on — and an `updated` event carries no
     * payment. A plan genuinely changed on Stripe's side arrives as an
     * invoice too, and the invoice is what moves money.
     */
    if (event.type === 'customer.subscription.updated') {
      const sub = event.data?.object ?? {};
      const periodEnd = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
      const ending = sub.cancel_at_period_end === true;
      if (sub.id && periodEnd) {
        const { recordRenewal } = await import('./membership.mjs');
        const r = await recordRenewal(env, sub.id, periodEnd);
        if (!r.ok) {
          const { recordBizRenewal } = await import('./bizbilling.mjs');
          const rb = await recordBizRenewal(env, sub.id, periodEnd);
          if (!rb.ok) {
            const { recordHostRenewal } = await import('./hostmoney.mjs');
            await recordHostRenewal(env, sub.id, periodEnd).catch(() => ({ ok: false }));
          }
        }
      }
      console.log('[pay] subscription updated', sub.id ?? '?', ending ? '— set to end at period end' : '— period moved', sub.status ?? '');
      return json({ received: true });
    }

    if (event.type === 'invoice.payment_failed') {
      const inv = event.data?.object ?? {};
      // Log and alert, change nothing: the grace period holds the tier while
      // Stripe retries. Lapsing here would punish a bank hiccup with an
      // instant downgrade that un-downgrades two days later.
      console.warn('[pay] renewal payment failed for', inv.subscription ?? 'unknown sub', '— Stripe will retry; grace covers it');
      await alert(env, `[pay] renewal failed: ${inv.subscription ?? '?'} (${inv.customer_email ?? 'no email'})`).catch(() => {});
      // This handler has always HAD the customer's address and spent it on a
      // console line. Stripe retries for a few days, so this message is the
      // window in which a person can fix a card before the plan lapses —
      // which makes it the single most valuable email in this file.
      {
        const { sendPlanMail } = await import('./planmail.mjs');
        const owner = await ownerOfSub(env, inv.subscription);
        await sendPlanMail(env, 'plan_renewal_failed', {
          to: inv.customer_email,
          ownerKind: owner.kind,
          tier: owner.tier,
          currency: String(inv.currency ?? 'usd').toUpperCase(),
          priceOverride: Number.isFinite(Number(inv.amount_due)) ? Number(inv.amount_due) : null,
        });
      }
      return json({ received: true });
    }

    if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
      const c = event.data?.object ?? {};
      const disputed = event.type === 'charge.dispute.created';
      const state = disputed ? 'disputed' : 'refunded';

      // ── WHY THIS IS NOT JUST `c.metadata.num_payment_id` ──────────────
      //
      // On `charge.dispute.created` the object is a DISPUTE, not a charge.
      // A dispute carries its own metadata — which is empty — plus
      // `payment_intent` and `charge` pointers. So reading metadata alone
      // resolved every dispute to "unknown payment", logged a useless alert,
      // and left the ledger row saying the money was still ours.
      //
      // Flights make this worse: they are PaymentIntents created directly,
      // never Checkout Sessions, so `num_payment_id` only reaches us on the
      // intent. Hence the second lookup — by intent id, against the
      // session_id column where flightpay records it.
      let id = c.metadata?.num_payment_id;
      let memberId = c.metadata?.num_member;
      let ref = c.metadata?.num_ref ?? '';
      const intentId = typeof c.payment_intent === 'string' ? c.payment_intent : c.payment_intent?.id;
      if (!id && intentId) {
        await ensure(env);
        const row = await env.DB?.prepare(
          'SELECT id, member_id, ref FROM num_payments WHERE session_id = ?1 LIMIT 1',
        ).bind(intentId).first().catch(() => null);
        if (row) {
          id = row.id;
          memberId = memberId ?? row.member_id;
          ref = ref || (row.ref ?? '');
          console.log(`[pay] ${state} resolved ${id} from intent ${intentId}`);
        } else {
          console.error(`[pay] ${state} for intent ${intentId} matches no payment row — money moved and nothing recorded it`);
        }
      }

      if (id) {
        await ensure(env);
        // Same idempotence shape as the credit: only a row not already in this
        // state flips, so Stripe's at-least-once delivery can't claw back the
        // same Stars twice.
        const flip = await env.DB?.prepare(
          'UPDATE num_payments SET state=?2 WHERE id=?1 AND state<>?2',
        ).bind(id, state).run().catch(() => null);
        const firstTime = (flip?.meta?.changes ?? 0) > 0;

        const packMatch = /^stars:(\d{1,7})$/.exec(ref);
        if (firstTime && packMatch && memberId) {
          const n = Number(packMatch[1]);
          // Take back what was bought. The balance is allowed to go negative
          // rather than clamping at zero: if someone spent refunded Stars we
          // need to SEE that, not quietly absorb it. A negative balance is a
          // thing a human should look at; a silently-adjusted one is a thing
          // nobody ever finds.
          await env.DB?.prepare('UPDATE num_star_balances SET stars = stars - ?2 WHERE member_id = ?1')
            .bind(memberId, n).run().catch(() => {});
          await env.DB?.prepare(
            "INSERT INTO num_star_moves (id, member_id, delta, kind, note, counterparty) VALUES (?1,?2,?3,'refund',?4,NULL)",
          ).bind(`sm_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`, memberId, -n, `${state} ${id}`)
            .run().catch((e) => console.warn('[pay] refund move', e?.message));
          console.warn('[pay]', state, '— reclaimed', n, 'stars from', memberId, 'for', id);
        }

        // A membership that was refunded should stop being a membership.
        const tierMatch = /^tier:([a-z_]{2,20})$/.exec(ref);
        if (firstTime && tierMatch && memberId) {
          await env.DB?.prepare("UPDATE num_memberships SET tier='free', renews_at=NULL WHERE member_id=?1")
            .bind(memberId).run().catch(() => {});
          console.warn('[pay]', state, '— membership revoked for', memberId);
        }
      }
      // Worth a human's attention either way — a dispute especially.
      await alert(env, `[pay] ${state}: ${id ?? 'unknown payment'} ${ref}`).catch(() => {});
    }

    // A payment that failed should say so, not sit in 'created' looking like
    // something still in flight.
    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data?.object ?? {};
      const id = pi.metadata?.num_payment_id;
      if (id) {
        await ensure(env);
        await env.DB?.prepare("UPDATE num_payments SET state='failed' WHERE id=?1 AND state='created'")
          .bind(id).run().catch(() => {});
      }
    }

    return json({ received: true });
  }

  /**
   * Make (or refresh) the Stripe Customer Portal configuration.
   *
   * Admin-gated and deliberately manual. billingPortal() creates the config
   * on its own the first time a portal is opened without one, but discovering
   * your billing page for the first time through a customer's click is not a
   * plan. This is the button that does it on purpose.
   */
  if (path === '/portal-config' && request.method === 'POST') {
    const { adminGuard } = await import('./adminkey.mjs');
    const denied = adminGuard(request, env);
    if (denied) return denied;
    const out = await configurePortal(env);
    return json(out, out.ok ? 200 : 502);
  }

  if (path === '/status' || path === '/' || path === '') {
    const mode = payMode(env);
    return json({
      mode,
      can_take_payment: mode !== 'none',
      // TEST or LIVE — the difference between taking money and rehearsing it.
      //
      // `can_take_payment: true` only means a Stripe key is present. With a
      // test key every step still works: a session mints, Checkout renders,
      // the webhook fires, Stars land, the member is delighted — and not one
      // real cent moves. There is no error anywhere to notice, which makes it
      // exactly the failure this codebase keeps producing: a system reporting
      // success while doing nothing. Twilio's wrong SID hid the same way for
      // the product's entire life until its shape was surfaced.
      //
      // Derived from the key prefix, which is not a secret — `sk_test_` vs
      // `sk_live_` is published in Stripe's own docs. The key itself is never
      // read, logged or returned.
      // RESTRICTED KEYS COUNT. On 17 Sep this reported
      // "unrecognised-key-prefix" on production while the key was working
      // perfectly — a staged version minted a real cs_live_ Checkout Session
      // with it. The key is an `rk_live_` restricted key, which Stripe issues
      // for exactly the scoping this worker wants, and only sk_ prefixes were
      // recognised here.
      //
      // That is this field's own failure mode inverted: it exists to stop a
      // system "reporting success while doing nothing", and it was reporting
      // trouble while everything worked. A monitor that cries wolf gets
      // ignored on the day it is right.
      stripe_mode: env.STRIPE_SECRET_KEY
        ? (/^(sk|rk)_live_/.test(String(env.STRIPE_SECRET_KEY)) ? 'live'
          : /^(sk|rk)_test_/.test(String(env.STRIPE_SECRET_KEY)) ? 'test'
          : 'unrecognised-key-prefix')
        : null,
      // A webhook secret is not optional decoration: without it every "paid"
      // event is refused, so checkout completes and nothing is ever granted.
      webhook_configured: !!env.STRIPE_WEBHOOK_SECRET,
      // Stars-for-cash is a licensing decision, not a feature flag — §8:
      // "Never sell Stars." It stays refused until Duke sets STARS_SALE_OK=1
      // on the record. Bills, tabs, bookings and bounties are unaffected.
      // The iOS app sells nothing digital (storefront.mjs). Answering it with
      // `stars_sale: false` and no packs means even a stale build renders no
      // price to tap.
      stars_sale: env.STARS_SALE_OK === '1' && !isIosApp(request),
      stars: starPolicy(env),
      // The packs, priced HERE. The wallet used to carry its own copy of these
      // numbers, which is the $1-for-★5,000 hole in a different shirt: two
      // sources of truth for a price, and the client's is the one an attacker
      // controls. The client displays what this returns and nothing else.
      packs: isIosApp(request) ? [] : Object.entries(STAR_PACKS).map(([stars, cents]) => ({
        stars: Number(stars),
        cents,
        price: `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`,
      })),
      apple_pay: mode === 'stripe' ? 'shown automatically in Stripe Checkout on Apple devices' : 'arrives with the Stripe key',
      configured_links: Object.keys(links(env)),
      note:
        mode === 'stripe'
          ? 'Checkout sessions are minted per request for the exact amount.'
          : mode === 'links'
            ? 'Using fixed payment links. Amounts are set when the link is made, not per booking.'
            : 'Nothing connected. Set STRIPE_SECRET_KEY for real checkout, or PAY_LINKS for hand-made links.',
      // Stated on the status endpoint so it is impossible to miss.
      card_handling: 'Num never sees a card number. Payment happens on Stripe’s own hosted page.',
    });
  }

  if (path === '/request' && post) {
    const b = await readBody(request);

    // App Review 3.1.1, 21 Sep 2026: Stars and plans are digital content and
    // the iOS app may not sell them outside IAP. Refused here whatever the
    // client shows — see storefront.mjs. Bills, tabs and bookings pass.
    if (isIosApp(request) && isDigitalSaleRef(b?.ref)) return json({ ...IOS_NO_SALE, mode: payMode(env) }, 403);

    // EVERY payment is checked before it exists. The verdict recomputes the
    // amount from our own price list, so a client number is a claim to be
    // checked rather than an input to trust — and a wrong one comes back with
    // the corrected transaction attached instead of a bare refusal.
    const verdict = checkPayment(b);
    if (!verdict.ok) return json({ ...refusal(verdict), mode: payMode(env) }, 400);
    b.amount_cents = verdict.amount_cents;
    if (/^stars:/.test(String(b.ref ?? ''))) {
      b.currency = 'usd';
      b.description = `Num — ${verdict.note}`;
    }

    // Closed-loop switch. NUM Stars are credit for NUM and nothing else —
    // see CLOSED_LOOP below. Buying them is therefore a prepaid in-app
    // balance, not a stored-value instrument that can leave the system. It
    // still waits on STARS_SALE_OK so the go/no-go stays a recorded decision.
    if (String(b.ref ?? '').startsWith('stars:') && env.STARS_SALE_OK !== '1') {
      return json({
        ok: false,
        mode: payMode(env),
        error: 'Star top-ups aren’t open yet. You can earn Stars in Num now, and any bill or booking can be paid directly.',
      }, 403);
    }
    try {
      const out = await requestPayment(env, {
        memberId: clip(b.me, 40),
        amountCents: b.amount_cents,
        // The VALIDATED currency. verdict.currency comes back from
        // checkPayment's allowlist; b.currency raw from the client was the
        // 97%-discount hole (tier priced in US cents, charged as satang).
        currency: verdict.currency ?? 'usd',
        description: clip(b.description, 200),
        ref: clip(b.ref, 60),
        link: clip(b.link, 40),
      });
      return json(out, out.ok ? 200 : 503);
    } catch (err) {
      console.error('[pay]', err?.message ?? err);
      return json({ error: err?.message ?? 'That didn’t go through.' }, err?.status ?? 500);
    }
  }

  if (path === '/history') {
    const url = new URL(request.url);
    const me = clip(url.searchParams.get('me'), 40);
    if (!me || !env.DB) return json({ payments: [] });
    await ensure(env);
    const { results } = await env.DB.prepare(
      'SELECT id, mode, ref, amount_cents, currency, description, state, created_at, paid_at FROM num_payments WHERE member_id=?1 ORDER BY rowid DESC LIMIT 25',
    ).bind(me).all();
    return json({ payments: results ?? [] });
  }

  // ── /activity — everything financial, in one list ──────────────────────
  //
  // Stars and money were two separate stories: /history returned card
  // payments, /social/stars returned Star moves, and the wallet showed
  // neither — it rendered a seeded demo array. So the one screen a person
  // opens to answer "what happened to my money?" answered with fiction.
  //
  // One feed, because that is how the question is actually asked. Nobody
  // wonders "what happened in my Stars ledger" — they wonder what they were
  // charged and what they have left.
  //
  // Server-side labelling on purpose: the client should never have to know
  // that kind 'tab' means a shared bill. If it did, two clients would drift.
  if (path === '/activity') {
    const url = new URL(request.url);
    const me = clip(url.searchParams.get('me'), 40);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 40, 1), 100);
    if (!me || !env.DB) return json({ activity: [] });
    await ensure(env);

    const [moves, pays] = await Promise.all([
      env.DB.prepare(
        `SELECT m.id, m.delta, m.kind, m.note, m.counterparty, m.created_at, p.name AS other_name
           FROM num_star_moves m
           LEFT JOIN num_members p ON p.id = m.counterparty
          WHERE m.member_id = ?1
          ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?2`,
      ).bind(me, limit).all().catch(() => ({ results: [] })),
      env.DB.prepare(
        `SELECT id, amount_cents, currency, description, state, ref, created_at, paid_at
           FROM num_payments WHERE member_id = ?1
          ORDER BY rowid DESC LIMIT ?2`,
      ).bind(me, limit).all().catch(() => ({ results: [] })),
    ]);

    // What a person would call this, not what the column says.
    const STAR_LABEL = {
      welcome: () => 'Welcome Stars',
      purchase: () => 'Bought Stars',
      refund: () => 'Refunded — Stars returned',
      pay: (r) => `Sent to ${r.other_name ?? 'someone'}`,
      receive: (r) => `From ${r.other_name ?? 'someone'}`,
      tab: (r) => r.note || 'Shared bill',
      errand: (r) => r.note || 'Errand',
      referral: () => 'Referral reward',
      bounty: (r) => r.note || 'Bounty',
      reward: (r) => r.note || 'Reward',
      cashout: () => 'Cashed out',
    };

    const activity = [
      ...(moves.results ?? []).map((r) => ({
        id: r.id,
        at: r.created_at,
        unit: 'stars',
        delta: r.delta,
        title: (STAR_LABEL[r.kind] ?? (() => r.kind))(r),
        detail: r.note && r.note !== (STAR_LABEL[r.kind]?.(r) ?? '') ? r.note : null,
        kind: r.kind,
        state: 'done',
      })),
      ...(pays.results ?? []).map((r) => ({
        id: r.id,
        at: r.paid_at || r.created_at,
        unit: r.currency || 'usd',
        // Money LEAVES you — always negative, so the sign means the same thing
        // in both halves of one list. A mixed feed where +/- flips meaning is
        // worse than two separate lists.
        delta: -Math.abs(r.amount_cents ?? 0),
        title: r.description || 'Payment',
        detail: null,
        kind: /^tier:/.test(r.ref ?? '') ? 'membership' : /^stars:/.test(r.ref ?? '') ? 'topup' : 'payment',
        // 'created' means Stripe never came back — in flight, not complete.
        state: r.state === 'paid' ? 'done' : r.state === 'created' ? 'pending' : r.state,
      })),
    ]
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, limit);

    return json({ activity });
  }

  // ── /report — the month, added up ──────────────────────────────────────
  //
  // The activity feed answers "what happened?"; this answers "so where did it
  // all go?" — which is a different question, asked monthly, usually with a
  // slight sense of dread. Totals by kind, per month, straight off
  // num_star_moves and num_payments. Computed at read time from the ledgers,
  // never stored: a stored summary can drift from the rows it summarises, and
  // then you have two answers to one question about money.
  if (path === '/report') {
    const url = new URL(request.url);
    const me = clip(url.searchParams.get('me'), 40);
    // Default: this month. ?month=2026-07 for any other.
    const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') ?? '')
      ? url.searchParams.get('month')
      : new Date().toISOString().slice(0, 7);
    if (!me || !env.DB) return json({ month, stars: {}, money: {} });
    await ensure(env);

    const [stars, money, balance] = await Promise.all([
      env.DB.prepare(
        `SELECT kind, COUNT(*) n, SUM(delta) net,
                SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) got,
                SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) spent
           FROM num_star_moves
          WHERE member_id = ?1 AND strftime('%Y-%m', created_at) = ?2
          GROUP BY kind`,
      ).bind(me, month).all().catch(() => ({ results: [] })),
      env.DB.prepare(
        `SELECT state, COUNT(*) n, SUM(amount_cents) cents
           FROM num_payments
          WHERE member_id = ?1 AND strftime('%Y-%m', COALESCE(paid_at, created_at)) = ?2
          GROUP BY state`,
      ).bind(me, month).all().catch(() => ({ results: [] })),
      env.DB.prepare('SELECT stars FROM num_star_balances WHERE member_id=?1')
        .bind(me).first().catch(() => null),
    ]);

    const sk = Object.fromEntries((stars.results ?? []).map((r) => [r.kind, { count: r.n, net: r.net, in: r.got, out: r.spent }]));
    const mk = Object.fromEntries((money.results ?? []).map((r) => [r.state, { count: r.n, cents: r.cents }]));

    return json({
      month,
      balance: Number(balance?.stars ?? 0),
      stars: {
        by_kind: sk,
        in: Object.values(sk).reduce((a, v) => a + v.in, 0),
        out: Object.values(sk).reduce((a, v) => a + v.out, 0),
      },
      money: {
        by_state: mk,
        // Only 'paid' is money that actually left. Pending isn't spent yet and
        // failed never was — a report that adds those in is lying upward,
        // which is the worse direction for a money report to lie.
        charged_cents: mk.paid?.cents ?? 0,
        refunded_cents: mk.refunded?.cents ?? 0,
      },
    });
  }

  return json({ error: 'not found' }, 404);
}
