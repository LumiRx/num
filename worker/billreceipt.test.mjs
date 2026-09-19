/**
 * The guest's own copy of a bill they have paid.
 *
 * The properties pinned here are the ones that decide whether a person trusts
 * the next thing the product tells them: a receipt is never sent for a bill
 * that was not paid, a STOP outlives a request typed on a page, a failure is
 * named rather than reported as success, and the page stays the receipt
 * whatever happens — a guest who gives no address has lost nothing.
 *
 * NOT growth/billreceipt.test.mjs, which guards the VENUE's settled-bill
 * email. Same moment, opposite recipient.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  paidBill, receiptText, sendReceipt, sentFor, channelsAvailable, SAID, sayFor,
} from './billreceipt.mjs';

function world({ twilio = true, resend = true } = {}) {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, status TEXT);
    CREATE TABLE num_paylinks (token TEXT PRIMARY KEY, business_id TEXT, label TEXT,
      amount TEXT, currency TEXT, state TEXT, created_at TEXT, settled_at TEXT,
      charged_via TEXT, split_parent TEXT);
    CREATE TABLE num_bill_items (id TEXT PRIMARY KEY, token TEXT, pos INTEGER, name TEXT,
      qty INTEGER, unit_minor INTEGER, line_minor INTEGER, created_at TEXT);
    INSERT INTO businesses VALUES ('b1','Bar Nine','active');
    INSERT INTO num_paylinks (token,business_id,label,amount,currency,state,created_at,settled_at,charged_via)
      VALUES ('PAID1','b1','Table 4','24.00','USD','active','2026-09-18','2026-09-18 20:00:00','card');
    INSERT INTO num_paylinks (token,business_id,label,amount,currency,state,created_at)
      VALUES ('OPEN1','b1','Table 5','24.00','USD','active','2026-09-18');
  `);
  const DB = {
    prepare(sql) {
      const bound = [];
      const api = {
        bind(...a) { bound.push(...a); return api; },
        async first() { return d.prepare(sql).get(...bound) ?? null; },
        async all() { return { results: d.prepare(sql).all(...bound) }; },
        async run() { const r = d.prepare(sql).run(...bound); return { meta: { changes: Number(r.changes ?? 0) } }; },
      };
      return api;
    },
  };
  return {
    d,
    env: {
      DB, SITE: 'https://itsnum.com',
      ...(twilio ? { TWILIO_SID: 'AC_test', TWILIO_TOKEN: 'tok', TWILIO_FROM: '+15005550006' } : {}),
      ...(resend ? { RESEND_KEY: 'rk_test' } : {}),
    },
  };
}

function twilioStub({ ok = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)) });
    return ok
      ? { ok: true, status: 201, json: async () => ({ sid: 'SM1' }), text: async () => '' }
      : { ok: false, status: 400, json: async () => ({}), text: async () => 'carrier refused' };
  };
  return { calls, fetchImpl };
}

/* ── what may be receipted ─────────────────────────────────────────────── */

test('an unpaid bill has no receipt to send', async () => {
  const { env } = world();
  assert.equal(await paidBill(env, 'OPEN1'), null);
  const out = await sendReceipt(env, 'OPEN1', 'guest@example.com');
  assert.equal(out.ok, false);
});

test('an unknown code and an unpaid one get the same answer', async () => {
  // Otherwise this endpoint is a way to ask whether a venue is on NUM.
  const { env } = world();
  const a = await sendReceipt(env, 'OPEN1', 'guest@example.com');
  const b = await sendReceipt(env, 'NOPE', 'guest@example.com');
  assert.equal(a.say, b.say);
});

/* ── the receipt itself ────────────────────────────────────────────────── */

test('the text and the email quote the same amount and the same reference', async () => {
  const { env } = world();
  const bill = await paidBill(env, 'PAID1');
  const m = receiptText(bill);
  for (const body of [m.sms, m.text, m.subject]) assert.match(body, /24\.00/);
  for (const body of [m.sms, m.text]) assert.match(body, /PAID1/);
});

test('the receipt carries the link, because on a phone the link is the receipt', async () => {
  const { env } = world();
  const m = receiptText(await paidBill(env, 'PAID1'));
  assert.match(m.sms, /https:\/\/itsnum\.com\/p\/PAID1/);
  assert.match(m.text, /https:\/\/itsnum\.com\/p\/PAID1/);
});

