// Repair — what Num does when a guest tells it it was wrong.
//
// The load-bearing tests here are the FALSE POSITIVES. A missed correction
// costs one awkward turn. A false one makes Num apologise for an answer that
// was fine — and every spent apology makes the next one work less well
// (Esterwood & Robert 2023: after three violations, no strategy fully
// restored trust). So the bar is conservative and these tests hold it there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { detectRepair, repairBlock, repairFor } from './repair.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CODE = readFileSync(join(HERE, 'repair.mjs'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

/* ── it fires ─────────────────────────────────────────────────────────── */

test('the live failure is caught, contracted or not', () => {
  // Verbatim shapes a guest would have typed on 14 Sep. The uncontracted
  // "that is a barbershop" is here because the first version of the pattern
  // only had "that's" and missed it — the one sentence this module exists
  // for. The unit test had used the apostrophe and passed; a demo caught it.
  for (const t of [
    "that's a barbershop",
    'that is a barbershop not a massage place',
    'thats a barber shop not a massage place',
    'those are all the wrong side of town',
  ]) assert.equal(detectRepair(t)?.kind, 'fact', `missed: ${t}`);
});

test('flat verdicts are corrections', () => {
  for (const t of [
    "that's not what I asked for",
    'wrong one',
    'wrong area',
    "that's wrong",
    'these are all the wrong side',
    'I asked for somewhere quiet',
  ]) assert.ok(detectRepair(t), `missed: ${t}`);
});

test('a stale fact is a correction, contracted or not', () => {
  for (const t of [
    "they're closed",
    'they are closed',
    'it is shut',
    "that place is gone",
    "that doesn't exist",
  ]) assert.ok(detectRepair(t), `missed: ${t}`);
});

test('a misunderstanding is tracked separately from a bad answer', () => {
  assert.equal(detectRepair('no I meant deep tissue')?.kind, 'understanding');
  assert.equal(detectRepair('I meant the other one')?.kind, 'understanding');
  assert.equal(detectRepair('I was asking about the Friday')?.kind, 'understanding');
});

/* ── it does NOT fire — the part that matters ─────────────────────────── */

test('an opinion about a place is not a correction', () => {
  for (const t of [
    "that's not cheap",
    "that's not really us",
    "that's not my scene",
    "that's not bad actually",
  ]) assert.equal(detectRepair(t), null, `false positive: ${t}`);
});

test('a guest quoting their own intention is not a correction', () => {
  for (const t of [
    "I said I'd think about it",
    'I meant to book it yesterday',
    'I meant to ask you earlier',
  ]) assert.equal(detectRepair(t), null, `false positive: ${t}`);
});

test('an ordinary request is never a correction', () => {
  for (const t of [
    'can you find a massage place',
    'somewhere for dinner tonight',
    'what time do they open',
    'book it please',
    'no thanks',
  ]) assert.equal(detectRepair(t), null, `false positive: ${t}`);
});

test('survives anything handed to it', () => {
  for (const junk of [null, undefined, 42, {}, [], '']) {
    assert.doesNotThrow(() => repairFor(junk));
    assert.equal(repairFor(junk), null);
  }
});

/* ── the brief ────────────────────────────────────────────────────────── */

test('the fix must arrive in the same message — the fix is the apology', () => {
  assert.match(repairBlock('fact'), /IN THIS SAME MESSAGE/);
});

test('blame-shifting is banned outright, and says why', () => {
  const b = repairBlock('fact');
  assert.match(b, /Blame anything/);
  assert.match(b, /WORSE than saying nothing/);
  // NB the brief says "lands worse", not "scores worse": the guardrail below
  // forbids ranking vocabulary in emitted text and caught the word "scores"
  // on the first run. Reworded rather than loosening the rail.
});

test('no jokes, no mechanism, no repeated apology', () => {
  const b = repairBlock('fact');
  assert.match(b, /Make a joke of it/);
  assert.match(b, /Explain how it happened/);
  assert.match(b, /Apologise more than once/);
});

test('it never hands the work back, and never silently re-guesses', () => {
  const b = repairBlock('fact');
  assert.match(b, /Ask them to rephrase/);
  assert.match(b, /as if nothing happened/);
});

test('an unclear correction gets a candidate reading, not an open question', () => {
  const b = repairBlock('understanding');
  assert.match(b, /do NOT ask an open question/);
  assert.match(b, /yes or no/);
});

test('it says back their words — the face-work is not decoration', () => {
  assert.match(repairBlock('fact'), /in their words/);
});

/* ── the guardrail, same line as every other voice module ─────────────── */

test('repair cannot reach the recommendation', () => {
  const forbidden = [
    'venue', 'restaurant', 'hotel', 'partner',
    'rank', 'score', 'boost', 'weight', 'order by',
    'price', 'cost', 'fee', 'commission', 'cheaper', 'expensive',
  ];
  for (const kind of ['fact', 'understanding']) {
    const b = repairBlock(kind).toLowerCase();
    for (const w of forbidden) {
      assert.doesNotMatch(b, new RegExp(`\\b${w}`),
        `the repair brief said "${w}" (${kind}) — it may change the words around a turn, never the answer`);
    }
  }
});

test('the module touches no database, network or storage', () => {
  for (const reach of ['env.DB', 'prepare(', 'fetch(', 'INSERT', 'SELECT']) {
    assert.doesNotMatch(CODE, new RegExp(reach.replace(/[.(]/g, '\\$&')),
      `repair.mjs must stay pure — found "${reach}"`);
  }
});

/* ── the wiring, asserted the way drawwiring.test.mjs does it ─────────── */

test('repair is wired, and outranks good news and the profiling question', () => {
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  assert.match(index, /import \{ repairFor \} from '\.\/repair\.mjs'/, 'repair.mjs has no caller');

  // Precedence is a behavioural contract, not a detail. A guest who has just
  // said "that's a barbershop" must not be congratulated, and must not be
  // asked whether they prefer buzzing or quiet.
  assert.match(index, /repairFor\(lastUser\)\s*\?\?\s*goodNewsFor\(lastUser\)/,
    'repair must be tried before good news at both call sites');
  const both = index.match(/repairFor\(lastUser\)\s*\?\?\s*goodNewsFor\(lastUser\)/g) ?? [];
  assert.equal(both.length, 2, `expected both the Claude path and the fallback chain, found ${both.length}`);

  // And it must take the earned-question slot, which is pushed last.
  assert.match(index, /const turnBlock = repairFor/);
  assert.match(index, /if \(turnBlock\) earnedBlock = turnBlock;/);
});

test('the house voice teaches the conversational grammar', () => {
  const voice = readFileSync(join(HERE, 'specialists.mjs'), 'utf8');
  // Each of these is a finding with evidence behind it; a future edit that
  // drops one should have to delete a test to do it.
  assert.match(voice, /ANSWER THE ANSWER/, 'the answer to your own question must be consumed');
  assert.match(voice, /NEVER "ANYTHING ELSE"/, '"something else" beats "anything else"');
  assert.match(voice, /A NO HAS A SHAPE/, 'refusals need structure');
  assert.match(voice, /USE THEIR WORDS FOR THINGS/, 'conceptual pacts');
  assert.match(voice, /END ON A COMMITMENT/, 'closings');
});
