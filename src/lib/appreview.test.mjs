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
    assert.match(PROFILE, /aria-label=(?:"Delete my account"|\{t\('Delete my account'\)\})/);
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
    //
    // 18 Sep 2026: the remodel regrouped the page — the three preference
    // sections (quick, travel, taste) became ONE collapsed card with a count
    // on the front, so TRAVEL and TASTE are no longer group headings. The
    // rhythm the test guards is still there, under the new names.
    for (const g of ['STARS & CODES', 'WHAT NUM KNOWS ABOUT YOU', 'YOUR NUM', 'SETTINGS', 'ACCOUNT & DATA']) {
      assert.ok(PROFILE.includes(`<Group>{t('${g}')}</Group>`), `${g} group heading is missing`);
    }
  });

  test('the preference fields are one collapsed card with a count, not three open ones', () => {
    assert.match(PROFILE, /title=\{t\('TELL NUM ABOUT YOU'\)\}/);
    assert.match(PROFILE, /const filled = ALL_FIELDS\.filter/);
    // All three field sets still render, inside it.
    for (const f of ['QUICK_FIELDS', 'TRAVEL_FIELDS', 'TASTE_FIELDS']) assert.match(PROFILE, new RegExp(`fields=\\{${f}\\}`));
  });

  test('the plan is one tap from who you are', () => {
    assert.match(PROFILE, /getElementById\('your-plan'\)/, 'the PLAN chip must land on the plans card');
    assert.match(PROFILE, /<div id="your-plan">\s*<MembershipCard \/>/);
  });

  test('the delete row is a line, not another big card', () => {
    const i = PROFILE.search(/aria-label=(?:"Delete my account"|\{t\('Delete my account'\)\})/);
    const el = PROFILE.slice(i, i + 900);
    assert.ok(!/\.\.\.card,/.test(el), 'it should not reuse the full card style');
    assert.match(el, /minHeight: 44/, 'still a full-size tap target');
  });
});

/**
 * ── 1.0(8), 17 Sep 2026: "Where is the sign-in page?" (Guideline 2.1) ─────
 *
 * Third rejection, iPad Air 11-inch again. And the tests above were all
 * passing — because they pinned the CONTENTS of Profile, and the finding was
 * never really about Profile's contents. It was about getting there.
 *
 * Measured on the review device: the app's initial state is `threadOpen:
 * true`, and the thread panel is position:absolute at z-index 45 directly
 * over the app header. document.elementFromPoint at the centre of the header
 * returned the thread panel, in portrait and in landscape. The header — the
 * only route to Profile — was behind the product on launch, for everybody.
 *
 * So build 2's "the app crashed on the way to Profile" and build 8's "where
 * is sign-in" are the same finding twice. The crash was real and is fixed;
 * the covered header was never diagnosed, and outlived it.
 *
 * Two repairs, pinned below: the words "Sign in" now exist in the rendered
 * app, and they exist on the screen the app actually opens on.
 */
describe('2.1 (1.0(8)) — a stranger can find the way in', () => {
  // The RENDERED label only — `{t('Sign in')}` also appears as aria-label and
  // title on each control, and counting those would let a button with no
  // visible text satisfy a test about visible text.
  const signIns = [...APP.matchAll(/\{t\('Sign in'\)\}\s*\n\s*<\/div>/g)];

  test('the words "Sign in" are rendered, not merely implied', () => {
    // Before this, a search of the whole rendered app for "sign in", "log in",
    // "sign up" or "account" found one match — "SET UP MY ACCOUNT" — inside a
    // closed sheet. Every real door was labelled in our own voice: INTRODUCE
    // YOURSELF, SET UP MY ACCOUNT, "Tell NUM who I am". Good product voice,
    // and not the phrase a person scanning for a way in is looking for.
    assert.ok(signIns.length >= 2,
      'Sign in belongs in BOTH the app header and the thread header — see the next test');
  });

  test('it is on the screen the app opens on, not just the one behind it', () => {
    // Moving the default away from the thread would be the other repair, and
    // it is the wrong one: opening on the thread is deliberate, the thread is
    // the product. So the door appears on whichever surface is in front.
    const threadHeader = APP.slice(APP.indexOf('· ASK NUM ANYTHING'), APP.indexOf('Close thread') + 240);
    assert.match(threadHeader, /\{t\('Sign in'\)\}/,
      'the thread header must carry Sign in: it renders OVER the app header on launch');
    assert.match(threadHeader, /inviteOpen: \{\}/,
      'and it opens the account sheet directly — not Profile, not a menu');
  });

  test('every Sign in control clears the 44pt floor', () => {
    // It first shipped at 30px and taptargets.test.mjs refused it. Recorded
    // here too, because this is the one control App Review goes looking for.
    assert.ok(signIns.length >= 2, 'nothing to measure');
    for (const m of signIns) {
      assert.match(APP.slice(Math.max(0, m.index - 900), m.index), /minHeight: 44/,
        'a Sign in control shipped under 44pt');
    }
  });

  test('a signed-in member is never offered a way to sign in', () => {
    assert.equal([...APP.matchAll(/\{!me && \(\s*<div[\s\S]{0,900}?\{t\('Sign in'\)\}/g)].length, 2,
      'each Sign in control is guarded by {!me && …}');
  });

  test('the X is not alone in the thread\'s corner any more', () => {
    // A reviewer who does not think to close the product in order to find the
    // account will not close the product.
    const corner = APP.slice(APP.indexOf('· ASK NUM ANYTHING'), APP.indexOf('Close thread'));
    assert.match(corner, /Sign in/, 'Sign in sits beside the close button, not behind it');
  });
});
