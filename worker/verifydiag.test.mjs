import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attemptsForVerification, attemptsSince, diagnoseVerifySid, explainAttempt,
  isStale, isVerifyServiceSid, reconcileVerifySends, verdictFor,
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
  assert.equal(explainAttempt({ channel_data: { message_status: 'sent' } }).delivered, null);
  assert.equal(explainAttempt({ channel_data: { message_status: 'delivered' } }).delivered, true);
  assert.equal(explainAttempt({ channel_data: { message_status: 'undelivered' } }).delivered, false);
  assert.equal(explainAttempt({ channel_data: { message_status: 'failed' } }).delivered, false);
  // No word from the carrier is `unknown`, never an optimistic default.
  assert.equal(explainAttempt({}).delivered, null);
  assert.equal(explainAttempt({}).status, 'unknown');
});

test('an error code is translated into the console it has to be fixed in', () => {
  // 30034 is a carrier code and lives in sms.mjs; 60220 is Verify's own. Both
  // must resolve, because the person reading this cannot be expected to know
  // which API produced the number.
  assert.match(explainAttempt({ channel_data: { message_status: 'undelivered', error_code: 30034 } }).hint, /A2P 10DLC/);
  assert.match(explainAttempt({ channel_data: { message_status: 'failed', error_code: 60220 } }).hint, /Fraud Guard/);
  assert.match(explainAttempt({ channel_data: { message_status: 'failed', error_code: 60410 } }).hint, /geo permissions/);
  // An unrecognised code must not invent a diagnosis.
  assert.equal(explainAttempt({ channel_data: { message_status: 'failed', error_code: 99999 } }).hint, null);
  // Numbers arrive as numbers from Twilio and as strings from a form post.
  assert.equal(explainAttempt({ channel_data: { message_status: 'failed', error_code: '30034' } }).error_code, '30034');
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
      channel_data: { message_status: 'undelivered', error_code: 30034 },
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
    () => okJson({ attempts: [{ sid: VL, verification_sid: VE, channel_data: { message_status: 'sent' } }] }),
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
  const one = (message_status, error_code) => ({ ok: true, attempts: [explainAttempt({ date_created: new Date().toISOString(), channel_data: { message_status, error_code, to: '+15550001111' } })] });

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
    explainAttempt({ channel_data: { message_status: 'undelivered', error_code: 30034 } }),
    explainAttempt({ channel_data: { message_status: 'delivered' } }),
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

// ── What the first live run of this endpoint got wrong, 31 Aug 2026 ───────

test('the CARRIER status is message_status, not status', () => {
  // Twilio puts two statuses in channel_data and they answer opposite
  // questions: `status` is whether the person typed the code back,
  // `message_status` is whether a carrier took the message. Reading the first
  // as the second made this endpoint report "pending — ask again in a minute"
  // about a nineteen-hour-old attempt on its very first run.
  const a = explainAttempt({
    channel_data: { status: 'unconfirmed', message_status: 'delivered', to: '+15550001111' },
  });
  assert.equal(a.delivered, true, 'a delivered message read as unresolved');
  assert.equal(a.status, 'delivered');
  assert.equal(a.confirmation, 'unconfirmed', 'the confirmation status was lost, not just deprioritised');

  // And the reverse: confirmed by the user, dropped by the carrier.
  const b = explainAttempt({ channel_data: { status: 'confirmed', message_status: 'undelivered', error_code: 30034 } });
  assert.equal(b.delivered, false);
});

test('error_code 0 is not an error', () => {
  // Twilio sends "0" for a clean attempt. Rendering it as a code sends someone
  // looking up an error that does not exist.
  assert.equal(explainAttempt({ channel_data: { message_status: 'delivered', error_code: '0' } }).error_code, null);
  assert.equal(explainAttempt({ channel_data: { message_status: 'delivered', error_code: 0 } }).error_code, null);
  assert.equal(explainAttempt({ channel_data: { message_status: 'failed', error_code: 30034 } }).error_code, '30034');
});

test('THE 30 AUG SIGNUP, actual cause: right pipe, wrong digits', () => {
  // Every field said the send was healthy. It was. The code went to
  // +1310735…, one digit from the number the person was holding — and no
  // status, error code or hint anywhere in the payload would ever say so.
  // The destination is the fact that solves this, so it must be surfaced and
  // it must appear in the verdict a human reads.
  const a = explainAttempt({
    date_created: new Date().toISOString(),
    channel_data: { to: '+13107356298', status: 'unconfirmed', message_status: 'delivered', error_code: '0', carrier: 'T-Mobile' },
  });
  assert.equal(a.to, '+13107356298');
  assert.equal(a.carrier, 'T-Mobile');
  const v = verdictFor({ configured: { ok: true, note: '' }, attempts: { ok: true, attempts: [a] } });
  assert.equal(v.state, 'delivering');
  assert.match(v.say, /\+13107356298/, 'the verdict never names the number it texted');
  assert.match(v.say, /CHECK THAT NUMBER IS THEIRS/, 'the verdict does not tell the reader what to check first');
});

test('an old unresolved attempt is not called "pending"', () => {
  // "Ask again in a minute" about something nineteen hours old is a cheerful
  // non-answer — the exact species of nonsense this file exists to end.
  const old = explainAttempt({ date_created: '2026-08-30T22:15:04Z', channel_data: { to: '+13107356298', status: 'unconfirmed' } });
  const now = new Date('2026-08-31T17:00:00Z').getTime();
  assert.equal(isStale(old, now), true);
  const v = verdictFor({ configured: { ok: true, note: '' }, attempts: { ok: true, attempts: [old] }, now });
  assert.equal(v.state, 'unresolved');
  assert.match(v.say, /Waiting will not change this/);
  assert.match(v.say, /\+13107356298/, 'the destination is the one actionable fact and it is missing');

  // A young one is still genuinely pending.
  const fresh = explainAttempt({ date_created: new Date(now - 10_000).toISOString(), channel_data: { status: 'unconfirmed' } });
  assert.equal(verdictFor({ configured: { ok: true, note: '' }, attempts: { ok: true, attempts: [fresh] }, now }).state, 'pending');
});
