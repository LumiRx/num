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

/** TwiML that actually says something back. */
const xmlReply = (body) =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${
      String(body).replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`)
    }</Message></Response>`,
    { headers: { 'Content-Type': 'text/xml' } },
  );

export async function validSignature(env, url, params, given) {
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
    await applyOptOut(env, from, single, text);
    return xmlOk();
  }

  // HELP, answered before the message is filed as a concierge request.
  //
  // Same single-word rule as STOP, and for the same reason: "help me find a
  // table for four" is a real request to a concierge and must reach the
  // concierge, not trip a compliance auto-reply. Only a bare HELP is the
  // keyword.
  //
  // Deliberately does NOT write to num_inbox and does NOT push. A keyword
  // reply is a compliance obligation, not a conversation, and filing it as an
  // unanswered request would leave the desk chasing a message that has already
  // been answered.
  if (text.split(/\s+/).length === 1 && HELP_WORDS.has(single)) {
    console.warn(`[sms] HELP from ${from}`);
    return xmlReply(HELP_REPLY);
  }

  // ── EVERY ORDINARY INBOUND MESSAGE IS CONSENT ─────────────────────────
  //
  // Not just START. Somebody who texts a concierge "table for two tonight"
  // has initiated contact with a published business number, which is the
  // strongest and least arguable consent there is — stronger than a ticked
  // box, because they wrote the evidence themselves.
  //
  // This is where Num's lawful audience comes from. Not from the 1,830,191
  // scraped numbers in `places`, which nobody agreed to anything.
  //
  // Runs after the STOP branch above, so a revocation is never mistaken for
  // an opt-in, and it swallows its own failures: a bookkeeping problem must
  // never cost somebody their answer.
  await import('./smsconsent.mjs')
    .then((c) => c.record(env, {
      phone: from,
      source: c.SOURCE.INBOUND_SMS,
      consentText: c.inboundConsentText(text),
    }))
    .catch((e) => console.warn('[sms] consent record failed', e?.message ?? e));

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
export async function ensureDelivery(env) {
  if (deliveryReady) return;
  await env.DB.batch(DELIVERY_SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  deliveryReady = true;
}

// A number is not a diagnosis. These are the failures that actually happen to
// us, translated into the sentence someone reading the ops console needs —
// because "30034" sent us down the wrong path for a day, and the fix for each
// of these lives in a completely different place.
export const CARRIER_HINTS = {
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
    await retractUndeliveredCode(env, sid);
  }
  return new Response('ok');
}

/**
 * A code that never arrived is not a pending code — retract it.
 *
 * `issueCode` stores the hash the moment Twilio ACCEPTS the message, because
 * that is the only signal available at the time. When the carrier then drops
 * it, the member is left holding a pending code that nobody on earth knows:
 * `/verify` says "wrong code" and burns an attempt, and `/resend` says "a code
 * is on its way" and refuses for the cooldown. They are stuck behind a phantom,
 * and every surface tells them things are fine. Dre hit exactly this on
 * 2026-08-05 while A2P was still blocking delivery.
 *
 * Matched on the message SID, never on the phone number. A failure receipt can
 * arrive seconds after a successful retry, and clearing by recipient would
 * wipe the newer, valid code — turning a recoverable failure into a worse one.
 */
async function retractUndeliveredCode(env, messageSid) {
  if (!messageSid) return;
  try {
    const res = await env.DB.prepare(
      `UPDATE num_members
          SET code_hash = NULL, code_salt = NULL, code_expires = NULL, code_sid = NULL, attempts = 0
        WHERE code_sid = ?1 AND COALESCE(phone_verified, 0) = 0`,
    ).bind(messageSid).run();
    const changed = res?.meta?.changes ?? res?.meta?.rows_written ?? 0;
    if (changed > 0) {
      // Worth a line: it means somebody asked to verify and we could not
      // deliver. The retraction lets them retry immediately rather than wait
      // out a cooldown for a message that is never coming.
      console.warn(`[sms] retracted undelivered code for message ${messageSid} — member can request another immediately`);
    }
  } catch (e) {
    console.warn('[sms] code retraction failed', e?.message ?? e);
  }
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

/**
 * HELP — the keyword we were already promising and had never implemented.
 *
 * Every consent surface we own tells people to reply HELP: the /sms opt-in
 * checkbox, the privacy policy, the terms, and the `message_flow` we are about
 * to file with TCR. Until now the word appeared nowhere in this worker, so a
 * carrier auditor — or a member — texting HELP got silence.
 *
 * That is not a missing nicety. HELP is a CTIA requirement and the message
 * flow we file is a statement to a carrier about what our number does. A
 * reviewer's first test of an opt-out claim is to send the keyword and see
 * what comes back, and "nothing" reads as a program that does not honour its
 * own disclosures.
 *
 * Answered here in the Worker rather than only by Advanced Opt-Out on a
 * Messaging Service, because this holds however the console is configured, is
 * covered by a test, and cannot be silently un-set by someone editing a
 * dropdown.
 *
 * The reply must name the brand, say how to stop, and give a real contact —
 * and it must fit one segment (160 GSM-7 characters) so it never arrives as a
 * fragmented pair.
 */
const HELP_WORDS = new Set(['HELP', 'INFO']);
export const HELP_REPLY =
  'NUM travel concierge. Msg&data rates may apply. Msg freq varies. '
  + 'Reply STOP to opt out. Help: info@5arz.com or itsnum.com/sms';

/**
 * Record an opt-out or opt-back-in against the consent register.
 *
 * The opt-IN branch used to be an UPDATE and nothing else, which meant a
 * person texting START with no existing row changed nothing at all: zero rows
 * matched, no consent was recorded, and they stayed unreachable. On 30 Aug
 * 2026 `num_sms_consent` held ZERO rows while 1.8m scraped numbers sat in
 * `places` — so the one path that could have built a lawful audience was the
 * one that silently did nothing.
 *
 * Somebody texting START is consenting. That is the strongest consent there
 * is, and it now gets written down.
 */
async function applyOptOut(env, phone, word, body = '') {
  const stopping = STOP_WORDS.has(word);
  if (!stopping) {
    const { record, SOURCE, inboundConsentText } = await import('./smsconsent.mjs');
    await record(env, {
      phone,
      source: SOURCE.KEYWORD,
      consentText: inboundConsentText(body || word),
    }).catch(() => {});
  }
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
