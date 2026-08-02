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
