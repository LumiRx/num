/**
 * The campaign has to survive the whole walk from an ad to the app —
 * and the tracker that carries it has to actually parse.
 *
 * ── THE FAILURE THIS PINS ────────────────────────────────────────────────
 *
 * The paid Reddit campaign sent 577 people to itsnum.com/?utm_source=reddit.
 * Three separate hops threw the campaign away:
 *
 *   1. The landing page's "Get the app" is a static /app/ link, so the query
 *      string died on the FIRST click.
 *   2. /app/ carried no analytics at all, so nothing was recorded there.
 *   3. Its "Open Num" button pointed at a hardcoded app.itsnum.com/?app.
 *
 * Every paid visitor who reached the product therefore arrived looking like
 * direct traffic. The campaign shows zero members, and the honest position is
 * that we cannot tell whether it produced any.
 *
 * The ref half of hop 3 had already been found and fixed once — there is a
 * comment on /app/ describing this exact bug in this exact language. The utm
 * half was left behind. So these tests assert the RULE, not the symptom.
 *
 * ── AND THE ONE THE FIX ITSELF CAUSED ────────────────────────────────────
 *
 * num-capture.js is not a file. It is a TEMPLATE LITERAL inside worker.js, so
 * every backslash is consumed before a browser sees it. A regex written as
 * /^https?:\/\/itsnum\.com$/ ships as /^https?://itsnum.com$/ — which is not a
 * syntax error in the source and IS one in the browser. It took the tracker
 * off all 22 pages for one deploy, silently, because a script that fails to
 * parse reports nothing at all.
 *
 * `the served tracker parses` below is the test that catches that class
 * outright, and it is the most valuable one in this file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

const worker = read('growth/worker.js');
const appPage = read('public/app/index.html');
const getPage = read('public/get/index.html');
const landing = read('public/ask/index.html');

/**
 * num-capture.js exactly as the browser receives it.
 *
 * Evaluating the template literal is the whole point: it is the step that eats
 * backslashes, and reading the raw source would test a string no browser ever
 * runs.
 */
const served = (() => {
  const marker = 'var CAPTURE_JS = `';
  let i = worker.indexOf(marker);
  if (i < 0) {
    // Fall back to finding whichever template literal contains the IIFE.
    const at = worker.indexOf('if (window.__numCapture) return;');
    assert.ok(at > 0, 'num-capture.js source not found in the worker');
    const open = worker.lastIndexOf('`', at);
    const close = worker.indexOf('`', at);
    assert.ok(open > 0 && close > at, 'could not delimit the num-capture template literal');
    return eval(worker.slice(open, close + 1)); // eslint-disable-line no-eval
  }
  const open = i + marker.length - 1;
  const close = worker.indexOf('`', open + 1);
  return eval(worker.slice(open, close + 1)); // eslint-disable-line no-eval
})();

/* ── the one that matters most ───────────────────────────────────────────── */

test('the served tracker parses', () => {
  // A script that throws SyntaxError reports nothing and logs nothing. Every
  // page keeps rendering, every dashboard keeps showing yesterday's shape, and
  // nobody finds out until someone asks why a number stopped moving.
  assert.doesNotThrow(
    () => new Function(served), // eslint-disable-line no-new-func
    'num-capture.js does not parse as served — the tracker is dead on every page. ' +
    'Most likely a backslash in a regex: this file is a template literal and they are eaten.',
  );
});

test('no backslash escapes survive into the served tracker', () => {
  // Belt and braces on the above: a regex that still parses but silently means
  // something different is the quieter half of the same bug. An unescaped dot
  // matches any character, so /itsnum.com/ accepts itsnumXcom.
  const suspicious = served.match(/\/\^[^\n]*\/[gimsuy]*/g) || [];
  for (const re of suspicious) {
    assert.equal(re.includes('://'), false,
      `a regex in the served tracker contains an unescaped "://" — ${re} — ` +
      'the backslashes were consumed by the template literal');
  }
});

/* ── the tag is on every step of the funnel ──────────────────────────────── */

test('every page in the paid funnel carries the tracking tag', () => {
  for (const [name, html] of [['/', landing], ['/app/', appPage], ['/get/', getPage]]) {
    assert.match(html, /<script src="\/num-capture\.js"[^>]*data-page="[^"]+"/,
      `${name} has no tracking tag — that step of the paid funnel is invisible`);
  }
});

