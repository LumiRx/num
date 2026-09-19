// One answer, up to three bubbles (lib/replyparts.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('./') && !/\.(mjs|js|ts)$/.test(spec)) return next(spec + '.ts', ctx);
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url.endsWith('.ts')) {
      const src = readFileSync(new URL(url), 'utf8');
      return { format: 'module', shortCircuit: true, source: transformSync(src, { loader: 'ts', format: 'esm' }).code };
    }
    return next(url, ctx);
  },
});

const { splitReply, paragraphs, isTail, MAX_PARTS } = await import('./replyparts.ts');
const PICKS = [{ id: 'a', name: 'A', link: 'https://a' }, { id: 'b', name: 'B', link: 'https://b' }];

test('a plain answer with no question stays one bubble', () => {
  const out = splitReply('Ramiro first, then Pensão Amor — a four-minute walk.', null);
  assert.equal(out.length, 1);
  assert.equal(out[0].part, undefined);
});

test('answer + picks + question → three bubbles, in that order, chips-ready on the last', () => {
  const out = splitReply('Three that fit what you said — seafood, late, near you.\n\nRamiro is the one I would book.\n\nWant me to hold a table at Ramiro for eight?', PICKS);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((m) => m.part), ['lead', 'picks', 'tail']);
  assert.equal(out[1].picks.length, 2);
  assert.match(out[2].text, /^Want me to hold/);
  assert.ok(!out[0].text.includes('Want me'), 'the question is not repeated in the lead');
});

test('a one-line lead carries the grid itself — no bubble holding only "Three that fit:"', () => {
  const out = splitReply('Three that fit:\n\nWhich one?', PICKS);
  assert.equal(out.length, 2);
  assert.equal(out[0].picks.length, 2);
  assert.equal(out[1].part, 'tail');
});

test('the last paragraph is a tail only when it asks or hands over; a statement stays in the lead', () => {
  assert.equal(isTail('Which sounds right?'), true);
  assert.equal(isTail('Say the word and I hold it.'), true);
  assert.equal(isTail('It closes at midnight.'), false);
  const out = splitReply('First line.\n\nIt closes at midnight.', null);
  assert.equal(out.length, 1);
});

test('a single-paragraph question is never split into nothing + a question', () => {
  const out = splitReply('Where are you staying?', null);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Where are you staying?');
});

test('never more than three, never a word lost', () => {
  const text = 'One.\n\nTwo.\n\nThree.\n\nFour?';
  const out = splitReply(text, PICKS);
  assert.ok(out.length <= MAX_PARTS);
  const joined = out.map((m) => m.text).join('\n\n');
  for (const w of ['One.', 'Two.', 'Three.', 'Four?']) assert.ok(joined.includes(w), w);
  assert.equal(paragraphs(text).length, 4);
});

test('the card and the turn ride on the first bubble; extra fields are kept', () => {
  const out = splitReply('Held.\n\nAnything else?', null, { card: { title: 'Ramiro', meta: '20:00', tag: 'hold' }, turn: { lane: 'x' } });
  assert.equal(out.length, 2);
  assert.equal(out[0].card.title, 'Ramiro');
  assert.equal(out[1].turn.lane, 'x');
});
