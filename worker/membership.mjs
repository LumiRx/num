// Memberships: what a paying member gets that a free one doesn't.
//
// ── The design rule ──────────────────────────────────────────────────────
//
// GATE THE CEILING, NEVER THE CORE.
//
// Num's promise is "ask for anything and I sort it out". The moment that
// sentence has an asterisk, the product stops being a concierge and becomes a
// demo of one. So the free tier keeps the whole experience — the concierge,
// plans, friends, bookings — and paying raises LIMITS and unlocks things that
// genuinely cost us money to run (long research, priority at peak, flights,
// concierge-brokered bookings).
//
// The test for any new gate: would a person on the free tier ever be told
// "Num can't help with that"? If yes, it is the wrong gate. "You've used your
// ten deep searches this month, here's when they reset" is a limit. "Num
// doesn't answer questions unless you pay" is a broken promise.
//
// ── Why entitlements and not `if (tier === 'pro')` ───────────────────────
//
// Feature checks scattered as tier comparisons rot the moment tiers change,
// and every one is a place to get the comparison backwards and hand out
// something free. Here, code asks "may this member do X" and never "which
// plan are they on".
//
// ── Prices ───────────────────────────────────────────────────────────────
//
// $8.98 and $28.98, set by Dre — no longer placeholders. Limits are still
// first-guesses and should move once there is real usage to look at.
//
// These are the ONLY authority on price. The client asks the server what a
// plan costs and the server charges what it says; a client that could name its
// own number is the $1-for-★5,000 hole again in a different shirt. Change them
// here, or override with MEMBERSHIP_TIERS (JSON) without a deploy.
import { STAR_PACKS } from './preflight.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/**
 * The tiers. `entitlements` is the whole contract — everything else is copy.
 *
 * `null` means unlimited. A missing entitlement means NOT granted, so adding a
 * new capability defaults to locked rather than accidentally free.
 */
const DEFAULT_TIERS = {
  free: {
    name: 'Num',
    price_cents: 0,
    blurb: 'The concierge, your plans, your people. No trial, no countdown.',
    entitlements: {
      concierge: true,          // the core promise — never gated
      plans: true,
      friends: true,
      errands: true,
      tabs: true,
      voice: true,
      plans_max: 3,             // a limit, not a lock
      friends_max: null,
      deep_research_monthly: 3,
      priority_queue: false,
      flight_search: false,
      concierge_booking: false,
      early_features: false,
    },
  },
  plus: {
    name: 'Num Plus',
    price_cents: 898,
    blurb: 'More room, more research, first in line when everyone asks at once.',
    entitlements: {
      concierge: true, plans: true, friends: true, errands: true, tabs: true, voice: true,
      plans_max: 25,
      friends_max: null,
      deep_research_monthly: 40,
      priority_queue: true,
      flight_search: true,
      concierge_booking: false,
      early_features: true,
    },
  },
  pro: {
    name: 'Num Pro',
    price_cents: 2898,
    blurb: 'Everything, no ceilings, and Num books on your behalf.',
    entitlements: {
      concierge: true, plans: true, friends: true, errands: true, tabs: true, voice: true,
      plans_max: null,
      friends_max: null,
      deep_research_monthly: null,
      priority_queue: true,
      flight_search: true,
      concierge_booking: true,
      early_features: true,
    },
  },
};

