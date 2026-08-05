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
const concierge = readFileSync(join(ROOT, 'src', 'lib', 'concierge.ts'), 'utf8');
const trackLib = readFileSync(join(ROOT, 'src', 'lib', 'track.ts'), 'utf8');
// Every client module that can emit an event, concatenated once so the scan
// below cannot miss one by only looking in the file someone thought of.
const allClient = [social, concierge].join('\n');
const appHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');
const watchHtml = readFileSync(join(ROOT, 'app-public', 'watch', 'index.html'), 'utf8');

// The loader block, isolated once so every test reads the same text.
const loader = index.slice(
  index.indexOf("url.pathname === '/api/analytics.js'"),
  index.indexOf("url.pathname.startsWith('/media/')"),
);

test('every analytics event the app fires has a gtag library to land in', () => {
  // Find what the app actually sends, across every module that sends anything.
  //
  // This scan deliberately keys on the track()/trackOnce() helpers rather than
  // on `gtag(`. An earlier version of this test grepped for the inline
  // `gtag?.('event', ...)` form; when those call sites were refactored behind
  // track(), the regex stopped matching, `fired` became empty, and the early
  // return below turned the whole guard into a no-op that still reported
  // PASS. A test that silently stops testing is worse than no test, so if the
  // helper is ever renamed, the assertion at the bottom fails loudly instead.
  const fired = [...allClient.matchAll(/\btrackOnce?\(\s*(?:'[a-z-]+'\s*,\s*)?'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(fired.length > 0,
    'no analytics events found — either the app measures nothing, or track() was renamed and this guard silently stopped looking');

  assert.match(
    loader,
    /googletagmanager\.com\/gtag\/js/,
    `the app fires ${fired.join(', ')} but no page ever loads gtag.js — ` +
      'the events go nowhere and the Ads conversion dropdown stays empty',
  );
  assert.match(loader, /GA_MEASUREMENT_ID/, 'gtag.js is loaded with no measurement ID to send to');
});

test('there is a conversion that can actually fire while SMS is blocked', () => {
  // A2P 10DLC is unapproved, so `verified_signup` has fired exactly zero times
  // in the product's life. Two live campaigns were optimising toward it — i.e.
  // toward nothing. Whatever else changes, the app must always emit at least
  // one conversion that does not depend on SMS, or paid spend goes blind again
  // the next time a provider gates us.
  const fired = [...allClient.matchAll(/\btrackOnce?\(\s*(?:'[a-z-]+'\s*,\s*)?'([a-z_]+)'/g)].map((m) => m[1]);
  const smsFree = fired.filter((e) => e !== 'verified_signup');
  assert.ok(smsFree.length > 0,
    'every conversion depends on SMS verification — if the provider blocks us, the ads are optimising toward an event that cannot happen');
  assert.ok(fired.includes('first_ask'),
    'no activation event — signups measure a filled-in form, not a person finding the product useful');
});

test('activation is counted once per device, not once per message', () => {
  // first_ask fired on every send would turn a quality signal into a chat
  // counter, and Google Ads would learn to buy whoever talks most rather than
  // whoever arrives and gets value.
  assert.match(concierge, /trackOnce\(\s*'first-ask'/,
    'first_ask uses track() not trackOnce() — it will fire on every message and inflate the number budget is judged against');
  assert.match(trackLib, /localStorage\.getItem/,
    'trackOnce does not persist — a page reload would re-fire "first" events');
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
