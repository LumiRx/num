/**
 * Num for Business — paid tiers.
 *
 * ── THE SHAPE, COPIED ON PURPOSE ─────────────────────────────────────────
 *
 * This is worker/membership.mjs's own pattern, retargeted at a business_id
 * instead of a member_id. Same reasons apply: prices are decided HERE, never
 * by the client (see pay.mjs's own incident notes about exactly that hole);
 * a tier is granted only from a Stripe webhook that has already verified the
 * signature and the amount; and a lapsed card costs a business the paid
 * extras, never its free listing.
 *
 * ── WHAT'S ACTUALLY GATED, AND WHY IT ISN'T "API ACCESS" ─────────────────
 *
 * The 25 Aug marketing draft for /business/ promised "analytics, promotions,
 * multi-location management and API access" behind three paid tiers. API
 * access can't be one of them: the numbiz_ key IS the claim mechanism itself
 * — bizconsole.mjs's whole dashboard calls into bizapi.mjs through that key,
 * and gating it would break the free tier's entire reason to exist. So the
 * four gated things here are the three that survive contact with how the
 * product actually works — deeper analytics (a longer lookback window),
 * promotions (a short line NUM can surface to a traveller), and multiple
 * locations under one plan — plus beta features on the top tier, which the
 * marketing copy also promised ("Full ... which includes beta features").
 *
 * ── WHY INLINE PRICING, NOT A STRIPE PRODUCT/PRICE LOOKUP ────────────────
 *
 * Same reasoning as requestSubscription() in pay.mjs: `price_data` is stated
 * on the Checkout Session itself, in USD, by this file. Nothing needs to be
 * pre-created in the Stripe dashboard, and there is no Price ID to keep in
 * sync with what's advertised here. Change a number in DEFAULT_BIZ_TIERS (or
 * override with BIZ_MEMBERSHIP_TIERS, no deploy) and the price a business is
 * actually charged moves with it — one source, not two.
 */
import { currencyForRequest, priceFor, priceBlock, formatPrice } from './planprice.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
  });
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/**
 * The tiers. `entitlements` is the whole contract, same rule as membership.mjs:
 * a missing key means NOT granted, so a new capability defaults locked.
 */
export const DEFAULT_BIZ_TIERS = Object.freeze({
  free: Object.freeze({
    name: 'Listed',
    price_cents: 0,
    blurb: 'Claim your listing, tell NUM what to say about you, and receive booking requests. Free, forever — no card, no expiry.',
    entitlements: Object.freeze({
      analytics_days: 7,
      promotions: false,
      multi_location_max: 1,
      beta_features: false,
    }),
  }),
  small: Object.freeze({
    name: 'Small Business',
    price_cents: 999,
    blurb: '30-day analytics, a promotion NUM can mention to travellers, and up to 3 locations on one plan.',
    entitlements: Object.freeze({
      analytics_days: 30,
      promotions: true,
      multi_location_max: 3,
      beta_features: false,
    }),
  }),
  pro: Object.freeze({
    name: 'Pro',
    price_cents: 1999,
    blurb: '90-day analytics and up to 10 locations — for a business managing more than one place on NUM.',
    entitlements: Object.freeze({
      analytics_days: 90,
      promotions: true,
      multi_location_max: 10,
      beta_features: false,
    }),
  }),
  full: Object.freeze({
    name: 'Full',
    price_cents: 5000,
    blurb: 'A full year of analytics, up to 25 locations, and new NUM for Business features before anyone else gets them.',
    entitlements: Object.freeze({
      analytics_days: 365,
      promotions: true,
      // 25, not unlimited: the Sept 15 rate card puts a group brand or 25+
      // locations on Enterprise, which has no public price.
      multi_location_max: 25,
      beta_features: true,
    }),
  }),
});

