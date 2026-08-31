import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSPORT, normalise, bareAddress, displayName, invalid, send, transports, recordSend, selfTest,
} from './mailer.mjs';

const MSG = { to: 'alex@example.com', subject: 'Hello', text: 'Body' };
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

const resendOk = () => { globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 're_1' }) }); };
const resend403 = () => {
  globalThis.fetch = async () => ({
    ok: false, status: 403,
    json: async () => ({ message: 'This API key is not authorized to send emails from itsnum.com' }),
  });
};
const cfBinding = (impl) => ({ send: impl ?? (async () => ({ messageId: 'cf_1' })) });

/* ─────────────────────────────────────────────────────────────────────────
   THE FIVE SILENT DAYS

   The invite cron ran every five minutes from 27 to 30 August and every send
   was refused. One transport, a broken credential, and nothing that said so.
   ───────────────────────────────────────────────────────────────────────── */

test('the exact production failure falls through to the second transport', async () => {
  resend403();
  const env = { RESEND_KEY: 're_broken', EMAIL: cfBinding() };
  const r = await send(env, MSG);
  assert.equal(r.ok, true);
  assert.equal(r.via, TRANSPORT.CLOUDFLARE, 'a dead credential must not be the end of the road');
  assert.equal(r.tried.length, 1);
  assert.match(r.tried[0].error, /not authorized to send emails from itsnum\.com/,
    'and the reason the first one failed is kept, not swallowed');
});

test('when everything fails, the result names every attempt and why', async () => {
  resend403();
  const r = await send({ RESEND_KEY: 're_broken', EMAIL: { send: async () => { throw new Error('destination not verified'); } } }, MSG);
  assert.equal(r.ok, false);
  assert.equal(r.via, TRANSPORT.NONE);
  assert.match(r.error, /resend: .*not authorized/);
  assert.match(r.error, /cloudflare: .*destination not verified/);
  assert.equal(r.tried.length, 2, 'a silent failure is the thing this file exists to prevent');
});

test('a working first transport is used and the second is never called', async () => {
  resendOk();
  let cfCalled = false;
  const r = await send({ RESEND_KEY: 're_good', EMAIL: cfBinding(async () => { cfCalled = true; return {}; }) }, MSG);
  assert.equal(r.via, TRANSPORT.RESEND);
  assert.equal(r.id, 're_1');
  assert.equal(cfCalled, false);
  assert.deepEqual(r.tried, []);
});

test('no transports configured at all is a reported failure, not a crash', async () => {
  const r = await send({}, MSG);
  assert.equal(r.ok, false);
  assert.match(r.error, /no RESEND_KEY/);
  assert.match(r.error, /no EMAIL binding/);
});

test('a transport that throws does not take the next one down', async () => {
  globalThis.fetch = async () => { throw new Error('network gone'); };
  const r = await send({ RESEND_KEY: 'k', EMAIL: cfBinding() }, MSG);
  assert.equal(r.ok, true);
  assert.equal(r.via, TRANSPORT.CLOUDFLARE);
  assert.match(r.tried[0].error, /network gone/);
});

test('the order can be forced, for a caller that knows better', async () => {
  resendOk();
  let cfCalled = false;
  const r = await send(
    { RESEND_KEY: 'k', EMAIL: cfBinding(async () => { cfCalled = true; return { messageId: 'cf_2' }; }) },
    MSG,
    { order: [TRANSPORT.CLOUDFLARE] },
  );
  assert.equal(r.via, TRANSPORT.CLOUDFLARE);
  assert.equal(cfCalled, true);
});

/* ── NOTHING MALFORMED REACHES A TRANSPORT ───────────────────────────── */

test('a message with nothing to send is refused before any network call', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  const env = { RESEND_KEY: 'k', EMAIL: cfBinding() };
  for (const [bad, why] of [
    [{ ...MSG, to: '' }, 'no recipient'],
    [{ ...MSG, to: 'not-an-address' }, 'a recipient address is malformed'],
    [{ ...MSG, subject: '' }, 'no subject'],
    [{ to: 'a@b.co', subject: 'x' }, 'no body'],
  ]) {
    const r = await send(env, bad);
    assert.equal(r.ok, false, why);
    assert.equal(r.error, why);
  }
  assert.equal(called, false, 'not one malformed message reached a transport');
});

