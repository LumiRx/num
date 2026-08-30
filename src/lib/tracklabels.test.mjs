/**
 * num-track.js: which page am I, and what did that tap mean?
 *
 * Both rules below were wrong in production, both silently, and both produced
 * confident written conclusions that were the opposite of the truth. Neither
 * failure showed up as an error — the events kept arriving with a 200.
 *
 *   1. PAGE COLLISION. The host test ran before the path test, so
 *      app.itsnum.com/install — a separate static page — reported itself as
 *      'app'. One name for two pages means neither has a readable funnel: the
 *      taps of one were counted against the arrivals of the other.
 *
 *   2. THE MISLABELLED TAP. "Ask Num something" is the primary call to
 *      action. It fired `open_in_browser_click`. All 25 rows of that event
 *      carried that label, and they were reported as 25 people fleeing an
 *      in-app browser — when they were the most interested people on the page
 *      pressing the button that means yes.
 *
 * Asserted against the source text because this file is a plain browser IIFE
 * with no exports; importing it would require a DOM and a location, which is
 * the very thing under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = new URL('../../app-public/num-track.js', import.meta.url);
const src = readFileSync(SRC, 'utf8');

/** The PAGE derivation block, without the prose around it. */
const pageBlock = (() => {
  const start = src.indexOf('var PAGE');
  const end = src.indexOf('})();', start);
  assert.ok(start > 0 && end > start, 'the PAGE derivation has moved or gone');
  return src.slice(start, end).replace(/\/\/[^\n]*/g, '');
})();

test('the path is tested before the host, or /install reports as app', () => {
  const install = pageBlock.indexOf("'/install'");
  const host = pageBlock.indexOf("indexOf('app.')");
  assert.ok(install > -1, 'the /install branch is gone');
  assert.ok(host > -1, 'the app-host branch is gone');
  assert.ok(
    install < host,
    'the app-host test runs first again — every /install visit is being recorded as the React app, ' +
    'and the two pages share one funnel',
  );
});

test('/business is also matched before the host', () => {
  const business = pageBlock.indexOf("'/business'");
  const host = pageBlock.indexOf("indexOf('app.')");
  assert.ok(business > -1 && business < host,
    'a business page served under app.* would be filed as the app');
});

/** The click-routing block. */
const clickBlock = (() => {
  const start = src.indexOf("document.addEventListener('click'");
  const end = src.indexOf('}, true);', start);
  assert.ok(start > 0 && end > start, 'the click handler has moved or gone');
  return src.slice(start, end);
})();

test('the primary CTA is not reported as leaving for another browser', () => {
  assert.match(clickBlock, /primary_cta_click/,
    'primary_cta_click is gone — the main call to action is being filed under some other name');

  // The specific regression: these two labels must not sit in the same test as
  // open_in_browser_click.
  const escapeLine = clickBlock
    .split('\n')
    .find((l) => l.includes("track('open_in_browser_click'") || l.includes('open it in my browser'));
  assert.ok(escapeLine, 'the browser-escape branch has gone entirely');

  const escapeTest = clickBlock.slice(0, clickBlock.indexOf("track('open_in_browser_click'"));
  const lastCondition = escapeTest.slice(escapeTest.lastIndexOf('else if'));
  assert.equal(/Ask Num something/i.test(lastCondition), false,
    '"Ask Num something" is routed to open_in_browser_click again — it is the primary CTA, ' +
    'and this exact mislabelling was reported to the founder as users fleeing the page');
  assert.equal(/Open Num/i.test(lastCondition), false,
    '"Open Num" is routed to open_in_browser_click again — same bug');
});

test('both new events are allow-listed, or the worker drops them with a 200', () => {
  // A name the worker does not know is answered 200 and recorded nowhere,
  // which is the failure mode this allow-list exists to prevent.
  const known = src.slice(src.indexOf('var KNOWN'), src.indexOf('];', src.indexOf('var KNOWN')));
  for (const ev of ['page_view', 'primary_cta_click']) {
    assert.ok(known.includes(`'${ev}'`), `${ev} is missing from KNOWN in the tracker`);
  }
  const worker = readFileSync(new URL('../../growth/worker.js', import.meta.url), 'utf8');
  const events = worker.slice(worker.indexOf('const EVENTS'), worker.indexOf(']);', worker.indexOf('const EVENTS')));
  for (const ev of ['page_view', 'primary_cta_click']) {
    assert.ok(events.includes(`"${ev}"`), `${ev} is missing from EVENTS in growth/worker.js — the worker will drop it silently`);
  }
});

test('the three copies of the tracker have not drifted', () => {
  // app-public is the source; dist and the iOS bundle are copies. A fix that
  // lands in one of the three is a fix that most users never receive.
  const dist = readFileSync(new URL('../../dist/num-track.js', import.meta.url), 'utf8');
  const ios = readFileSync(new URL('../../ios/App/App/public/num-track.js', import.meta.url), 'utf8');
  assert.equal(dist, src, 'dist/num-track.js has drifted from app-public/num-track.js');
  assert.equal(ios, src, 'ios/App/App/public/num-track.js has drifted from app-public/num-track.js');
});
