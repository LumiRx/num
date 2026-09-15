// A VENUE IS SHOWN ITS OWN MONEY.
//
// 14 Sep 2026. LA Cannabis Club — country US on its own profile — read
// "0.00 THB" on its statement and its hub, while the prose two lines above
// said "$2". Three faults stacked:
//
//   1. money.owed() fell through to a hard-coded 'THB' when a venue had no
//      billed lines — which is every venue on its first day.
//   2. Both money pages read `currency` from num_business_settings, a column
//      that does not exist, so the SELECT threw and the catch turned it null —
//      taking the venue's commission rate and walk-in fee with it. A venue on
//      15% was shown 10% by the same fault.
//   3. The browser's own formatter defaulted to THB too.
//
// None of it was a missing feature. The country was on the profile the whole
// time and railFor() already knew what to do with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { venueCurrency } from './money.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const worker = readFileSync(join(HERE, 'worker.js'), 'utf8');
const money = readFileSync(join(HERE, 'money.mjs'), 'utf8');

const envWith = (country) => ({
  DB: { prepare: () => ({ bind: () => ({ first: async () => (country ? { country } : null) }) }) },
});

test('the country on the profile decides the currency', async () => {
  assert.equal(await venueCurrency(envWith('US'), 'b1'), 'USD');
  assert.equal(await venueCurrency(envWith('us'), 'b1'), 'USD', 'case must not matter');
  assert.equal(await venueCurrency(envWith('TH'), 'b1'), 'THB');
  assert.equal(await venueCurrency(envWith('GB'), 'b1'), 'GBP');
});

test('an unknown country falls to USD, never to one particular market', async () => {
  assert.equal(await venueCurrency(envWith(null), 'b1'), 'USD');
  assert.equal(await venueCurrency(envWith('ZZ'), 'b1'), 'USD');
});

test('nothing in the money layer guesses THB', () => {
  // Not scoped to one function on purpose. There were four of these — the
  // running total, the line filter inside it, and two in the code that ISSUES
  // invoices, where the fallback would have raised a real bill in baht against
  // a Los Angeles venue.
  const code = money
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const guesses = code.match(/\|\|\s*'THB'/g) || [];
  assert.deepEqual(guesses, [],
    'a THB fallback is back in the money layer — that is the line that put baht on a Los Angeles statement');
  assert.match(code, /await venueCurrency\(env, businessId\)/,
    'the empty case no longer asks the venue what money it is in');
});

test('an invoice is never raised in a currency nobody agreed to', () => {
  const inv = money.slice(money.indexOf('One invoice cannot be part baht'));
  assert.match(inv.slice(0, 700), /lines\[0\]\.currency \|\| await venueCurrency\(env, businessId\)/,
    'the invoice writer can still fall back to a hard-coded currency');
});

test('the browser never labels a figure with a currency it was not given', () => {
  assert.ok(!/\(cur\|\|'THB'\)/.test(worker),
    'the client formatter defaults to THB again');
  assert.match(worker, /function m\(cs,cur\)\{return \(cs\/100\)\.toFixed\(2\)\+\(cur\?/,
    'the formatter no longer degrades to an unlabelled figure');
});

test('the money pages stop reading a column that does not exist', () => {
  // num_business_settings has no `currency`. Selecting it threw, and the catch
  // turned the venue's real commission rate and walk-in fee into defaults.
  assert.ok(!/walkin_fee_cs, currency\s*\n\s*FROM num_business_settings/.test(worker),
    'the terms query asks for a column that does not exist, so it silently returns nothing');
  const hits = (worker.match(/const money = await venueMoney\(env, who\.business\.id\)/g) || []);
  assert.ok(hits.length >= 2,
    'the hub and the statement must both resolve currency the same way — and any page that shows money joins them here, never with its own guess');
});

test('an unknown currency shows its letters, never a wrong symbol', () => {
  const sym = worker.slice(worker.indexOf('const CURRENCY_SYMBOL'));
  assert.match(sym.slice(0, 400), /USD: '\$'/);
  const amt = worker.slice(worker.indexOf('function venueAmount'));
  assert.match(amt.slice(0, 400), /money\.symbol \?/,
    'venueAmount assumes a symbol exists — "$12.00" for zloty is a lie');
});
