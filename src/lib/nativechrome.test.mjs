/**
 * The installed-app chrome guard.
 *
 * Every bug this file protects against has the same shape and all of them
 * shipped in TestFlight build 1.0(1):
 *
 *   "am I installed?" was asked with `(display-mode: standalone)` — a PWA
 *   question — and the App Store build is not a PWA. It is a WKWebView
 *   serving a bundle from capacitor://localhost, where that media query is
 *   false and `navigator.standalone` is undefined. So the app answered "no,
 *   I am a Safari tab" about itself, and then acted on it:
 *
 *     - InviteSheet rendered "Tap Share, then Add to Home Screen" INSIDE the
 *       app, telling a TestFlight tester to install the app they are holding
 *       and spending ~200px directly above the sign-up button on the one
 *       screen whose vertical room is already halved by the keyboard.
 *     - social.ts refused to accept the invite that opened the app and showed
 *       a carry-across pair code instead.
 *     - push.ts reported 'needs-install' on iOS native, prompting for an
 *       install to enable notifications that arrive over APNs regardless.
 *
 * src/lib/native.ts already answers this correctly, with two independent
 * witnesses (the Capacitor bridge AND the origin). These assertions exist so
 * a call site can never again ask the question itself and get it wrong.
 *
 * Asserted against source text rather than by rendering, because these are
 * platform branches: a jsdom run cannot be capacitor://localhost, so a
 * behavioural test would have to fake the very signal under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/**
 * Strip comments so prose ABOUT a bug never satisfies a test looking for it.
 *
 * LINE comments go first, and the order is not cosmetic. social.ts line 2
 * reads "Talks to /api/social/* (worker/social.mjs)" — that `/*` inside a
 * line comment opens a block comment as far as a regex is concerned, and the
 * next `*​/` in the file is 2kB later, so a block-first pass silently swallows
 * every import in the file and the import assertions below fail on code that
 * is perfectly correct. Removing whole-line comments first takes that `/*`
 * out of play before anything looks for block comments.
 *
 * The line pattern is anchored with ^\s* so a `https://` inside real code is
 * never mistaken for the start of a comment.
 */
const code = (p) =>
  read(p)
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

const PWA_SNIFF = /display-mode:\s*standalone|\.standalone\b/;

test('the install card is gated on canOfferInstall(), not a PWA media query', () => {
  const src = code('../components/app/InviteSheet.tsx');
  const fn = src.slice(src.indexOf('function AddToHomeScreen'), src.indexOf('export default'));
  assert.ok(fn.length > 0, 'AddToHomeScreen not found in InviteSheet');
  assert.match(fn, /canOfferInstall\(\)/, 'AddToHomeScreen must ask native.ts, not the DOM');
  assert.doesNotMatch(
    fn,
    PWA_SNIFF,
    'AddToHomeScreen is sniffing for a PWA again. That is false inside the App Store build, so the install card renders in the installed app. Use canOfferInstall().',
  );
});

test('the install card imports its answer from native.ts', () => {
  assert.match(
    code('../components/app/InviteSheet.tsx'),
    /import \{[^}]*canOfferInstall[^}]*\} from '\.\.\/\.\.\/lib\/native'/,
    'InviteSheet must import canOfferInstall from lib/native',
  );
});

for (const [file, label] of [
  ['./social.ts', 'invite and connect parking'],
  ['./push.ts', 'push install gate'],
]) {
  test(`${label} counts the native app as installed`, () => {
    const src = code(file);
    const checks = [
      ...src.matchAll(/const installed[\s\S]{0,240}?;/g),
      ...src.matchAll(/installedOnHomeScreen[\s\S]{0,240}?;/g),
    ];
    let sawPwaCheck = false;
    for (const m of checks) {
      if (!PWA_SNIFF.test(m[0])) continue;
      sawPwaCheck = true;
      assert.match(
        m[0],
        /isNativeApp\(\)/,
        `${file}: an "am I installed" check uses the PWA signals without isNativeApp(). Inside the App Store build both PWA signals are false, so the app decides it is a browser tab and takes the browser branch.`,
      );
    }
    assert.ok(sawPwaCheck, `${file}: expected an installed-check to guard; did it move?`);
    assert.match(src, /import \{[^}]*isNativeApp[^}]*\} from '\.\/native'/, `${file} must import isNativeApp`);
  });
}
