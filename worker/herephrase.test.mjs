// Where they ARE is not where they are GOING.
//
// 9 Aug 2026, found by asking the live app for flights: a guest typed
// "we are in kata — flights to bangkok on friday?" and Num resolved them TO
// BANGKOK. `destNamedIn` scanned the whole sentence for any covered city and
// found exactly one — the destination — so the place they were standing in
// never reached the model. Num then asked which airport "Kata" meant and
// offered Katowice, Poland.
//
// Three prompt patches had already tried to fix the symptom. None could: the
// model was answering correctly given a context block that said Bangkok.
//
// The distinction is grammatical, so it belongs in code, not in a prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { herePhrase, statedPlace } from '../ai/places.js';

test('a here-phrase is found and carries only the place they are IN', () => {
  for (const [text, want] of [
    ['we are in kata — flights to bangkok on friday?', 'kata'],
    ["i'm in phuket, what's good in bangkok next week?", 'phuket'],
    ['we are staying in patong — where to eat?', 'patong'],
    ['here in kata, sunset spot?', 'kata'],
  ]) {
    const here = herePhrase(text);
    assert.ok(here, `no here-phrase found in "${text}" — the destination will win again`);
    assert.match(here.toLowerCase(), new RegExp(want), `the here-phrase lost the actual place in "${text}"`);
    assert.doesNotMatch(here.toLowerCase(), /bangkok/,
      `the here-phrase swallowed the DESTINATION in "${text}" — this is the Kata → Bangkok bug exactly`);
  }
});

test('planning language is NOT a here-phrase', () => {
  // The same bug pointed the other way would be worse: a guest planning a trip
  // is not standing in the place they are asking about. "Delmar" taught us
  // that once already.
  for (const text of [
    'flights to bangkok on friday?',
    'heading to bangkok tomorrow',
    'best beach in phuket',
    "let's plan the horse races this weekend in delmar",
    'thinking about tokyo in march',
  ]) {
    assert.equal(herePhrase(text), null,
      `"${text}" was read as the guest's current location — planning is not standing`);
  }
});

test('statedPlace reads the here-clause, not the whole sentence', () => {
  // The clause is what gets handed to statedPlace now. On the full sentence it
  // still finds "kata" first, but that was luck of word order — on
  // "flights to bangkok, we are in kata" it would have found bangkok.
  assert.equal(statedPlace(herePhrase('we are in kata — flights to bangkok on friday?')), 'kata');
  assert.equal(statedPlace(herePhrase('flights to bangkok friday, we are in kata')), 'kata',
    'word order still decides the answer — the clause is not being isolated');
});

test('resolveLocation prefers the here-phrase over any other city named', () => {
  // Guard the wiring, not just the helper: a perfect herePhrase() that
  // resolveLocation never calls fixes nothing.
  const src = readFileSync(new URL('../ai/places.js', import.meta.url), 'utf8');
  assert.match(src, /const here = herePhrase\(text\)/,
    'resolveLocation no longer extracts the here-phrase');
  assert.match(src, /\(here && destNamedIn\(here, dests\)\) \|\| \(here \? null : destNamedIn\(text, dests\)\)/,
    'destNamedIn is scanning the whole message again — the destination will be read as the location');
  assert.match(src, /statedPlace\(here \?\? text\)/,
    'statedPlace is reading the whole message again');
});
