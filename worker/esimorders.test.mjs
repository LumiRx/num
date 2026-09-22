import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './esimtestdb.mjs';
import * as O from './esimorders.mjs';
import { refreshCatalogue, plansIn, planByCode, countryIndex, catalogueStatus } from './esimstore.mjs';

const SCHEMA = ['worker/migrations/0064_esim.sql'];
const PLAN = { provider: 'esimaccess', code: 'TH10', name: 'Thailand 10GB', scope: 'local', countries: ['TH'], dataMb: 10240, unlimited: false, days: 30, costUnits: 40000, costCs: 400, retailCs: 1100, priceCs: 499 };

test('quote -> checkout -> paid -> ordering -> ready, each step once', async () => {
  const db = d1(SCHEMA);
  const q = await O.createQuote(db, { plan: PLAN, dest: { label: 'Thailand', country: 'TH' }, phone: '+14155550100', smsOk: true, channel: 'sms' });
  assert.equal(q.ok, true);
  const o = q.order;
  assert.equal(o.state, 'quoted');
  assert.equal(o.price_cs, 499);
  assert.equal(o.plan_label, '10 GB · 30 days');
  assert.match(o.id, /^eso_[0-9a-f]{16}$/);
  assert.match(o.token, /^[A-Za-z0-9_-]{24}$/);

  assert.equal(await O.markCheckout(db, o.id, 'cs_1'), true);
  assert.equal(await O.markPaid(db, o.id, { sessionId: 'cs_1', paymentIntent: 'pi_1', paidCs: 499, email: 'A@B.co' }), true);
  assert.equal(await O.markPaid(db, o.id, { sessionId: 'cs_1', paymentIntent: 'pi_1', paidCs: 499 }), false, 'a repeated webhook changes nothing');
  assert.equal((await O.getById(db, o.id)).email, 'a@b.co');

  const [a, b] = await Promise.all([O.claimForOrdering(db, o.id), O.claimForOrdering(db, o.id)]);
  assert.equal([a, b].filter(Boolean).length, 1, 'exactly one claimant');

  await O.saveSupplierOrder(db, o.id, 'B1');
  assert.equal(await O.markReady(db, o.id, { iccid: '89', esimTranNo: 'T1', lpa: 'LPA:1$rsp.redtea.io$X', qrUrl: 'https://q/x.png' }), true);
  const done = await O.getByToken(db, o.token);
  assert.equal(done.state, 'ready');
  assert.equal(done.lpa, 'LPA:1$rsp.redtea.io$X');
});

test('a quote refuses a plan that is not sellable, and never takes a client price', async () => {
  const db = d1(SCHEMA);
  assert.equal((await O.createQuote(db, { plan: { ...PLAN, priceCs: 10 }, dest: {} })).ok, false);
  assert.equal((await O.createQuote(db, { plan: { ...PLAN, costUnits: 0 }, dest: {} })).ok, false);
});

test('bad contact details are dropped, not stored', async () => {
  const db = d1(SCHEMA);
  const q = await O.createQuote(db, { plan: PLAN, dest: {}, phone: '0812345678', email: 'nope', smsOk: true });
  assert.equal(q.order.phone, null);
  assert.equal(q.order.email, null);
  assert.equal(q.order.sms_ok, 0, 'no texting consent without a valid number');
});

test('token lookups reject junk', async () => {
  const db = d1(SCHEMA);
  assert.equal(await O.getByToken(db, "x' OR 1=1 --"), null);
  assert.equal(await O.getByToken(db, 'short'), null);
});

test('stuck orders and expiry', async () => {
  const db = d1(SCHEMA);
  const { order } = await O.createQuote(db, { plan: PLAN, dest: {} });
  await O.markPaid(db, order.id, { paidCs: 499 });
  const future = new Date(Date.now() + 60000).toISOString();
  const stuck = await O.stuckOrders(db, { paidOlderThanIso: future, orderingOlderThanIso: future });
  assert.equal(stuck.length, 1);
  const { order: q2 } = await O.createQuote(db, { plan: PLAN, dest: {} });
  await O.expireQuotes(db, future);
  assert.equal((await O.getById(db, q2.id)).state, 'expired');
  assert.equal((await O.getById(db, order.id)).state, 'paid', 'a paid order never expires');
});

