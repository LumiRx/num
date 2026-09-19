// Lightspeed K-Series — the first till that knows which table it is talking
// about, and the first that speaks a different unit from everything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ls from './lightspeed.mjs';

const conn = { token: 'tok', location_id: '77', webhook_id: 'ep_1' };

function serving(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers ?? {} });
    const out = handler(String(url), init);
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200 });
  };
  return { calls, restore() { globalThis.fetch = real; } };
}

const CHECK = {
  uuid: 'chk-1',
  tableNumber: 7,
  clientCount: 4,
  staffName: 'Mia',
  openDate: '2026-09-19T19:04:00Z',
  currentAmount: 84.5,
  paidAmount: 0,
  salesEntries: [
    { name: 'Pad Thai', quantity: 2, unitAmount: 18 },
    { name: 'Singha', quantity: 3, unitAmount: 9.5 },
  ],
};

test('it is not ready without credentials, and says which ones', () => {
  assert.equal(ls.ready({}), false);
  assert.deepEqual(ls.needs({}).length, 2);
  assert.match(ls.needs({}).join(' '), /LIGHTSPEED_CLIENT_ID/);
  assert.equal(ls.ready({ LIGHTSPEED_CLIENT_ID: 'a', LIGHTSPEED_CLIENT_SECRET: 'b' }), true);
  assert.deepEqual(ls.needs({ LIGHTSPEED_CLIENT_ID: 'a', LIGHTSPEED_CLIENT_SECRET: 'b' }), []);
});

test('major units become minor exactly once, and are rounded not truncated', () => {
  // 24.5 is 2450, not 245 and not 2449. A cent lost per check is a venue
  // short at the end of a night.
  assert.equal(ls.toMinor(24.5), 2450);
  assert.equal(ls.toMinor(0.1 + 0.2), 30, 'float noise must not become 29');
  assert.equal(ls.toMinor(19.999), 2000);
  assert.equal(ls.toMinor(null), 0);
  assert.equal(ls.toMajor(2450), 24.5);
  assert.equal(ls.toMajor(2449), 24.49);
});

test('the authorize URL asks for orders-api and nothing else', () => {
  const u = new URL(ls.authorizeUrl({ LIGHTSPEED_CLIENT_ID: 'cid' }, { state: 's1', origin: 'https://itsnum.com' }));
  assert.equal(u.origin + u.pathname, 'https://auth.lsk-prod.app/realms/k-series/protocol/openid-connect/auth');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('scope'), 'orders-api', 'reading a check must not also grant editing the menu');
  assert.equal(u.searchParams.get('state'), 's1');
  assert.match(u.searchParams.get('redirect_uri'), /\/biz\/pos\/callback\?vendor=lightspeed$/);
});

test('an open check comes back with its table, its outstanding amount and its lines', async () => {
  const v = serving(() => ({ body: [CHECK] }));
  try {
    const [c] = await ls.openChecks({}, conn);
    assert.equal(c.table, '7', 'the thing Square and Clover cannot tell us');
    assert.equal(c.name, 'Table 7');
    assert.equal(c.amount_minor, 8450);
    assert.equal(c.guests, 4);
    assert.equal(c.staff, 'Mia');
    // The bill, already itemised, straight off the till. 2×18.00 + 3×9.50.
    assert.deepEqual(c.items.map((i) => [i.name, i.qty, i.line_minor]), [['Pad Thai', 2, 3600], ['Singha', 3, 2850]]);
    assert.equal(c.items.reduce((n, i) => n + i.line_minor, 0), 6450);
  } finally { v.restore(); }
});

test('the currency is NEVER taken from the till', async () => {
  // There is no currency field on the response at all. Inventing one is how a
  // bill in Bangkok becomes dollars — the same rule billphoto.mjs follows.
  const v = serving(() => ({ body: [CHECK] }));
  try {
    const [c] = await ls.openChecks({}, conn);
    assert.equal(c.currency, null);
  } finally { v.restore(); }
});

