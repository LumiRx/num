/**
 * THE AD LANDING PAGE HAS TO SHOW THE PRODUCT WITHOUT SCROLLING.
 *
 * Measured on the live page, 18 Sep 2026:
 *
 *   iPhone 13, 664px fold — the Ask box started at 647px. Four pixels of it.
 *   iPhone SE, 553px fold — the Ask box started at 647px. Ninety-four below.
 *
 * Of 2,764 visitors from the second week of the Reddit campaign, 66 scrolled
 * halfway and 24 typed anything: 0.9%. The page was not failing to persuade
 * them. It was not showing them the thing the ad had promised.
 *
 * The repair reorders `.col` on a phone so the box comes before the
 * sub-headline. The geometry itself needs a browser and is checked by
 * scripts/ipad-review-walkthrough.mjs's sibling measurements; what is checked
 * HERE is the footgun that would silently undo it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../public/ask/index.html', import.meta.url), 'utf8');
const mobileBlock = () => {
  const i = HTML.indexOf('GET THE PRODUCT ABOVE THE FOLD');
  assert.ok(i > 0, 'the fold block is gone — read this file before deleting it');
  return HTML.slice(i, HTML.indexOf('</style>', i));
};

describe('the ask page puts the box above the fold on a phone', () => {
  test('every direct child of .col is given an explicit order', () => {
    // THE FOOTGUN. A flex child with no `order` defaults to 0 and sorts AHEAD
    // of order:1 — so forgetting one flings it to the top of the column, which
    // is a worse page than the one being fixed. There are four children:
    // .askhero, .box, .under, #ways.
    const block = mobileBlock();
    for (const child of ['.askhero', '.box', '.col>.under', '.col>.sub', '.col>#ways']) {
      const re = new RegExp(`${child.replace(/[.#>]/g, (c) => `\\${c}`)}\\s*\\{[^}]*order:\\s*\\d`);
      assert.match(block, re, `${child} has no explicit order — it will jump to the top`);
    }
  });

  test('the box is ordered before the sub-headline, which is the whole point', () => {
    const block = mobileBlock();
    const orderOf = (sel) => {
      const m = block.match(new RegExp(`${sel.replace(/[.#>]/g, (c) => `\\${c}`)}\\s*\\{[^}]*order:\\s*(\\d)`));
      return m ? Number(m[1]) : null;
    };
    assert.ok(orderOf('.box') < orderOf('.col>.sub'),
      'the concierge box must come before the supporting copy on a phone');
    assert.ok(orderOf('.askhero') < orderOf('.box'),
      'but after the headline — that is the ad\'s promise and it stays on top');
  });

  test('the sub-headline is a sibling of the header, or it cannot be moved', () => {
    // `order` only sorts siblings. While <p class="sub"> lived INSIDE
    // <header class="askhero"> no amount of CSS could put it after the box.
    const header = HTML.slice(HTML.indexOf('<header class="askhero">'), HTML.indexOf('</header>'));
    assert.doesNotMatch(header, /class="sub"/,
      'the sub is back inside the header, so the mobile order silently does nothing');
    assert.match(HTML, /<\/header>[\s\S]{0,400}<p class="sub">/,
      'and it should sit just after it, so the desktop reading order is unchanged');
  });

  test('nothing was deleted to make room', () => {
    // The temptation is to cut copy. The copy is fine; it was in front of the
    // product rather than behind it.
    assert.match(HTML, /Dinner, a driver, a table for six/, 'the sub-headline still exists');
    assert.match(HTML, /Live in 39 countries/, 'the pill still exists');
    assert.match(HTML, /Free\. No signup, no app store, no card/, 'the reassurance line still exists');
    for (const chip of ['Dinner tonight in Edinburgh', 'Landing in Bangkok at 11pm', 'Quiet place to work in Tokyo']) {
      assert.ok(HTML.includes(chip), `the "${chip}" chip still exists`);
    }
  });

  test('the desktop layout is left alone', () => {
    const block = mobileBlock();
    assert.match(block, /@media\(max-width:700px\)/, 'the reorder is phone-only');
    assert.ok(!/\.col\{display:flex;flex-direction:column\}/.test(HTML.slice(0, HTML.indexOf('GET THE PRODUCT ABOVE THE FOLD'))),
      '.col must not become a flex column outside the media query');
  });
});
