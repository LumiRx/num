import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendBatch } from './resend.mjs';

/** Restored after every test that stubs it. */
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

/* THIS CONTRACT WAS DELIBERATELY INVERTED ON 13 SEP 2026.
 *
 * It used to read "a dead Resend key falls through to the transport that
 * works", on the reasoning that a bad key is not this batch's fault so the
 * drain should not stop. Half right. The wrong half: the Cloudflare binding
 * reaches only destinations VERIFIED ON OUR OWN ACCOUNT, so for a merchant, a
 * host or a guest it accepts the message and discards it. mailer.mjs refuses to
 * put Cloudflare in the external chain for precisely this reason, and names the
 * cost in its own comment — "six businesses became unreachable-forever rather
 * than merely un-emailed". sendBatch reached past that guard with
 * `{ order: ['cloudflare'] }`.
 *
 * So the drain drained into nothing while every ledger wrote `sent`. A lead is
 * mailed once; those leads were spent. The principle the test three below
 * already held — "no lead is silently burned" — just had not been applied to a
 * rejected key. It is now. */
test('a dead Resend key fails loudly instead of sending into a black hole', async () => {
  const sent = [];
  const env = {
    RESEND_KEY: 'dead',
    EMAIL: { send: async (m) => { sent.push(m.to); return { messageId: 'cf-1' }; } },
    MAIL_CF_FROM: 'NUM <hello@mail.itsnum.com>',
    fetch: undefined,
  };
  globalThis.fetch = async () => new Response('API key is invalid', { status: 401 });
  const out = await sendBatch(env, [
    { to: 'a@venue.co.uk', from: 'NUM <hello@mail.itsnum.com>', subject: 's', text: 't' },
    { to: 'b@venue.co.uk', from: 'NUM <hello@mail.itsnum.com>', subject: 's', text: 't' },
  ]);
  assert.equal(out.ok, false, 'a key we cannot send with is a failure, not a success');
  assert.equal(out.sent, 0);
  assert.deepEqual(sent, [], 'and nothing may be handed to a rail that cannot reach a venue');
  assert.match(out.error, /resend 401/, 'the reason has to survive to the caller');
});

test('ops mail to our own verified inbox may still use the fallback', async () => {
  // The opt-in exists because the objection to stopping the drain is real for
  // mail we send to OURSELVES — those addresses are verified on the account, so
  // Cloudflare genuinely delivers them. It is only untrue for outsiders.
  const sent = [];
  const env = {
    RESEND_KEY: 'dead',
    EMAIL: { send: async (m) => { sent.push(m.to); return { messageId: 'cf-1' }; } },
  };
  globalThis.fetch = async () => new Response('API key is invalid', { status: 401 });
  const out = await sendBatch(env, [{ to: 'info@5arz.com', subject: 's', text: 't' }], { internal: true });
  assert.equal(out.ok, true);
  assert.equal(out.via, 'cloudflare');
  assert.match(out.fell_back_from, /resend 401/, 'even then it must say it fell back');
});

test('with no Resend key, outside mail refuses rather than pretending', async () => {
  const sent = [];
  const env = { EMAIL: { send: async (m) => { sent.push(m.to); return { messageId: 'cf-1' }; } } };
  const out = await sendBatch(env, [{ to: 'a@b.com', from: 'NUM <hello@mail.itsnum.com>', subject: 's', text: 't' }]);
  assert.equal(out.ok, false);
  assert.equal(out.sent, 0);
  assert.deepEqual(sent, []);
  assert.match(out.error, /accept and discard/, 'and it must say why it refused, not just that it did');
});

test('one failure fails the whole tick, so no lead is silently burned', async () => {
  // drainInvites marks a lead `invited` on a reported success. A partial count
  // would mark leads sent that never were, and they are never retried.
  let n = 0;
  const env = {
    EMAIL: { send: async () => { n += 1; if (n === 2) throw new Error('rejected'); return { messageId: 'cf' }; } },
  };
  const out = await sendBatch(env, [
    { to: 'a@b.com', from: 'f@mail.itsnum.com', subject: 's', text: 't' },
    { to: 'b@b.com', from: 'f@mail.itsnum.com', subject: 's', text: 't' },
  ], { internal: true });
  assert.equal(out.ok, false);
  assert.equal(out.sent, 0, 'all-or-nothing: the drain releases every lead it claimed');
});

test('an invite is never blind-copied', async () => {
  // 14,360 copies to one inbox is a second mailbox nobody reads.
  const seen = [];
  const env = {
    MAIL_BCC: 'info@thatislumi.com',
    EMAIL: { send: async (m) => { seen.push(m); return { messageId: 'cf' }; } },
  };
  await sendBatch(env, [{ to: 'a@b.com', from: 'NUM <hello@mail.itsnum.com>', subject: 's', text: 't' }],
    { internal: true });
  assert.ok(!('bcc' in seen[0]), 'bulk sends opt out of the standing blind copy');
});

/* ── which rail did it actually use? ─────────────────────────────────────────
 * 12 Sep 2026. A bill-settled email reported ok and wrote no row to
 * num_mail_events. The only evidence that it had gone out over Cloudflare
 * instead of Resend was the SHAPE of the returned id — an RFC Message-ID
 * rather than a Resend UUID. A silent fallback on a rejected key looks
 * identical to a healthy send, which is how a dead RESEND_KEY survives while
 * every message quietly loses its delivery receipt.
 */
test('a send says which rail carried it', async () => {
  const env = {
    RESEND_KEY: 'k',
    _fetch: null,
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'uuid-1' }] }), { status: 200 });
  const out = await sendBatch(env, [{ to: ['a@b.com'], subject: 's', text: 't' }]);
  assert.equal(out.ok, true);
  assert.equal(out.via, 'resend', 'a Resend send must name Resend');
  assert.equal(out.fell_back_from, undefined, 'a clean send has nothing to fall back from');
});

test('a rejected key falls back AND says so', async () => {
  const env = {
    RESEND_KEY: 'dead-key',
    EMAIL: { send: async () => {} },
    DB: null,
  };
  globalThis.fetch = async () => new Response('API key is invalid', { status: 401 });
  // The cloudflare transport is reached through worker/mailer.mjs; stub it by
  // giving the binding a send() and letting mailer resolve the id as null.
  const out = await sendBatch(env, [{ to: ['a@b.com'], subject: 's', text: 't' }], { internal: true });
  assert.equal(out.via, 'cloudflare', 'the fallback must name the rail that carried it');
  assert.match(out.fell_back_from, /resend 401/,
    'a 401 from Resend must survive into the caller, not vanish behind ok:true');
});

test('no key at all is reported as a fallback reason, not silence', async () => {
  const env = { EMAIL: { send: async () => {} } };
  const out = await sendBatch(env, [{ to: ['a@b.com'], subject: 's', text: 't' }], { internal: true });
  assert.equal(out.fell_back_from, 'no RESEND_KEY');
});
