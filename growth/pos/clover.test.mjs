// The second till. Most of these exist because Clover disagrees with Square
// about something, and the disagreement has to stay inside this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as clover from './clover.mjs';
import { adapterFor, posReady, posNeeds, saveConnection, connectionFor, openChecks, recordExternalPayment, withFreshToken } from './index.mjs';

const ENV = { POS_TOKEN_KEY: 'k'.repeat(24), CLOVER_APP_ID: 'app1', CLOVER_APP_SECRET: 'sec1', CLOVER_SANDBOX: '1' };

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE num_business_pos (business_id TEXT PRIMARY KEY, vendor TEXT, merchant_id TEXT,
    location_id TEXT, token_enc TEXT, refresh_enc TEXT, expires_at TEXT, state TEXT DEFAULT 'active',
    last_error TEXT, connected_at TEXT, updated_at TEXT);`);
  const DB = {
    prepare(sql) {
      const b = [];
      const api = { bind(...a) { b.push(...a); return api; },
        async first() { return d.prepare(sql).get(...b) ?? null; },
        async all() { return { results: d.prepare(sql).all(...b) }; },
        async run() { const r = d.prepare(sql).run(...b); return { meta: { changes: Number(r.changes ?? 0) } }; } };
      return api;
    },
  };
  return { d, env: { ...ENV, DB } };
}
const capture = (responder) => {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    return responder(String(url), calls.length, init);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
};

test('Clover is a registered adapter and is ready only when both halves are set', () => {
  assert.equal(adapterFor('clover').label, 'Clover');
  assert.equal(posReady(ENV, 'clover'), true);
  assert.equal(posReady({ POS_TOKEN_KEY: 'k' }, 'clover'), false);
  assert.match(posNeeds({ POS_TOKEN_KEY: 'k' }, 'clover').join(' '), /CLOVER_APP_ID/);
});

test('the authorize URL has no redirect_uri — Clover keeps the callback on the app, and sandbox is a different host', () => {
  const u = new URL(clover.authorizeUrl(ENV, { state: 'st' }));
  assert.equal(u.origin + u.pathname, 'https://sandbox.dev.clover.com/oauth/v2/authorize');
  assert.equal(u.searchParams.get('client_id'), 'app1');
  assert.equal(u.searchParams.get('state'), 'st');
  assert.equal(u.searchParams.get('redirect_uri'), null, 'Clover would reject one — the callback lives on the app');
  const prod = new URL(clover.authorizeUrl({ ...ENV, CLOVER_SANDBOX: '0' }, { state: 's' }));
  assert.equal(prod.origin, 'https://www.clover.com');
  assert.equal(clover.authorizeUrl({}, { state: 's' }), null);
});

test('the token exchange takes the merchant from the CALLBACK, and unix expiries become ISO', async () => {
  const { calls, restore } = capture(() => new Response(JSON.stringify({
    access_token: 'at', refresh_token: 'rt',
    access_token_expiration: 1893456000, refresh_token_expiration: 1924992000,
  }), { status: 200 }));
  try {
    const t = await clover.exchangeCode(ENV, { code: 'c1', merchantId: 'M77' });
    assert.equal(calls[0].url, 'https://apisandbox.dev.clover.com/oauth/v2/token');
    assert.deepEqual(calls[0].body, { client_id: 'app1', client_secret: 'sec1', code: 'c1' });
    assert.equal(t.merchant_id, 'M77', 'Clover has no "who am I" call — the callback is where this comes from');
    assert.equal(t.expires_at, new Date(1893456000 * 1000).toISOString());
    assert.equal(t.refresh_expires_at, new Date(1924992000 * 1000).toISOString());
  } finally { restore(); }
});

test('refresh posts to /oauth/v2/refresh with the app id, and keeps the old refresh token if none comes back', async () => {
  const { calls, restore } = capture(() => new Response(JSON.stringify({ access_token: 'at2', access_token_expiration: 1893456000 }), { status: 200 }));
  try {
    const t = await clover.refresh(ENV, 'rt-old');
    assert.match(calls[0].url, /\/oauth\/v2\/refresh$/);
    assert.deepEqual(calls[0].body, { client_id: 'app1', refresh_token: 'rt-old' });
    assert.equal(t.access_token, 'at2');
    assert.equal(t.refresh_token, 'rt-old');
  } finally { restore(); }
});

test('a NUM payment is NEVER logged as cash — that is somebody counting a drawer at 1am', () => {
  const cash = { id: 't1', label: 'Cash', labelKey: 'com.clover.tender.cash' };
  const card = { id: 't2', label: 'Credit Card', labelKey: 'com.clover.tender.credit_card' };
  assert.equal(clover.pickTender([cash, card]), null, 'no suitable tender is an honest refusal');
  assert.equal(clover.pickTender([cash, card, { id: 't3', label: 'External Payment' }]).id, 't3');
  assert.equal(clover.pickTender([cash, card, { id: 't4', label: 'Gift voucher' }]).id, 't4', 'any custom tender beats cash');
  assert.equal(clover.pickTender([cash, card, { id: 't5', label: 'External', enabled: false }]), null, 'a disabled tender is not a tender');
  assert.equal(clover.pickTender([]), null);
  assert.equal(clover.pickTender(null), null);
});

test('open checks subtract what is already paid — the same rule as Square, reached the hard way', async () => {
  const { env } = db();
  await saveConnection(env, 'b1', { vendor: 'clover', merchantId: 'M1', token: 'tok', refresh: 'ref' });
  const { calls, restore } = capture(() => new Response(JSON.stringify({
    elements: [
      { id: 'o1', title: 'Table 3', total: 9000, currency: 'USD', createdTime: 1758200000000,
        payments: { elements: [{ amount: 3000 }] } },
      { id: 'o2', note: 'bar', total: 2500, currency: 'USD', createdTime: 1758200500000 },
      { id: 'o3', title: 'done', total: 1000, payments: { elements: [{ amount: 1000 }] } },
    ],
  }), { status: 200 }));
  try {
    const out = await openChecks(env, 'b1');
    assert.equal(out.ok, true);
    assert.equal(out.vendor, 'clover');
    assert.equal(out.checks.length, 2, 'an order that owes nothing is not an open check');
    assert.equal(out.checks[0].amount_minor, 6000, 'a deposit already on the order must not be billed again');
    assert.equal(out.checks[0].name, 'Table 3');
    assert.equal(out.checks[1].name, 'bar');
    assert.match(calls[0].url, /\/v3\/merchants\/M1\/orders\?filter=state%3Dopen&expand=payments/);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
    assert.match(calls[0].init.headers['User-Agent'], /NUM/);
  } finally { restore(); }
});

test('closing a check looks the tender up first and keys the payment on the NUM bill token', async () => {
  const { env } = db();
  await saveConnection(env, 'b1', { vendor: 'clover', merchantId: 'M1', token: 'tok', refresh: 'ref' });
  const { calls, restore } = capture((url) => {
    if (url.endsWith('/tenders')) {
      return new Response(JSON.stringify({ elements: [
        { id: 'tc', label: 'Cash', labelKey: 'com.clover.tender.cash' },
        { id: 'tx', label: 'External Payment' },
      ] }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 'pay_9' }), { status: 200 });
  });
  try {
    const out = await recordExternalPayment(env, 'b1', { orderId: 'o1', amountMinor: 6000, currency: 'USD', reference: 'BILL7', feeMinor: 600 });
    assert.equal(out.ok, true);
    assert.equal(out.closed, true);
    assert.equal(out.tender, 'External Payment');
    assert.match(calls[0].url, /\/v3\/merchants\/M1\/tenders$/, 'tender ids are per merchant and are never hardcoded');
    assert.match(calls[1].url, /\/v3\/merchants\/M1\/orders\/o1\/payments$/);
    assert.deepEqual(calls[1].body.tender, { id: 'tx' });
    assert.equal(calls[1].body.amount, 6000);
    assert.equal(calls[1].body.externalPaymentId, 'BILL7', 'a retried webhook must not pay the merchant twice');
    assert.equal(calls[1].body.offline, false);
  } finally { restore(); }
});

test('a merchant with only cash and card is refused, in words that say what to do about it', async () => {
  const { env } = db();
  await saveConnection(env, 'b1', { vendor: 'clover', merchantId: 'M1', token: 'tok', refresh: 'ref' });
  const { restore } = capture(() => new Response(JSON.stringify({ elements: [
    { id: 'tc', label: 'Cash', labelKey: 'com.clover.tender.cash' },
  ] }), { status: 200 }));
  try {
    const out = await recordExternalPayment(env, 'b1', { orderId: 'o1', amountMinor: 100, reference: 'B' });
    assert.equal(out.ok, false);
    assert.match(out.reason, /Setup → Tenders/);
  } finally { restore(); }
});

test('the registry drives Clover through the same door as Square — nothing vendor-specific escapes the adapter', async () => {
  const { d, env } = db();
  await saveConnection(env, 'b1', { vendor: 'clover', merchantId: 'M1', token: 'old', refresh: 'ref', expiresAt: '2020-01-01T00:00:00Z' });
  const conn = await connectionFor(env, 'b1');
  assert.equal(conn.vendor, 'clover');
  assert.equal(conn.expired, true);
  const { restore } = capture(() => new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r2', access_token_expiration: 4102444800 }), { status: 200 }));
  try {
    const fresh = await withFreshToken(env, conn);
    assert.equal(fresh.token, 'new');
    assert.equal(fresh.usable, true);
  } finally { restore(); }
  assert.equal(d.prepare("SELECT vendor FROM num_business_pos WHERE business_id='b1'").get().vendor, 'clover');
});
