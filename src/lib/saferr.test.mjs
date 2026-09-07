/**
 * The last line of defence: nothing that looks like code, a stack trace, a
 * status code or a vendor's billing reaches a guest's screen.
 *
 * 6 Sep 2026. Every screen in this app did `setNote(err.message)`, and every
 * fetch wrapper did `throw new Error(body.error || 'errand 500')`. So a guest
 * could read a D1 constraint, an Anthropic billing line, or the literal string
 * "errand 500". This file pins the rule at the point of display.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'saferr.ts'), 'utf8');

/** Run the module's rules without a TypeScript step: strip the types. */
const mod = await import(`data:text/javascript,${encodeURIComponent(
  SRC.replace(/:\s*RegExp\[\]/g, '').replace(/:\s*unknown/g, '').replace(/:\s*string(\s*[,)=])/g, '$1')
     .replace(/\)\s*:\s*boolean\s*\{/g, ') {').replace(/\)\s*:\s*string\s*\{/g, ') {')
     .replace(/where\?/g, 'where').replace(/export /g, 'export '),
)}`);
const { guestMessage, isGuestSafe } = mod;

const NEVER = {
  'a D1 error': 'D1_ERROR: NOT NULL constraint failed: num_orders.total_cs',
  'a status shorthand': 'errand 500',
  'a bare status': '502',
  'the vendor billing line': 'Your credit balance is too low to access the Anthropic API.',
  'a request id': 'failed req_011CemHaFBPKEUY5qTtEQVny',
  'a stack frame': 'TypeError: x is undefined\n    at send (dm.ts:54:11)',
  'a fenced block': '```\nnpm run build\n```',
  'raw JSON': '{"error":"nope"}',
  'browser network words': 'Failed to fetch',
  'an arrow function': 'const f = (x) => { return x; }',
  'an api key': 'bad key sk-ant-api03-abcdefghijkl',
  'an http status': 'upstream said HTTP 402',
};
for (const [what, raw] of Object.entries(NEVER)) {
  test(`never shown: ${what}`, () => {
    assert.equal(isGuestSafe(raw), false, `a guest could read: ${raw}`);
    assert.equal(guestMessage(new Error(raw), 'That didn’t go through.'), 'That didn’t go through.');
  });
}

test('a real server sentence is passed through untouched', () => {
  const good = [
    'That code didn’t match — check the six digits and try once more.',
    'Sorry, that table is no longer free at 19:30.',
    'LA Cannabis Club is 21+ only — verify your identity in Num first.',
    'You have already invited that number to this plan.',
  ];
  for (const s of good) {
    assert.equal(isGuestSafe(s), true, `a good message was suppressed: "${s}"`);
    assert.equal(guestMessage(new Error(s), 'fallback'), s);
  }
});

test('no screen renders a raw error message any more', () => {
  const files = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n) && !/\.test\./.test(n) && n !== 'saferr.ts') files.push(p);
    }
  })(HERE.replace(/\/lib$/, ''));

  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // `err instanceof Error ? err.message : '…'` — the pattern that shipped it.
    if (/(err|e|error)\s+instanceof\s+Error\s*\?\s*\1\.message/.test(src)) {
      offenders.push(f.slice(HERE.length - 3));
    }
  }
  assert.deepEqual(offenders, [], 'these render a raw error to a guest — use guestMessage() instead');
});
