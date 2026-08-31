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

test('a blank phone number is still allowed — this was not the bug', () => {
  // Guarding the DECISION, not just the code. Making the number mandatory
  // would look like a fix for the reviewer's empty account and would actually
  // put every new user back behind an SMS path that has verified 2 people.
  const sheet = root('src/components/app/InviteSheet.tsx');
  assert.match(sheet, /Mobile \(optional/, 'the number stopped being optional at signup');
  const social = root('worker/social.mjs');
  assert.match(social, /if \(!existing && !name\)/,
    'the server-side signup guard changed — a name is required, a number is not');
});

test('4.0 — the phone frame does not follow the app onto an iPad', () => {
  // App Review photographed 1.0(2) as a phone-shaped card floating on black on
  // an iPad Air M3. That frame is the web launch stage leaking into a binary.
  const css = root('src/styles/glass.css');
  assert.match(css, /html:not\(\.num-native\) \.app-shell \{/,
    'the 440px phone frame is unscoped again — it will render inside the installed app');
  assert.match(css, /html:not\(\.num-native\) \.app-shell-stage \{/,
    'the dark launch stage is unscoped again');
  const app = root('src/App.tsx');
  assert.match(app, /if \(isNativeApp\(\)\) root\.classList\.add\('num-native'\)/,
    'nothing marks the document as native — the CSS guard above can never match');
  assert.match(app, /classList\.remove\('num-native'\)/, 'the native marker is never cleaned up');
});
