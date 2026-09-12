/**
 * billreceipt — what a guest and a venue are told once a bill is paid.
 *
 * 12 Sep 2026. Settling a bill moved the ledger and told nobody. There was no
 * guest receipt, no venue confirmation, no text and no email anywhere in the
 * settle path — and `payLanding` never read `settled_at`, so a guest who
 * reopened their own bill link after paying was shown "Pay THB 2,400" again.
 *
 * Two things are guarded here. The receipt, which has to work for a guest we
 * hold no contact details for at all. And the venue's confirmation, which has
 * to fire once per bill, say whether NUM will invoice on it, and never make
 * staff at a table wait on an email.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worker = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

test('a paid bill shows a receipt instead of asking for the money again', () => {
  assert.match(worker, /if \(o\.state === "paid"\) return payShell\(/,
    'payPage has no receipt state, so a settled bill renders as a demand');
  assert.match(worker, /<h1>Paid — thank you<\/h1>/);
  assert.match(worker, /cannot be paid again/);
});

test('payLanding actually looks at settled_at', () => {
  // The whole bug was that it did not. Selecting the column is not enough:
  // it has to branch on it before rendering the pay screen.
  assert.match(worker, /l\.crypto_quote, l\.settled_at,/,
    'settled_at is not in the query, so the page cannot know');
  const branch = worker.match(/if \(link\.settled_at\) \{[\s\S]*?\n  \}/);
  assert.ok(branch, 'nothing branches on settled_at');
  assert.match(branch[0], /state: "paid"/);
});

test('reopening a paid bill is never counted as a billable scan', () => {
  const branch = worker.match(/if \(link\.settled_at\) \{[\s\S]*?\n  \}/)[0];
  assert.match(branch, /kind: "receipt_view"/, 'a receipt view needs its own kind');
  assert.ok(!/active: true/.test(branch),
    'a guest rereading their receipt would inflate the venue\'s scan count and ours');
});

test('the receipt gives the guest a reference they can quote', () => {
  assert.match(worker, /Your reference/);
  assert.match(worker, /Quote this if you need to ask/);
});

test('the venue is emailed once per bill, not once per tap of Settle', () => {
  assert.match(worker, /__idem: "billsettled-" \+ bill\.token/,
    'without an idempotency key a double tap sends two receipts for one dinner');
  assert.match(worker, /out\.ok && out\.settled/,
    'the mail must not fire on `already`, which is exactly what a second tap returns');
});

test('settling does not make staff wait on an email', () => {
  // Staff are standing at a table with a guest in front of them.
  assert.match(worker, /ctx\.waitUntil\(\s*\n\s*mailBillSettled\(env, who, b\.token, out\)/);
  assert.match(worker, /\.catch\(\(e\) => console\.error\("billsettled mail threw"/,
    'a failed send must never turn a successful settle into an error');
});

test('a send that does not happen leaves a reason behind', () => {
  // Found the hard way: the first real end-to-end settle in production sent
  // nothing and the outcome was discarded, so there was no way to tell a
  // refused send from one that never ran.
  assert.match(worker, /console\.error\("billsettled mail not sent"/,
    'a failed send must say so — a swallowed error reads as a working feature');
  assert.match(worker, /console\.log\("billsettled mail sent"/,
    'a success needs the provider id, or nobody can find the message later');
  assert.ok(!/mailBillSettled\(env, who, b\.token, out\)\.catch\(\(\) => \{\}\)/.test(worker),
    'the silent catch is back');
});

test('mailBillSettled names which precondition stopped it', () => {
  const fn = worker.match(/async function mailBillSettled\([\s\S]*?\n\}/)[0];
  assert.match(fn, /bill not found: /);
  assert.match(fn, /no address on file for /);
});

test('the venue is told plainly whether NUM will invoice on this bill', () => {
  const fn = worker.match(/async function mailBillSettled\([\s\S]*?\n\}/)[0];
  assert.match(fn, /out\.billed/, 'the email cannot be honest about the fee without checking');
  assert.match(fn, /NUM's 10% applies/);
  assert.match(fn, /NUM charges nothing on it/);
  assert.match(fn, /nothing is charged to you today/,
    'a venue must not read this as money being taken out of the guest\'s payment');
});

test('no address on file means no send, not a crash', () => {
  const fn = worker.match(/async function mailBillSettled\([\s\S]*?\n\}/)[0];
  assert.match(fn, /if \(!bill\.venue_email\) return/,
    'four of six live businesses have no email on file');
});

test('the email carries the figure the statement is calculated from', () => {
  const fn = worker.match(/async function mailBillSettled\([\s\S]*?\n\}/)[0];
  assert.match(fn, /it is the figure your/,
    'the venue needs to know this is its one chance to correct the number');
});
