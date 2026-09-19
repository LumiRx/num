// Who gets paid for a signup.
//
// The referral code is stored on first touch because somebody taps a friend's
// link today and signs up on Thursday. Until 18 Sep 2026 the rule was PURE
// first touch: once stored, nothing replaced it.
//
// Half of that is right and stays. Someone who returns later with no link at
// all still belongs to whoever persuaded them — losing that is how a referrer
// is robbed by their own referee's second visit.
//
// The other half was wrong. A genuinely new referral could never be recorded:
// tap Ana's link in March and never sign up, tap Ben's link in September and
// sign up that day, and Ana was paid for work Ben did. With two people
// posting the same product that is not a rounding error, it is the wrong
// person being paid.
//
// Rule: silence changes nothing, a different explicit code wins, the same
// code again is not a change.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./social.ts', import.meta.url), 'utf8');

/** The rule as written, lifted out so it can be exercised directly. */
function applyRef(stored, urlCode) {
  const mem = { 'num-ref': stored };
  const ref = urlCode;
  if (ref) {
    const code = ref.slice(0, 40);
    if (mem['num-ref'] !== code) mem['num-ref'] = code;
  }
  return mem['num-ref'];
}

describe('referral attribution', () => {
  test('a first code is stored', () => {
    assert.equal(applyRef(null, 'ana'), 'ana');
  });

  test('a visit with NO code leaves the credit alone', () => {
    // The whole reason this is persisted. Someone who comes back directly,
    // from a bookmark or a push, still belongs to Ana.
    assert.equal(applyRef('ana', null), 'ana');
    assert.equal(applyRef('ana', undefined), 'ana');
    assert.equal(applyRef('ana', ''), 'ana');
  });

  test('a DIFFERENT code wins', () => {
    assert.equal(applyRef('ana', 'ben'), 'ben');
  });

  test('the same code again is not a change', () => {
    // A referrer refreshing their own post must not be able to churn the
    // record, or "last write" becomes "whoever reloads most".
    assert.equal(applyRef('ana', 'ana'), 'ana');
  });

  test('a code is truncated before it is compared, not after', () => {
    const long = 'x'.repeat(60);
    assert.equal(applyRef(null, long), 'x'.repeat(40));
    // and storing it again must not read as a change
    assert.equal(applyRef('x'.repeat(40), long), 'x'.repeat(40));
  });

  test('the source still implements this rule, not the old one', () => {
    assert.ok(
      !/if \(ref && !localStorage\.getItem\('num-ref'\)\)/.test(SRC),
      'pure first touch is back: a new referral can no longer be recorded',
    );
    assert.match(SRC, /if \(localStorage\.getItem\('num-ref'\) !== code\) localStorage\.setItem\('num-ref', code\);/);
  });

  test('it still cannot break boot in private mode', () => {
    assert.match(SRC, /catch \{ \/\* private mode — attribution is not worth breaking boot \*\/ \}/);
  });
});
