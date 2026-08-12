// Response quality control — the checks, and the promise they must not break.
//
// Every hard check below is a bug that reached a paying guest. The most
// important test in this file is the last one: grading must never be able to
// produce silence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect, figuresIn } from './quality.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTEXT = 'VERIFIED\nKrua Thai — Kata Road — 4.6 (312 reviews) — mains from THB 180\nBaan Rim Pa — Patong — 4.4 (890 reviews)\nA long block of verified grounding so the deflection check has something to argue with. '.padEnd(500, '.');

test('an invented price is caught; a quoted one is not', () => {
  const invented = inspect({
    ask: 'how much is a taxi to the airport',
    reply: 'A car to the airport runs about THB 2,800.',
    context: CONTEXT,
  });
  assert.ok(invented.hard, 'the 2,800 baht incident would ship again');
  assert.ok(invented.flags.some((f) => f.startsWith('invented-money')));

  const quoted = inspect({
    ask: 'where can I eat near Kata',
    reply: 'Krua Thai on Kata Road — mains from THB 180. Solid and close.',
    context: CONTEXT,
  });
  assert.ok(!quoted.flags.some((f) => f.startsWith('invented-')),
    'a price copied verbatim from the verified block was flagged — the check would retry correct answers');
});

test('separators do not make a real number look invented', () => {
  // The model writes "THB 1,200"; the row says "1200". Same number.
  const r = inspect({ ask: 'cost?', reply: 'About THB 1,200.', context: 'transfer 1200 baht fixed' });
  assert.ok(!r.hard, 'comma formatting alone triggered a retry');
});

test('a number the guest supplied is theirs to have repeated', () => {
  const r = inspect({
    ask: 'anywhere good for dinner under 800 baht',
    reply: 'Krua Thai fits under THB 800 comfortably.',
    context: CONTEXT,
  });
  assert.ok(!r.hard, 'echoing the guest’s own budget counted as invention');
});

test('ratings are held to the same rule as prices', () => {
  assert.ok(inspect({ ask: 'is it good', reply: 'It is rated 4.9 — excellent.', context: CONTEXT }).hard,
    'a rating no row holds passed');
  assert.ok(!inspect({ ask: 'is it good', reply: 'Yes — 4.6 from 312 reviews.', context: CONTEXT }).hard,
    'the real rating was rejected');
});

test('distances and times are NOT hard-flagged', () => {
  // Deliberate: these are restated and computed constantly, and a false
  // positive costs a guest a real retry on a correct answer.
  const r = inspect({ ask: 'how far is karon', reply: 'Karon is about 10 minutes up the coast, roughly 4 km.', context: CONTEXT });
  assert.ok(!r.hard, 'a distance triggered a corrective retry — this check must stay narrow');
});

test('deflection with a full context block is caught', () => {
  const r = inspect({ ask: 'where should I eat in Kata', reply: "I don't have that information right now.", context: CONTEXT });
  assert.ok(r.hard && r.flags.includes('deflected-with-context'));
  // But an honest gap with nothing to work from is not a failure.
  assert.ok(!inspect({ ask: 'where should I eat in Ulaanbaatar', reply: "I don't have anything verified there yet.", context: '' }).hard,
    'honesty about an empty directory was punished');
});

test('a reply that is only a question is caught', () => {
  assert.ok(inspect({ ask: 'book me dinner tonight', reply: 'What time were you thinking?', context: CONTEXT }).hard);
  assert.ok(!inspect({ ask: 'book me dinner tonight', reply: 'Krua Thai has space tonight. What time?', context: CONTEXT }).hard,
    'answer-then-one-question is the house style and must pass');
});

test('a thin recommendation is soft, never a retry', () => {
  const r = inspect({ ask: 'where should I get breakfast', reply: 'Krua Thai — good coffee, opens at seven.', context: CONTEXT });
  assert.ok(r.flags.includes('thin-recommendation'));
  assert.ok(!r.hard,
    'retrying a thin recommendation pushes the model to invent a third place — exactly the failure the three-option rule must not cause');
});

test('a yes/no question with no verdict is flagged', () => {
  assert.ok(inspect({ ask: 'is Kata beach walkable from here', reply: 'Kata beach is popular in the afternoon.', context: CONTEXT })
    .flags.includes('no-verdict'));
  assert.ok(!inspect({ ask: 'is Kata beach walkable from here', reply: 'Yes — about eight minutes down the hill.', context: CONTEXT })
    .flags.includes('no-verdict'));
});

test('figuresIn reads the shapes guests actually see', () => {
  const kinds = figuresIn('THB 1,200 or $45, rated 4.6 stars').map((f) => `${f.kind}:${f.n}`);
  assert.deepEqual(kinds, ['money:1200', 'money:45', 'rating:46']);
});

test('grading can never produce silence', () => {
  // The contract, in code: inspect() has no path that returns a reply, so it
  // cannot withhold one. And the caller keeps the original whenever the retry
  // is not strictly better.
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  assert.match(index, /if \(!after\.hard\) \{\s*\n\s*result = \{ \.\.\.fixed/,
    'the retry is taken unconditionally — a worse retry would replace a good answer');
  assert.match(index, /flags: \[\.\.\.quality\.flags, 'retry-error'\]/,
    'a thrown retry is no longer caught — a failed grade would cost the guest the reply they already had');
  const quality = readFileSync(join(HERE, 'quality.mjs'), 'utf8');
  assert.ok(!/return\s+FALLBACK|reply:/.test(quality),
    'quality.mjs now returns a reply — it grades, it must not answer');
});

test('the ask row carries the flags', () => {
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  assert.match(index, /quality: quality\.flags/,
    'flags are computed and thrown away — the whole point is being able to see quality per question');
  // And the check must run BEFORE the row is written, or it records the
  // grade of a reply that was then replaced.
  assert.ok(index.indexOf('let quality = inspect(') < index.indexOf('quality: quality.flags'),
    'the ask is recorded before the reply is graded');
});
