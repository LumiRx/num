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
