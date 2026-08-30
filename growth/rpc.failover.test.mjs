/**
 * rpc — endpoint failover, and the rule that a failed pass must LOOK failed.
 *
 * Both of these exist because of one live incident. The watcher was pointed at
 * a single public Base endpoint. It answered a laptop instantly and returned
 * 429 to the Worker, whose requests leave from a shared Cloudflare egress pool
 * that the rest of the internet also uses. Every pass died on its first call.
 *
 * That alone would have been an afternoon's annoyance. What made it dangerous
 * is that the throw escaped before anything was written down, so the console
 * reported last_error: null and runs: 0 — indistinguishable from a healthy
 * watcher with nothing to do. A real payment sat unsettled and every status
 * page we had said everything was fine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  endpoints, rpc, sweep, watcherStatus, TRANSFER_TOPIC, addressTopic, OVERLAP,
} from './rpc.mjs';
import { ASSETS } from './crypto.mjs';

const VENUE = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const OTHER = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const GOOD = 'https://good.example';
const BAD = 'https://throttled.example';

function db(rpcBase) {
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
  return { d, env: { DB, NUM_RPC_BASE: rpcBase ?? `${BAD},${GOOD}` } };
}

function bill(d, token = 'B1', units = '550000') {
  d.prepare(`INSERT INTO num_paylinks
    (token,business_id,label,kind,target,crypto_asset,amount_mode,amount,currency,state,
     created_at,one_time,crypto_base_units)
    VALUES (?,'biz1','Bill','crypto',?,'usdc-base','fixed','18.00','THB','active','2026-08-22',1,?)`)
    .run(token, VENUE, units);
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A stub that answers differently per endpoint, which is the whole point. */
function stubByHost(perHost) {
  const hits = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    hits.push({ url: String(url), method: body.method });
    const h = perHost[String(url)];
    if (!h) throw new Error(`unexpected endpoint ${url}`);
    return h(body);
  };
  return hits;
}

// After the bills these fixtures write. A transfer with no time is never
// judged — see rpc.timing.test.mjs for why that rule exists.
const AFTER = Math.floor(Date.parse('2026-08-23T12:00:00Z') / 1000);

const logFor = ({ value = 550000n, block = 100, tx = '0x' + 'a'.repeat(64), ts = AFTER } = {}) => ({
  transactionHash: tx,
  logIndex: '0x0',
  blockNumber: '0x' + block.toString(16),
  blockTimestamp: '0x' + ts.toString(16),
  address: ASSETS['usdc-base'].contract.toLowerCase(),
  topics: [TRANSFER_TOPIC, addressTopic(OTHER), addressTopic(VENUE)],
  data: '0x' + value.toString(16).padStart(64, '0'),
});

/* ── reading the list ────────────────────────────────────────────────────── */

test('NUM_RPC_BASE is read as a list, and tolerates the spacing a human types', () => {
  assert.deepEqual(endpoints({ NUM_RPC_BASE: 'https://a, https://b ,,https://c ' }),
    ['https://a', 'https://b', 'https://c']);
  assert.deepEqual(endpoints({ NUM_RPC_BASE: 'https://only' }), ['https://only'],
    'one URL must keep working — every existing deployment has one');
  assert.deepEqual(endpoints({}), []);
  assert.deepEqual(endpoints({ NUM_RPC_BASE: '  ,  ' }), [],
    'a list of nothing is not configured, however it is punctuated');
});

/* ── failing over ────────────────────────────────────────────────────────── */

test('a 429 on the first endpoint falls through to the second', async () => {
  const { env } = db();
  const hits = stubByHost({
    [BAD]: () => json({ error: 'rate limited' }, 429),
    [GOOD]: () => json({ jsonrpc: '2.0', id: 1, result: '0x3e8' }),
  });
  assert.equal(await rpc(env, 'eth_blockNumber'), '0x3e8');
  assert.deepEqual(hits.map((h) => h.url), [BAD, GOOD], 'in order, and only as far as needed');
});

