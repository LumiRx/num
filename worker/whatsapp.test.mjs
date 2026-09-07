import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleWhatsAppInbound, phoneFrom, askPayload, enabled, publicNumber, FALLBACK_REPLY, MAX_REPLY, sendWhatsApp } from './whatsapp.mjs';
import { readFileSync } from 'node:fs';

const TOKEN = 'test-token';
const URL_ = 'https://app.itsnum.com/api/whatsapp/inbound';

async function sign(url, params) {
  const keys = [...params.keys()].sort();
  let data = url;
  for (const k of keys) data += k + params.get(k);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(TOKEN), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

function envWith(over = {}) {
  return {
    WHATSAPP_ENABLED: 'true',
    TWILIO_WHATSAPP_FROM: 'whatsapp:+14243460888',
    TWILIO_TOKEN: TOKEN,
    TWILIO_SID: 'ACx',
    DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null }) }) },
    ...over,
  };
}

async function inbound(env, fields, { signed = true } = {}) {
  const params = new URLSearchParams(fields);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (signed) headers['X-Twilio-Signature'] = await sign(URL_, params);
  return new Request(URL_, { method: 'POST', headers, body: params.toString() });
}

const ctxSync = { waitUntil: () => {} };

describe('the door stays shut until it is configured', () => {
  test('flag off → 503, even to a signed message', async () => {
    const env = envWith({ WHATSAPP_ENABLED: '' });
    const res = await handleWhatsAppInbound(await inbound(env, { From: 'whatsapp:+66812345678', Body: 'hi' }), env, ctxSync);
    assert.equal(res.status, 503);
  });
  test('a sender that is not a whatsapp: address is half-configured, so still shut', () => {
    assert.equal(enabled({ WHATSAPP_ENABLED: 'true', TWILIO_WHATSAPP_FROM: '+14243460888' }), false);
    assert.equal(enabled({ WHATSAPP_ENABLED: 'true', TWILIO_WHATSAPP_FROM: 'whatsapp:+14243460888' }), true);
  });
});

describe('an unsigned webhook is an open mailbox', () => {
  test('missing signature → 403, nothing asked, nothing sent', async () => {
    const env = envWith();
    let asked = 0;
    const res = await handleWhatsAppInbound(
      await inbound(env, { From: 'whatsapp:+66812345678', Body: 'hi' }, { signed: false }), env, ctxSync,
      { ask: async () => { asked++; return 'x'; }, send: async () => true },
    );
    assert.equal(res.status, 403);
    assert.equal(asked, 0);
  });
  test('a From that is not WhatsApp is refused', async () => {
    const env = envWith();
    const res = await handleWhatsAppInbound(await inbound(env, { From: '+66812345678', Body: 'hi' }), env, ctxSync);
    assert.equal(res.status, 400);
  });
  test('phoneFrom', () => {
    assert.equal(phoneFrom('whatsapp:+66812345678'), '+66812345678');
    assert.equal(phoneFrom('+66812345678'), null);
    assert.equal(phoneFrom('whatsapp:0812345678'), null);
  });
});

describe('a message becomes a concierge turn, and the answer goes back', () => {
  test('happy path: acknowledged with empty TwiML, asked once, sent once', async () => {
    const env = envWith();
    const calls = { ask: [], send: [] };
    const res = await handleWhatsAppInbound(
      await inbound(env, { From: 'whatsapp:+66812345678', Body: 'where should we eat tonight in kata' }), env, null,
      { ask: async (p, phone) => { calls.ask.push([p, phone]); return 'Three options…'; }, send: async (phone, body) => { calls.send.push([phone, body]); return true; } },
    );
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<Response><\/Response>/);
    assert.equal(calls.ask.length, 1);
    const [payload, phone] = calls.ask[0];
    assert.equal(phone, '+66812345678');
    assert.deepEqual(payload.messages, [{ role: 'user', content: 'where should we eat tonight in kata' }]);
    assert.equal(payload.state.anon, 'wa:+66812345678');
    assert.equal(payload.state.channel, 'whatsapp');
    assert.deepEqual(calls.send, [['+66812345678', 'Three options…']]);
  });
  test('a verified member on that number gets THEIR Num, not a device thread', async () => {
    const env = envWith({
      DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => ({ id: 'mem_1', name: 'Dre' }) }) }) },
    });
    let payload;
    await handleWhatsAppInbound(
      await inbound(env, { From: 'whatsapp:+13105551234', Body: 'hi' }), env, null,
      { ask: async (p) => { payload = p; return 'ok'; }, send: async () => true },
    );
    assert.deepEqual(payload.state, { me: { id: 'mem_1', name: 'Dre' }, channel: 'whatsapp' });
  });
  test('askPayload never carries both a member and an anon subject', () => {
    const a = askPayload({ text: 'x', member: { id: 'mem_1', name: null }, phone: '+1' });
    assert.equal(a.state.anon, undefined);
    const b = askPayload({ text: 'x', member: null, phone: '+1' });
    assert.equal(b.state.me, undefined);
  });
  test('an empty body is acknowledged and asks nothing', async () => {
    const env = envWith();
    let asked = 0;
    const res = await handleWhatsAppInbound(await inbound(env, { From: 'whatsapp:+66812345678', Body: '   ' }), env, null, { ask: async () => { asked++; return 'x'; }, send: async () => true });
    assert.equal(res.status, 200);
    assert.equal(asked, 0);
  });
  test('when the brain fails the person still hears back — never silence', async () => {
    const env = envWith();
    const sent = [];
    await handleWhatsAppInbound(
      await inbound(env, { From: 'whatsapp:+66812345678', Body: 'hi' }), env, null,
      { ask: async () => { throw new Error('boom'); }, send: async (p, b) => { sent.push(b); return true; } },
    );
    assert.deepEqual(sent, [FALLBACK_REPLY]);
  });
});

