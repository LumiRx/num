// "After someone signs up in the browser we should walk them through how to
// add it as an app." — Dre, 20 Sep 2026.
//
// The reason is mechanical, not promotional. A signup IS a verified phone or
// address: a promise that NUM can reach them. In a browser tab that promise
// is half-empty — no push, so a plan that moves at 6pm reaches nobody. The
// moment somebody hands over a number is the moment the home screen stops
// being a nicety.
//
// What this file guards is the other half: that the offer stays a single
// moment and does not become nagging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('../components/app/InstallPrompt.tsx', import.meta.url), 'utf8');
const src = raw
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');

test('a signup opens the card', () => {
  assert.match(src, /import \{ canSend \} from '\.\.\/\.\.\/lib\/gate'/);
  assert.match(src, /if \(now && !was && !flag\(SIGNUP_KEY\)\)/);
});

test('it fires on the TRANSITION, so signing in on a device that already has one does not re-offer', () => {
  assert.match(src, /let was = canSend\(store\.get\(\)\.me\);/,
    'the starting value is not read, so an already-verified member trips it on the first tick');
  assert.match(src, /was = now;/);
});

test('it is spent once, and its key is its own', () => {
  // Separate from DISMISS_KEY on purpose: somebody who waved the card away as
  // a stranger and then proved a phone number is not making the same
  // decision twice. One more showing, and exactly one.
  assert.match(src, /const SIGNUP_KEY = 'num-install-after-signup';/);
  const values = [...src.matchAll(/const (?:SIGNUP|DISMISS)_KEY = '([^']+)'/g)].map((m) => m[1]);
  assert.equal(values.length, 2, 'one of the two keys has gone');
  assert.notEqual(values[0], values[1], 'the two keys have been collapsed into one');
  assert.match(src, /mark\(SIGNUP_KEY\);/);
  assert.match(src, /stop\(\);/, 'the subscription keeps running after it has fired');
});

test('the steps are already open — an offer you must tap to read is not a walk-through', () => {
  assert.match(src, /setReason\('signup'\);\s*setOpen\(true\);\s*setShow\(true\);/);
});

test('the signup card says why, in the terms the person just agreed to', () => {
  assert.match(raw, /You just gave NUM a way to reach you/);
  assert.match(src, /reason === 'signup' \?/);
});

test('nothing is offered where there is nothing to install', () => {
  // The app-store build and an already-installed home-screen launch both have
  // to be out before any of this runs, signup or no signup.
  const i = src.indexOf('if (!canOfferInstall()) return;');
  const j = src.indexOf('isStandalone()');
  const k = src.indexOf('SIGNUP_KEY)');
  assert.ok(i > 0 && j > i && k > j, 'the signup path can fire inside the native app');
});
