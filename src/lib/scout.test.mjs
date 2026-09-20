import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const LIB = read('./scout.ts');
const SHEET = read('../components/app/ScoutSheet.tsx');
const PROFILE = read('../components/app/ProfileView.tsx');
const APP = read('../components/app/ConciergeApp.tsx');
const PAGE = read('../../app-public/scout/index.html');

describe('the sheet never does arithmetic on hope', () => {
  test('money comes from the server’s earned figures only', () => {
    // Introductions times the finder fee is the number a scout will compute in
    // their head if the page invites it, and it would be wrong.
    assert.match(SHEET, /data\.money\.accrued_minor \+ data\.money\.payable_minor \+ data\.money\.paid_minor/);
    assert.equal(/byState[\s\S]{0,80}\*\s*(finder|terms)/.test(SHEET), false,
      'the sheet multiplies a count by a fee somewhere');
  });

  test('the money note from the server is shown, not paraphrased', () => {
    assert.match(SHEET, /\{data\.money\.note\}/);
  });

  test('each state carries the server’s own explanation', () => {
    assert.match(SHEET, /data\.businesses\.meaning\?\.\[st\]/);
  });

  test('"introduced" and "earning" are different words on the screen', () => {
    assert.match(SHEET, /activated: 'Earning'/);
    assert.match(SHEET, /introduced: 'Introduced'/);
  });

  test('the terms shown are the scout’s own, with the promise attached', () => {
    assert.match(SHEET, /\{data\.terms\.note\}/);
    assert.match(SHEET, /data\.terms\.finder_gate_minor/);
  });
});

describe('formatting money', () => {
  test('rounding goes down, never up', async () => {
    const { money, pct } = await import('./scout.ts').catch(() => ({}));
    // The .ts is not importable from node directly; assert the source instead.
    assert.equal(typeof money, 'undefined');
    assert.equal(typeof pct, 'undefined');
    assert.match(LIB, /Math\.floor\(n\) \/ 100/);
    assert.equal(/Math\.round\([^)]*\) \/ 100/.test(LIB), false, 'money rounds up somewhere');
  });

  test('a non-number is $0.00, not NaN on a scout’s screen', () => {
    assert.match(LIB, /if \(!Number\.isFinite\(n\)\) return '\$0\.00'/);
  });
});

describe('the door into it', () => {
  test('the sheet is mounted', () => {
    assert.match(APP, /import ScoutSheet from '\.\/ScoutSheet'/);
    assert.match(APP, /<ScoutSheet \/>/);
  });

  test('there is a way in from the profile', () => {
    assert.match(PROFILE, /store\.set\(\{ scoutOpen: true \}\)/);
  });

  test('somebody who is not an expert yet is told how to become one', () => {
    // Sign-up is open, so hiding the door would be hiding something they are
    // allowed to walk through.
    assert.match(SHEET, /You are not a Num Expert yet/);
    assert.match(SHEET, /href="\/scout"/);
  });

  test('the words on screen are Dre’s words, not the table names', () => {
    // The schema stays `num_scouts` and the route stays /s/CODE — renaming a
    // live schema to match a brand word is a migration with no upside, and the
    // short link is already going on printed cards. What a person READS is
    // "Num Expert" everywhere.
    assert.match(SHEET, /NUM EXPERT/);
    assert.equal(/>\s*Become a scout\s*</.test(SHEET), false);
    assert.match(PROFILE, /NUM EXPERT/);
    assert.match(PAGE, /Num Experts/);
  });
});

/**
 * The page's own JavaScript, comments stripped.
 *
 * Scoped to the <script> block FIRST, and that is not tidiness. Stripping
 * block comments across the whole document silently ate the entire script,
 * because the markup contains `accept="application/pdf,image/*"` — the `/*`
 * inside that attribute value opens a comment that runs until the next `*​/`
 * hundreds of lines later, in the JavaScript. The assertion then failed on
 * code that was present and correct.
 *
 * Comments are stripped because prose has satisfied a test in this repo five
 * times now: the sentence explaining that sign-in no longer uses `prompt()`
 * contains the word `prompt(`.
 */
const SCRIPT = (() => {
  const open = PAGE.indexOf('<script>');
  const close = PAGE.lastIndexOf('</script>');
  return PAGE.slice(open, close)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
})();

