// Which Claude answers.
//
// Opus ran on every big-lane turn, including "what time do shops open". The
// saving from routing that to a mid model is large; the risk is that a
// misrouted turn gives a worse answer to somebody who cared. So every test
// here is about the direction the classifier fails in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickModel } from './router.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STRONG = 'claude-opus-5';
const EASY = 'claude-sonnet-5';

test('anything touching money or a commitment gets the best model', () => {
  // The turns where being wrong costs a guest real money or a real evening.
  for (const q of [
    'book a table for tonight',
    'how much does the airport transfer cost',
    'cancel my reservation',
    'can i get a refund',
  ]) {
    assert.equal(pickModel(q, {}, {}), STRONG, `"${q}" was routed to the cheaper model`);
  }
});

test('planning, comparing and judging stay on the best model', () => {
  // The things a frontier model is genuinely better at, which is the whole
  // reason for paying for one.
  for (const q of [
    'plan our day tomorrow',
    'kata or karon, which is better',
    'should i rent a scooter or get taxis',
    'whats worth it in phuket',
  ]) {
    assert.equal(pickModel(q, {}, {}), STRONG, `"${q}" was routed down — the answer would get thinner`);
  }
});

test('a guest in trouble always gets the best we have', () => {
  for (const q of ['my driver is late', 'the booking is wrong', 'help me im lost']) {
    assert.equal(pickModel(q, {}, {}), STRONG, `"${q}" was economised on — never acceptable`);
  }
});

test('a live trip is never economised on', () => {
  // Mid-trip there is real context to get wrong, even for a trivial-looking ask.
  assert.equal(pickModel('what time is it', { bookings: [{ id: 'b1' }] }, {}), STRONG);
  assert.equal(pickModel('what time is it', { party: { id: 'p1' } }, {}), STRONG);
});

test('a short single-fact lookup may use the mid model', () => {
  // If nothing routes down, the change saves nothing at all.
  for (const q of ['what time do shops open', 'where is the old town', 'how far is the airport']) {
    assert.equal(pickModel(q, {}, {}), EASY, `"${q}" still pays frontier prices for a one-line fact`);
  }
});

test('silence, noise and long asks escalate', () => {
  // Ambiguity is not evidence of simplicity.
  assert.equal(pickModel('', {}, {}), STRONG, 'an empty ask went to the cheap model');
  assert.equal(pickModel('asdkjhasd', {}, {}), STRONG, 'unrecognised input went to the cheap model');
  assert.equal(pickModel('x'.repeat(200), {}, {}), STRONG, 'a long ask went to the cheap model');
});

test('NUM_MODEL still overrides everything', () => {
  // The 2am kill switch. One secret puts the whole product back on one model
  // when a routing change is the suspect.
  assert.equal(pickModel('what time do shops open', {}, { NUM_MODEL: 'claude-opus-5' }), 'claude-opus-5');
  assert.equal(pickModel('book a car', {}, { NUM_MODEL: 'claude-sonnet-5' }), 'claude-sonnet-5');
});

test('routing is actually used by the request path', () => {
  // A classifier nobody calls is a file, not a saving.
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  assert.match(index, /pickModel\(/, 'the model is still chosen by a constant — every turn pays Opus prices');
});

test('an ask that LOOKS simple but touches money still gets the best model', () => {
  // The only test in this file that can actually fail. Everything else falls
  // through to `strong` by default, so deleting the money guard entirely left
  // them all green — a guard the fallback already satisfies guards nothing.
  //
  // These match SIMPLE_LOOKUP (short, starts with a question word) AND involve
  // money or a commitment. They are the exact turns a naive classifier
  // economises on, and the exact turns where that is least acceptable.
  for (const q of [
    'what does a car to the airport cost',
    'where can i book a table',
    'when should i cancel',
    'how long is the refund',
  ]) {
    assert.equal(pickModel(q, {}, {}), STRONG,
      `"${q}" looked like a lookup and got the cheap model — it is about money`);
  }
});
