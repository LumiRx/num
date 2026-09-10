/**
 * The site must not claim coverage it does not have.
 *
 * 10 Sep 2026: itsnum.com said "77 destinations in 38 countries" in 149 places
 * while the database held 104, and llms.txt told answer engines NUM covered
 * "567,793 places" when the real figure was 2,686,795 — a fifth of the truth,
 * published under the heading "the accurate one-line description".
 *
 * Nobody had lied. The numbers were typed by hand into 30+ static files and a
 * Python generator, and the world moved. That is exactly the failure mode a
 * test can close for good.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { drift, TRUTH, CLAIMS } from './coverage-claims.mjs';

describe('coverage claims match the destination list', () => {
  test('nothing on the site contradicts it', () => {
    const bad = drift('public');
    assert.deepEqual(bad, [], bad.map((b) => `${b.file}: "${b.said}"`).join('\n'));
  });

  test('the truth comes from the list, not from a number in this file', () => {
    // If someone ever pins TRUTH to a literal, the guard becomes the thing it
    // was built to prevent.
    const src = readFileSync(new URL('./coverage-claims.mjs', import.meta.url), 'utf8');
    assert.match(src, /destinations: DESTINATIONS\.length/);
    assert.ok(!/destinations:\s*\d+/.test(src), 'TRUTH must be derived');
    assert.ok(TRUTH.destinations > 0 && TRUTH.countries > 0);
  });
});

describe('the guard catches what it is for, and only that', () => {
  const scan = (text) => {
    const hits = [];
    for (const { re, key } of CLAIMS) {
      for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
        const n = Number(String(m[1]).replace(/,/g, ''));
        if (n !== TRUTH[key]) hits.push(m[0]);
      }
    }
    return hits;
  };

  test('a stale coverage claim is caught', () => {
    assert.ok(scan('It covers 2.6 million places across 77 destinations.').length);
    assert.ok(scan('all 77 destinations with place counts').length);
    assert.ok(scan('77 destinations in 38 countries').length);
  });

  test('the true claim passes', () => {
    assert.deepEqual(scan(`across ${TRUTH.destinations} destinations in ${TRUTH.countries} countries`), []);
  });

  test('a legitimate subtotal is NOT flagged', () => {
    // These two sentences are true and were flagged by the first version.
    // A guard that cries wolf on correct copy gets switched off.
    assert.deepEqual(scan('32 destinations have a page of their own.'), []);
    assert.deepEqual(scan('The remaining 100 destinations are listed at itsnum.com.'), []);
  });

  test('an unrelated number is not a coverage claim', () => {
    assert.deepEqual(scan('Pro is 19.99 per month across 10 locations.'), []);
  });
});

describe('the generated files are generated, not typed', () => {
  test('seo_files.py derives its numbers from the destination list', () => {
    const py = readFileSync(new URL('./seo_files.py', import.meta.url), 'utf8');
    assert.match(py, /from pages_cities import DESTS/);
    assert.match(py, /N_PLACES = sum\(d\[4\] for d in DESTS\)/);
    // Comments are stripped first: the incident is deliberately written down
    // at the top of that file, old numbers and all, and a record of what went
    // wrong must not read as the bug still being there.
    const live = py.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.ok(!/567,793/.test(live), 'the old hand-typed place count must be gone');
    assert.ok(!/\b77 destinations\b/.test(live), 'the old hand-typed destination count must be gone');
  });
});
