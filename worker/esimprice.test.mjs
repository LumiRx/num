import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, breakEvenCs, pricingConfig, feeFor, roundUp9, roundDown9, usd, STRIPE_MIN_CS } from './esimprice.mjs';

const cfg = pricingConfig({});

test('break-even really breaks even after the card fee, for every cost', () => {
  for (let cost = 1; cost <= 5000; cost += 7) {
    const be = breakEvenCs(cost, cfg);
    assert.ok(be - feeFor(be, cfg) >= cost - 1, `cost ${cost}: be ${be} fee ${feeFor(be, cfg)}`);
  }
});

test('default price never loses money, for every cost', () => {
  for (let cost = 1; cost <= 5000; cost += 3) {
    const p = priceFor({ costCs: cost });
    assert.equal(p.ok, true);
    assert.ok(p.marginCs >= 0, `cost ${cost} -> price ${p.priceCs} margin ${p.marginCs}`);
    assert.ok(p.priceCs >= STRIPE_MIN_CS);
    assert.equal(p.priceCs % 10, 9, 'ends in 9');
    assert.equal(p.subsidised, false);
  }
});

test('a $4.00 plan prices under $5 — far below the big-brand $10-12', () => {
  const p = priceFor({ costCs: 400 });
  assert.equal(p.priceCs, 499);
  assert.ok(p.marginCs > 0 && p.marginCs < 60, `thin margin, got ${p.marginCs}`);
});

test('price is capped under the supplier suggested retail', () => {
  const p = priceFor({ costCs: 400, retailCs: 480 });
  assert.equal(p.ok, true);
  assert.equal(p.cappedAtRetail, true);
  assert.ok(p.priceCs < 480);
  assert.ok(p.marginCs >= 0);
});

test('a plan we could only sell above retail is not listed', () => {
  const p = priceFor({ costCs: 400, retailCs: 420 });
  assert.equal(p.ok, false);
  assert.equal(p.reason, 'above_retail');
});

test('subsidy only when explicitly set, and bounded by the setting', () => {
  const env = { ESIM_MAX_LOSS_CS: '100' };
  for (let cost = 60; cost <= 3000; cost += 11) {
    const p = priceFor({ costCs: cost }, env);
    const be = breakEvenCs(cost, pricingConfig(env));
    assert.ok(p.priceCs >= Math.max(STRIPE_MIN_CS, be - 100), `cost ${cost}`);
    assert.ok(p.priceCs - p.costCs - p.feeCs >= -110, 'loss never beyond the cap (plus rounding)');
  }
});

test('margin knobs: zero margin sells at break-even', () => {
  const p = priceFor({ costCs: 400 }, { ESIM_MARGIN_PCT: '0', ESIM_MIN_MARGIN_CS: '0' });
  assert.equal(p.priceCs, roundUp9(breakEvenCs(400, cfg)));
  assert.ok(p.marginCs >= 0);
});

test('refuses to price without a cost', () => {
  assert.equal(priceFor({}).ok, false);
  assert.equal(priceFor({ costCs: 0 }).ok, false);
  assert.equal(priceFor({ costCs: 'abc' }).ok, false);
});

test('rounding helpers', () => {
  assert.equal(roundUp9(437), 439);
  assert.equal(roundUp9(439), 439);
  assert.equal(roundUp9(440), 449);
  assert.equal(roundDown9(1100), 1099);
  assert.equal(roundDown9(1095), 1089);
});

test('usd formats cents', () => {
  assert.equal(usd(499), '$4.99');
  assert.equal(usd(5), '$0.05');
  assert.equal(usd(1200), '$12.00');
});

test('bad env values fall back to safe defaults', () => {
  const c = pricingConfig({ ESIM_FEE_PCT: 'x', ESIM_MARGIN_PCT: '-3' });
  assert.equal(c.feePct, 4.4);
  assert.equal(c.marginPct, 10);
});
