// Reading a venue's till, and closing a check in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { seal, unseal, posReady, posNeeds, connectionFor, saveConnection, openChecks, recordExternalPayment, withFreshToken, disconnect, adapterFor } from './index.mjs';
import * as square from './square.mjs';

const ENV = { POS_TOKEN_KEY: 'a-long-random-key-for-tests', SQUARE_APP_ID: 'sq0idp-test', SQUARE_APP_SECRET: 'sq0csp-test' };

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE num_business_pos (business_id TEXT PRIMARY KEY, vendor TEXT, merchant_id TEXT,
    location_id TEXT, token_enc TEXT, refresh_enc TEXT, expires_at TEXT, state TEXT DEFAULT 'active',
    last_error TEXT, connected_at TEXT, updated_at TEXT);`);
  const DB = {
    prepare(sql) {
      const b = [];
      const api = {
        bind(...a) { b.push(...a); return api; },
        async first() { return d.prepare(sql).get(...b) ?? null; },
        async all() { return { results: d.prepare(sql).all(...b) }; },
        async run() { const r = d.prepare(sql).run(...b); return { meta: { changes: Number(r.changes ?? 0) } }; },
      };
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

test('merchant tokens are ciphertext at rest, and a rotated key reads as "reconnect" rather than throwing', async () => {
  const blob = await seal(ENV, 'sq0atp-super-secret');
  assert.ok(!blob.includes('sq0atp'), 'the token must not be recoverable by eye from the column');
  assert.equal(await unseal(ENV, blob), 'sq0atp-super-secret');
  assert.equal(await unseal({ POS_TOKEN_KEY: 'a-different-key' }, blob), null, 'a rotated key gives null, not an exception');
  assert.equal(await unseal(ENV, 'garbage'), null);
  assert.equal(await seal(ENV, null), null);
  // Two seals of the same token differ — a fresh IV each time, so the column
  // cannot be used to tell which venues share a token.
  assert.notEqual(await seal(ENV, 'same'), await seal(ENV, 'same'));
});

test('no POS_TOKEN_KEY means no POS — never a bearer token written in the clear', () => {
  assert.equal(posReady(ENV, 'square'), true);
  assert.equal(posReady({ SQUARE_APP_ID: 'x', SQUARE_APP_SECRET: 'y' }, 'square'), false);
  assert.match(posNeeds({ SQUARE_APP_ID: 'x', SQUARE_APP_SECRET: 'y' }, 'square')[0], /POS_TOKEN_KEY/);
  assert.equal(posReady(ENV, 'toast'), false, 'an unbuilt vendor is never ready');
  assert.deepEqual(posNeeds(ENV, 'toast'), ['no such POS vendor']);
  assert.match(posNeeds({ POS_TOKEN_KEY: 'k' }, 'square').join(' '), /SQUARE_APP_ID/);
});

test('a missing table, a missing connection and a dead token are three different honest answers', async () => {
  const { env } = db();
  assert.equal(await connectionFor(env, 'b1'), null);
  assert.deepEqual(await openChecks(env, 'b1'), { ok: false, reason: 'no till is connected' });
  // Before migration 0039 the table does not exist; that must read as "no POS".
  assert.equal(await connectionFor({ ...env, DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('no such table'); } }) }) } }, 'b1'), null);

  await saveConnection(env, 'b1', { vendor: 'square', merchantId: 'M1', locationId: 'L1', token: 'tok', refresh: 'ref' });
  const c = await connectionFor(env, 'b1');
  assert.equal(c.token, 'tok');
  assert.equal(c.usable, true);

  // A token whose key no longer decrypts: row present, token gone, NOT usable.
  const other = await connectionFor({ ...env, POS_TOKEN_KEY: 'rotated' }, 'b1');
  assert.equal(other.token, null);
  assert.equal(other.usable, false);
});

test('open checks: due amount not total, ticket name passed through unread, zero-value checks dropped', async () => {
  const { env } = db();
  await saveConnection(env, 'b1', { vendor: 'square', locationId: 'L1', token: 'tok', refresh: 'ref' });
  const { calls, restore } = capture(() => new Response(JSON.stringify({
    orders: [
      { id: 'o1', ticket_name: 'Table 7', total_money: { amount: 9000, currency: 'USD' }, net_amount_due_money: { amount: 6000, currency: 'USD' }, created_at: '2026-09-18T12:00:00Z', version: 3 },
      { id: 'o2', reference_id: 'bar tab', total_money: { amount: 2500, currency: 'USD' }, created_at: '2026-09-18T12:05:00Z' },
      { id: 'o3', ticket_name: 'settled', net_amount_due_money: { amount: 0, currency: 'USD' } },
    ],
  }), { status: 200 }));
  try {
    const out = await openChecks(env, 'b1');
    assert.equal(out.ok, true);
    assert.equal(out.checks.length, 2, 'a check owing nothing is not an open check');
    assert.equal(out.checks[0].amount_minor, 6000, 'a deposit already paid must not be billed twice');
    assert.equal(out.checks[0].name, 'Table 7');
    assert.equal(out.checks[1].name, 'bar tab');
    assert.equal(out.checks[1].amount_minor, 2500);
    assert.equal(calls[0].body.query.filter.state_filter.states[0], 'OPEN');
    assert.deepEqual(calls[0].body.location_ids, ['L1']);
    assert.equal(calls[0].init.headers['Square-Version'], square.SQUARE_VERSION, 'the API version is pinned, never floating');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  } finally { restore(); }
});

test('a till that refuses is reported and recorded — never an exception, never an invented check', async () => {
  const { d, env } = db();
  await saveConnection(env, 'b1', { vendor: 'square', locationId: 'L1', token: 'tok', refresh: 'ref' });
  const { restore } = capture(() => new Response(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED', detail: 'token revoked' }] }), { status: 401 }));
  try {
    const out = await openChecks(env, 'b1');
    assert.equal(out.ok, false);
    assert.match(out.reason, /could not read the till/);
    assert.ok(!('checks' in out), 'no list at all beats an empty list that reads as "nothing open"');
    const row = d.prepare("SELECT state, last_error FROM num_business_pos WHERE business_id='b1'").get();
    assert.equal(row.state, 'needs_reauth');
    assert.match(row.last_error, /token revoked/);
  } finally { restore(); }
});

test('closing a check: external payment then PayOrder, keyed on the NUM bill token so a retried webhook cannot double-charge', async () => {
  const { env } = db();
  await saveConnection(env, 'b1', { vendor: 'square', locationId: 'L1', token: 'tok', refresh: 'ref' });
  const { calls, restore } = capture((url) => {
    if (url.endsWith('/v2/payments')) return new Response(JSON.stringify({ payment: { id: 'pay_1', status: 'APPROVED' } }), { status: 200 });
    return new Response(JSON.stringify({ order: { id: 'o1', state: 'COMPLETED' } }), { status: 200 });
  });
  try {
    const out = await recordExternalPayment(env, 'b1', { orderId: 'o1', amountMinor: 8450, currency: 'USD', reference: 'BILL01', feeMinor: 845 });
    assert.equal(out.ok, true);
    assert.equal(out.closed, true);
    const pay = calls[0].body;
    assert.equal(pay.source_id, 'EXTERNAL');
    assert.equal(pay.autocomplete, false, 'autocomplete:false, or PayOrder cannot close it');
    assert.equal(pay.idempotency_key, 'num-BILL01');
    assert.equal(calls[0].init.headers['Idempotency-Key'], 'num-BILL01');
    assert.deepEqual(pay.amount_money, { amount: 8450, currency: 'USD' });
    assert.deepEqual(pay.external_details.source_fee_money, { amount: 845, currency: 'USD' });
    assert.equal(pay.external_details.source, 'NUM');
    assert.match(calls[1].url, /\/v2\/orders\/o1\/pay$/);
    assert.deepEqual(calls[1].body.payment_ids, ['pay_1']);
  } finally { restore(); }
});

test('a failed close never reads as a failed payment — the guest has already paid by then', async () => {
  const { env } = db();
  await saveConnection(env, 'b1', { vendor: 'square', locationId: 'L1', token: 'tok', refresh: 'ref' });
  const { restore } = capture(() => new Response(JSON.stringify({ errors: [{ code: 'NOT_FOUND', detail: 'order not found' }] }), { status: 404 }));
  try {
    const out = await recordExternalPayment(env, 'b1', { orderId: 'gone', amountMinor: 100, reference: 'B1' });
    assert.equal(out.ok, false);
    assert.match(out.reason, /order not found/);
  } finally { restore(); }
  // Nothing to close, and nothing to charge for.
  await assert.rejects(() => square.recordExternalPayment(ENV, { token: 't' }, { orderId: 'o', amountMinor: 0, reference: 'x' }), /cannot be closed for nothing/);
  await assert.rejects(() => square.recordExternalPayment(ENV, { token: 't' }, { amountMinor: 10, reference: 'x' }), /no Square order/);
});

test('an expired token refreshes once; a refresh that fails marks the venue for reconnection instead of retrying for ever', async () => {
  const { d, env } = db();
  await saveConnection(env, 'b1', { vendor: 'square', locationId: 'L1', token: 'old', refresh: 'ref', expiresAt: '2020-01-01T00:00:00Z' });
  let conn = await connectionFor(env, 'b1');
  assert.equal(conn.expired, true);
  assert.equal(conn.usable, false);

  const ok = capture(() => new Response(JSON.stringify({ access_token: 'new', refresh_token: 'ref2', expires_at: '2099-01-01T00:00:00Z', merchant_id: 'M9' }), { status: 200 }));
  try {
    const fresh = await withFreshToken(env, conn);
    assert.equal(fresh.token, 'new');
    assert.equal(fresh.usable, true);
    assert.equal(ok.calls[0].body.grant_type, 'refresh_token');
  } finally { ok.restore(); }

  await saveConnection(env, 'b1', { vendor: 'square', locationId: 'L1', token: 'old', refresh: 'ref', expiresAt: '2020-01-01T00:00:00Z' });
  conn = await connectionFor(env, 'b1');
  const bad = capture(() => new Response(JSON.stringify({ errors: [{ detail: 'refresh rejected' }] }), { status: 401 }));
  try {
    assert.equal(await withFreshToken(env, conn), null);
    assert.equal(d.prepare("SELECT state FROM num_business_pos WHERE business_id='b1'").get().state, 'needs_reauth');
  } finally { bad.restore(); }
});

test('the venue is told about Square\'s 1%, and NUM asks for no scope it does not use', () => {
  assert.match(square.SELLER_NOTE, /1%/);
  assert.match(square.SELLER_NOTE, /Square/);
  assert.deepEqual([...square.SCOPES].sort(), ['MERCHANT_PROFILE_READ', 'ORDERS_READ', 'ORDERS_WRITE', 'PAYMENTS_WRITE']);
  const u = square.authorizeUrl(ENV, { state: 'st', origin: 'https://itsnum.com' });
  assert.ok(u.startsWith('https://connect.squareup.com/oauth2/authorize?'));
  assert.match(u, /scope=ORDERS_READ\+ORDERS_WRITE\+PAYMENTS_WRITE\+MERCHANT_PROFILE_READ/);
  assert.match(u, /state=st/);
  assert.match(u, /session=false/);
  assert.match(decodeURIComponent(u), /redirect_uri=https:\/\/itsnum\.com\/biz\/pos\/callback/);
  assert.equal(square.authorizeUrl({}, { state: 's', origin: 'o' }), null);
  assert.ok(square.authorizeUrl({ ...ENV, SQUARE_SANDBOX: '1' }, { state: 's', origin: 'o' }).startsWith('https://connect.squareupsandbox.com'));
});

test('disconnecting forgets the tokens', async () => {
  const { d, env } = db();
  await saveConnection(env, 'b1', { vendor: 'square', token: 'tok', refresh: 'ref' });
  await disconnect(env, 'b1');
  const row = d.prepare("SELECT state, token_enc, refresh_enc FROM num_business_pos WHERE business_id='b1'").get();
  assert.equal(row.state, 'revoked');
  assert.equal(row.token_enc, null);
  assert.equal(row.refresh_enc, null);
  assert.equal((await connectionFor(env, 'b1')).usable, false);
  assert.equal(adapterFor('square'), (await import('./square.mjs')).default ?? adapterFor('square'));
});
