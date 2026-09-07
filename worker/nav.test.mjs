// ONE NAVIGATION, EVERY PAGE.
//
// Before 3 Sep 2026, 41 of 78 pages had NO navigation at all — every Taiwan
// destination page, /taipei/, /partners/, /referral/, /sms/, /claim/,
// /signin/. A visitor who arrived on one of them from search hit a cul-de-sac:
// nothing on the page led anywhere else on itsnum.com. The 37 that did have a
// nav carried four different versions of it, between 2 and 17 links, so "the
// nav" was not one thing anybody could change.
//
// These tests keep it one thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');

function walk(dir = PUBLIC, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}
const PAGES = walk().map((p) => [p.slice(PUBLIC.length + 1).split(sep).join('/'), readFileSync(p, 'utf8')]);

/**
 * How a page is recognised as having the site navigation.
 *
 * It used to be the bare string `class="nv"`, which is two letters any page
 * may reuse for something else — and one did. The hosts one-pager has three
 * "Never" cards styled `<div class="nv">`, and this file read them as three
 * site navigations and failed four tests on a page that was perfectly fine.
 *
 * A marker for "this page has the nav" has to name the nav element, or it is
 * really a marker for "this page contains two particular letters".
 */
const NAV_TAG = '<nav class="nv">';
const hasNav = (s) => s.includes(NAV_TAG);

// Pages that must NOT carry the nav, each for a stated reason. A page missing
// from BOTH this list and the nav is a bug, not a judgement call.
const NO_NAV = {
  // Not "no links out" — it has two, by hand: the wordmark goes home and one
  // link answers the question a stranger has before typing. What it must not
  // grow is the six-link site nav, because every extra exit on this page is a
  // click that cost money and left without asking Num anything.
  'ask/index.html': 'the ads landing page — it carries its own two-link header instead',
  'get/index.html': 'a redirect stub, on screen for milliseconds',
  'join/index.html': 'a redirect stub',
  'console/index.html': 'the partner demo console, not a marketing page',
  'app-preview/index.html': 'team-only prototype, noindex, linked from nowhere public',
  'host/index.html': 'the private host console, key-gated and noindex',
  'flyers/business/index.html': 'print artwork',
  'flyers/hosts/index.html': 'print artwork',
  'flyers/hosts/onepager/index.html': 'print artwork',
  'flyers/hosts/onepager/usd/index.html': 'print artwork, the US price version',
};

test('every page has the nav, except the ones we decided should not', () => {
  const missing = PAGES.filter(([p, s]) => !NO_NAV[p] && !hasNav(s)).map(([p]) => p);
  assert.deepEqual(missing, [], `pages with no way out: ${missing.join(', ')}`);
});

test('the ads landing page still has no nav', () => {
  // /ask/ is what paid traffic lands on. Its job is one thing — get a message
  // sent — and a nav is six ways to leave before that happens.
  const ask = PAGES.find(([p]) => p === 'ask/index.html');
  assert.ok(ask, 'the ads landing page is gone');
  assert.equal(hasNav(ask[1]), false, 'the ads page grew a navigation');
});

test('the nav appears once per page, with one auth hook', () => {
  for (const [p, s] of PAGES) {
    if (!hasNav(s)) continue;
    assert.equal(s.split(NAV_TAG).length - 1, 1, `${p}: two navs`);
    // site.js swaps this one element to "Sign out" when a session exists. Two
    // of them and only the first would ever update.
    assert.equal(s.split('id="navAuth"').length - 1, 1, `${p}: navAuth is not unique`);
  }
});

test('the VIP host page is in the nav on every page that has one', () => {
  // Asked for by name on 3 Sep 2026. /hosts/ is the public host page;
  // /host/ (singular) is the key-gated console and must never be linked.
  for (const [p, s] of PAGES) {
    if (!hasNav(s)) continue;
    const nav = s.slice(s.indexOf('<nav class="nv">'), s.indexOf('</nav>'));
    assert.match(nav, /href="\/hosts\/"[^>]*>For hosts</, `${p}: the host page is not in the nav`);
    assert.equal(/href="\/host\/"/.test(nav), false, `${p}: the nav links the PRIVATE host console`);
  }
});

test('every nav link points at a page that exists', () => {
  const sample = PAGES.find(([, s]) => hasNav(s))[1];
  const nav = sample.slice(sample.indexOf('<nav class="nv">'), sample.indexOf('</nav>'));
  const hrefs = [...nav.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 8, 'the nav lost its links');
  for (const h of hrefs) {
    if (h === '/') continue;
    const file = join(PUBLIC, h.replace(/^\/|\/$/g, ''), 'index.html');
    assert.ok(existsSync(file), `the nav links ${h}, which does not exist`);
  }
});

test('the nav carries its own stylesheet and script, in the head', () => {
  // 41 of these pages do not load assets/site.css. If the nav depended on it
  // they would show unstyled markup, which is worse than no nav.
  for (const [p, s] of PAGES) {
    if (!hasNav(s)) continue;
    const head = s.indexOf('</head>');
    assert.ok(s.includes('/assets/nav.css'), `${p}: no nav stylesheet`);
    assert.ok(s.includes('/assets/nav.js'), `${p}: no nav script`);
    assert.ok(s.indexOf('/assets/nav.css') < head, `${p}: the stylesheet is below </head>`);
  }
});

test('no page still carries the old nav markup', () => {
  for (const [p, s] of PAGES) {
    for (const junk of ['class="navlinks"', 'class="menu-btn"', 'class="mobile"']) {
      assert.equal(s.includes(junk), false, `${p}: leftover ${junk} from the old nav`);
    }
  }
});

const css = readFileSync(join(PUBLIC, 'assets', 'nav.css'), 'utf8');
const js = readFileSync(join(PUBLIC, 'assets', 'nav.js'), 'utf8');
// The file's comments quote the broken comparison to explain it. A guard that
// cannot tell code from its own explanation gets the explanation deleted.
const jsCode = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('the nav collapses before the row can collide with the brand', () => {
  // Six links plus a button need more room than the old 860px breakpoint gave
  // them; between 860 and ~1040 the row used to overlap the wordmark.
  const bp = /@media\(max-width:(\d+)px\)\{\s*\.nv-links\{display:none\}/.exec(css);
  assert.ok(bp, 'the collapse breakpoint is gone');
  assert.ok(Number(bp[1]) >= 1000, `collapses at ${bp[1]}px — too narrow for six links and a button`);
});

test('the current page is marked by comparing whole paths', () => {
  // site.js compared an href like "/how-it-works/" against
  // location.pathname.split('/').pop() — "how-it-works", no slashes — so it
  // never matched and no page has ever shown as current.
  assert.match(js, /location\.pathname\.replace/);
  assert.match(js, /aria-current/);
  assert.equal(/split\('\/'\)\.pop\(\)/.test(jsCode), false, 'the broken active-link comparison is back');
});

test('the menu can be closed without a mouse', () => {
  assert.match(js, /e\.key === 'Escape'/, 'the mobile menu is a keyboard trap');
  assert.match(js, /aria-expanded/);
});

test('the nav does not offer the same button twice on one screen', () => {
  for (const [p, s] of PAGES) {
    if (!hasNav(s)) continue;
    const nav = s.slice(s.indexOf('<nav class="nv">'), s.indexOf('</nav>'));
    assert.equal(nav.split('class="nv-cta"').length - 1, 1, `${p}: "Get the app" appears twice in the nav`);
  }
});
