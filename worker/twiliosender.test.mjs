// The 30034 fix, and the three places it has to hold.
//
// Context, because the test names will not carry it on their own: every SMS
// Num sent to a real phone came back 30034, "A2P campaign not registered or
// not approved". For a month that was recorded as "A2P is unregistered". It
// was not — brand and campaign were both approved on 28 Jul 2026, a week
// before the first failure. A US long code inherits campaign approval through
// its MESSAGING SERVICE, and every call site was sending a bare `From:`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { senderParams, usingMessagingService } from './twiliosender.mjs';

const src = (f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
const SVC = 'MG64fac2280000000000000000000000ab';   // MG + 32 hex
const NUM = '+14243460888';

/* ── choosing a sender ──────────────────────────────────────────────────── */

test('the Messaging Service wins when one is configured', () => {
  const p = senderParams({ TWILIO_MESSAGING_SERVICE_SID: SVC, TWILIO_FROM: NUM });
  assert.deepEqual(p, { MessagingServiceSid: SVC });
  // The bare number must NOT also be sent: supplying both is what Twilio
  // rejects outright, and it is the obvious "belt and braces" mistake here.
  assert.ok(!('From' in p));
  assert.equal(usingMessagingService({ TWILIO_MESSAGING_SERVICE_SID: SVC }), true);
});

test('without a service it falls back to the number, exactly as before', () => {
  // Non-US destinations need no campaign, and a missing secret must degrade to
  // the old behaviour rather than stop every message in the product.
  assert.deepEqual(senderParams({ TWILIO_FROM: NUM }), { From: NUM });
  assert.equal(usingMessagingService({ TWILIO_FROM: NUM }), false);
});

test('neither configured means do not attempt a send', () => {
  assert.equal(senderParams({}), null);
  assert.equal(senderParams(undefined), null);
});

test('a SID of the wrong SHAPE falls back instead of failing at Twilio', () => {
  // These are the four things a person could plausibly paste into the secret.
  // Each would be accepted by a naive presence check and then rejected by
  // Twilio with an error nobody would trace back to the wrong paste.
  for (const wrong of [
    'AC00000000000000000000000000000000',            // account SID
    'CM00000000000000000000000000000000',            // campaign SID
    'BN00000000000000000000000000000000',            // brand SID
    'MG64fac228',                                     // truncated paste
  ]) {
    assert.deepEqual(
      senderParams({ TWILIO_MESSAGING_SERVICE_SID: wrong, TWILIO_FROM: NUM }),
      { From: NUM },
      `${wrong.slice(0, 2)}… should not be treated as a Messaging Service`,
    );
  }
});

test('whitespace around a pasted SID does not break it', () => {
  assert.deepEqual(
    senderParams({ TWILIO_MESSAGING_SERVICE_SID: `  ${SVC}\n` }),
    { MessagingServiceSid: SVC },
  );
});

/* ── every sender uses it — this is the part that regressed before ──────── */

for (const [file, fn] of [
  ['./claim.mjs', 'sendSms — the sign-in code'],
  ['./bookdesk.mjs', 'smsPartner — the venue booking text'],
  ['./health.mjs', 'alert — the message that says something broke'],
]) {
  test(`${fn} sends through senderParams, not a bare From`, () => {
    const s = src(file);
    assert.match(s, /import \{ senderParams \} from '\.\/twiliosender\.mjs'/,
      `${file} must import the shared sender`);
    // No call site may put TWILIO_FROM straight into a request body again.
    assert.doesNotMatch(s, /From: env\.TWILIO_FROM/,
      `${file} still builds a bare From — this is the 30034 bug`);
    assert.match(s, /\.\.\.(sms)?[Ss]ender,/, `${file} must spread the chosen sender`);
  });
}

/* ── the health check that would have caught this in August ────────────── */

test('health warns when a number is set but no Messaging Service is', () => {
  const s = src('./health.mjs');
  assert.match(s, /TWILIO_MESSAGING_SERVICE_SID/);
  assert.match(s, /30034/, 'the remedy must name the error code someone will be googling');
  // A warning, never a failure: outside the US the bare number is correct, and
  // this must not take a Thailand-only deployment red.
  const check = s.slice(s.indexOf('function checkSms('), s.indexOf('\n}', s.indexOf('function checkSms(')));
  assert.match(check, /ok: true, warn:/, 'the missing-service case must warn, not fail');
  assert.match(check, /ok: false, remedy:/, 'a malformed SID must fail loudly');
});