describe('sendWhatsApp', () => {
  test('posts to the account with a whatsapp: pair, clipped', async () => {
    const env = envWith();
    let got;
    const ok = await sendWhatsApp(env, '+66812345678', 'y'.repeat(5000), { fetchImpl: async (url, init) => { got = { url, body: new URLSearchParams(init.body) }; return { ok: true }; } });
    assert.equal(ok, true);
    assert.match(got.url, /Accounts\/ACx\/Messages\.json$/);
    assert.equal(got.body.get('From'), 'whatsapp:+14243460888');
    assert.equal(got.body.get('To'), 'whatsapp:+66812345678');
    assert.equal(got.body.get('Body').length, MAX_REPLY);
  });
  test('no credentials → false, no network', async () => {
    assert.equal(await sendWhatsApp({}, '+1', 'x', { fetchImpl: async () => { throw new Error('should not be called'); } }), false);
  });
});

// ── THE ADVERTISED NUMBER ────────────────────────────────────────────────
//
// Added 3 Sep 2026. The ads landing page shows its "Message Num on WhatsApp"
// button only when /api/version publishes a number, and /api/version gets
// that number from here. One definition, so the "is the channel live" test
// and the "should we show the button" test can never disagree — their
// disagreement would take the shape of a button that opens a chat nobody
// answers, on the one page paid traffic lands on.
test('publicNumber is null until the channel is genuinely live', () => {
  assert.equal(publicNumber({}), null);
  assert.equal(publicNumber({ WHATSAPP_ENABLED: 'true' }), null, 'enabled with no sender is not live');
  assert.equal(publicNumber({ TWILIO_WHATSAPP_FROM: 'whatsapp:+14243460888' }), null, 'a sender behind a closed switch is not live');
  assert.equal(publicNumber({ WHATSAPP_ENABLED: 'false', TWILIO_WHATSAPP_FROM: 'whatsapp:+14243460888' }), null);
});

test('publicNumber strips the whatsapp: prefix and nothing else', () => {
  assert.equal(
    publicNumber({ WHATSAPP_ENABLED: 'true', TWILIO_WHATSAPP_FROM: 'whatsapp:+14243460888' }),
    '+14243460888',
  );
  // Trailing whitespace in a pasted secret must not produce a broken link.
  assert.equal(
    publicNumber({ WHATSAPP_ENABLED: ' true ', TWILIO_WHATSAPP_FROM: ' whatsapp:+66812345678 ' }),
    '+66812345678',
  );
});

test('a malformed sender never becomes a link', () => {
  for (const bad of ['+14243460888', 'whatsapp:14243460888', 'whatsapp:+1', 'whatsapp:+notanumber', '']) {
    assert.equal(publicNumber({ WHATSAPP_ENABLED: 'true', TWILIO_WHATSAPP_FROM: bad }), null, bad);
  }
});

test('the version endpoint reports the channel from that one function', () => {
  const src = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  assert.match(src, /whatsapp_number: whatsAppNumber\(env\)/);
  assert.match(src, /whatsapp: !!whatsAppNumber\(env\)/,
    'the connected flag re-derives the gate instead of asking whatsapp.mjs — two definitions, one drift away from a dead button');
});
