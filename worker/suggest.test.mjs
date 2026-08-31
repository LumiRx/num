import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSuggestions, rotationIndex, categoriesFor } from './suggest.mjs';

const PHUKET = [
  { category: 'Restaurant', n: 1200 }, { category: 'Café', n: 300 },
  { category: 'Beauty & spa', n: 400 }, { category: 'Bar', n: 250 },
  { category: 'Attraction', n: 90 }, { category: 'Hotel', n: 800 },
  { category: 'Tours & travel', n: 60 },
];

test('a suggestion is only offered where Num can actually answer it', () => {
  // The whole point. A town with two cafés and no bars must not be told to
  // ask about nightlife — the next screen would have nothing to show.
  const tiny = [{ category: 'Restaurant', n: 30 }, { category: 'Café', n: 2 }, { category: 'Bar', n: 1 }];
  const { starters } = buildSuggestions(tiny);
  const labels = starters.map((s) => s.label);
  assert.ok(labels.includes('Dinner tonight'), 'a town full of restaurants was not offered dinner');
  assert.ok(!labels.includes('Good coffee'), '2 cafés was enough to promise the best coffee in town');
  assert.ok(!labels.includes('Drinks tonight'), '1 bar was enough to promise a night out');
});

test('the strip leads with what the destination has most of', () => {
  const { starters } = buildSuggestions(PHUKET);
  assert.equal(starters[0].label, 'Dinner tonight', 'the biggest category did not lead');
  const local = starters.findIndex((s) => s.label === 'Car to the airport');
  const spa = starters.findIndex((s) => s.label === 'Massage & spa');
  assert.ok(spa < local, 'a universal capability outranked the local directory');
});

test('an unknown destination still shows what Num can do', () => {
  // An empty strip would teach a brand-new guest that Num does nothing, which
  // is the single worst first impression this product can make.
  const { starters, grounded } = buildSuggestions([]);
  assert.equal(grounded, false);
  assert.ok(starters.length >= 4, 'a guest with no known destination got an empty strip');
  assert.ok(starters.every((s) => s.prompt && s.label && s.emoji));
});

test('the showcase line never claims something the town cannot serve', () => {
  const noFood = [{ category: 'Hotel', n: 400 }];
  for (let i = 0; i < 40; i += 1) {
    const { rotating } = buildSuggestions(noFood, { now: i * 90_000 });
    assert.ok(rotating, 'no showcase line was offered at all');
    assert.ok(!/dinner|eating|café|drink|massage/i.test(rotating),
      `offered "${rotating}" in a destination with no such places`);
  }
});

test('the showcase line actually rotates', () => {
  const seen = new Set();
  for (let i = 0; i < 12; i += 1) seen.add(buildSuggestions(PHUKET, { now: i * 90_000 }).rotating);
  assert.ok(seen.size >= 5, `only ${seen.size} distinct lines in 12 windows — it is not rotating`);
});

test('the rotation is stable inside its window', () => {
  // It must not change under a guest who is mid-read.
  // Anchored to a window boundary — 1_000_000 sits 10s before one, so the
  // original version of this test was measuring a real rotation and calling
  // it a bug.
  const start = 11 * 90_000;
  const a = buildSuggestions(PHUKET, { now: start }).rotating;
  const b = buildSuggestions(PHUKET, { now: start + 89_000 }).rotating;
  assert.equal(a, b, 'the line changed while the guest was still looking at it');
  assert.equal(rotationIndex(0), 0);
});

test('every prompt is a thing a guest would really type', () => {
  const { starters } = buildSuggestions(PHUKET);
  for (const s of starters) {
    assert.ok(s.prompt.length > 12 && s.prompt.length < 80, `bad prompt: ${s.prompt}`);
    assert.ok(!/^\W/.test(s.label), `label starts with punctuation: ${s.label}`);
  }
});

test('a database failure costs a strip, never a page', async () => {
  assert.deepEqual(await categoriesFor({}, 'phuket'), []);
  assert.deepEqual(await categoriesFor({ DB: { prepare() { throw new Error('down'); } } }, 'phuket'), []);
});

test('a display name resolves to a destination — the client never had a slug', async () => {
  // The original shape of this feature read `place.slug` on the client, where
  // `place` is a string. It type-checked, returned undefined forever, and
  // would have looked exactly like a working feature serving the fallback.
  const rows = { phuket: [{ category: 'Restaurant', n: 900 }] };
  const env = {
    DB: {
      prepare(q) {
        return {
          bind(...a) {
            return {
              async first() {
                if (/WHERE slug = /.test(q)) return a[0] === 'phuket' ? { slug: 'phuket' } : null;
                if (/lower\(name\)/.test(q)) return /phuket/i.test(String(a[0])) ? { slug: 'phuket' } : null;
                return null;
              },
              async all() { return { results: rows.phuket }; },
            };
          },
        };
      },
    },
  };
  const { resolveDest } = await import('./suggest.mjs');
  assert.equal(await resolveDest(env, 'phuket'), 'phuket', 'an exact slug did not resolve');
  assert.equal(await resolveDest(env, 'Phuket'), 'phuket', 'a display name did not resolve');
  assert.equal(await resolveDest(env, 'Kata, Phuket'), 'phuket', 'an "area, city" name did not resolve');
  assert.equal(await resolveDest(env, 'Nowhere'), null);
  assert.equal(await resolveDest({}, 'Phuket'), null, 'a missing DB should be null, not a throw');
});