test('the guest is told who held the money, on their own receipt', async () => {
  const { env } = world();
  const m = receiptText(await paidBill(env, 'PAID1'));
  assert.match(m.text, /straight from you to Bar Nine/);
  assert.match(m.text, /NUM never held it/);
});

test('what was on the bill rides along when the venue itemised it', async () => {
  const { d, env } = world();
  d.prepare(`INSERT INTO num_bill_items (id,token,pos,name,qty,unit_minor,line_minor,created_at)
             VALUES ('i1','PAID1',0,'Negroni',2,1200,2400,'2026-09-18')`).run();
  const m = receiptText(await paidBill(env, 'PAID1'));
  assert.match(m.text, /2x Negroni/);
  assert.match(m.text, /24\.00/);
});

test('a share says it was a share, so the figure is not a surprise', async () => {
  const { d, env } = world();
  d.prepare(`INSERT INTO num_paylinks (token,business_id,amount,currency,state,created_at,settled_at,split_parent)
             VALUES ('S1','b1','6.00','USD','active','2026-09-18','2026-09-18 20:05:00','PAID1')`).run();
  const m = receiptText(await paidBill(env, 'S1'));
  assert.match(m.text, /your share of a bill somebody split/);
});

/* ── which address, read off the string ────────────────────────────────── */

test('an address with an @ goes by email and a number goes by text', async () => {
  const { env } = world();
  const tw = twilioStub();
  const sms = await sendReceipt(env, 'PAID1', '+14155550777', { fetchImpl: tw.fetchImpl });
  assert.equal(sms.ok, true);
  assert.equal(tw.calls.length, 1);
  assert.match(tw.calls[0].body.Body, /PAID1/);
});

test('a number without a country code is refused with the fix, not a shrug', async () => {
  const { env } = world();
  const out = await sendReceipt(env, 'PAID1', '4155550777');
  assert.equal(out.ok, false);
  assert.match(out.say, /country code/);
});

test('a malformed email is named rather than handed to a provider', async () => {
  const { env } = world();
  const out = await sendReceipt(env, 'PAID1', 'guest@');
  assert.equal(out.ok, false);
  assert.match(out.say, /email address/);
});

test('an empty box asks for something rather than failing silently', async () => {
  const { env } = world();
  const out = await sendReceipt(env, 'PAID1', '   ');
  assert.equal(out.ok, false);
  assert.match(out.say, /Type an email address or a mobile number/);
});

