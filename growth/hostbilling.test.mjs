// TWO WORKERS, ONE PRICE.
//
// The price a host is SHOWN comes from growth/worker.js (num-growth, on
// itsnum.com). The price a host is CHARGED comes from worker/hostmoney.mjs
// (num-app, on app.itsnum.com), in pence, because that is what mints the
// Stripe checkout session.
//
// They are separate workers on separate hostnames and cannot import each
// other, so the number exists twice. This file is the only thing standing
// between that and a host reading £9.99 on the page while Stripe charges them
// something else — which is not a display bug, it is a chargeback and a
// complaint from the kind of person whose whole business is trust.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HOST_PLANS, HOST_CURRENCY } from '../worker/hostmoney.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const worker = read('growth/worker.js');

/** The shown-price table, parsed out of the growth worker. */
function shownPence() {
  const m = worker.match(/const HOST_TIER_PENCE\s*=\s*\{([^}]*)\}/);
  assert.ok(m, 'HOST_TIER_PENCE is gone from growth/worker.js — the console can no longer state a price');
  const out = {};
  for (const [, k, v] of m[1].matchAll(/(\w+)\s*:\s*(\d+)/g)) out[k] = Number(v);
  return out;
}

test('every charged plan is shown at exactly the price it charges', () => {
  const shown = shownPence();
  for (const [tier, plan] of Object.entries(HOST_PLANS)) {
    assert.equal(shown[tier], plan.pence,
      `${tier}: the console shows ${shown[tier]}p and Stripe charges ${plan.pence}p`);
  }
});

test('the human-readable price agrees with the pence it is charged', () => {
  // A host reads "£9.99/mo", not 999. If the two drift, the number they were
  // shown is the one they will quote back at us.
  const m = worker.match(/const HOST_TIER_PRICE\s*=\s*\{([^}]*)\}/);
  assert.ok(m, 'HOST_TIER_PRICE is gone');
  const labels = {};
  for (const [, k, v] of m[1].matchAll(/(\w+)\s*:\s*"([^"]*)"/g)) labels[k] = v;

  for (const [tier, plan] of Object.entries(HOST_PLANS)) {
    const digits = (labels[tier] || '').replace(/[^0-9.]/g, '');
    assert.ok(digits, `${tier} has no readable price label`);
    assert.equal(Math.round(parseFloat(digits) * 100), plan.pence,
      `${tier}: label says "${labels[tier]}" but Stripe charges ${plan.pence}p`);
  }
  assert.equal(labels.free, 'Free', 'the free plan is no longer labelled Free');
});

test('free is free on both sides', () => {
  assert.equal(shownPence().free, 0, 'the free plan has a price');
  assert.ok(!('free' in HOST_PLANS), 'free is a purchasable plan in hostmoney — it must not be');
});

test('the plan is charged in the currency the page quotes', () => {
  assert.equal(HOST_CURRENCY, 'gbp', 'the plan currency moved — the console still writes £');
  assert.match(worker, /HOST_TIER_PRICE\s*=\s*\{[^}]*£/, 'the console no longer quotes in pounds');
});

test('the booking fee is one number across both workers', () => {
  // growth/worker.js imports it from worker/servicefee.mjs, and hostmoney's
  // sweep has its own floor. They are allowed to differ in meaning — one is
  // the fee, one is the minimum worth invoicing — but the fee itself must have
  // exactly one definition.
  const sweep = read('worker/hostmoney.mjs');
  const defs = (sweep.match(/booking_fee_minor\s*=\s*\d+/g) || []);
  assert.equal(defs.length, 0,
    'hostmoney.mjs sets a booking fee of its own — the fee is defined in worker/servicefee.mjs');
  assert.match(worker, /import \{ BOOKING_FEE_MINOR \} from '\.\.\/worker\/servicefee\.mjs'/,
    'the growth worker no longer reads the fee from its one definition');
});

