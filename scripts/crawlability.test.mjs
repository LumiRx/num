// Nothing renders robots.txt and nothing type-checks a <link rel=canonical>.
// The feedback loop on a missing sitemap entry is a report that comes back
// thin three weeks later, by which time nobody connects it to the commit.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { audit, descOf, canonOf, hasLd, noindex, disallowed, sitemapUrls } from './crawlability.mjs';

const ROBOTS = readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8');

describe('the parser reads what is actually there', () => {
  // Every one of these bit a first draft of this audit today.
  test('an apostrophe in the value does not end the value', () => {
    const h = `<meta name="description" content="Add NUM's travel places MCP server to Cursor">`;
    assert.equal(descOf(h), "Add NUM's travel places MCP server to Cursor",
      'the apostrophe ended the match and condemned eleven good /agents/ pages');
  });

  test('single-quoted attributes work too', () => {
    assert.equal(canonOf(`<link rel='canonical' href='https://itsnum.com/x/'>`), 'https://itsnum.com/x/');
  });

  test('noindex is a decision, not a gap', () => {
    assert.equal(noindex('<meta name="robots" content="noindex,nofollow">'), true);
    assert.equal(noindex('<meta name="robots" content="noindex, follow">'), true);
    assert.equal(noindex('<meta name="robots" content="index,follow">'), false);
    assert.equal(noindex('<html></html>'), false, 'no robots meta means indexable by default');
  });

  test('the disallow list is read from the wildcard block, not from a named agent', () => {
    const d = disallowed(ROBOTS);
    assert.ok(d.includes('/api/') && d.includes('/console/'), `got ${JSON.stringify(d)}`);
    assert.equal(d.includes('/'), false, 'a bare / would mean the whole site is disallowed');
  });

  test('a sitemap index lists sitemaps, and its entries are not pages', () => {
    const urls = sitemapUrls();
    assert.equal([...urls].some((u) => /sitemap/.test(u)), false,
      'sitemap_index.xml entries leaked in as if they were pages');
  });
});

describe('every indexable page is machine-readable', () => {
  const { rows, dead } = audit();
  const real = rows.filter((r) => !r.print);

  test('there are pages to check at all', () => {
    assert.ok(real.length > 50, `only ${real.length} pages — the walk is broken, not the site`);
  });

  for (const [field, what] of [['title', 'a <title>'], ['desc', 'a meta description'],
    ['canon', 'a canonical'], ['ld', 'structured data'], ['inMap', 'a sitemap entry']]) {
    test(`every indexable page has ${what}`, () => {
      const bad = real.filter((r) => !r[field]).map((r) => r.url);
      assert.deepEqual(bad, [], `missing ${what}: ${bad.join(' ')}`);
    });
  }

  test('no sitemap URL points at a page that does not exist', () => {
    // A 404 in a sitemap is worse than an omission: it is an assertion that
    // the page is there, which is the one thing a crawler takes on trust.
    assert.deepEqual(dead, [], `dead sitemap URLs: ${dead.join(' ')}`);
  });
});

describe('robots.txt does not claim more than the site delivers', () => {
  // It said "Structured data on every page" while 16 pages had none — a claim
  // a crawler disproves in one fetch, on a site selling "verified, checked".
  test('the opening claim is one the audit above can stand behind', () => {
    assert.doesNotMatch(ROBOTS, /Structured data on every page/i,
      'that sentence was false for 16 pages; if it is back, this audit must prove it first');
    assert.match(ROBOTS, /Structured data on every/i, 'the claim was dropped rather than corrected');
  });

  test('everything robots.txt points at exists', () => {
    for (const f of ['llms.txt', 'llms-full.txt']) {
      assert.ok(readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').length > 500, `${f} is missing or a stub`);
    }
  });
});
