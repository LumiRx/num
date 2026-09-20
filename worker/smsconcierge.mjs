/**
 * The concierge, over SMS.
 *
 * ── WHAT WAS TRUE BEFORE THIS FILE (20 Sep 2026) ─────────────────────────
 *
 * itsnum.com says "AI text-message concierge on LINE, SMS, WhatsApp". The
 * feature registry says "The whole concierge over SMS, for a traveller with no
 * data and no app." Neither was true. worker/sms.mjs answered STOP, HELP,
 * PACKS, a kitchen's "Y A417" and a supplier's photograph — and filed every
 * other text into num_inbox with an empty TwiML. A traveller who texted
 * "table for two tonight" to +1 424 346 0888 was recorded as consenting,
 * written to an inbox nobody watches, and answered with nothing.
 *
 * num_inbox held three SMS rows in the product's life, the last from 20 Aug.
 * Programmable Messaging had not attempted a single send since 21 Aug
 * (num_sms_delivery: nine 30034s, then silence) — so the Messaging Service
 * fix in worker/twiliosender.mjs had never once been exercised against a
 * carrier. Sign-in codes go through Verify, a separate pipe, and were the only
 * texts leaving the building.
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────
 *
 * The same shape as worker/whatsapp.mjs, and for the same reason: it is not a
 * second concierge. An ordinary inbound text goes through the same `handleNum`
 * the app and WhatsApp use — same brain, same grounding, same directory, same
 * thread. A VERIFIED member texting from the number on their account gets
 * their Num. Anyone else gets a thread keyed on their phone, which becomes
 * theirs the day they verify that number in the app.
 *
 * Twilio gives the webhook 15 seconds and a concierge answer can take longer,
 * so the webhook is acknowledged with empty TwiML and the answer goes out as a
 * separate message under ctx.waitUntil, through senderParams() — the Messaging
 * Service that carries the approved A2P campaign. A TwiML <Message> reply
 * would leave from the bare number and could not be tracked; this one carries
 * a StatusCallback, so num_sms_delivery records whether a carrier took it.
 * The first real proof that US outbound works is the first row this writes.
 *
 * ── CONSENT ──────────────────────────────────────────────────────────────
 *
 * The person texted us first. sms.mjs records that as consent before this
 * runs (smsconsent.SOURCE.INBOUND_SMS), and a reply to a message they sent is
 * the one text nobody can argue with. The opt-out footer rides on the FIRST
 * reply to a number only — the CTIA asks for it once per programme, and a
 * concierge that ends every answer with "Reply STOP" reads like a robocall.
 *
 * ── DARK WHEN IT CANNOT WORK ─────────────────────────────────────────────
 *
 * With no Twilio credentials or no sender configured, or with NUM_OFF=sms,
 * `enabled()` is false and sms.mjs behaves exactly as it did: inbox and push,
 * empty TwiML. A half-configured door answers nothing rather than promising
 * an answer it cannot send.
 */

import { senderParams } from './twiliosender.mjs';
import { isOff } from './features.mjs';

/**
 * SMS has no 1500-character luxury. GSM-7 segments are 153 characters once
 * concatenated, and a US segment costs money and arrives out of order when
 * there are many. Four segments is a full answer; more is a list that belongs
 * in the app. The cut is made at a sentence end, never mid-word.
 */
export const MAX_REPLY = 600;
export const FALLBACK_REPLY = 'I couldn’t get to that just now — give me a minute and text again.';
export const STOP_FOOTER = 'Reply STOP to opt out.';

export const enabled = (env) =>
  !!(env?.TWILIO_SID && env?.TWILIO_TOKEN) && !!senderParams(env) && !isOff(env, 'sms');

/**
 * Whose Num is this? Same rule as WhatsApp: only a VERIFIED member whose
 * number matches gets their account. Possession of a phone number is not
 * proof of the account that merely typed it.
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
      ? { me: { id: member.id, name: member.name ?? null }, channel: 'sms' }
      : { anon: `sms:${phone}`, channel: 'sms' },
  };
}

/**
 * Fit an answer into MAX_REPLY without cutting a sentence in half. Markdown
 * that the app renders — bold, bullets, headings — is plain noise on a phone
 * and is stripped first.
 */
export function fitForSms(reply, max = MAX_REPLY) {
  let s = String(reply ?? '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[ \t]*[-*•][ \t]+/gm, '• ')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 $2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'), head.lastIndexOf('! '), head.lastIndexOf('? '));
  s = cut > max * 0.5 ? head.slice(0, cut + 1) : head.replace(/\s+\S*$/, '') + '…';
  return s.trim();
}

/** Default: the in-process concierge, same as WhatsApp and the partner MCP. */
async function defaultAsk(env, ctx, payload, phone) {
  const { handleNum } = await import('./index.mjs');
  const req = new Request('https://app.itsnum.com/api/num', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Per-sender rate bucket, so one chatty number cannot throttle the rest.
      'CF-Connecting-IP': `sms:${phone}`,
    },
    body: JSON.stringify(payload),
  });
  const res = await handleNum(req, env, ctx ?? { waitUntil() {} });
  if (!res.ok) throw new Error(`concierge ${res.status}`);
  const j = await res.json();
  return typeof j?.reply === 'string' ? j.reply : '';
}

/** Send one SMS through the Messaging Service. Returns { ok, sid | error }. */
async function defaultSend(env, phone, body) {
  const { sendText } = await import('./friendtext.mjs');
  return sendText(env, { to: phone, body });
}

/**
 * Answer an ordinary inbound text. Called by sms.mjs AFTER the keyword, order
 * and photo branches have had their turn, so it never sees STOP, HELP, PACKS,
 * a kitchen decision or a supplier's photograph.
 *
 * @param {object} args
 * @param {string} args.phone   E.164, already normalised by sms.mjs
 * @param {string} args.text    what they sent
 * @param {boolean} [args.firstContact]  true when this text CREATED their consent row
 * @param {object} [deps]  tests: `ask(payload, phone) → string`, `send(phone, body) → {ok}`
 * @returns {Promise<{ answered: boolean, why?: string }>}
 */
export async function answerBySms(env, ctx, { phone, text, firstContact = false }, deps = {}) {
  if (!enabled(env)) return { answered: false, why: 'sms concierge is not switched on' };
  if (!phone || !text) return { answered: false, why: 'nothing to answer' };

  const ask = deps.ask ?? ((payload, p) => defaultAsk(env, ctx, payload, p));
  const send = deps.send ?? ((p, body) => defaultSend(env, p, body));

  const member = await memberFor(env, phone);
  const payload = askPayload({ text, member, phone });

  // Acknowledge now; answer when the answer exists.
  const work = (async () => {
    let reply = '';
    try {
      reply = (await ask(payload, phone)) || '';
    } catch (e) {
      console.warn('[sms] concierge failed:', e?.message ?? e);
    }
    let body = fitForSms(reply) || FALLBACK_REPLY;
    if (firstContact) body = `${body}\n\n${STOP_FOOTER}`;
    const out = await send(phone, body).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (!out?.ok) console.warn(`[sms] reply to ${phone.slice(0, 5)}… was not accepted by Twilio: ${out?.error ?? 'unknown'}`);
  })();
  if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
  return { answered: true };
}
