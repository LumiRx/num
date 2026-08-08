// The currency is part of the price.
//
// Before this file, `currency` travelled from the client to Stripe with no
// check at all. Every number in the system means "hundredths of SOMETHING" —
// and 898 is $8.98 in US cents, ฿8.98 (about 25 US cents) in satang. Same
// integer, 97% discount. Accepting baht without pinning that down would have
// turned every price into a suggestion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPayment, CURRENCIES, tierPaidRight } from './preflight.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('baht is accepted for real-world bills', () => {
  // The point of the whole exercise: a ฿1,240 dinner is a normal thing to pay.
  const v = checkPayment({ ref: 'tab:abc', amount_cents: 124000, currency: 'thb' });
  assert.equal(v.ok, true, 'a normal baht bill was refused — THB is not actually accepted');
  assert.equal(v.currency, 'thb', 'the validated currency is not returned — the caller will fall back to the raw client value');
});

test('our own prices can never be charged in the wrong currency', () => {
  // 898 US cents charged as satang is the 97% discount. Tier and Star refs
  // are priced by US in USD; the client does not get a vote on the unit.
  for (const ref of ['tier:plus', 'stars:500']) {
    const v = checkPayment({ ref, amount_cents: ref === 'stars:500' ? 15000 : 898, currency: 'thb' });
    assert.equal(v.ok, false, `${ref} was allowed in THB — the same integer is worth 35x less`);
  }
});

test('an unknown currency is refused, never defaulted', () => {
  // Falling back to USD silently would re-open the confusion: the client said
  // one unit, we charged another.
  const v = checkPayment({ ref: 'tab:abc', amount_cents: 5000, currency: 'idr' });
  assert.equal(v.ok, false, 'an unsupported currency slipped through');
});

test('bounds scale with the currency', () => {
  // One ceiling calibrated for dollars refuses a normal Thai dinner: 2,000,000
  // is $20,000 in cents but only ~$570 in satang. Each currency carries its
  // own floor and ceiling or the bounds are theatre.
  const bigThaiDinner = checkPayment({ ref: 'tab:x', amount_cents: 3_000_000, currency: 'thb' }); // ฿30,000
  assert.equal(bigThaiDinner.ok, true, 'a ฿30,000 group dinner was refused by a ceiling calibrated in dollars');
  const sameNumberUsd = checkPayment({ ref: 'tab:x', amount_cents: 3_000_000, currency: 'usd' }); // $30,000
  assert.equal(sameNumberUsd.ok, false, 'a $30,000 charge sailed past the human-review ceiling');
  assert.ok(CURRENCIES.thb.min > CURRENCIES.usd.min, 'THB floor is below Stripe’s actual THB minimum');
});

test('the request path uses the VALIDATED currency, not the client’s', () => {
  const pay = readFileSync(join(HERE, 'pay.mjs'), 'utf8');
  assert.match(pay, /currency: verdict\.currency/,
    'requestPayment is fed the raw client currency again — checkPayment validates and is then ignored');
});

test('a signed payment for the wrong amount buys nothing', () => {
  // Behaviour, not source text: the first version of this test grepped
  // pay.mjs for the check and a `true ||` mutation passed it untouched.
  assert.equal(tierPaidRight({ amount_total: 2898, currency: 'usd' }, 2898), true, 'the exact right payment is refused');
  assert.equal(tierPaidRight({ amount_total: 50, currency: 'usd' }, 2898), false, 'fifty cents bought a $28.98 membership');
  assert.equal(tierPaidRight({ amount_total: 2898, currency: 'thb' }, 2898), false, '฿28.98 bought a $28.98 membership');
  assert.equal(tierPaidRight({ amount_total: 2898, currency: 'usd' }, undefined), false, 'an unknown tier with no price was granted anyway');
});

test('the webhook actually uses the pure check', () => {
  // The function being right is worthless if the webhook stops calling it.
  const pay = readFileSync(join(HERE, 'pay.mjs'), 'utf8');
  assert.match(pay, /tierPaidRight\(s, owed\)/,
    'the webhook no longer calls tierPaidRight — the underpayment check is dead code');
  assert.match(pay, /TIER UNDERPAYMENT/,
    'an underpayment is no longer logged loudly — money taken with no tier granted would be invisible');
});
