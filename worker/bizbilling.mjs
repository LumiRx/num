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
    blurb: 'A full year of analytics, unlimited locations, and new NUM for Business features before anyone else gets them.',
    entitlements: Object.freeze({
      analytics_days: 365,
      promotions: true,
      multi_location_max: null,
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
let ready = false;
async function ensure(env) {
  if (ready || !env.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
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
export async function grantBizTier(env, businessId, tier, { source = 'stripe', ref = null, months = 1, sub = null } = {}) {
  await ensure(env);
  if (!bizTiers(env)[tier]) return { ok: false, error: 'unknown tier' };
  const renews = new Date(Date.now() + months * 30 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  await env.DB.prepare(
    `INSERT INTO num_business_subscriptions (business_id, tier, renews_at, source, ref, stripe_sub) VALUES (?1,?2,?3,?4,?5,?6)
     ON CONFLICT(business_id) DO UPDATE SET tier=?2, renews_at=?3, source=?4, ref=?5, stripe_sub=COALESCE(?6, stripe_sub)`,
  ).bind(businessId, tier, renews, source, ref, sub).run();
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
    return json({
      tiers: Object.entries(all).map(([id, t]) => ({
        id, name: t.name, price_cents: t.price_cents, blurb: t.blurb, entitlements: t.entitlements,
      })),
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
    const { requestSubscription } = await import('./pay.mjs');
    const out = await requestSubscription(env, {
      businessId: auth.businessId,
      amountCents: t.price_cents,
      name: `NUM for Business — ${t.name}`,
      ref: `biztier:${tier}`,
      successUrl: clip(b.success_url, 300) || undefined,
      cancelUrl: clip(b.cancel_url, 300) || undefined,
    });
    return json(out, out.ok ? 200 : 503);
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
