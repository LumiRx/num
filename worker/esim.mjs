// eSIM — the doors and the wiring.
//
// Dre, 21 Sep 2026: "offer it to the users — just text and get your eSIM now,
// with your own concierge with it … price it better than everyone else, we
// just want the user … wire in another eSIM company until LetsGo2Trip is
// ready … for every airport in the world."
//
// What is where:
//   esimaccess.mjs   the stand-in supplier (LetsGo2Trip's eSIM API is due mid-Nov)
//   esimprice.mjs    undercut the market, never lose money unless told to
//   esimcatalogue    plans -> priced, deduped, three picks for a text
//   esimstore.mjs    the listing cache in D1, refreshed daily by the cron
//   esimorders.mjs   one row per purchase, guarded state moves
//   esimfulfil.mjs   paid -> supplier order -> installed, or refunded; never silent
//   esimtext.mjs     "text ESIM" — the whole purchase inside a text thread
//   esimpages.mjs    /esim, a page per country, per airport, the order page
//   esimstripe.mjs   hosted Checkout and refunds, through pay.mjs's client
//   THIS FILE        routes, the Stripe hook, the supplier doorbell, the cron,
//                    the admin door, and the concierge-by-text for buyers
//
// Everything here fails soft on a missing table or secret: before migration
// 0033 is applied and ESIMACCESS_ACCESS_CODE is set, every door answers in its
// own voice ("being set up") and nothing is sold.

import * as O from './esimorders.mjs';
import { refreshCatalogue, plansIn, planByCode, countryIndex, countryEntry, catalogueStatus } from './esimstore.mjs';
import { esimAccessDriver, parseWebhook } from './esimaccess.mjs';
import { fulfil, sweep, onDoorbell, refundAndTell } from './esimfulfil.mjs';
import { handleEsimText } from './esimtext.mjs';
import { createCheckout, sessionPays, refundDuplicate, refundPayment } from './esimstripe.mjs';
import { renderHome, renderCountry, renderAirport, renderRegion, renderOrder, renderMessage, renderSitemap } from './esimpages.mjs';
import { resolveDestination, airport as airportRow, countryName, REGION_LABELS } from './esimplaces.mjs';
import { page as P, smsSafe } from './esimcopy.mjs';
import { adminGuard } from './adminkey.mjs';

export const ORIGIN = 'https://app.itsnum.com';

// ---- plumbing ---------------------------------------------------------------

const html = (body, { status = 200, cache = 'no-store', noindex = false } = {}) =>
  new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': cache,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...(noindex ? { 'X-Robots-Tag': 'noindex' } : {}),
    },
  });
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const redirect = (to, status = 303) => new Response(null, { status, headers: { Location: to, 'Cache-Control': 'no-store' } });
const message = (title, body, status = 200) => { const m = renderMessage({ title, body, status }); return html(m.html, { status: m.status, noindex: true }); };

/** Is the eSIM schema in this database yet? Cached per isolate once true. */
let schemaSeen = false;
async function schemaReady(env) {
  if (schemaSeen) return true;
  if (!env?.DB) return false;
  const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'num_esim_orders'").first().catch(() => null);
  schemaSeen = Boolean(r);
  return schemaSeen;
}

