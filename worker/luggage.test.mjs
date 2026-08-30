import test from 'node:test';
import assert from 'node:assert/strict';
import { CITIES, luggageReady, luggageLink, wantsLuggage, luggageBlock } from './luggage.mjs';

const ENV = { BOUNCE_REF: 'NUM28251611139908608' };

test('no referral code, no link', () => {
  assert.equal(luggageReady({}), false);
  assert.equal(luggageLink({}, { name: 'Phuket' }), null);
});

test('a verified city gets its own page, attributed', () => {
  const u = new URL(luggageLink(ENV, { name: 'Phuket' }));
  assert.equal(u.origin + u.pathname, 'https://bounce.com/city/phuket');
  assert.equal(u.searchParams.get('ref'), 'NUM28251611139908608');
});

// A guessed slug 404s — verified: /city/nowhere-xyz returns 404. A 404
// carrying our referral code is worse than a generic link.
test('an unverified city falls back rather than guessing a slug', () => {
  const u = luggageLink(ENV, { name: 'Nakhon Nowhere' });
  assert.equal(u, 'https://go.bounce.com/NUM28251611139908608');
  assert.ok(!u.includes('/city/'), 'never guess a city page');
});

test('every city in the list is lowercase and slug-shaped', () => {
  for (const [k, v] of Object.entries(CITIES)) {
    assert.equal(k, v, `${k} should map to itself`);
    assert.match(v, /^[a-z0-9-]+$/);
  }
});

test('a beach falls back to its parent city', () => {
  const u = new URL(luggageLink(ENV, { name: 'Kata Beach', city: 'Phuket' }));
  assert.equal(u.pathname, '/city/phuket');
});

test('the gate catches asking about bags', () => {
  for (const q of [
    'where can we store our luggage',
    'somewhere to leave bags for the day',
    'can we drop our suitcases somewhere',
    'left luggage near the station',
    'is there a bag drop',
    'lockers anywhere',
    'need to store a backpack',
  ]) assert.ok(wantsLuggage(q), `missed: ${q}`);
});

// "What time do we check out" is a question about the hotel. Answering it
// with a luggage shop answers a question nobody asked.
test('the gate stays out of adjacent questions', () => {
  for (const q of [
    'what time do we check out',
    'can you book a car',
    'how much luggage can I take on the flight',
    "what's on tonight",
    'thanks',
  ]) assert.equal(wantsLuggage(q), false, `false positive: ${q}`);
});

// The honest hierarchy: the hotel is nearly always free and nearly always
// closer. A rail that earns commission must not bury that.
test('the block sends them to their hotel first', () => {
  const block = luggageBlock(luggageLink(ENV, { name: 'Phuket' }), { name: 'Phuket' });
  assert.match(block, /hotel will almost always hold bags for free/i);
  assert.match(block, /offer that FIRST/);
  assert.match(block, /CANNOT see live prices/i);
  assert.match(block, /before the shop closes/i, 'the late-flight trap is the useful warning');
});

test('no link means no block', () => {
  assert.equal(luggageBlock(null, { name: 'Phuket' }), '');
});

// Bounce has city pages for Dubai and Abu Dhabi and NOT for the other five
// emirates — checked by fetch on 30 Aug 2026. The five must degrade to the
// generic referral rather than 404 with our code attached.
test('UAE splits correctly between real city pages and the fallback', () => {
  for (const name of ['Dubai', 'Abu Dhabi']) {
    const u = new URL(luggageLink(ENV, { name }));
    assert.equal(u.origin, 'https://bounce.com', `${name} should get a city page`);
    assert.match(u.pathname, /^\/city\//);
  }
  for (const name of ['Sharjah', 'Ajman', 'Al Ain', 'Ras Al Khaimah', 'Fujairah']) {
    const u = luggageLink(ENV, { name });
    assert.ok(!u.includes('/city/'), `${name} has no Bounce page and must fall back`);
    assert.match(u, /^https:\/\/go\.bounce\.com\//);
  }
});
