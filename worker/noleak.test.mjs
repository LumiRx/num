/**
 * A guest must never read code, a stack trace, or our vendor's billing.
 *
 * 6 Sep 2026: a customer screenshotted Num answering with code. Claude and
 * Haiku were out of API credit, the chain fell through to unstructured models,
 * and those emit fenced blocks and thinking tokens as a matter of course. The
 * 9 Aug guard (leakguard.test.mjs) described one model's draft leak and did
 * not describe any of this.
 *
 * Every string below is a shape that was reachable in production today.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardReply } from './router.mjs';

const MUST_REJECT = {
  'a fenced code block': '```json\n{"reply": "Try Nahm on Sathorn"}\n```',
  'a bare fence': 'Here you go:\n```\nconst places = await fetch(url);\n```',
  'gpt-oss harmony tokens': '<|channel|>analysis<|message|>The user wants dinner. Let me think.',
  'an exposed think tag': '<think>They asked about Bangkok, I should list three</think> Try Nahm.',
  'a whole JSON blob': '{"reply":"Nahm on Sathorn","chips":null}',
  'an API error object': 'Sorry: {"error": {"type": "invalid_request_error"}}',
  'the vendor billing line': 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.',
  'a vendor request id': 'Something went wrong (request_id req_011CemHaFBPKEUY5qTtEQVny).',
  'an api key': 'Set the header to sk-ant-api03-Xy12z_abcDEF.',
  'a stack frame': 'TypeError: Cannot read properties of undefined\n    at askNum (index.mjs:812:15)',
  'our own brain wording': 'hosted HTTP 402 — insufficient balance',
  'javascript': 'You can do console.log(place.name) to see it.',
  'an arrow function': 'const pick = (p) => { return p.name; }',
};

for (const [what, text] of Object.entries(MUST_REJECT)) {
  test(`rejected: ${what}`, () => {
    assert.equal(guardReply(text).ok, false, `a guest could have been shown: ${text.slice(0, 60)}…`);
  });
}

test('real concierge answers still pass — the guard must not eat the product', () => {
  const good = [
    'Nahm on Sathorn — the tasting menu is the reason to go, and 9pm is the quiet slot. Want me to ask them?',
    'Ciccio Wine Cellar & Bistro for Italian, 70 m away. Thai Aree Food for Thai, 90 m away.',
    'Your table at Bo.lan is held for 19:30 — they have you down for four, by the window.',
    'It is 11pm in Phuket, so most kitchens have closed. Kata Beach has two that run late.',
    'I have asked them and will tell you the moment they answer (usually inside an hour).',
    'The function room upstairs seats twelve — shall I ask whether it is free on the 12th?',
    'Meet at Nobu (Bangkok) at 19:30 — I have put it in your calendar.',
    'That is £42 for two, service included. Pay there, not here.',
  ];
  for (const s of good) {
    assert.equal(guardReply(s).ok, true, `the guard rejected a perfectly good answer: "${s}"`);
  }
});

test('the guard is not optional inside the brain chain', () => {
  const src = readFileSync(new URL('./brains.mjs', import.meta.url), 'utf8');
  assert.match(src, /\(guard \?\? guardReply\)\(read\.reply\)/,
    'a caller that forgets to pass a guard would ship raw model text to a guest');
  assert.doesNotMatch(src, /guard \? guard\(read\.reply\) :/, 'the optional-guard passthrough came back');
});

test('an OpenAI-compatible failure carries its HTTP status, so quota is not filed as transient', () => {
  const src = readFileSync(new URL('./brains.mjs', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('if (!res.ok) {'), src.indexOf('if (!res.ok) {') + 400);
  assert.match(block, /err\.status = res\.status/, 'classify() reads err.status; without it 402 looks transient');
});

test('the hosted brain reads a reply the same way Workers AI does', () => {
  const src = readFileSync(new URL('./brains.mjs', import.meta.url), 'utf8');
  const at = src.indexOf('const body = await res.json();');
  const block = src.slice(at, at + 1200);
  assert.match(block, /extractText\(body\)/,
    'reading only choices[0].message.content throws away a paid-for answer from a reasoning model');
});

import { readFileSync } from 'node:fs';