async function meta(db, key) {
  return (await db.prepare('SELECT value, updated_at FROM num_esim_meta WHERE key = ?').bind(key).first().catch(() => null)) || null;
}
async function setMeta(db, key, value) {
  await db.prepare('INSERT INTO num_esim_meta (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, String(value), new Date().toISOString()).run().catch(() => null);
}

export function drivers(env) {
  // Tests hand in fakes through env; a real Worker env only ever holds strings.
  if (Array.isArray(env?.ESIM_TEST_DRIVERS)) return env.ESIM_TEST_DRIVERS;
  // LetsGo2Trip joins this list the day their eSIM API exists (docs due
  // mid-November). The catalogue already merges suppliers and keeps the
  // cheapest plan for each shape, so adding them is a driver, not a rebuild.
  return [esimAccessDriver(env)];
}
export const driverFor = (env) => (id) => drivers(env).find((d) => d.id === id) || null;

/** How Num reaches a traveller. Every text checks the opt-out list first. */
export function notifier(env) {
  return {
    async sms(to, body, { channel } = {}) {
      const { optedOut } = await import('./optout.mjs');
      if (await optedOut(env, to).catch(() => true)) return { ok: false, error: 'opted out' };
      if (channel === 'whatsapp') {
        const w = await import('./whatsapp.mjs');
        if (w.enabled(env)) return { ok: await w.sendWhatsApp(env, to, body).catch(() => false) };
      }
      const { sendText } = await import('./friendtext.mjs');
      return sendText(env, { to, body });
    },
    async email(to, subject, text) {
      const { send, AUDIENCE } = await import('./mailer.mjs');
      // bulk: true keeps the standing BCC off. This email carries the codes
      // that install somebody's eSIM; a copy in a shared mailbox is a copy of
      // their eSIM.
      return send(env, { to, subject, text, bulk: true }, { audience: AUDIENCE.EXTERNAL });
    },
    async alert(text) {
      if (typeof env?.ESIM_TEST_ALERT === 'function') return env.ESIM_TEST_ALERT(text);
      const { alert } = await import('./health.mjs');
      return alert(env, `[esim] ${text}`).catch(() => null);
    },
  };
}

export function deps(env, extra = {}) {
  return {
    origin: ORIGIN,
    driverFor: driverFor(env),
    notify: notifier(env),
    // Whether the delivery text may say "just text me" (see esimcopy.mjs).
    textConcierge: String(env?.SMS_CONCIERGE ?? '').trim() === 'on',
    ...extra,
  };
}

/**
 * May we take money for an eSIM right now? Only if a supplier is configured,
 * the listing has plans, and the prepaid supplier balance can cover a sale.
 * Selling what we would then have to refund is worse than not selling.
 */
export async function salesOpen(env, { now = Date.now() } = {}) {
  if (String(env?.ESIM_SALES ?? '').trim() === 'off') return false;
  if (!(await schemaReady(env))) return false;
  const driver = drivers(env).find((d) => d.ready());
  if (!driver) return false;
  const cat = await catalogueStatus(env.DB).catch(() => ({ plans: 0 }));
  if (!cat.plans) return false;
  const floor = Number(env.ESIM_MIN_BALANCE_CS ?? 1000);
  const cached = await meta(env.DB, 'balance_cs');
  if (cached && now - Date.parse(cached.updated_at) < 10 * 60000) return Number(cached.value) >= floor;
  const b = await driver.balance().catch(() => ({ ok: false }));
  if (!b.ok) return true; // unknown balance: sell, and let the refund path cover a refusal
  await setMeta(env.DB, 'balance_cs', b.balanceCs);
  return b.balanceCs >= floor;
}

async function recordInboundConsent(env, phone, text) {
  const c = await import('./smsconsent.mjs');
  return c.record(env, { phone, source: c.SOURCE.INBOUND_SMS, consentText: c.inboundConsentText(text), page: 'app.itsnum.com/esim' });
}

// ---- the text door (SMS and WhatsApp) ------------------------------------------

/** Called from sms.mjs and whatsapp.mjs. Returns { handled, reply }. */
export async function esimText(env, { from, body, channel = 'sms' }) {
  if (!(await schemaReady(env))) return { handled: false };
  return handleEsimText(env, env.DB, { from, body, channel }, {
    origin: ORIGIN,
    // The SMS register records people who texted the SMS line. A WhatsApp
    // message is not that, and must not put a number on the SMS list.
    recordConsent: channel === 'sms' ? (phone) => recordInboundConsent(env, phone, body) : null,
    salesOpen: () => salesOpen(env),
  });
}

/** Strip a concierge answer down to something a text message can carry. */
export function forText(reply, max = 600) {
  let s = String(reply ?? '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[*•]\s+/gm, '- ')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 $2');
  s = smsSafe(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 40);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return `${(end > max / 2 ? cut.slice(0, end + 1) : cut).trim()} More in the app: app.itsnum.com`;
}

/**
 * "Your own concierge with it." A traveller who bought an eSIM from us and
 * texts the number gets the same concierge the app has, answered by text.
 *
 * Only eSIM buyers, deliberately. The same number receives venues answering
 * orders, drivers saying "I'm outside" and suppliers sending photos; those
 * land in the inbox as before and must never get a chatbot reply.
 * Off until SMS_CONCIERGE=on. Capped per number per day.
 */
export async function conciergeByText(env, ctx, { from, text, member = null }, { ask } = {}) {
  if (String(env?.SMS_CONCIERGE ?? '').trim() !== 'on') return false;
  if (!text || !(await schemaReady(env))) return false;
  const since = new Date(Date.now() - 90 * 86400e3).toISOString();
  const buyer = await env.DB.prepare("SELECT id FROM num_esim_orders WHERE phone = ? AND state IN ('paid','ordering','ready') AND created_at >= ? LIMIT 1").bind(from, since).first().catch(() => null);
  if (!buyer) return false;
  const { optedOut } = await import('./optout.mjs');
  if (await optedOut(env, from).catch(() => true)) return false;
  const day = new Date().toISOString().slice(0, 10);
  const cap = Number(env.SMS_CONCIERGE_DAILY_CAP ?? 30);
  const used = await env.DB.prepare('SELECT n FROM num_esim_text_usage WHERE phone = ? AND day = ?').bind(from, day).first('n').catch(() => 0);
  if ((used ?? 0) >= cap) return false;
  await env.DB.prepare('INSERT INTO num_esim_text_usage (phone, day, n) VALUES (?,?,1) ON CONFLICT(phone, day) DO UPDATE SET n = n + 1').bind(from, day).run().catch(() => null);

  const work = (async () => {
    let reply = '';
    try {
      reply = await (ask ?? defaultAsk)(env, ctx, {
        messages: [{ role: 'user', content: text }],
        state: member ? { me: { id: member.id, name: member.name ?? null }, channel: 'sms' } : { anon: `sms:${from}`, channel: 'sms' },
      }, from);
    } catch (e) {
      console.warn('[esim] text concierge failed:', e?.message ?? e);
    }
    const body = forText(reply) || 'Num: I could not get to that just now. Give me a minute and ask again.';
    const { sendText } = await import('./friendtext.mjs');
    const r = await sendText(env, { to: from, body }).catch((e) => ({ ok: false, error: String(e) }));
    if (!r?.ok) console.warn(`[esim] text concierge reply to ${from.slice(0, 5)}... not accepted: ${r?.error}`);
  })();
  if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
  return true;
}

async function defaultAsk(env, ctx, payload, phone) {
  const { handleNum } = await import('./index.mjs');
  const res = await handleNum(new Request(`${ORIGIN}/api/num`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `sms:${phone}` },
    body: JSON.stringify(payload),
  }), env, ctx ?? { waitUntil() {} });
  if (!res.ok) throw new Error(`concierge ${res.status}`);
  const j = await res.json();
  return typeof j?.reply === 'string' ? j.reply : '';
}