test('addresses are normalised so the same person is not two recipients', () => {
  const m = normalise({ to: ['  Alex@Example.COM ', 'b@c.co'], subject: 'x', text: 'y' });
  assert.deepEqual(m.to, ['alex@example.com', 'b@c.co']);
  assert.equal(m.from, 'NUM <info@itsnum.com>', 'a default sender, so a caller cannot forget one');
});

test('a single recipient is not wrapped in an array for Cloudflare', async () => {
  let got;
  await send({ EMAIL: cfBinding(async (x) => { got = x; return { messageId: 'cf' }; }) }, MSG, { order: [TRANSPORT.CLOUDFLARE] });
  assert.equal(got.to, 'alex@example.com');
});

/* ── THE FROM HEADER ─────────────────────────────────────────────────── */

test('the display name and the address are split for the API that wants them apart', () => {
  assert.equal(bareAddress('NUM <info@itsnum.com>'), 'info@itsnum.com');
  assert.equal(displayName('NUM <info@itsnum.com>'), 'NUM');
  assert.equal(bareAddress('info@itsnum.com'), 'info@itsnum.com');
  assert.equal(displayName('info@itsnum.com'), null);
  assert.equal(displayName('"Num Concierge" <info@itsnum.com>'), 'Num Concierge');
});

test('Cloudflare gets a structured sender and Resend gets the header form', async () => {
  let cf;
  await send({ EMAIL: cfBinding(async (x) => { cf = x; return {}; }) }, MSG, { order: [TRANSPORT.CLOUDFLARE] });
  assert.deepEqual(cf.from, { email: 'info@itsnum.com', name: 'NUM' });

  let body;
  globalThis.fetch = async (u, i) => { body = JSON.parse(i.body); return { ok: true, status: 200, json: async () => ({ id: 'r' }) }; };
  await send({ RESEND_KEY: 'k' }, MSG, { order: [TRANSPORT.RESEND] });
  assert.equal(body.from, 'NUM <info@itsnum.com>');
});

/* ── SAYING WHAT IS TRUE ─────────────────────────────────────────────── */

// `resend_key_present` answered YES for five days while nothing sent. A
// readiness report that repeats that mistake is worse than none.
test('the transport report does not claim a present key is a working one', () => {
  const t = transports({ RESEND_KEY: 'k' });
  const resend = t.find((x) => x.via === TRANSPORT.RESEND);
  assert.equal(resend.configured, true);
  assert.match(resend.note, /says nothing about whether it is authorised/);
});

test('the Cloudflare entry carries its real limit and the exact way to lift it', () => {
  const cf = transports({ EMAIL: cfBinding() }).find((x) => x.via === TRANSPORT.CLOUDFLARE);
  assert.equal(cf.configured, true);
  assert.match(cf.note, /verified destination addresses/);
  assert.match(cf.note, /Email Service → Email Sending → Onboard Domain/);
  assert.match(cf.note, /does NOT change the root MX/, 'the existing SES inbound must keep working');
});

/* ── THE RECORD ──────────────────────────────────────────────────────── */

test('every send writes a row a person will actually see', async () => {
  const rows = [];
  const DB = { prepare: (sql) => ({ bind: (...a) => ({ run: async () => rows.push({ sql, a }) }) }) };
  await recordSend({ DB }, 'confirmation', { ok: true, via: 'cloudflare', id: 'cf_1' });
  assert.match(rows[0].sql, /INSERT INTO num_health/);
  assert.deepEqual(rows[0].a, ['ok', 'mail:confirmation', 'sent via cloudflare (cf_1)']);

  await recordSend({ DB }, 'invite', { ok: false, error: 'resend 403 not authorized' });
  assert.deepEqual(rows[1].a, ['fail', 'mail:invite', 'resend 403 not authorized']);
});

test('a failed health write never costs the email', async () => {
  await recordSend({ DB: { prepare() { throw new Error('D1 gone'); } } }, 'x', { ok: true, via: 'resend' });
});

/* ── THE SELF-TEST ───────────────────────────────────────────────────── */

// "Is email working" was answered from configuration for five days, and
// configuration was not the thing that was wrong.
test('the self-test is a no-op until somebody asks for it', async () => {
  assert.deepEqual(await selfTest({}), { skipped: true });
});

