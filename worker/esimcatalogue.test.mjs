import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceCatalogue, plansForCountry, plansForRegion, picks, planLabel, dataLabel, fromPriceCs, dedupe } from './esimcatalogue.mjs';

const P = (o) => ({ provider: 'esimaccess', code: o.code, name: o.code, costCs: o.cost, retailCs: o.retail ?? null, dataMb: o.mb ?? null, unlimited: !!o.unl, daily: !!o.daily, days: o.days, countries: o.c, scope: o.c.length <= 1 ? 'local' : o.c.length >= 40 ? 'global' : 'regional', networks: [] });

const RAW = [
  P({ code: 'th1', cost: 70, mb: 1024, days: 7, c: ['TH'] }),
  P({ code: 'th5', cost: 250, mb: 5120, days: 30, c: ['TH'] }),
  P({ code: 'th10', cost: 400, mb: 10240, days: 30, c: ['TH'], retail: 1100 }),
  P({ code: 'th20', cost: 700, mb: 20480, days: 30, c: ['TH'] }),
  P({ code: 'thday', cost: 50, mb: 1024, days: 1, c: ['TH'], daily: true }),
  P({ code: 'asia', cost: 900, mb: 10240, days: 30, c: ['TH', 'VN', 'MY', 'SG', 'ID', 'PH', 'KH'] }),
  P({ code: 'eu', cost: 900, mb: 10240, days: 30, c: ['FR', 'DE', 'IT', 'ES', 'NL', 'BE', 'PT', 'GR'] }),
  P({ code: 'dup', cost: 500, mb: 10240, days: 30, c: ['TH'] }),
];

test('pricing drops per-day plans and keeps honest prices', () => {
  const priced = priceCatalogue(RAW);
  assert.ok(!priced.some((p) => p.code === 'thday'));
  for (const p of priced) assert.ok(p.priceCs > p.costCs, p.code);
});

test('a country gets its local plans, cheapest of any duplicate, before wider plans', () => {
  const plans = plansForCountry('TH', priceCatalogue(RAW));
  const codes = plans.map((p) => p.code);
  assert.ok(codes.includes('th10') && !codes.includes('dup'), 'duplicate 10GB/30d keeps the cheaper one');
  assert.equal(plans[0].scope, 'local');
  assert.ok(!codes.includes('asia'), 'a pricier Asia plan giving no more is not shown in Thailand');
});

test('a regional plan appears where no local plan exists', () => {
  const plans = plansForCountry('KH', priceCatalogue(RAW));
  assert.deepEqual(plans.map((p) => p.code), ['asia']);
  assert.deepEqual(plansForCountry('ZZ', priceCatalogue(RAW)), []);
});

test('region requests get multi-country plans', () => {
  const eu = plansForRegion('EU', priceCatalogue(RAW)).map((p) => p.code);
  assert.deepEqual(eu, ['eu']);
  const as = plansForRegion('AS', priceCatalogue(RAW)).map((p) => p.code);
  assert.deepEqual(as, ['asia']);
});

test('three distinct picks, small to large', () => {
  const pk = picks(plansForCountry('TH', priceCatalogue(RAW)));
  assert.equal(pk.length, 3);
  assert.equal(new Set(pk.map((p) => p.code)).size, 3);
  assert.ok(pk[0].dataMb <= pk[1].dataMb && pk[1].dataMb <= pk[2].dataMb);
});

test('labels', () => {
  assert.equal(planLabel({ dataMb: 10240, days: 30 }), '10 GB · 30 days');
  assert.equal(planLabel({ dataMb: 512, days: 1 }), '512 MB · 1 day');
  assert.equal(dataLabel({ unlimited: true }), 'Unlimited');
  assert.equal(dataLabel({ dataMb: 1536 }), '1.5 GB');
});

test('from-price', () => {
  assert.equal(fromPriceCs([]), null);
  assert.equal(fromPriceCs([{ priceCs: 500 }, { priceCs: 199 }]), 199);
});

test('dedupe is by what the traveller gets', () => {
  assert.equal(dedupe([{ dataMb: 1, days: 1, scope: 'local', unlimited: false, priceCs: 2 }, { dataMb: 1, days: 1, scope: 'local', unlimited: false, priceCs: 1 }])[0].priceCs, 1);
});
