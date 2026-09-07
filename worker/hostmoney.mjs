/**
 * HOST MONEY — recorded since 3 Sep, never moved until 4 Sep 2026.
 *
 * THE MODEL (3 Sep 2026, growth/hostbook.test.mjs pins it): the host is NUM's
 * customer and the client is the host's. The host pays a monthly plan
 * (small £9.99 · pro £19.99 · full £50) plus £5 per confirmed booking
 * (`booking_fee_minor`, charged on confirm, once); the hosted member pays
 * NUM nothing. The OLD model — host as referrer earning a share of NUM's
 * commission — is gone, and `num_host_earnings` stays dormant on purpose.
 * Filing a share there would be the old model leaking back in.
 *
 * What this puts behind a host's console key:
 *
 *   1. PLAN — the same Stripe subscription path NUM for Business uses:
 *      ref `hosttier:<tier>`, metadata `num_host`, priced in GBP. The webhook
 *      in pay.mjs grants, renews and lapses it exactly as it does a business,
 *      and stores the Stripe customer so fees can be invoiced to the same card.
 *   2. FEES — a monthly sweep sums the confirmed bookings' fees per host and
 *      raises one Stripe invoice. It runs only with HOST_FEE_INVOICING=on:
 *      this charges a real card, and the first invoice deserves a human
 *      reading it in the Stripe dashboard before the switch is thrown.
 *      Rows are stamped `fee_invoiced_at` so a fee is invoiced once, ever.
 *   3. MINE / CLIENT CALENDAR — the member-facing side (below).
 *
 * Underpayment refuses the grant (tierPaidRight, GBP), same as business. An
 * ended host cannot subscribe and is never invoiced.
 */
import { calendar, vevent, floating } from './calendar.mjs';

/* ---------------------------------------------------------------- auth */

