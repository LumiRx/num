/**
 * AN ORDER HAS TO REACH A KITCHEN, NOT AN INBOX.
 *
 * Dre, 12 Sep 2026: "we need to work a way to send notifcations to the
 * business of orders like doordash to their current systems so they dont need
 * to only use our dashboard."
 *
 * Before this, `createOrder()` told a partner exactly one way — an email, and
 * only if they had set one. Meanwhile the guest was told "you'll hear the
 * moment they accept". An order nobody sees is worse than no order.
 *
 * The properties these tests defend, in order of how badly each one hurts:
 *   1. One dead channel never silences another.
 *   2. A keypress or a text cannot move an order unless it comes from the
 *      line Num actually alerted.
 *   3. Every attempt is on a row, so "we told them" is a fact not a hope.
 *   4. A venue is never rung twice about the same order.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  alertOrder, routeFor, saveRoute, needsEscalation, acceptFrom, parseReply,
  orderTwiml, smsBody, signBody, orderSummary, ESCALATE_AFTER_MIN, __resetReady,
} from './orderalert.mjs';

const DELIVERY = readFileSync(new URL('./delivery.mjs', import.meta.url), 'utf8');
const SMS = readFileSync(new URL('./sms.mjs', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');

let db; let env; let calls;
const binding = () => ({
  prepare(sql) {
    let bound = [];
    const api = {
      bind(...a) { bound = a; return api; },
      async run() { const r = db.prepare(sql).run(...bound); return { meta: { changes: r.changes } }; },
      async first() { const r = db.prepare(sql).get(...bound); return r ? { ...r } : null; },
      async all() { return { results: db.prepare(sql).all(...bound).map((r) => ({ ...r })) }; },
    };
    return api;
  },
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const ORDER = {
  id: 'ord_1', short: 'A417', business_id: 'biz1', partner: 'Boba Guys',
  items: [{ name: 'Taro Milk Tea', qty: 2 }, { name: 'Mochi', qty: 1 }],
  subtotal: 1800, fee: 300, total: 2100, fulfilment: 'delivery',
};

beforeEach(() => {
  __resetReady();
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT)`);
  db.prepare("INSERT INTO businesses VALUES ('biz1','Boba Guys')").run();
  db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, phone TEXT)`);
  db.exec(`CREATE TABLE num_place_owners (place_id TEXT, business_id TEXT, revoked_at TEXT)`);
  db.exec(`CREATE TABLE num_orders (id TEXT PRIMARY KEY, short_code TEXT, business_id TEXT,
    total_cs INTEGER, fulfilment TEXT, status TEXT, created_at INTEGER)`);
  db.exec(`CREATE TABLE num_order_items (order_id TEXT, name TEXT, qty INTEGER)`);
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return { ok: true, status: 200, text: async () => 'ok' };
  };
  env = {
    DB: binding(),
    TWILIO_SID: 'ACxxx', TWILIO_TOKEN: 't',
    TWILIO_MESSAGING_SERVICE_SID: 'MG0123456789abcdef0123456789abcdef',
    TWILIO_VOICE_FROM: '+14243460888',
  };
});

const seedRoute = (patch) => saveRoute(env, 'biz1', patch);
const alertsFor = (id) => db.prepare('SELECT * FROM num_order_alerts WHERE order_id=?').all(id);

describe('the fan-out', () => {
  test('a venue with all three routes gets all three', async () => {
    await seedRoute({ sms_to: '+13105550100', voice_to: '+13105550100', webhook_url: 'https://pos.example/num' });
    const out = await alertOrder(env, ORDER);
    assert.deepEqual(out.sent.sort(), ['sms', 'webhook']);
    // Voice is the escalation channel, not the first pass — see below.
    assert.equal(out.failed.length, 0);
  });

  test('ONE DEAD CHANNEL NEVER SILENCES ANOTHER', async () => {
    // The whole point. A broken webhook must not cost the venue its text.
    await seedRoute({ sms_to: '+13105550100', webhook_url: 'https://pos.example/num' });
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('pos.example')) throw new Error('their server is down');
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    const out = await alertOrder(env, ORDER);
    assert.deepEqual(out.sent, ['sms']);
    assert.equal(out.failed[0].channel, 'webhook');
    assert.match(out.failed[0].error, /their server is down/);
  });

  test('every attempt is written down, successes and failures alike', async () => {
    await seedRoute({ sms_to: '+13105550100', webhook_url: 'https://pos.example/num' });
    globalThis.fetch = async (url) => {
      if (String(url).includes('pos.example')) return { ok: false, status: 500, text: async () => 'boom' };
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    await alertOrder(env, ORDER);
    const rows = alertsFor('ord_1');
    assert.equal(rows.length, 2, '"we told them" must be a row, not an assumption');
    assert.equal(rows.find((r) => r.channel === 'sms').ok, 1);
    assert.equal(rows.find((r) => r.channel === 'webhook').ok, 0);
  });

  test('a venue with nothing configured falls back to its published phone', async () => {
    // A hand-onboarded pilot shop is reachable on day one without filling in
    // any form — the number is already on their own listing.
    db.prepare("INSERT INTO places VALUES ('p1','+13105559999')").run();
    db.prepare("INSERT INTO num_place_owners VALUES ('p1','biz1',NULL)").run();
    const r = await routeFor(env, 'biz1');
    assert.equal(r.sms_to, '+13105559999');
    assert.equal(r.voice_to, '+13105559999');
  });

  test('no routes at all is quiet, not a crash', async () => {
    const out = await alertOrder(env, ORDER);
    assert.deepEqual(out.sent, []);
    assert.deepEqual(out.failed, []);
  });
});

describe('the text a kitchen reads', () => {
  test('everything needed is in the first line', () => {
    const b = smsBody({ short: 'A417', partner: 'Boba Guys', items: ORDER.items, total: 2100, fulfilment: 'delivery' });
    assert.match(b.split('\n')[0], /A417/);
    assert.match(b.split('\n')[0], /2x Taro Milk Tea/);
    assert.match(b.split('\n')[0], /\$21\.00/);
  });

  test('the reply carries the code, because two orders can land in one minute', () => {
    assert.match(smsBody({ short: 'A417', items: [], total: 0 }), /Reply Y A417 to accept/);
  });

  test('it goes through the Messaging Service, not a bare number', async () => {
    // A US long code inherits A2P approval through the service. Sending
    // `From: <number>` is what earned 30034 on every real send in August.
    await seedRoute({ sms_to: '+13105550100' });
    await alertOrder(env, ORDER);
    const sms = calls.find((c) => c.url.includes('Messages.json'));
    assert.match(sms.body, /MessagingServiceSid=MG/);
    assert.ok(!/(^|&)From=/.test(sms.body));
  });

  test('no Twilio sender configured fails loudly rather than silently', async () => {
    await seedRoute({ sms_to: '+13105550100' });
    const out = await alertOrder({ ...env, TWILIO_MESSAGING_SERVICE_SID: '', TWILIO_FROM: '' }, ORDER);
    assert.equal(out.sent.length, 0);
    assert.match(out.failed[0].error, /no Twilio sender/);
  });
});

describe('the phone call', () => {
  test('it reads the order out twice, because a kitchen is loud', () => {
    const x = orderTwiml({ short: 'A417', partner: 'Boba Guys', items: ORDER.items, total: 2100, callbackUrl: 'https://app.itsnum.com/cb' });
    assert.equal((x.match(/<Say/g) ?? []).length, 3, 'twice inside the Gather, once after it');
    assert.match(x, /Press 1 to accept/);
  });

  test('the code is spelled out, not run together', () => {
    // "A417" read as a word is not a code anybody can write down.
    assert.match(orderTwiml({ short: 'A417', items: [], total: 0, callbackUrl: 'x' }), /A 4 1 7/);
  });

  test('one key and a short timeout — it must not camp on the venue line', () => {
    const x = orderTwiml({ short: 'A417', items: [], total: 0, callbackUrl: 'x' });
    assert.match(x, /numDigits="1"/);
    const t = Number(/timeout="(\d+)"/.exec(x)[1]);
    assert.ok(t <= 10, `${t}s is too long to hold a restaurant's phone open`);
  });

  test('a venue name with an ampersand cannot break the XML', () => {
    const x = orderTwiml({ short: 'A1', partner: 'Ben & Jerry\'s <b>', items: [], total: 0, callbackUrl: 'https://x/y?a=1&b=2' });
    assert.ok(!/&(?!amp;|quot;|lt;|gt;)/.test(x), 'unescaped ampersand — Twilio would reject the document');
    assert.ok(!x.includes('<b>'));
  });

  test('voice fires on escalation, not on the first pass', async () => {
    await seedRoute({ sms_to: '+13105550100', voice_to: '+13105550100' });
    const first = await alertOrder(env, ORDER);
    assert.ok(!first.sent.includes('voice'), 'ringing instantly costs the guest nothing and the venue its patience');
    const second = await alertOrder(env, ORDER, { escalation: true });
    assert.deepEqual(second.sent, ['voice']);
  });

  test('escalation does not re-send the channels that already went', async () => {
    await seedRoute({ sms_to: '+13105550100', voice_to: '+13105550100', webhook_url: 'https://pos.example/num' });
    const out = await alertOrder(env, ORDER, { escalation: true });
    assert.deepEqual(out.sent, ['voice'], 're-texting a venue that already has the text is noise');
  });
});

describe('who is allowed to accept', () => {
  beforeEach(() => {
    db.prepare("INSERT INTO num_orders VALUES ('ord_1','A417','biz1',2100,'delivery','pending_business',1)").run();
  });

  test('a reply from the line we alerted is accepted', async () => {
    await seedRoute({ sms_to: '+13105550100' });
    await alertOrder(env, ORDER);
    // decideOrder is exercised separately; here we only need to reach it.
    const out = await acceptFrom(env, { from: '+1 (310) 555-0100', short: 'A417', decision: 'accept' });
    assert.ok(!/was not the one/.test(out.error ?? ''), 'the venue’s own number was refused');
  });

  test('KNOWING THE CODE IS NOT ENOUGH — a stranger is refused', async () => {
    await seedRoute({ sms_to: '+13105550100' });
    await alertOrder(env, ORDER);
    const out = await acceptFrom(env, { from: '+13105558888', short: 'A417', decision: 'accept' });
    assert.equal(out.ok, false);
    assert.match(out.error, /not the one this order was sent to/);
  });

  test('an order nobody was alerted about cannot be accepted by anyone', async () => {
    const out = await acceptFrom(env, { from: '+13105550100', short: 'A417', decision: 'accept' });
    assert.equal(out.ok, false);
  });

  test('a code that does not exist gives nothing away', async () => {
    const out = await acceptFrom(env, { from: '+13105550100', short: 'ZZZZ', decision: 'accept' });
    assert.equal(out.ok, false);
    assert.match(out.error, /no such order/);
  });

  test('formatting does not decide who owns a restaurant', async () => {
    await seedRoute({ sms_to: '+1 (310) 555-0100' });
    await alertOrder(env, ORDER);
    const out = await acceptFrom(env, { from: '3105550100', short: 'A417', decision: 'accept' });
    assert.ok(!/was not the one/.test(out.error ?? ''));
  });
});

describe('reading the reply', () => {
  test('the shapes a venue actually types', () => {
    assert.deepEqual(parseReply('Y A417'), { decision: 'accept', short: 'A417' });
    assert.deepEqual(parseReply('y a417'), { decision: 'accept', short: 'A417' });
    assert.deepEqual(parseReply('N A417'), { decision: 'decline', short: 'A417' });
    assert.deepEqual(parseReply('1 A417'), { decision: 'accept', short: 'A417' });
  });

  test('a sentence is a message to the concierge, not a decision', () => {
    // "Yes we can do that for you" must never silently accept an order.
    for (const t of ['Yes we can do that', 'no thanks', 'Y but only after 8', 'can you call me', '']) {
      assert.equal(parseReply(t), null, `"${t}" was read as an order decision`);
    }
  });
});

describe('escalation is once, and only for the unanswered', () => {
  test('an order still pending past the window is picked up', async () => {
    const old = Math.floor(Date.now() / 1000) - (ESCALATE_AFTER_MIN + 2) * 60;
    db.prepare(`INSERT INTO num_orders VALUES ('ord_2','B100','biz1',900,'delivery','pending_business',?)`).run(old);
    const rows = await needsEscalation(env);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].short_code, 'B100');
  });

  test('an order that was answered is left alone', async () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    db.prepare(`INSERT INTO num_orders VALUES ('ord_3','C100','biz1',900,'delivery','accepted',?)`).run(old);
    assert.equal((await needsEscalation(env)).length, 0);
  });

  test('a fresh order is left alone — the text has not had its chance', async () => {
    db.prepare(`INSERT INTO num_orders VALUES ('ord_4','D100','biz1',900,'delivery','pending_business',?)`)
      .run(Math.floor(Date.now() / 1000));
    assert.equal((await needsEscalation(env)).length, 0);
  });

  test('A VENUE IS NEVER RUNG TWICE ABOUT ONE ORDER', async () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    db.prepare(`INSERT INTO num_orders VALUES ('ord_5','E100','biz1',900,'delivery','pending_business',?)`).run(old);
    await seedRoute({ voice_to: '+13105550100' });
    assert.equal((await needsEscalation(env)).length, 1);
    await alertOrder(env, { id: 'ord_5', short: 'E100', business_id: 'biz1', items: [], total: 900 }, { escalation: true });
    assert.equal((await needsEscalation(env)).length, 0, 'a venue rung twice stops answering the phone to us');
  });
});

describe('the webhook a POS can trust', () => {
  test('it is signed, and the timestamp is inside the signature', async () => {
    // Without the timestamp signed, a captured request replays forever.
    const a = await signBody('k', '{"a":1}', 1000);
    const b = await signBody('k', '{"a":1}', 2000);
    assert.notEqual(a, b);
    assert.equal(a, await signBody('k', '{"a":1}', 1000));
  });

  test('the signature and timestamp ride on the request', async () => {
    await seedRoute({ webhook_url: 'https://pos.example/num', webhook_key: 'shh' });
    let headers = null;
    globalThis.fetch = async (_u, init) => { headers = init.headers; return { ok: true, status: 200 }; };
    await alertOrder(env, ORDER);
    assert.match(headers['X-Num-Signature'], /^[0-9a-f]{64}$/);
    assert.ok(Number(headers['X-Num-Timestamp']) > 0);
  });

  test('plain http is refused — that is an address in clear text', async () => {
    const out = await saveRoute(env, 'biz1', { webhook_url: 'http://pos.example/num' });
    assert.equal(out.ok, false);
    assert.match(out.error, /https/);
  });
});

describe('the wiring', () => {
  test('createOrder actually calls the fan-out', () => {
    assert.match(DELIVERY, /const \{ alertOrder \} = await import\('\.\/orderalert\.mjs'\)/);
    const at = DELIVERY.indexOf('alertOrder(env,');
    const email = DELIVERY.indexOf("const { prefs } = await import('./biznotify.mjs')");
    assert.ok(at > 0 && at < email, 'the alert should go before the paper trail');
  });

  test('an inbound Y reaches the order before the concierge inbox', () => {
    const decide = SMS.indexOf('parseReply');
    const inbox = SMS.indexOf('EVERY ORDINARY INBOUND MESSAGE IS CONSENT');
    assert.ok(decide > 0 && decide < inbox,
      'a two-character reply from a kitchen would be filed as a concierge request');
  });

  test('the voice routes exist, both directions', () => {
    assert.match(INDEX, /url\.pathname\.startsWith\('\/api\/orders\/voice\/'\)/);
    assert.match(INDEX, /Digits/);
    assert.match(INDEX, /m\.orderTwiml\(/);
  });

  test('the escalation cron is wired', () => {
    assert.match(INDEX, /m\.needsEscalation\(env\)/);
    assert.match(INDEX, /\{ escalation: true \}/);
  });
});

describe('small things that would embarrass us', () => {
  test('an order summary is capped — a text is not a receipt', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `Item number ${i}`, qty: 2 }));
    assert.ok(orderSummary(many).length <= 300);
  });

  test('pickup does not say delivery', () => {
    assert.match(smsBody({ short: 'A1', items: [], total: 500, fulfilment: 'pickup' }), /pickup/);
  });
});
