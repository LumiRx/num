// The install card has to live where the install can happen.
//
// This is a structural test, not a behavioural one, because the bug it exists
// to catch was structural and cost us most of a month of phone traffic:
// InstallPrompt was mounted in LaunchStage and nowhere else, and App.tsx sends
// every viewport under 720px to ConciergeApp instead of LaunchStage. The card
// was therefore rendered ONLY on desktop — where "add to home screen" is
// close to meaningless — and never once on a phone, which is the only device
// that can act on it and very nearly all of our traffic.
//
// Nothing about that was visible from either file alone. Both looked correct.
// So the assertion is on the pair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const APP = src('../App.tsx');
const CONCIERGE = src('../components/app/ConciergeApp.tsx');
const LAUNCH = src('../components/canvas/LaunchStage.tsx');
const PROMPT = src('../components/app/InstallPrompt.tsx');

test('a phone-width viewport routes to ConciergeApp, not the launch page', () => {
  // If this ever stops being true the rest of the file is testing the wrong
  // component, so it is asserted rather than assumed.
  assert.match(APP, /innerWidth < 720/);
  assert.match(APP, /if \(standalone\)/);
  assert.match(APP, /<ConciergeApp standalone \/>/);
});

test('the install card is mounted on the app surface', () => {
  assert.match(CONCIERGE, /import InstallPrompt from '\.\/InstallPrompt'/);
  assert.match(CONCIERGE, /<InstallPrompt\b/);
});

test('and still on the launch page, so desktop visitors keep theirs', () => {
  assert.match(LAUNCH, /InstallPrompt/);
});

test('the app-surface copy is suppressed while a sheet is up', () => {
  // The name gate is a sheet. A fixed z-60 card landing on top of it would
  // buy an install by spending a signup, which is a bad trade in both
  // directions — we would lose the person and the number.
  const mount = CONCIERGE.slice(CONCIERGE.indexOf('<InstallPrompt'));
  assert.match(mount, /suppressed=\{[^}]*overlayOpen/);
});

test('the card refuses to render where nothing can be installed', () => {
  // Native build: already the app. Standalone: already installed. Both of
  // these are the difference between a helpful card and a bug report.
  assert.match(PROMPT, /if \(!canOfferInstall\(\)\) return;/);
  assert.match(PROMPT, /if \(isStandalone\(\)\) return;/);
});

/**
 * ── WHEN the card appears, which is a different bug from WHERE ────────────
 *
 * The comment in InstallPrompt.tsx has said since 17 Sep that the offer makes
 * sense "AFTER they have asked something and got a real answer back — at which
 * point it is an upgrade rather than a toll gate". The code said
 * `msgs.some(m => m.who === 'u')`, which is true the instant the guest hits
 * send. Watched on a live phone-sized session on 18 Sep: message sent, card
 * up, answer arriving underneath it, composer covered.
 *
 * A toll gate before the answer and a card on top of the answer are the same
 * mistake, and the second is worse — the guest saw the value arrive and then
 * saw it covered. These pin the condition to what the comment always claimed.
 */
test('the card waits for an ANSWER, not for the guest pressing send', () => {
  const gate = PROMPT.slice(PROMPT.indexOf('const answered'), PROMPT.indexOf('eslint-disable-next-line react-hooks'));
  assert.ok(gate.length > 40, 'the gate is named `answered` — if it is renamed, re-read this test');
  assert.match(gate, /findIndex\(\(m\) => m\.who === 'u'\)/, 'it locates the first thing the guest said');
  assert.match(gate, /slice\(firstAsk \+ 1\)\.some\(\(m\) => m\.who === 'c'\)/,
    'and requires a reply from NUM AFTER it — not merely any reply, and not the send');
  assert.doesNotMatch(gate, /msgs\.some\(\(m\) => m\.who === 'u'\)/,
    'the old condition fired on send and covered the answer it was meant to follow');
});

test('and gives the guest a beat to read the answer first', () => {
  const gate = PROMPT.slice(PROMPT.indexOf('const answered'), PROMPT.indexOf('eslint-disable-next-line react-hooks'));
  assert.match(gate, /setTimeout\(\(\) => setShow\(true\), \d{4}\)/,
    'the card is armed on a delay — landing on the same frame as the answer is landing on top of it');
});
