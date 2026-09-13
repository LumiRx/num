// Register mirroring — matching how Num writes to how the guest writes.
//
// Two of these tests are guardrails rather than unit tests, and they are the
// reason the file exists in this shape:
//
//   1. The module may not contain venue, ranking, price or ordering
//      vocabulary. A voice layer that can reach the recommendation is not a
//      voice layer, it is a personalised sales engine, and the difference is
//      the whole reason NUM can say it cannot be bought.
//   2. The block may not raise the length cap, and may not tell the guest it
//      exists. Style matching works below awareness; narrating it inverts it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readRegister, registerBlock, registerFor, wordsIn, CONFIDENT_AT, BRISK_AT } from './register.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = readFileSync(join(HERE, 'register.mjs'), 'utf8');
// The code with its prose removed, so the file can SAY "never changes which
// place is recommended" without that sentence failing the test enforcing it —
// the same trap aftertable.test.mjs and unicode.test.mjs step around.
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

const said = (...texts) => texts.map((content) => ({ role: 'user', content }));

/* ── the confidence floor ─────────────────────────────────────────────── */

test('says nothing below three messages — one mention is a mood', () => {
  assert.equal(CONFIDENT_AT, 3);
  assert.equal(readRegister(said('hey')), null);
  assert.equal(readRegister(said('hey', 'food?')), null);
  assert.equal(registerFor(said('hey', 'food?')), null);
});

test('ignores Num\'s own messages when reading the guest', () => {
  const mixed = [
    { role: 'user', content: 'hey' },
    { role: 'assistant', content: 'Absolutely delighted to help you with that, here is a long warm reply full of words and detail.' },
    { role: 'user', content: 'food?' },
    { role: 'assistant', content: 'Another long assistant message that would swamp the median if it were counted.' },
    { role: 'user', content: 'where' },
  ];
  assert.equal(readRegister(mixed).length, 'terse');
});

/* ── length ───────────────────────────────────────────────────────────── */

test('reads a terse guest as terse', () => {
  const r = readRegister(said('food?', 'where', 'cheap one', 'tonight'));
  assert.equal(r.length, 'terse');
});

test('reads an expansive guest as expansive', () => {
  const long = 'We are landing about six in the evening with the kids and my parents in tow, and I would love somewhere that is genuinely relaxed rather than stuffy, ideally near the water if that is at all possible';
  const r = readRegister(said(long, long, long));
  assert.equal(r.length, 'expansive');
});

test('a guest in the middle gets no length instruction at all', () => {
  const mid = 'looking for somewhere good for dinner tonight around eight';
  const r = readRegister(said(mid, mid, mid));
  assert.equal(r?.length ?? null, null);
});

/* ── the bug that would have shipped ──────────────────────────────────── */

test('Thai is not read as terse — whitespace does not delimit Thai words', () => {
  // A real sentence with no spaces in it. Split on whitespace it is ONE word,
  // which would have made every Thai guest maximally terse for ever — in a
  // live market.
  const thai = 'ผมกำลังมองหาร้านอาหารดีๆแถวนี้สำหรับมื้อเย็นคืนนี้กับครอบครัว';
  assert.ok(wordsIn(thai) > 10, `expected a real word count, got ${wordsIn(thai)}`);
  const r = readRegister(said(thai, thai, thai));
  assert.notEqual(r?.length, 'terse');
});

test('Japanese is counted the same way', () => {
  const ja = '今夜の家族での夕食にちょうどいいレストランを探しているところです';
  assert.ok(wordsIn(ja) > 5);
});

test('English word counting is still plain', () => {
  assert.equal(wordsIn('three little words'), 3);
  assert.equal(wordsIn('   '), 0);
  assert.equal(wordsIn(null), 0);
});

/* ── emoji ────────────────────────────────────────────────────────────── */

test('matches an emoji user, including ZWJ and skin tones', () => {
  const r = readRegister(said('hey 👋🏽', 'dinner? 🍜', 'yesss 👨‍👩‍👧'));
  assert.equal(r.emoji, 'yes');
});

test('one emoji in a long run is punctuation, not a style', () => {
  const r = readRegister(said('food', 'where', 'when', 'ok', 'cheers', 'sure', 'yes', 'ta 👍'));
  assert.notEqual(r?.emoji, 'yes');
});

test('four clean messages with no emoji turns emoji off', () => {
  const r = readRegister(said('food', 'where', 'when', 'ok'));
  assert.equal(r.emoji, 'no');
});

/* ── warmth ───────────────────────────────────────────────────────────── */

test('reads a warm guest as warm', () => {
  const r = readRegister(said('Hi there!', 'Thanks so much', 'That looks perfect, appreciate it'));
  assert.equal(r.warmth, 'warm');
});

