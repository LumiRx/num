/**
 * orderalert.mjs — getting an order into a kitchen that is not reading email.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 * Dre, 12 Sep 2026: "we need to work a way to send notifcations to the
 * business of orders like doordash to their current systems so they dont need
 * to only use our dashboard."
 *
 * He is describing a real gap. `createOrder()` in delivery.mjs told a partner
 * exactly one way — an email, and only if they had set one. A restaurant at
 * 7pm on a Friday is not reading email, and it is certainly not refreshing a
 * dashboard. An order nobody sees is worse than no order: the guest is told
 * "you'll hear the moment they accept" and then hears nothing.
 *
 * ── THE FOUR CHANNELS, AND WHY EACH ONE ──────────────────────────────────
 *
 *   webhook  For a venue with a POS or their own software. The only route
 *            that reaches a real system without a partnership, and the one
 *            that scales to a chain. Signed, so they can prove it was us.
 *   sms      A text to the venue line, reply Y to accept. The channel a
 *            small shop actually watches.
 *   voice    A phone call that reads the order out and takes a keypress.
 *            Works on a landline in a kitchen with no smartphone, no app and
 *            no data. This is what reaches the shops nothing else reaches.
 *   email    The paper trail. Kept, demoted — it is a record, not an alert.
 *
 * ── WHY THEY FIRE TOGETHER AND NOT IN SEQUENCE ───────────────────────────
 * The tempting design is a ladder: text, wait, then call. It is wrong for the
 * first minute of an order. A guest is standing there watching "sent to the
 * restaurant" and every rung costs them the wait. So every enabled channel
 * fires at once, and the LADDER is used for escalation afterwards — if the
 * order is still unanswered a few minutes later, that is when the phone
 * rings.
 *
 * ── THE SECURITY PROPERTY THAT MATTERS ───────────────────────────────────
 * An SMS reply and a keypress are weak proofs on their own. What makes them
 * safe is that the reply must arrive FROM the number Num dialled or texted —
 * the venue's own registered line — and it can only move the one order that
 * line was told about. Knowing a short code is not enough; you must also be
 * holding the restaurant's phone. `acceptFrom()` enforces both, and refuses
 * any transition ORDER_NEXT does not allow.
 */

import { senderParams } from './twiliosender.mjs';

/** How long before an unanswered order escalates to a phone call. */
export const ESCALATE_AFTER_MIN = 4;

/** Channels, in the order a person would try them. */
export const CHANNELS = Object.freeze(['webhook', 'sms', 'voice', 'email']);

let ready = new WeakSet();
/** Reset for tests. Production never calls this. */
export function __resetReady() { ready = new WeakSet(); }

export async function ensure(env) {
  if (!env?.DB || ready.has(env.DB)) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS num_order_alerts (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       order_id    TEXT NOT NULL,
       business_id TEXT NOT NULL,
       channel     TEXT NOT NULL,
       target      TEXT,
       ok          INTEGER NOT NULL DEFAULT 0,
       detail      TEXT,
       escalation  INTEGER NOT NULL DEFAULT 0,
       at          TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  ).run().catch(() => {});
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS num_order_routes (
       business_id  TEXT PRIMARY KEY,
       sms_to       TEXT,
       voice_to     TEXT,
       webhook_url  TEXT,
       webhook_key  TEXT,
       email_to     TEXT,
       updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  ).run().catch(() => {});
  ready.add(env.DB);
}

/**
 * Where this business wants orders sent.
 *
 * Falls back to the venue's PUBLISHED phone when no route row exists, which
 * is the number on their own listing and the one a guest would ring. That
 * fallback is what makes a hand-onboarded pilot shop reachable on day one
 * without anybody filling in a form.
 */
