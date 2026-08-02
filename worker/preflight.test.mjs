// The money rules, pinned.
//
// These exist because the $1-for-★5,000 bug was not exotic — it was one
// missing comparison in a route that looked fine in review. A test that
// states the price and asserts it cannot be argued down is the cheapest way
// to stop that class of bug returning.
// Run: node --test worker/preflight.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPayment, checkStars, refusal, STAR_PACKS } from './preflight.mjs';

test('the client can never set the price of a Star pack', () => {
  // The exact exploit, verified live against production before the fix.
  const v = checkPayment({ ref: 'stars:5000', amount_cents: 100 });
  assert.equal(v.ok, false);
  assert.equal(v.correction.amount_cents, STAR_PACKS[5000]);
  assert.match(v.reason, /\$1,425\.00/);
  assert.match(v.reason, /\$1\.00/); // says what they claimed, too
  assert.match(v.correction.says, /Continue at \$1,425\.00/); // a button label
});

test('a pack with no amount is still priced by us', () => {
  const v = checkPayment({ ref: 'stars:1000' });
  assert.equal(v.ok, true);
  assert.equal(v.amount_cents, STAR_PACKS[1000]);
});

test('an invented pack is refused with the nearest real one', () => {
  const v = checkPayment({ ref: 'stars:9999999', amount_cents: 100 });
  assert.equal(v.ok, false);
  assert.equal(v.correction.stars, 5000);
  // ★750 sits exactly between ★500 and ★1,000. Ties go to the CHEAPER pack —
  // suggesting the bigger one mid-confusion is an upsell, and if we must be
  // wrong it should be in the customer's favour.
  const tie = checkPayment({ ref: 'stars:750', amount_cents: 999 });
  assert.equal(tie.correction.stars, 500);
});

test('a correct pack request passes untouched', () => {
  for (const [stars, cents] of Object.entries(STAR_PACKS)) {
    const v = checkPayment({ ref: `stars:${stars}`, amount_cents: cents });
    assert.equal(v.ok, true, `★${stars} at ${cents} should pass`);
    assert.equal(v.amount_cents, cents);
  }
});

test('bills carry their own amount but still get bounds', () => {
  assert.equal(checkPayment({ ref: 'bill:abc', amount_cents: 4800 }).ok, true);
  assert.equal(checkPayment({ ref: 'bill:abc', amount_cents: 0 }).ok, false);
  assert.equal(checkPayment({ ref: 'bill:abc', amount_cents: -500 }).ok, false);
  // Below Stripe's floor: refuse, and say what the floor is.
  const low = checkPayment({ ref: 'bill:abc', amount_cents: 10 });
  assert.equal(low.ok, false);
  assert.equal(low.correction.amount_cents, 50);
  // A typo'd extra zero on a big number needs a human, not a silent charge.
  assert.equal(checkPayment({ ref: 'bill:abc', amount_cents: 99_999_999 }).ok, false);
});

test('Stars never move beyond what the ledger says is there', () => {
  assert.equal(checkStars({ amount: 100, available: 250 }).ok, true);
  const over = checkStars({ amount: 500, available: 40, label: 'cash out' });
  assert.equal(over.ok, false);
  // The correction is the useful part: "you can cash out ★40 now".
  assert.equal(over.correction.amount, 40);
  assert.match(over.correction.says, /★40/);
  // Nothing available at all gets no correction — there is nothing to offer.
  assert.equal(checkStars({ amount: 10, available: 0 }).correction, null);
});

test('a refusal always reads as a sentence a person could act on', () => {
  const body = refusal(checkPayment({ ref: 'stars:5000', amount_cents: 100 }));
  assert.equal(body.ok, false);
  assert.ok(body.error.length > 20);
  assert.ok(body.correction, 'the corrected transaction rides along');
});