// ---- Stripe ---------------------------------------------------------------------

/**
 * The marketing box, honoured once the order is paid. Recorded at payment
 * rather than at the form, so nobody can sign a stranger's number up for
 * offers just by typing it in; and never over a number that has opted out,
 * because a ticked box on an eSIM form is not the same person saying START.
 */
async function recordMarketingConsent(env, orderId) {
  try {
    const o = await O.getById(env.DB, orderId);
    if (!o?.marketing_ok || !o.phone) return;
    // No evidence left (the quote expired before a late payment revived it):
    // a consent we cannot evidence is not recorded.
    if (!o.consent_ip) return;
    const prior = await env.DB.prepare('SELECT revoked_at FROM num_sms_consent WHERE phone = ?').bind(o.phone).first().catch(() => null);
    const { optedOut } = await import('./optout.mjs');
    const blocked = Boolean(prior?.revoked_at) || (await optedOut(env, o.phone).catch(() => true));
    if (!blocked) {
      const c = await import('./smsconsent.mjs');
      await c.record(env, {
        phone: o.phone, source: c.SOURCE.WEB_FORM, consentText: P.marketingConsent, page: `${ORIGIN}/esim`,
        ip: o.consent_ip, userAgent: o.consent_ua, country: o.consent_country,
      });
    }
    await O.clearConsentEvidence(env.DB, orderId);
  } catch (e) {
    console.warn('[esim] marketing consent not recorded:', e?.message ?? e);
  }
}