test('spaces and brackets in a typed number do not defeat it', async () => {
  const { env } = world();
  const tw = twilioStub();
  const out = await sendReceipt(env, 'PAID1', '+1 (415) 555-0777', { fetchImpl: tw.fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(tw.calls[0].body.To, '+14155550777');
});

/* ── a STOP outlives a request ─────────────────────────────────────────── */

test('a number that said STOP is not texted because a different screen offered', async () => {
  const { env } = world();
  await env.DB.prepare("CREATE TABLE num_text_optouts (phone TEXT PRIMARY KEY, reason TEXT, evidence TEXT, created_at TEXT)").run();
  await env.DB.prepare("INSERT INTO num_text_optouts VALUES ('+14155550777','user_stop','','2026-09-01')").run();
  const tw = twilioStub();
  const out = await sendReceipt(env, 'PAID1', '+14155550777', { fetchImpl: tw.fetchImpl });
  assert.equal(out.ok, false);
  assert.equal(tw.calls.length, 0);
  assert.match(out.say, /asked us to stop/);
  assert.match(out.say, /email address instead/, 'a refusal with no way forward is a dead end');
});

test('the refusal is recorded, so it is not invisible later', async () => {
  const { env } = world();
  await env.DB.prepare("CREATE TABLE num_text_optouts (phone TEXT PRIMARY KEY, reason TEXT, evidence TEXT, created_at TEXT)").run();
  await env.DB.prepare("INSERT INTO num_text_optouts VALUES ('+14155550777','user_stop','','2026-09-01')").run();
  await sendReceipt(env, 'PAID1', '+14155550777');
  const [row] = await sentFor(env, 'PAID1');
  assert.equal(row.ok, 0);
  assert.match(row.detail, /opt-out/);
});

/* ── never claiming a send that did not happen ─────────────────────────── */

test('a refused text is reported as refused, and the page is still the receipt', async () => {
  const { env } = world();
  const tw = twilioStub({ ok: false });
  const out = await sendReceipt(env, 'PAID1', '+14155550777', { fetchImpl: tw.fetchImpl });
  assert.equal(out.ok, false);
  assert.match(out.say, /could not text/);
  assert.match(out.say, /on this page either way/,
    'a guest told only that it failed thinks they have lost their receipt');
});

test('a failure leaves the reason behind rather than a silence', async () => {
  const { env } = world();
  const tw = twilioStub({ ok: false });
  await sendReceipt(env, 'PAID1', '+14155550777', { fetchImpl: tw.fetchImpl });
  const [row] = await sentFor(env, 'PAID1');
  assert.equal(row.ok, 0);
  assert.match(row.detail, /twilio 400/);
});

test('one receipt per address per bill, however many times the button is pressed', async () => {
  const { env } = world();
  const tw = twilioStub();
  await sendReceipt(env, 'PAID1', '+14155550777', { fetchImpl: tw.fetchImpl });
  const again = await sendReceipt(env, 'PAID1', '+14155550777', { fetchImpl: tw.fetchImpl });
  assert.equal(tw.calls.length, 1);
  assert.equal(again.already, true);
  assert.match(again.say, /Already sent/);
});

test('a second, different address still gets one', async () => {
  const { env } = world();
  const tw = twilioStub();
  await sendReceipt(env, 'PAID1', '+14155550777', { fetchImpl: tw.fetchImpl });
  await sendReceipt(env, 'PAID1', '+14155550888', { fetchImpl: tw.fetchImpl });
  assert.equal(tw.calls.length, 2, 'two people at one table each want their own copy');
});

/* ── never offering a box that cannot work ─────────────────────────────── */

test('the page is told which channels are actually configured', () => {
  assert.deepEqual(channelsAvailable({}), { email: false, sms: false });
  assert.deepEqual(channelsAvailable({ RESEND_KEY: 'x' }), { email: true, sms: false });
  assert.deepEqual(
    channelsAvailable({ RESEND_KEY: 'x', TWILIO_SID: 'a', TWILIO_TOKEN: 'b' }),
    { email: true, sms: true },
  );
});

test('an unconfigured worker refuses rather than pretending', async () => {
  const { env } = world({ twilio: false, resend: false });
  const out = await sendReceipt(env, 'PAID1', 'guest@example.com');
  assert.equal(out.ok, false);
  assert.match(out.say, /could not email/);
});

test('the receipt leaves from the transactional sender', async () => {
  // A receipt on the outreach domain inherits whatever a cold list built, and
  // a filtered receipt is a guest who thinks they were not charged properly.
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('./billreceipt.mjs', import.meta.url), 'utf8'));
  assert.match(src, /from: senderFor\(env, MAIL_KIND\.TRANSACTIONAL\)/);
});

/* ── the page is handed a code, never a sentence ──────────────────────────
 * Whatever this returns travels back to `/p/<token>` in a query string, which
 * is to say a thing anybody can write. "?say=Your card was charged twice" on
 * a real NUM receipt page, in NUM's own voice, is a better phishing message
 * than most phishing messages — and escaping it stops a script while doing
 * nothing at all about the sentence.
 */

test('every outcome carries a code from the closed vocabulary', async () => {
  const { env } = world();
  const tw = twilioStub();
  const outs = [
    await sendReceipt(env, 'PAID1', '   '),
    await sendReceipt(env, 'PAID1', 'guest@'),
    await sendReceipt(env, 'PAID1', '4155550777'),
    await sendReceipt(env, 'NOPE', 'guest@example.com'),
    await sendReceipt(env, 'PAID1', '+14155550777', { fetchImpl: tw.fetchImpl }),
    await sendReceipt(env, 'PAID1', '+14155550777', { fetchImpl: tw.fetchImpl }),
  ];
  for (const o of outs) {
    assert.ok(o.code, 'an outcome with no code cannot be shown to the guest at all');
    assert.equal(SAID[o.code], o.say, `${o.code} is not in the vocabulary`);
  }
});

test('a sentence somebody else wrote maps to nothing', () => {
  assert.equal(sayFor('Your card was charged twice'), null);
  assert.equal(sayFor('<script>alert(1)</script>'), null);
  assert.equal(sayFor(''), null);
  assert.equal(sayFor(undefined), null);
});

test('every code in the vocabulary has copy, and every failure says where the receipt still is', () => {
  for (const [code, text] of Object.entries(SAID)) {
    assert.ok(text.length > 10, `${code} needs a real sentence`);
  }
  for (const code of ['nosms', 'nomail']) {
    assert.match(SAID[code], /on this page either way/,
      'a guest told only that it failed thinks they have lost their receipt');
  }
});
