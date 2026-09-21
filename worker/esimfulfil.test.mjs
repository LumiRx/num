import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './esimtestdb.mjs';
import * as O from './esimorders.mjs';
import { fulfil, sweep, onDoorbell, refundAndTell } from './esimfulfil.mjs';

const SCHEMA = ['worker/migrations/0033_esim.sql'];
const PLAN = { provider: 'esimaccess', code: 'TH10', dataMb: 10240, unlimited: false, days: 30, costUnits: 40000, costCs: 400, priceCs: 499 };
const GOOD = { iccid: '8985', esimTranNo: 'T1', lpa: 'LPA:1$rsp.redtea.io$ABC', qrUrl: 'https://q/x.png', status: 'GOT_RESOURCE' };

async function paidOrder(db, extra = {}) {
  const { order } = await O.createQuote(db, { plan: PLAN, dest: { label: 'Thailand', country: 'TH' }, phone: '+14155550100', email: 't@example.com', smsOk: true, ...extra });
  await O.markPaid(db, order.id, { sessionId: 'cs_1', paymentIntent: 'pi_1', paidCs: 499 });
  return order;
}

function harness({ order: orderReply, query: queryReply, refund = { ok: true, id: 're_1' }, cancel: cancelReply = { ok: true } } = {}) {
  const log = { orders: [], queries: 0, sms: [], email: [], alerts: [], refunds: [], cancels: [] };
  const driver = {
    id: 'esimaccess',
    ready: () => true,
    order: async (a) => { log.orders.push(a); return typeof orderReply === 'function' ? orderReply(a, log) : orderReply ?? { ok: true, orderNo: 'B1' }; },
    query: async (a) => { log.queries++; return typeof queryReply === 'function' ? queryReply(a, log) : queryReply ?? { ok: true, profiles: [{ ...GOOD, transactionId: null }] }; },
    cancel: async (a) => { log.cancels.push(a); return cancelReply; },
  };
  const deps = {
    origin: 'https://app.itsnum.com',
    driverFor: () => driver,
    notify: {
      sms: async (to, body) => { log.sms.push({ to, body }); return { ok: true }; },
      email: async (to, subject, text) => { log.email.push({ to, subject, text }); return { ok: true }; },
      alert: async (t) => { log.alerts.push(t); },
    },
    refund: async (env, order) => { log.refunds.push(order.id); return refund; },
    sleep: async () => {},
    pollMs: [0, 0],
  };
  return { deps, log };
}

test('happy path: paid -> supplier order -> ready -> text and email with the install link', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db);
  const { deps, log } = harness();
  const r = await fulfil({}, db, order.id, deps);
  assert.equal(r.state, 'ready');
  assert.deepEqual(log.orders, [{ planCode: 'TH10', txnId: order.id, costUnits: 40000 }]);
  const o = await O.getById(db, order.id);
  assert.equal(o.state, 'ready');
  assert.equal(o.lpa, 'LPA:1$rsp.redtea.io$ABC');
  assert.equal(log.sms.length, 1);
  assert.match(log.sms[0].body, new RegExp(`/esim/o/${order.token}`));
  assert.equal(log.email.length, 1);
  assert.ok(o.sms_sent_at && o.email_sent_at);
  assert.equal(log.refunds.length, 0);
});

test('two fulfil calls at once buy exactly one eSIM', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db);
  const { deps, log } = harness();
  await Promise.all([fulfil({}, db, order.id, deps), fulfil({}, db, order.id, deps)]);
  assert.equal(log.orders.length, 1);
});

test('supplier refuses: traveller refunded and told, owner alerted', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db);
  const { deps, log } = harness({ order: { ok: false, kind: 'refused', error: 'package not found' } });
  const r = await fulfil({}, db, order.id, deps);
  assert.equal(r.state, 'refunded');
  assert.deepEqual(log.refunds, [order.id]);
  assert.match(log.sms[0].body, /refunded the full \$4\.99/);
  assert.equal(log.email[0].subject, 'We refunded your Thailand eSIM');
  assert.equal((await O.getById(db, order.id)).state, 'refunded');
});

test('supplier balance empty: refund AND a top-up alert', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db);
  const { deps, log } = harness({ order: { ok: false, kind: 'no_balance', error: 'Insufficient balance' } });
  await fulfil({}, db, order.id, deps);
  assert.ok(log.alerts.some((a) => /Top up/.test(a)));
  assert.equal((await O.getById(db, order.id)).state, 'refunded');
});