describe('the web page', () => {
  test('it says what is paid and when, above the form', () => {
    assert.match(PAGE, /released once that business has produced its first/);
    assert.match(PAGE, /Nothing is paid for a signature/);
  });

  test('the terms version promise is on the form itself', () => {
    assert.match(PAGE, /rates you get today stay yours even if the programme changes/);
  });

  test('the server’s meaning is ON THE PAGE, not in a tooltip', () => {
    // It used to be a `title` attribute. A `title` tooltip needs hover, and
    // hover does not exist on a touch screen — so the explanation of what
    // "introduced" versus "activated" means was invisible to every single
    // person it was written for, all of whom are holding a phone outside a
    // shop. It is rendered into the row now.
    assert.match(PAGE, /meaning\[p\.state\]/,
      'the page stopped using the server’s own wording for a state');
    assert.ok(!/\.title\s*=/.test(PAGE),
      'a state meaning is back in a tooltip, where a phone cannot reach it');
  });

  test('business names are set as text, never as markup', () => {
    // These are names typed by whoever ran the claim. textContent is the whole
    // defence and innerHTML would be the hole.
    // Asserted on the PROPERTY rather than on one variable name: the previous
    // version matched `a.textContent = p.biz_name` exactly, so renaming the
    // local from `a` to `nm` during the 17 Sep rebuild broke the test while
    // the safety it guards was completely intact. A test that a rename can
    // fail is testing the spelling, not the defence.
    assert.match(PAGE, /textContent = p\.biz_name/);
    assert.equal(/innerHTML\s*=/.test(PAGE), false, 'the page assigns innerHTML somewhere');
    assert.equal(/insertAdjacentHTML|outerHTML\s*=|document\.write/.test(PAGE), false,
      'the page writes markup by another route');
  });

  test('localStorage is wrapped, because a private window throws', () => {
    for (const m of PAGE.matchAll(/localStorage\.(getItem|setItem)/g)) {
      const around = PAGE.slice(Math.max(0, m.index - 120), m.index + 80);
      assert.match(around, /try \{/, `unguarded localStorage near: ${m[0]}`);
    }
  });

  test('a failed dashboard call lands on the sign-in door, not a blank page', () => {
    // Before the 17 Sep rebuild the dashboard fetch failed silently and left
    // whatever was on screen. Now every failure — refused, expired session,
    // no connection — routes to the same place, which is the one screen that
    // can actually get the person moving again.
    assert.match(PAGE, /function signedOut/);
    assert.match(PAGE, /\.catch\(function \(\) \{ signedOut\(null\); return false; \}\)/);
  });

  test('SIGNING IN IS BY EMAIL, and the code is never a credential again', () => {
    // Comments stripped FIRST — HTML and JS both. The fifth time this trap has
    // been hit in this repo: the sentence explaining that signing in no longer
    // uses `prompt()` contains the word `prompt(`, so an unstripped search
    // fails on its own explanation. Assert against code, never against prose.
    // The whole reason this page was rebuilt. `?code=` used to open the
    // dashboard, the paperwork, and the POST that signs the NDA.
    const code = SCRIPT;
    assert.match(code, /api\/scouts\/login/);
    assert.match(code, /credentials: 'same-origin'/);
    assert.ok(!/code=' \+ encodeURIComponent|\?code=/.test(code),
      'the page is sending a referral code as authentication again');
    assert.ok(!/prompt\(/.test(code),
      'signing in is back to typing a code into a prompt()');
  });

  test('THE 404 BUG: the page moves itself to the origin the API is on', () => {
    // The reason nobody had ever signed up through this page. It is published
    // at BOTH itsnum.com/scout (num-console serves public/) and
    // app.itsnum.com/scout (Vite copies public/ into dist/), but the API
    // exists only on app.itsnum.com — itsnum.com/api/scouts/terms is a 404,
    // as is every other /api path on the apex. Every call the page made from
    // the apex had been 404ing since it was written.
    //
    // Redirect rather than call across hosts: a cross-origin call would need
    // CORS and a SameSite=None cookie to carry a contractor's session, and
    // Safari drops third-party cookies.
    const code = SCRIPT;
    assert.match(code, /location\.replace\('https:\/\/' \+ APP_HOST \+ '\/scout\/' \+ location\.search\)/,
      'the page no longer moves itself onto the API origin');
    assert.match(code, /location\.search/,
      'the query string is dropped, so a sign-in link landing on the apex would lose its token');
    assert.match(code, /localhost/,
      'local development now redirects to production');
  });

  test('the reply never reveals whether an address is on the programme', () => {
    assert.match(PAGE, /If that address is a Num Expert/);
  });

  test('it is readable on a phone, which is where a scout is', () => {
    assert.match(PAGE, /@media\(max-width:480px\)/);
    assert.match(PAGE, /viewport-fit=cover/);
  });
});

describe('the signpost left at the old address', () => {
  // itsnum.com/scout is the address in the docs, on the printed cards and in
  // what has already been sent to people, so it has to keep working. It must
  // NOT keep working by being a second copy of the dashboard — two copies is
  // how one of them quietly stops matching the other.
  const STUB = readFileSync(new URL('../../public/scout/index.html', import.meta.url), 'utf8');

  test('it sends people to the origin the API is on', () => {
    assert.match(STUB, /https:\/\/app\.itsnum\.com\/scout\//);
    assert.match(STUB, /location\.replace\('https:\/\/app\.itsnum\.com\/scout\/' \+ location\.search\)/,
      'the query string is dropped, so a sign-in link landing here loses its token');
  });

  test('it still redirects with JavaScript off', () => {
    // A redirect nobody can follow without JavaScript is a dead end. Both the
    // meta refresh and a real link, because in-app browsers vary.
    assert.match(STUB, /http-equiv="refresh"/);
    assert.match(STUB, /<a href="https:\/\/app\.itsnum\.com\/scout\/"/);
  });

  test('IT IS NOT A SECOND COPY OF THE DASHBOARD', () => {
    assert.ok(STUB.length < 3000, `the signpost is ${STUB.length} bytes — it has grown back into a page`);
    // Comments stripped: the file's own explanation of WHY it moved lists the
    // API paths that 404 on this host, so an unstripped search fails on the
    // sentence describing the bug. Sixth time in this repo. Assert on code.
    const markup = STUB.replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/api\/scouts|api\/expert-docs/.test(markup),
      'the old address is calling the API again, from a host that has no API');
  });

  test('and it is not indexed twice', () => {
    // Two URLs serving the same thing is the search engine's problem until it
    // becomes ours.
    assert.match(STUB, /noindex/);
    assert.match(STUB, /rel="canonical" href="https:\/\/app\.itsnum\.com\/scout\/"/);
  });
});

describe('the paperwork on the page', () => {
  const PACK = readFileSync(new URL('../../app-public/scout/index.html', import.meta.url), 'utf8');

  test('it says you earn while the paperwork is outstanding', () => {
    // The line that stops somebody thinking they have to finish forms before
    // they can start working.
    assert.match(PACK, /You can start signing businesses up straight away and you keep everything you earn/);
    assert.match(PACK, /cannot pay it out until these are done/);
  });

  test('the NDA is signed on the page, with the text shown first', () => {
    assert.match(PACK, /Type your full name to sign/);
    assert.match(PACK, /ndaBody/);
    assert.match(PACK, /expert-docs\/nda/);
  });

  test('the tax form is downloaded from the IRS, never from Num', () => {
    assert.match(PACK, /Download the form from the IRS/);
    // The link is set at runtime from the server's url, which expertdocs.test
    // asserts is on www.irs.gov and nowhere else. What THIS page must not do is
    // carry a form link of its own — a hardcoded one is how a copy of a
    // government form eventually gets served from Num's own domain.
    assert.equal(/fw9|w-?9[^a-z]{0,3}\.pdf/i.test(PACK.replace(/id="w9"|'w9'|\/w9/g, '')), false);
    assert.match(PACK, /\$\('taxLink'\)\.href = tax\.url/);
  });

  test('the file input takes a photo, because that is what people send', () => {
    assert.match(PACK, /accept="application\/pdf,image\/\*"/);
  });

  test('the section disappears once both are accepted', () => {
    assert.match(PACK, /if \(pack\.payable\) show\('docs', false\)/);
  });

  test('every state word is plain English, not a database value', () => {
    assert.match(PACK, /uploaded: 'Received — Num is checking it\.'/);
    assert.match(PACK, /accepted: 'Done\.'/);
  });

  test('nothing about the paperwork is rendered as markup', () => {
    // A reject reason is typed by a person at Num and goes on the page.
    assert.match(PACK, /\$\('taxState'\)\.textContent/);
    assert.equal(/innerHTML\s*=/.test(PACK), false);
  });
});
