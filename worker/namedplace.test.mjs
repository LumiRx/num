// The guest is the only authority on where the guest is asking about.
//
// "Let's plan the horse races this weekend in Delmar" was answered with Los
// Angeles restaurants. The resolver's own comment promised "a place the guest
// named > where they actually are", but the branch order checked IP
// coordinates first — so anyone planning a trip from inside a covered city
// was answered about the covered city. Planning means asking about somewhere
// you are not standing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statedPlace, detectCat } from '../ai/places.js';
import { contextBlock } from './prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const places = readFileSync(join(HERE, '..', 'ai', 'places.js'), 'utf8');
const grounding = readFileSync(join(HERE, 'grounding.mjs'), 'utf8');

test('a stated place is heard', () => {
  assert.equal(statedPlace("let's plan the horse races this weekend in Delmar"), 'Delmar');
  assert.equal(statedPlace('dinner in Tulum next month'), 'Tulum');
});

test('"in a hurry" is still not a city', () => {
  // The guard that makes the reorder safe. If these regress, every idiom with
  // "in" strips a guest of their grounding.
  for (const s of ["i'm in a hurry", 'in the mood for thai', 'table in the evening', 'in about an hour']) {
    assert.equal(statedPlace(s), null, `"${s}" was read as a place name`);
  }
});

test('a named place outranks coordinates in the resolver, structurally', () => {
  // The bug was pure branch order: `nearest` (IP) was checked before `stated`.
  // Assert the order in the source so a refactor cannot quietly swap it back.
  const fn = places.slice(places.indexOf('export async function resolveLocation'));
  const statedIdx = fn.indexOf('else if (stated)');
  const nearestIdx = fn.indexOf('else if (nearest && nearest.km < 120)');
  assert.ok(statedIdx > 0 && nearestIdx > 0, 'resolver branches not found — this guard is not guarding');
  assert.ok(statedIdx < nearestIdx,
    'the IP-coordinates branch is checked before the stated-place branch again — ' +
    '"horse races in Delmar" will be answered with the guest\'s IP city');
});

test('an unsupported place reaches the model instead of vanishing', () => {
  // Returning `none` hid WHY there were no partners, and the prompt fell back
  // to asserting the IP city. The place must travel through, flagged.
  assert.match(grounding, /unsupported: true/,
    'grounding drops the named-but-uncovered place — the model cannot answer about it honestly');
});

test('the prompt answers about the asked place and admits no coverage', () => {
  const block = contextBlock({ place: { name: 'Del Mar', unsupported: true } });
  assert.match(block, /Del Mar/, 'the asked-about place never reaches the prompt');
  assert.match(block, /NO partner network/i, 'the model is not told coverage is absent — it will invent partner venues');
  assert.match(block, /NEVER answer about a different city/i,
    'nothing forbids substituting the IP city — the Delmar → Los Angeles answer is still possible');
  assert.ok(!/current destination/.test(block),
    'an uncovered place is presented as the current destination — downstream logic will treat it as covered');
});

test('a beach ask is a beach ask, in the languages guests use', () => {
  // 14,010 places and zero beaches was half the failure; the other half was
  // that detectCat had no beach category at all, so even with rows in the
  // table "best beach" would have been answered with the restaurant defaults.
  assert.equal(detectCat('best beach in phuket'), 'beach');
  assert.equal(detectCat('หาดไหนสวย'), 'beach');
  assert.equal(detectCat('лучший пляж'), 'beach');
  assert.equal(detectCat('a sandwich place nearby'), null,
    '"sandwich" matched the beach category — substring matching needs the word list to stay clean');
});

test('the nature ingest can never clobber an enriched row', () => {
  // The main ingest REPLACES on id collision. A nature re-run writes rating
  // NULL, so REPLACE would wipe the Google ratings the enrichment pass paid
  // for. IGNORE is the difference between adding knowledge and erasing it.
  const ingest = readFileSync(join(HERE, '..', 'scripts', 'ingest_global.mjs'), 'utf8');
  assert.match(ingest, /NATURE \? 'IGNORE' : 'REPLACE'/,
    'the nature mode no longer uses INSERT OR IGNORE — a re-run will erase Google ratings on every collision');
  assert.match(ingest, /natural"="beach/, 'the nature query no longer asks Overpass for beaches');
});