export function bizTiers(env) {
  if (!env?.BIZ_MEMBERSHIP_TIERS) return DEFAULT_BIZ_TIERS;
  try {
    const parsed = JSON.parse(env.BIZ_MEMBERSHIP_TIERS);
    return parsed && typeof parsed === 'object' ? parsed : DEFAULT_BIZ_TIERS;
  } catch {
    console.warn('[bizbilling] BIZ_MEMBERSHIP_TIERS is not valid JSON — using defaults');
    return DEFAULT_BIZ_TIERS;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_business_subscriptions (
  business_id TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'free',
  since TEXT NOT NULL DEFAULT (datetime('now')),
  renews_at TEXT,
  source TEXT,
  ref TEXT,
  stripe_sub TEXT
);
`;
/**
 * Columns 0013 did not foresee, added lazily — the same shape hostmoney.mjs
 * uses, and for the same reason: a migration file for one nullable column is
 * ceremony, and a CREATE TABLE that already ran cannot grow one.
 *
 * `stripe_customer` is what makes a billing portal possible. Stripe's portal
 * is opened for a CUSTOMER, not a subscription, and until now the business
 * ladder stored only the subscription id — so a business could be charged
 * every month and had no way to see an invoice or replace an expiring card.
 * (num_hosts has carried `stripe_customer` since the fee-invoicing work; this
 * brings the other two ladders level.)
 */
const ALTERS = [
  'ALTER TABLE num_business_subscriptions ADD COLUMN stripe_customer TEXT',
];
// Keyed on the database, not a module-level boolean.
//
// `let ready = false` meant the FIRST env.DB this isolate saw marked the
// migration done for every other one. In production there is one database so
// it never bit; under test, and in any isolate that touches a second binding,
// the second database silently skipped its ALTERs and then failed on the
// INSERT that needed the column. hostmoney.mjs already keys its own `ready`
// on env.DB for exactly this reason — this brings the other two level.
const ready = new WeakSet();
async function ensure(env) {
  if (!env.DB || ready.has(env.DB)) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  for (const sql of ALTERS) {
    await env.DB.prepare(sql).run().catch((e) => {
      const m = String(e?.message ?? e);
      if (!/duplicate column/i.test(m)) console.warn('[bizbilling] ensure', m);
    });
  }
  ready.add(env.DB);
}

/**
 * What tier is this business on, right now?
 *
 * An expired plan silently becomes free rather than erroring — the same rule
 * membership.mjs uses. A lapsed card should cost the extras, never the
 * listing.
 */
export async function bizTierOf(env, businessId) {
  if (!businessId || !env.DB) return 'free';
  await ensure(env);
  const row = await env.DB.prepare('SELECT tier, renews_at FROM num_business_subscriptions WHERE business_id=?1')
    .bind(businessId).first().catch(() => null);
  if (!row) return 'free';
  if (row.renews_at && Date.parse(`${row.renews_at}Z`) < Date.now()) return 'free';
  return bizTiers(env)[row.tier] ? row.tier : 'free';
}

/** The one question feature code should ask: what does this business get? */
export async function bizEntitlements(env, businessId) {
  const t = await bizTierOf(env, businessId);
  const all = bizTiers(env);
  const tier = all[t] ? t : 'free';
  return { tier, name: all[tier]?.name ?? 'Listed', ...(all[tier]?.entitlements ?? {}) };
}

/**
 * Put a business on a tier. Called ONLY by the Stripe webhook after a
 * verified payment — never from a client request, for the exact reason a
 * client can't price its own Star pack or membership tier.
 */
/**
 * End the subscription this owner is REPLACING, if there is one.
 *
 * ── THE BUG ──────────────────────────────────────────────────────────────
 *
 * The console's "Switch" button, and every other upgrade path, called
 * requestSubscription() again and then granted the new tier. The grant's
 * upsert overwrote `stripe_sub` with the new subscription id — and nothing
 * ever told Stripe about the old one. It stayed live and kept charging. The
 * customer held two subscriptions; this table knew about one; and the one it
 * had forgotten was the one still taking money with no row pointing at it.
 *
 * Immediate, not at-period-end: they are already paying for the new plan
 * from today, so leaving the old one to run out bills them twice for the
 * overlap. A customer choosing to STOP still gets cancel_at_period_end —
 * that is a different action and keeps the month they paid for.
 *
 * Best-effort on purpose. If Stripe refuses, the grant still stands (the
 * money for the new plan has already been taken and withholding the plan
 * would be the worse failure) and endSubscriptionNow logs loudly so a human
 * can finish the job.
 */
export async function endReplacedSubscription(env, previousSub, nextSub) {
  if (!previousSub || previousSub === nextSub) return;
  try {
    const { endSubscriptionNow } = await import('./pay.mjs');
    await endSubscriptionNow(env, previousSub);
  } catch (err) {
    console.error('[plan] could not end the replaced subscription', previousSub, err?.message ?? err);
  }
}

export async function grantBizTier(env, businessId, tier, { source = 'stripe', ref = null, months = 1, sub = null, customer = null } = {}) {
  await ensure(env);
  if (!bizTiers(env)[tier]) return { ok: false, error: 'unknown tier' };
  // Read BEFORE the upsert overwrites it — this is the only moment the old
  // subscription id still exists anywhere.
  const prior = await env.DB.prepare('SELECT stripe_sub FROM num_business_subscriptions WHERE business_id=?1')
    .bind(businessId).first().catch(() => null);
  const renews = new Date(Date.now() + months * 30 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  await env.DB.prepare(
    `INSERT INTO num_business_subscriptions (business_id, tier, renews_at, source, ref, stripe_sub, stripe_customer)
       VALUES (?1,?2,?3,?4,?5,?6,?7)
     ON CONFLICT(business_id) DO UPDATE SET tier=?2, renews_at=?3, source=?4, ref=?5,
       stripe_sub=COALESCE(?6, stripe_sub),
       -- COALESCE, never overwrite with null: a Stars grant or an admin fix
       -- carries no customer, and losing the stored one would take the
       -- billing portal away from somebody who is still paying.
       stripe_customer=COALESCE(?7, stripe_customer)`,
  ).bind(businessId, tier, renews, source, ref, sub, customer).run();
  if (sub) await endReplacedSubscription(env, prior?.stripe_sub ?? null, sub);
  return { ok: true, tier, renews_at: renews };
}

/**
 * A renewal invoice was PAID — extend the plan it belongs to. Keyed on the
 * Stripe subscription id, same as membership.mjs's recordRenewal, and for the
 * same reason: no metadata archaeology on the invoice. Returns ok:false (not
 * a throw) when the sub id isn't one of ours, so the webhook can fall back to
 * checking whether it belongs to a MEMBER subscription instead — the two live
 * in different tables and a sub id belongs to exactly one of them.
 */
export async function recordBizRenewal(env, subId, periodEndEpochSeconds) {
  if (!subId || !env.DB) return { ok: false };
  await ensure(env);
  const t = Number(periodEndEpochSeconds);
  const renews = Number.isFinite(t) && t > 0
    ? new Date(t * 1000 + 3 * 86400_000).toISOString().slice(0, 19).replace('T', ' ')
    : new Date(Date.now() + 33 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  const r = await env.DB.prepare('UPDATE num_business_subscriptions SET renews_at=?2 WHERE stripe_sub=?1')
    .bind(subId, renews).run();
  return { ok: (r?.meta?.changes ?? 0) > 0, renews_at: renews };
}

/** The subscription died at Stripe — the plan follows it back to free. */
export async function lapseBizBySub(env, subId) {
  if (!subId || !env.DB) return { ok: false };
  await ensure(env);
  const r = await env.DB.prepare(
    "UPDATE num_business_subscriptions SET tier='free', renews_at=NULL, stripe_sub=NULL WHERE stripe_sub=?1",
  ).bind(subId).run();
  return { ok: (r?.meta?.changes ?? 0) > 0 };
}

/**
 * May this business attach another location?
 *
 * ── WHY THIS IS A HOOK AND NOT YET A GATE ────────────────────────────────
 *
 * `multi_location_max` is advertised on every tier (1 / 3 / 10 / 25) and was
 * enforced nowhere, which read like a missing check. It is not: there is no
 * door to put a check on. Every claim path — bizapi.mjs's verify and
 * console.mjs's admin promote — creates a NEW business row per listing, so a
 * business owning several places is a thing the tier table describes and the
 * product cannot yet do.
 *
 * Writing a gate into a flow that does not exist would be worse than the gap:
 * it would read as enforced, and the first person to build the real
 * multi-location door would have no reason to look for it. So this is the one
 * function that answers the question, `listLocations` reports its answer
 * honestly, and whoever builds that door calls this before attaching.
 */
export async function canAddLocation(env, businessId) {
  const ent = await bizEntitlements(env, businessId);
  const max = ent?.multi_location_max;
  const { results } = await env.DB.prepare(
    'SELECT place_id FROM num_place_owners WHERE business_id=?1 AND revoked_at IS NULL',
  ).bind(businessId).all().catch(() => ({ results: [] }));
  const count = (results ?? []).length;
  if (max == null) return { ok: true, count, max: null, reason: null };
  if (count < max) return { ok: true, count, max, reason: null };
  return {
    ok: false,
    count,
    max,
    tier: ent.tier,
    reason: `Your ${ent.tier} plan covers ${max} location${max === 1 ? '' : 's'} and you have ${count}.`,
  };
}

/* ── routes, mounted under /v1/billing/* by bizapi.mjs ─────────────────────
 * `auth` is bizapi's own authed() result ({businessId, placeId, keyId}), or
 * null for the one route that's public. Not re-authenticated here — one
 * key check per request, not two. */
export async function handleBizBilling(request, env, path, auth) {
  await ensure(env);

  // Public: a business should be able to see what paying buys before it has
  // a key to pay with.
  if (path === '/tiers' || path === '' || path === '/') {
    const all = bizTiers(env);
    // Priced in the visitor's own currency (worker/planprice.mjs), derived
    // from Cloudflare's country on THIS request — never from a query param,
    // because a currency the caller picks is a discount the caller picks.
    // `price_cents` stays the field name every existing client reads; what
    // changed is that it is now denominated in `currency` beside it.
    const cur = currencyForRequest(request, env);
    return json({
      currency: cur.toLowerCase(),
      tiers: Object.entries(all).map(([id, t]) => {
        const block = priceBlock('biz', id, cur);
        return {
          id,
          name: t.name,
          price_cents: block?.price_cents ?? t.price_cents,
          currency: cur.toLowerCase(),
          display: block?.display ?? formatPrice(t.price_cents, cur),
          blurb: t.blurb,
          entitlements: t.entitlements,
        };
      }),
      principle: 'Listing and receiving bookings is free, forever. Paying unlocks deeper analytics, promotions, more locations on one plan, and beta features first.',
    });
  }

  if (!auth?.businessId) return json({ error: 'unauthorized' }, 401);

  if (path === '/me' && request.method === 'GET') {
    const ent = await bizEntitlements(env, auth.businessId);
    const row = await env.DB.prepare('SELECT since, renews_at FROM num_business_subscriptions WHERE business_id=?1')
      .bind(auth.businessId).first().catch(() => null);
    return json({ ...ent, since: row?.since ?? null, renews_at: row?.renews_at ?? null });
  }

  if (path === '/subscribe' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const tier = clip(b.tier, 20);
    const t = tier ? bizTiers(env)[tier] : null;
    if (!t || !(t.price_cents > 0)) {
      return json({ ok: false, error: `Which plan? One of: ${Object.keys(bizTiers(env)).filter((k) => bizTiers(env)[k].price_cents > 0).join(', ')}.` }, 400);
    }
    // Currency comes from the request, price comes from the table. The
    // webhook in pay.mjs re-derives BOTH from the Stripe session and refuses
    // the grant if they disagree with this same table, so a forged session
    // buys nothing.
    const cur = currencyForRequest(request, env);
    const amountCents = priceFor('biz', tier, cur);
    if (amountCents == null) {
      return json({ ok: false, error: `No price for ${tier} in ${cur}.` }, 400);
    }
    const { requestSubscription } = await import('./pay.mjs');
    const out = await requestSubscription(env, {
      businessId: auth.businessId,
      amountCents,
      currency: cur,
      name: `NUM for Business — ${t.name}`,
      ref: `biztier:${tier}`,
      successUrl: clip(b.success_url, 300) || undefined,
      cancelUrl: clip(b.cancel_url, 300) || undefined,
    });
    return json(out, out.ok ? 200 : 503);
  }

  // A subscriber can now fix a card, pull an invoice and see what they are
  // paying — the thing cancel-at-period-end was standing in for. Stripe hosts
  // the page; we only mint the session and send them there.
  if (path === '/portal' && request.method === 'POST') {
    const row = await env.DB.prepare('SELECT stripe_customer FROM num_business_subscriptions WHERE business_id=?1')
      .bind(auth.businessId).first().catch(() => null);
    if (!row?.stripe_customer) {
      // Said plainly rather than with an empty portal: a business on the free
      // plan has no Stripe customer because it has never been charged, and
      // that is not an error.
      return json({ ok: false, error: "You're on the free plan — there's nothing to bill, so there's no billing page yet." }, 400);
    }
    const b = await request.json().catch(() => ({}));
    const { billingPortal } = await import('./pay.mjs');
    const out = await billingPortal(env, row.stripe_customer, clip(b.return_url, 300) || undefined);
    return json(out, out.ok ? 200 : 502);
  }

  if (path === '/cancel' && request.method === 'POST') {
    const row = await env.DB.prepare('SELECT stripe_sub, tier, renews_at FROM num_business_subscriptions WHERE business_id=?1')
      .bind(auth.businessId).first();
    if (!row?.stripe_sub) {
      return json({
        ok: true,
        note: row?.renews_at
          ? `Nothing renews automatically — your ${row.tier} access simply ends ${row.renews_at}.`
          : "You're on the free plan — nothing to cancel.",
      });
    }
    const { cancelSubscription } = await import('./pay.mjs');
    const out = await cancelSubscription(env, row.stripe_sub);
    return json(out.ok
      ? { ok: true, note: `Done — ${row.tier} stays active until ${row.renews_at}, then won't charge again.` }
      : out, out.ok ? 200 : 502);
  }

  return json({ error: 'not found' }, 404);
}