test('refund itself fails: order goes to attention and a human is paged', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db);
  const { deps, log } = harness({ order: { ok: false, kind: 'refused', error: 'x' }, refund: { ok: false, error: 'stripe down' } });
  const r = await fulfil({}, db, order.id, deps);
  assert.equal(r.state, 'attention');
  assert.ok(log.alerts.some((a) => /refund FAILED/.test(a)));
  assert.equal(log.sms.length, 0, 'we do not tell them they were refunded when they were not');
});

test('supplier silent: no refund, no second order until the sweep retries with the SAME transaction id', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db);
  let calls = 0;
  const { deps, log } = harness({ order: () => (++calls === 1 ? { ok: false, kind: 'unknown', error: 'timeout' } : { ok: true, orderNo: 'B9' }) });
  const r = await fulfil({}, db, order.id, deps);
  assert.equal(r.state, 'ordering');
  assert.equal(log.refunds.length, 0);
  const early = await sweep({}, db, deps, { now: Date.now() + 5 * 60000 });
  assert.equal(early.retried, 0, 'too soon to retry');
  const later = await sweep({}, db, deps, { now: Date.now() + 11 * 60000 });
  assert.equal(later.retried, 1);
  assert.deepEqual(log.orders.map((o) => o.txnId), [order.id, order.id]);
  assert.equal((await O.getById(db, order.id)).state, 'ready');
});

test('retry that finds the first order existed goes to a human, never a refund', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db);
  let calls = 0;
  const { deps, log } = harness({ order: () => (++calls === 1 ? { ok: false, kind: 'unknown', error: 'timeout' } : { ok: false, kind: 'duplicate', error: 'exists' }) });
  await fulfil({}, db, order.id, deps);
  await sweep({}, db, deps, { now: Date.now() + 11 * 60000 });
  assert.equal((await O.getById(db, order.id)).state, 'attention');
  assert.equal(log.refunds.length, 0);
  assert.ok(log.alerts.some((a) => /already exists/.test(a)));
});

test('allocation arrives later via the supplier doorbell', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db);
  let ready = false;
  const { deps, log } = harness({ query: () => (ready ? { ok: true, profiles: [GOOD] } : { ok: true, profiles: [] }) });
  const r = await fulfil({}, db, order.id, deps);
  assert.equal(r.state, 'ordering');
  ready = true;
  const d = await onDoorbell({}, db, { type: 'ORDER_STATUS', notifyId: 'n1', transactionId: order.id, orderNo: 'B1', orderStatus: 'GOT_RESOURCE' }, deps);
  assert.equal(d.state, 'ready');
  const again = await onDoorbell({}, db, { type: 'ORDER_STATUS', notifyId: 'n1', transactionId: order.id, orderNo: 'B1' }, deps);
  assert.equal(again.duplicate, true);
  assert.equal(log.sms.length, 1, 'delivered once');
});

test('a forged doorbell cannot attach someone else\'s eSIM to an order', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db);
  const { deps, log } = harness({ order: { ok: false, kind: 'unknown', error: 't' }, query: { ok: true, profiles: [{ ...GOOD, transactionId: 'eso_somebody_else' }] } });
  await fulfil({}, db, order.id, deps);
  const d = await onDoorbell({}, db, { type: 'ORDER_STATUS', notifyId: 'n9', transactionId: order.id, orderNo: 'B-OTHER' }, deps);
  assert.equal(d.state, 'attention');
  assert.equal(log.sms.length, 0);
  assert.equal((await O.getById(db, order.id)).lpa, null);
});

test('a malformed activation code is never sent to a traveller', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db);
  const { deps, log } = harness({ query: { ok: true, profiles: [{ ...GOOD, lpa: 'javascript:alert(1)' }] } });
  const r = await fulfil({}, db, order.id, deps);
  assert.equal(r.state, 'attention');
  assert.equal(log.sms.length, 0);
});

test('an hour with no allocation pages a human', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db);
  const { deps, log } = harness({ query: { ok: true, profiles: [] } });
  await fulfil({}, db, order.id, deps);
  await sweep({}, db, deps, { now: Date.now() + 61 * 60000 });
  assert.equal((await O.getById(db, order.id)).state, 'attention');
  assert.ok(log.alerts.some((a) => /in an hour/.test(a)));
});

