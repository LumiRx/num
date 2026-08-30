/**
 * Twilio Verify — the way out of A2P for sign-in codes.
 *
 * Twilio's own A2P page: "If you're only using 10DLC numbers to send user
 * verification text messages, you can use Twilio Verify rather than
 * registering for A2P 10DLC." Verify traffic is exempt.
 *
 * On 2026-08-21 `num_sms_delivery` showed every real send failing with carrier
 * error 30034 — unregistered campaign — including Andre's own number. One SMS
 * had ever been delivered, to Twilio's magic test number, which never touches a
 * carrier. 129 members, 42 numbers, two verified, both predating the current
 * sender. Sign-in was closed, not slow.
 *
 * THE TRAP THIS FILE EXISTS FOR: a wrong code does not make Verify return an
 * error. It answers HTTP 200 with status "pending". Any implementation that
 * checks "did the request succeed" instead of "is the status approved" lets
 * anybody in with any code. That is one line away at all times, so it is
 * asserted from several directions below.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verifyConfigured, verifySend, verifyCheck } from '../claim/verify.mjs';

const ENV = { VERIFY_SERVICE_SID: 'VAtest', TWILIO_SID: 'ACtest', TWILIO_TOKEN: 'tok' };

/** Stub fetch with a canned Verify response, capturing what was sent. */
function withVerify({ ok = true, body = {} }, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: new URLSearchParams(init.body) });
    return { ok, json: async () => body };
  };
  return Promise.resolve(fn(calls)).finally(() => { globalThis.fetch = real; });
}

describe('it is off until it is configured', () => {
  test('no service SID means no Verify', () => {
    assert.equal(verifyConfigured({ TWILIO_SID: 'AC', TWILIO_TOKEN: 't' }), false);
    assert.equal(verifyConfigured({}), false);
  });
  test('send and check return null so callers fall back rather than fail', async () => {
    assert.equal(await verifySend({}, '+13105550142'), null);
    assert.equal(await verifyCheck({}, '+13105550142', '123456'), null);
  });
  test('fully configured switches it on', () => {
    assert.equal(verifyConfigured(ENV), true);
  });
});

describe('sending', () => {
  test('a code goes to the Verify service, not the Messages API', async () => {
    await withVerify({ body: { status: 'pending', sid: 'VE1' } }, async (calls) => {
      const out = await verifySend(ENV, '+13105550142');
      assert.equal(out.ok, true);
      assert.match(calls[0].url, /verify\.twilio\.com\/v2\/Services\/VAtest\/Verifications$/);
      assert.ok(!/api\.twilio\.com/.test(calls[0].url), 'still sending through Programmable Messaging');
      assert.equal(calls[0].body.get('To'), '+13105550142');
      assert.equal(calls[0].body.get('Channel'), 'sms');
    });
  });

  test('a malformed number is reported in words, not as a code', async () => {
    // 60200 is what Verify answers for anything that is not strict E.164 —
    // which is precisely why the phone backfill had to land before this.
    await withVerify({ ok: false, body: { code: 60200, message: 'Invalid parameter' } }, async () => {
      const out = await verifySend(ENV, '4437079219');
      assert.equal(out.ok, false);
      assert.equal(out.code, 60200);
      assert.match(out.error, /country code/i, 'the person is not told what to do about it');
    });
  });

  test('rate limiting is surfaced as "try again", not as a failure of theirs', async () => {
    await withVerify({ ok: false, body: { code: 60203 } }, async () => {
      const out = await verifySend(ENV, '+13105550142');
      assert.match(out.error, /again/i);
    });
  });
});

describe('checking — where a wrong code must never read as a right one', () => {
  test('approved is a pass', async () => {
    await withVerify({ body: { status: 'approved' } }, async (calls) => {
      const out = await verifyCheck(ENV, '+13105550142', '123456');
      assert.equal(out.approved, true);
      assert.match(calls[0].url, /VerificationCheck$/);
      assert.equal(calls[0].body.get('Code'), '123456');
    });
  });

  test('PENDING IS A WRONG CODE, and it arrives as HTTP 200', async () => {
    // The whole reason this file exists.
    await withVerify({ ok: true, body: { status: 'pending' } }, async () => {
      const out = await verifyCheck(ENV, '+13105550142', '000000');
      assert.equal(out.approved, false, 'a wrong code was accepted — Verify returns 200/pending for these');
    });
  });

  test('canceled and expired are not passes either', async () => {
    for (const status of ['canceled', 'expired', 'max_attempts_reached', '']) {
      await withVerify({ ok: true, body: { status } }, async () => {
        const out = await verifyCheck(ENV, '+13105550142', '000000');
        assert.equal(out.approved, false, `status "${status}" was treated as approved`);
      });
    }
  });

  test('a 404 — no pending verification — is not a pass', async () => {
    // Expired, already used, or never sent. Indistinguishable to the person
    // from a wrong code, and it must not open the door.
    await withVerify({ ok: false, body: {} }, async () => {
      const out = await verifyCheck(ENV, '+13105550142', '123456');
      assert.equal(out.approved, false);
    });
  });

  test('a network failure is not a pass', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('network down'); };
    try {
      const out = await verifyCheck(ENV, '+13105550142', '123456');
      assert.equal(out.approved, false, 'an unreachable Verify let somebody in');
    } finally { globalThis.fetch = real; }
  });
});
