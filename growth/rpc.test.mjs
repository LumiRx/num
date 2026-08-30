/**
 * rpc — the watcher decides whether a merchant gets billed on the strength of
 * what an endpoint tells it, so every branch is pinned here: the event topic,
 * underpayment, overpayment, reorg depth, replay, and what happens when the
 * endpoint lies or dies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  TRANSFER_TOPIC, addressTopic, topicAddress, classify,
  rpc, blockNumber, transfersTo, sweep, watcherStatus, CONFIRMATIONS, RpcError,
} from './rpc.mjs';
import { ASSETS } from './crypto.mjs';

const VENUE = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const OTHER = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';

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
  return { d, env: { DB, NUM_RPC_BASE: 'https://rpc.example/base' } };
}

function bill(d, { token = 'B1', target = VENUE, units = '73440000', settled = null } = {}) {
  d.prepare(`INSERT INTO num_paylinks
    (token,business_id,label,kind,target,crypto_asset,amount_mode,amount,currency,state,
     created_at,one_time,crypto_base_units,settled_at)
    VALUES (?,?,?,'crypto',?,'usdc-base','fixed','2400.00','THB','active','2026-08-22',1,?,?)`)
    .run(token, 'biz1', 'Bill', target, units, settled);
  return token;
}

const HASH = (n) => '0x' + String(n).padStart(64, 'a');

/** A stubbed endpoint. Records what was asked, answers what it was told to. */
function stubFetch(handlers) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const h = handlers[body.method];
    if (typeof h === 'function') return h(body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: h }),
      { headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

// Noon on the day after these fixtures' bills are written. A transfer has to
// carry a time or the sweep will not judge it at all — money that arrived
// before a bill existed is not payment for it, so "when" is not optional.
const AFTER = Math.floor(Date.parse('2026-08-23T12:00:00Z') / 1000);

const logFor = ({ to = VENUE, value = 73440000n, block = 100, idx = 0, tx = HASH(1), ts = AFTER }) => ({
  transactionHash: tx,
  logIndex: '0x' + idx.toString(16),
  blockNumber: '0x' + block.toString(16),
  blockTimestamp: '0x' + ts.toString(16),
  address: ASSETS['usdc-base'].contract.toLowerCase(),
  topics: [TRANSFER_TOPIC, addressTopic(OTHER), addressTopic(to)],
  data: '0x' + value.toString(16).padStart(64, '0'),
});

/* ── the event signature ─────────────────────────────────────────────────── */

test('the Transfer topic is computed and equals the known constant', () => {
  assert.equal(TRANSFER_TOPIC,
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    'a wrong topic matches nothing — the watcher would look like it works and find no payments, forever');
});

test('an address round-trips through a 32-byte topic', () => {
  assert.equal(addressTopic(VENUE),
    '0x000000000000000000000000' + VENUE.slice(2).toLowerCase());
  assert.equal(topicAddress(addressTopic(VENUE)), VENUE);
  assert.equal(addressTopic('nope'), null);
  assert.equal(topicAddress('0x1234'), null);
});

/* ── the decision that bills a merchant ──────────────────────────────────── */

test('an exact payment settles', () => {
  const v = classify({ crypto_base_units: '73440000' }, { value: 73440000n });
  assert.deepEqual(v, { outcome: 'exact', settle: true });
});

test('underpayment is recorded and refused', () => {
  const v = classify({ crypto_base_units: '73440000' }, { value: 70000000n });
  assert.equal(v.settle, false);
  assert.equal(v.outcome, 'underpaid');
  assert.match(v.detail, /flagged, not settled/);
});

test('overpayment settles — the bill is plainly covered', () => {
  const v = classify({ crypto_base_units: '73440000' }, { value: 80000000n });
  assert.equal(v.settle, true);
  assert.equal(v.outcome, 'overpaid');
});

test('a transfer matching no bill settles nothing', () => {
  assert.equal(classify(null, { value: 1n }).settle, false);
  assert.equal(classify({ crypto_base_units: '0' }, { value: 1n }).settle, false);
});

/* ── the client ──────────────────────────────────────────────────────────── */

test('no endpoint configured is an error, not a silent no-op', async () => {
  await assert.rejects(() => rpc({}, 'eth_blockNumber'), RpcError);
  const { env } = db();
  const out = await sweep({ ...env, NUM_RPC_BASE: '' }, async () => ({ ok: true }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /NUM_RPC_BASE/);
});

test('an RPC error is surfaced, never treated as "no payments"', async () => {
  const { env } = db();
  stubFetch({ eth_blockNumber: () => new Response(
    JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'rate limited' } }),
    { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(() => blockNumber(env), /rate limited/);
});

test('an HTTP failure is an error', async () => {
  const { env } = db();
  stubFetch({ eth_blockNumber: () => new Response('nope', { status: 503 }) });
  await assert.rejects(() => blockNumber(env), /http 503/);
});

test('many recipients are asked for in one call, not one call each', async () => {
  const { env } = db();
  const calls = stubFetch({ eth_getLogs: [] });
  await transfersTo(env, {
    token: ASSETS['usdc-base'].contract,
    recipients: [VENUE, OTHER, VENUE],
    fromBlock: 1, toBlock: 2,
  });
  assert.equal(calls.length, 1);
  const topics = calls[0].params[0].topics;
  assert.equal(topics[0], TRANSFER_TOPIC);
  assert.equal(topics[1], null, 'the sender is not filtered — anyone may pay');
  assert.equal(topics[2].length, 2, 'duplicates collapse');
});

test('a log decodes into the fields the matcher needs', async () => {
  const { env } = db();
  stubFetch({ eth_getLogs: [logFor({ value: 12345n, block: 77, idx: 3 })] });
  const [l] = await transfersTo(env, {
    token: ASSETS['usdc-base'].contract, recipients: [VENUE], fromBlock: 1, toBlock: 2,
  });
  assert.equal(l.value, 12345n);
  assert.equal(l.block_number, 77);
  assert.equal(l.log_index, 3);
  assert.equal(l.to, VENUE);
  assert.equal(l.from, OTHER);
});

/* ── the sweep ───────────────────────────────────────────────────────────── */

test('a paid bill is settled and the transaction is written down', async () => {
  const { d, env } = db();
  bill(d, { token: 'B1' });
  stubFetch({ eth_blockNumber: '0x3e8', eth_getLogs: [logFor({ tx: HASH(7) })] });

  const settled = [];
  const out = await sweep(env, async (e, biz, token, o) => {
    settled.push({ biz, token, by: o.settledBy }); return { ok: true };
  });

  assert.equal(out.settled, 1);
  assert.deepEqual(settled, [{ biz: 'biz1', token: 'B1', by: 'chain' }]);
  assert.equal(d.prepare('SELECT onchain_tx FROM num_paylinks WHERE token=?').get('B1').onchain_tx,
    HASH(7), 'the claim must be checkable against a block explorer');
});

test('the same transfer never settles twice', async () => {
  const { d, env } = db();
  bill(d, { token: 'B1' });
  stubFetch({ eth_blockNumber: '0x3e8', eth_getLogs: [logFor({ tx: HASH(7) })] });

  let calls = 0;
  const fn = async () => { calls++; return { ok: true }; };
  await sweep(env, fn);
  // rewind the watermark so the same log is returned again
  d.prepare('UPDATE num_chain_state SET last_block = 0').run();
  await sweep(env, fn);
  assert.equal(calls, 1, 'a replayed log must not bill the merchant a second time');
});

test('an underpayment is recorded but the bill stays open', async () => {
  const { d, env } = db();
  bill(d, { token: 'B1' });
  stubFetch({ eth_blockNumber: '0x3e8', eth_getLogs: [logFor({ value: 5000000n })] });

  const out = await sweep(env, async () => ({ ok: true }));
  assert.equal(out.settled, 0);
  const s = d.prepare('SELECT outcome, detail FROM num_chain_sightings').get();
  assert.equal(s.outcome, 'underpaid');
  assert.equal(d.prepare('SELECT settled_at FROM num_paylinks WHERE token=?').get('B1').settled_at, null);
});

test('a payment to another venue’s wallet is not our bill', async () => {
  const { d, env } = db();
  bill(d, { token: 'B1', target: VENUE });
  stubFetch({ eth_blockNumber: '0x3e8', eth_getLogs: [logFor({ to: OTHER })] });
  const out = await sweep(env, async () => ({ ok: true }));
  assert.equal(out.settled, 0);
});

test('one wallet with two open bills settles the one the guest actually paid', async () => {
  const { d, env } = db();
  bill(d, { token: 'SMALL', units: '73440000' });
  bill(d, { token: 'BIG', units: '200000000' });
  stubFetch({ eth_blockNumber: '0x3e8', eth_getLogs: [logFor({ value: 73440000n })] });

  const settled = [];
  await sweep(env, async (e, biz, token) => { settled.push(token); return { ok: true }; });
  assert.deepEqual(settled, ['SMALL'], 'paying 73.44 must not close a 200.00 bill');
});

test('the tip of the chain is left alone until it is confirmed', async () => {
  const { d, env } = db();
  bill(d);
  const calls = stubFetch({ eth_blockNumber: '0x3e8', eth_getLogs: [] });
  await sweep(env, async () => ({ ok: true }));
  const range = calls.find((c) => c.method === 'eth_getLogs').params[0];
  assert.equal(parseInt(range.toBlock, 16), 1000 - CONFIRMATIONS,
    'settling on a log that can still be reorged out bills a merchant for money that never existed');
});

test('the watermark advances so the next pass does not re-scan', async () => {
  const { d, env } = db();
  bill(d);
  stubFetch({ eth_blockNumber: '0x3e8', eth_getLogs: [] });
  await sweep(env, async () => ({ ok: true }));
  const st = d.prepare("SELECT last_block, runs FROM num_chain_state WHERE chain='base'").get();
  assert.equal(st.last_block, 1000 - CONFIRMATIONS);
  assert.equal(st.runs, 1);
});

test('a failing endpoint is written down and does not move the watermark', async () => {
  const { d, env } = db();
  bill(d);
  stubFetch({
    eth_blockNumber: '0x3e8',
    eth_getLogs: () => new Response(JSON.stringify({ error: { message: 'boom' } }),
      { headers: { 'content-type': 'application/json' } }),
  });
  const out = await sweep(env, async () => ({ ok: true }));
  assert.equal(out.ok, false);
  const st = d.prepare("SELECT last_block, last_error FROM num_chain_state WHERE chain='base'").get();
  assert.equal(st.last_block, 0, 'a range we never read must be read again');
  assert.match(st.last_error, /boom/);
});

test('nothing open means nothing asked of the chain', async () => {
  const { env } = db();
  const calls = stubFetch({ eth_blockNumber: '0x3e8', eth_getLogs: [] });
  const out = await sweep(env, async () => ({ ok: true }));
  assert.equal(out.bills, 0);
  assert.equal(calls.length, 0, 'no open bills, no RPC bill');
});

test('an already-settled bill is not watched', async () => {
  const { d, env } = db();
  bill(d, { token: 'DONE', settled: '2026-08-22T10:00:00Z' });
  const calls = stubFetch({ eth_blockNumber: '0x3e8', eth_getLogs: [] });
  const out = await sweep(env, async () => ({ ok: true }));
  assert.equal(out.bills, 0);
  assert.equal(calls.length, 0);
});

test('status says plainly whether the watcher is switched on', async () => {
  const { env } = db();
  assert.equal((await watcherStatus(env)).configured, true);
  assert.equal((await watcherStatus({ ...env, NUM_RPC_BASE: '' })).configured, false);
});

/* ── money that arrives after the code expired ───────────────────────────── */

test('a payment against an expired code is recorded, not settled', async () => {
  const { d, env } = db();
  bill(d, { token: 'GONE' });
  d.prepare("UPDATE num_paylinks SET state='revoked' WHERE token='GONE'").run();
  d.prepare("UPDATE num_paylinks SET revoked_by='agent', revoked_at=? WHERE token='GONE'")
    .run(new Date().toISOString());

  stubFetch({ eth_blockNumber: '0x3e8', eth_getLogs: [logFor({ tx: HASH(9) })] });
  const settled = [];
  const out = await sweep(env, async (e, b, t) => { settled.push(t); return { ok: true }; });

  assert.equal(settled.length, 0, 'a retired code must stay retired');
  const s = d.prepare('SELECT outcome, detail FROM num_chain_sightings').get();
  assert.equal(s.outcome, 'paid_after_expiry',
    'the venue has the money — if we never look, we never bill for a table we filled');
  assert.match(s.detail, /needs a human/);
  assert.equal(out.matched, 1);
});

test('an expired code older than a day is no longer watched', async () => {
  const { d, env } = db();
  bill(d, { token: 'ANCIENT' });
  d.prepare("UPDATE num_paylinks SET state='revoked', revoked_by='agent', revoked_at=? WHERE token='ANCIENT'")
    .run(new Date(Date.now() - 5 * 86400_000).toISOString());
  const calls = stubFetch({ eth_blockNumber: '0x3e8', eth_getLogs: [] });
  const out = await sweep(env, async () => ({ ok: true }));
  assert.equal(out.bills, 0);
  assert.equal(calls.length, 0);
});

test('a code a person revoked is not watched at all', async () => {
  const { d, env } = db();
  bill(d, { token: 'PULLED' });
  d.prepare("UPDATE num_paylinks SET state='revoked', revoked_by='bu_owner', revoked_at=? WHERE token='PULLED'")
    .run(new Date().toISOString());
  const out = await sweep(env, async () => ({ ok: true }));
  assert.equal(out.bills, 0, 'an owner who pulled a code meant it');
});
