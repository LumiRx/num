// Every lane pays, and every question knows what it cost.
//
// Task #6 from the response-brain handoff, 11 Aug 2026. Two gaps made the
// ledger lie, and both flattered us:
//
//   1. PRICES held one model — Claude Opus. Every other lane logged zero
//      tokens and zero dollars, so 10-11 Aug (DeepSeek carrying 100% of
//      traffic) recorded as the CHEAPEST days of the month. They were the
//      degraded ones. An unmetered lane does not read as unknown; it reads as
//      free, and the Token Manager agent would have reported an outage as a
//      cost win.
//   2. num_usage had no link to the ask that caused it, so cost was knowable
//      per day and per lane, never per KIND of question — which is the only
//      number that can tune the router.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(HERE, f), 'utf8');

test('every model Num can call has a price', () => {
  const c = src('console.mjs');
  for (const m of ['claude-opus-5', 'claude-sonnet-5', 'deepseek-v4-flash', 'kimi-k2.6', 'glm-5.2']) {
    assert.ok(c.includes(`'${m}'`), `${m} has no price — turns on it will log as free`);
  }
  assert.match(c, /const priceFor = \(model\)/, 'per-model pricing resolver is gone; one price fits all again');
  assert.match(c, /startsWith\('@cf\/'\)/, 'Workers AI models no longer resolve — they will price at Opus rates');
  assert.match(c, /return PRICE;/, 'no fallback price — an unknown model logs as free, the exact bug this fixes');
});

test('an OpenAI-shaped usage block is read, not dropped', () => {
  // Anthropic says input_tokens; every OpenAI-compatible vendor says
  // prompt_tokens. Reading only the first is why DeepSeek days cost $0.00.
  const c = src('console.mjs');
  assert.match(c, /usage\?\.input_tokens \?\? usage\?\.prompt_tokens/, 'prompt_tokens is ignored again');
  assert.match(c, /usage\?\.output_tokens \?\? usage\?\.completion_tokens/, 'completion_tokens is ignored again');
  const b = src('brains.mjs');
  assert.match(b, /return \{ text, usage: body\?\.usage \?\? null/,
    'callProse throws the vendor usage away — nothing downstream can meter a fallback turn');
  assert.match(b, /_usage: prose\.usage/, 'ask() no longer carries usage back to the caller');
});

test('the ledger records the MODEL, not the chain slot', () => {
  // 'hosted' is a position; 'deepseek-v4-flash' is a thing with a price.
  const i = src('index.mjs');
  assert.match(i, /result\._model \?\? result\._brain/,
    'usage logs the brain slot again — priceFor() cannot resolve it and the turn prices at zero or at Opus');
});

test('cost is joined to the question that caused it', () => {
  const a = src('asks.mjs');
  assert.match(a, /return res\?\.meta\?\.last_row_id \?\? null/, 'recordAsk no longer returns the row id');
  const c = src('console.mjs');
  assert.match(c, /ALTER TABLE num_usage ADD COLUMN ask_id INTEGER/, 'the ask_id column migration is gone');
  assert.match(c, /askId = null/, 'logUsage no longer accepts an askId');
  const i = src('index.mjs');
  assert.match(i, /\.then\(\(askId\) =>\s*\n\s*logUsage\(env, \{/,
    'the ask is no longer recorded before the cost — the two facts cannot be joined');
});

test('one ask makes one row', () => {
  // The refactor moved recordAsk earlier; the later duplicate call for the
  // same turn had to go, or every model-answered turn logs itself twice and
  // every count in the Asks view doubles.
  const i = src('index.mjs');
  assert.ok(!/brain: _brain \?\? null/.test(i),
    'the duplicate recordAsk for the big lane is back — asks will double-count');
});
