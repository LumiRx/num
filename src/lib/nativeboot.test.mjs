/**
 * WHAT THE APP STORE BUILD IS NOT ALLOWED TO DO AT LAUNCH.
 *
 * ── THE REJECTION ────────────────────────────────────────────────────────
 *
 * 12 Sep 2026, 5:21 PM. iOS 1.0 build (6), guideline 2.1.0 Performance: App
 * Completeness. "The app crashed after the initial launch."
 *
 * ── WHAT WAS ACTUALLY IN main.tsx ────────────────────────────────────────
 *
 * Three things written for the WEB app, where every one of them is correct,
 * and all three gated on `import.meta.env.PROD` alone — which is true in the
 * App Store build too.
 *
 *   THE AUTO-UPDATER. 2.5 seconds after launch it asks the server what
 *   version it is running and reloads the page when the answer differs from
 *   the version baked into the bundle. In an App Store build those two can
 *   never agree again: the bundle is frozen at archive time and the Worker is
 *   redeployed several times a day. The live server said 0.8.291 while this
 *   was being diagnosed. So the app launches, waits two and a half seconds,
 *   and reloads itself — on a bundle a reload cannot change.
 *
 *   Once is a flash of blank screen. The guard against doing it twice is a
 *   sessionStorage stamp wrapped in a try/catch that silently does nothing
 *   when storage is unavailable — at which point it repeats on every
 *   foreground, forever.
 *
 *   THE SERVICE WORKER. The bundle ships inside the IPA. There is nothing to
 *   cache it for, and what it CAN do is serve a stale index.html over the
 *   real one, whose hashed asset filenames no longer exist. White screen, no
 *   error, no log.
 *
 *   THE AD PIXEL. index.html is bundled into the IPA, so an unguarded Reddit
 *   pixel means the iOS app contacts an ad network at launch for every user
 *   with no App Tracking Transparency prompt. That is 5.1.2 — a different
 *   rejection, waiting behind this one.
 *
 * ── WHY THESE ARE TESTS AND NOT A FIX ────────────────────────────────────
 *
 * The fix is four `isNativeApp()` checks. Nothing about writing them stops
 * the fifth web-only thing being added to boot next month, and the failure
 * mode is invisible: it works in every browser, it works in the simulator
 * against a dev server, and it only breaks in a build nobody can run locally
 * until Apple runs it. So the boot path is asserted, permanently.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const MAIN = read('../main.tsx');
const HTML = read('../../index.html');
const NATIVE = read('./native.ts');
const AUTOUPDATE = read('./autoupdate.ts');

/** The file with its comments removed — this repo keeps tripping over them. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('nothing web-only runs in the app store build', () => {
  const boot = code(MAIN);

  test('the auto-updater is gated on not being the native app', () => {
    const at = boot.indexOf("import('./lib/autoupdate')");
    assert.ok(at > -1, 'the auto-updater import is gone — re-point this test');
    const guard = boot.slice(Math.max(0, at - 200), at);
    assert.match(guard, /\bweb\b/,
      'a frozen bundle that reloads itself because the server moved on is the 2.1.0 rejection');
  });

  test('the service worker is gated the same way', () => {
    const at = boot.indexOf("serviceWorker.register(");
    assert.ok(at > -1);
    const block = boot.slice(0, at);
    const opens = block.lastIndexOf("'serviceWorker' in navigator");
    assert.ok(opens > -1);
    assert.match(block.slice(opens - 40, opens), /\bweb &&/,
      'a cached index.html can point at asset filenames that no longer exist');
  });

  test('the gate is the shared answer, not a fourth opinion about the platform', () => {
    assert.match(boot, /import \{ isNativeApp, nativePlatform \} from '\.\/lib\/native'/);
    assert.match(boot, /const web = !isNativeApp\(\)/);
    // The repo already learned this once: native.ts's own comment records the
    // day a missed platform check reopened three separate bugs at once.
    assert.doesNotMatch(boot, /navigator\.userAgent.*[Cc]apacitor/,
      'sniffing the user agent here is the fourth opinion this file exists to avoid');
  });

  test('the third-party trackers do not load in the app store build', () => {
    assert.match(boot, /loadAnalytics\(\{ thirdParty: !isNativeApp\(\) \}\)/);
    const loader = code(read('./analyticsLoader.ts'));
    assert.match(loader, /if \(thirdParty\) inject\(apiUrl\('\/api\/analytics\.js'\)\)/,
      'Cloudflare Insights and Google Analytics both come down that one file');
    assert.match(loader, /inject\(apiUrl\('\/num-track\.js'\)\)/,
      "Num's own tracker is first-party and stays on every surface");
  });

  test('a launch error still reaches somebody when gtag is not there', () => {
    // The gap this closes: the error reporter wrote to `gtag`, which is the
    // third-party global that is now absent on iOS. That is the one platform
    // where an unreported launch failure costs a review cycle — and it just
    // did. /api/crash was built on 12 Sep for exactly this and had no caller
    // on the boot path.
    assert.match(boot, /apiUrl\('\/api\/crash'\)/);
    assert.match(boot, /keepalive: true/,
      'a page that is dying has to be able to finish sending the report');
    assert.match(boot, /surface: isNativeApp\(\) \? nativePlatform\(\) : 'web'/,
      'a crash on iOS and the same crash in Safari are different problems');
    assert.match(boot, /build: VERSION/, 'without the build number the row cannot be tied to a submission');
  });
});

describe('the ad pixel cannot fire inside the app', () => {
  test('it is wrapped in an origin check', () => {
    const at = HTML.indexOf('redditstatic.com');
    assert.ok(at > -1, 'the pixel is gone — delete this suite with it');
    const before = HTML.slice(Math.max(0, at - 800), at);
    assert.match(before, /capacitor:/, 'the app origin has to be excluded');
    assert.match(before, /localhost/, 'and the bundled-server origin with it');
  });

  test('it checks the ORIGIN, not the Capacitor bridge', () => {
    // This runs in <head>, before any bundle. `window.Capacitor` may not have
    // been injected yet, so a bridge check here reads as "web" on the very
    // launch it is supposed to protect.
    const at = HTML.indexOf('redditstatic.com');
    const guard = HTML.slice(Math.max(0, at - 500), at);
    assert.match(guard, /window\.location|location\.protocol/);
  });

  test('the guard matches native.ts, so the two cannot drift apart', () => {
    const at = HTML.indexOf('redditstatic.com');
    const guard = HTML.slice(Math.max(0, at - 600), at);
    // Every origin nativeOrigin() calls native must also stop the pixel.
    const origin = NATIVE.slice(NATIVE.indexOf('const nativeOrigin'), NATIVE.indexOf('export const isNativeApp'));
    for (const token of ["'capacitor:'", "'ionic:'", "'localhost'", "'127.0.0.1'"]) {
      assert.ok(origin.includes(token), `native.ts no longer treats ${token} as the app`);
      assert.ok(guard.includes(token.replaceAll("'", "'")), `the pixel guard is missing ${token}`);
    }
  });

  test('it fails closed — a throw must not let the pixel through', () => {
    const at = HTML.indexOf('redditstatic.com');
    const guard = HTML.slice(Math.max(0, at - 500), at);
    assert.match(guard, /catch\s*\([^)]*\)\s*\{\s*return/,
      'if reading location throws, the safe answer is "do not track", not "track anyway"');
  });
});

describe('why the auto-updater could never win in a frozen bundle', () => {
  test('it compares the built-in version against the live server', () => {
    assert.match(AUTOUPDATE, /apiUrl\('\/api\/version'\)/);
    assert.match(AUTOUPDATE, /version !== VERSION/);
  });

  test('and its only brake is storage that is allowed to fail silently', () => {
    // Not a criticism of the web behaviour — one refresh is the right cost
    // there. It is the reason the NATIVE gate has to be at the call site and
    // cannot be a tweak inside this file.
    assert.match(AUTOUPDATE, /sessionStorage\.getItem\(RELOADED\)/);
    assert.match(AUTOUPDATE, /catch \{ \/\* private mode \*\/ \}/,
      'a failed setItem means getItem keeps returning null and the reload re-arms');
    assert.match(AUTOUPDATE, /location\.reload\(\)/);
  });
});