export async function routeFor(env, businessId) {
  if (!env?.DB || !businessId) return null;
  await ensure(env);
  const row = await env.DB.prepare(
    'SELECT sms_to, voice_to, webhook_url, webhook_key, email_to FROM num_order_routes WHERE business_id=?1',
  ).bind(String(businessId)).first().catch(() => null);

  let published = null;
  if (!row?.sms_to || !row?.voice_to) {
    published = await env.DB.prepare(
      `SELECT p.phone FROM num_place_owners o JOIN places p ON p.id = o.place_id
        WHERE o.business_id = ?1 AND o.revoked_at IS NULL AND p.phone IS NOT NULL LIMIT 1`,
    ).bind(String(businessId)).first().catch(() => null);
  }
  const fallback = published?.phone ?? null;
  return {
    sms_to: row?.sms_to ?? fallback,
    voice_to: row?.voice_to ?? fallback,
    webhook_url: row?.webhook_url ?? null,
    webhook_key: row?.webhook_key ?? null,
    email_to: row?.email_to ?? null,
  };
}

/** Save a venue's routing. Console-facing; every field optional. */
export async function saveRoute(env, businessId, patch = {}) {
  if (!env?.DB || !businessId) return { ok: false, error: 'no business' };
  await ensure(env);
  const url = patch.webhook_url ? String(patch.webhook_url).trim() : null;
  // A webhook that is not HTTPS is an order posted in clear text across
  // somebody's network, containing a delivery address.
  if (url && !/^https:\/\//i.test(url)) return { ok: false, error: 'the webhook URL must start with https://' };
  await env.DB.prepare(
    `INSERT INTO num_order_routes (business_id, sms_to, voice_to, webhook_url, webhook_key, email_to, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,datetime('now'))
     ON CONFLICT(business_id) DO UPDATE SET
       sms_to=COALESCE(?2,sms_to), voice_to=COALESCE(?3,voice_to),
       webhook_url=COALESCE(?4,webhook_url), webhook_key=COALESCE(?5,webhook_key),
       email_to=COALESCE(?6,email_to), updated_at=datetime('now')`,
  ).bind(
    String(businessId),
    patch.sms_to ?? null, patch.voice_to ?? null, url,
    patch.webhook_key ?? null, patch.email_to ?? null,
  ).run();
  return { ok: true };
}

/** One line per item, short enough to be read aloud or fit a text. */
export const orderSummary = (lines = []) =>
  lines.map((l) => `${l.qty}x ${l.name}`).join(', ').slice(0, 300);

const money = (cs) => `$${((Number(cs) || 0) / 100).toFixed(2)}`;

async function log(env, { orderId, businessId, channel, target, ok, detail, escalation = 0 }) {
  await env.DB?.prepare(
    `INSERT INTO num_order_alerts (order_id, business_id, channel, target, ok, detail, escalation)
     VALUES (?1,?2,?3,?4,?5,?6,?7)`,
  ).bind(
    String(orderId), String(businessId), channel,
    target ? String(target).slice(0, 120) : null,
    ok ? 1 : 0, detail ? String(detail).slice(0, 300) : null, escalation ? 1 : 0,
  ).run().catch(() => {});
}

/* ── webhook ───────────────────────────────────────────────────────────── */

/**
 * Sign the body so a venue can prove the order came from Num.
 *
 * Timestamped and included in the signed payload: without the timestamp in
 * the signature, a captured request can be replayed at any point in the
 * future and still verify.
 */
export async function signBody(secret, body, ts) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sendWebhook(env, route, payload) {
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', 'X-Num-Timestamp': String(ts) };
  if (route.webhook_key) headers['X-Num-Signature'] = await signBody(route.webhook_key, body, ts);
  const res = await fetch(route.webhook_url, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
  return `HTTP ${res.status}`;
}

/* ── sms ───────────────────────────────────────────────────────────────── */

/**
 * The text, and why it is shaped like this.
 *
 * The short code goes in the reply, not just the message, because a busy
 * venue may have two orders in the same minute and "Y" on its own cannot say
 * which. Everything a kitchen needs is in the first line — the rest can be
 * cut off by a preview and nothing important is lost.
 */
export function smsBody({ short, partner, items, total, fulfilment }) {
  return `NUM order ${short} — ${orderSummary(items)}. ${money(total)} ${fulfilment === 'pickup' ? 'pickup' : 'delivery'}.\n`
    + `Reply Y ${short} to accept, N ${short} to decline. ${partner ? `(${partner})` : ''}`.trim();
}

async function sendSms(env, to, body) {
  const sender = senderParams(env);
  // Not "no phone number" — the Messaging Service is what carries the
  // approved A2P campaign, and without it every US send returns 30034.
  // See twiliosender.mjs for the month that cost.
  if (!sender) throw new Error('no Twilio sender configured');
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN) throw new Error('no Twilio credentials');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, ...sender, Body: body.slice(0, 400) }),
  });
  if (!res.ok) throw new Error(`twilio ${res.status} ${(await res.text()).slice(0, 120)}`);
  return 'sent';
}

