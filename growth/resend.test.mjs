import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendBatch } from './resend.mjs';

/** Restored after every test that stubs it. */
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test('a dead Resend key falls through to the transport that works', async () => {
  // The production key returns 401 "API key is invalid" and the copy on disk
  // is authorised for no domain we own. Retrying it next tick changes nothing,
  // so the drain must not stop for as long as the key stays broken.
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
  assert.equal(out.ok, true);
  assert.equal(out.sent, 2);
  assert.deepEqual(sent, ['a@venue.co.uk', 'b@venue.co.uk']);
});

test('with no Resend key at all it still sends', async () => {
  const sent = [];
  const env = { EMAIL: { send: async (m) => { sent.push(m.to); return { messageId: 'cf-1' }; } } };
  const out = await sendBatch(env, [{ to: 'a@b.com', from: 'NUM <hello@mail.itsnum.com>', subject: 's', text: 't' }]);
  assert.equal(out.sent, 1);
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
  ]);
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
  await sendBatch(env, [{ to: 'a@b.com', from: 'NUM <hello@mail.itsnum.com>', subject: 's', text: 't' }]);
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
  const out = await sendBatch(env, [{ to: ['a@b.com'], subject: 's', text: 't' }]);
  assert.equal(out.via, 'cloudflare', 'the fallback must name the rail that carried it');
  assert.match(out.fell_back_from, /resend 401/,
    'a 401 from Resend must survive into the caller, not vanish behind ok:true');
});

test('no key at all is reported as a fallback reason, not silence', async () => {
  const env = { EMAIL: { send: async () => {} } };
  const out = await sendBatch(env, [{ to: ['a@b.com'], subject: 's', text: 't' }]);
  assert.equal(out.fell_back_from, 'no RESEND_KEY');
});
