// WhatsApp as a front door.
//
// Num's customer is a person far from home with a phone in their hand. That
// phone already has WhatsApp on it. Until now the only way to talk to Num
// was to install an app; this makes Num a contact instead.
//
// ── What this is NOT ─────────────────────────────────────────────────────
//
// It is not a second concierge. Every message here goes through the same
// `handleNum` the app uses — same brain, same grounding, same directory,
// same durable facts (memory.mjs), same thread (turns.mjs). A verified
// member who messages from the number on their account gets THEIR Num,
// mid-thought. Anyone else gets a thread keyed on their WhatsApp number,
// which becomes theirs the day they verify that number in the app.
//
// ── How Twilio delivers it ───────────────────────────────────────────────
//
// The same webhook shape as SMS: form-encoded POST, `From: whatsapp:+66…`,
// `Body`, signed with the account token. The signature is checked before a
// word is believed (sms.mjs validSignature) — an unsigned webhook is an
// open mailbox.
//
// Twilio gives a webhook 15 seconds. A real answer can take longer, so the
// webhook is acknowledged immediately with empty TwiML and the answer is
// sent as a separate outbound message from `ctx.waitUntil`. Replying to an
// inbound message is inside WhatsApp's 24-hour service window, so no
// template is needed and nothing here ever messages first.
//
// ── Dark until switched on ───────────────────────────────────────────────
//
// `WHATSAPP_ENABLED=true` and `TWILIO_WHATSAPP_FROM=whatsapp:+1…` (a sender
// approved for WhatsApp in the Twilio console, or the sandbox number while
// testing). Without both, the route answers 503 — the BOOKDESK_ENABLED
// pattern. A half-configured door stays shut.

import { validSignature } from './sms.mjs';

const PUBLIC_PATH = '/api/whatsapp/inbound';
export const MAX_REPLY = 1500;   // WhatsApp allows 4096; a concierge answer that needs more is a list, not an answer
const MAX_INBOUND = 1600;

const xmlOk = () =>
  new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    headers: { 'Content-Type': 'text/xml' },
  });

export const enabled = (env) =>
  String(env?.WHATSAPP_ENABLED ?? '').trim() === 'true' &&
  /^whatsapp:\+\d{8,15}$/.test(String(env?.TWILIO_WHATSAPP_FROM ?? '').trim());

/**
 * The public number to advertise, or null while the channel is off.
 *
 * One definition, because two would drift: /api/version publishes this and
 * the ads landing page shows its WhatsApp button only when it is present.
 * If the "is it live" test here and the "should we show the button" test
 * there ever disagreed, the disagreement would take the shape of a button
 * that opens a chat nobody answers — the single worst outcome for a page
 * paid traffic lands on.
 */
export const publicNumber = (env) =>
  enabled(env) ? String(env.TWILIO_WHATSAPP_FROM).trim().replace(/^whatsapp:/, '') : null;

/** `whatsapp:+66812345678` → `+66812345678`, or null for anything else. */
export function phoneFrom(from) {
  const m = /^whatsapp:(\+\d{8,15})$/.exec(String(from ?? '').trim());
  return m ? m[1] : null;
}

/**
 * Whose Num is this? A VERIFIED member whose number matches gets their own
 * account — facts, thread, briefing. An unverified match is deliberately
 * NOT used: possession of a WhatsApp number is not proof of the account
 * that merely typed it.
 */
export async function memberFor(env, phone) {
  if (!env?.DB || !phone) return null;
  try {
    return await env.DB.prepare(
      'SELECT id, name FROM num_members WHERE phone = ?1 AND phone_verified = 1 ORDER BY created_at DESC LIMIT 1',
    ).bind(phone).first();
  } catch {
    return null;
  }
}

