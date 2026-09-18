// A member's own wallet. These tests are the four rules in the file header
// made executable — especially the two that are about what must NOT exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as PRIVY from './privy.mjs';
import { privyReady, privyNeeds, privyCall, addressFromUser, walletFor, ensureWalletFor, usdcBalance, createBillPolicy, handleWallet } from './privy.mjs';

const ENV = { PRIVY_APP_ID: 'app_num', PRIVY_APP_SECRET: 'sec_num' };

function db({ verified = 1, phone = '+66812345678', wallet = null } = {}) {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT, phone TEXT UNIQUE, phone_verified INTEGER DEFAULT 0);
    CREATE TABLE num_member_wallets (member_id TEXT PRIMARY KEY, privy_user_id TEXT, privy_wallet_id TEXT,
      address TEXT NOT NULL, chain TEXT DEFAULT 'base', chain_type TEXT DEFAULT 'ethereum',
      state TEXT DEFAULT 'active', created_at TEXT DEFAULT '2026-09-18', updated_at TEXT);
    INSERT INTO num_members VALUES ('mem_1','Dre','${phone}',${verified});
  `);
  if (wallet) d.prepare(`INSERT INTO num_member_wallets (member_id,address) VALUES ('mem_1',?)`).run(wallet);
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
    return responder(String(url), init, calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
};

const PRIVY_USER = {
  id: 'did:privy:abc123',
  linked_accounts: [
    { type: 'phone', number: '+66812345678' },
    { type: 'wallet', address: '0xAbC0000000000000000000000000000000000001', chain_type: 'ethereum', wallet_client: 'privy' },
  ],
};

test('RULE 2, as code: this module has no way to put value INTO a wallet', () => {
  // The rule that keeps NUM out of cash-in-cash-out cannot be a comment alone.
  // If somebody adds fundWallet/topUp/buyUsdc/transfer here, this fails and
  // they have to argue with worker/cashout.mjs first.
  const forbidden = /^(fund|topUp|topup|buy|deposit|send|transfer|sweep|withdraw|sell)/i;
  const offenders = Object.keys(PRIVY).filter((k) => forbidden.test(k));
  assert.deepEqual(offenders, [], 'a value-moving export appeared in privy.mjs');
  const src = readFileSync(new URL('./privy.mjs', import.meta.url), 'utf8');
  assert.ok(!/eth_sendTransaction'\s*,\s*params/.test(src), 'this file must never submit a transaction');
  assert.ok(!/PRIVY_SIGNING_KEY|private_key|privateKey/.test(src), 'no key material belongs here');
});

test('RULE 3, as code: a wallet payload never carries Stars', async () => {
  const { env } = db({ wallet: '0xAbC0000000000000000000000000000000000001' });
  const { restore } = capture(() => new Response(JSON.stringify({ error: 'rpc down' }), { status: 500 }));
  try {
    const body = await (await handleWallet(new Request('https://app.itsnum.com/api/wallet?me=mem_1'), env, '/')).json();
    // The NOTE may say the word — it is the honest disclosure. What must never
    // exist is a Stars FIGURE in the same structure as a USDC one, because that
    // is the shape somebody eventually adds together.
    const numbers = { ...body.wallet, ...(body.balance ?? {}) };
    for (const k of Object.keys(numbers)) {
      assert.ok(!/star/i.test(k), `a Stars field appeared beside the wallet: ${k}`);
    }
    assert.ok(/stars are separate/i.test(body.note), 'the split has to be said out loud to the member');
    assert.equal(body.balance, null, 'an unreadable chain is null, never 0');
  } finally { restore(); }
});

test('readiness is derived and names the missing half', () => {
  assert.equal(privyReady(ENV), true);
  assert.equal(privyReady({ PRIVY_APP_ID: 'x' }), false);
  assert.match(privyNeeds({ PRIVY_APP_ID: 'x' })[0], /PRIVY_APP_SECRET/);
  assert.equal(privyNeeds(ENV).length, 0);
});

test('every Privy call carries Basic auth AND the app-id header — a request missing either is a 401 that looks like bad keys', async () => {
  const { calls, restore } = capture(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  try {
    await privyCall(ENV, '/users', { a: 1 }, 'POST', 'idem-1');
    const h = calls[0].init.headers;
    assert.equal(calls[0].url, 'https://api.privy.io/v1/users');
    assert.equal(h.Authorization, `Basic ${btoa('app_num:sec_num')}`);
    assert.equal(h['privy-app-id'], 'app_num');
    assert.equal(h['privy-idempotency-key'], 'idem-1');
  } finally { restore(); }
  await assert.rejects(() => privyCall({}, '/users'), /not configured/);
});

test('a wallet needs a verified human — an unverified member is refused before Privy is ever called', async () => {
  const { env } = db({ verified: 0 });
  const { calls, restore } = capture(() => new Response('{}', { status: 200 }));
  try {
    const out = await ensureWalletFor(env, 'mem_1');
    assert.equal(out.ok, false);
    assert.match(out.reason, /verify your number/);
    assert.equal(calls.length, 0, 'no Privy user should be created for an unverified number');
    assert.equal((await ensureWalletFor(env, 'nobody')).reason, 'no such member');
  } finally { restore(); }
});

test('creating a wallet: pregenerated from the verified phone, idempotent on the member id, saved once', async () => {
  const { d, env } = db();
  const { calls, restore } = capture(() => new Response(JSON.stringify(PRIVY_USER), { status: 200 }));
  try {
    const out = await ensureWalletFor(env, 'mem_1');
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.wallet.address, '0xAbC0000000000000000000000000000000000001');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, {
      linked_accounts: [{ type: 'phone', number: '+66812345678' }],
      wallets: [{ chain_type: 'ethereum' }],
    });
    assert.equal(calls[0].init.headers['privy-idempotency-key'], 'num-wallet-mem_1',
      'without this a retry leaves the member with two wallets and NUM pointing at the empty one');

    // Second call: nothing reaches Privy, same address comes back.
    const again = await ensureWalletFor(env, 'mem_1');
    assert.equal(again.already, true);
    assert.equal(again.wallet.address, out.wallet.address);
    assert.equal(calls.length, 1);
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM num_member_wallets').get().n, 1);
  } finally { restore(); }
});

test('Privy refusing is reported, not thrown, and nothing is written', async () => {
  const { d, env } = db();
  const { restore } = capture(() => new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }));
  try {
    const out = await ensureWalletFor(env, 'mem_1');
    assert.equal(out.ok, false);
    assert.equal(out.status, 429);
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM num_member_wallets').get().n, 0);
  } finally { restore(); }
  const off = await ensureWalletFor(db().env && { ...db().env, PRIVY_APP_ID: '', PRIVY_APP_SECRET: '' }, 'mem_1');
  assert.equal(off.ok, false);
});

test('addressFromUser finds the embedded wallet and ignores a connected external one', () => {
  assert.equal(addressFromUser(PRIVY_USER).address, '0xAbC0000000000000000000000000000000000001');
  assert.equal(addressFromUser({ linked_accounts: [{ type: 'email', address: 'a@b.c' }] }), null);
  const both = { linked_accounts: [
    { type: 'wallet', address: '0xEXTERNAL', chain_type: 'ethereum', wallet_client: 'metamask' },
    { type: 'wallet', address: '0xPRIVY', chain_type: 'ethereum', wallet_client: 'privy' },
  ] };
  assert.equal(addressFromUser(both).address, '0xPRIVY', 'the embedded wallet is the one NUM made');
});

test('balance is read from the chain, never trusted blindly, and a bad address is refused', async () => {
  const good = '0x' + 'a'.repeat(40);
  const { calls, restore } = capture(() => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (12_340_000).toString(16) }), { status: 200 }));
  try {
    const b = await usdcBalance({ USDC_RPC_URL: 'https://rpc.test' }, good);
    assert.equal(b.display, '12.34');
    assert.equal(b.symbol, 'USDC');
    assert.equal(calls[0].body.method, 'eth_call', 'read only — never eth_sendTransaction');
    assert.equal(calls[0].body.params[0].to, PRIVY.USDC_BASE.address);
    assert.match(calls[0].body.params[0].data, /^0x70a08231/, 'balanceOf selector');
  } finally { restore(); }
  assert.equal(await usdcBalance({}, 'not-an-address'), null);
  const { restore: r2 } = capture(() => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 200 }));
  try { assert.equal(await usdcBalance({}, good), null, 'an RPC error is null, not zero'); } finally { r2(); }
});

test('a bill policy is scoped to ONE venue address, so a compromised Worker cannot redirect a payment', async () => {
  const { calls, restore } = capture(() => new Response(JSON.stringify({ id: 'pol_1' }), { status: 200 }));
  try {
    const out = await createBillPolicy(ENV, { venueAddress: '0x' + 'B'.repeat(40), label: 'Bar Nine' });
    assert.equal(out.ok, true);
    assert.equal(out.policy_id, 'pol_1');
    const rule = calls[0].body.rules[0];
    assert.equal(rule.action, 'ALLOW');
    assert.equal(rule.method, 'eth_sendTransaction');
    assert.equal(rule.conditions[0].field, 'to');
    assert.equal(rule.conditions[0].value, ('0x' + 'B'.repeat(40)).toLowerCase());
  } finally { restore(); }
  assert.equal((await createBillPolicy(ENV, { venueAddress: 'nope' })).ok, false);
});

test('the wallet route refuses an anonymous caller and says plainly when wallets are off', async () => {
  const { env } = db();
  assert.equal((await handleWallet(new Request('https://x/api/wallet'), env, '/')).status, 401);
  const offEnv = { ...env, PRIVY_APP_ID: '', PRIVY_APP_SECRET: '' };
  const body = await (await handleWallet(new Request('https://x/api/wallet?me=mem_1'), offEnv, '/')).json();
  assert.equal(body.wallet, null);
  assert.equal(body.available, false);
  assert.match(body.why, /not switched on/);
});