/* ── THE FREE UPGRADE BUTTON ─────────────────────────────────────────────
 * `tier` used to arrive in the profile body and get written straight to
 * num_hosts.tier. That was harmless while a tier was a note about what a host
 * intended to buy. It became a free upgrade button the moment FEATURE_MIN_TIER
 * started gating the network, introductions and products on that same column:
 * anyone holding a console key could POST {"tier":"full"} and unlock the lot. */
test('a host cannot set their own plan', () => {
  const prof = worker.slice(worker.indexOf('async function hostProfile'), worker.indexOf('async function hostSummary'));
  assert.ok(!/HOST_TIERS\.indexOf\(String\(b\.tier/.test(prof),
    'the profile endpoint reads tier from the request body — that is a free upgrade');
  assert.match(prof, /const tier = \(row && HOST_TIER_PRICE\[row\.tier\] !== undefined\) \? row\.tier : "free"/,
    'the profile endpoint no longer carries the current tier through unchanged');
  // And the console must not send it either, or a stale form silently downgrades.
  const page = read('public/host/index.html');
  assert.ok(!/tier: \$\('tier'\)\.value/.test(page), 'the console still posts a tier with the profile');
  assert.ok(!/<select id="tier"/.test(page), 'the plan is still a dropdown the host can set');
});

test('a plan changes only where money changes hands', () => {
  const money = read('worker/hostmoney.mjs');
  // grantHostTier on a webhook, lapseHostBySub on cancellation. Those two, and
  // hostClose setting plan_status='cancelled' when a host leaves entirely.
  const writes = (worker.match(/SET[^`"']*\btier\s*=/g) || []).length;
  assert.equal(writes, 1, `growth/worker.js writes num_hosts.tier in ${writes} places — it should only carry it through`);
  assert.match(money, /export async function grantHostTier/, 'the paid grant path is gone');
  assert.match(money, /export async function lapseHostBySub/, 'the cancellation path is gone');
});

test('the console can actually reach billing, which lives on another host', () => {
  // The console is served from itsnum.com by num-growth. The plan endpoints are
  // on app.itsnum.com in num-app. Nothing about that is obvious from the page,
  // so it is pinned: a relative call here would 404 forever and look like a
  // broken button.
  const page = read('public/host/index.html');
  assert.match(page, /var PLAN_API = 'https:\/\/app\.itsnum\.com\/api\/host'/,
    'the plan calls are no longer absolute — they will hit num-growth and 404');
  for (const p of ['/plan?k=', '/plan/subscribe?k=', '/plan/cancel?k=']) {
    assert.ok(page.includes(p), `the console never calls ${p}`);
  }
  assert.match(page, /billing_on === false/, 'the console offers checkout even when billing is switched off');
});

test('the console explains the fees it used to charge, rather than hiding them', () => {
  // Was: "the host is told a booking fee cannot be collected without a card".
  // The per-booking fee was removed on 7 Sep 2026, so the uncollectable-fee
  // problem went with it. What is left is a host who may have accrued fees
  // before the change and already seen the number — a figure that silently
  // disappears from a page someone has read is worse than one explained.
  const page = read('public/host/index.html');
  assert.match(page, /before we removed them/i,
    'the console does not explain historical fees a host may already have seen');
  assert.match(page, /never collected and never will be/i,
    'the console does not say the old fees were never taken');
  assert.match(page, /no per-booking fee now/i,
    'the console does not state that there is no fee any more');

  const integ = read('worker/hostintegrity.mjs');
  assert.match(integ, /fee_charged_after_it_was_removed/,
    'nothing reports a per-booking fee creeping back in');
  assert.ok(!/fees_with_no_way_to_charge/.test(integ),
    'the uncollectable-fee check is still running — with no fee it can only produce noise');
});

test('the subscription is the only thing that charges a host', () => {
  // One revenue line. If a second appears, it appears here first.
  const money = read('worker/hostmoney.mjs');
  const refs = money.match(/ref: `host[a-z]+:/g) || [];
  assert.deepEqual([...new Set(refs)], ['ref: `hosttier:'],
    `hostmoney mints more than one kind of charge: ${refs.join(', ')}`);
});
