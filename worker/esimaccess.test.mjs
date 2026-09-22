import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esimAccessDriver, normalisePackage, normaliseProfile, parseWebhook, unitsToCents, classifyFailure } from './esimaccess.mjs';

// Shapes copied from eSIM Access's published examples.
const PKG = {
  packageCode: 'CKH491', name: 'Thailand 10GB 30Days', price: 40000, retailPrice: 110000, currencyCode: 'USD',
  volume: 10737418240, unusedValidTime: 180, duration: 30, durationUnit: 'DAY', location: 'TH',
  description: 'Thailand 10GB 30Days', activeType: 1, dataType: 1, supportTopUpType: 2,
  locationNetworkList: [{ locationName: 'Thailand', operatorList: [{ operatorName: 'AIS', networkType: '5G' }, { operatorName: 'TrueMove H', networkType: '5G' }] }],
};

function fakeFetch(routes, calls = []) {
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const path = url.replace(/^https:\/\/api\.esimaccess\.com\/api\/v1\/open/, '');
    const h = routes[path];
    if (!h) return new Response(JSON.stringify({ success: false, errorCode: '404', errorMsg: 'no route' }), { status: 200 });
    const out = typeof h === 'function' ? h(JSON.parse(init.body)) : h;
    if (out instanceof Error) throw out;
    return new Response(typeof out === 'string' ? out : JSON.stringify(out), { status: out?.__status || 200 });
  };
}

test('money units: 1/10,000 USD, rounded UP to cents', () => {
  assert.equal(unitsToCents(18000), 180);
  assert.equal(unitsToCents(18001), 181);
  assert.equal(unitsToCents(0), 0);
});

test('normalises a package', () => {
  const p = normalisePackage(PKG);
  assert.equal(p.code, 'CKH491');
  assert.equal(p.costCs, 400);
  assert.equal(p.retailCs, 1100);
  assert.equal(p.dataMb, 10240);
  assert.equal(p.days, 30);
  assert.deepEqual(p.countries, ['TH']);
  assert.equal(p.scope, 'local');
  assert.equal(p.daily, false);
  assert.equal(p.activateWithinDays, 180);
  assert.deepEqual(p.networks, ['AIS 5G', 'TrueMove H 5G']);
});

test('regional and global scope from the location list', () => {
  assert.equal(normalisePackage({ ...PKG, location: 'US,CA' }).scope, 'regional');
  const many = Array.from({ length: 60 }, (_, i) => String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26))).join(',');
  assert.equal(normalisePackage({ ...PKG, location: many }).scope, 'global');
});

test('drops packages it cannot sell honestly', () => {
  assert.equal(normalisePackage({ ...PKG, currencyCode: 'EUR' }), null);
  assert.equal(normalisePackage({ ...PKG, price: 0 }), null);
  assert.equal(normalisePackage({ ...PKG, packageCode: '' }), null);
  assert.equal(normalisePackage(null), null);
  assert.equal(normalisePackage({ ...PKG, dataType: 2 }).daily, true);
});

test('package list sends the documented request with the access code header', async () => {
  const calls = [];
  const d = esimAccessDriver({ ESIMACCESS_ACCESS_CODE: 'AC1' }, { fetchImpl: fakeFetch({ '/package/list': { success: true, obj: { packageList: [PKG, { junk: 1 }] } } }, calls) });
  const r = await d.packages({ country: 'TH' });
  assert.equal(r.ok, true);
  assert.equal(r.plans.length, 1);
  assert.equal(r.dropped, 1);
  assert.equal(calls[0].init.headers['RT-AccessCode'], 'AC1');
  assert.deepEqual(calls[0].body, { locationCode: 'TH', type: 'BASE', packageCode: '', iccid: '' });
});

