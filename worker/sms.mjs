// Inbound texts. The "Texts" connection means: the venue's "running late?"
// reply, the driver's "I'm outside", the friend without the app — all of it
// reaches Num at one number and lands in the member's world without them
// leaving the app to check Messages.
//
// Twilio POSTs form-encoded params here. We verify its signature (HMAC-SHA1
// of the exact URL + sorted params, keyed with the auth token) before
// believing a word — an unsigned webhook is an open mailbox anyone can stuff.
import { notify } from './push.mjs';

const xmlOk = () =>
  new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    headers: { 'Content-Type': 'text/xml' },
  });

async function validSignature(env, url, params, given) {
  if (!env.TWILIO_TOKEN || !given) return false;
  // Twilio's recipe: full URL, then each POST param appended as key+value in
  // byte-sorted key order, HMAC-SHA1, base64.
  const keys = [...params.keys()].sort();
  let data = url;
  for (const k of keys) data += k + params.get(k);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.TWILIO_TOKEN),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return expected === given;
}

const normalise = (p) => {
  const digits = String(p ?? '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return '+1' + digits;
  return '+' + digits;
};

export async function handleSmsInbound(request, env) {
  if (request.method !== 'POST') return new Response('no', { status: 405 });
  const body = await request.text();
  const params = new URLSearchParams(body);

  // Signature check against the public URL Twilio was configured with.
  const url = new URL(request.url);
  const publicUrl = `https://app.itsnum.com${url.pathname}`;
  const ok = await validSignature(env, publicUrl, params, request.headers.get('X-Twilio-Signature'));
  if (!ok) {
    console.warn('[sms] rejected unsigned/forged inbound');
    return new Response('forbidden', { status: 403 });
  }

  const from = normalise(params.get('From'));
  const text = (params.get('Body') ?? '').slice(0, 1600).trim();
  if (!from || !text) return xmlOk();

  // Opt-out first, before anything else touches this message.
  //
  // A person texting STOP is withdrawing consent, and that has to be recorded
  // whatever else the message might look like. Handled ahead of the inbox
  // write and the push so a revocation can never be lost to a later failure —
  // and so we never notify somebody about a text whose entire content was
  // "leave me alone". Single word only: "stop by at 7" is a real message to a
  // concierge, not an opt-out.
  const single = text.toUpperCase().replace(/[^A-Z]/g, '');
  if (text.split(/\s+/).length === 1 && (STOP_WORDS.has(single) || START_WORDS.has(single))) {
    await applyOptOut(env, from, single);
    return xmlOk();
  }

  // Whose world does this text belong to? Exact phone match, verified first.
  const member = await env.DB.prepare(
    'SELECT id, name FROM num_members WHERE phone = ?1 OR phone = ?2 ORDER BY phone_verified DESC, created_at DESC LIMIT 1',
  ).bind(from, from.replace(/^\+1/, '')).first().catch(() => null);

  await env.DB.prepare(
    'INSERT INTO num_inbox (id, member_id, kind, frm, subject, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
  ).bind(
    'inb_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20),
    member?.id ?? null, 'sms', from, null, text,
  ).run().catch((e) => console.warn('[sms] inbox write failed', e?.message));

  if (member) {
    await notify(env, {
      memberId: member.id,
      kind: 'sms',
      title: 'Text for you',
      body: text.slice(0, 120),
      url: '/?app',
      tag: `sms:${from}`,
    }).catch(() => {});
  }
  return xmlOk();
}

// A member asks "what texts came in for me?" — their inbox, newest first.
/* ───────────────────────── delivery, and opt-out ───────────────────────── */

// What a carrier actually did with a message we handed to Twilio.
//
// Built on 2026-08-04, after a day spent unable to answer "did the text
// arrive?". `sendCode` returns `{ sent: true }` the moment Twilio ACCEPTS a
// message — which is a promise to try, not evidence of delivery. A carrier can
// silently drop it seconds later and nothing in the product would ever know.
// That gap is why an authentication failure was misdiagnosed as an A2P problem
// and then, once auth was fixed, why we still could not tell whether the first
// working send had been filtered.
//
// Twilio will tell us, for free, if we give it somewhere to say so.
const DELIVERY_SCHEMA = `
CREATE TABLE IF NOT EXISTS num_sms_delivery (
  message_sid TEXT PRIMARY KEY,
  to_phone TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  error_hint TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_num_sms_delivery_status ON num_sms_delivery(status, updated_at);
`;
let deliveryReady = false;
async function ensureDelivery(env) {
  if (deliveryReady) return;
  await env.DB.batch(DELIVERY_SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  deliveryReady = true;
}

// A number is not a diagnosis. These are the failures that actually happen to
// us, translated into the sentence someone reading the ops console needs —
// because "30034" sent us down the wrong path for a day, and the fix for each
// of these lives in a completely different place.
const CARRIER_HINTS = {
  30003: 'Handset unreachable or switched off.',
  30004: 'The recipient has blocked this number.',
  30005: 'Unknown or retired number.',
  30006: 'Landline or unreachable carrier — this number cannot receive SMS.',
  30007: 'Carrier flagged it as spam. Usually message content or sender reputation.',
  30034: 'A2P 10DLC campaign is not registered or not approved. This is the compliance path, not a code bug.',
  21610: 'This number replied STOP. We must not message it again until they opt back in.',
  21612: 'This route cannot reach that country from our number.',
};

/**
 * Twilio's StatusCallback. Records what happened to a message we sent.
 *
 * Twilio calls this several times per message (queued → sent → delivered, or
 * → undelivered/failed), so it upserts rather than inserts. Always answers 200:
 * a webhook that errors gets retried, and retries on a status update are noise
 * we would then have to reason about during an incident.
 */
export async function handleSmsStatus(request, env) {
  if (request.method !== 'POST') return new Response('no', { status: 405 });
  const params = new URLSearchParams(await request.text());

  // Same bar as inbound: an unsigned webhook is an open mailbox. Anyone could
  // otherwise write fake delivery records and quietly hide a real outage.
  const url = new URL(request.url);
  const ok = await validSignature(env, `https://app.itsnum.com${url.pathname}`, params, request.headers.get('X-Twilio-Signature'));
  if (!ok) {
    console.warn('[sms] rejected unsigned status callback');
    return new Response('forbidden', { status: 403 });
  }

  const sid = params.get('MessageSid') || params.get('SmsSid');
  const status = params.get('MessageStatus') || params.get('SmsStatus');
  if (!sid || !status) return new Response('ok');

  const code = params.get('ErrorCode') || null;
  try {
    await ensureDelivery(env);
    await env.DB.prepare(
      `INSERT INTO num_sms_delivery (message_sid, to_phone, status, error_code, error_hint, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,unixepoch(),unixepoch())
       ON CONFLICT(message_sid) DO UPDATE SET
         status     = excluded.status,
         error_code = COALESCE(excluded.error_code, num_sms_delivery.error_code),
         error_hint = COALESCE(excluded.error_hint, num_sms_delivery.error_hint),
         updated_at = excluded.updated_at`,
    ).bind(sid, params.get('To') ?? null, status, code, code ? (CARRIER_HINTS[Number(code)] ?? null) : null).run();
  } catch (e) {
    console.warn('[sms] delivery write failed', e?.message ?? e);
  }
  // Loud in the log for the two states that mean a person did not get their
  // message. Everything else is routine progress.
  if (status === 'undelivered' || status === 'failed') {
    console.warn(`[sms] NOT DELIVERED ${sid} status=${status} code=${code ?? 'none'} — ${CARRIER_HINTS[Number(code)] ?? 'no hint for this code'}`);
  }
  return new Response('ok');
}

// Opt-out keywords, per CTIA and Twilio's own handling.
//
// Twilio also intercepts most of these at the account level, so this may never
// see some of them — but "the vendor probably handled it" is not a consent
// record. `/sms/` promises "Reply STOP to opt out"; if somebody does and our
// register still shows them consenting, the register is wrong, and the whole
// point of that table is being able to prove what is true.
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT']);
const START_WORDS = new Set(['START', 'UNSTOP', 'YES', 'OPTIN']);

/** Record an opt-out or opt-back-in against the consent register. */
async function applyOptOut(env, phone, word) {
  const stopping = STOP_WORDS.has(word);
  try {
    await env.DB.prepare(
      `UPDATE num_sms_consent SET revoked_at = ${stopping ? 'unixepoch()' : 'NULL'} WHERE phone = ?1`,
    ).bind(phone).run();
  } catch (e) {
    // The table lives with the opt-in page (num-growth) and may not exist yet
    // in a fresh environment. Never fail an inbound text over bookkeeping.
    console.warn('[sms] consent update failed', e?.message ?? e);
  }
  console.warn(`[sms] ${stopping ? 'OPT-OUT' : 'OPT-IN'} ${word} from ${phone}`);
}

export async function handleInboxRead(request, env) {
  const url = new URL(request.url);
  const me = (url.searchParams.get('me') ?? '').slice(0, 64);
  if (!me) return new Response(JSON.stringify({ items: [] }), { headers: { 'Content-Type': 'application/json' } });
  const rows = await env.DB.prepare(
    'SELECT id, kind, frm, subject, body, created_at FROM num_inbox WHERE member_id = ?1 ORDER BY created_at DESC LIMIT 30',
  ).bind(me).all().catch(() => ({ results: [] }));
  return new Response(JSON.stringify({ items: rows.results ?? [] }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Email in — the same idea for confirmations ──────────────────────────────
// Every member gets num+<their id>@itsnum.com. Forward a booking confirmation
// there and it lands in their inbox; nobody pastes anything into a chat.
// Live the moment Email Routing on itsnum.com points its catch-all at this
// worker (one dashboard switch).
export async function handleEmailIn(message, env) {
  try {
    const to = String(message.to ?? '');
    const tag = /\+([A-Za-z0-9_]{6,40})@/.exec(to)?.[1] ?? null;
    let memberId = null;
    if (tag) {
      const row = await env.DB.prepare(
        'SELECT id FROM num_members WHERE id = ?1 OR id LIKE ?2 LIMIT 1',
      ).bind(tag, `%${tag.slice(-10)}`).first().catch(() => null);
      memberId = row?.id ?? null;
    }
    const subject = (message.headers?.get?.('subject') ?? '').slice(0, 300);
    await env.DB.prepare(
      'INSERT INTO num_inbox (id, member_id, kind, frm, subject, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    ).bind(
      'inb_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20),
      memberId, 'email', String(message.from ?? '').slice(0, 200), subject, null,
    ).run();
    if (memberId) {
      await notify(env, {
        memberId,
        kind: 'email',
        title: 'Confirmation received',
        body: subject || 'A forwarded email just arrived.',
        url: '/?app',
        tag: 'email-in',
      }).catch(() => {});
    }
  } catch (e) {
    console.warn('[email-in]', e?.message ?? e);
  }
}
