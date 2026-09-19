// robots.txt is the one file where a typo is invisible until a quarter of
// traffic has gone. Nothing here renders it, nothing type-checks it, and the
// only feedback is a report that comes back empty weeks later.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const TXT = readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8');

/** Every block, as { agent, allow[], disallow[] }. */
function blocks(txt) {
  const out = [];
  let cur = null;
  for (const raw of txt.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^(User-agent|Allow|Disallow|Crawl-delay|Sitemap):\s*(.*)$/i);
    if (!m) continue;
    const [, k, v] = m;
    const key = k.toLowerCase();
    if (key === 'user-agent') { cur = { agent: v, allow: [], disallow: [] }; out.push(cur); continue; }
    if (!cur) continue;
    if (key === 'allow') cur.allow.push(v);
    if (key === 'disallow') cur.disallow.push(v);
  }
  return out;
}

const ALL = blocks(TXT);
const byAgent = (a) => ALL.find((b) => b.agent.toLowerCase() === a.toLowerCase());

// The tokens Semrush actually sends, from semrush.com/bot. Naming a token
// that does not exist is worse than useless: it reads as coverage and matches
// nothing.
const SEMRUSH = ['SemrushBot', 'SiteAuditBot', 'SemrushBot-BA', 'SemrushBot-SI',
  'SemrushBot-SWA', 'SemrushBot-OCOB', 'SplitSignalBot'];

describe('robots.txt parses at all', () => {
  test('there is a wildcard block and it is not a wall', () => {
    const star = byAgent('*');
    assert.ok(star, 'no "User-agent: *" block — every unnamed crawler is then undefined behaviour');
    assert.ok(star.allow.includes('/'), 'the wildcard must allow the site');
    assert.equal(star.disallow.includes('/'), false, 'Disallow: / on the wildcard would delist the entire site');
  });

  test('no block anywhere disallows the whole site', () => {
    for (const b of ALL) {
      assert.equal(b.disallow.includes('/'), false, `${b.agent} is blocked entirely — was that deliberate?`);
    }
  });

  test('every declared agent actually has rules', () => {
    for (const b of ALL) {
      assert.ok(b.allow.length + b.disallow.length > 0, `${b.agent} is named with no rules, which does nothing`);
    }
  });
});

describe('the SEO crawlers are allowed, and provably so', () => {
  // 19 Sep 2026. They were already allowed by falling through to the
  // wildcard, which is true and completely invisible to a support desk asking
  // "are we in your robots.txt". Being right is not the same as being able to
  // show it.
  for (const agent of SEMRUSH) {
    test(`${agent} is named and allowed`, () => {
      const b = byAgent(agent);
      assert.ok(b, `${agent} is not named — a Site Audit that comes back empty cannot be ruled out here`);
      assert.ok(b.allow.includes('/'), `${agent} is named but not allowed`);
      assert.equal(b.disallow.includes('/'), false, `${agent} is blocked outright`);
    });
  }

  test('their rules match the wildcard exactly — an explicit block must not become a quiet exception', () => {
    // The whole point is that naming them changed NOTHING about access. The
    // day someone adds a Disallow to one of these and not the others, the
    // difference is a crawl budget mystery nobody connects to this file.
    const star = byAgent('*');
    const want = [...star.disallow].sort().join('|');
    for (const agent of SEMRUSH) {
      const got = [...byAgent(agent).disallow].sort().join('|');
      assert.equal(got, want, `${agent} has drifted from the wildcard's disallow list`);
    }
  });

  test('/api/ stays closed to them — there is no content there to audit', () => {
    for (const agent of SEMRUSH) {
      assert.ok(byAgent(agent).disallow.includes('/api/'), `${agent} may crawl /api/`);
    }
  });
});

describe('the sitemaps are reachable', () => {
  test('at least one Sitemap line, absolute and https', () => {
    const maps = [...TXT.matchAll(/^Sitemap:\s*(\S+)$/gim)].map((m) => m[1]);
    assert.ok(maps.length > 0, 'no Sitemap line — a crawler has to guess at the URL set');
    for (const m of maps) {
      assert.match(m, /^https:\/\/itsnum\.com\//, `a relative or off-domain sitemap is ignored: ${m}`);
    }
  });
});