test('order sends our order id as the transaction id and the cost as price', async () => {
  const calls = [];
  const d = esimAccessDriver({ ESIMACCESS_ACCESS_CODE: 'AC1' }, { fetchImpl: fakeFetch({ '/esim/order': { success: true, obj: { orderNo: 'B2309' } } }, calls) });
  const r = await d.order({ planCode: 'CKH491', txnId: 'eso_1', costUnits: 40000 });
  assert.deepEqual(r, { ok: true, orderNo: 'B2309' });
  assert.deepEqual(calls[0].body, { transactionId: 'eso_1', amount: 40000, packageInfoList: [{ packageCode: 'CKH491', count: 1, price: 40000 }] });
});

test('order failures are classified so the caller knows whether to refund', async () => {
  const mk = (reply) => esimAccessDriver({ ESIMACCESS_ACCESS_CODE: 'x' }, { fetchImpl: fakeFetch({ '/esim/order': reply }) });
  assert.equal((await mk({ success: false, errorCode: '200007', errorMsg: 'Insufficient balance' }).order({ planCode: 'a', txnId: 't', costUnits: 1 })).kind, 'no_balance');
  assert.equal((await mk({ success: false, errorCode: '200010', errorMsg: 'transactionId already exists' }).order({ planCode: 'a', txnId: 't', costUnits: 1 })).kind, 'duplicate');
  assert.equal((await mk({ success: false, errorCode: '200005', errorMsg: 'package not found' }).order({ planCode: 'a', txnId: 't', costUnits: 1 })).kind, 'refused');
  assert.equal((await mk(new TypeError('fetch failed')).order({ planCode: 'a', txnId: 't', costUnits: 1 })).kind, 'unknown');
  assert.equal((await mk('<html>502</html>').order({ planCode: 'a', txnId: 't', costUnits: 1 })).kind, 'unknown');
});

test('never calls out without credentials', async () => {
  const calls = [];
  const d = esimAccessDriver({}, { fetchImpl: fakeFetch({}, calls) });
  assert.equal(d.ready(), false);
  const r = await d.order({ planCode: 'a', txnId: 't', costUnits: 1 });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

test('query returns install material', async () => {
  const d = esimAccessDriver({ ESIMACCESS_ACCESS_CODE: 'x' }, { fetchImpl: fakeFetch({ '/esim/query': { success: true, obj: { esimList: [{ iccid: '8985', esimTranNo: 'T1', orderNo: 'B2309', transactionId: 'eso_1', ac: 'LPA:1$rsp.redtea.io$ABC', qrCodeUrl: 'https://p.qrsim.net/x.png', esimStatus: 'GOT_RESOURCE', smdpStatus: 'RELEASED', totalVolume: 10737418240 }] } } }) });
  const r = await d.query({ orderNo: 'B2309' });
  assert.equal(r.ok, true);
  assert.equal(r.profiles[0].lpa, 'LPA:1$rsp.redtea.io$ABC');
  assert.equal(r.profiles[0].qrUrl, 'https://p.qrsim.net/x.png');
});

test('an http QR url is not trusted', () => {
  assert.equal(normaliseProfile({ qrCodeUrl: 'http://x/y.png' }).qrUrl, null);
});

test('balance in cents', async () => {
  const d = esimAccessDriver({ ESIMACCESS_ACCESS_CODE: 'x' }, { fetchImpl: fakeFetch({ '/balance/query': { success: true, obj: { balance: 1234500 } } }) });
  assert.deepEqual(await d.balance(), { ok: true, balanceCs: 12345 });
});

test('webhook is parsed as a doorbell only', () => {
  const w = parseWebhook({ notifyType: 'ORDER_STATUS', notifyId: 'n1', content: { orderNo: 'B2309', transactionId: 'eso_1', orderStatus: 'GOT_RESOURCE' } });
  assert.deepEqual(w, { type: 'ORDER_STATUS', notifyId: 'n1', transactionId: 'eso_1', orderNo: 'B2309', esimTranNo: null, iccid: null, orderStatus: 'GOT_RESOURCE', esimStatus: null });
  assert.equal(parseWebhook('x'), null);
});

test('classifyFailure', () => {
  assert.equal(classifyFailure({ transport: true }), 'unknown');
  assert.equal(classifyFailure({ errorMsg: 'duplicate transactionId' }), 'duplicate');
});
