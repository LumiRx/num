// The bug that cost two days.
//
// `asked: userText` sat inside the fetch handler, where the variable is called
// `lastUser`. `userText` exists only as a parameter of askNum, so every
// big-lane request threw a ReferenceError — AFTER the model had already
// produced a good answer — and the catch quietly replaced it with the
// directory fallback.
//
// Every symptom pointed somewhere else: "the chat is down", degraded replies,
// an empty brain-events table, an outage that survived a model change and a
// kill switch. The brains were healthy the entire time. A one-word scope error
// wearing an outage's clothes.
//
// There is no linter in this project, so these are the guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');

/**
 * Strip comments before scanning. The comment above the fixed line explains
 * the bug by naming `userText`, and the first version of this guard failed on
 * its own documentation — a test that cannot tell code from prose will either
 * be deleted or have its explanation deleted, and both are worse than the bug.
 */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The body of `async fetch(request, env, ctx)`, where `userText` does not exist. */
function fetchHandler(src) {
  const start = src.indexOf('async fetch(request, env, ctx)');
  assert.ok(start > 0, 'the fetch handler could not be located — this guard is not running');
  return code(src.slice(start));
}

test('the request handler never references askNum’s parameter names', () => {
  // Bare `userText` (not `userText:` as an object key) inside the fetch
  // handler is always this bug. The handler calls it `lastUser`.
  const body = fetchHandler(index);
  const bare = [...body.matchAll(/\buserText\b(?!\s*:)/g)];
  assert.equal(
    bare.length, 0,
    `\`userText\` is referenced ${bare.length} time(s) in the fetch handler, where it does not exist. ` +
    'It is a parameter of askNum. The variable here is `lastUser`. This throws a ReferenceError ' +
    'AFTER the model has answered, and the catch turns a working reply into the fallback.',
  );
});

test('a code bug can never again be mistaken for an outage', () => {
  // The catch serves the same polite fallback for a quota failure and for a
  // typo. That is what let this hide: every dashboard and every log line said
  // "degraded", so two days were spent on models and quota.
  assert.match(index, /THIS IS A CODE BUG, NOT AN OUTAGE/,
    'the catch no longer distinguishes our own errors from upstream failures — the next typo will look like an outage too');
  assert.match(index, /err instanceof ReferenceError \|\| err instanceof TypeError/,
    'the programmer-error check is gone; a ReferenceError would be logged as a generic failure again');
});

test('the fallback still runs for real outages', () => {
  // The point is to label our bugs, not to stop protecting guests. A genuine
  // brain failure must still reach the directory answer.
  assert.match(index, /lastResort\(\{/, 'the no-model fallback was removed along with the diagnosis');
});

test('every fallback lane admits it is a fallback', () => {
  // The rescue lane returned a reply with no `degraded` flag, so a cheap
  // stand-in answer looked identical to a healthy one from the outside. That
  // is what made "Kata Beach is a fave." read as a working concierge having an
  // off day. Any lane that runs only after a failure must say so, or the
  // dashboards and the alerting are measuring the wrong thing.
  const body = fetchHandler(index);
  const rescue = body.slice(body.indexOf("lane: 'rescue'"));
  const ret = rescue.slice(0, rescue.indexOf('\n', rescue.indexOf('return json(200')) + 1);
  assert.match(ret, /degraded: true/,
    'the rescue lane reports itself as healthy — a degraded answer would be invisible to every alert');
});
