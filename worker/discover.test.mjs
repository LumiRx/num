import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameThing, slug, annotate, rank, dealThree, haversineKm, MOOD_TAGS } from './discover.mjs';

test('slug strips accents and punctuation so "Havana Música!" matches "havana musica"', () => {
  assert.equal(slug('Havana Música!'), 'havana musica');
});

test('sameThing: a plan item "Thai cooking class" counts as the Viator "Thai Cooking Class with Market Visit"', () => {
  assert.ok(sameThing('Thai cooking class', 'Thai Cooking Class with Market Visit'));
  assert.ok(!sameThing('Thai cooking class', 'Sunset kayak Ao Thalane'));
});

test('annotate drops disliked things and stamps never-tried from the crew history', () => {
  const history = {
    items: [{ title: 'Phi Phi island tour', by_id: 'ari', by_name: 'Ari', status: 'done' }],
    members: [{ member_id: 'ari', name: 'Ari' }, { member_id: 'kim', name: 'Kim' }],
    dislikes: new Set(['fight night patong']),
  };
  const out = annotate([
    { source: 'viator', title: 'Phi Phi Island Tour by speedboat', sub: '' },
    { source: 'num', title: 'Fight night, Patong', sub: '' },
    { source: 'viator', title: 'Thai cooking class', sub: '' },
  ], history, { me: 'viv' });
  assert.equal(out.length, 2, 'the 👎 item never comes back');
  const phi = out.find((i) => i.title.startsWith('Phi'));
  assert.equal(phi.novelty.never_tried, false);
  assert.match(phi.reason, /Ari did this already/);
  const cook = out.find((i) => i.title.startsWith('Thai'));
  assert.equal(cook.novelty.never_tried, true);
  assert.match(cook.reason, /None of you has done this. Ari and Kim/);
});

test('rank puts never-tried first, then closer, then cheaper', () => {
  const r = rank([
    { title: 'a', novelty: { never_tried: false }, distance_km: 1, price: 1 },
    { title: 'b', novelty: { never_tried: true }, distance_km: 9, price: 50 },
    { title: 'c', novelty: { never_tried: true }, distance_km: 2, price: 80 },
    { title: 'd', novelty: { never_tried: true }, distance_km: 2, price: 20 },
  ]);
  assert.deepEqual(r.map((i) => i.title), ['d', 'c', 'b', 'a']);
});

test('dealThree prefers one card per source so a deal is never three boat trips', () => {
  const ranked = [
    { title: 'v1', source: 'viator', novelty: { never_tried: true } },
    { title: 'v2', source: 'viator', novelty: { never_tried: true } },
    { title: 'n1', source: 'num', novelty: { never_tried: true } },
    { title: 't1', source: 'ticketmaster', novelty: { never_tried: true } },
  ];
  assert.deepEqual(dealThree(ranked).map((i) => i.title), ['v1', 'n1', 't1']);
});

test('dealThree falls back to tried things rather than an empty hand', () => {
  const ranked = [{ title: 'x', source: 'num', novelty: { never_tried: false } }];
  assert.equal(dealThree(ranked).length, 1);
});

test('haversine: Patong to Phuket Town is about 12 km', () => {
  const km = haversineKm(7.8965, 98.2963, 7.8804, 98.3923);
  assert.ok(km > 10 && km < 14, km);
});

test('every mood maps to real Viator tag ids', () => {
  for (const [, tags] of Object.entries(MOOD_TAGS)) assert.ok(tags.every((t) => Number.isInteger(t) && t > 10000));
});
