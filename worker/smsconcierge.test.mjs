/**
 * The concierge answers a text.
 *
 * Until 20 Sep 2026 an ordinary SMS to NUM's number was filed to num_inbox
 * and answered with empty TwiML, while the site said "AI text-message
 * concierge on SMS". These drive the real webhook with real signed requests
 * and assert that a question gets an answer — and that the keywords, the
 * kitchen and the supplier never reach the brain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSmsInbound } from './sms.mjs';
import { answerBySms, askPayload, enabled, fitForSms, MAX_REPLY, STOP_FOOTER, FALLBACK_REPLY } from './smsconcierge.mjs';

const TOKEN = 'test-auth-token';
const URL_ = 'https://app.itsnum.com/api/sms/inbound';
const SVC = 'MG64fac2280000000000000000000000ab';

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

/** A DB that records consent as "created" on first sight of a number. */
function fakeDb({ member = null } = {}) {
  const seen = new Set();
  const writes = [];
  return {
    writes,
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => {
          if (/FROM num_members/.test(sql)) return member;
          if (/FROM num_sms_consent/.test(sql)) return seen.has(args[0]) ? { revoked_at: null } : null;
          return null;
        },
        run: async () => {
          writes.push({ sql, args });
          if (/INSERT INTO num_sms_consent/.test(sql)) {
            const phone = args[1];
            const created = !seen.has(phone);
            seen.add(phone);
            return { success: true, meta: { changes: created ? 1 : 0 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
        all: async () => ({ results: [] }),
      }),
    }),
  };
}

const live = (db) => ({ TWILIO_TOKEN: TOKEN, TWILIO_SID: 'AC' + 'a'.repeat(32), TWILIO_MESSAGING_SERVICE_SID: SVC, DB: db });
const dark = (db) => ({ TWILIO_TOKEN: TOKEN, DB: db });

