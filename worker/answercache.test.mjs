// The answer we already paid for.
//
// A cache is the one optimisation that can quietly break a product: a wrong
// hit shows one guest another guest's answer, and it looks like a working
// reply from the outside. These tests are mostly about what must NOT be cached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, ttlFor, cacheable } from './answercache.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('the many ways of typing one question collapse to one key', () => {
  // Without this the cache holds a thousand keys and hits none of them.
  const a = normalize('Best beach in Phuket?');
  assert.equal(normalize('best beaches phuket'), a === normalize('best beaches phuket') ? a : a,
    'sanity');
  for (const variant of ['Best beach in Phuket?', 'best beach phuket', "What's the best beach in Phuket"]) {
    assert.equal(normalize(variant), 'best beach phuket', `"${variant}" produced a different key`);
  }
});

test('a question about a person is never shared', () => {
  // The single most damaging failure this file could have.
  for (const q of ['where is my booking', 'what did we book', "i'm vegetarian, where should i eat"]) {
    assert.equal(cacheable({ userText: q, profile: {}, state: {}, reply: {} }), false,
      `"${q}" would have been served to another guest`);
  }
});

test('an answer shaped by a profile or a trip stays private', () => {
  const base = { userText: 'where should we eat', reply: {} };
  assert.equal(cacheable({ ...base, profile: { likes: 'seafood' }, state: {} }), false,
    'a profile-shaped answer was marked shareable');
  assert.equal(cacheable({ ...base, profile: {}, state: { party: 4 } }), false,
    'a party-size-shaped answer was marked shareable');
  assert.equal(cacheable({ ...base, profile: {}, state: { bookings: [{ id: 'b1' }] } }), false,
    'an answer from a live trip was marked shareable');
});

test('a reply that DOES something is never replayed', () => {
  // Actions run on delivery. Serving a stored one would re-trigger the doing —
  // a second car, a second booking, from a cache hit nobody asked for.
  assert.equal(
    cacheable({ userText: 'book a car to the airport', profile: {}, state: {}, reply: { actions: [{ type: 'book' }] } }),
    false,
    'a reply carrying actions was cached — it would fire again on the next hit');
});

test('a general question with no personal context is shareable', () => {
  assert.equal(cacheable({ userText: 'best beach in phuket', profile: {}, state: {}, reply: {} }), true,
    'the common case is not being cached — the whole saving is lost');
});

test('freshness matches how fast the answer goes stale', () => {
  // One global TTL either throws away good answers or serves stale ones.
  assert.ok(ttlFor('what time does it open') <= 3600,
    'opening hours are cached for hours — guests would be sent to a closed door');
  assert.ok(ttlFor('how much is a taxi to the airport') <= 3600, 'a price is cached too long');
  assert.ok(ttlFor('best beach in phuket') >= 86400, 'a stable recommendation is thrown away too fast');
});

test('junk and essays are left alone', () => {
  assert.equal(cacheable({ userText: 'hi', profile: {}, state: {}, reply: {} }), false);
  assert.equal(cacheable({ userText: 'x'.repeat(400), profile: {}, state: {}, reply: {} }), false);
});

test('the cache is wired into the request path, both ends', () => {
  // A cache module nobody calls is a file, not a saving.
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  assert.match(index, /readCache\(env/, 'nothing ever reads the cache — every repeat question still pays full price');
  assert.match(index, /writeCache\(env/, 'nothing ever writes the cache — it can never hit');
  assert.match(index, /served from cache, no model called/, 'a cache hit is invisible; the hit rate could not be measured');
});

test('lean-mode answers are never cached', () => {
  // Caching a degraded reply would outlive the outage that caused it — guests
  // would keep getting "I'm running lean" hours after the brains recovered.
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  assert.match(index, /!_degraded && cacheable\(/,
    'a degraded reply can be written to the cache — lean mode would become permanent for that question');
});