/** From pay.mjs's signed webhook, for a completed session with kind=esim. */
export async function onCheckoutCompleted(env, session, ctx) {
  // An error, not "ignored": pay.mjs answers Stripe with a 5xx for errors, so
  // Stripe keeps retrying (for days) until the tables are there. A payment
  // acknowledged here and then dropped would be money with no order behind it.
  if (!(await schemaReady(env))) return { error: 'eSIM tables missing' };
  const d = deps(env);
  const order = await O.getById(env.DB, String(session?.metadata?.num_esim || session?.client_reference_id || ''));
  if (!order) {
    await d.notify.alert(`paid session ${session?.id} names no eSIM order (${session?.metadata?.num_esim}). Refund it in Stripe.`);
    return { ignored: 'no such order' };
  }
  const check = sessionPays(session, order);
  if (!check.ok) {
    // Our server set the amount, so this should never happen. If it does,
    // the money goes straight back rather than sitting against an order we
    // will not fill.
    const r = session?.payment_intent ? await refundPayment(env, session.payment_intent, order.id, { reason: 'requested_by_customer', key: `esim_mismatch_${session.payment_intent}` }) : { ok: false, error: 'no payment intent' };
    await O.markAttention(env.DB, order.id, ['quoted', 'checkout'], `payment did not match the order: ${check.reason}`);
    await d.notify.alert(`order ${order.id}: payment did not match (${check.reason}). Not fulfilled; ${r.ok ? 'refunded automatically' : `refund FAILED (${r.error}) - refund ${session?.payment_intent} by hand`}.`);
    if (!r.ok && session?.payment_intent) return { error: `refund of ${session.payment_intent} failed: ${r.error}` };
    return { state: 'attention' };
  }
  const moved = await O.markPaid(env.DB, order.id, {
    sessionId: session.id,
    paymentIntent: session.payment_intent,
    paidCs: session.amount_total,
    email: session.customer_details?.email,
    phone: session.customer_details?.phone,
    name: session.customer_details?.name,
  });
  if (!moved) {
    // Read again: the copy above was taken before markPaid, and a second
    // session completing at the same moment must be judged on what is true now.
    const now = await O.getById(env.DB, order.id);
    if (now?.stripe_pi && now.stripe_pi === session.payment_intent) return { state: now.state, repeat: true };
    if (!session.payment_intent) {
      await d.notify.alert(`order ${order.id}: a completed session ${session.id} could not be applied (order is ${now?.state}) and carries no payment intent. Check it in Stripe.`);
      return { state: now?.state, unapplied: true };
    }
    // A payment this order cannot use: a second payment for an order already
    // paid (two tabs, two taps), or one for an order that has already been
    // refunded or handed to a person. The money goes straight back.
    const r = now?.stripe_pi
      ? await refundDuplicate(env, session.payment_intent, order.id)
      : await refundPayment(env, session.payment_intent, order.id, { reason: 'requested_by_customer', key: `esim_unapplied_${session.payment_intent}` });
    await d.notify.alert(`order ${order.id} (${now?.state}) got a payment it cannot use; it ${r.ok ? 'was refunded' : `could NOT be refunded (${r.error}) - refund ${session.payment_intent} by hand`}.`);
    // A failed refund is an error so Stripe sends the event again, and the
    // refund is retried under the same idempotency key.
    if (!r.ok) return { error: `refund of ${session.payment_intent} failed: ${r.error}` };
    return { state: now?.stripe_pi ? 'duplicate_refunded' : 'unapplied_refunded' };
  }
  await recordMarketingConsent(env, order.id);
  const work = fulfil(env, env.DB, order.id, d).catch(async (e) => {
    await d.notify.alert(`order ${order.id}: fulfilment crashed (${e?.message ?? e}); the sweep will retry.`);
    return { error: String(e?.message ?? e) };
  });
  if (ctx?.waitUntil) { ctx.waitUntil(work); return { state: 'paid' }; }
  return work;
}

// ---- the pages -----------------------------------------------------------------------

