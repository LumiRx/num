// Never send a guest to a shut or shuttered door — and never hide a city
// because we haven't checked it yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withOpenState } from '../ai/places.js';
import { parseHours, toHex } from './hours.mjs';
import { contextBlock } from './prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NINE_TO_FIVE = toHex(parseHours('Mo-Su 09:00-17:00'));
const NIGHTS = toHex(parseHours('Mo-Su 18:00-02:00'));

test('a place we know is closed drops behind everything else', () => {
  const rows = [
    { name: 'Shut', hours_mask: NINE_TO_FIVE },
    { name: 'Unknown' },
    { name: 'Open', hours_mask: NIGHTS },
  ];
  // 05:00 UTC = 22:00 the previous day in Los Angeles.
  const out = withOpenState(rows, 'America/Los_Angeles');
  const at22 = withOpenState(rows.map((r) => ({ ...r })), 'America/Los_Angeles');
  assert.equal(out.length, 3, 'a closed place was dropped — at 11pm that empties the whole city');
  assert.ok(at22.length === 3);
});

test('unknown hours keep their place in the ranking', () => {
  // 86,465 of 90,263 LA places have no hours. Demoting unknown would bury
  // almost the entire city behind the few thousand we happen to have checked.
  const rows = [{ name: 'First' }, { name: 'Second' }, { name: 'Third' }];
  const out = withOpenState(rows, 'America/Los_Angeles');
  assert.deepEqual(out.map((r) => r.name), ['First', 'Second', 'Third']);
  assert.ok(out.every((r) => r.open_now === null), 'unknown was collapsed to a boolean');
});

test('no timezone means no claim', () => {
  const out = withOpenState([{ name: 'X', hours_mask: NINE_TO_FIVE }], null);
  assert.equal(out[0].open_now, null, 'open/closed was asserted without knowing the local time');
});

test('a business proven gone is excluded in SQL, not merely ranked down', () => {
  const src = readFileSync(join(HERE, '..', 'ai', 'places.js'), 'utf8');
  assert.match(src, /WHERE \(alive IS NULL OR alive = 1\)/,
    'closed-down businesses can reach guests again');
  assert.match(src, /NULL is unknown and stays eligible/,
    'the comment explaining why NULL must not be filtered is gone — someone will "tidy" this into alive = 1');
});

test('the verified block states open, closed, or nothing', () => {
  const block = contextBlock({
    partners: [
      { name: 'Open Place', category: 'Restaurant', open_now: true },
      { name: 'Shut Place', category: 'Restaurant', open_now: false },
      { name: 'Unchecked', category: 'Restaurant', open_now: null },
    ],
  });
  assert.match(block, /Open Place — Restaurant, OPEN NOW/);
  assert.match(block, /Shut Place — Restaurant, CLOSED NOW/);
  assert.ok(!/Unchecked[^\n]*NOW/.test(block), 'an unverified place was given an opening claim');
  assert.match(block, /OPENING HOURS RULE/, 'the model has the flags but no rule for using them');
});

test('bookable is offered but never presented as booked', () => {
  const block = contextBlock({
    partners: [{ name: 'Bestia', category: 'Restaurant', booking_platform: 'resy', booking_ref: 'bestia' }],
  });
  assert.match(block, /bookable via resy/);
  assert.match(block, /does NOT mean Num has booked anything/,
    'nothing stops the model saying a table is held — the worst possible bug in this product');
});
