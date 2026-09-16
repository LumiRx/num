// Guards on the App Review fixes for 1.0(2). Each test names the guideline it
// protects, because the cost of a regression here is another rejection cycle,
// not a bug report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const root = (p) => readFileSync(join(HERE, '..', p), 'utf8');

/** Source with comments removed — a guard that reads prose finds the sentence
 *  promising the bad thing does not exist and reports the bad thing. */
const code = (p) => root(p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ');

test('2.1(a) — the camera usage description that stopped the crash is present', () => {
  // Apple's crash log, 2026-08-29 23:07, iPad Air M3: "attempted to access
  // privacy-sensitive data without a usage description ... must contain an
  // NSCameraUsageDescription key". The avatar picker offers "Take Photo".
  const info = root('ios/App/App/Info.plist');
  assert.match(info, /<key>NSCameraUsageDescription<\/key>/,
    'NSCameraUsageDescription is gone — tapping the profile picture will crash on iOS again');
  assert.match(info, /<key>NSPhotoLibraryUsageDescription<\/key>/);
  // A key with an empty string is the same crash with extra steps.
  const camera = /<key>NSCameraUsageDescription<\/key>\s*<string>([^<]+)<\/string>/.exec(info);
  assert.ok(camera && camera[1].trim().length > 10, 'the usage description must actually explain the use');
});

test('every media input has a matching usage description', () => {
  // The rule that generalises the crash: a file input that accepts images or
  // video opens a picker that can reach the camera.
  const profile = root('src/components/app/ProfileView.tsx');
  const inputs = [...profile.matchAll(/type="file"[^>]*accept="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(inputs.length > 0, 'the avatar input vanished — re-check this guard still means anything');
  const info = root('ios/App/App/Info.plist');
  for (const accept of inputs) {
    if (/image|video/.test(accept)) {
      assert.match(info, /NSCameraUsageDescription/,
        `an input accepting ${accept} ships without a camera usage description`);
    }
  }
});

test('4.8 — Sign in with Apple is entitled and built', () => {
  const ent = root('ios/App/App/App.entitlements');
  assert.match(ent, /com\.apple\.developer\.applesignin/, 'the Sign in with Apple entitlement is gone');
  const pbx = root('ios/App/App.xcodeproj/project.pbxproj');
  assert.match(pbx, /SignInWithApple\.swift in Sources/,
    'the plugin is no longer compiled into the target — the button would silently do nothing');
  assert.match(pbx, /CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/,
    'the entitlements file is not wired to the build configuration');
});

test('4.8 — the button is offered at least as prominently as the other option', () => {
  // Apple's HIG requires it to be no less prominent than any other sign-in.
  // Rendering it BELOW the Google card was the arrangement that got rejected.
  const profile = root('src/components/app/ProfileView.tsx');
  const apple = profile.indexOf('<AppleSignIn />');
  const google = profile.indexOf('<Verify5arz />');
  assert.ok(apple > 0, 'the Apple sign-in button is not mounted');
  assert.ok(apple < google, 'Sign in with Apple renders below the Google card — 4.8 asks for equal prominence');
});

test('4.0 — no account flow leaves the app on iOS', () => {
  // "the user is taken to the default web browser to sign in or register".
  const v = root('src/components/app/Verify5arz.tsx');
  assert.match(v, /nativePlatform\(\) === 'ios'/, 'the iOS gate on the Google flow is gone');
  assert.match(v, /if \(iosBuild\) return;/, 'the GIS client id fetch is no longer gated');
  assert.match(v, /if \(iosBuild \|\| !clientId/, 'the GIS script loader is no longer gated');
  assert.ok(!/accounts\.google\.com\/gsi\/client/.test(root('src/components/app/AppleSignIn.tsx')),
    'the Apple button must not pull in Google Identity Services');
});

test('the identity token is verified server-side, never decoded and believed', () => {
  const social = code('worker/social.mjs');
  assert.match(social, /verifyAppleToken\(/, 'the Apple endpoint stopped verifying the token');
  assert.ok(!/atob\(.*identity_token|JSON\.parse\(atob/.test(social),
    'something in social.mjs decodes a token without verifying it — that is an account takeover');
  const auth = code('worker/appleauth.mjs');
  assert.ok(!/skipVerify|allowUnsigned|NODE_ENV/.test(auth),
    'a bypass flag appeared in the verifier — there must be exactly one code path and it verifies');
});

test('5.1.1(v) — account deletion is findable, not merely present', () => {
  // Apple: "does not include an option to initiate account deletion". It did —
  // as 10.5px --ink-40 text at the foot of a long scroll. Existing is not the
  // bar; a reviewer (and a user) has to be able to see it.
  const dz = root('src/components/app/DangerZone.tsx');
  assert.match(dz, /aria-label="Delete my account"/, 'the delete control lost its accessible name');
  const size = /fontSize: (\d+(?:\.\d+)?), fontWeight: 700, color: '#a3271c'/.exec(dz);
  assert.ok(size && Number(size[1]) >= 13, 'the delete control shrank back below legible size');
  assert.ok(!/fontSize: 10\.5[\s\S]{0,80}DELETE MY ACCOUNT/.test(dz),
    'the faint 10.5px treatment that Apple could not find is back');
  // And it must still be a real delete, not a deactivate — Apple names that
  // explicitly as insufficient.
  assert.match(dz, /deleteAccount\(true\)/, 'the confirmed-delete call is gone');
});

test('4.8 — Apple sign-in is offered where an account actually begins', () => {
  // Mounting it only in Profile means a new user meets the name/number form
  // first and never sees it. App Review's screenshots show precisely that
  // outcome: a reviewer who typed a name, skipped the number, and landed in an
  // empty account.
  const sheet = root('src/components/app/InviteSheet.tsx');
  assert.match(sheet, /<AppleSignIn onDone=\{close\} \/>/, 'the first-run screen lost the Apple button');
  const apple = sheet.indexOf('<AppleSignIn');
  const nameField = sheet.indexOf("placeholder={sending ? 'Your name'");
  assert.ok(apple > 0 && apple < nameField,
    'Apple sign-in renders below the name/number form — 4.8 asks for at least equal prominence');
});

/**
 * THE DECISION THIS TEST GUARDS WAS REVERSED ON 12 SEP 2026, DELIBERATELY.
 *
 * It used to read "a blank phone number is still allowed — this was not the
 * bug", and it was right at the time: making the number mandatory would have
 * looked like a fix for the reviewer's empty account while actually putting
 * every new user back behind an SMS path that had verified two people.
 *
 * What that policy bought, measured: 107 of 147 members with no way to reach
 * them at all. So a contact is required again — but a MOBILE is not, which is
 * the part that keeps the original reasoning intact. There are three doors,
 * and Sign in with Apple is one of them, so nobody is stuck behind SMS.
 *
 * What must stay true either way is the reviewer's actual complaint: they
 * typed a name, skipped everything else, and landed in an empty account.
 * Under this rule they cannot skip everything else.
 */
test('a contact is required, but a MOBILE is not — the SMS path is still not a wall', () => {
  const sheet = root('src/components/app/InviteSheet.tsx');
  // The number is no longer labelled optional...
  assert.ok(!/Mobile \(optional/.test(sheet),
    'the sheet still calls the number optional — a new account must carry a contact');
  // ...and the alternative is offered on the same screen, in plain words.
  assert.match(sheet, /use my email instead/,
    'a mandatory number with no alternative IS the wall this file argued against');
  assert.match(sheet, /A NUMBER OR AN EMAIL/,
    'the button must say which of the two is missing rather than sitting dim');

  const social = root('worker/social.mjs');
  assert.match(social, /if \(!existing && !phone && !email\)/,
    'the server does not enforce the rule — a sheet-only rule is a suggestion');
  // EXISTING members are never locked out by a rule they signed up before.
  assert.match(social, /!existing && !phone && !email/,
    'the guard must be scoped to NEW accounts');
});

test('Sign in with Apple satisfies the contact rule on its own', () => {
  // Apple hands us a verified identity, and guideline 4.8 obliges us to offer
  // the button anyway. Demanding a number on top of it would be asking the
  // same person to prove the same thing twice, on the one path that has no
  // code to wait for.
  const contact = root('worker/membercontact.mjs');
  assert.match(contact, /apple_sub/, 'an Apple identity must count as reachable');
  const sheet = root('src/components/app/InviteSheet.tsx');
  const apple = sheet.indexOf('<AppleSignIn');
  const emailOffer = sheet.indexOf('use my email instead');
  assert.ok(apple > 0 && apple < emailOffer,
    'the one-tap door should be reached before the two typed ones');
});

test('4.0 — THERE IS NO PHONE FRAME, on any surface', () => {
  // App Review photographed 1.0(2) as a phone-shaped card floating on black on
  // an iPad Air M3. That frame was the web launch stage leaking into a binary.
  //
  // It used to be fixed by SCOPING: `html:not(.num-native) .app-shell` drew
  // the 440px frame for browsers and skipped it inside the installed app. This
  // test asserted that scoping.
  //
  // On 16 Sep 2026 the frame was deleted outright. Desktop browsers stopped
  // being an audience to show the product TO and became people trying to USE
  // it — the X flight sent 133 US desktop visitors in a day and every one got
  // a marketing page — so a browser now gets the real app, centred at a
  // readable measure, exactly as an iPad does.
  //
  // So the property to hold is no longer "the frame is scoped away from
  // native". It is stronger and simpler: nothing anywhere draws a phone.
  const css = root('src/styles/glass.css');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/width:\s*440px/.test(rules),
    'a 440px phone frame is back in glass.css — it will render inside the installed app again');
  // Scoped to the STAGE rule, not the whole file: `html, body` is still
  // painted #14100e for the pitch page at ?stage, which genuinely does float a
  // column on a dark ground. `html.num-standalone` overrides it to the app's
  // own background everywhere the app renders, browser included.
  const stage = /\.app-shell-stage \{[^}]*\}/.exec(rules)?.[0] ?? '';
  assert.ok(!/#14100e/.test(stage),
    'the opaque dark launch stage is back behind the app — on a binary that is a mockup floating on black');

  // The shell fills its surface and the CONTENT is what gets centred. This is
  // the rule that replaced the frame, and losing it would stretch a chat bubble
  // across a 1180px iPad.
  assert.match(rules, /\.app-shell > div \{[^}]*max-width: 760px/,
    'the content measure is gone — the app will sprawl edge to edge on a tablet');
});