export async function handleEsimPage(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/esim';
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('no', { status: 405 });
  if (!(await schemaReady(env))) return message('eSIMs are nearly here', 'Num eSIMs are being set up right now. Check back soon.', 503);
  const db = env.DB;

  if (path === '/esim') {
    const countries = await countryIndex(db).catch(() => []);
    return html(renderHome({ env, countries, origin: ORIGIN }), { cache: 'public, max-age=300' });
  }

  if (path === '/esim/sitemap.xml') {
    const countries = (await countryIndex(db).catch(() => [])).map((c) => c.country);
    const covered = new Set(countries);
    const { AIRPORTS } = await import('./esimairports.data.mjs');
    const airports = AIRPORTS.filter((a) => covered.has(a[3]) && a[4] === 'L').map((a) => a[0]);
    return new Response(renderSitemap({ origin: ORIGIN, countries, airports }), { headers: { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=3600' } });
  }

  if (path === '/esim/find') {
    const r = resolveDestination(`esim ${url.searchParams.get('q') || ''}`);
    if (r.kind === 'airport') return redirect(`/esim/airport/${r.airport[0].toLowerCase()}`, 302);
    if (r.kind === 'country') return redirect(`/esim/${r.country.toLowerCase()}`, 302);
    if (r.kind === 'region') return redirect(`/esim/region/${r.region.toLowerCase()}`, 302);
    return message("We couldn't place that", 'Try a country name, a city or a three-letter airport code, like Thailand, Bangkok or BKK.', 404);
  }

  let m = /^\/esim\/([a-z]{2})$/i.exec(path);
  if (m) {
    const code = m[1].toUpperCase();
    if (!countryName(code)) return message('Not a place we know', 'Try the search on the eSIM page.', 404);
    const plans = await plansIn(db, { country: code }).catch(() => []);
    return html(renderCountry({ env, code, plans, origin: ORIGIN }), { cache: 'public, max-age=300' });
  }

  m = /^\/esim\/airport\/([a-z]{3})$/i.exec(path);
  if (m) {
    const a = airportRow(m[1]);
    if (!a) return message('Not an airport we know', 'Try the search on the eSIM page.', 404);
    const plans = await plansIn(db, { country: a[3] }).catch(() => []);
    return html(renderAirport({ env, airport: a, plans, origin: ORIGIN }), { cache: 'public, max-age=300' });
  }

  m = /^\/esim\/region\/([a-z]{2,5})$/i.exec(path);
  if (m) {
    const region = m[1].toUpperCase();
    if (!REGION_LABELS[region]) return message('Not a region we know', 'Try the search on the eSIM page.', 404);
    const plans = await plansIn(db, { region }).catch(() => []);
    const label = REGION_LABELS[region].replace(/^the /, '');
    return html(renderRegion({ env, region, label: label.charAt(0).toUpperCase() + label.slice(1), plans, origin: ORIGIN }), { cache: 'public, max-age=300' });
  }

  m = /^\/esim\/pay\/([A-Za-z0-9_-]{16,64})$/.exec(path);
  if (m) return payPage(env, m[1]);

  m = /^\/esim\/o\/([A-Za-z0-9_-]{16,64})$/.exec(path);
  if (m) {
    const order = await O.getByToken(db, m[1]);
    if (!order) return message('Not found', 'This link does not match an order. Check the link in your text or email.', 404);
    // Stripe sends people here the moment they pay, which can be a second
    // before its webhook reaches us. ?paid=1 changes the WORDING only; the
    // order is not treated as paid until Stripe has signed for it.
    // 'expired' too: a Checkout page opened before expiry can be paid after it,
    // and that payment revives the order (esimorders.mjs markPaid).
    const shown = url.searchParams.get('paid') === '1' && ['quoted', 'checkout', 'expired'].includes(order.state) ? { ...order, state: 'paid' } : order;
    const concierge = { sms: String(env.SMS_CONCIERGE ?? '').trim() === 'on' };
    return html(renderOrder({ env, order: shown, concierge }), { noindex: true });
  }

  return message('Not found', 'That page does not exist.', 404);
}

async function payPage(env, token) {
  const db = env.DB;
  const order = await O.getByToken(db, token);
  if (!order) return message('Not found', 'This payment link does not match an order.', 404);
  if (['paid', 'ordering', 'ready', 'refunding', 'refunded', 'attention'].includes(order.state)) return redirect(`/esim/o/${order.token}`);
  if (order.state === 'expired') return html(renderOrder({ env, order }), { noindex: true });
  const reuse = O.reusableCheckout(order);
  if (reuse) return redirect(reuse);
  if (!(await salesOpen(env))) return message('Paused for a few minutes', 'eSIM sales are paused for a few minutes. Nothing was charged. Please try again shortly.', 503);
  const plan = await planByCode(db, order.provider, order.plan_code);
  if (!plan || plan.costUnits !== order.cost_units) {
    await O.expireOne(db, order.id).catch(() => null);
    return message('That plan just changed', 'The supplier updated this plan a moment ago. Nothing was charged. Pick again from the current list.', 409);
  }
  const s = await createCheckout(env, order, { origin: ORIGIN, attempt: order.checkout_attempts ?? 0 });
  if (!s.ok) {
    await notifier(env).alert(`checkout did not open for ${order.id}: ${s.error}`);
    return message('The payment page did not open', 'Nothing was charged. Please try the link again in a minute.', 502);
  }
  await O.markCheckout(db, order.id, s.id, s.url);
  return redirect(s.url);
}

// ---- the API ---------------------------------------------------------------------------

async function readBody(request) {
  const type = request.headers.get('Content-Type') || '';
  if (type.includes('application/json')) return { data: await request.json().catch(() => ({})), form: false };
  const f = new URLSearchParams(await request.text().catch(() => ''));
  return { data: Object.fromEntries(f), form: true };
}

export function e164(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const digits = s.replace(/[\s().-]/g, '');
  const withPlus = digits.startsWith('00') ? `+${digits.slice(2)}` : digits;
  return /^\+[1-9]\d{6,14}$/.test(withPlus) ? withPlus : false;
}

async function ipHash(env, request) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!ip) return null;
  const data = new TextEncoder().encode(`${env.ESIM_IP_SALT || 'num-esim'}:${ip}`);
  const h = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(h)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function handleEsimApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');

  // The supplier's doorbell. Unsigned by the supplier, so the secret lives in
  // the URL we registered with them, and even then nothing in the body is
  // believed: it only says which order to re-read through the signed-in API.
  const bell = /^\/api\/esim\/doorbell\/([A-Za-z0-9_-]{16,128})$/.exec(path);
  if (bell) {
    const secret = String(env.ESIMACCESS_WEBHOOK_SECRET || '');
    if (!secret || !timingSafeEqual(bell[1], secret) || request.method !== 'POST') return new Response('not found', { status: 404 });
    if (!(await schemaReady(env))) return json({ ok: true, ignored: 'not set up' });
    const body = await request.json().catch(() => null);
    const parsed = parseWebhook(body);
    const work = onDoorbell(env, env.DB, parsed, deps(env)).catch((e) => console.warn('[esim] doorbell', e?.message ?? e));
    if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
    return json({ ok: true });
  }

  if (!(await schemaReady(env))) return json({ error: 'eSIMs are being set up' }, 503);
  const db = env.DB;

  if (path === '/api/esim/plans' && request.method === 'GET') {
    const a = url.searchParams.get('airport') ? airportRow(url.searchParams.get('airport')) : null;
    const country = a ? a[3] : String(url.searchParams.get('country') || '').toUpperCase();
    const region = String(url.searchParams.get('region') || '').toUpperCase();
    const plans = region && REGION_LABELS[region] ? await plansIn(db, { region }) : /^[A-Z]{2}$/.test(country) ? await plansIn(db, { country }) : [];
    const entry = country ? await countryEntry(db, country) : null;
    return json({
      country: country || null,
      airport: a ? a[0] : null,
      from_cs: entry?.from_cs ?? null,
      page: a ? `${ORIGIN}/esim/airport/${a[0].toLowerCase()}` : country ? `${ORIGIN}/esim/${country.toLowerCase()}` : `${ORIGIN}/esim`,
      plans: plans.map((p) => ({ id: `${p.provider}:${p.code}`, data_mb: p.dataMb, unlimited: p.unlimited, days: p.days, price_cs: p.priceCs, scope: p.scope, countries: p.countries.length })),
    });
  }

  if (path === '/api/esim/quote' && request.method === 'POST') {
    const { data, form } = await readBody(request);
    const fail = (title, body, status = 400) => (form ? message(title, body, status) : json({ error: body }, status));
    if (!(await salesOpen(env))) return fail('Paused for a few minutes', 'eSIM sales are paused for a few minutes. Nothing was charged. Please try again shortly.', 503);
    const [provider, code] = String(data.plan || '').split(':');
    const plan = provider && code ? await planByCode(db, provider, code) : null;
    if (!plan) return fail('Pick a plan', 'That plan is not available any more. Go back and pick one from the list.', 404);
    const a = data.airport ? airportRow(data.airport) : null;
    const country = a ? a[3] : String(data.country || '').toUpperCase();
    const region = String(data.region || '').toUpperCase();
    if (region ? !REGION_LABELS[region] : !(/^[A-Z]{2}$/.test(country) && plan.countries.includes(country))) {
      return fail('That plan does not cover it', 'That plan does not cover where you are going. Go back and pick another.', 400);
    }
    const phone = e164(data.phone);
    if (phone === false) return fail('Check the mobile number', 'Include the country code, for example +1 555 123 4567 or +44 7700 900123.', 400);
    const smsOk = data.sms_ok === '1' || data.sms_ok === true;
    const marketingOk = data.marketing_ok === '1' || data.marketing_ok === true;
    if ((smsOk || marketingOk) && !phone) return fail('Add your mobile number', 'To get texts, add your mobile number with its country code.', 400);

    const hash = await ipHash(env, request);
    const hourAgo = new Date(Date.now() - 3600e3).toISOString();
    if ((await O.countRecent(db, { ipHash: hash, sinceIso: hourAgo })) >= 20 || (phone && (await O.countRecent(db, { phone, sinceIso: hourAgo })) >= 10)) {
      return fail('Slow down a little', 'That is a lot of orders in a short time. Please try again in an hour.', 429);
    }
    if (phone && (await O.countRecent(db, { phone, sinceIso: new Date(Date.now() - 86400e3).toISOString(), paidOnly: true })) >= 3) {
      return fail('That is plenty for today', 'This number already has three eSIMs from today. Text us if you need more.', 429);
    }
    const dest = region ? { label: REGION_LABELS[region].replace(/^the /, ''), region } : { label: countryName(country), country, airport: a ? a[0] : null };
    // The marketing box is recorded as consent only once this order is paid
    // (recordMarketingConsent). Until then its evidence waits on the order.
    const consent = marketingOk && phone
      ? { ip: request.headers.get('CF-Connecting-IP'), userAgent: request.headers.get('User-Agent'), country: request.headers.get('CF-IPCountry') }
      : null;
    const q = await O.createQuote(db, {
      plan, dest, channel: data.channel === 'app' ? 'app' : 'web', phone: phone || null, email: data.email || null,
      smsOk, marketingOk, consent, ipHash: hash, ref: data.ref || url.searchParams.get('ref'), utm: data.utm || null,
    });
    if (!q.ok) return fail('Could not start that order', 'Please pick the plan again.', 400);
    const payUrl = `${ORIGIN}/esim/pay/${q.order.token}`;
    return form ? redirect(payUrl) : json({ ok: true, pay_url: payUrl, order_url: `${ORIGIN}/esim/o/${q.order.token}`, price_cs: q.order.price_cs });
  }

  const status = /^\/api\/esim\/order\/([A-Za-z0-9_-]{16,64})$/.exec(path);
  if (status && request.method === 'GET') {
    const o = await O.getByToken(db, status[1]);
    if (!o) return json({ error: 'not found' }, 404);
    return json({ state: o.state, dest: o.dest_label, plan: o.plan_label, price_cs: o.price_cs, ready: o.state === 'ready' });
  }

  return json({ error: 'not found' }, 404);
}

function timingSafeEqual(a, b) {
  const x = String(a); const y = String(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

// ---- the owner's door --------------------------------------------------------------------

/** GET: the whole picture. POST {action: refresh | sweep | refund, id?}. */
export async function handleEsimAdmin(request, env, ctx) {
  const denied = adminGuard(request, env, { 'Content-Type': 'application/json' });
  if (denied) return denied;
  if (!(await schemaReady(env))) return json({ error: 'migration 0064_esim.sql is not applied' }, 503);
  const db = env.DB;
  const d = deps(env);

  if (request.method === 'GET') {
    const ds = drivers(env);
    const ready = ds.find((x) => x.ready());
    const balance = ready ? await ready.balance().catch((e) => ({ ok: false, error: String(e) })) : null;
    const { results: attention } = await db.prepare("SELECT id, state, dest_label, plan_label, paid_cs, error, created_at FROM num_esim_orders WHERE state = 'attention' ORDER BY updated_at DESC LIMIT 20").all();
    const { results: recent } = await db.prepare("SELECT id, state, channel, dest_label, plan_label, price_cs, paid_cs, created_at FROM num_esim_orders WHERE state NOT IN ('quoted','expired') ORDER BY created_at DESC LIMIT 10").all();
    return json({
      suppliers: ds.map((x) => ({ id: x.id, configured: x.ready() })),
      balance,
      sales_open: await salesOpen(env),
      catalogue: await catalogueStatus(db),
      orders: await O.orderStats(db),
      attention,
      recent,
      text_concierge: String(env.SMS_CONCIERGE ?? '').trim() === 'on',
      doorbell_configured: Boolean(env.ESIMACCESS_WEBHOOK_SECRET),
    });
  }

  const body = await request.json().catch(() => ({}));
  if (body.action === 'refresh') return json(await refreshCatalogue(db, drivers(env), env));
  if (body.action === 'sweep') return json(await sweep(env, db, d));
  if (body.action === 'refund') {
    // By order id, or by the token at the end of the install link — whichever
    // is to hand. Every refund goes through refundAndTell, which claims the
    // order first, so a refund here can never race a delivery or another refund.
    const order = body.id ? await O.getById(db, String(body.id)) : await O.getByToken(db, String(body.token || ''));
    if (!order) return json({ error: 'no such order' }, 404);
    const force = body.force === true;
    const reason = String(body.reason || 'refunded by Num').slice(0, 200);
    const driver = d.driverFor(order.provider);
    if (order.state === 'ready') {
      // Cancel with the supplier first: if the traveller has not installed it,
      // the supplier gives Num its money back too. No profile number, no cancel,
      // so that needs a deliberate force.
      if (!order.esim_tran_no && !force) return json({ error: 'this order has no supplier profile number, so it cannot be cancelled with the supplier first. Send {"force":true} to refund anyway at our cost.' }, 409);
      if (order.esim_tran_no) {
        const c = await driver?.cancel({ esimTranNo: order.esim_tran_no }).catch((e) => ({ ok: false, error: String(e) }));
        if (!c?.ok && !force) return json({ error: `the supplier would not cancel it (probably already installed): ${c?.error}. Send {"force":true} to refund anyway at our cost.` }, 409);
      }
      return json(await refundAndTell(env, db, order, 'ready', reason, d));
    }
    if (order.state === 'paid') return json(await refundAndTell(env, db, order, 'paid', reason, d));
    if (order.state === 'attention') {
      // A person has decided. If a profile exists it was never delivered;
      // cancelling it gets Num's money back from the supplier.
      let cancelled = null;
      if (order.esim_tran_no) cancelled = await driver?.cancel({ esimTranNo: order.esim_tran_no }).catch((e) => ({ ok: false, error: String(e) }));
      const r = await refundAndTell(env, db, order, 'attention', reason, d);
      return json(cancelled && !cancelled.ok ? { ...r, supplier: `not cancelled (${cancelled.error}); cancel ${order.esim_tran_no} in the supplier console` } : r);
    }
    if (order.state === 'ordering') {
      if (!force) return json({ error: 'the supplier is still working on this order. Wait for the sweep (it finishes the order or pages you within the hour), or send {"force":true} to refund now.' }, 409);
      const r = await refundAndTell(env, db, order, 'ordering', reason, d);
      return json({ ...r, note: order.provider_order_no ? `if the supplier still delivers order ${order.provider_order_no}, its doorbell makes Num cancel the profile; check their console tomorrow to be sure` : 'no supplier order number was recorded; check the supplier console for this transaction id tomorrow' });
    }
    if (order.state === 'refunding') return json({ error: 'a refund for this order is already under way' }, 409);
    return json({ error: `cannot refund an order in state ${order.state}` }, 409);
  }
  return json({ error: 'unknown action' }, 400);
}

// ---- the cron ------------------------------------------------------------------------------

/** Every five minutes: push stuck orders along. Daily: refresh the listing. Hourly: watch the balance. */
export async function esimCron(env, { now = Date.now() } = {}) {
  if (!(await schemaReady(env))) return { skipped: 'eSIM tables missing' };
  const db = env.DB;
  const d = deps(env);
  const out = { sweep: await sweep(env, db, d, { now }) };

  const ready = drivers(env).find((x) => x.ready());
  if (!ready) return out;

  const cat = await catalogueStatus(db);
  if (!cat.refreshedAt || now - Date.parse(cat.refreshedAt) > 20 * 3600e3) {
    const last = await meta(db, 'refresh_tried');
    if (!last || now - Date.parse(last.updated_at) > 3600e3) {
      await setMeta(db, 'refresh_tried', now);
      out.refresh = await refreshCatalogue(db, drivers(env), env);
      if (!out.refresh.ok) await d.notify.alert(`listing refresh failed: ${JSON.stringify(out.refresh.providers)}`);
    }
  }

  const checked = await meta(db, 'balance_checked');
  if (!checked || now - Date.parse(checked.updated_at) > 3600e3) {
    await setMeta(db, 'balance_checked', now);
    const b = await ready.balance().catch(() => ({ ok: false }));
    if (b.ok) {
      await setMeta(db, 'balance_cs', b.balanceCs);
      const warnAt = Number(env.ESIM_BALANCE_ALERT_CS ?? 5000);
      const warned = await meta(db, 'balance_warned');
      if (b.balanceCs < warnAt && (!warned || now - Date.parse(warned.updated_at) > 12 * 3600e3)) {
        await setMeta(db, 'balance_warned', now);
        await d.notify.alert(`supplier balance is $${(b.balanceCs / 100).toFixed(2)}. Top up ${ready.id} before it runs out; sales pause below $${(Number(env.ESIM_MIN_BALANCE_CS ?? 1000) / 100).toFixed(2)}.`);
      }
      out.balanceCs = b.balanceCs;
    }
  }
  return out;
}
