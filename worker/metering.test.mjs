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
  //
  // Widened 30 Aug: both Anthropic brains now carry `_model` from the
  // directive, so `_model` leads and the brain slot is only ever the last
  // resort. A Haiku turn must price as Haiku — inheriting Opus's rate would
  // overstate the bill by 5x and hide the saving the bulk lane exists for.
  const i = src('index.mjs');
  assert.match(i, /model: result\._model\s*\n?\s*\?\?/,
    'usage logs the brain slot again — priceFor() cannot resolve it and the turn prices at zero or at Opus');
  const b = src('brains.mjs');
  assert.match(b, /_model: structuredModel/,
    'the structured brains no longer report which model answered — every Haiku turn would price as Opus');
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

test('a vendor-prefixed model is priced as itself, not as Opus', async () => {
  // Bionic echoes the model back namespaced: 'deepseek/deepseek-v4-flash'.
  // The price table is keyed on the bare name, so exact-match alone fell
  // through to the Opus default and priced the first live DeepSeek turn at
  // $0.026 instead of $0.0007 — a 37× overstatement on the single number the
  // whole router is judged by. It made a working router look like it had
  // saved nothing.
  const src = readFileSync(join(HERE, 'console.mjs'), 'utf8');
  assert.match(src, /const bare = String\(model\)\.split\('\/'\)\.pop\(\);/,
    'the namespace strip is gone — prefixed models price at the Opus rate again');
  assert.match(src, /if \(PRICES\[bare\]\) return PRICES\[bare\];/);
  // And a genuinely unknown model must still cost the MOST, never the least:
  // an under-count hides real spend, which is the worse direction to be wrong.
  assert.match(src, /no price for model .* charging at the default rate/,
    'an unpriced model is now silent — spend on a new vendor would vanish from the ledger');
});

// ── THE BULK LANE HAD NO PRICE ───────────────────────────────────────────
//
// Found 3 Sep 2026 while pulling the numbers for a full report: 13 Haiku
// calls averaged $0.056 against Opus's $0.061, because the price table had no
// Haiku row and the resolver falls back to Opus on an unknown model. The
// router exists to make the everyday question cost a fifth of the expensive
// one, and the one ledger that judges it was reporting that it costs the same.
test('the bulk lane has a price of its own', () => {
  const c = readFileSync(new URL('./console.mjs', import.meta.url), 'utf8');
  const table = c.slice(c.indexOf('const PRICES = {'), c.indexOf('const PRICE ='));
  assert.match(table, /'claude-haiku-4-5-20251001':/,
    'the dated model id the API echoes back has no price and falls through to Opus');
  assert.match(table, /'claude-haiku-4-5':/, 'the bare name has no price');
  // Cheaper than Opus in every column, or the row is not doing its job.
  const haiku = /'claude-haiku-4-5':\s*\{ in: ([\d.]+), out: ([\d.]+), cacheWrite: ([\d.]+), cacheRead: ([\d.]+) \}/.exec(table);
  const opus = /'claude-opus-5':\s*\{ in: ([\d.]+),\s*out: ([\d.]+),\s*cacheWrite: ([\d.]+), cacheRead: ([\d.]+) \}/.exec(table);
  assert.ok(haiku && opus, 'the price rows changed shape');
  for (let i = 1; i <= 4; i++) {
    assert.ok(Number(haiku[i]) < Number(opus[i]), `haiku column ${i} is not cheaper than opus`);
  }
});
