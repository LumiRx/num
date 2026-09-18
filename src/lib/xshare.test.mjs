// Sharing to X, with no X API.
//
// Two things here are worth more than the rest: that a public post carries a
// REFERRAL link and never a connect link, and that the post still fits once X
// has charged 23 characters for the URL. The first is a privacy question, the
// second is the difference between a compose box the member can send and one
// showing an error.
//
// The real module is LOADED AND RUN, not re-implemented. `xshare.ts` is pure on
// purpose — no `window`, no imports — so the only thing standing between this
// test and the shipped code is a type strip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'xshare.ts'), 'utf8');

/** The real module, with TypeScript annotations removed. */
const X = await (async () => {
  // Narrow on purpose. `xshare.ts` annotates only with NAMED aliases and
  // primitives — no inline object types — precisely so this strip stays three
  // lines instead of becoming a second implementation of TypeScript living in a
  // test file. If a future edit needs a cleverer strip, that is the signal to
  // simplify the source rather than the signal to grow this.
  const js = SRC
    .replace(/^type\s+\w+\s*=[\s\S]*?;\s*$/gm, '')
    .replace(/:\s*(XPost|XPlace|string|number|boolean)\b/g, '')
    .replace(/export (const|function)/g, '$1');
  const names = ['X_INTENT', 'X_LIMIT', 'X_URL_COST', 'X_TEXT_BUDGET',
    'fitText', 'xShareUrl', 'shareNumOnX', 'sharePlaceOnX'];
  const fn = new Function(`${js}\nreturn {${names.join(',')}};`);
  const mod = fn();
  for (const n of names) assert.ok(mod[n] !== undefined, `${n} did not load from xshare.ts`);
  return mod;
})();

const params = (url) => new URL(url).searchParams;

test('a share is a plain intent link — no key, no token, no API', () => {
  const u = X.shareNumOnX('https://app.itsnum.com/r/ABC');
  assert.match(u, /^https:\/\/twitter\.com\/intent\/tweet\?/);
  // The whole point: nothing secret can be in a URL the browser opens.
  assert.doesNotMatch(u, /bearer|oauth|api[_-]?key|token=/i);
});