test('an endpoint that refuses the RANGE also fails over, not just one that refuses us', async () => {
  // 1rpc caps eth_getLogs at 50 blocks and says so in a JSON-RPC error body,
  // not an HTTP status. Treating that as a real answer would strand the sweep
  // on a node that can never serve a cron-sized window.
  const { env } = db();
  stubByHost({
    [BAD]: () => json({ jsonrpc: '2.0', id: 1, error: { message: 'eth_getLogs is limited to 0 - 50 blocks range' } }),
    [GOOD]: () => json({ jsonrpc: '2.0', id: 1, result: [] }),
  });
  assert.deepEqual(await rpc(env, 'eth_getLogs', [{}]), []);
});

test('a healthy first endpoint is never second-guessed', async () => {
  const { env } = db(`${GOOD},${BAD}`);
  const hits = stubByHost({
    [GOOD]: () => json({ jsonrpc: '2.0', id: 1, result: '0x1' }),
    [BAD]: () => { throw new Error('must not be reached'); },
  });
  await rpc(env, 'eth_blockNumber');
  assert.equal(hits.length, 1, 'spares are spares, not extra load');
});

test('when every endpoint refuses, the error says so', async () => {
  const { env } = db();
  stubByHost({
    [BAD]: () => json({ error: 'nope' }, 429),
    [GOOD]: () => json({ error: 'nope' }, 503),
  });
  await assert.rejects(() => rpc(env, 'eth_blockNumber'), (e) => {
    assert.match(String(e.message), /http 503/, 'the last reason survives');
    assert.match(String(e.message), /all 2 endpoints failed/,
      'so a log line reads as an outage, not one flaky node');
    return true;
  });
});

test('a sweep survives a throttled primary and still settles the payment', async () => {
  const { d, env } = db();
  bill(d);
  stubByHost({
    [BAD]: () => json({ error: 'rate limited' }, 429),
    [GOOD]: (b) => json({
      jsonrpc: '2.0', id: 1,
      result: b.method === 'eth_blockNumber' ? '0x3e8' : [logFor()],
    }),
  });
  const settled = [];
  const out = await sweep(env, async (e, biz, token) => { settled.push(token); return { ok: true }; });
  assert.equal(out.ok, true);
  assert.deepEqual(settled, ['B1'], 'money that landed gets billed, throttling or not');
});

/* ── the silent-failure bug ──────────────────────────────────────────────── */

test('a pass that dies on its first call is written down, not swallowed', async () => {
  const { d, env } = db(BAD);
  bill(d);
  stubByHost({ [BAD]: () => json({ error: 'rate limited' }, 429) });

  const out = await sweep(env, async () => ({ ok: true }));
  assert.equal(out.ok, false);

  const st = d.prepare("SELECT * FROM num_chain_state WHERE chain='base'").get();
  assert.ok(st, 'this row not existing is exactly how the outage hid for hours');
  assert.equal(st.runs, 1, 'a pass that ran and failed still ran');
  assert.match(st.last_error, /429/, 'and the reason has to be legible without a log tail');
  assert.ok(st.last_run_at, 'a watcher that never records a run looks like one with no work');
});

test('the watermark does not advance when the endpoint fails', async () => {
  const { d, env } = db(BAD);
  bill(d);
  d.prepare("INSERT INTO num_chain_state (chain,last_block) VALUES ('base',900)").run();
  stubByHost({ [BAD]: () => json({ error: 'rate limited' }, 429) });

  await sweep(env, async () => ({ ok: true }));
  const st = d.prepare("SELECT * FROM num_chain_state WHERE chain='base'").get();
  assert.equal(st.last_block, 900,
    'skipping past unread blocks would lose the payment in them permanently');
});

test('a recovered pass clears the error it recorded', async () => {
  const { d, env } = db();
  bill(d);

  stubByHost({ [BAD]: () => json({ error: 'rate limited' }, 429), [GOOD]: () => json({ error: 'down' }, 503) });
  await sweep(env, async () => ({ ok: true }));
  assert.match(d.prepare("SELECT last_error FROM num_chain_state WHERE chain='base'").get().last_error, /503/);

  stubByHost({
    [BAD]: () => json({ error: 'rate limited' }, 429),
    [GOOD]: (b) => json({ jsonrpc: '2.0', id: 1, result: b.method === 'eth_blockNumber' ? '0x3e8' : [] }),
  });
  await sweep(env, async () => ({ ok: true }));
  const st = d.prepare("SELECT * FROM num_chain_state WHERE chain='base'").get();
  assert.equal(st.last_error, null, 'a stale error would have us chasing an outage that ended');
  assert.equal(st.runs, 2);
});

