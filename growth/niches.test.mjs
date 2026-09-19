// Niches, and the rotation of what a milestone can be.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NICHES, NICHE_KEYS, readNiches, cleanNiches, offerFit,
  REWARD_POOL, readyRewards, rotateReward, POST_LINES, postLinesFor,
} from './niches.mjs';

/* ── THE ONE THAT IS NOT IN THE POOL ───────────────────────────────────── */

test('cannabis is not a reward, and cannot be added by accident', () => {
  // NUM ships in the Apple App Store and Google Play, takes payment through
  // Stripe, and the draw beside this runs in the US and UK, 18+. Apple's
  // guideline 1.4.3, Stripe's restricted list, and the fact that supply is a
  // criminal offence in both territories are each independently fatal.
  const text = JSON.stringify(REWARD_POOL).toLowerCase();
  for (const word of ['cannabis', 'weed', 'marijuana', 'thc', 'cbd', 'dispensary']) {
    assert.equal(text.includes(word), false, `"${word}" appears in the reward pool`);
  }
});

test('every reward says whether NUM can actually hand it over', () => {
  for (const r of REWARD_POOL) {
    assert.equal(typeof r.ready, 'boolean', r.key + ' does not say if it is sourceable');
    // A "not yet" with no reason is how a milestone queue fills with things
    // nobody can action.
    if (!r.ready) assert.ok(r.needs && r.needs.length > 15, r.key + ' is not ready and does not say why');
    if (r.ready) assert.equal(r.needs, null);
  }
});

test('the things NUM can do today are the things it controls', () => {
  const ready = readyRewards().map((r) => r.key);
  assert.deepEqual(ready.sort(), ['membership', 'niche_offer', 'stars']);
  // Flights, rooms, cars and brand goods all need somebody outside NUM.
  for (const k of ['flight', 'room', 'car', 'clothing', 'beauty']) {
    assert.equal(ready.includes(k), false, k + ' is marked sourceable and is not');
  }
});

test('the rotation only ever suggests something NUM can actually give', () => {
  const ready = readyRewards().map((r) => r.key);
  for (let i = 0; i < 200; i++) {
    const r = rotateReward('a_' + i, [1, 5, 10, 25, 50][i % 5]);
    assert.ok(ready.includes(r.key), `rotation suggested ${r.key}, which is not sourceable`);
  }
});

test('the rotation is stable — a refresh does not change what NUM is thinking of', () => {
  const a = rotateReward('a_rae', 10);
  const b = rotateReward('a_rae', 10);
  assert.equal(a.key, b.key);
  // And it does move between rungs, or it is not a rotation.
  const keys = new Set([1, 5, 10, 25, 50, 100, 250].map((t) => rotateReward('a_rae', t).key));
  assert.ok(keys.size > 1, 'every rung suggests the same thing');
});

/* ── niches ────────────────────────────────────────────────────────────── */

test('the vocabulary is short enough that a form gets finished', () => {
  assert.ok(NICHES.length >= 8 && NICHES.length <= 14, `${NICHES.length} options`);
  assert.equal(new Set(NICHE_KEYS).size, NICHES.length, 'a key is duplicated');
  for (const n of NICHES) assert.ok(n.label && n.label.length > 3, n.key);
});

test('an unknown niche is dropped rather than stored', () => {
  assert.deepEqual(cleanNiches(['food', 'crypto', 'nightlife']), ['food', 'nightlife']);
  assert.deepEqual(cleanNiches('not an array'), []);
  assert.deepEqual(cleanNiches([null, undefined, 7]), []);
});

test('six is the cap, because an ambassador for everything is an ambassador for nothing', () => {
  const all = cleanNiches(NICHE_KEYS);
  assert.equal(all.length, 6);
});

test('a duplicate tick does not count twice', () => {
  assert.deepEqual(cleanNiches(['food', 'food', 'food']), ['food']);
});

test('unreadable stored JSON is an empty list, never a crash', () => {
  for (const bad of [null, '', 'not json', '{"a":1}', '[1,2,3]']) {
    assert.deepEqual(readNiches(bad), []);
  }
});