test('THE PRIVACY ONE: a public post carries a referral link, never a connect link', () => {
  // `/c/<memberId>` CONNECTS whoever opens it to that member. Texted to a
  // friend that is the feature; posted publicly it invites any stranger
  // scrolling past to attach themselves to a named person.
  const u = X.shareNumOnX('https://app.itsnum.com/r/ABC');
  const shared = params(u).get('url');
  assert.equal(shared, 'https://app.itsnum.com/r/ABC');
  assert.doesNotMatch(shared, /\/c\//, 'a connect link reached a public post');
  // And the file must say why, so the next edit does not quietly swap it back.
  assert.match(SRC, /referralLink\(\).*credit without connection|credit without connection/s);
});

test('the URL rides in its own parameter, so X builds a preview card', () => {
  const u = X.sharePlaceOnX({ name: 'Bang Tao Seafood', city: 'Phuket' }, 'https://app.itsnum.com/r/Z');
  const p = params(u);
  assert.equal(p.get('url'), 'https://app.itsnum.com/r/Z');
  assert.match(p.get('text'), /Bang Tao Seafood/);
  assert.match(p.get('text'), /Phuket/);
  assert.doesNotMatch(p.get('text'), /itsnum\.com/, 'inside the text a link is just characters');
});

test('the post fits AFTER X charges 23 characters for the link', () => {
  // Budgeting by the real URL length makes a long link look free and X then
  // rejects the whole post rather than trimming it.
  assert.equal(X.X_URL_COST, 23);
  assert.equal(X.X_TEXT_BUDGET, X.X_LIMIT - X.X_URL_COST - 1);
  const long = 'Seafood '.repeat(80);
  const u = X.sharePlaceOnX({ name: long, city: 'Phuket' }, 'https://app.itsnum.com/r/Z');
  const text = params(u).get('text');
  assert.ok(text.length <= X.X_TEXT_BUDGET, `${text.length} characters is over budget`);
  assert.ok(text.length + X.X_URL_COST + 1 <= X.X_LIMIT, 'the finished post is over 280');
});

test('trimming breaks on a word, not mid-word', () => {
  const t = X.fitText('the quick brown fox jumped over the lazy dog', 20);
  assert.ok(t.length <= 20);
  assert.match(t, /…$/);
  assert.doesNotMatch(t, /\s…$/, 'a space before the ellipsis is a visible seam');
  // The break must land on a boundary that existed in the input.
  const body = t.slice(0, -1);
  assert.ok('the quick brown fox jumped over the lazy dog'.startsWith(body));
  assert.doesNotMatch(body, /jumpe$/, 'cut mid-word');
});

test('one very long word is cut rather than deleted', () => {
  // With no space to break at, breaking early would throw most of it away.
  const t = X.fitText('Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch', 20);
  assert.ok(t.length <= 20);
  assert.ok(t.length > 10, 'almost everything was discarded looking for a space');
});

test('text that already fits is left exactly alone', () => {
  assert.equal(X.fitText('short enough', 100), 'short enough');
  assert.doesNotMatch(X.fitText('short enough', 100), /…/);
});

test('whitespace is collapsed, because a post is one line', () => {
  assert.equal(X.fitText('  two   lines\n  here  ', 100), 'two lines here');
});

test('a non-https link is refused rather than posted', () => {
  // A post is public and permanent; this is not something to tidy up later.
  for (const bad of ['http://app.itsnum.com/r/A', 'javascript:alert(1)', 'ftp://x', '', null]) {
    const u = X.xShareUrl({ text: 'hello', url: bad });
    assert.equal(params(u).get('url'), null, `${bad} reached a post`);
  }
});

test('with no link, the text may use the whole 280', () => {
  const u = X.xShareUrl({ text: 'x'.repeat(400), url: null });
  assert.equal(params(u).get('text').length, X.X_LIMIT);
});

test('a place with no name produces nothing to post', () => {
  for (const p of [null, {}, { name: '  ' }, { city: 'Phuket' }]) {
    assert.equal(X.sharePlaceOnX(p, 'https://app.itsnum.com/r/Z'), '');
  }
});

test('via drops a leading @, which X rejects', () => {
  assert.equal(params(X.xShareUrl({ text: 'hi', via: '@itsnum' })).get('via'), 'itsnum');
  assert.equal(params(X.xShareUrl({ text: 'hi', via: 'itsnum' })).get('via'), 'itsnum');
});

/* ── THE BUTTON, AS WIRED ─────────────────────────────────────────────────
 *
 * The module above can be perfect and the feature still wrong, because the
 * whole privacy question is WHICH LINK the sheet hands it. These read the
 * component.
 */

const SHEET = readFileSync(join(HERE, '../components/app/ShareSheet.tsx'), 'utf8');

test('a public post carries the referral link, never the connect link', async () => {
  // 18 Sep 2026: the X button moved into src/lib/socialshare.ts with every
  // other destination. The promise is unchanged and now holds for Instagram
  // and Facebook too: a public channel gets the referral link (credits the
  // member, connects nobody); a private one gets the connect link.
  const { DESTINATIONS, linkFor } = await import('./socialshare.ts');
  const l = { connect: 'https://app.itsnum.com/c/mem_1?ref=ABC', referral: 'https://app.itsnum.com/r/ABC', line: 'Join me.' };
  for (const d of DESTINATIONS) {
    if (!d.href) continue;
    const href = d.href(l);
    if (d.public) {
      assert.ok(!href.includes(encodeURIComponent(l.connect)) && !href.includes(l.connect), `${d.id}: the connect link reached a public post`);
      assert.equal(linkFor(d, l), l.referral);
    } else {
      assert.equal(linkFor(d, l), l.connect);
    }
  }
  assert.ok(DESTINATIONS.some((d) => d.id === 'x' && d.public), 'X is still a public destination');
});

test('every destination is an anchor, because an installed PWA blocks window.open', () => {
  // A share button that silently does nothing is worse than no share button.
  const block = SHEET.slice(SHEET.indexOf('offered(links!).map'), SHEET.indexOf('pretty(links!.connect)'));
  assert.ok(block.length > 40, 'the destination row was not found');
  assert.match(block, /<a key=\{d\.id\} href=\{href\} target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(SHEET, /window\.open/);
});

test('nothing is posted without the member — no key, no auto-post', () => {
  assert.doesNotMatch(SHEET, /fetch\([^)]*x\.com|api\.twitter|XAI_|X_API/i,
    'the sheet is calling an API; this feature is a compose link the member sends');
});

test('a member with no referral code is offered no public tile at all', async () => {
  const { offered } = await import('./socialshare.ts');
  const none = offered({ connect: 'https://app.itsnum.com/c/mem_1', referral: null, line: 'Join me.' });
  assert.ok(none.every((d) => !d.public), 'a public tile with nothing but a connect link would auto-connect strangers');
  assert.ok(none.some((d) => d.id === 'whatsapp') && none.some((d) => d.id === 'copy'), 'the private tiles stay');
  assert.match(SHEET, /referral: me\.ref \? referralLink\(me\.ref\) : null/);
});
