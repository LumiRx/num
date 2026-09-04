// THE AD PIXELS, GUARDED.
//
// Reddit is 87% of every visitor NUM has ever had, and until 3 Sep 2026 the
// campaign could see nothing those people did after the click — so it was
// optimising for people who load a page. These tests pin the properties that
// make the pixel able to report a real conversion, and the ones that stop it
// reporting the same conversion twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');
const REDDIT_ID = 'a2_jgfeykixrdo7';

function pages(dir = PUBLIC, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) pages(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}
const HTML = pages().map((p) => [p.slice(PUBLIC.length + 1), readFileSync(p, 'utf8')]);
const withReddit = HTML.filter(([, s]) => s.includes("rdt('init'"));
const withMeta = HTML.filter(([, s]) => s.includes("fbq('init'"));

test('the ads landing page carries the Reddit pixel', () => {
  // /ask/ is where the campaign points. A pixel missing here is a campaign
  // with no conversion signal at all.
  const ask = HTML.find(([p]) => p === join('ask', 'index.html'));
  assert.ok(ask, 'the ads landing page is gone');
  assert.match(ask[1], new RegExp(`rdt\\('init','${REDDIT_ID}'\\)`));
  assert.match(ask[1], /rdt\('track', 'PageVisit'\)/);
});

test('every page that reports to Meta also reports to Reddit', () => {
  // One rule, so a page added later cannot end up visible to one network and
  // invisible to the other — which reads as "that page converts worse" rather
  // than "that page is not being measured".
  const missing = withMeta.filter(([, s]) => !s.includes("rdt('init'")).map(([p]) => p);
  assert.deepEqual(missing, [], `pages with a Meta pixel and no Reddit pixel: ${missing.join(', ')}`);
});

test('the pixel is in the head, exactly once per page', () => {
  for (const [p, s] of withReddit) {
    const head = s.indexOf('</head>');
    assert.ok(head > 0, `${p}: no </head>`);
    assert.ok(s.indexOf("rdt('init'") < head, `${p}: the pixel is below </head> — Reddit's verifier only looks inside it`);
    // A second init double-counts every PageVisit, and a doubled conversion
    // number is worse than none because you act on it.
    assert.equal(s.split("rdt('init'").length - 1, 1, `${p}: the pixel initialises more than once`);
  }
});