test('the funnel pages do not share a page name', () => {
  const names = [landing, appPage, getPage].map((h) => {
    const m = h.match(/<script src="\/num-capture\.js"[^>]*data-page="([^"]+)"/);
    return m && m[1];
  });
  assert.equal(new Set(names).size, names.length,
    `two funnel pages report the same name (${names.join(', ')}) — one funnel for two pages ` +
    'means neither can be read, which is the bug num-track.js had with /install');
});

test('a tagged page always logs an arrival, even with an unfamiliar name', () => {
  // The old code looked the page up in a map and returned silently when it was
  // missing, so tagging a new page did nothing and looked like it had.
  assert.match(served, /ARRIVAL\[CFG\.page\]\s*\|\|\s*"page_view"/,
    'logArrival no longer falls back — a newly tagged page reports nothing and nobody notices');
});

/* ── the campaign crosses to the app, and nowhere else ───────────────────── */

test('app.itsnum.com counts as ours, or the campaign dies on the last hop', () => {
  const m = served.match(/var OUR_HOSTS = (\[[^\]]*\]);/);
  assert.ok(m, 'the our-hosts allow-list has gone or changed shape');
  const hosts = JSON.parse(m[1].replace(/'/g, '"'));
  assert.ok(hosts.includes('app.itsnum.com'), 'app.itsnum.com is excluded again — this IS the bug');
  assert.ok(hosts.includes('itsnum.com'), 'itsnum.com must be included');
});

test('the campaign is never appended to a third-party link', () => {
  const m = served.match(/var OUR_HOSTS = (\[[^\]]*\]);/);
  const hosts = JSON.parse(m[1].replace(/'/g, '"'));
  for (const bad of [
    'line.me', '5arz.com', 'reddit.com',
    'itsnum.com.evil.test', 'notitsnum.com', 'wwwXitsnum.com', 'evil-itsnum.com',
  ]) {
    assert.equal(hosts.includes(bad), false, `${bad} would receive our campaign data`);
  }
});

test('the host code stays same-origin — it identifies a person', () => {
  // The campaign describes a visit; ref describes someone. Only the first is
  // safe to hand to another origin, even one of ours.
  assert.match(served, /same && REF && !u\.searchParams\.get\("ref"\)/,
    'ref is no longer gated on same-origin — a host code is about to travel');
});

test('a valueless query param survives being carried', () => {
  // /app/ links to app.itsnum.com/?app. Round-tripping that through
  // URLSearchParams rewrites it to ?app=, a silent change to a URL the app
  // reads. The appender must be string-based.
  assert.match(served, /function appendParams/, 'appendParams has gone');
  const fn = served.slice(served.indexOf('function appendParams'));
  assert.equal(/searchParams|toString\(\)/.test(fn.slice(0, 500)), false,
    'appendParams re-serialises the URL again — ?app will quietly become ?app=');
});

/* ── the button at the end ───────────────────────────────────────────────── */

test('"Open Num" carries the campaign, not just the referral', () => {
  const from = appPage.indexOf('id="open"');
  const block = appPage.slice(from, appPage.indexOf('</script>', from));
  assert.match(block, /utm_source/,
    'the Open Num button dropped the campaign again — the exact hop already fixed once for ref and missed for utm');
  assert.match(block, /gclid|fbclid/, 'paid click ids are not carried');
  assert.ok(block.indexOf("'https://app.itsnum.com/r/'") < block.indexOf('utm_source'),
    'the campaign is appended before the ref branch rewrites the href — it will be discarded');
});

test('forms only get a hidden ref when there is one', () => {
  // carryRef used to return early without a REF, so the form loop was
  // unreachable. It is reachable now that a campaign alone gets that far.
  const fn = served.slice(served.indexOf('function carryRef'));
  const formsAt = fn.indexOf('querySelectorAll("form")');
  const guardAt = fn.lastIndexOf('if (!REF) return;', formsAt);
  assert.ok(guardAt > -1 && guardAt < formsAt,
    'every form on the site is about to get <input name="ref" value="">');
});
