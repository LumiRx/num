// ONE NAV, ONE COPY OF IT.
//
// worker/nav.test.mjs guards the OUTPUT: it reads public/ and fails when a
// page has no way out of itself, or still carries the pre-September markup.
// That test is downstream of the problem. It cannot fire until a generator
// has already written the wrong nav into a file somebody is about to commit,
// and on 19 Sep 2026 that is exactly what happened — /guides/ and both Rome
// guides shipped a five-link header that exists nowhere else on the site,
// because scripts/pseo/ held its own copy of the nav from before the move.
//
// scripts/pseo/genclients.mjs had been caught the same way earlier, and the
// comment left behind said its copy was "kept byte-identical to the shared
// nav". There was no shared nav. There were three copies that happened to
// agree — which is a coincidence, not a guarantee, and not something that
// survives anybody editing one of them.
//
// scripts/nav.mjs is the shared nav now. This file guards the SOURCE: that
// the generators still holding an inline copy match it, and that the ones
// that import it have not quietly grown one back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV, NAV_HEAD, TRANSLATE } from './nav.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(HERE, ...p), 'utf8');

// Generators that still write the nav out by hand rather than importing it.
// Each must match scripts/nav.mjs byte for byte. Emptying this list is the
// goal; adding to it is how the 2026 split happened.
const INLINE = ['destpage.mjs'];

// Generators that import it. They must NOT contain a literal nav element —
// that is the shape the drift always takes: someone pastes the current markup
// in "just for this page" and the import becomes decoration.
const IMPORTS = ['pseo/template.mjs', 'pseo/hub.mjs', 'pseo/genclients.mjs'];

// Generators that write a <head> and must take it from NAV_HEAD, so the nav's
// stylesheet, its script and the referral carrier travel together.
const HEADS = ['pseo/template.mjs', 'pseo/hub.mjs', 'pseo/genclients.mjs'];

test('an inlined nav is byte-identical to the shared one', () => {
  for (const f of INLINE) {
    const s = read(f);
    const i = s.indexOf('<nav class="nv">');
    assert.notEqual(i, -1, `${f}: no nav at all — did it move to the old markup?`);
    const inline = s.slice(i, s.indexOf('</nav>', i) + 6);
    assert.equal(inline, NAV,
      `${f} has drifted from scripts/nav.mjs. Change scripts/nav.mjs, not this copy.`);
  }
});

test('a generator that imports the nav does not also hold one', () => {
  for (const f of IMPORTS) {
    const s = read(f);
    assert.match(s, /from '\.\.?\/(\.\.\/)?nav\.mjs'/, `${f}: does not import the shared nav`);
    assert.equal(s.includes('<nav class="nv">'), false,
      `${f}: imports the nav and then writes one out anyway`);
  }
});

test('no generator still emits the markup the site left behind', () => {
  // The exact three strings worker/nav.test.mjs looks for in public/, checked
  // one step earlier, where the fix is a one-line edit instead of a rebuild.
  for (const f of [...INLINE, ...IMPORTS]) {
    for (const junk of ['class="navlinks"', 'class="menu-btn"', 'class="mobile"']) {
      assert.equal(read(f).includes(junk), false, `${f}: still emits ${junk}`);
    }
  }
});

test('a generator that writes a head takes it from the shared one', () => {
  // Hand-listing the nav's assets is how they come apart: genclients.mjs
  // listed nav.css and nav.js and not refcarry.js, so every run deleted the
  // referral script from eleven pages that link to the app.
  for (const f of HEADS) {
    const s = read(f);
    assert.match(s, /\$\{NAV_HEAD\}/, `${f}: writes its own head instead of using NAV_HEAD`);
    assert.equal(/<link rel="stylesheet" href="\/assets\/nav\.css">/.test(s), false,
      `${f}: lists the nav stylesheet by hand as well`);
  }
});

test('the shared nav satisfies what the page test demands of every page', () => {
  // These are worker/nav.test.mjs's rules, asserted against the source so a
  // generated page cannot be the first place we find out.
  assert.equal(NAV.split('<nav class="nv">').length - 1, 1, 'two navs in one nav');
  assert.equal(NAV.split('id="navAuth"').length - 1, 1, 'site.js has no single element to swap');
  assert.equal(NAV.split('class="nv-cta"').length - 1, 1, '"Get NUM" appears twice on one screen');
  assert.match(NAV, /href="\/hosts\/"[^>]*>For hosts</, 'the public host page is not in the nav');
  assert.equal(/href="\/host\/"/.test(NAV), false, 'the nav links the PRIVATE host console');
});

test('the nav brings its own stylesheet and script', () => {
  // 41 pages do not load assets/site.css. A nav that depends on it renders as
  // unstyled markup there, which is worse than no nav.
  assert.match(NAV_HEAD, /\/assets\/nav\.css/);
  assert.match(NAV_HEAD, /\/assets\/nav\.js/);
  // The nav's own CTA is a link to app.itsnum.com, and localStorage does not
  // cross an origin. A page that carries the nav and not this script sends
  // people to the app and drops their referral code on the way — which is
  // what scripts/pseo/genclients.mjs was doing to all eleven /agents/ pages
  // on every run, silently re-stripping a line somebody kept adding by hand.
  if (NAV.includes('app.itsnum.com')) {
    assert.match(NAV_HEAD, /\/assets\/refcarry\.js/,
      'the nav links the app but the head does not carry the referral script');
  }
  assert.equal(TRANSLATE.trim(), '<script src="/assets/translate.js" defer></script>');
  assert.equal(TRANSLATE.includes('gtInit'), false, 'the translator is pasted inline again');
});

test('the python builder that still holds the old nav cannot be run', () => {
  // scripts/build_pages.py carries the pre-September NAV constant and is
  // imported by pages_more / pages_company / pages_agents. None of them is an
  // entry point: scripts/build.py is, and it refuses to write because public/
  // has been hand-edited since — including two pricing sweeps a rebuild would
  // revert. If that guard is ever lifted, the old nav goes back on every page
  // it touches, so the guard is what keeps this file's list short.
  const old = read('build_pages.py');
  assert.ok(old.includes('<nav class="nav">'), 'build_pages.py was fixed — drop this test and add it to INLINE');
  const build = read('build.py');
  assert.match(build, /BUILD_PAGES_I_READ_THE_STALE_GUARD/,
    'the stale guard is gone and build_pages.py can now write the old nav over the site');
});