export function tiers(env) {
  if (!env?.MEMBERSHIP_TIERS) return DEFAULT_TIERS;
  try {
    const parsed = JSON.parse(env.MEMBERSHIP_TIERS);
    return parsed && typeof parsed === 'object' ? parsed : DEFAULT_TIERS;
  } catch {
    // A malformed override must not silently hand out the wrong plan.
    console.warn('[membership] MEMBERSHIP_TIERS is not valid JSON — using defaults');
    return DEFAULT_TIERS;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_memberships (
  member_id TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'free',
  since TEXT NOT NULL DEFAULT (datetime('now')),
  renews_at TEXT,
  source TEXT,
  ref TEXT
);
CREATE TABLE IF NOT EXISTS num_usage_counters (
  member_id TEXT NOT NULL, period TEXT NOT NULL, key TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (member_id, period, key)
);
`;
let ready = false;
async function ensure(env) {
  if (ready || !env.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

const period = () => new Date().toISOString().slice(0, 7); // YYYY-MM

/**
 * What tier is this member on, right now?
 *
 * An EXPIRED membership silently becomes free rather than erroring — a lapsed
 * card should cost you the extras, never the app.
 */
export async function tierOf(env, memberId) {
  if (!memberId || !env.DB) return 'free';
  await ensure(env);
  const row = await env.DB.prepare('SELECT tier, renews_at FROM num_memberships WHERE member_id=?1')
    .bind(memberId).first().catch(() => null);
  if (!row) return 'free';
  if (row.renews_at && Date.parse(`${row.renews_at}Z`) < Date.now()) return 'free';
  return tiers(env)[row.tier] ? row.tier : 'free';
}

/**
 * May this member do X? The only question feature code should ask.
 *
 * Returns a verdict in the same shape as preflight: a refusal carries what
 * WOULD work, so the app can offer the upgrade in context instead of a wall.
 */
export async function may(env, memberId, capability, { count = null } = {}) {
  const t = await tierOf(env, memberId);
  const all = tiers(env);
  const ent = all[t]?.entitlements ?? {};
  const value = ent[capability];

  // Boolean capability.
  if (typeof value === 'boolean') {
    if (value) return { ok: true, tier: t };
    const upgrade = Object.entries(all).find(([, v]) => v.entitlements?.[capability] === true);
    return {
      ok: false, tier: t,
      reason: `That’s part of ${upgrade?.[1]?.name ?? 'a paid plan'}.`,
      upgrade_to: upgrade?.[0] ?? null,
    };
  }

  // Numeric limit. null = unlimited.
  if (value === null) return { ok: true, tier: t, limit: null };
  if (typeof value === 'number') {
    const used = count ?? (await usedThisPeriod(env, memberId, capability));
    if (used < value) return { ok: true, tier: t, limit: value, used, left: value - used };
    const better = Object.entries(all).find(([, v]) => {
      const lim = v.entitlements?.[capability];
      return lim === null || (typeof lim === 'number' && lim > value);
    });
    return {
      ok: false, tier: t, limit: value, used,
      reason: `You’ve used all ${value} this month.`,
      upgrade_to: better?.[0] ?? null,
      upgrade_gives: better ? better[1].entitlements[capability] : null,
    };
  }

  // Not listed = not granted. New capabilities default locked, on purpose.
  return { ok: false, tier: t, reason: 'That isn’t available on your plan yet.', upgrade_to: null };
}

async function usedThisPeriod(env, memberId, key) {
  await ensure(env);
  const r = await env.DB.prepare('SELECT used FROM num_usage_counters WHERE member_id=?1 AND period=?2 AND key=?3')
    .bind(memberId, period(), key).first().catch(() => null);
  return Number(r?.used ?? 0);
}

/** Count one use of a metered capability. Call AFTER the work succeeded. */
export async function countUse(env, memberId, key, by = 1) {
  if (!memberId || !env.DB) return;
  await ensure(env);
  await env.DB.prepare(
    `INSERT INTO num_usage_counters (member_id, period, key, used) VALUES (?1,?2,?3,?4)
     ON CONFLICT(member_id, period, key) DO UPDATE SET used = used + ?4`,
  ).bind(memberId, period(), key, by).run().catch(() => {});
}

/**
 * Put a member on a tier. Called by the Stripe webhook after a verified
 * payment — never from a client request, for the same reason the client can't
 * price a Star pack.
 */
export async function grantTier(env, memberId, tier, { source = 'stripe', ref = null, months = 1 } = {}) {
  await ensure(env);
  if (!tiers(env)[tier]) return { ok: false, error: 'unknown tier' };
  const renews = new Date(Date.now() + months * 30 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  await env.DB.prepare(
    `INSERT INTO num_memberships (member_id, tier, renews_at, source, ref) VALUES (?1,?2,?3,?4,?5)
     ON CONFLICT(member_id) DO UPDATE SET tier=?2, renews_at=?3, source=?4, ref=?5`,
  ).bind(memberId, tier, renews, source, ref).run();
  return { ok: true, tier, renews_at: renews };
}

export async function handleMembership(request, env, path) {
  const url = new URL(request.url);
  await ensure(env);

  // The price list, public. A pricing page that disagrees with the server is
  // how people end up feeling misled.
  if (path === '/tiers' || path === '/' || path === '') {
    const all = tiers(env);
    return json({
      tiers: Object.entries(all).map(([id, t]) => ({
        id, name: t.name, price_cents: t.price_cents, blurb: t.blurb, entitlements: t.entitlements,
      })),
      star_packs: STAR_PACKS,
      principle: 'The concierge, plans and friends are free forever. Paying raises limits and unlocks what costs us to run.',
    });
  }

  // What am I on, and what have I used?
  if (path === '/me') {
    const me = clip(url.searchParams.get('me'), 40);
    if (!me) return json({ tier: 'free', entitlements: tiers(env).free.entitlements });
    const t = await tierOf(env, me);
    const row = await env.DB.prepare('SELECT tier, since, renews_at FROM num_memberships WHERE member_id=?1')
      .bind(me).first().catch(() => null);
    const { results } = await env.DB.prepare(
      'SELECT key, used FROM num_usage_counters WHERE member_id=?1 AND period=?2',
    ).bind(me, period()).all().catch(() => ({ results: [] }));
    return json({
      tier: t,
      name: tiers(env)[t]?.name ?? 'Num',
      entitlements: tiers(env)[t]?.entitlements ?? {},
      since: row?.since ?? null,
      renews_at: row?.renews_at ?? null,
      used: Object.fromEntries((results ?? []).map((r) => [r.key, r.used])),
    });
  }

  // Start a subscription — priced by US, like everything else.
  if (path === '/subscribe' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const me = clip(b.me, 40);
    const tier = clip(b.tier, 20);
    const t = tiers(env)[tier];
    if (!me || !t || t.price_cents <= 0) return json({ ok: false, error: 'Which plan?' }, 400);

    const { requestPayment } = await import('./pay.mjs');
    const out = await requestPayment(env, {
      memberId: me,
      amountCents: t.price_cents,          // ours, never the client's
      currency: 'usd',
      description: `${t.name} — monthly`,
      ref: `tier:${tier}`,
    });
    return json(out, out.ok ? 200 : 503);
  }

  return json({ error: 'not found' }, 404);
}
