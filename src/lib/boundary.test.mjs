// The crash screen has to be able to get somebody out.
//
// 15 Sep 2026: a malformed value in localStorage crashed the app on an iPhone
// mid-signup. "Reload Num" cleared the service worker and the caches, restored
// the same bad blob, and crashed again — every time. The only escape was
// deleting the app, which is the one thing you cannot ask of somebody halfway
// through adding a friend.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const B = read('../components/app/Boundary.tsx');
const DATA = read('./data.ts');
const APIBASE = read('./apibase.ts');

describe('the literals cannot drift from the real ones', () => {
  test('the trip key matches the key data.ts actually writes', () => {
    // A reset that clears the wrong key is a reset that does nothing, and it
    // would fail exactly when somebody is already stuck.
    const real = /const STORAGE_KEY = '([^']+)'/.exec(DATA)?.[1];
    const inBoundary = /const TRIP_KEY = '([^']+)'/.exec(B)?.[1];
    assert.ok(real, 'data.ts no longer defines STORAGE_KEY');
    assert.equal(inBoundary, real);
  });

  test('the crash endpoint still matches the app origin', () => {
    // API_ORIGIN is an env override with a literal fallback; the fallback is
    // the one the boundary has to match, because the boundary cannot read env.
    // Non-greedy across the type annotation: `string | undefined` contains the
    // very pipe the fallback is separated by, so [^|]* never reaches it.
    const origin = /VITE_API_ORIGIN[\s\S]{0,80}?\|\|\s*'([^']+)'/.exec(APIBASE)?.[1];
    const endpoint = /CRASH_ENDPOINT = '([^']+)'/.exec(B)?.[1];
    assert.ok(origin, 'apibase.ts no longer defines API_ORIGIN');
    assert.ok(endpoint.startsWith(origin.replace(/\/+$/, '')), `${endpoint} is not on ${origin}`);
  });

  test('the identity key is NOT in the boundary, because it must never be cleared', () => {
    // Identity lives in its own key precisely so a corrupt trip blob costs
    // somebody their chat history and never their account.
    const identity = /const IDENTITY_KEY = '([^']+)'/.exec(DATA)?.[1];
    assert.ok(identity);
    assert.equal(B.includes(identity), false, 'the crash screen can clear the account');
  });
});

describe('the second tier', () => {
  test('it only appears after a reload has already failed', () => {
    // Most crashes are not storage crashes. Throwing away somebody's thread on
    // the first tap would be a worse default than reloading.
    assert.match(B, /\{this\.state\.triedBefore && \(/);
    assert.match(B, /Still broken — clear saved data/);
  });

  test('the first button records that it tried', () => {
    assert.match(B, /sessionStorage\.setItem\(TRIED_KEY, '1'\)/);
  });

  test('the flag dies with the tab, not with the device', () => {
    // A crash today should not offer a destructive button to somebody who
    // comes back next week.
    assert.match(B, /sessionStorage, not localStorage/);
    assert.equal(/localStorage\.setItem\(TRIED_KEY/.test(B), false);
  });

  test('the reset clears the trip and nothing else', () => {
    assert.match(B, /localStorage\.removeItem\(TRIP_KEY\)/);
    assert.equal(/localStorage\.clear\(\)/.test(B), false, 'it clears everything, including the account');
  });

  test('and it reloads properly afterwards, not just in place', () => {
    assert.match(B, /await this\.recover\(\)/);
  });

  test('the person is told what they are about to lose, and what they are not', () => {
    assert.match(B, /You stay signed in/);
    assert.match(B, /on NUM&rsquo;s side, not this phone/);
  });
});

describe('the rules the file sets itself still hold', () => {
  test('no app imports — anything imported here is code that can throw here', () => {
    const imports = [...B.matchAll(/^import .*?from '([^']+)'/gm)].map((m) => m[1]);
    for (const i of imports) {
      assert.ok(i === 'react' || i.startsWith('react'), `Boundary imports ${i}`);
    }
  });

  test('every storage call is wrapped, because storage throws in a webview', () => {
    for (const m of B.matchAll(/(?:sessionStorage|localStorage)\.\w+\(/g)) {
      const before = B.slice(Math.max(0, m.index - 90), m.index);
      assert.match(before, /try \{/, `unwrapped storage call at ${m[0]}`);
    }
  });

  test('tried() cannot throw, and assumes not-tried when it cannot tell', () => {
    // Offering a destructive button to somebody on their first crash is worse
    // than not offering it.
    const fn = B.slice(B.indexOf('function tried()'), B.indexOf('export default class'));
    assert.match(fn, /catch \{/);
    assert.match(fn, /return false/);
  });

  test('colours are still literals, because the stylesheet may be what broke', () => {
    const render = B.slice(B.indexOf('render() {'));
    assert.equal(/var\(--/.test(render), false, 'the recovery screen uses a design token');
  });
});
