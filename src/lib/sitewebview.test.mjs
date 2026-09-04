// The marketing site must recognise an in-app browser too — and must agree
// with the app about which ones exist.
//
// ── THE BUG ──────────────────────────────────────────────────────────────
//
// `webview.mjs` has known since 24 August which apps open links in their own
// webview, and the React app uses it to show an escape card instead of
// impossible instructions. The MARKETING SITE knew none of it.
//
// So the Instagram journey was: bio link → itsnum.com → "Get the app" →
// /get/ → /app/, a page whose entire promise is "add it to your home screen"
// and whose button loads a 500 kB app. Instagram's browser has no Add to Home
// Screen — that is a Safari and Chrome menu — so every visitor from the one
// channel we actually post on met instructions they could not follow and an
// app that could not install. It was verified on 2 Sep 2026 by fetching
// /app/ with a real Instagram user-agent: byte-identical to the Safari page.
//
// The site cannot import webview.mjs — it is static HTML served by a
// different Worker — so the signature list is copied inline. A copy that can
// drift silently is worse than no copy: the app would escape Snapchat while
// the site walked Snapchat users into a dead end. This test is the join.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IN_APP_SIGNATURES } from './webview.mjs';

const SITE = new URL('../../public/', import.meta.url);
const appPage = readFileSync(new URL('app/index.html', SITE), 'utf8');
const homePage = readFileSync(new URL('index.html', SITE), 'utf8');

/** The names and regex sources the static page carries, in its own order. */
function siteSignatures(html) {
  const block = html.slice(html.indexOf('var APPS = ['), html.indexOf('];', html.indexOf('var APPS = [')));
  return [...block.matchAll(/\['([^']+)',\s*(\/.*\/)i\]/g)].map((m) => ({ name: m[1], src: m[2].slice(1, -1) }));
}

test('the install page carries every signature the app knows', () => {
  const site = siteSignatures(appPage);
  assert.equal(site.length, IN_APP_SIGNATURES.length,
    `the site lists ${site.length} in-app browsers, webview.mjs lists ${IN_APP_SIGNATURES.length}`);
  IN_APP_SIGNATURES.forEach((sig, i) => {
    assert.equal(site[i].name, sig.name, `signature ${i} names a different app`);
    assert.equal(site[i].src, sig.re.source,
      `the pattern for ${sig.name} has drifted between webview.mjs and /app/`);
  });
});

test('order is preserved, because order is load-bearing', () => {
  // Messenger ships an FBAN token, so it must be tested before the generic
  // Facebook signature or every Messenger user is told they are in Facebook.
  // Copying the list without its order reintroduces that silently.
  const names = siteSignatures(appPage).map((s) => s.name);
  assert.ok(names.indexOf('Messenger') < names.indexOf('Facebook'),
    'Facebook is tested before Messenger — Messenger users will be misnamed');
  assert.deepEqual(names, IN_APP_SIGNATURES.map((s) => s.name));
});

test('the real user-agents the app is tested against also match the site copy', () => {
  // Driving the site's own regexes with the strings webview.mjs is pinned to
  // is the part that proves the copy WORKS, not merely that it looks the same.
  const site = siteSignatures(appPage);
  const CASES = [
    ['Instagram', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 340.0.0.19.109 (iPhone14,3; iOS 17_5; en_US)'],
    ['Facebook', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/452.0.0.35.109]'],
    ['TikTok', 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 BytedanceWebview/d8a21c6'],
    ['Reddit', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Reddit/Version 2024.20.0'],
  ];
  for (const [expected, ua] of CASES) {
    const hit = site.find((s) => new RegExp(s.src, 'i').test(ua));
    assert.equal(hit?.name, expected, `the site copy misidentifies a real ${expected} user-agent`);
  }
});

test('a normal Safari user-agent matches nothing', () => {
  // The whole page changes shape when this fires. A false positive would show
  // "you're in an app's browser" to someone who is not, and hide the install
  // steps from the one browser that can actually follow them.
  const site = siteSignatures(appPage);
  for (const ua of [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
  ]) {
    const hit = site.find((s) => new RegExp(s.src, 'i').test(ua));
    assert.equal(hit, undefined, `a real browser was mistaken for ${hit?.name}`);
  }
});

/* ── the page actually changes, not just detects ────────────────────────── */

test('detection runs before paint, in the head', () => {
  // After the stylesheet has painted, the reader has already seen "add it to
  // your home screen" — and that flash is the whole bug, briefly.
  const head = appPage.slice(0, appPage.indexOf('</head>'));
  assert.ok(head.includes('var APPS = ['), 'the detection script is not in the head');
  assert.ok(head.includes('data-inapp'), 'the head script does not mark the document');
});

test('the impossible instructions are hidden when detection fires', () => {
  for (const sel of ['#install-steps', '.qr-card', '.trust']) {
    assert.ok(appPage.includes(sel), `${sel} is gone — re-check what the escape state hides`);
  }
  const css = appPage.slice(appPage.indexOf('#inapp { display: none; }'));
  assert.match(css, /html\[data-inapp\][^{]*#install-steps/,
    'the Add to Home Screen steps still show inside an in-app browser');
});

test('the escape offers a route out AND the manual steps', () => {
  // The Android intent:// link is the only one that reliably leaves a
  // webview; iOS has no equivalent worth promising. So the numbered steps are
  // the instruction and the button is the shortcut, never the other way round.
  assert.match(appPage, /intent:\/\//, 'no Android route out of the webview');
  assert.match(appPage, /package=com\.android\.chrome/, 'the intent names no browser');
  assert.match(appPage, /Open in Safari/, 'no iOS instruction');
  assert.match(appPage, /Open in Chrome|Open in browser/, 'no Android instruction');
  assert.match(appPage, /line\.me/, 'no way to use Num without escaping at all');
});

test('the home page sends people to a page that can explain an in-app browser', () => {
  // The home page is the site again (restored 3 Sep 2026). Its "Get the app"
  // buttons go to /get/, which forwards to /app/ — the one page that knows how
  // to explain Instagram's browser and how to get out of it. A home CTA that
  // went STRAIGHT to app.itsnum.com would skip that and land an Instagram
  // visitor on the dark screen this whole file exists to prevent.
  const ctas = [...homePage.matchAll(/<a\b[^>]*class="btn[^"]*"[^>]*href="([^"]+)"[^>]*>/gi)].map((m) => m[1]);
  assert.ok(ctas.length >= 2, 'the home page has lost its buttons');
  assert.ok(ctas.some((h) => h === '/get/' || h === '/app/'), 'no home CTA leads to /get/ or /app/');
  assert.ok(!ctas.some((h) => /^https?:\/\/app\.itsnum\.com\/?$/.test(h)),
    'a home CTA goes straight to app.itsnum.com and skips the in-app browser handling');
});
