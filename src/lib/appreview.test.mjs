/**
 * The four things Apple rejected 1.0(2) for, pinned in source.
 *
 * Review on 30 Aug 2026, iPad Air 11-inch (M3), iPadOS 26.6. Three of the four
 * rejections had ONE cause: the app crashed on tapping the profile picture, so
 * the reviewer never reached ProfileView — which is where Sign in with Apple
 * (4.8) and Delete My Account (5.1.1(v)) both live. Fix the crash and two
 * rejections stop being true.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const PROFILE = read('../components/app/ProfileView.tsx');
const BIZ = read('../components/app/BusinessSheet.tsx');
const PLIST = read('../../ios/App/App/Info.plist');
const VERIFY = read('../components/app/Verify5arz.tsx');

describe('2.1(a) — the crash on tapping the profile picture', () => {
  test('the media usage descriptions iOS kills the process without are present', () => {
    // No NSCameraUsageDescription and iOS SIGABRTs the instant the picker
    // offers "Take Photo". Added 30 Aug, AFTER the rejection — never shipped.
    assert.match(PLIST, /<key>NSCameraUsageDescription<\/key>/);
    assert.match(PLIST, /<key>NSPhotoLibraryUsageDescription<\/key>/);
  });

  test('the file input is never display:none — iPad anchors a popover to its rect', () => {
    // The second, independent iPad-only failure. `hidden` is display:none, so
    // the rect is zero and UIPopoverPresentationController has nothing to
    // anchor to. Invisible-but-laid-out is the fix; `hidden` must not return.
    const i = PROFILE.indexOf('type="file"');
    assert.ok(i > 0, 'the profile picture input must still exist');
    // The ELEMENT only. The comment above it says the word "hidden" on
    // purpose, to warn the next reader off it.
    const start = PROFILE.lastIndexOf('<input', i);
    const el = PROFILE.slice(start, PROFILE.indexOf('/>', i) + 2);
    assert.ok(!/\bhidden\b(?!=)/.test(el), 'a hidden file input has no popover anchor on iPad');
    assert.match(el, /opacity: 0/, 'invisible, but laid out');
    assert.match(el, /position: 'absolute'/);
  });
});

describe('4.8 and 5.1.1(v) — already built, behind the crash', () => {
  test('Sign in with Apple is offered in the profile the reviewer never reached', () => {
    assert.match(PROFILE, /<AppleSignIn \/>/);
  });

  test('account deletion is offered there too', () => {
    assert.match(PROFILE, /<DangerZone \/>/);
  });

  test('the Google card that triggered 4.8 stays off on iOS', () => {
    assert.match(VERIFY, /nativePlatform\(\) === 'ios'/);
    assert.match(VERIFY, /if \(iosBuild\) return;/);
  });
});

describe('4.0 — nothing that registers an account may leave the app', () => {
  test('the outbound claim link is not offered on iOS', () => {
    assert.match(BIZ, /nativePlatform\(\) === 'ios' \?/);
    const i = BIZ.lastIndexOf('href="https://itsnum.com/claim"');
    assert.ok(i > 0);
    // The link may still exist for web and Android; it must sit on the false
    // branch of the iOS check, not before it.
    assert.ok(BIZ.indexOf("nativePlatform() === 'ios' ?") < i, 'the iOS branch must guard the link');
  });
});
