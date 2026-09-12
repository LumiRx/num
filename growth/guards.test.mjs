// The guard list on /api/growth/health must never be able to lie.
//
// It exists so that one curl after a deploy answers "did the fix land". That is
// only worth anything if the list is TRUE — a build that claims a control it
// does not have is worse than no list at all, because it would be believed.
//
// So every name is tied to the code that implements it. Remove the control and
// this fails; remove the name and this fails. Each pairing was checked by
// deleting the implementation and watching the test go red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const CLAIMS = readFileSync(new URL('./claimverify.mjs', import.meta.url), 'utf8');

// name → the thing in the source that has to be there for the name to be true
const EVIDENCE = {
  'arrive-guess-lock': () => /async function arriveGuessing\(/.test(SRC)
    && /if \(guess\.network\) \{/.test(SRC)
    && /FROM num_venue_scans/.test(SRC),
  'booking-ref-verified': () => /FROM num_bookings WHERE id = \?1 AND business_id = \?2/
    .test(readFileSync(new URL('../worker/billqr.mjs', import.meta.url), 'utf8')),
  'identity-owner-only': () => {
    const i = SRC.indexOf('async function qrIdentitySet');
    return i > 0 && /QR\.can\(who\.role, "settings"\)/.test(SRC.slice(i, i + 1400));
  },
  'offers-noreferrer': () => (SRC.match(/<a href="\/tonight\/"[^>]*>/g) || [])
    .every((a) => /noreferrer/.test(a)),
  'claim-send-cap': () => /MAX_SENDS_PER_CLAIM_PER_DAY/.test(CLAIMS)
    && /MAX_SENDS_PER_CLAIM_PER_DAY\) \{/.test(CLAIMS),
  'consent-throttle': () => /overLimit\("consent:" \+ cip, \d+\)/.test(SRC),
};

/** The names inside the GUARDS array literal, and nothing else. Scoped to the
 *  closing bracket — a looser window picked up unrelated strings from the
 *  function below it and reported a guard the code never claimed. */
function claimedGuards() {
  const start = SRC.indexOf('const GUARDS = Object.freeze([');
  assert.ok(start > 0, 'GUARDS must exist');
  const end = SRC.indexOf(']);', start);
  assert.ok(end > start, 'GUARDS must be closed');
  return [...SRC.slice(start, end).matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
}

test('health actually publishes the guard list', () => {
  assert.match(SRC, /const GUARDS = Object\.freeze\(\[/, 'the list must exist');
  assert.match(SRC, /guards: GUARDS,/, 'and health must return it — a list nobody can read is a comment');
});

test('every guard the build claims is really in the build', () => {
  const claimed = claimedGuards();
  assert.ok(claimed.length >= 6, 'expected the six controls shipped 12 Sep');
  for (const name of claimed) {
    const check = EVIDENCE[name];
    assert.ok(check, `"${name}" is advertised on health with nothing tying it to code — add it to EVIDENCE`);
    assert.ok(check(), `the build claims "${name}" but the code that implements it is gone`);
  }
});

test('every control we have is advertised, so the list does not silently go stale', () => {
  const claimed = claimedGuards();
  for (const name of Object.keys(EVIDENCE)) {
    assert.ok(claimed.includes(name), `${name} exists in the code but health does not mention it`);
  }
});