/* ── the second round ────────────────────────────────────────────────────── */

test('a throttle that lifts a moment later does not cost us the pass', async () => {
  const { env } = db(BAD);
  let n = 0;
  stubByHost({
    [BAD]: () => (++n === 1
      ? json({ error: 'rate limited' }, 429)
      : json({ jsonrpc: '2.0', id: 1, result: '0x3e8' })),
  });
  assert.equal(await rpc(env, 'eth_blockNumber', [], { pauseMs: 1 }), '0x3e8');
  assert.equal(n, 2, 'these limits are shared across all of Cloudflare — a 429 is often just this minute');
});

test('the retry is bounded, so a dead provider cannot hold the whole cron', async () => {
  const { env } = db();
  const hits = stubByHost({
    [BAD]: () => json({ error: 'down' }, 503),
    [GOOD]: () => json({ error: 'down' }, 503),
  });
  await assert.rejects(() => rpc(env, 'eth_blockNumber', [], { pauseMs: 1 }));
  assert.equal(hits.length, 4, '2 endpoints × 2 rounds, and then it gives up');
});

/* ── re-reading recent ground ────────────────────────────────────────────── */

test('each pass re-reads the recent past, because a node can answer with a lie', async () => {
  // meowrpc returned HTTP 200 and [] for a range that provably held the
  // payment. Advancing the watermark on that answer loses the money forever.
  const { d, env } = db(GOOD);
  bill(d);
  // Close enough behind the tip that the MAX_RANGE clamp is not what decides
  // the window — otherwise this test would pass without the overlap existing.
  d.prepare("INSERT INTO num_chain_state (chain,last_block) VALUES ('base',9000)").run();

  let asked = null;
  stubByHost({
    [GOOD]: (b) => {
      if (b.method === 'eth_blockNumber') return json({ jsonrpc: '2.0', id: 1, result: '0x2710' });
      asked = b.params[0];
      return json({ jsonrpc: '2.0', id: 1, result: [] });
    },
  });
  await sweep(env, async () => ({ ok: true }));

  assert.equal(Number(asked.fromBlock), 9001 - OVERLAP,
    'a second look at ground we have already covered is the whole point');
});

test('re-reading never settles the same transfer twice', async () => {
  const { d, env } = db(GOOD);
  bill(d);
  const answer = (b) => json({
    jsonrpc: '2.0', id: 1,
    result: b.method === 'eth_blockNumber' ? '0x2710' : [logFor({ block: 9000 })],
  });
  stubByHost({ [GOOD]: answer });

  const settled = [];
  const settle = async (e, biz, token) => {
    settled.push(token);
    d.prepare('UPDATE num_paylinks SET settled_at = ? WHERE token = ?')
      .run(new Date().toISOString(), token);
    return { ok: true };
  };
  await sweep(env, settle);
  await sweep(env, settle);

  assert.deepEqual(settled, ['B1'], 'the overlap must be free, or it is not worth having');
  assert.equal(d.prepare('SELECT COUNT(*) c FROM num_chain_sightings').get().c, 1);
});

/* ── what the console is told ────────────────────────────────────────────── */

test('status reports how many endpoints we carry, and never which', async () => {
  const { env } = db();
  const s = await watcherStatus(env);
  assert.equal(s.configured, true);
  assert.equal(s.endpoints, 2);
  assert.equal(JSON.stringify(s).includes('throttled.example'), false,
    'a venue-facing endpoint has no business publishing our provider list');

  const off = await watcherStatus({ ...env, NUM_RPC_BASE: '' });
  assert.equal(off.configured, false);
  assert.equal(off.endpoints, 0);
});
