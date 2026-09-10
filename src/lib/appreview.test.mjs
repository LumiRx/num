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
const DANGER = read('../components/app/DangerZone.tsx');
const APP = read('../components/app/ConciergeApp.tsx');

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


describe('5.1.1(v) — deletion has to be findable, not merely present', () => {
  test('there is a signpost near the top of the profile', () => {
    // It was at the bottom of a long scroll. Apple reported it missing and
    // Dre could not find it in his own app on 9 Sep. A destructive action
    // should be quiet, not hidden.
    // The label is the action itself, not a direction to it: one tap now
    // opens the confirmation rather than scrolling to a shut control.
    assert.match(PROFILE, /aria-label="Delete my account"/);
    assert.match(PROFILE, /store\.set\(\{ deleteOpen: true \}\)/, 'the row must open the flow');
    assert.match(PROFILE, /getElementById\('delete-account'\)/);
    assert.match(DANGER, /id="delete-account"/, 'the signpost needs something to point at');
  });

  test('the signpost sits above the danger zone it points to', () => {
    assert.ok(PROFILE.indexOf('aria-label="Delete my account"') < PROFILE.indexOf('<DangerZone />'));
  });
});

describe('the close buttons clear the notch and can be hit', () => {
  test('every full-screen overlay header uses the safe-area inset', () => {
    // The thread header had a flat 12px while the profile header next to it
    // already used the inset, so the chat X sat under the Dynamic Island.
    const headers = [...APP.matchAll(/padding: '([^']*)' , 16px 6px|padding: '([^']*)16px 6px'/g)];
    const flat = APP.match(/padding: '12px 16px 6px'/g);
    assert.equal(flat, null, 'a full-screen header with no safe-area inset puts its X under the status bar');
    assert.ok(headers.length >= 0);
    assert.ok((APP.match(/max\(env\(safe-area-inset-top\), 12px\) 16px 6px/g) ?? []).length >= 2);
  });

  test('the close targets are at least 44pt', () => {
    assert.equal(APP.match(/width: 30, height: 30, borderRadius: 999/g), null,
      'Apple s minimum tap target is 44pt; 30 is hard to hit at the top edge of a phone');
  });
});


describe('the profile reads as a page, not a stack of squares', () => {
  test('the sections are labelled', () => {
    // Eleven identical glass cards in one column, nothing more important than
    // anything else. The cards are fine; the rhythm was missing.
    for (const g of ['TRAVEL', 'TASTE', 'ACCOUNT']) {
      assert.ok(PROFILE.includes(`<Group>${g}</Group>`), `${g} group heading is missing`);
    }
  });

  test('the delete row is a line, not another big card', () => {
    const i = PROFILE.indexOf('aria-label="Delete my account"');
    const el = PROFILE.slice(i, i + 900);
    assert.ok(!/\.\.\.card,/.test(el), 'it should not reuse the full card style');
    assert.match(el, /minHeight: 44/, 'still a full-size tap target');
  });
});
