// THE PRICE WE TELL A VENUE HAS TO BE THE PRICE THE LEDGER CHARGES.
//
// Until 19 Sep 2026 it was not. PRICE_FACTS — the block worker/bizreply.mjs's
// guard enforces on every generated reply to a business — said:
//
//     "A completed table booking costs a flat $2.00, whatever the bill."
//
// while billpay.mjs feeForBill() charged commission_bp (default 1000bp = 10%)
// on any bill with a booking verified against that venue, and took the flat
// walk-in fee only when there was no such booking. The pricing page and the
// Fact Sheet both agreed with the ledger. The reply guard was the odd one out,
// so every reply that quoted price to a venue quoted one we never charge —
// aimed squarely at the people we are about to ask for money.
//
// These tests hold the two together by shape rather than by a copied number,
// so the next person to change one is told about the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRICE_FACTS } from './bizreply.mjs';

const all = PRICE_FACTS.join('\n');

test('a booking NUM completes is quoted as a share of the bill, not a flat fee', () => {
  const booking = PRICE_FACTS.find((l) => /booking NUM completes/i.test(l));
  assert.ok(booking, 'no line describes what a completed booking costs');
  assert.match(booking, /10%/, 'a table is 10% — billpay defaults commission_bp to 1000');
  assert.match(booking, /15%/, 'a room or appointment is 15%');
  assert.match(booking, /20%/, 'an activity or tour is 20%');
  assert.doesNotMatch(booking, /flat/i, 'a completed booking is never a flat fee');
});

test('the flat $2.00 is the settle fee, and is never attached to a completed booking', () => {
  const flat = PRICE_FACTS.find((l) => /\$2\.00/.test(l));
  assert.ok(flat, 'no line describes the settle fee');
  assert.match(flat, /did not send|didn’t send|did not send/i,
    'the flat fee is for a guest NUM did NOT send');
  assert.doesNotMatch(flat, /completes|completed/i,
    'the flat fee must not be described as the price of a booking NUM completed');
});

test('never a bare USD figure — the house rule on quoting money', () => {
  // Fact Sheet: "Never quote USD alone." A venue in Phuket reading $2.00 with
  // no ฿ has been told a number they cannot check against their own till.
  for (const line of PRICE_FACTS.filter((l) => /\$/.test(l))) {
    assert.match(line, /£/, `no GBP beside the USD: ${line}`);
    assert.match(line, /€/, `no EUR beside the USD: ${line}`);
    assert.match(line, /฿/, `no THB beside the USD: ${line}`);
  }
});

test('listing is free, and nothing is charged when nobody turned up', () => {
  assert.match(all, /Listing is free/i);
  assert.match(all, /no-show/i);
  assert.match(all, /declined/i, 'a declined request costs nothing and should say so');
});

test('the old wrong sentence is gone and cannot come back', () => {
  assert.doesNotMatch(all, /completed table booking costs a flat/i,
    'this is the exact sentence that quoted venues a price the ledger never charges');
});
