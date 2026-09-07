/**
 * THE CONSOLE MUST NOT PROMISE A FEE WE DO NOT CHARGE.
 *
 * On 7 September 2026 the per-booking fee was removed: worker/servicefee.mjs
 * holds BOOKING_FEE_MINOR at 0, the flyer we hand to hosts says "£0 per
 * booking, no commission", and the Requests card in the console says the same
 * thing in its own words.
 *
 * One line of JavaScript underneath it kept saying "We charge £5 when you
 * confirm a booking" — and it was the line a host actually saw, because it
 * rendered live under the table. Two contradictory promises on one screen is
 * worse than either promise alone: a host who notices stops believing the
 * page, and a host who does not notice believes the wrong one.
 *
 * Copy drifts away from code silently. This test is the thing that notices.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOKING_FEE_MINOR } from './servicefee.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, '..', p), 'utf8');

// Everything a host reads about what NUM charges them per booking.
const HOST_FACING = [
  'public/host/index.html',
  'public/hosts/index.html',
  'public/my-host/index.html',
  'public/flyers/hosts/onepager/index.html',
  'public/flyers/hosts/onepager/usd/index.html',
];

// Strip HTML and JS comments — a comment explaining why the fee is gone is
// the opposite of the problem, and must not fail this test.
const live = (s) => s
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

test('the fee really is zero, so every page below is talking about nothing', () => {
  assert.equal(BOOKING_FEE_MINOR, 0);
});

for (const page of HOST_FACING) {
  test(`${page} never tells a host we take a cut of a booking`, () => {
    const s = live(read(page));
    // Both the escaped and the literal pound sign, because the console writes
    // '£5' and the flyers write '£5'.
    const claims = [
      /we charge\s*(\\u00a3|£)\s*\d/i,
      /(\\u00a3|£)\s*\d+(\.\d+)?\s*(a|per)\s+booking/i,
      /per[- ]booking fee of/i,
      /commission on (your|the) (work|booking)s? of/i,
    ];
    for (const re of claims) {
      const hit = s.match(re);
      assert.equal(hit, null,
        `${page} claims a per-booking charge: ${hit && hit[0]}`);
    }
  });
}

test('the console still says plainly that there is no per-booking fee', () => {
  // Removing the false claim is only half the job — the true one has to stay,
  // because silence reads as "they have not said, so probably yes".
  const s = read('public/host/index.html');
  assert.match(s, /no per-booking fee/i);
  assert.match(s, /no commission on your work/i);
});

test('a host can always see what a paid plan costs', () => {
  // The plan cards fell back to an em dash whenever Stripe had not answered,
  // so every paid tier read "Pro — —" next to an Upgrade button. Nobody should
  // be asked to upgrade to a price they cannot see.
  const s = read('public/host/index.html');
  assert.match(s, /var PLAN_LIST = \{/, 'the list-price fallback is gone');
  for (const p of ['9.99', '19.99', '50']) {
    assert.ok(s.includes(p), `the ${p} plan price is missing from the console`);
  }
});
