import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attemptsForVerification, attemptsSince, diagnoseVerifySid, explainAttempt,
  isVerifyServiceSid, reconcileVerifySends, verdictFor,
} from './verifydiag.mjs';

const VA = 'VA' + 'a'.repeat(32);
const VE = 'VE' + 'b'.repeat(32);
const VL = 'VL' + 'c'.repeat(32);

const env = () => ({ TWILIO_SID: 'AC' + '1'.repeat(32), TWILIO_TOKEN: 'tok', VERIFY_SERVICE_SID: VA });

/** Swap fetch for one call, always restoring it even when the assertion throws. */
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (u, init) => {
    seen.push(String(u));
    return handler(String(u), init);
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = real;
  }
}

const okJson = (body) => ({ ok: true, async json() { return body; } });

test('a Verify Service SID is not a Messaging Service SID', () => {
  // Both live one click apart in the same console and both are 34 characters.
  assert.equal(isVerifyServiceSid(VA), true);
  assert.equal(isVerifyServiceSid(`  ${VA}\n`), true, 'a pasted newline should not fail');
  assert.equal(diagnoseVerifySid('MG' + 'a'.repeat(32)).kind, 'wrong_sid_mg');
  assert.match(diagnoseVerifySid('MG' + 'a'.repeat(32)).note, /Messaging Service SID/);
  assert.equal(diagnoseVerifySid('').kind, 'missing');
  assert.equal(diagnoseVerifySid(VA).ok, true);
});

test('SENT IS NOT DELIVERED — the distinction the whole file exists for', () => {
  // Twilio reports `sent` the moment a carrier accepts a handoff. Reading it
  // as success is precisely the blind spot that made a signup with no text
  // record a healthy send.
  assert.equal(explainAttempt({ channel_data: { status: 'sent' } }).delivered, null);
  assert.equal(explainAttempt({ channel_data: { status: 'delivered' } }).delivered, true);
  assert.equal(explainAttempt({ channel_data: { status: 'undelivered' } }).delivered, false);
  assert.equal(explainAttempt({ channel_data: { status: 'failed' } }).delivered, false);
  // No word from the carrier is `unknown`, never an optimistic default.
  assert.equal(explainAttempt({}).delivered, null);
  assert.equal(explainAttempt({}).status, 'unknown');
});

test('an error code is translated into the console it has to be fixed in', () => {
  // 30034 is a carrier code and lives in sms.mjs; 60220 is Verify's own. Both
  // must resolve, because the person reading this cannot be expected to know
  // which API produced the number.
  assert.match(explainAttempt({ channel_data: { status: 'undelivered', error_code: 30034 } }).hint, /A2P 10DLC/);
  assert.match(explainAttempt({ channel_data: { status: 'failed', error_code: 60220 } }).hint, /Fraud Guard/);
  assert.match(explainAttempt({ channel_data: { status: 'failed', error_code: 60410 } }).hint, /geo permissions/);
  // An unrecognised code must not invent a diagnosis.
  assert.equal(explainAttempt({ channel_data: { status: 'failed', error_code: 99999 } }).hint, null);
  // Numbers arrive as numbers from Twilio and as strings from a form post.
  assert.equal(explainAttempt({ channel_data: { status: 'failed', error_code: '30034' } }).error_code, '30034');
});

test('attempts are scoped to OUR service, not the whole account', async () => {
  // An account can run several Verify services. An unfiltered read would
  // blame ours for another one's failures.
  await withFetch(() => okJson({ attempts: [] }), async (seen) => {
    await attemptsSince(env(), '2026-08-30T00:00:00Z');
    assert.match(seen[0], /ServiceSid=VA/);
    assert.match(seen[0], /DateCreatedAfter=2026-08-30/);
  });
});