function sameSecret(a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** The host behind a console key, or null. Mirrors growth/worker.js hostAuth. */
export async function hostByKey(env, k) {
  k = String(k ?? '');
  if (!env?.DB || k.length < 20 || k.length > 80) return null;
  const host = await env.DB.prepare(
    'SELECT id, name, email, code, console_key, host_bps, term_months, status, tier, plan_status, plan_sub_id, plan_renews_at, currency FROM num_hosts WHERE console_key = ?1',
  ).bind(k).first().catch(() => null);
  if (!host || !sameSecret(host.console_key, k) || host.status === 'ended') return null;
  return host;
}

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/* ------------------------------------------------------------- billing */

export const HOST_PLANS = Object.freeze({
  small: { name: 'Small', pence: 999 },
  pro: { name: 'Pro', pence: 1999 },
  full: { name: 'Full', pence: 5000 },
});
export const HOST_CURRENCY = 'gbp';

const stamp = (epochS) => new Date((Number.isFinite(Number(epochS)) && Number(epochS) > 0 ? Number(epochS) * 1000 : Date.now() + 30 * 86400_000) + 3 * 86400_000)
  .toISOString().slice(0, 19).replace('T', ' ');

/** Stripe said paid: the plan is theirs. */
// Two columns the plan needs that 0013 did not foresee: the Stripe customer
// (so booking fees can be invoiced to the card that pays the plan) and the
// receipt that a fee has been invoiced. Added lazily, in the house style.
const ALTERS = [
  'ALTER TABLE num_hosts ADD COLUMN stripe_customer TEXT',
  'ALTER TABLE num_host_requests ADD COLUMN fee_invoiced_at TEXT',
];
const ready = new WeakSet();
export async function ensure(env) {
  if (!env?.DB || ready.has(env.DB)) return;
  let absent = false;
  for (const sql of ALTERS) {
    try { await env.DB.prepare(sql).run(); }
    catch (e) { const m = String(e?.message ?? e); if (/no such table/i.test(m)) absent = true; else if (!/duplicate column/i.test(m)) console.warn('[hostmoney] ensure', m); }
  }
  if (!absent) ready.add(env.DB);
}

export async function grantHostTier(env, hostId, tier, { ref = null, sub = null, periodEnd = null, customer = null } = {}) {
  if (!env?.DB || !hostId || !HOST_PLANS[tier]) return { ok: false };
  await ensure(env);
  const r = await env.DB.prepare(
    `UPDATE num_hosts SET tier = ?2, plan_status = 'active', plan_sub_id = ?3, plan_renews_at = ?4, updated_at = ?5,
            stripe_customer = COALESCE(?6, stripe_customer)
      WHERE id = ?1 AND status <> 'ended'`,
  ).bind(hostId, tier, sub, stamp(periodEnd), now(), customer).run().catch(() => null);
  const ok = (r?.meta?.changes ?? 0) > 0;
  if (ok && ref) console.log('[hostmoney] plan', tier, 'granted to host', hostId, 'ref', ref);
  return { ok };
}

export async function recordHostRenewal(env, subId, periodEnd) {
  if (!env?.DB || !subId) return { ok: false };
  const renews = stamp(periodEnd);
  const r = await env.DB.prepare(
    "UPDATE num_hosts SET plan_renews_at = ?2, plan_status = 'active', updated_at = ?3 WHERE plan_sub_id = ?1",
  ).bind(subId, renews, now()).run().catch(() => null);
  return { ok: (r?.meta?.changes ?? 0) > 0, renews_at: renews };
}

export async function lapseHostBySub(env, subId) {
  if (!env?.DB || !subId) return { ok: false };
  const r = await env.DB.prepare(
    "UPDATE num_hosts SET tier = 'free', plan_status = 'cancelled', plan_sub_id = NULL, plan_renews_at = NULL, updated_at = ?2 WHERE plan_sub_id = ?1",
  ).bind(subId, now()).run().catch(() => null);
  return { ok: (r?.meta?.changes ?? 0) > 0 };
}

/* ------------------------------------------------------ booking fees */

/**
 * Sum each host's un-invoiced confirmed-booking fees and raise ONE Stripe
 * invoice per host, charged to the customer that pays their plan.
 * Dry by default: without HOST_FEE_INVOICING=on it reports what it WOULD
 * invoice and touches nothing.
 */
export async function feeSweep(env, { stripeCall = null, minPence = 500 } = {}) {
  if (!env?.DB) return { hosts: 0, invoiced: 0, pence: 0, dry: true };
  await ensure(env);
  const live = env.HOST_FEE_INVOICING === 'on' && !!env.STRIPE_SECRET_KEY;
  let rows;
  try {
    ({ results: rows } = await env.DB.prepare(
      `SELECT h.id AS host_id, h.name, h.email, h.stripe_customer, h.currency,
              SUM(r.booking_fee_minor) AS pence, COUNT(*) AS n
         FROM num_host_requests r JOIN num_hosts h ON h.id = r.host_id AND h.status = 'active'
        WHERE r.status IN ('confirmed','done') AND r.booking_fee_minor > 0 AND r.fee_invoiced_at IS NULL
        GROUP BY h.id HAVING SUM(r.booking_fee_minor) >= ?1 ORDER BY pence DESC LIMIT 50`,
    ).bind(minPence).all());
  } catch (e) {
    if (!/no such (table|column)/i.test(String(e?.message ?? e))) console.warn('[hostmoney] fees', e?.message ?? e);
    return { hosts: 0, invoiced: 0, pence: 0, dry: !live };
  }
  const owed = rows ?? [];
  const total = owed.reduce((n, r) => n + Number(r.pence || 0), 0);
  if (!live) return { hosts: owed.length, invoiced: 0, pence: total, dry: true };
  const call = stripeCall ?? (await import('./pay.mjs')).stripeCall;
  let invoiced = 0;
  for (const r of owed) {
    if (!r.stripe_customer) { console.warn('[hostmoney] no Stripe customer for host', r.host_id, '— plan never paid, fees not invoiced'); continue; }
    const period = now().slice(0, 7);
    const idem = `hostfees:${r.host_id}:${period}`;
    try {
      await call(env, '/invoiceitems', {
        customer: r.stripe_customer, currency: HOST_CURRENCY, amount: Number(r.pence),
        description: `NUM booking fees — ${r.n} confirmed booking(s) at £5`,
      }, idem + ':item');
      const inv = await call(env, '/invoices', {
        customer: r.stripe_customer, auto_advance: 'true', collection_method: 'charge_automatically',
        description: `NUM for VIP hosts — booking fees, ${period}`,
      }, idem + ':invoice');
      await env.DB.prepare(
        `UPDATE num_host_requests SET fee_invoiced_at = ?2 WHERE host_id = ?1 AND status IN ('confirmed','done') AND booking_fee_minor > 0 AND fee_invoiced_at IS NULL`,
      ).bind(r.host_id, `${now()} ${inv?.id ?? ''}`.trim()).run();
      invoiced++;
    } catch (e) {
      console.error('[hostmoney] invoice failed for host', r.host_id, e?.message ?? e);
      const { record } = await import('./failures.mjs');
      await record(env, { kind: 'host_fee_invoice_failed', subject: `${r.name} <${r.email}>`, detail: String(e?.message ?? e) }).catch(() => {});
    }
  }
  return { hosts: owed.length, invoiced, pence: total, dry: false };
}

/* ------------------------------------------------- the member's host */

/** GET /api/host/mine?me= — who looks after this member, for the app. */
export async function mine(env, memberId, { site = 'https://itsnum.com' } = {}) {
  const { hostFor } = await import('./hostaware.mjs');
  const host = memberId ? await hostFor(env, memberId) : null;
  if (!host) return { host: null, find: `${site}/find-a-host/` };
  const client = await env.DB.prepare('SELECT member_token, created_at FROM num_host_clients WHERE id = ?1').bind(host.clientId).first().catch(() => null);
  return {
    host: { name: host.hostName, services: host.services, since: client?.created_at ?? null },
    page: client?.member_token ? `${site}/my-host/?t=${client.member_token}` : null,
    calendar: client?.member_token ? `${site}/api/host/client-calendar.ics?t=${client.member_token}` : null,
    find: null,
  };
}

/* --------------------------------------- the client's calendar feed */

/**
 * GET /api/host/client-calendar.ics?t=<member_token>
 * What the host has confirmed for THIS client, as a feed their calendar can
 * subscribe to. Read-only, confirmed and done only, dates parsed or skipped.
 */
export async function clientCalendar(env, t) {
  t = String(t ?? '');
  if (!env?.DB || t.length < 16 || t.length > 80) return null;
  const client = await env.DB.prepare(
    `SELECT c.id, c.name, c.member_token, h.name AS host_name FROM num_host_clients c JOIN num_hosts h ON h.id = c.host_id
      WHERE c.member_token = ?1 AND c.status <> 'removed'`,
  ).bind(t).first().catch(() => null);
  if (!client || !sameSecret(client.member_token, t)) return null;
  const { results } = await env.DB.prepare(
    `SELECT id, title, detail, city, starts_at, ends_at, status, updated_at, created_at
       FROM num_host_requests WHERE client_id = ?1 AND status IN ('confirmed','done')
        AND starts_at IS NOT NULL AND starts_at <> '' ORDER BY starts_at DESC LIMIT 300`,
  ).bind(client.id).all().catch(() => ({ results: [] }));
  const events = [];
  for (const r of results ?? []) {
    const [day, time] = String(r.starts_at).replace('T', ' ').split(' ');
    const when = floating(day, time);
    if (!when) continue;
    let end = null;
    if (r.ends_at) {
      const [d2, t2] = String(r.ends_at).replace('T', ' ').split(' ');
      end = floating(d2, t2)?.value ?? null;
    }
    events.push(vevent({
      uid: `host-request-${r.id}`, start: when.value, end, allDay: when.allDay,
      summary: r.title,
      description: [r.detail, `Arranged by ${client.host_name} through NUM.`].filter(Boolean).join('\n'),
      location: r.city ?? undefined,
    }));
  }
  return calendar({ name: `${client.host_name} — for ${client.name || 'you'}`, events });
}

/* --------------------------------------------------------------- HTTP */

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
});