test('the sweep fulfils a paid order the webhook never started', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db);
  const { deps } = harness();
  const rep = await sweep({}, db, deps, { now: Date.now() + 3 * 60000 });
  assert.equal(rep.fulfilled, 1);
  assert.equal((await O.getById(db, order.id)).state, 'ready');
});

test('no texting without consent: web order without the box ticked gets email only', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db, { smsOk: false, channel: 'web' });
  const { deps, log } = harness();
  await fulfil({}, db, order.id, deps);
  assert.equal(log.sms.length, 0);
  assert.equal(log.email.length, 1);
});

test('a traveller who texted us gets the reply by text', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db, { smsOk: false, channel: 'sms', email: null });
  const { deps, log } = harness();
  await fulfil({}, db, order.id, deps);
  assert.equal(log.sms.length, 1);
});

// ---- found by the adversarial review, 21 Sep ----------------------------------------

test('RETRY: after an unanswered first call, a "no" goes to a person, never to an automatic refund', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db);
  let calls = 0;
  const { deps, log } = harness({ order: () => (++calls === 1 ? { ok: false, kind: 'unknown', error: 'timeout' } : { ok: false, kind: 'refused', error: 'rate limited' }) });
  await fulfil({}, db, order.id, deps);
  await sweep({}, db, deps, { now: Date.now() + 11 * 60000 });
  const now = await O.getById(db, order.id);
  assert.equal(now.state, 'attention');
  assert.equal(log.refunds.length, 0, 'the first call may have bought the eSIM');
  assert.ok(log.alerts.some((a) => a.includes(`look up transaction ${order.id}`)));
});

test('the first call refused outright is still refunded automatically (nothing was bought)', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db);
  const { deps, log } = harness({ order: { ok: false, kind: 'refused', error: 'package offline' } });
  const r = await fulfil({}, db, order.id, deps);
  assert.equal(r.state, 'refunded');
  assert.equal(log.refunds.length, 1);
});

test('a refund never races a delivery: if the order moved on, nothing is refunded', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db);
  const { deps, log } = harness();
  await fulfil({}, db, order.id, deps);
  assert.equal((await O.getById(db, order.id)).state, 'ready');
  const stale = { ...order, state: 'ordering' };
  const r = await refundAndTell({}, db, stale, 'ordering', 'stale copy', deps);
  assert.ok(r.skipped);
  assert.equal(r.state, 'ready');
  assert.equal(log.refunds.length, 0);
});

test('a refund claimed but never finished is finished by the sweep, once', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db);
  assert.equal(await O.claimRefund(db, order.id, 'paid', 'supplier refused'), true);
  const { deps, log } = harness();
  const early = await sweep({}, db, deps, { now: Date.now() + 2 * 60000 });
  assert.equal(early.refundsResumed, 0, 'too soon: the first worker may still be finishing it');
  const later = await sweep({}, db, deps, { now: Date.now() + 11 * 60000 });
  assert.equal(later.refundsResumed, 1);
  assert.equal((await O.getById(db, order.id)).state, 'refunded');
  assert.equal(log.refunds.length, 1);
  assert.equal(log.sms.length, 1, 'the traveller is told');
  const again = await sweep({}, db, deps, { now: Date.now() + 30 * 60000 });
  assert.equal(again.refundsResumed, 0);
});

test('a profile that arrives after a refund is cancelled with the supplier, never sent', async () => {
  const db = d1(SCHEMA);
  const order = await paidOrder(db);
  const { deps, log } = harness({ order: { ok: true, orderNo: 'B7' }, query: { ok: true, profiles: [] } });
  await fulfil({}, db, order.id, deps);
  assert.equal((await O.getById(db, order.id)).state, 'ordering');
  const r = await refundAndTell({}, db, await O.getById(db, order.id), 'ordering', 'refunded by Num', deps);
  assert.equal(r.state, 'refunded');
  const late = harness({ query: { ok: true, profiles: [{ ...GOOD, esimTranNo: 'T7' }] } });
  const d = await onDoorbell({}, db, { type: 'ORDER_STATUS', notifyId: 'n77', transactionId: order.id, orderNo: 'B7' }, late.deps);
  assert.deepEqual(late.log.cancels, [{ esimTranNo: 'T7' }]);
  assert.equal(late.log.sms.length, 0);
  assert.ok(late.log.alerts.some((a) => /after the order was refunded/.test(a)));
  assert.equal(d.state, 'refunded');
  assert.equal(log.refunds.length, 1);
});