/* ── voice ─────────────────────────────────────────────────────────────── */

/**
 * The call. Reads the order twice and takes one key.
 *
 * TwiML rather than a recorded prompt because the order is different every
 * time. Twice because a kitchen is loud and the first few words of a robocall
 * are the ones nobody listens to.
 *
 * `numDigits: 1` with a short timeout: anything longer and the call sits open
 * on the venue's line, which is the one thing a restaurant will not forgive.
 */
export function orderTwiml({ short, partner, items, total, callbackUrl }) {
  const say = `New Num order for ${partner || 'your venue'}. Order ${short.split('').join(' ')}. `
    + `${orderSummary(items)}. Total ${money(total)}. `
    + 'Press 1 to accept this order. Press 2 to decline.';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Response>'
    + `<Gather numDigits="1" timeout="8" action="${esc(callbackUrl)}" method="POST">`
    + `<Say voice="Polly.Joanna">${esc(say)}</Say>`
    + `<Say voice="Polly.Joanna">${esc(say)}</Say>`
    + '</Gather>'
    + '<Say voice="Polly.Joanna">No key pressed. The order is waiting in your Num console.</Say>'
    + '</Response>';
}

async function placeCall(env, to, twimlUrl) {
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN) throw new Error('no Twilio credentials');
  const from = String(env.TWILIO_VOICE_FROM || env.TWILIO_FROM || '').trim();
  // A Messaging Service SID cannot place a call — voice needs a real number,
  // and failing loudly here beats a 400 from Twilio nobody reads.
  if (!from) throw new Error('no TWILIO_VOICE_FROM configured');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Calls.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Url: twimlUrl, Method: 'GET' }),
  });
  if (!res.ok) throw new Error(`twilio voice ${res.status} ${(await res.text()).slice(0, 120)}`);
  return 'ringing';
}

/* ── the fan-out ───────────────────────────────────────────────────────── */

/**
 * Tell the venue, every way they have told us to.
 *
 * Never throws, and never lets one dead channel stop another: a venue with a
 * broken webhook must still get the phone call. Each attempt is recorded so
 * "we told them" is a fact on a row rather than an assumption.
 */
export async function alertOrder(env, order, { escalation = false, base } = {}) {
  if (!env?.DB || !order?.id) return { sent: [], failed: [] };
  await ensure(env);
  const route = await routeFor(env, order.business_id);
  if (!route) return { sent: [], failed: [] };

  const origin = base || env.APP_ORIGIN || 'https://app.itsnum.com';
  const sent = [];
  const failed = [];
  const attempt = async (channel, target, fn) => {
    if (!target) return;
    try {
      const detail = await fn();
      sent.push(channel);
      await log(env, { orderId: order.id, businessId: order.business_id, channel, target, ok: 1, detail, escalation });
    } catch (e) {
      failed.push({ channel, error: String(e?.message ?? e).slice(0, 160) });
      await log(env, { orderId: order.id, businessId: order.business_id, channel, target, ok: 0, detail: String(e?.message ?? e), escalation });
    }
  };

  // ESCALATION IS VOICE ONLY. Re-texting a venue that already has the text
  // is noise; the point of the second pass is to reach a channel the first
  // one did not.
  if (!escalation) {
    await attempt('webhook', route.webhook_url, () => sendWebhook(env, route, {
      event: 'order.created',
      order: {
        id: order.id, short_code: order.short, business_id: order.business_id,
        fulfilment: order.fulfilment ?? 'delivery',
        items: order.items, subtotal_cs: order.subtotal, delivery_fee_cs: order.fee, total_cs: order.total,
        area: order.area ?? null, note: order.note ?? null,
      },
      accept_url: `${origin}/api/orders/${encodeURIComponent(order.id)}`,
    }));
    await attempt('sms', route.sms_to, () => sendSms(env, route.sms_to, smsBody({
      short: order.short, partner: order.partner, items: order.items, total: order.total,
      fulfilment: order.fulfilment,
    })));
  }
  await attempt('voice', escalation ? route.voice_to : null, () => placeCall(
    env, route.voice_to, `${origin}/api/orders/voice/${encodeURIComponent(order.id)}`,
  ));
  return { sent, failed };
}