test('the self-test sends a real message and records the outcome', async () => {
  const rows = [];
  const DB = { prepare: () => ({ bind: (...a) => ({ run: async () => rows.push(a) }) }) };
  let sent;
  const r = await selfTest({
    MAIL_SELFTEST: 'andre@thatislumi.com',
    DB,
    EMAIL: cfBinding(async (x) => { sent = x; return { messageId: 'cf_9' }; }),
  });
  assert.equal(r.ok, true);
  assert.equal(sent.to, 'andre@thatislumi.com');
  assert.match(sent.subject, /self-test/i);
  assert.match(sent.text, /wrangler secret delete MAIL_SELFTEST/, 'it tells you how to turn itself off');
  assert.deepEqual(rows[0].slice(0, 2), ['ok', 'mail:selftest']);
});

test('a failing self-test records the failure rather than passing quietly', async () => {
  const rows = [];
  const DB = { prepare: () => ({ bind: (...a) => ({ run: async () => rows.push(a) }) }) };
  resend403();
  const r = await selfTest({ MAIL_SELFTEST: 'a@b.co', DB, RESEND_KEY: 'k' });
  assert.equal(r.ok, false);
  assert.equal(rows[0][0], 'fail');
  assert.match(rows[0][2], /not authorized/);
});

/* ── IS IT ON THE PATH? ──────────────────────────────────────────────── */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.mjs'), 'utf8');

test('the self-test actually runs on the cron', () => {
  assert.match(SRC, /import\('\.\/mailer\.mjs'\)/, 'the mailer is never reached from the cron');
  assert.match(SRC, /\.then\(\(m\) => m\.selfTest\(env\)\)/);
});

