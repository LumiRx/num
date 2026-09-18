// The everyday intents added 18 Sep 2026 for the new doors: each ask lands on
// its own bucket, and the substring traps that were checked by hand stay shut.
// Run: node --test ai/everyday.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCat, subIntent, CATS } from './places.js';

const cases = [
  ['where can I get my shirts dry cleaned', 'laundry'],
  ['is there a laundromat near the hotel', 'laundry'],
  ['nearest supermarket for water and snacks', 'grocery'],
  ['is there a 7-eleven nearby', 'grocery'],
  ['I need to send a parcel home', 'postoffice'],
  ['post office near me', 'postoffice'],
  ['somewhere to store my bags for the day', 'luggage'],
  ['I need a new suitcase', 'luggage'],
  ['how do I get to the train station', 'transit'],
  ['nearest metro station', 'transit'],
  ['my dog is sick, I need a vet', 'vet'],
  ['emergency vet open now', 'vet'],
  ['a coworking space with a day desk', 'cowork'],
  ['is there a wework here', 'cowork'],
  ['things to do with kids this afternoon', 'kids'],
  ['a playground near the hotel', 'kids'],
  ['I need a haircut before dinner', 'grooming'],
  ['a good barber nearby', 'grooming'],
  ['lash extensions tomorrow morning', 'grooming'],
  ['manicure and pedicure', 'grooming'],
];
for (const [ask, want] of cases) {
  test(`"${ask}" → ${want}`, () => assert.equal(detectCat(ask), want));
}

test('the traps stay shut: velvet is not a vet, training is not a train, carpet is not a pet', () => {
  assert.notEqual(detectCat('the velvet lounge'), 'vet');
  assert.notEqual(detectCat('muay thai training'), 'transit');
  assert.notEqual(detectCat('a carpet shop'), 'vet');
});

test('a kid-friendly restaurant is still a restaurant ask, and a taxi to the station is a taxi ask', () => {
  assert.equal(detectCat('a kid friendly restaurant for dinner'), 'restaurant');
  assert.equal(detectCat('a taxi to the train station'), 'transport');
});

test('facial stays with spa; a massage ask never becomes grooming', () => {
  assert.equal(detectCat('a facial this afternoon'), 'spa');
  assert.equal(detectCat('deep tissue massage'), 'spa');
});

test('grooming sub-intents: barber, lashes, nails, hair each earn their own bonus', () => {
  assert.equal(subIntent('grooming', 'a good barber'), '%barber%');
  assert.equal(subIntent('grooming', 'lash extensions'), '%lash%');
  assert.equal(subIntent('grooming', 'a manicure'), '%nail%');
  assert.equal(subIntent('grooming', 'a haircut and blow dry'), '%hair%');
});

test('every new intent has category patterns to search with', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('./places.js', import.meta.url), 'utf8'));
  for (const k of ['laundry', 'grocery', 'postoffice', 'luggage', 'transit', 'vet', 'cowork', 'kids', 'grooming']) {
    assert.ok(k in CATS, k);
    assert.match(src, new RegExp(`\\n  ${k}:\\s+\\[[^\\n]*%`), `CATSQL has ${k}`);
  }
});
