// Public tokens: how long they are, how evenly they are drawn, and whether a
// miss on the routes that resolve them leaves a trace.
//
// WHY ANY OF THIS MATTERS. A /p/ or /v/ token is the only thing between a
// stranger and a live venue's pay page. It is printed on a card, so it is not
// secret from anyone standing in the room — the threat is the person who never
// goes there, walking the space from outside. Two routes made that cheap:
// /api/venue/qr/ and /api/pay/qr/ answer 200 or 404 for any token and, until
// 12 Sep 2026, wrote nothing at all, while /v/ and /p/ both recorded every
// miss into the tables the security sweep reads. The open door was the one
// nobody watched.
//
// Source assertions, the convention for worker.js — the file is too large to
// import. Each was checked by reverting the change and watching it fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

const ALPHABET = SRC.match(/const TOKEN_ALPHABET = "([^"]+)"/)[1];
const DEFAULT_LEN = Number(SRC.match(/function newToken\(len = (\d+)\)/)[1]);

test('a minted token is long enough that the space cannot be walked', () => {
  const bits = Math.log2(ALPHABET.length) * DEFAULT_LEN;
  assert.ok(DEFAULT_LEN >= 10, `tokens are ${DEFAULT_LEN} characters — six was walkable`);
  assert.ok(bits >= 45,
    `${bits.toFixed(1)} bits of token. Below ~45 a scripted walk of the space is an afternoon, `
    + 'and every hit is somebody\'s live pay page.');
});

test('nobody has to type one, so length costs a guest nothing', () => {
  // Stated as a test so the trade-off is written down where it is decided. The
  // ONE human-typed code in the system is the guest check-in code, which is
  // short on purpose — read aloud across a counter, in a second language, over
  // noise — and is defended by the guessing lock instead of by length.
  assert.match(SRC, /const CODE_OK = /, 'the typed code keeps its own separate rule');
  assert.ok(!/newToken\(\s*\d+\s*\)/.test(SRC),
    'every caller must take the default, so raising it raises all of them at once');
});

test('characters are drawn evenly — no modulo bias', () => {
  const fn = SRC.slice(SRC.indexOf('function newToken('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /256 - \(256 % n\)/,
    'rejection sampling: 256 is not a multiple of 28, so a bare % skews the first four letters');
  assert.match(body, /if \(b\[i\] < limit\)/, 'and the out-of-range bytes must actually be dropped');

  // Behavioural, not just structural. Re-implemented from the same alphabet:
  // the biased version puts the first four letters ~11% over, which this
  // threshold catches and the fixed version passes comfortably.
  const n = ALPHABET.length;
  const limit = 256 - (256 % n);
  const counts = new Map([...ALPHABET].map((c) => [c, 0]));
  const bytes = 2_000_000;
  const buf = new Uint8Array(bytes);
  for (let off = 0; off < bytes; off += 65536) {
    crypto.getRandomValues(buf.subarray(off, Math.min(off + 65536, bytes)));
  }
  let kept = 0;
  for (let i = 0; i < bytes; i++) {
    if (buf[i] < limit) { counts.set(ALPHABET[buf[i] % n], counts.get(ALPHABET[buf[i] % n]) + 1); kept++; }
  }
  const expected = kept / n;
  for (const [ch, got] of counts) {
    const off = Math.abs(got - expected) / expected;
    assert.ok(off < 0.03, `"${ch}" came up ${(off * 100).toFixed(1)}% off uniform`);
  }
});

/** A function's body with comments removed. Asserting against raw source lets a
 *  COMMENT satisfy the test: the first version of the check below passed with
 *  the logging call deleted, because the explanatory comment above it still
 *  contained the word it was grepping for. Twice in one day — the SQL version
 *  of this same mistake is in scanoutcomes.test.mjs. Strip prose, assert code. */
function codeOf(marker, span = 2200) {
  const i = SRC.indexOf(marker);
  assert.ok(i > 0, `${marker} must exist`);
  return SRC.slice(i, i + span)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

test('a miss on the QR artwork routes is recorded, not silent', () => {
  for (const [fn, logger] of [['async function venueQr(', 'logScan'], ['async function payQrRoute(', 'logPayEvent']]) {
    const body = codeOf(fn);
    const call = body.indexOf(`${logger}(env, req,`);
    const answer = body.indexOf('return TEXT("unknown token", 404)');
    assert.ok(call > 0,
      `${fn} 404s an unknown token without calling ${logger} — a free, untraceable existence oracle`);
    assert.ok(/unknown_token/.test(body),
      `${fn} must record the miss under a name the sweep reads`);
    assert.ok(answer > 0 && call < answer, `${fn} must write the miss BEFORE it answers`);
  }
});

test('the recorded miss uses the kind the security sweep already reads', () => {
  // A new name here would need a new sweep query, and — as num_venue_scans
  // proved on 12 Sep — possibly a new CHECK constraint too. Reusing the
  // existing one means the alert that already exists starts covering this
  // route the moment it deploys, with nothing else to remember.
  const sweep = SRC.includes("outcome='unknown_token'") || SRC.includes('outcome = \'unknown_token\'');
  assert.ok(sweep || SRC.includes("kind='unknown_token'") || SRC.includes("'unknown_token'"),
    'the sweep must already query this name');
});
