// An event nobody receives is not tracking, it is a comment.
//
// This guards a failure that shipped and looked fine: `verifyCode()` fired
// `window.gtag?.('event','verified_signup')` on a page where gtag had never
// been installed. Optional chaining made it crash-proof AND invisible — the
// conversion Google Ads was meant to optimize toward never existed, and the
// only symptom was an empty dropdown in the Ads UI days later.
//
// The rule these tests encode: if the app FIRES an analytics event, the page
// must LOAD the library that receives it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
const social = readFileSync(join(ROOT, 'src', 'lib', 'social.ts'), 'utf8');
const appHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');
const watchHtml = readFileSync(join(ROOT, 'app-public', 'watch', 'index.html'), 'utf8');

// The loader block, isolated once so every test reads the same text.
const loader = index.slice(
  index.indexOf("url.pathname === '/api/analytics.js'"),
  index.indexOf("url.pathname.startsWith('/media/')"),
);

test('every gtag event the app fires has a gtag library to land in', () => {
  // Find what the app actually sends. If someone adds a second event later,
  // this still holds them to the same bargain.
  const fired = [...social.matchAll(/gtag\?\.\(\s*'event'\s*,\s*'([a-z_]+)'/g)].map((m) => m[1]);
  if (fired.length === 0) return; // nothing fired, nothing to guarantee

  assert.match(
    loader,
    /googletagmanager\.com\/gtag\/js/,
    `the app fires ${fired.join(', ')} but no page ever loads gtag.js — ` +
      'the events go nowhere and the Ads conversion dropdown stays empty',
  );
  assert.match(loader, /GA_MEASUREMENT_ID/, 'gtag.js is loaded with no measurement ID to send to');
});

test('the gtag stub is defined before the library finishes downloading', () => {
  // gtag.js is async. A person who verifies in the first second would fire
  // into an undefined gtag and lose the conversion — unless the stub exists
  // to queue it. The stub must be pushed to dataLayer, not swallowed.
  assert.match(loader, /window\.dataLayer\s*=\s*window\.dataLayer\s*\|\|\s*\[\]/,
    'no dataLayer — early events are dropped instead of queued');
  assert.match(loader, /window\.gtag\s*=\s*window\.gtag\s*\|\|\s*function/,
    'no gtag stub — an event fired before gtag.js loads is lost');
  assert.ok(
    loader.indexOf('window.dataLayer') < loader.indexOf('googletagmanager.com'),
    'the stub is defined after the async script tag — the race it exists to win is already lost',
  );
});

test('both the app and the ad landing page load analytics', () => {
  // The landing page is where paid clicks arrive. Missing there means the
  // funnel is measured from the app onward and the ad click is invisible.
  assert.match(appHtml, /src="\/api\/analytics\.js"/, 'the app loads no analytics');
  assert.match(watchHtml, /src="\/api\/analytics\.js"/,
    'the ad landing page loads no analytics — paid clicks arrive unmeasured');
});

test('analytics stays config, never a hardcoded ID in the repo', () => {
  // A measurement ID pasted into HTML is one that can never be changed
  // without a deploy, and that ends up in the wrong property at the worst
  // moment. The worker reads env; the pages just ask the worker.
  for (const [name, html] of [['index.html', appHtml], ['watch/index.html', watchHtml]]) {
    assert.ok(!/G-[A-Z0-9]{6,}/.test(html), `${name} hardcodes a GA measurement ID`);
    assert.ok(!/googletagmanager\.com/.test(html), `${name} loads gtag directly instead of via the configured loader`);
  }
});

test('unconfigured analytics degrades to a comment, never a broken script', () => {
  // Serving `undefined` into a script tag would throw in the console of
  // every visitor. Absent config must be silent, not noisy.
  assert.match(loader, /\/\* analytics:/, 'with no config set, this serves something other than an inert comment');
});

// ── /go/ links: the tag IS the measurement ────────────────────────────────

test('every /go/ code lands on a real page with a full UTM triple', () => {
  // A /go/ code with a missing utm_source shows up in by_source as
  // 'organic' — indistinguishable from someone who found us on their own.
  // That is worse than no link: it silently credits paid spend to luck.
  const go = index.slice(index.indexOf('const GO = {'), index.indexOf('const to = GO['));
  const codes = [...go.matchAll(/^\s{8}(\w+):\s*'([^']+)'/gm)];
  assert.ok(codes.length >= 4, 'the /go/ map lost entries');
  for (const [, code, dest] of codes) {
    assert.ok(dest.startsWith('/watch/'), `/go/${code} points somewhere other than the landing page`);
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign']) {
      assert.match(dest, new RegExp(`[?&]${p}=[^&]+`), `/go/${code} is missing ${p} — its spend lands in 'organic'`);
    }
  }
});

test('an unknown /go/ code still delivers the visitor', () => {
  // A typo on a poster costs attribution. It must never cost the visitor.
  const block = index.slice(index.indexOf('const GO = {'), index.indexOf("if (url.pathname.startsWith('/api/book')"));
  assert.match(block, /to \?\? '\/watch\/'/, 'an unknown code 404s instead of falling back to the landing page');
});
