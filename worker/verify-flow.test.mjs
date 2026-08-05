// A verification flow with one chance is not a verification flow.
//
// The original code called sendCode() in exactly one place: the first /me POST
// carrying a phone number. Every later attempt with that number hit the
// recovery branch, which returned "Welcome back — everything on this number is
// still here" and sent nothing, and no other route could issue a code. So if
// the first text failed, arrived late, or the person closed the app before
// typing it, they were permanently unable to verify — and the product told
// them everything was fine.
//
// It was invisible while A2P blocked every send anyway. The day approval lands
// it becomes the largest drop-off in the funnel. These tests pin the three
// properties that keep it fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const social = readFileSync(join(HERE, 'social.mjs'), 'utf8');

/** The body of a named function, up to the next top-level declaration. */
function fn(name) {
  const start = social.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const next = social.indexOf('\nasync function ', start + 10);
  return social.slice(start, next < 0 ? social.length : next);
}

test('a person can get a code more than once', () => {
  // The whole bug in one assertion: if only one call site can mint a code,
  // then missing it is terminal.
  const sites = [...social.matchAll(/\bsendCode\(/g)].length;
  const issuers = [...social.matchAll(/\bissueCode\(/g)].length;
  assert.ok(issuers >= 3,
    `a code can be issued from only ${issuers} place(s) — signup, recovery and resend must all be able to send, or missing the first text is permanent`);
  assert.equal(sites, 1,
    'sendCode is called from more than one place — minting logic has been duplicated and the copies will drift');
});

test('recovery sends a code instead of a reassuring dead end', () => {
  // "Welcome back, everything is still here" while silently doing nothing is
  // worse than an error: it stops the person trying anything else.
  const me = social.slice(social.indexOf('if (!holder.phone_verified) {'), social.indexOf('async function verifyMe'));
  assert.match(me, /issueCode\(/,
    'the recovery branch still returns without sending a code — a returning user can never verify');
  assert.ok(!/recovered_unverified/.test(me),
    'recovery still reports the old do-nothing reason instead of a real send result');
});

test('there is a resend route, because "I did not get it" always happens', () => {
  assert.match(social, /path === '\/resend' && post/, 'no resend endpoint is routed');
  assert.match(fn('resendCode'), /issueCode\(/, 'the resend handler does not actually issue a code');
});

test('the hash is only stored when the text actually went out', () => {
  // Storing a hash for a message that failed leaves a member who cannot
  // verify AND whose next attempt is told a code is already pending — the
  // worst of both states.
  const f = fn('issueCode');
  const guard = f.indexOf('if (!out.ok)');
  const write = f.indexOf('UPDATE num_members SET code_hash');
  // Assert PRESENCE before ordering. `indexOf` returns -1 for a missing
  // guard, and -1 is less than any real index — so a bare `guard < write`
  // comparison passes when the check has been deleted entirely, which is the
  // very mutation this test exists to catch.
  assert.ok(guard >= 0, 'the send result is never checked — a failed text still stores a code hash');
  assert.ok(write >= 0, 'no code hash is stored at all, so nothing can ever be verified');
  assert.ok(guard < write,
    'the code hash is written before the send result is checked — a failed text would leave a pending code nobody has');
});

test('resend is cooled down, since every call spends real money', () => {
  // An unthrottled resend button is a way for a stranger to spend the Twilio
  // balance. A cooldown refuses the masher without stranding the person whose
  // first text genuinely never came.
  const f = fn('resendCode');
  assert.match(f, /RESEND_COOLDOWN_SEC/, 'resend has no cooldown — each press sends another paid SMS');
  assert.match(f, /429/, 'a throttled resend does not return 429');
  assert.match(f, /retry_after_sec/,
    'the throttle does not tell the caller when to try again, so a UI cannot show anything useful');
});

test('an already-verified member is not re-texted', () => {
  const f = fn('resendCode');
  assert.match(f, /phone_verified.*already|already: true/s,
    'resend would text somebody who is already verified — a message with no purpose, billed to us');
});