/* ── matching ──────────────────────────────────────────────────────────── */

test('an offer with no niche is for everybody and does not sink', () => {
  // Neutral, not zero. At zero the open offers fall below every targeted one
  // and the first ambassador with a niche never sees them again.
  assert.equal(offerFit(null, ['food']), 1);
  assert.equal(offerFit('[]', ['food']), 1);
});

test('a matching offer beats an open one, and a mismatched one loses to both', () => {
  const mine = ['food', 'nightlife'];
  const match = offerFit(JSON.stringify(['food']), mine);
  const open = offerFit(null, mine);
  const miss = offerFit(JSON.stringify(['beauty']), mine);
  assert.ok(match > open, 'a targeted offer does not outrank an open one');
  assert.ok(open > miss, 'an offer for somebody else outranks a general one');
  assert.equal(miss, 0);
});

test('two matching niches beat one', () => {
  const mine = ['food', 'nightlife'];
  assert.ok(offerFit(JSON.stringify(['food', 'nightlife']), mine)
    > offerFit(JSON.stringify(['food']), mine));
});

test('somebody with no niches still sees the open offers first', () => {
  assert.equal(offerFit(null, []), 1);
  assert.equal(offerFit(JSON.stringify(['food']), []), 0);
});

test('the niche columns exist in the migration that ships them', () => {
  const sql = readFileSync(new URL('../worker/migrations/0055_niches_and_tokyo.sql', import.meta.url), 'utf8');
  assert.match(sql, /ALTER TABLE num_ambassadors ADD COLUMN niches_json/);
  assert.match(sql, /ALTER TABLE num_ambassador_offers ADD COLUMN niches_json/);
  // One ALTER per statement: a duplicate-column error on the first must not
  // roll back the rest.
  for (const stmt of sql.split(';')) {
    assert.ok((stmt.match(/ALTER\s+TABLE/gi) || []).length <= 1, 'two ALTERs in one statement');
  }
});

/* ── something to post ─────────────────────────────────────────────────── */

test('every suggested line is true today — none promise a thing that is off', () => {
  // The rewards NUM cannot source yet are named in REWARD_POOL with ready
  // false; nothing a person is invited to POST may lean on one of them.
  const notReady = REWARD_POOL.filter((r) => !r.ready).map((r) => r.key);
  assert.ok(notReady.includes('room') && notReady.includes('flight') && notReady.includes('car'));
  const all = POST_LINES.map((l) => l.text.toLowerCase()).join(' ');
  // An ambassador who pastes a line NUM wrote and gets caught out will never
  // paste another one.
  for (const word of ['hotel', 'flight', 'car hire', 'rental car', 'yacht', 'jet', 'villa', 'chauffeur']) {
    assert.equal(all.includes(word), false, `a suggested post mentions "${word}", which is not live`);
  }
});

test('the coverage claim in the lines matches the rest of the product', () => {
  // 39 countries, checked by scripts/coverage-claims.mjs everywhere else.
  const all = POST_LINES.map((l) => l.text).join(' ');
  assert.equal(/\b38 countries\b/.test(all), false, 'a post line says 38 countries');
  assert.ok(/\b39 countries\b/.test(all));
});

test('every line carries the ambassador\'s own link', () => {
  for (const l of POST_LINES) assert.match(l.text, /\{link\}/, l.key + ' has no link in it');
  const out = postLinesFor([], 'https://itsnum.com/r/ABC');
  for (const l of out) {
    assert.match(l.text, /https:\/\/itsnum\.com\/r\/ABC/);
    assert.equal(l.text.includes('{link}'), false, 'a placeholder was left in');
  }
});

test('somebody who posts about food is not handed a nightlife line first', () => {
  const out = postLinesFor(['food'], 'L');
  assert.equal(out[0].key, 'food');
  // And they still get the general ones, so the list is never thin.
  assert.ok(out.length >= 4);
});

test('an ambassador with no niche still gets something', () => {
  const out = postLinesFor([], 'L');
  assert.ok(out.length >= 3);
  for (const l of out) assert.ok(l.text.length > 40);
});