/**
 * The unanswered ones, for the cron.
 *
 * Only orders that are still `pending_business`, older than the escalation
 * window, and that have not already been escalated — a venue rung twice about
 * the same order stops answering the phone to us.
 */
export async function needsEscalation(env, { minutes = ESCALATE_AFTER_MIN, limit = 20 } = {}) {
  if (!env?.DB) return [];
  await ensure(env);
  const cutoff = Math.floor(Date.now() / 1000) - minutes * 60;
  const { results } = await env.DB.prepare(
    `SELECT o.id, o.short_code, o.business_id, o.total_cs, o.fulfilment, b.name AS partner
       FROM num_orders o JOIN businesses b ON b.id = o.business_id
      WHERE o.status = 'pending_business'
        AND o.created_at < ?1
        AND NOT EXISTS (SELECT 1 FROM num_order_alerts a WHERE a.order_id = o.id AND a.escalation = 1)
      ORDER BY o.created_at ASC LIMIT ?2`,
  ).bind(cutoff, Math.max(1, Math.min(50, limit))).all().catch(() => ({ results: [] }));
  return results ?? [];
}

/**
 * Accept or decline, from a phone.
 *
 * ── WHAT MAKES A KEYPRESS SAFE ───────────────────────────────────────────
 * Two facts have to line up: the order must be one Num actually told THIS
 * number about, and the number must match the route we dialled. Knowing a
 * short code is not enough — you have to be holding the restaurant's phone.
 *
 * And the transition still goes through ORDER_NEXT, so a keypress cannot do
 * anything the console could not.
 */
export async function acceptFrom(env, { from, orderId = null, short = null, decision }) {
  if (!env?.DB) return { ok: false, error: 'no database' };
  await ensure(env);
  const want = decision === 'accept' ? 'accepted' : 'declined';

  const order = orderId
    ? await env.DB.prepare('SELECT id, business_id, status FROM num_orders WHERE id=?1').bind(orderId).first().catch(() => null)
    : await env.DB.prepare('SELECT id, business_id, status FROM num_orders WHERE short_code=?1').bind(String(short ?? '').toUpperCase()).first().catch(() => null);
  if (!order) return { ok: false, error: 'no such order' };

  // The caller must be the line Num alerted for THIS order.
  const digits = (v) => String(v ?? '').replace(/\D+/g, '').slice(-10);
  const alerted = await env.DB.prepare(
    "SELECT target FROM num_order_alerts WHERE order_id=?1 AND channel IN ('sms','voice') AND ok=1",
  ).bind(order.id).all().catch(() => ({ results: [] }));
  const known = (alerted.results ?? []).map((r) => digits(r.target)).filter((d) => d.length >= 7);
  if (!known.includes(digits(from))) {
    return { ok: false, error: 'that number was not the one this order was sent to' };
  }

  const { decideOrder } = await import('./delivery.mjs');
  return await decideOrder(env, {
    businessId: order.business_id, orderId: order.id, status: want, actor: 'business',
    reason: `by ${decision === 'accept' ? 'keypress/SMS accept' : 'keypress/SMS decline'}`,
  });
}

/** Parse "Y A417" / "n a417" / "1" out of whatever the venue typed back. */
export function parseReply(text) {
  const t = String(text ?? '').trim().toUpperCase();
  const m = /^([YN12])\s*[- ]?\s*([A-Z0-9]{3,10})?$/.exec(t);
  if (!m) return null;
  return { decision: m[1] === 'Y' || m[1] === '1' ? 'accept' : 'decline', short: m[2] ?? null };
}