async function textIn(env, body, { from = '+13105550142', deps } = {}) {
  const params = new URLSearchParams({ From: from, Body: body });
  const sig = await sign(URL_, params);
  const req = new Request(URL_, {
    method: 'POST',
    headers: { 'X-Twilio-Signature': sig, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const res = await handleSmsInbound(req, env, null, deps);
  return res.text();
}

function spies(reply = 'Tonight I would book Nusr-Et at 8. Shall I hold it?') {
  const asked = []; const sent = [];
  return {
    asked, sent,
    deps: {
      ask: async (payload, phone) => { asked.push({ payload, phone }); return reply; },
      send: async (phone, body) => { sent.push({ phone, body }); return { ok: true, sid: 'SM' + '1'.repeat(32) }; },
    },
  };
}

test('enabled() needs credentials AND a sender, and honours NUM_OFF=sms', () => {
  assert.equal(enabled(live(null)), true);
  assert.equal(enabled(dark(null)), false, 'no TWILIO_SID means dark');
  assert.equal(enabled({ ...live(null), TWILIO_MESSAGING_SERVICE_SID: '' }), false, 'no sender means dark');
  assert.equal(enabled({ ...live(null), NUM_OFF: 'tonight,sms' }), false, 'the kill switch must work');
});

test('an ordinary text gets a concierge answer, sent as its own message', async () => {
  const db = fakeDb();
  const s = spies();
  const xml = await textIn(live(db), 'table for two tonight near Sukhumvit', { deps: s.deps });
  assert.doesNotMatch(xml, /<Message>/, 'the answer must not ride in TwiML — it needs the Messaging Service and a StatusCallback');
  assert.equal(s.asked.length, 1, 'the brain was not asked');
  assert.equal(s.asked[0].payload.messages[0].content, 'table for two tonight near Sukhumvit');
  assert.equal(s.asked[0].payload.state.channel, 'sms');
  assert.equal(s.asked[0].payload.state.anon, 'sms:+13105550142', 'an unknown number gets a thread keyed on the phone');
  assert.equal(s.sent.length, 1, 'no answer was sent');
  assert.equal(s.sent[0].phone, '+13105550142');
  assert.match(s.sent[0].body, /Nusr-Et/);
});

test('the STOP footer rides on the first reply to a number only', async () => {
  const db = fakeDb();
  const s = spies();
  await textIn(live(db), 'hi num', { deps: s.deps });
  await textIn(live(db), 'and a driver after', { deps: s.deps });
  assert.equal(s.sent.length, 2);
  assert.ok(s.sent[0].body.endsWith(STOP_FOOTER), 'first contact must say how to opt out');
  assert.ok(!s.sent[1].body.includes(STOP_FOOTER), 'a concierge that ends every answer with STOP reads like a robocall');
});

test('a verified member texting from their number gets THEIR Num', async () => {
  const db = fakeDb({ member: { id: 'm_1', name: 'Dre' } });
  const s = spies();
  await textIn(live(db), 'where am I booked tonight?', { deps: s.deps });
  assert.deepEqual(s.asked[0].payload.state.me, { id: 'm_1', name: 'Dre' });
  assert.equal(s.asked[0].payload.state.anon, undefined);
});

test('STOP, HELP and PACKS never reach the brain', async () => {
  const db = fakeDb();
  const s = spies();
  await textIn(live(db), 'STOP', { deps: s.deps });
  await textIn(live(db), 'HELP', { deps: s.deps });
  await textIn(live(db), 'PACKS', { deps: s.deps });
  assert.equal(s.asked.length, 0, 'a keyword is a compliance obligation, not a conversation');
  assert.equal(s.sent.length, 0);
});

test('"stop by at 7" and "help me find a table" ARE conversations', async () => {
  const db = fakeDb();
  const s = spies();
  await textIn(live(db), 'stop by at 7', { deps: s.deps });
  await textIn(live(db), 'help me find a table for four', { deps: s.deps });
  assert.equal(s.asked.length, 2);
});

test('dark when Twilio is not configured: inbox and empty TwiML, exactly as before', async () => {
  const db = fakeDb();
  const s = spies();
  const xml = await textIn(dark(db), 'table for two', { deps: s.deps });
  assert.match(xml, /<Response><\/Response>/);
  assert.equal(s.asked.length, 0, 'a half-configured door must not promise an answer it cannot send');
  assert.ok(db.writes.some((w) => /INSERT INTO num_inbox/.test(w.sql)), 'the inbox row is still written');
});

test('a brain failure still answers something honest', async () => {
  const db = fakeDb();
  const sent = [];
  await textIn(live(db), 'anything', { deps: {
    ask: async () => { throw new Error('brain down'); },
    send: async (phone, body) => { sent.push(body); return { ok: true }; },
  } });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].startsWith(FALLBACK_REPLY));
});

test('answerBySms refuses with a reason when dark, without touching the brain', async () => {
  let asked = 0;
  const out = await answerBySms(dark(fakeDb()), null, { phone: '+13105550142', text: 'hi' }, { ask: async () => { asked++; return 'x'; } });
  assert.equal(out.answered, false);
  assert.equal(asked, 0);
});

test('fitForSms strips app markdown and cuts at a sentence, never mid-word', () => {
  assert.equal(fitForSms('**Tonight:** try [Gaggan](https://g.co/x)\n\n\n- one\n- two'), 'Tonight: try Gaggan https://g.co/x\n\n• one\n• two');
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const cut = fitForSms(long);
  assert.ok(cut.length <= MAX_REPLY, `over the cap: ${cut.length}`);
  assert.match(cut, /\.$/, 'must end on a sentence');
  const word = 'a'.repeat(MAX_REPLY + 50);
  assert.ok(fitForSms(word).length <= MAX_REPLY + 1);
});

test('askPayload keys an unknown sender on the phone and a member on their id', () => {
  assert.equal(askPayload({ text: 'x', member: null, phone: '+1' }).state.anon, 'sms:+1');
  assert.equal(askPayload({ text: 'x', member: { id: 'm', name: null }, phone: '+1' }).state.me.id, 'm');
});