test('reads an instruction-giver as brisk', () => {
  // Five, not four: warmth is only dropped on the stronger evidence floor.
  const r = readRegister(said('table for 4', 'move it to 9', 'cancel that', 'book the other one', 'earlier'));
  assert.equal(r.warmth, 'brisk');
});

/* ── the block ────────────────────────────────────────────────────────── */

test('the block never raises the length cap', () => {
  const long = 'We are landing about six in the evening with the kids and my parents in tow, and I would love somewhere that is genuinely relaxed rather than stuffy, ideally near the water if that is at all possible';
  const block = registerFor(said(long, long, long));
  assert.ok(block, 'an expansive guest should produce a block');
  assert.match(block, /cap, which does not move|inside the length cap/i);
  // Nothing may invite a longer reply.
  assert.doesNotMatch(block, /\b(longer|more words|as long as|no limit|ignore the cap|expand)\b/i);
});

test('the block never tells the guest it exists', () => {
  const block = registerFor(said('hey there!', 'thanks so much', 'perfect, appreciate it'));
  assert.match(block, /never mention it/i);
  assert.doesNotMatch(block, /\b(I noticed|you seem to|because you write|your style is|we detected)\b/i);
});

test('no reading means no block, and today\'s behaviour is unchanged', () => {
  assert.equal(registerBlock(null), null);
  const mid = 'looking for somewhere good for dinner tonight around eight';
  assert.equal(registerFor(said(mid, mid, mid)), null);
});

/* ── it can never be the reason a guest gets no answer ────────────────── */

test('survives anything handed to it', () => {
  for (const junk of [null, undefined, 'not an array', 42, {}, [null], [{ role: 'user' }], [{ role: 'user', content: 123 }]]) {
    assert.doesNotThrow(() => registerFor(junk), `threw on ${JSON.stringify(junk)}`);
  }
});

/* ── THE GUARDRAIL ────────────────────────────────────────────────────── */

test('the voice layer cannot reach the recommendation', () => {
  // Same query, any register, must return the same venues in the same order.
  // The cheapest way to guarantee that is for this module to have no
  // vocabulary for venues, ranking, money or ordering at all. If a future
  // change needs one of these words, it is no longer a voice layer and this
  // test is the conversation about that.
  const forbidden = [
    'venue', 'place', 'partner', 'restaurant', 'hotel', 'bar',
    // NB 'sort' is deliberately absent: Array.prototype.sort computes the
    // median here and is not ranking anything. The words below are the ones
    // that could only appear if this module had grown an opinion about which
    // venue wins.
    'rank', 'score', 'order by', 'weight', 'boost',
    'price', 'cost', 'fee', 'commission', 'rate', 'cheap', 'expensive',
    'pick', 'recommend', 'suggest',
  ];
  for (const word of forbidden) {
    assert.doesNotMatch(
      CODE.toLowerCase(),
      new RegExp(`\\b${word}`),
      `register.mjs must not contain "${word}" — the voice layer may change the words around an answer, never the answer`,
    );
  }
});

test('the module touches no database, network or storage', () => {
  for (const reach of ['env.DB', 'prepare(', 'fetch(', 'KV', 'R2', 'D1', 'INSERT', 'SELECT']) {
    assert.doesNotMatch(CODE, new RegExp(reach.replace(/[.(]/g, '\\$&')),
      `register.mjs must stay pure — found "${reach}"`);
  }
});

/* ── added after looking at real output ───────────────────────────────── */

test('warmth is not dropped on thin evidence — being wrongly cold costs more', () => {
  // Four short lowercase messages is how most people type on a phone. It is
  // not yet grounds for stripping the greeting.
  const four = readRegister(said('dinner tonight', 'somewhere cheap', 'for two', 'around eight'));
  assert.equal(four.length, 'terse', 'length should still match');
  assert.notEqual(four.warmth, 'brisk', 'four messages is not enough to go cold');

  const enough = readRegister(said('dinner tonight', 'somewhere cheap', 'for two', 'around eight', 'book it'));
  assert.equal(enough.warmth, 'brisk');
  assert.equal(BRISK_AT, 5);
});

test('Thai politeness particles read as warmth', () => {
  const r = readRegister(said(
    'มีร้านอาหารแนะนำไหมครับ',
    'ขอบคุณมากครับ',
    'ดีเลยครับ ขอที่เงียบๆ หน่อยได้ไหมครับ',
  ));
  assert.equal(r?.warmth, 'warm', 'ครับ and ขอบคุณ are the clearest warmth signal Thai has');
});

test('Japanese thanks and greetings read as warmth', () => {
  const r = readRegister(said('こんにちは', 'ありがとうございます', 'よろしくお願いします'));
  assert.equal(r?.warmth, 'warm');
});
