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

/** Source with comments stripped. A grep that reads its own explanation
 *  proves nothing — this file made that mistake twice already. */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

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
  // ── 13 Sep ────────────────────────────────────────────────────────────────
  'token-len-10': () => {
    const m = SRC.match(/function newToken\(len = (\d+)\)/);
    return !!m && Number(m[1]) >= 10 && /256 - \(256 % n\)/.test(SRC);
  },
  'qr-oracle-logged': () => {
    const body = (mark) => strip(SRC.slice(SRC.indexOf(mark), SRC.indexOf(mark) + 2200));
    return /logScan\(env, req,[\s\S]{0,90}unknown_token/.test(body('async function venueQr('))
      && /logPayEvent\(env, req,[\s\S]{0,90}unknown_token/.test(body('async function payQrRoute('));
  },
  'visitor-id-unforgeable': () => {
    const i = SRC.indexOf('async function visitorId(');
    const body = strip(SRC.slice(i, SRC.indexOf('\n}\n', i)));
    return !/user-agent/i.test(body) && /cf-connecting-ip/.test(body);
  },
  'arrive-reply-minimal': () => {
    const i = SRC.indexOf('async function venueArrive');
    const fn = SRC.slice(i, SRC.indexOf('\n}\n', i));
    return !/starts_at: bk\.starts_at/.test(fn) && !/status: bk\.status/.test(fn);
  },
  'venue-currency-default': () => {
    const falls = [...strip(SRC).matchAll(/PAY_CURRENCIES\.includes\([\s\S]{0,120}?:\s*([^;]+);/g)];
    return falls.length >= 3 && falls.every((m) => /currencyForVenue\(env,/.test(m[1]));
  },
  'mail-reply-to-rest': () => !/\breplyTo\s*:/.test(strip(SRC)),
  'mail-no-blind-fallback': () => /internal = false/.test(
    readFileSync(new URL('./resend.mjs', import.meta.url), 'utf8')),
  'host-relink-emailed': () => {
    const i = SRC.indexOf('if (existing) {');
    const branch = SRC.slice(i, i + 2600);
    const reply = branch.slice(branch.indexOf('return J({'));
    return /console_emailed: true/.test(reply) && !/console_url/.test(reply);
  },
  'tables-failure-visible': () => /function banner\(msg,cls\)/.test(SRC)
    && /function loader\(path,draw,what\)/.test(SRC)
    && /trouble==='signedout'/.test(SRC),
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
  assert.ok(claimed.length >= 15, 'expected every control shipped 12-13 Sep');
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
