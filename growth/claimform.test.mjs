// The claim form is the last step of every business invitation, and it was
// rejecting the people it invited.
//
// 7 Sep 2026: 503 invitations, 200 opened, 19 businesses clicked through to a
// form ALREADY FILLED IN with their own name — and one completed it. The form
// required a mobile number and the server rejected anything without one, while
// every single visitor had arrived by clicking a link in an email we had sent
// them. We held the address and demanded a phone number instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worker = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const form = readFileSync(new URL('../public/claim/index.html', import.meta.url), 'utf8');

test('the server accepts a business that offers an email instead of a phone', () => {
  assert.match(worker, /if \(!hasPhone && !hasEmail\) return J\(\{ ok: false, error: "need_contact" \}, 400\);/,
    'the requirement is not "reach them somehow"');
  assert.ok(
    !/if \(!okPhone\(phone\)\) return J\(\{ ok: false, error: "bad_phone" \}/.test(worker),
    'the server still rejects every business that has no phone number to give',
  );
});

test('a malformed value is still refused — optional is not unvalidated', () => {
  assert.match(worker, /if \(phone && !hasPhone\) return J\(\{ ok: false, error: "bad_phone" \}/);
  assert.match(worker, /if \(email && !okEmail\(email\)\) return J\(\{ ok: false, error: "bad_email" \}/);
});

test('an absent phone is stored as NULL, never as an empty string', () => {
  // "" in a phone column reads as a number we hold and cannot dial. NULL is
  // the honest value and is what every downstream `phone IS NOT NULL` expects.
  assert.match(worker, /hasPhone \? localE164\(phone, req, b\.country\) : null/);
});

test('the form no longer demands a mobile number', () => {
  const phoneField = form.slice(form.indexOf('id="phone"'), form.indexOf('id="phone"') + 200);
  assert.ok(!/\brequired\b/.test(phoneField), 'the phone input is still required in the browser');
  assert.match(form, /id="l-phone">Mobile number <span class="opt">/, 'the label does not say it is optional');
});

test('business name and contact name are still required', () => {
  // The change was "which channel", not "ask for nothing". A claim with no
  // business name is not a claim.
  assert.match(worker, /if \(!business\) return J\(\{ ok: false, error: "no_business" \}/);
  const nameField = form.slice(form.indexOf('id="contact_name"'), form.indexOf('id="contact_name"') + 160);
  assert.match(nameField, /required/);
});
