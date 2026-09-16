import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const LIB = read('./scout.ts');
const SHEET = read('../components/app/ScoutSheet.tsx');
const PROFILE = read('../components/app/ProfileView.tsx');
const APP = read('../components/app/ConciergeApp.tsx');
const PAGE = read('../../public/scout/index.html');

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
    assert.match(PAGE, /N(um|UM) Experts/);
  });
});

describe('the web page', () => {
  test('it says what is paid and when, above the form', () => {
    assert.match(PAGE, /released once that business has produced its first/);
    assert.match(PAGE, /Nothing is paid for a signature/);
  });

  test('the terms version promise is on the form itself', () => {
    assert.match(PAGE, /rates you get today stay yours even if the programme changes/);
  });

  test('the state column uses the server’s meaning as its tooltip', () => {
    assert.match(PAGE, /d\.businesses\.meaning \|\| \{\}\)\[p\.state\]/);
  });

  test('business names are set as text, never as markup', () => {
    // These are names typed by whoever ran the claim. textContent is the whole
    // defence and innerHTML would be the hole.
    assert.match(PAGE, /a\.textContent = p\.biz_name/);
    assert.equal(/innerHTML\s*=/.test(PAGE), false, 'the page assigns innerHTML somewhere');
  });

  test('localStorage is wrapped, because a private window throws', () => {
    for (const m of PAGE.matchAll(/localStorage\.(getItem|setItem)/g)) {
      const around = PAGE.slice(Math.max(0, m.index - 120), m.index + 80);
      assert.match(around, /try \{/, `unguarded localStorage near: ${m[0]}`);
    }
  });

  test('it still works as a signup form if the dashboard call fails', () => {
    assert.match(PAGE, /the page still works as a signup form/);
  });

  test('it is readable on a phone, which is where a scout is', () => {
    assert.match(PAGE, /@media\(max-width:480px\)/);
    assert.match(PAGE, /viewport-fit=cover/);
  });
});

describe('the paperwork on the page', () => {
  const PACK = readFileSync(new URL('../../public/scout/index.html', import.meta.url), 'utf8');

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
