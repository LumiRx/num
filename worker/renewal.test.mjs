// The leak: "monthly" was a one-off wearing the word.
//
// A Plus member paid $8.98 once, got 30 days, and on day 31 silently dropped
// to free. Nothing charged again, nothing even said so — every subscriber was
// one month of revenue. These tests hold the lifecycle that replaces it:
// Stripe owns the schedule, invoice.paid is the only thing that extends,
// customer.subscription.deleted is the only thing that ends early.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renewsFrom } from './membership.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const pay = readFileSync(join(HERE, 'pay.mjs'), 'utf8');
const membership = readFileSync(join(HERE, 'membership.mjs'), 'utf8');

test('subscribing mints a RECURRING session, not a one-off', () => {
  // The entire bug was this one word. If /subscribe ever routes back through
  // requestPayment, "monthly" becomes a label again.
  const sub = membership.slice(membership.indexOf("path === '/subscribe'"), membership.indexOf("path === '/cancel'"));
  assert.match(sub, /requestSubscription/, '/subscribe is back on the one-off path — subscribers stop recurring');
  assert.ok(!/requestPayment/.test(sub), '/subscribe still calls requestPayment — the one-off leak is back');
  assert.match(pay, /mode: 'subscription'/, 'no checkout is ever created in subscription mode');
  assert.match(pay, /recurring: \{ interval: 'month' \}/, 'the price is not recurring — Stripe will charge once and stop');
});

test('the subscription carries its own name into every future invoice', () => {
  // Invoices reference the subscription, not the session. Without metadata
  // ON the subscription, every renewal arrives anonymous.
  assert.match(pay, /subscription_data: \{\s*metadata/, 'subscription_data.metadata is gone — renewals cannot be attributed');
});

test('grace absorbs the retry window instead of flapping the tier', () => {
  // Stripe retries a failed renewal for days. Without grace: free at midnight
  // on day 30, silently restored on day 32 — entitlements that flap read as a
  // broken product.
  const end = Math.floor(Date.now() / 1000) + 30 * 86400;
  const renews = renewsFrom(end);
  const graceMs = Date.parse(renews + 'Z') - (end * 1000);
  assert.ok(graceMs >= 2.5 * 86400_000, 'the grace window is under 3 days — a retried payment lapses the member mid-retry');
  assert.ok(graceMs <= 4 * 86400_000, 'the grace window has grown — a cancelled member keeps entitlements for free');
  assert.equal(renewsFrom(null), null, 'a missing period end fabricates a date instead of admitting it');
});

test('a renewal extends and a death lapses — and nothing else does either', () => {
  assert.match(pay, /event\.type === 'invoice\.paid'/, 'invoice.paid is unhandled — renewals are collected by Stripe and never granted by us');
  assert.match(pay, /recordRenewal\(env, subId/, 'the paid invoice never reaches recordRenewal');
  assert.match(pay, /event\.type === 'customer\.subscription\.deleted'/, 'a dead subscription never lapses the membership — cancelled members keep paying nothing and keeping everything');
  assert.match(pay, /lapseBySub\(env, sub\.id\)/, 'the deletion event never reaches lapseBySub');
  // A failed payment must NOT lapse — grace covers the retry window.
  const failedBlock = pay.slice(pay.indexOf("'invoice.payment_failed'"), pay.indexOf("'invoice.payment_failed'") + 900);
  assert.ok(!/lapseBySub|tier='free'/.test(failedBlock), 'a single failed payment lapses the member while Stripe is still retrying');
});

test('an unmatched renewal screams instead of shrugging', () => {
  // invoice.paid for a subscription we do not hold means money was taken and
  // nothing was extended. That must be loud enough to reconcile.
  assert.match(membership, /money taken, nothing extended/, 'a renewal that matches no member is silently dropped');
});

test('cancel exists, is honest, and ends at period end', () => {
  assert.match(membership, /path === '\/cancel'/, 'there is no cancel path — churn becomes chargebacks');
  assert.match(pay, /cancel_at_period_end: true/, 'cancellation is immediate — members lose the month they already paid for');
  const cancel = membership.slice(membership.indexOf("path === '/cancel'"));
  assert.match(cancel, /Nothing renews automatically/, 'legacy one-off members are told a lie about having a recurring plan to cancel');
});

test('the underpayment gate covers subscription checkouts too', () => {
  // The subscription session's amount_total is the first invoice — the same
  // fifty-cent trick applies and the same check must sit in front of it.
  const grant = pay.slice(pay.indexOf('tierMatch && memberId'), pay.indexOf('const packMatch'));
  assert.match(grant, /tierPaidRight/, 'subscription grants skip the price check — fifty cents starts a Pro subscription');
  assert.match(grant, /sub: s\.subscription/, 'the subscription id is not stored at grant time — every later invoice.paid will match no member');
});