test('menus expire, doorbell dedupes', async () => {
  const db = d1(SCHEMA);
  await O.saveMenu(db, '+1', 'pick', { a: 1 }, { ttlMin: 30, now: 1000 });
  assert.deepEqual(await O.getMenu(db, '+1', { now: 2000 }), { stage: 'pick', data: { a: 1 } });
  assert.equal(await O.getMenu(db, '+1', { now: 1000 + 31 * 60000 }), null);
  assert.equal(await O.firstRing(db, 'n1', 'ORDER_STATUS'), true);
  assert.equal(await O.firstRing(db, 'n1', 'ORDER_STATUS'), false);
});

test('rate counting', async () => {
  const db = d1(SCHEMA);
  for (let i = 0; i < 3; i++) await O.createQuote(db, { plan: PLAN, dest: {}, phone: '+14155550100', ipHash: 'ip1' });
  const since = new Date(Date.now() - 3600e3).toISOString();
  assert.equal(await O.countRecent(db, { phone: '+14155550100', sinceIso: since }), 3);
  assert.equal(await O.countRecent(db, { ipHash: 'ip1', sinceIso: since }), 3);
  assert.equal(await O.countRecent(db, { phone: '+14155550100', sinceIso: since, paidOnly: true }), 0);
});

// ---- listing cache ----
const driver = (plans, ok = true) => ({ id: 'esimaccess', ready: () => true, packages: async () => (ok ? { ok: true, plans } : { ok: false, error: 'down' }) });
const mk = (code, c, mb, days, cost) => ({ provider: 'esimaccess', code, name: code, costUnits: cost * 100, costCs: cost, retailCs: null, dataMb: mb, unlimited: false, daily: false, days, activateWithinDays: 180, countries: c, scope: c.length <= 1 ? 'local' : 'regional', topup: false, networks: ['AIS 5G'] });
const many = () => [mk('TH10', ['TH'], 10240, 30, 400), mk('TH1', ['TH'], 1024, 7, 70), mk('JP5', ['JP'], 5120, 15, 300), mk('ASIA', ['TH', 'VN', 'KH', 'LA', 'MY'], 10240, 30, 900), ...Array.from({ length: 20 }, (_, i) => mk(`X${i}`, ['FR'], 1024 * (i + 1), 30, 100 + i))];

test('refresh stores priced plans and a country index', async () => {
  const db = d1(SCHEMA);
  const r = await refreshCatalogue(db, [driver(many())]);
  assert.equal(r.ok, true);
  const th = await plansIn(db, { country: 'TH' });
  assert.ok(th.find((p) => p.code === 'TH10'));
  for (const p of th) assert.ok(p.priceCs > p.costCs);
  const kh = await plansIn(db, { country: 'KH' });
  assert.deepEqual(kh.map((p) => p.code), ['ASIA']);
  const idx = await countryIndex(db);
  assert.ok(idx.find((x) => x.country === 'TH' && x.from_cs > 0));
  assert.equal((await planByCode(db, 'esimaccess', 'JP5')).days, 15);
  assert.equal((await catalogueStatus(db)).plans, 24);
});

test('a failed or tiny supplier fetch never empties the shop', async () => {
  const db = d1(SCHEMA);
  await refreshCatalogue(db, [driver(many())]);
  await refreshCatalogue(db, [driver([], false)]);
  assert.equal((await catalogueStatus(db)).plans, 24);
  await refreshCatalogue(db, [driver([mk('ONLY', ['TH'], 1024, 7, 70)])]);
  assert.equal((await catalogueStatus(db)).plans, 24);
});

test('plans that vanish from the supplier are removed on the next good refresh', async () => {
  const db = d1(SCHEMA);
  await refreshCatalogue(db, [driver(many())]);
  await new Promise((r) => setTimeout(r, 5));
  await refreshCatalogue(db, [driver(many().filter((p) => p.code !== 'JP5'))]);
  assert.equal(await planByCode(db, 'esimaccess', 'JP5'), null);
});

test('country lookups are safe against odd input', async () => {
  const db = d1(SCHEMA);
  assert.deepEqual(await plansIn(db, { country: "T' OR 1" }), []);
});