/** The body handed to handleNum: one new message, and who is asking. */
export function askPayload({ text, member, phone }) {
  return {
    messages: [{ role: 'user', content: text }],
    state: member
      ? { me: { id: member.id, name: member.name ?? null }, channel: 'whatsapp' }
      : { anon: `wa:${phone}`, channel: 'whatsapp' },
  };
}

/** Default: the in-process concierge, same as the partner MCP uses. */
async function defaultAsk(env, ctx, payload, phone) {
  const { handleNum } = await import('./index.mjs');
  const req = new Request(`https://app.itsnum.com/api/num`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Per-sender rate bucket, so one chatty number cannot throttle the rest.
      'CF-Connecting-IP': `wa:${phone}`,
    },
    body: JSON.stringify(payload),
  });
  const res = await handleNum(req, env, ctx ?? { waitUntil() {} });
  if (!res.ok) throw new Error(`concierge ${res.status}`);
  const j = await res.json();
  return typeof j?.reply === 'string' ? j.reply : '';
}

/** Send one WhatsApp message through the account. Returns true on accept. */
export async function sendWhatsApp(env, toPhone, body, { fetchImpl = fetch } = {}) {
  if (!env?.TWILIO_SID || !env?.TWILIO_TOKEN) return false;
  const r = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      From: String(env.TWILIO_WHATSAPP_FROM).trim(),
      To: `whatsapp:${toPhone}`,
      Body: String(body).slice(0, MAX_REPLY),
    }),
  });
  return r.ok;
}

export const FALLBACK_REPLY = 'I couldn’t get to that just now — give me a minute and ask again.';

/**
 * The webhook. `deps` exists for tests: `ask` answers a payload, `send`
 * delivers a string. Production uses the real concierge and Twilio.
 */
export async function handleWhatsAppInbound(request, env, ctx, deps = {}) {
  const ask = deps.ask ?? ((payload, phone) => defaultAsk(env, ctx, payload, phone));
  const send = deps.send ?? ((phone, body) => sendWhatsApp(env, phone, body));

  // 503, not 404: the route exists and is switched off — the BOOKDESK_ENABLED
  // convention, and what lets worker/routetable.test.mjs tell a dark door
  // from a missing one.
  if (!enabled(env)) return new Response(JSON.stringify({ error: 'WhatsApp is not switched on' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  if (request.method !== 'POST') return new Response('no', { status: 405 });

  const params = new URLSearchParams(await request.text());
  const ok = await validSignature(env, `https://app.itsnum.com${PUBLIC_PATH}`, params, request.headers.get('X-Twilio-Signature'));
  if (!ok) {
    console.warn('[whatsapp] rejected unsigned/forged inbound');
    return new Response('forbidden', { status: 403 });
  }

  const phone = phoneFrom(params.get('From'));
  if (!phone) return new Response('bad request', { status: 400 });
  const text = String(params.get('Body') ?? '').slice(0, MAX_INBOUND).trim();
  if (!text) return xmlOk();

  const member = await memberFor(env, phone);
  const payload = askPayload({ text, member, phone });

  // Filed alongside texts, so the desk can see what came in even when the
  // brain was down. Fail-soft: bookkeeping never costs somebody their answer.
  if (env?.DB) {
    await env.DB.prepare(
      'INSERT INTO num_inbox (id, member_id, kind, frm, subject, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    ).bind('inb_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20), member?.id ?? null, 'whatsapp', phone, null, text)
      .run().catch((e) => console.warn('[whatsapp] inbox write failed', e?.message ?? e));
  }

  // Acknowledge now; answer when the answer exists.
  const work = (async () => {
    let reply = '';
    try {
      reply = (await ask(payload, phone)) || '';
    } catch (e) {
      console.warn('[whatsapp] concierge failed:', e?.message ?? e);
    }
    const sent = await send(phone, reply.trim() || FALLBACK_REPLY).catch(() => false);
    if (!sent) console.warn(`[whatsapp] reply to ${phone.slice(0, 5)}… was not accepted by Twilio`);
  })();
  if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
  return xmlOk();
}