test('a broken mailer cannot take the health cron down with it', () => {
  const i = SRC.indexOf("import('./mailer.mjs')");
  assert.match(SRC.slice(i, i + 220), /\.catch\(\(e\) => console\.error\('\[mailer\]'/);
});

/* ─────────────────────────────────────────────────────────────────────────
   THE SENDER HAS TO BE ON A DOMAIN THAT WORKS

   Live, 30 Aug 2026: itsnum.com Email Routing read `enabled: false,
   status: unconfigured`, so Cloudflare refused every send with "could not
   find domain config of sending domain". 5arz.com was already `ready`.
   ───────────────────────────────────────────────────────────────────────── */

test('the Cloudflare sender can be pointed at a domain that is actually enabled', async () => {
  let sent;
  const r = await send(
    { EMAIL: cfBinding(async (x) => { sent = x; return { messageId: 'cf_5' }; }), MAIL_CF_FROM: 'Num <info@5arz.com>' },
    MSG,
    { order: [TRANSPORT.CLOUDFLARE] },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(sent.from, { email: 'info@5arz.com', name: 'Num' });
  assert.equal(r.substitutedFrom, 'info@5arz.com', 'a swapped sender is reported, never silent');
});

// A reply goes to the From address unless told otherwise. Silently swapping
// the sender sends the answer somewhere nobody reads — which is precisely how
// 1,051 invite replies were lost.
test('a substituted sender keeps the original address as Reply-To', async () => {
  let sent;
  await send(
    { EMAIL: cfBinding(async (x) => { sent = x; return {}; }), MAIL_CF_FROM: 'Num <info@5arz.com>' },
    MSG,
    { order: [TRANSPORT.CLOUDFLARE] },
  );
  assert.equal(sent.replyTo, 'info@itsnum.com', 'the answer must still reach the right inbox');
});

test('an explicit Reply-To is never overwritten by the substitution', async () => {
  let sent;
  await send(
    { EMAIL: cfBinding(async (x) => { sent = x; return {}; }), MAIL_CF_FROM: 'Num <info@5arz.com>' },
    { ...MSG, replyTo: 'adam@hieedinburgh.co.uk' },
    { order: [TRANSPORT.CLOUDFLARE] },
  );
  assert.equal(sent.replyTo, 'adam@hieedinburgh.co.uk');
});

test('no override means no substitution and no surprise Reply-To', async () => {
  let sent;
  const r = await send({ EMAIL: cfBinding(async (x) => { sent = x; return {}; }) }, MSG, { order: [TRANSPORT.CLOUDFLARE] });
  assert.equal(r.substitutedFrom, null);
  assert.equal(sent.replyTo, undefined);
  assert.deepEqual(sent.from, { email: 'info@itsnum.com', name: 'NUM' });
});

test('the two real Cloudflare refusals are surfaced verbatim, not flattened', async () => {
  for (const msg of ['could not find domain config of sending domain', 'destination not verified']) {
    const r = await send({ EMAIL: { send: async () => { throw new Error(msg); } } }, MSG, { order: [TRANSPORT.CLOUDFLARE] });
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(msg));
  }
});

test('every non-bulk send is blind-copied to the standing address', () => {
  const m = normalise({ to: ['owner@venue.co.uk'], subject: 'x' }, { MAIL_BCC: 'info@thatislumi.com' });
  assert.deepEqual(m.bcc, ['info@thatislumi.com']);
});

test('a bulk send is not blind-copied', () => {
  // 39,271 outreach invites copied to one inbox is not a safety net, it is a
  // second mailbox nobody reads — and some providers count every BCC.
  const m = normalise({ to: ['a@b.com'], subject: 'x', bulk: true }, { MAIL_BCC: 'info@thatislumi.com' });
  assert.deepEqual(m.bcc, []);
});

test('nobody is both a recipient and a blind copy', () => {
  const m = normalise({ to: ['Info@ThatIsLumi.com'], subject: 'x' }, { MAIL_BCC: 'info@thatislumi.com' });
  assert.deepEqual(m.to, ['info@thatislumi.com']);
  assert.deepEqual(m.bcc, [], 'two copies of one email is how somebody stops reading both');
});

test('a caller can add its own blind copy, and duplicates collapse', () => {
  const m = normalise({ to: ['a@b.com'], bcc: ['ops@x.com', 'info@thatislumi.com'], subject: 'x' },
    { MAIL_BCC: 'info@thatislumi.com' });
  assert.deepEqual(m.bcc, ['ops@x.com', 'info@thatislumi.com']);
});

test('reply-to falls back to a monitored address rather than the dead default', () => {
  // The default From is info@itsnum.com, whose inbound rejects at the SMTP
  // layer. A reply goes to From unless told otherwise, so with no Reply-To
  // every lead who hit reply got a bounce.
  const m = normalise({ to: ['a@b.com'], subject: 'x' }, { MAIL_REPLY_TO: 'info@thatislumi.com' });
  assert.equal(m.replyTo, 'info@thatislumi.com');
  const explicit = normalise({ to: ['a@b.com'], subject: 'x', replyTo: 'adam@hotel.com' },
    { MAIL_REPLY_TO: 'info@thatislumi.com' });
  assert.equal(explicit.replyTo, 'adam@hotel.com', 'an explicit reply-to still wins');
});

test('with no env configured nothing changes', () => {
  const m = normalise({ to: ['a@b.com'], subject: 'x' });
  assert.deepEqual(m.bcc, []);
  assert.equal(m.replyTo, null);
});

test('a rejected blind copy never costs us the email', async () => {
  // Cloudflare's binding is not documented to accept bcc. A binding that
  // rejects an unknown field would have turned a convenience into a total
  // outage on the first real send, to businesses who had already waited weeks.
  const seen = [];
  const env = {
    MAIL_BCC: 'info@thatislumi.com',
    EMAIL: {
      send: async (msg) => {
        seen.push(msg);
        if ('bcc' in msg) throw new Error('unknown field bcc');
        return { messageId: 'ok-1' };
      },
    },
  };
  const out = await send(env, { to: 'adam@hotel.co.uk', from: 'NUM <hello@mail.itsnum.com>', subject: 's', text: 't' },
    { order: [TRANSPORT.CLOUDFLARE] });
  assert.equal(out.ok, true, 'the business must still hear from us');
  assert.equal(seen.length, 2, 'tried with the copy, then without');
  assert.ok(!('bcc' in seen[1]));
});

test('a dropped blind copy is reported, not pretended', async () => {
  const env = {
    MAIL_BCC: 'info@thatislumi.com',
    EMAIL: { send: async (msg) => { if ('bcc' in msg) throw new Error('unknown field bcc'); return { messageId: 'ok-1' }; } },
  };
  const out = await send(env, { to: 'a@b.com', from: 'NUM <hello@mail.itsnum.com>', subject: 's', text: 't' },
    { order: [TRANSPORT.CLOUDFLARE] });
  assert.match(out.bccDropped ?? '', /rejected bcc/);
});
