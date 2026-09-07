// The guest's words must reach the screen before anything can block.
//
// ── THE BUG THIS PINS ────────────────────────────────────────────────────
//
// `askNum` used to await a location permission prompt BEFORE echoing the
// message into the thread. `send()` clears the composer the instant you press
// Enter, so the text was already gone from the input — and iOS does not run
// getCurrentPosition's own timeout while its permission dialog is up, so an
// unanswered dialog left that await pending forever.
//
// The result, reported from a real device: type a question, press enter,
// nothing. Not an error — nothing. The text left the box and never appeared in
// the thread, never reached the server, never landed in num_asks. Tapping a
// starter chip worked, which made it look like a keyboard problem, because
// most chip prompts do not match `wantsLocalAdvice` and so never reached the
// prompt at all.
//
// Two invariants keep it dead, and both are ORDERING facts that no unit test
// of either function alone would catch:
//   1. the echo happens before the location await
//   2. fixPosition always settles, whatever the platform does
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Source with comments removed — twice now a regex has matched the prose
 *  explaining a rule rather than the code enforcing it, and passed. */
function code(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Only strip `//` when it starts a line's comment, so `https://` survives.
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

const concierge = code('./concierge.ts');
const whereami = code('./whereami.ts');

/* ── 1 · the echo comes first ───────────────────────────────────────────── */

test('askNum pushes the user message BEFORE awaiting a location', () => {
  const body = concierge.slice(concierge.indexOf('export async function askNum'));
  assert.ok(body.length > 200, 'askNum not found — this test is asserting on nothing');

  const echo = body.indexOf("push({ who: 'u'");
  const locate = body.indexOf('ensurePlaceForRecommendation');
  assert.ok(echo > 0, "askNum no longer pushes the user's message");
  assert.ok(locate > 0, 'the location call has moved — re-check this invariant by hand');
  assert.ok(
    echo < locate,
    'the location prompt is awaited before the guest\'s message is shown. '
    + 'A prompt nobody answers makes the question disappear.',
  );
});

test('typing is set before the location await, so the app shows it is working', () => {
  const body = concierge.slice(concierge.indexOf('export async function askNum'));
  const typing = body.indexOf('typing: true');
  const locate = body.indexOf('ensurePlaceForRecommendation');
  assert.ok(typing > 0 && typing < locate,
    'the typing indicator starts after a call that can wait on a human');
});

test('a location failure cannot take the question down with it', () => {
  const body = concierge.slice(concierge.indexOf('export async function askNum'));
  const call = body.slice(body.indexOf('ensurePlaceForRecommendation') - 200,
    body.indexOf('ensurePlaceForRecommendation') + 120);
  assert.match(call, /try\s*\{[^}]*ensurePlaceForRecommendation/,
    'the location call is unguarded — a rejection would abandon the ask');
});

/* ── 2 · the promise always settles ─────────────────────────────────────── */

test('fixPosition has a deadline of its own', () => {
  // getCurrentPosition's `timeout` option does NOT cover the permission
  // prompt, so the platform's timeout is not a deadline. This one is.
  const body = whereami.slice(whereami.indexOf('export async function fixPosition'));
  assert.match(body, /setTimeout\(/,
    'fixPosition relies solely on getCurrentPosition\'s timeout, which does not '
    + 'run while a permission dialog is open — so the promise can hang forever');
});

test('the deadline and the callbacks cannot both resolve', () => {
  const body = whereami.slice(whereami.indexOf('export async function fixPosition'));
  assert.match(body, /settled/, 'no guard against a double settle');
  assert.match(body, /clearTimeout\(/, 'the deadline timer is never cleared');
});

test('a late fix is still recorded, even after the deadline fired', () => {
  // A position that arrives at 12s is still true and makes the NEXT question
  // better. Only the promise is idempotent; the store write is not gated.
  const body = whereami.slice(whereami.indexOf('export async function fixPosition'));
  const setHere = body.indexOf('store.set({ here: at })');
  const done = body.indexOf('done(at)');
  assert.ok(setHere > 0 && done > setHere,
    'the store write is gated behind the settle guard — a late fix is discarded');
});

/* ── 3 · the trigger, so the blast radius stays understood ──────────────── */

test('wantsLocalAdvice still matches the questions people actually type first', () => {
  // If this ever stops matching, the ordering above matters less — but the
  // list is also the reason the bug looked like a keyboard fault: these are
  // typed, and most starter chips are not on this list.
  const fn = whereami.slice(whereami.indexOf('export function wantsLocalAdvice'));
  for (const word of ['eat', 'dinner', 'tonight', 'near', 'recommend']) {
    assert.ok(fn.includes(word), `wantsLocalAdvice no longer matches "${word}"`);
  }
});
