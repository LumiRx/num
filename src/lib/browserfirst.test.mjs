// Let people use Num in the browser they arrived in.
//
// ── THE DECISION, 2 SEPTEMBER 2026 ───────────────────────────────────────
//
// An account belongs to a verified phone number now, not to a device's
// storage. That retires the reason the escape card interrupted on arrival:
// there is no longer an account to lose, so there is nothing urgent to warn
// a stranger about before Num has said anything useful.
//
// New shape: Num works inside Instagram, so let it. Offer the home screen
// after the first real message, when it is an upgrade rather than a toll
// gate. And never again claim their account might vanish — that problem is
// fixed, and frightening someone about a fixed problem costs a signup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { escapeInstruction } from './webview.mjs';

const code = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');

const prompt = code('../components/app/InstallPrompt.tsx');
const main = code('../main.tsx');
const appPage = readFileSync(new URL('../../public/app/index.html', import.meta.url), 'utf8');

const IG = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 340.0.0.19.109';

/* ── the card waits ─────────────────────────────────────────────────────── */

test('the escape card no longer shows on arrival', () => {
  // `if (escape) { setShow(true); return; }` was the whole bug in one line.
  assert.ok(!/if \(escape\) \{\s*setShow\(true\);\s*return;\s*\}/.test(prompt),
    'the in-app card still interrupts before the guest has done anything');
});

test('it waits for a message the GUEST sent, not any message', () => {
  // Num speaks first. Keying off msgs.length would fire on the greeting,
  // which is the same interruption with extra steps.
  const gate = prompt.slice(prompt.indexOf('if (escape) {'));
  assert.match(gate, /msgs\.some\(\(m\) => m\.who === 'u'\)/,
    'the gate does not require a message from the guest');
});

test('it subscribes, so the card appears on the first ask and not a reload later', () => {
  const gate = prompt.slice(prompt.indexOf('if (escape) {'), prompt.indexOf('if (escape) {') + 600);
  assert.match(gate, /store\.subscribe\(/, 'nothing watches for the first message');
  assert.match(gate, /stop\(\)/, 'the subscription is never unsubscribed');
});

/* ── the words ──────────────────────────────────────────────────────────── */

test('the card no longer claims an account may be lost', () => {
  const card = escapeInstruction(IG);
  assert.ok(card, 'Instagram is no longer detected at all');
  assert.ok(!/may not be kept|can’t be added|cannot be kept/i.test(card.body),
    `the card still warns about losing an account: ${card.body}`);
  assert.match(card.body, /works fine in here|travels with your number/i,
    'the card does not say the guest can carry on using Num');
});

test('the steps still say how to reach a home screen', () => {
  // Softening the warning must not delete the instruction — the card is now
  // an offer, and an offer with no method is just a nicer dead end.
  const ios = escapeInstruction(IG);
  assert.match(ios.steps.join(' '), /Open in Safari/);
  assert.match(ios.steps.join(' '), /home screen/);
});

/* ── the site says the same thing ───────────────────────────────────────── */

test('the install page leads with using Num, not with escaping', () => {
  const panel = appPage.slice(appPage.indexOf('<section id="inapp"'), appPage.indexOf('</section>', appPage.indexOf('<section id="inapp"')));
  const use = panel.indexOf('Start using Num');
  const escapeStep = panel.indexOf('Open in Safari');
  assert.ok(use > 0, 'the in-app panel offers no way to just use Num');
  assert.ok(escapeStep > use,
    'the page still leads with instructions to leave rather than an offer to start');
  assert.match(panel, /home screen\?/i, 'the home-screen route is gone entirely');
});

test('the page no longer tells an in-app visitor their account is at risk', () => {
  const panel = appPage.slice(appPage.indexOf('<section id="inapp"'), appPage.indexOf('</section>', appPage.indexOf('<section id="inapp"')));
  assert.ok(!/may not be kept/i.test(panel), 'the old warning survives on the site');
  assert.match(panel, /lives on your phone number|follows you/i,
    'the page does not explain why using it here is safe');
});

/* ── and a crash is never silent again ──────────────────────────────────── */

test('render errors are caught before they blank the app', () => {
  assert.match(main, /<Boundary>/, 'nothing catches a render error — React unmounts the whole tree');
  const boundary = main.indexOf('<Boundary>');
  const app = main.indexOf('<App />');
  assert.ok(boundary > 0 && boundary < app, 'the boundary is inside the tree it must protect');
});

test('errors outside render are reported too', () => {
  // A rejected promise or a broken handler blanks a page just as well, and
  // the boundary cannot see either.
  assert.match(main, /'unhandledrejection'/, 'unhandled promise rejections go unrecorded');
  assert.match(main, /app_error/, 'nothing is reported when something throws');
});
