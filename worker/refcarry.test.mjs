// A referral code has to survive the walk from itsnum.com to app.itsnum.com.
//
// THE BREAK THESE TESTS EXIST FOR. Measured on production 19 Sep 2026: 21
// referral arrivals logged, 0 members with a referrer. The code that stores a
// referral lives in the app, on app.itsnum.com; the link lands on itsnum.com.
// localStorage is per-origin, so every code was dropped at the boundary, in
// silence, on every link. The whole programme paid nobody and looked fine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');
const SRC = readFileSync(join(PUBLIC, 'assets', 'refcarry.js'), 'utf8');

function walk(dir = PUBLIC, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}
const PAGES = walk().map((p) => [p.slice(PUBLIC.length + 1).split(sep).join('/'), readFileSync(p, 'utf8')]);

test('every page that links to the app carries the referral code', () => {
  // The rule is mechanical on purpose: 64 pages linked to the app when this
  // was found, and "remember to add it" is what produced 0 of 21.
  const missing = PAGES
    .filter(([, s]) => s.includes('app.itsnum.com') && !s.includes('refcarry.js'))
    .map(([p]) => p);
  assert.deepEqual(missing, [],
    `these pages send people to the app and drop the referral on the way: ${missing.join(', ')}`);
});

test('it reads ?ref= and it writes the same key the app reads', () => {
  // 'num-ref' is the key src/lib/social.ts reads at signup. A different key
  // here would store the code somewhere nothing ever looks.
  assert.match(SRC, /'num-ref'/);
  assert.match(SRC, /get\('ref'\)/);
});

test('it puts the code on the app link itself, because the URL is the only channel between two origins', () => {
  assert.match(SRC, /a\[href\^="https:\/\/app\.itsnum\.com"\]/);
  assert.match(SRC, /'ref=' \+ encodeURIComponent\(code\)/);
});

test('it never overwrites a code already written into a link by hand', () => {
  assert.match(SRC, /if \(\/\[\?&\]ref=\/\.test\(href\)\) continue/);
});

test('it does not fight the app over who gets paid', () => {
  // The app owns the last-touch rule and documents why. Two files deciding
  // that is how somebody is paid twice, or nobody is.
  assert.match(SRC, /if \(localStorage\.getItem\(KEY\) !== code\) localStorage\.setItem\(KEY, code\)/);
});

test('localStorage is wrapped, because private mode throws and a page must still load', () => {
  const reads = SRC.match(/localStorage/g) || [];
  const tries = SRC.match(/try \{/g) || [];
  assert.ok(tries.length >= 3, 'every localStorage access needs its own try');
  assert.ok(reads.length >= 3);
});

test('the site page a referral link actually lands on is covered', () => {
  // /r/CODE redirects to the site root. If that page were missing the script
  // the fix would cover 80 pages and miss the only one that matters.
  const home = PAGES.find(([p]) => p === 'index.html');
  assert.ok(home, 'the home page is gone');
  assert.ok(home[1].includes('refcarry.js'), 'the page every referral link lands on drops the code');
});
