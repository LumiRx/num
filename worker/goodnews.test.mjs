// Good news — the one turn Num must not answer efficiently.
//
// The load-bearing test in this file is the false-positive suite. A missed
// good-news turn costs a warm moment. A FALSE one answers "can you book
// somewhere amazing" with "tell me everything!", which is the behaviour that
// makes people say an app is trying too hard — so the bar is set to be
// conservative and these tests hold it there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isGoodNews, goodNewsBlock, goodNewsFor } from './goodnews.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = readFileSync(join(HERE, 'goodnews.mjs'), 'utf8');
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

/* ── it fires ─────────────────────────────────────────────────────────── */

test('reports of a good evening are good news', () => {
  for (const t of [
    'that place was incredible, thank you',
    'dinner last night was perfect',
    'we went and it was absolutely brilliant',
    'best meal we have had in years',
    'thanks for that, it turned out amazing',
    'we loved it, the room was unreal',
  ]) assert.equal(isGoodNews(t), true, `missed: ${t}`);
});

test('life news counts with no evaluation word at all', () => {
  for (const t of [
    'I got the job!!',
    'she said yes',
    'we got engaged last night',
    'I passed my exams',
  ]) assert.equal(isGoodNews(t), true, `missed: ${t}`);
});

/* ── it does not fire — the part that matters ─────────────────────────── */

test('a request is never good news, however warm the words', () => {
  for (const t of [
    'can you find somewhere amazing for tonight',
    'we want somewhere really special for our anniversary',
    'looking for the best meal in town',
    'is there anywhere incredible nearby',
    'book somewhere perfect for six',
    'I need somewhere wonderful, last night was a disaster',
    'any update on the amazing place you mentioned',
    'how much was that incredible place',
  ]) assert.equal(isGoodNews(t), false, `false positive: ${t}`);
});

test('a plain past-tense report with no delight is not good news', () => {
  for (const t of [
    'we went last night',
    'that was yesterday',
    'we had the table at eight',
  ]) assert.equal(isGoodNews(t), false, `false positive: ${t}`);
});

test('bad news is never good news', () => {
  for (const t of [
    'last night was a disaster',
    'the table was gone when we arrived',
    'it was fine I suppose',
  ]) assert.equal(isGoodNews(t), false, `false positive: ${t}`);
});

test('survives anything handed to it', () => {
  for (const junk of [null, undefined, 42, {}, [], '']) {
    assert.doesNotThrow(() => goodNewsFor(junk));
    assert.equal(goodNewsFor(junk), null);
  }
});

/* ── the brief itself ─────────────────────────────────────────────────── */

test('the block bans the sales pivot outright', () => {
  const b = goodNewsBlock();
  assert.match(b, /Pivot to more business/);
  assert.match(b, /no upsell/i);
});

test('the block bans the bare acknowledgement, which is the real failure', () => {
  assert.match(goodNewsBlock(), /glad it went well/);
});

test('the block bans taking credit — it was their evening', () => {
  assert.match(goodNewsBlock(), /Take any credit/);
});

test('it does NOT lift the length cap — the fallback chain could not honour it', () => {
  // proseSystem places style before the hard cap, and the fallback chain has
  // no slot after it. An instruction that only works on one brain is worse
  // than none. The research agrees: the failure is closing the subject, not
  // being short.
  const b = goodNewsBlock();
  assert.doesNotMatch(b, /cap is lifted|ignore the cap|as long as you like|no limit/i);
  assert.match(b, /END ON THEIR STORY/);
});

/* ── the guardrail, same line as the register layer ───────────────────── */

test('good news cannot reach the recommendation', () => {
  const forbidden = [
    'venue', 'restaurant', 'hotel', 'partner',
    'rank', 'score', 'boost', 'weight', 'order by',
    'price', 'cost', 'fee', 'commission', 'cheaper', 'expensive',
  ];
  const b = goodNewsBlock().toLowerCase();
  for (const w of forbidden) {
    assert.doesNotMatch(b, new RegExp(`\\b${w}`),
      `the good-news brief said "${w}" — it may change the words around a turn, never the answer`);
  }
});

test('the module touches no database, network or storage', () => {
  for (const reach of ['env.DB', 'prepare(', 'fetch(', 'INSERT', 'SELECT']) {
    assert.doesNotMatch(CODE, new RegExp(reach.replace(/[.(]/g, '\\$&')),
      `goodnews.mjs must stay pure — found "${reach}"`);
  }
});