test('THE 30 AUG SIGNUP: accepted by Twilio, dropped by the carrier, recorded as ok', async () => {
  // The exact shape of the incident. issueCode logged send/ok because Verify
  // answered `pending`; the phone never buzzed. Reconciliation is what turns
  // the first fact into the second.
  const writes = [];
  const e = {
    ...env(),
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async run() { writes.push({ sql, args }); return {}; },
              async first() { return { phone: '+14243460888' }; },
            };
          },
          async run() { return {}; },
        };
      },
      async batch() { return []; },
    },
  };
  const out = await withFetch(
    () => okJson({ attempts: [{
      sid: VL, verification_sid: VE, channel: 'sms', date_created: '2026-08-30T22:15:04Z',
      conversion_status: 'unconverted',
      channel_data: { status: 'undelivered', error_code: 30034 },
    }] }),
    () => reconcileVerifySends(e),
  );

  assert.equal(out.ok, true);
  assert.equal(out.undelivered, 1, 'a dropped code was not counted as a failure');
  assert.deepEqual(out.reasons, ['30034']);
  const row = writes.find((w) => /num_sms_delivery/.test(w.sql));
  assert.ok(row, 'nothing was written to the one table that answers "did it arrive"');
  assert.equal(row.args[0], VL, 'the delivery row must be keyed by the attempt sid');
  assert.equal(row.args[1], '+14243460888', 'the recipient was not recovered from our own member row');
  assert.equal(row.args[2], 'undelivered');
  assert.match(row.args[4], /A2P 10DLC/);
});

test('an unresolved attempt writes NOTHING rather than a hopeful row', async () => {
  // A `sent` attempt is still in flight. Recording it would put a non-answer
  // into the status histogram the ops console reads as ground truth.
  const writes = [];
  const e = {
    ...env(),
    DB: {
      prepare(sql) {
        return { bind() { return { async run() { writes.push(sql); return {}; }, async first() { return null; } }; }, async run() { return {}; } };
      },
      async batch() { return []; },
    },
  };
  const out = await withFetch(
    () => okJson({ attempts: [{ sid: VL, verification_sid: VE, channel_data: { status: 'sent' } }] }),
    () => reconcileVerifySends(e),
  );
  assert.equal(out.seen, 1);
  assert.equal(out.written, 0, 'an in-flight attempt was recorded as a delivery outcome');
  assert.equal(out.undelivered, 0);
});

test('attempts for one verification are refused unless it really is one', async () => {
  // The caller is social.mjs handing over whatever sits in code_sid, which on
  // the old Programmable Messaging path is an SM… message sid.
  const bad = await attemptsForVerification(env(), 'SM' + 'a'.repeat(32));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.attempts, []);
  await withFetch(() => okJson({ attempts: [] }), async (seen) => {
    const good = await attemptsForVerification(env(), VE);
    assert.equal(good.ok, true);
    assert.match(seen[0], /VerificationSid=VE/);
  });
});

test('the verdict distinguishes the four things that are actually different', () => {
  const configured = { ok: true, kind: 'verify_service', note: '' };
  const one = (status, error_code) => ({ ok: true, attempts: [explainAttempt({ channel_data: { status, error_code } })] });

  assert.equal(verdictFor({ configured, attempts: one('delivered') }).state, 'delivering');
  assert.equal(verdictFor({ configured, attempts: one('undelivered', 30034) }).state, 'failing');
  // Accepted but no carrier verdict yet is NOT a pass and NOT a failure.
  assert.equal(verdictFor({ configured, attempts: one('sent') }).state, 'pending');
  // Silence is its own answer: it means the sends are not coming from here.
  assert.equal(verdictFor({ configured, attempts: { ok: true, attempts: [] } }).state, 'quiet');
  // A misconfiguration outranks everything — no point reading attempts from a
  // service SID that is a paste of something else.
  const broken = { ok: false, kind: 'wrong_sid_mg', note: 'This is a Messaging Service SID' };
  assert.equal(verdictFor({ configured: broken, attempts: one('delivered') }).state, 'misconfigured');
});

test('a partly-failing service is not reported as healthy', () => {
  const attempts = { ok: true, attempts: [
    explainAttempt({ channel_data: { status: 'undelivered', error_code: 30034 } }),
    explainAttempt({ channel_data: { status: 'delivered' } }),
  ] };
  const v = verdictFor({ configured: { ok: true, note: '' }, attempts });
  assert.equal(v.state, 'partial');
  assert.match(v.say, /1 of 2/);
});

test('missing credentials are reported, never thrown', async () => {
  const out = await attemptsSince({ VERIFY_SERVICE_SID: VA }, null);
  assert.equal(out.ok, false);
  assert.match(out.error, /TWILIO_SID/);
  assert.deepEqual(out.attempts, []);
});

test('the admin endpoint is invisible without the key', async () => {
  const { handleVerifyDiag } = await import('./verifydiag.mjs');
  const res = await handleVerifyDiag(
    new Request('https://app.itsnum.com/api/admin/verify'),
    { ADMIN_KEY: 'secret' },
  );
  // 404, not 401: an endpoint that answers "unauthorized" has confirmed it
  // exists to whoever was probing for it.
  assert.equal(res.status, 404);
});