test('what has already been paid is subtracted, and a settled check disappears', async () => {
  const v = serving(() => ({ body: [
    { ...CHECK, uuid: 'part', currentAmount: 84.5, paidAmount: 20 },
    { ...CHECK, uuid: 'done', currentAmount: 40, paidAmount: 40 },
  ] }));
  try {
    const list = await ls.openChecks({}, conn);
    assert.equal(list.length, 1, 'a check with nothing owed is not an open check');
    assert.equal(list[0].amount_minor, 6450);
  } finally { v.restore(); }
});

test('no location chosen is refused before a call is made', async () => {
  let called = false;
  const v = serving(() => { called = true; return { body: [] }; });
  try {
    await assert.rejects(() => ls.openChecks({}, { token: 't' }), /location/);
    await assert.rejects(() => ls.checkForTable({}, { token: 't' }, 7), /location/);
    assert.equal(called, false);
  } finally { v.restore(); }
});

test('one table reads through the same mapper as all tables', async () => {
  const v = serving((url) => {
    assert.match(url, /\/order\/table\/7\/getCheck/);
    return { body: CHECK };
  });
  try {
    const c = await ls.checkForTable({}, conn, 7);
    assert.equal(c.table, '7');
    assert.equal(c.amount_minor, 8450);
    assert.equal(c.items.length, 2);
  } finally { v.restore(); }
});

test('paying logs the NUM token as the third-party reference, in major units', async () => {
  const v = serving(() => ({ body: { status: 'ok' } }));
  try {
    const out = await ls.recordExternalPayment({}, conn, { amountMinor: 8450, reference: 'QHJPRNMUWV', tableNumber: 7 });
    assert.equal(out.closed, true);
    const pay = v.calls.find((c) => c.url.endsWith('/o/op/1/pay'));
    assert.equal(pay.method, 'POST');
    assert.equal(pay.body.thirdPartyPaymentReference, 'QHJPRNMUWV');
    assert.equal(pay.body.paymentAmount, 84.5, 'the one call in the file that speaks majors');
    assert.equal(pay.body.businessLocationId, 77);
    assert.equal(pay.body.endpointId, 'ep_1');
  } finally { v.restore(); }
});

test('a Stripe retry is already-closed, not a failure', async () => {
  // Lightspeed enforces reference uniqueness itself and rejects a repeat. On
  // a webhook Stripe delivers twice, that is a success with a different
  // shape — reporting it as an error would tell a venue a paid check failed.
  const v = serving(() => ({ status: 400, body: { message: 'reference has already been used [QHJPRNMUWV]' } }));
  try {
    const out = await ls.recordExternalPayment({}, conn, { amountMinor: 8450, reference: 'QHJPRNMUWV' });
    assert.equal(out.closed, true);
    assert.equal(out.already, true);
  } finally { v.restore(); }
});

test('a location with no webhook endpoint is refused by name, not attempted', async () => {
  let called = false;
  const v = serving(() => { called = true; return { body: {} }; });
  try {
    await assert.rejects(
      () => ls.recordExternalPayment({}, { ...conn, webhook_id: null }, { amountMinor: 100, reference: 'X' }),
      /webhook endpoint/,
    );
    assert.equal(called, false, 'a call we know will fail is not worth making');
  } finally { v.restore(); }
});

test('a check is never closed for nothing, or without a reference', async () => {
  await assert.rejects(() => ls.recordExternalPayment({}, conn, { amountMinor: 0, reference: 'X' }), /for nothing/);
  await assert.rejects(() => ls.recordExternalPayment({}, conn, { amountMinor: 100 }), /reference/);
});

test('a real vendor error still throws, and carries its status', async () => {
  const v = serving(() => ({ status: 401, body: { message: 'token expired' } }));
  try {
    await assert.rejects(
      () => ls.recordExternalPayment({}, conn, { amountMinor: 100, reference: 'X' }),
      (e) => e.status === 401 && /token expired/.test(e.message),
    );
  } finally { v.restore(); }
});
