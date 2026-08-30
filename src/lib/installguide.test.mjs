// Which install steps a device actually needs.
//
// The install page used to decide with three tests — iPhone, Android,
// everything else. That is wrong in five ways, and each one costs a real
// install because the reader is handed instructions for a menu that is not in
// front of them:
//
//   1. An iPad reports itself as a Macintosh (iPadOS 13+) and got desktop steps
//   2. Chrome/Firefox/Edge on iOS cannot install AT ALL — only Safari may
//   3. Samsung Internet's menu is not Chrome's, and it has real share in
//      Thailand, where 1,033 of last week's 1,230 visitors were
//   4. Desktop Safari says "Add to Dock", not "Add to Home Screen"
//   5. Desktop Firefox cannot install a web app and never said so
//
// The user-agent strings below are real. The point of testing against strings
// rather than a mocked navigator is that the whole risk here is misreading a
// real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
  fileURLToPath(new URL('../../app-public/installguide.js', import.meta.url)), 'utf8');

/** The browser file, loaded the way the browser loads it. */
const guide = (() => {
  const sandbox = {};
  new Function('self', SRC)(sandbox);
  assert.ok(sandbox.numInstallGuide, 'installguide.js did not export onto the global');
  return sandbox.numInstallGuide;
})();

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  iphoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
  chromeDesktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  edgeDesktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  firefoxDesktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
};

const g = (ua, extra = {}) => guide({ ua, maxTouchPoints: 0, ...extra });

/* ══ 1. the iPad that says it is a Mac ══════════════════════════════════ */

test('an iPad is an iPad even though it claims to be a Macintosh', () => {
  // Since iPadOS 13 there is no "iPad" in Safari's user agent. The only tell
  // is touch on a Mac, and without it every iPad visitor got desktop steps.
  const ipad = g(UA.mac, { maxTouchPoints: 5 });
  assert.equal(ipad.platform, 'ipad');
  assert.match(ipad.steps.join(' '), /Add to Home Screen/);
});

test('a real Mac is not an iPad', () => {
  const mac = g(UA.mac);
  assert.equal(mac.platform, 'desktop');
  assert.equal(mac.browser, 'safari-mac');
  // And it is told the right words: Safari has no "Home Screen".
  assert.match(mac.headline, /Dock/);
  // It may MENTION the Home Screen to explain that the Dock is the same
  // thing — what it must not do is instruct a Mac to use a menu item Safari
  // on macOS does not have.
  assert.doesNotMatch(mac.steps.join(' '), /Add to Home Screen/);
});

test('the iPad Share button is in a different place from the iPhone one', () => {
  assert.match(g(UA.iphoneSafari).steps.join(' '), /bottom of the screen/);
  assert.match(g(UA.mac, { maxTouchPoints: 5 }).steps.join(' '), /top right/);
});

/* ══ 2. the browsers that cannot install at all ═════════════════════════ */

test('Chrome on iPhone is told plainly that it cannot install', () => {
  // Apple permits only Safari to add to the Home Screen. Burying that in a
  // caveat inside Chrome instructions is how 27 people tapped install and 4
  // saw a prompt.
  const r = g(UA.iphoneChrome);
  assert.equal(r.canInstall, false);
  assert.match(r.headline, /only Safari can install/);
  assert.match(r.steps[0], /Open in Safari/);
  assert.match(r.note, /Apple/);
});

test('Firefox on iPhone gets the same answer, named correctly', () => {
  const r = g(UA.iphoneFirefox);
  assert.equal(r.canInstall, false);
  assert.match(r.steps[0], /Firefox/);
});

test('desktop Firefox says so rather than describing a menu it does not have', () => {
  const r = g(UA.firefoxDesktop);
  assert.equal(r.canInstall, false);
  assert.match(r.steps.join(' '), /Firefox limitation/);
  assert.match(r.steps.join(' '), /works; it simply will not have its own icon/);
});

test('an already-installed app is never shown how to install', () => {
  const r = g(UA.androidChrome, { standalone: true });
  assert.equal(r.canInstall, false);
  assert.match(r.headline, /already installed/);
});

/* ══ 3. Android is not one browser ══════════════════════════════════════ */

test('Samsung Internet gets its own menu, not Chrome\'s', () => {
  // Real share in the market this traffic is actually coming from.
  const r = g(UA.samsung, { maxTouchPoints: 5 });
  assert.equal(r.browser, 'samsung');
  assert.match(r.steps.join(' '), /≡ menu/);
  assert.match(r.steps.join(' '), /Add page to/);
  assert.doesNotMatch(r.steps.join(' '), /⋮/, 'Samsung Internet has no ⋮ menu');
});

test('Samsung Internet is not mistaken for Chrome, which its UA also claims', () => {
  // The string contains "Chrome/121" as well as "SamsungBrowser/25". Order of
  // tests is the whole thing here.
  assert.notEqual(g(UA.samsung, { maxTouchPoints: 5 }).browser, 'chrome-android');
});

test('Chrome and Firefox on Android get different menu items', () => {
  assert.match(g(UA.androidChrome, { maxTouchPoints: 5 }).steps.join(' '), /Install app/);
  assert.match(g(UA.firefoxAndroid, { maxTouchPoints: 5 }).steps.join(' '), /Install</);
  assert.equal(g(UA.firefoxAndroid, { maxTouchPoints: 5 }).canInstall, true);
});

/* ══ 4. desktop ═════════════════════════════════════════════════════════ */

test('Chrome and Edge on the desktop are pointed at the address-bar icon', () => {
  for (const ua of [UA.chromeDesktop, UA.edgeDesktop]) {
    const r = g(ua);
    assert.equal(r.canInstall, true);
    assert.match(r.steps.join(' '), /install icon/);
    assert.match(r.steps.join(' '), /address bar/);
  }
});

/* ══ every answer is usable ═════════════════════════════════════════════ */

test('every combination returns steps, and never an empty page', () => {
  for (const [name, ua] of Object.entries(UA)) {
    for (const touch of [0, 5]) {
      const r = g(ua, { maxTouchPoints: touch });
      assert.ok(r.steps.length >= 1, `${name} (touch ${touch}) produced no steps`);
      assert.ok(r.headline.length > 5, `${name} (touch ${touch}) has no headline`);
      for (const s of r.steps) assert.ok(s.length > 10, `${name}: step too short — "${s}"`);
    }
  }
});

test('an unknown user agent still gets something to do', () => {
  const r = g('SomeFutureBrowser/1.0');
  assert.ok(r.steps.length >= 1);
  assert.equal(r.canInstall, false, 'an unrecognised browser must not promise an install');
});

/* ══ the page uses it ═══════════════════════════════════════════════════ */

test('the install page loads the guide and feeds it maxTouchPoints', () => {
  const page = readFileSync(
    fileURLToPath(new URL('../../app-public/install/index.html', import.meta.url)), 'utf8');
  assert.match(page, /<script src="\/installguide\.js"><\/script>/);
  assert.match(page, /maxTouchPoints: navigator\.maxTouchPoints/,
    'without maxTouchPoints every iPad is read as a Mac again');
  assert.match(page, /window\.navigator\.standalone === true/,
    'iOS reports standalone on navigator, not through matchMedia');
});
