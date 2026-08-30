/**
 * rpc — money that arrived before the bill existed is not payment for it.
 *
 * This file exists because of what happened the first time the watcher was
 * pointed at a real payment on a real chain. The wallet had ordinary earlier
 * traffic in it. The sweep looked back over recent blocks, found a 2.18 USDC
 * transfer from sixteen minutes BEFORE the bill was created, decided it more
 * than covered a 0.55 bill, and settled against it.
 *
 * On a test wallet that is a wrong answer. On a real venue wallet — which
 * receives money all day for reasons that have nothing to do with us — it is
 * the worst failure this system can have: every new bill is marked paid the
 * instant it opens. Staff are told a guest has paid who has not, and NUM
 * invoices a commission on a table nobody settled.
 *
 * So: a transfer is only payment for a bill if it landed after the bill did,
 * and a transfer we cannot date is never settled at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  classify, sweep, CLOCK_GRACE_S, TRANSFER_TOPIC, addressTopic,
} from './rpc.mjs';
import { ASSETS } from './crypto.mjs';

const VENUE = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const OTHER = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const RPC = 'https://rpc.example';

const BORN = '2026-08-24T01:24:44Z';
const bornS = Math.floor(Date.parse(BORN) / 1000);

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE num_paylinks (token TEXT PRIMARY KEY, business_id TEXT, label TEXT, kind TEXT,
      target TEXT, promptpay_kind TEXT, crypto_asset TEXT, amount_mode TEXT, amount TEXT,
      currency TEXT, state TEXT, created_at TEXT, booking_id TEXT, settled_at TEXT,
      one_time INTEGER DEFAULT 0, resource_id TEXT, issued_by TEXT, settled_by TEXT,
      revoked_by TEXT, revoked_at TEXT,
      crypto_base_units TEXT, crypto_quote TEXT, onchain_tx TEXT);
    CREATE TABLE num_chain_state (chain TEXT PRIMARY KEY, last_block INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT, last_error TEXT, runs INTEGER NOT NULL DEFAULT 0,
      matched INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE num_chain_sightings (id INTEGER PRIMARY KEY AUTOINCREMENT, chain TEXT NOT NULL,
      tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number INTEGER NOT NULL,
      token TEXT NOT NULL, to_address TEXT NOT NULL, value_base TEXT NOT NULL,
      token_matched TEXT, outcome TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL,
      UNIQUE (chain, tx_hash, log_index));
  `);
  const DB = {
    prepare(sql) {
      const bound = [];
      const api = {
        bind(...a) { bound.push(...a); return api; },
        async first() { try { return d.prepare(sql).get(...bound) ?? null; } catch { return null; } },
        async all() { try { return { results: d.prepare(sql).all(...bound) }; } catch { return { results: [] }; } },
        async run() {
          const r = d.prepare(sql).run(...bound);
          return { meta: { changes: Number(r.changes ?? 0) } };
        },
      };
      return api;
    },
  };
  d.prepare(`INSERT INTO num_paylinks
    (token,business_id,label,kind,target,crypto_asset,amount_mode,amount,currency,state,
     created_at,one_time,crypto_base_units)
    VALUES ('BILL','biz1','Table 4','crypto',?,'usdc-base','fixed','18.00','THB','active',?,1,'550000')`)
    .run(VENUE, BORN);
  return { d, env: { DB, NUM_RPC_BASE: RPC } };
}

const tx = (n) => '0x' + String(n).repeat(64).slice(0, 64);

/** A log as eth_getLogs hands it back. `ts` null means the provider omitted it. */
const rawLog = ({ value = 550000n, block = 1000, idx = 0, hash = tx(1), ts = bornS + 300 }) => {
  const l = {
    transactionHash: hash,
    logIndex: '0x' + idx.toString(16),
    blockNumber: '0x' + block.toString(16),
    address: ASSETS['usdc-base'].contract.toLowerCase(),
    topics: [TRANSFER_TOPIC, addressTopic(OTHER), addressTopic(VENUE)],
    data: '0x' + value.toString(16).padStart(64, '0'),
  };
  if (ts !== null) l.blockTimestamp = '0x' + ts.toString(16);
  return l;
};

/** Answers eth_blockNumber, eth_getLogs and eth_getBlockByNumber. */
function stub({ logs = [], blockTimes = {}, head = 0x2710 }) {
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    asked.push(b.method);
    let result;
    if (b.method === 'eth_blockNumber') result = '0x' + head.toString(16);
    else if (b.method === 'eth_getLogs') result = logs;
    else if (b.method === 'eth_getBlockByNumber') {
      const n = Number(BigInt(b.params[0]));
      const t = blockTimes[n];
      result = t ? { timestamp: '0x' + t.toString(16) } : null;
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
      { headers: { 'content-type': 'application/json' } });
  };
  return asked;
}

/* ── the rule, on its own ────────────────────────────────────────────────── */

