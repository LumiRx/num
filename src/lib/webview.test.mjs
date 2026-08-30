// The in-app browser, and why the install funnel was a leak.
//
// Measured on the `global-pretrip-film1` cohort, 29 Aug 2026:
//
//   1,230 landed → 70 scrolled half → 27 tapped install → 4 saw a prompt → 1 installed
//
// One cause. Reddit opens links in an embedded web view, an embedded web view
// is not an installable context, so `beforeinstallprompt` never fires there.
// The install button fell through to written steps that said "tap the ⋮ menu
// in Chrome" — to somebody who was not in Chrome. And "open it in my browser"
// was a plain <a href>, which inside a web view navigates INSIDE the web view.
// Twenty-five people took the escape hatch and none of them escaped.
//
// These tests hold the three properties that fix costs nothing to keep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = readFileSync(
  fileURLToPath(new URL('../../app-public/install/index.html', import.meta.url)), 'utf8');

/** The web-view block, extracted so the assertions are about it and not the page. */
const BLOCK = (() => {
  const i = PAGE.indexOf('(function () {\n  var ua = navigator.userAgent');
  assert.ok(i > 0, 'the in-app-browser handling is gone from the install page');
  return PAGE.slice(i, PAGE.indexOf('</script>', i));
})();

/** The same block with its prose removed, so it can SAY "x-safari-https is not
 *  public API" in a comment without failing the test that forbids using it. */
const CODE = BLOCK.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the Android escape is an intent:// handoff, not a plain link', () => {
  // The only reliable way off an in-app web view on any platform. A normal
  // href navigates inside the web view, which is exactly what was happening.
  assert.match(BLOCK, /intent:\/\//);
  assert.match(BLOCK, /package=com\.android\.chrome/);
});

test('a device without Chrome gets a fallback rather than a dead tap', () => {
  // An intent:// with no S.browser_fallback_url does nothing at all when the
  // named package is absent, and does it silently.
  assert.match(BLOCK, /S\.browser_fallback_url=/);
  assert.match(BLOCK, /encodeURIComponent\(url\)/);
});

test('the campaign survives the escape', () => {
  // If the handoff drops the UTM, everyone who escapes lands as fresh
  // unattributed traffic and the campaign becomes unmeasurable — which is the
  // state it was already in, and the reason the true conversion rate is
  // currently unknown.
  assert.match(BLOCK, /var target = location\.href/,
    'the intent target must carry the current URL, query string included');
  assert.match(BLOCK, /utm_campaign=global-pretrip-film1/);
  assert.match(BLOCK, /utm_content=install-webview-/,
    'an escape into the chat must be separable from a hero tap');
});

test('only named apps are treated as in-app browsers', () => {
  // A generic "does this look like a web view" sniff catches real browsers,
  // and telling somebody in Chrome that they are not in Chrome is worse than
  // saying nothing at all.
  assert.match(BLOCK, /if \(!app\) return;/);
  for (const app of ['Reddit', 'FBAN', 'Instagram', 'TikTok']) {
    assert.ok(BLOCK.includes(app), `${app} is not detected`);
  }
  assert.doesNotMatch(CODE, /wv\b.*=.*true|isWebView\s*=\s*!/,
    'looks like a generic web-view guess crept in');
});

test('an installed app never sees the banner', () => {
  assert.match(BLOCK, /display-mode: standalone/);
});

test('iOS is told the gesture for the app it is actually in', () => {
  // There is no supported programmatic escape on iOS — x-safari-https:// was
  // never public API. What works is naming the real control.
  assert.match(BLOCK, /Open in Safari/);
  assert.doesNotMatch(CODE, /x-safari-https/,
    'x-safari-https is not public API and fails silently on modern iOS');
});

test('the written steps stop instructing a browser the reader is not in', () => {
  assert.match(BLOCK, /pane\.innerHTML =/);
  assert.match(BLOCK, /Open in Chrome<\/b> above/);
});

test('the honest primary action in a web view is the chat, not the install', () => {
  // The concierge runs perfectly well inside a web view — it is a chat. Only
  // INSTALLING is forbidden here. Leading with install spends the whole ad
  // budget on the one thing the context cannot do.
  assert.match(BLOCK, /just try Num here/);
  assert.match(BLOCK, /Skip the install/);
});

test('the banner is inserted above everything else on the page', () => {
  assert.match(BLOCK, /insertBefore\(bar, host\.firstChild\)/);
  assert.match(PAGE, /\.wv\{/, 'the banner has no styles and would render unstyled');
});
