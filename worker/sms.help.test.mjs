/**
 * HELP — the keyword every consent surface we own already promised.
 *
 * The /sms opt-in checkbox, the privacy policy, the terms, and the
 * `message_flow` filed with TCR all say "Reply HELP for help". Until
 * 2026-08-21 the word appeared nowhere in worker/sms.mjs, so a carrier
 * auditor texting HELP got silence — while our filing told a carrier
 * otherwise. HELP is a CTIA requirement, and the first thing a reviewer does
 * with an opt-out claim is send the keyword and see what comes back.
 *
 * These drive the real handler with real signed requests and assert on the
 * TwiML that comes out, rather than grepping the source for the word HELP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSmsInbound, HELP_REPLY } from './sms.mjs';

const TOKEN = 'test-auth-token';
const URL_ = 'https://app.itsnum.com/api/sms/in';

/** Twilio's signature recipe: URL + sorted key/value pairs, HMAC-SHA1, base64. */
async function sign(url, params) {
  const keys = [...params.keys()].sort();
  let data = url;
  for (const k of keys) data += k + params.get(k);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(TOKEN), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

const inbox = [];
const env = {
  TWILIO_TOKEN: TOKEN,
  DB: {
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => null,
        run: async () => { inbox.push({ sql, args }); return { success: true }; },
        all: async () => ({ results: [] }),
      }),
    }),
  },
};

async function textIn(body, from = '+13105550142') {
  const params = new URLSearchParams({ From: from, Body: body });
  const sig = await sign(URL_, params);
  const req = new Request(URL_, {
    method: 'POST',
    headers: { 'X-Twilio-Signature': sig, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const res = await handleSmsInbound(req, env);
  return res.text();
}

test('texting HELP gets an answer, not silence', async () => {
  const xml = await textIn('HELP');
  assert.match(xml, /<Message>/, 'HELP was met with an empty TwiML response');
  assert.match(xml, /NUM/, 'the reply does not name the brand');
  assert.match(xml, /STOP/, 'the reply does not say how to opt out');
});

test('the HELP reply fits one segment', () => {
  // A fragmented compliance reply arrives as two texts out of order and reads
  // like a broken system on the one message that has to look deliberate.
  assert.ok(HELP_REPLY.length <= 160, `HELP reply is ${HELP_REPLY.length} chars — over one segment`);
});

test('the HELP reply carries a real contact route', () => {
  assert.match(HELP_REPLY, /@|https?:|itsnum\.com/, 'no way for a person to actually get help');
});

test('INFO is treated as HELP', async () => {
  const xml = await textIn('INFO');
  assert.match(xml, /<Message>/, 'INFO is a recognised help keyword and was ignored');
});

test('a real request containing the word help still reaches the concierge', async () => {
  // "help me find a table for four" is a concierge request, not a keyword.
  // Auto-replying to it would swallow a customer's actual message.
  const before = inbox.length;
  const xml = await textIn('help me find a table for four tonight');
  assert.ok(!/<Message>/.test(xml), 'a genuine request was swallowed by the HELP auto-reply');
  assert.ok(inbox.length > before, 'the request never reached the inbox');
});

test('STOP still wins and stays silent', async () => {
  const xml = await textIn('STOP');
  assert.ok(!/<Message>/.test(xml), 'STOP now triggers a reply — Twilio sends its own');
});

test('an unsigned request is refused before any keyword is read', async () => {
  const params = new URLSearchParams({ From: '+13105550142', Body: 'HELP' });
  const req = new Request(URL_, {
    method: 'POST',
    headers: { 'X-Twilio-Signature': 'not-a-real-signature', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const res = await handleSmsInbound(req, env);
  assert.equal(res.status, 403, 'a forged inbound got a compliance reply out of us');
});
