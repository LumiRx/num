// A verified number with no consent row was a member Num could never text.
// These pin that verification records the exact sentence the sign-up sheet
// shows, and that the two copies of that sentence never drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SIGNUP_CONSENT_TEXT, SOURCE } from './smsconsent.mjs';

const social = readFileSync(new URL('./social.mjs', import.meta.url), 'utf8');
const sheet = readFileSync(new URL('../src/components/app/InviteSheet.tsx', import.meta.url), 'utf8');

test('the sentence the app shows is the sentence the server records', () => {
  const shown = sheet.replace(/\s+/g, ' ');
  assert.ok(shown.includes(SIGNUP_CONSENT_TEXT), 'InviteSheet.tsx does not show SIGNUP_CONSENT_TEXT word for word');
  assert.match(SIGNUP_CONSENT_TEXT, /Reply STOP any time\.$/);
  assert.match(SIGNUP_CONSENT_TEXT, /Message rates may apply/);
  assert.doesNotMatch(SIGNUP_CONSENT_TEXT, /offers|deals|marketing|promotions/i, 'this is transactional consent, not a marketing opt-in');
});

test('verification records consent as web_form with the sentence, after phone_verified is set, and never fails the verification', () => {
  const fn = social.slice(social.indexOf('async function verifyMe('), social.indexOf('async function', social.indexOf('async function verifyMe(') + 10));
  const flag = fn.indexOf("SET phone_verified=1");
  const rec = fn.indexOf('c.record(env, {');
  assert.ok(flag > 0 && rec > flag, 'consent is recorded before the number is verified, or not at all');
  assert.match(fn, /source: c\.SOURCE\.WEB_FORM/);
  assert.match(fn, /consentText: c\.SIGNUP_CONSENT_TEXT/);
  assert.match(fn, /\.catch\(\(e\) => console\.warn\('\[verify\] consent record failed'/, 'a bookkeeping failure must not fail a verification');
  assert.equal(SOURCE.WEB_FORM, 'web_form');
});