test('a transfer from before the bill was written is not payment for it', () => {
  const v = classify(
    { crypto_base_units: '550000', created_at: BORN, state: 'active' },
    { value: 2180000n, block_time: bornS - 16 * 60 },
  );
  assert.equal(v.settle, false, 'this exact case settled a real bill on a real chain');
  assert.equal(v.outcome, 'predates_bill');
  assert.match(v.detail, /before this bill existed/);
});

test('covering the bill many times over does not make old money new', () => {
  const v = classify(
    { crypto_base_units: '550000', created_at: BORN, state: 'active' },
    { value: 999999999n, block_time: bornS - 3600 },
  );
  assert.equal(v.settle, false, 'a large enough coincidence is still a coincidence');
});

test('a payment a moment after the bill settles', () => {
  const v = classify(
    { crypto_base_units: '550000', created_at: BORN, state: 'active' },
    { value: 550000n, block_time: bornS + 30 },
  );
  assert.deepEqual(v, { outcome: 'exact', settle: true });
});

test('clock skew between the database and the chain is forgiven, but only a little', () => {
  const bill = { crypto_base_units: '550000', created_at: BORN, state: 'active' };
  assert.equal(classify(bill, { value: 550000n, block_time: bornS - CLOCK_GRACE_S + 5 }).settle,
    true, 'two clocks disagreeing by seconds must not strand a real guest');
  assert.equal(classify(bill, { value: 550000n, block_time: bornS - CLOCK_GRACE_S - 5 }).settle,
    false, 'and the forgiveness has an edge');
});

/* ── the rule, through a sweep ───────────────────────────────────────────── */

test('an earlier transfer is recorded and the later real payment still settles', async () => {
  const { d, env } = db();
  stub({
    logs: [
      rawLog({ value: 2180000n, block: 900, hash: tx(7), ts: bornS - 960 }),
      rawLog({ value: 550000n, block: 1200, hash: tx(3), ts: bornS + 240 }),
    ],
  });
  const settled = [];
  const out = await sweep(env, async (e, biz, token) => { settled.push(token); return { ok: true }; });

  assert.deepEqual(settled, ['BILL'], 'the guest did pay — the bill must still settle');
  assert.equal(out.settled, 1);

  const rows = d.prepare('SELECT tx_hash, outcome FROM num_chain_sightings ORDER BY block_number').all();
  assert.deepEqual(rows.map((r) => r.outcome), ['predates_bill', 'exact']);

  const paid = d.prepare("SELECT onchain_tx FROM num_paylinks WHERE token='BILL'").get();
  assert.equal(paid.onchain_tx, tx(3),
    'the hash written down has to be the payment, or a human checking it finds the wrong transfer');
});

test('an older transfer alone leaves the bill open', async () => {
  const { d, env } = db();
  stub({ logs: [rawLog({ value: 2180000n, block: 900, ts: bornS - 960 })] });

  const settled = [];
  await sweep(env, async (e, biz, token) => { settled.push(token); return { ok: true }; });

  assert.equal(settled.length, 0);
  assert.equal(d.prepare("SELECT settled_at FROM num_paylinks WHERE token='BILL'").get().settled_at, null,
    'telling staff a guest has paid who has not is the failure this whole file is about');
});

/* ── money we cannot date ────────────────────────────────────────────────── */

test('a provider that omits the block time is asked, and the payment still settles', async () => {
  const { d, env } = db();
  const asked = stub({
    logs: [rawLog({ value: 550000n, block: 1200, ts: null })],
    blockTimes: { 1200: bornS + 240 },
  });
  const settled = [];
  await sweep(env, async (e, biz, token) => { settled.push(token); return { ok: true }; });

  assert.ok(asked.includes('eth_getBlockByNumber'), 'we have to go and find out');
  assert.deepEqual(settled, ['BILL']);
});

test('a transfer that cannot be dated is not judged, not recorded, and not passed over', async () => {
  const { d, env } = db();
  stub({ logs: [rawLog({ value: 550000n, block: 1200, ts: null })], blockTimes: {} });

  const settled = [];
  const out = await sweep(env, async (e, biz, token) => { settled.push(token); return { ok: true }; });

  assert.equal(settled.length, 0, 'undated money is never settled');
  assert.equal(d.prepare('SELECT COUNT(*) c FROM num_chain_sightings').get().c, 0,
    'nor written down with a verdict we could not justify');

  const st = d.prepare("SELECT last_block FROM num_chain_state WHERE chain='base'").get();
  assert.ok(st.last_block < 1200,
    'and the watermark must stay behind it, so the next pass looks again');
  assert.equal(out.to < 1200, true);
});

test('once the block time can be read, the payment settles on a later pass', async () => {
  const { d, env } = db();
  stub({ logs: [rawLog({ value: 550000n, block: 1200, ts: null })], blockTimes: {} });
  const settled = [];
  const settle = async (e, biz, token) => { settled.push(token); return { ok: true }; };
  await sweep(env, settle);
  assert.equal(settled.length, 0);

  stub({ logs: [rawLog({ value: 550000n, block: 1200, ts: null })], blockTimes: { 1200: bornS + 240 } });
  await sweep(env, settle);
  assert.deepEqual(settled, ['BILL'], 'a bad minute at a provider must not cost a payment');
});