export async function handleHost(request, env, url) {
  const path = url.pathname.replace(/^\/api\/host/, '') || '/';
  const site = env.SITE || 'https://itsnum.com';

  if (path === '/mine' && request.method === 'GET') {
    const me = String(url.searchParams.get('me') ?? '').slice(0, 40);
    if (!me) return json({ error: 'me required' }, 400);
    return json(await mine(env, me, { site }));
  }

  if (path === '/client-calendar.ics' && request.method === 'GET') {
    const body = await clientCalendar(env, url.searchParams.get('t'));
    if (!body) return new Response('Not found', { status: 404 });
    return new Response(body, {
      headers: {
        'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, no-store',
        'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer',
      },
    });
  }

  if (path === '/book' && request.method === 'POST') {
    const { handleHostBook } = await import('./hostbookdesk.mjs');
    return handleHostBook(request, env, url);
  }

  if (path.startsWith('/plan')) {
    const host = await hostByKey(env, url.searchParams.get('k'));
    if (!host) return json({ error: 'unauthorised' }, 401);
    if (path === '/plan' && request.method === 'GET') {
      return json({
        tier: host.tier ?? 'free', plan_status: host.plan_status ?? 'none', renews_at: host.plan_renews_at ?? null,
        plans: Object.fromEntries(Object.entries(HOST_PLANS).map(([k, v]) => [k, { name: v.name, pence: v.pence, currency: HOST_CURRENCY }])),
        billing_on: (env.PAY_MODE ?? (env.STRIPE_SECRET_KEY ? 'stripe' : 'off')) === 'stripe',
      });
    }
    if (path === '/plan/subscribe' && request.method === 'POST') {
      const b = await request.json().catch(() => ({}));
      const tier = String(b.tier ?? '').toLowerCase();
      if (!HOST_PLANS[tier]) return json({ ok: false, error: `Which plan? One of: ${Object.keys(HOST_PLANS).join(', ')}.` }, 400);
      const { requestSubscription } = await import('./pay.mjs');
      const out = await requestSubscription(env, {
        hostId: host.id,
        amountCents: HOST_PLANS[tier].pence,
        currency: HOST_CURRENCY,
        name: `NUM for VIP hosts — ${HOST_PLANS[tier].name}`,
        ref: `hosttier:${tier}`,
        successUrl: String(b.success_url ?? '').slice(0, 300) || `${site}/host/?k=${host.console_key}&paid=1`,
        cancelUrl: String(b.cancel_url ?? '').slice(0, 300) || `${site}/host/?k=${host.console_key}`,
      });
      return json(out, out.ok ? 200 : 503);
    }
    if (path === '/plan/cancel' && request.method === 'POST') {
      if (!host.plan_sub_id) return json({ ok: true, note: "You're on the free plan — nothing to cancel." });
      const { cancelSubscription } = await import('./pay.mjs');
      const out = await cancelSubscription(env, host.plan_sub_id);
      return json(out.ok ? { ok: true, note: `Done — ${host.tier} stays until ${host.plan_renews_at ?? 'the period ends'}, then won't charge again.` } : out, out.ok ? 200 : 502);
    }
  }
  return json({ error: 'not found' }, 404);
}
