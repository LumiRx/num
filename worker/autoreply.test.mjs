// The turns that must cost nothing, and the ones that must never be stolen.
//
// The second half matters more than the first. A gate that saves a cent by
// answering "yes" with "Any time." while NUM was asking "shall I book it?"
// has not saved anything — it has dropped a booking and told the guest their
// answer was noise. So most of what is below is about when this file must
// KEEP ITS HANDS OFF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoReply, isFragment } from './autoreply.mjs';

/* ── the four measured repeats ─────────────────────────────────────────── */

test('a bare acknowledgement after a statement costs no model call', () => {
  for (const word of ['ok', 'okay', 'yes', 'thanks', 'got it', 'cool', 'perfect', 'no']) {
    const out = autoReply({ text: word, prevAssistant: 'Booked — 8pm, table for two.' });
    assert.ok(out, `"${word}" still pays for a brain`);
    assert.equal(out.kind, 'ack');
  }
});

test('a four-letter typo is answered honestly rather than guessed at', () => {
  // "cate" — eight times over three days, three destinations, eight full
  // system blocks. Whatever a model makes of it is invention.
  const out = autoReply({ text: 'cate' });
  assert.equal(out?.kind, 'fragment');
  assert.match(out.reply, /more words/i);
});

test('a clean trip check is read back from the arithmetic the app already did', () => {
  const out = autoReply({
    text: 'run a trip check and tell me what needs me.',
    state: { tripCheck: ['No clashes, no expiring holds, no empty days — the trip is clean.'] },
  });
  assert.equal(out?.kind, 'tripcheck');
  assert.match(out.reply, /the trip is clean/);
});

/* ── what it must never touch ──────────────────────────────────────────── */

test('"yes" to a QUESTION goes to the brain', () => {
  for (const prev of ['Shall I book it?', 'Want me to hold the 8pm?', 'Two of you, or three?']) {
    assert.equal(autoReply({ text: 'yes', prevAssistant: prev }), null,
      'an answer to a question was swallowed by the acknowledgement path');
  }
});

test('a trip check that found something needs a person', () => {
  for (const line of [
    'CLASH: Nahm at 19:00 overlaps Bo.lan at 19:30 on 9/21.',
    'TIGHT: only 15 min between A and B on 9/21.',
    'HOLD EXPIRES: Nahm — confirm by Friday.',
    'EMPTY DAYS: 2 day(s) have nothing on them.',
    'MULTI-CITY: 2 cities on this trip.',
    'TRANSFER: Patong → Kata with 20 min — check it is walkable.',
  ]) {
    assert.equal(autoReply({ text: 'run a trip check and tell me what needs me.', state: { tripCheck: [line] } }), null,
      `"${line}" was answered without judgement`);
  }
});

test('a trip check with no arithmetic attached is not answered from nothing', () => {
  assert.equal(autoReply({ text: 'run a trip check and tell me what needs me.', state: {} }), null);
  assert.equal(autoReply({ text: 'run a trip check and tell me what needs me.', state: { tripCheck: [] } }), null);
});

test('short words that are real questions still reach a model', () => {
  for (const word of ['bar', 'spa', 'cafe', 'food', 'taxi', 'visa', 'atm', 'gym']) {
    assert.equal(isFragment(word), false, `"${word}" was thrown away as a typo`);
    assert.equal(autoReply({ text: word }), null);
  }
});

test('a real sentence is never handled here', () => {
  for (const q of [
    'where should we eat tonight',
    'ok so what about the flight',
    'yes please book the 8pm table',
    'is it open',
  ]) {
    assert.equal(autoReply({ text: q, prevAssistant: 'Here are three.' }), null, `"${q}" was answered without a model`);
  }
});

/* ── the language rule ─────────────────────────────────────────────────── */

test('the English replies are not sent to somebody reading another language', () => {
  for (const lang of ['th', 'th-TH', 'fr', 'ja-JP', 'es-419']) {
    assert.equal(autoReply({ text: 'ok', prevAssistant: 'Booked.', lang }), null,
      `an English canned reply went to a ${lang} reader`);
    assert.equal(autoReply({ text: 'cate', lang }), null);
  }
});

test('the trip-check path IS allowed in any language, because the words are the app’s', () => {
  // Every line came from src/lib/prefs.ts already translated; this file only
  // decides whether any of them needs a person.
  const out = autoReply({
    text: 'run a trip check and tell me what needs me.',
    state: { tripCheck: ['ยังไม่มีอะไรจองเลย — แผนยังว่างอยู่'] },
    lang: 'th',
  });
  assert.equal(out?.kind, 'tripcheck');
});

/* ── it is actually wired up ───────────────────────────────────────────── */

test('index.mjs calls it, and before it pays for anything', () => {
  // Block comments are stripped only where one STARTS A LINE. A naive
  // /\*[\s\S]*?\*\// also matches the `/*` inside a regex literal — index.mjs
  // has several — and then eats every import above it, which is exactly how
  // this test first failed against a file that was correctly wired.
  const src = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
  assert.match(src, /import \{ autoReply \} from '\.\/autoreply\.mjs'/);
  const call = src.indexOf('autoReply({');
  const known = src.indexOf('knownAnswer({');
  const model = src.indexOf('const lane = pickLane(');
  assert.ok(call > 0, 'autoReply is imported and never called');
  assert.ok(call < known && call < model, 'the free path runs after a paid one');
  assert.match(src, /lane: `auto:\$\{auto\.kind\}`/, 'the free answers are not counted in the ask log');
});
