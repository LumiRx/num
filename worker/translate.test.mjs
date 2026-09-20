// ONE TRANSLATOR, EVERY PAGE.
//
// The widget used to be four things pasted into each page by hand — a div, a
// style rule, an init function and a script tag. Thirty-four pages had all
// four and forty-seven had none, including Bangkok, Phuket, the FAQ and How it
// works, while one Taiwanese mountain village had it. Nobody decided that; it
// is what a copy-paste snippet does over a year.
//
// So it lives in /assets/translate.js and a page opts in with one line. This
// test is what stops the drift coming back: a page missing from BOTH the
// exemption list below and the script is a bug, not a judgement call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');

function walk(dir = PUBLIC, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      // Print artwork is not a web page and has no reader to translate for.
      if (name !== 'flyers' && name !== 'assets') walk(p, out);
    } else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

const PAGES = walk().map((p) => [p.slice(PUBLIC.length + 1).split(sep).join('/'), readFileSync(p, 'utf8')]);
const TAG = '/assets/translate.js';

// Pages that must NOT carry it, each with a stated reason.
const NO_TRANSLATE = {
  'get/index.html': 'a redirect stub, on screen for milliseconds',
  'join/index.html': 'a redirect stub',
  // The dashboard itself moved to app-public/scout/ on 17 Sep 2026, so it is
  // served by num-app on the same origin as the API it calls. What is left here
  // is a signpost: itsnum.com/scout is the address on the printed cards.
  'scout/index.html': 'a redirect stub — the Expert dashboard moved to app.itsnum.com/scout/',
  'console/index.html': 'the partner console, not a page a stranger lands on',
  'host/index.html': 'the private host console, key-gated and noindex',
  'app-preview/index.html': 'team-only prototype, noindex, linked from nowhere public',
};

test('every page can be translated, except the ones we decided should not', () => {
  const missing = PAGES
    .filter(([p, s]) => !(p in NO_TRANSLATE) && !s.includes(TAG))
    .map(([p]) => p);
  assert.deepEqual(missing, [], `pages a traveller cannot read in their own language: ${missing.join(', ')}`);
});

test('an exempted page really is exempt, so the list cannot rot', () => {
  for (const p of Object.keys(NO_TRANSLATE)) {
    assert.ok(PAGES.some(([q]) => q === p), `${p} is exempted but no longer exists`);
  }
});

test('nobody has pasted the widget inline again', () => {
  // The whole failure mode. If this starts failing, someone copied a snippet
  // out of an old page instead of adding the one line.
  for (const [p, s] of PAGES) {
    assert.equal(s.includes('gtInit'), false, `${p} has an inline copy of the translator`);
    assert.equal(s.includes('translate_a/element.js'), false, `${p} loads Google's script directly`);
  }
});

test('the destination pages are covered, because that is who arrives from a search', () => {
  // A stranger searching in Thai lands on /bangkok/, not on the homepage.
  const dests = PAGES.filter(([p]) => /^(bangkok|phuket|edinburgh|london|rome|alishan)\//.test(p) || /^(bangkok|phuket|edinburgh|london)\/index\.html$/.test(p));
  assert.ok(dests.length >= 4, 'destination pages not found — has the site moved?');
  for (const [p, s] of dests) assert.ok(s.includes(TAG), `${p} cannot be translated`);
});

const JS = readFileSync(join(PUBLIC, 'assets', 'translate.js'), 'utf8');

test('it injects its own markup and styles, so a page needs one line and not four', () => {
  assert.match(JS, /id = HOST_ID/);
  assert.match(JS, /gtx-style/);
  assert.match(JS, /document\.body\.appendChild/);
});

test('nothing is shown until Google actually answers', () => {
  // An empty pill in the corner of every page reads as something failing to
  // load, which is worse than no control at all.
  assert.match(JS, /display:none\}/);
  assert.match(JS, /\.gtx\.ready\{display:block\}/);
  assert.match(JS, /el\.className = 'gtx ready'/);
});

test('a blocked or failed load leaves no dead box behind', () => {
  // Google is blocked outright in some of the countries Num covers.
  assert.match(JS, /s\.onerror = function/);
  assert.match(JS, /removeChild\(el\)/);
  assert.match(JS, /\} catch \(e\) \{/);
});

test('Google’s page-shoving banner is suppressed', () => {
  assert.match(JS, /\.skiptranslate\{display:none!important\}/);
  assert.match(JS, /body\{top:0!important\}/);
});

test('it is labelled for a screen reader', () => {
  // Unlabelled, it is a select that changes the entire page.
  assert.match(JS, /aria-label', 'Translate this page'/);
});

test('it runs once even if two pages load it', () => {
  assert.match(JS, /if \(window\.__numTranslate\) return/);
});

test('it is out of the way on a phone and gone in print', () => {
  assert.match(JS, /@media \(max-width:480px\)/);
  assert.match(JS, /@media print\{\.gtx\{display:none!important\}\}/);
});