test('the pixel id is the account we actually run ads from', () => {
  for (const [p, s] of withReddit) {
    const ids = [...s.matchAll(/pixel_id=([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    for (const id of ids) assert.equal(id, REDDIT_ID, `${p}: unknown pixel id ${id}`);
  }
});

// ── the conversion layer ─────────────────────────────────────────────────
const reddit = readFileSync(join(PUBLIC, 'js', 'reddit.js'), 'utf8');
// The file's own comments explain the double-init trap by naming rdt('init').
// A guard that cannot tell code from the prose explaining it will get the
// prose deleted, which is worse than the bug.
const redditCode = reddit.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('the conversion layer never initialises a second pixel', () => {
  // The base code in <head> owns init. This file reporting events through it
  // is the whole point; this file calling init as well would double every
  // PageVisit. js/track.js is empty for exactly this reason on the Meta side.
  assert.equal(/rdt\(\s*['"]init['"]/.test(redditCode), false,
    'js/reddit.js initialises the pixel — that is a second init and every PageVisit doubles');
});

test('the first message maps to Reddit Lead', () => {
  // The conversion the campaign should bid for, and the number every other
  // number is downstream of: 1 in the product's history as of 3 Sep 2026.
  assert.match(reddit, /Lead:\s*'Lead'/);
  assert.match(reddit, /CompleteRegistration:\s*'SignUp'/);
  assert.match(reddit, /ViewContent:\s*'ViewContent'/);
});

test('an unmapped moment is sent as Custom, never dropped', () => {
  assert.match(reddit, /MAP\[name\] \|\| 'Custom'/);
  assert.match(reddit, /payload\.customEventName = name/);
});

test('both networks get the same conversion id', () => {
  // Reddit calls it conversionId, Meta calls it eventID. The same value in
  // both is what lets the Conversions API send the same conversion
  // server-side later without double-counting it.
  assert.match(reddit, /conversionId/);
  assert.match(reddit, /eventID/);
  assert.match(reddit, /var cid = p\.conversionId \|\| p\.eventID \|\| newId\(\)/);
});

test('the bridge survives either load order', () => {
  // js/track.js also assigns window.numMetaEvent. With a plain assignment,
  // whichever file ran second would silently win and one network would report
  // nothing — invisible until you look at a month of empty conversion data.
  assert.match(reddit, /Object\.defineProperty\(window, 'numMetaEvent'/);
  assert.match(reddit, /set: function \(fn\)/);
  assert.match(reddit, /catch \(e\)/, 'no fallback if the property cannot be redefined');
});

test('the page reports its moments through one call', () => {
  const ask = readFileSync(join(PUBLIC, 'ask', 'index.html'), 'utf8');
  assert.match(ask, /numMetaEvent\('Lead'/, 'the first-message conversion is no longer reported');
  assert.match(ask, /numMetaEvent\('ViewContent'/);
  assert.match(ask, /numMetaEvent\('CompleteRegistration'/);
  assert.match(ask, /src="\/js\/reddit\.js"/, 'the ads landing page does not load the Reddit conversion layer');
});

test('a blocked or slow pixel cannot break the page', () => {
  // 87% of this traffic is a phone inside Reddit's own in-app browser, and a
  // meaningful share of the rest runs a blocker. Every call is wrapped.
  assert.match(reddit, /if \(typeof window\.rdt === 'function'\)/);
  assert.ok((reddit.match(/try \{/g) ?? []).length >= 5, 'the pixel calls are not defensively wrapped');
});

// ── the bridge, actually run ─────────────────────────────────────────────
//
// String-matching proves the code says the right thing. This proves it DOES
// the right thing, in both load orders, which is the part that was going to
// fail silently for a month.
import vm from 'node:vm';

function boot({ metaFirst }) {
  const calls = { meta: [], reddit: [] };
  const win = {};
  win.window = win;
  win.crypto = { randomUUID: () => 'fixed-id' };
  win.setInterval = () => 0;
  win.clearInterval = () => {};
  const install = () => {
    win.numMetaEvent = (name, params) => calls.meta.push([name, params]);
  };
  if (metaFirst) install();
  vm.runInNewContext(reddit, win);
  if (!metaFirst) install();          // js/track.js loading second
  win.rdt = (verb, ev, params) => calls.reddit.push([verb, ev, params]);
  return { win, calls };
}

test('one call reaches both networks — Meta first', () => {
  const { win, calls } = boot({ metaFirst: true });
  win.numMetaEvent('Lead', { content_name: 'first_ask' });
  assert.equal(calls.meta.length, 1, 'Meta stopped receiving the conversion');
  assert.equal(calls.reddit.length, 1, 'Reddit did not receive the conversion');
  assert.deepEqual(calls.reddit[0][1], 'Lead');
  assert.equal(calls.meta[0][1].eventID, calls.reddit[0][2].conversionId,
    'the two networks got different ids — the Conversions API could not dedupe this later');
});

test('one call reaches both networks — Reddit layer first', () => {
  const { win, calls } = boot({ metaFirst: false });
  win.numMetaEvent('CompleteRegistration', {});
  assert.equal(calls.reddit[0][1], 'SignUp');
  assert.equal(calls.meta.length, 1, 'Meta lost the conversion because it loaded second');
});

test('a conversion reported before either pixel loads is held, not dropped', () => {
  // The visitor who asks Num something two seconds after arriving is the best
  // conversion of the day, and the likeliest to beat an async third-party
  // script to the punch.
  const calls = { meta: [], reddit: [] };
  const win = { crypto: { randomUUID: () => 'fixed-id' }, setInterval: () => 0, clearInterval: () => {} };
  win.window = win;
  vm.runInNewContext(reddit, win);
  win.numMetaEvent('Lead', {});                       // nothing loaded yet
  assert.equal(calls.meta.length, 0);
  win.numMetaEvent = (n, p) => calls.meta.push([n, p]); // track.js arrives
  assert.equal(calls.meta.length, 1, 'the queued conversion was never replayed to Meta');
  assert.equal(calls.meta[0][0], 'Lead');
});

test('an unmapped moment still reaches Reddit as Custom', () => {
  const { win, calls } = boot({ metaFirst: true });
  win.numMetaEvent('StartedTrip', {});
  assert.equal(calls.reddit[0][1], 'Custom');
  assert.equal(calls.reddit[0][2].customEventName, 'StartedTrip');
});
