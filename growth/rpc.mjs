/**
 * rpc — watching the chain for a payment that has actually landed.
 *
 * This is the thing a bank rail cannot do. When a guest pays by PromptPay,
 * NUM sees a scan and then waits for a member of staff to tap "Paid" — a
 * human step that gets forgotten on a busy Saturday, and a bill that is never
 * settled is a fee never charged. A stablecoin transfer is public: the exact
 * amount, to the exact address, is visible to anyone who looks. So we look.
 *
 * The rules this file will not bend:
 *
 *   • It only ever READS. There is no signer here, no key, and no transaction
 *     is ever sent. The worst a compromised RPC endpoint can do is lie about
 *     whether money arrived, and every claim it makes is written down with
 *     the transaction hash so a human can check it against a block explorer.
 *   • Underpayment never settles. A transfer smaller than the bill is
 *     recorded and flagged, not waved through.
 *   • Confirmations are waited for. A log from the very tip of the chain can
 *     vanish in a reorg, and settling on one would bill a merchant for money
 *     that never existed.
 */

import { keccak256, ASSETS, validAddress } from './crypto.mjs';

/* ── the event we are looking for ────────────────────────────────────────
 * Computed, not pasted. A wrong topic hash silently matches nothing — the
 * watcher would run forever, find no payments, and look like it was working.
 * The test asserts this equals the well-known constant.
 */
export const TRANSFER_TOPIC =
  '0x' + keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'));

/** An address as a 32-byte topic: left-padded, lowercase. */
export function addressTopic(addr) {
  const v = validAddress(addr);
  if (!v.ok) return null;
  return '0x' + v.address.slice(2).toLowerCase().padStart(64, '0');
}

/** The 20-byte address back out of a 32-byte topic. */
export function topicAddress(topic) {
  const t = String(topic || '').replace(/^0x/, '');
  if (t.length !== 64) return null;
  const v = validAddress('0x' + t.slice(24));
  return v.ok ? v.address : null;
}

const hexToBigInt = (h) => {
  const s = String(h || '0x0');
  try { return BigInt(s); } catch { return null; }
};

/* ── the client ──────────────────────────────────────────────────────────── */

export class RpcError extends Error {}

/**
 * The endpoints to try, in order.
 *
 * NUM_RPC_BASE is a comma-separated LIST, not one URL, and that is not a
 * nicety. The public Base endpoint answers happily from a laptop and returns
 * 429 to a Cloudflare Worker, because a Worker's requests leave from a shared
 * egress pool that the rest of the internet is also hammering. We found this
 * the only way you ever find it: a watcher that reported itself healthy for
 * hours while every single pass died on someone else's rate limit.
 *
 * Reads are idempotent, so trying the next endpoint costs nothing and can
 * never double-settle anything. Carry spares.
 */
export function endpoints(env) {
  return String(env.NUM_RPC_BASE || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * One JSON-RPC call to one endpoint.
 *
 * Times out on its own. A cron pass that hangs on a wedged endpoint holds the
 * whole scheduled run, including the invoice run that shares it.
 */
async function rpcOnce(endpoint, method, params, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctl.signal,
    });
  } catch (e) {
    throw new RpcError(`rpc ${method} failed: ${String(e).slice(0, 120)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new RpcError(`rpc ${method} http ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!body) throw new RpcError(`rpc ${method} returned nothing readable`);
  if (body.error) throw new RpcError(`rpc ${method}: ${String(body.error.message || body.error).slice(0, 160)}`);
  return body.result;
}

/**
 * One JSON-RPC call, against whichever endpoint answers.
 *
 * Every failure is worth failing over on, including a JSON-RPC error body:
 * providers disagree about how many blocks eth_getLogs may span and whether
 * an archive range needs a paid token, so "this node won't" is routinely a
 * fact about the node and not about the question.
 */
export async function rpc(env, method, params = [], {
  timeoutMs = 8000, url = null, rounds = 2, pauseMs = 400,
} = {}) {
  const list = url ? [url] : endpoints(env);
  if (!list.length) throw new RpcError('no RPC endpoint configured — set NUM_RPC_BASE');

  let last = null;
  for (let round = 0; round < Math.max(1, rounds); round++) {
    // Measured, not assumed: probing from real Worker egress, the same
    // endpoint answered one minute and returned 429 the next. These limits
    // are shared across everything running on Cloudflare, so a refusal says
    // more about the last sixty seconds than about the endpoint. One patient
    // second beats losing a fifteen-minute pass.
    if (round > 0) await new Promise((r) => setTimeout(r, pauseMs));
    for (const endpoint of list) {
      try {
        return await rpcOnce(endpoint, method, params, timeoutMs);
      } catch (e) {
        last = e;
      }
    }
  }
  // The last endpoint's reason, plus how many we got through — so a log line
  // says "everything refused" rather than looking like a single bad node.
  throw new RpcError(
    `${String(last?.message || last)}${list.length > 1 ? ` (all ${list.length} endpoints failed)` : ''}`,
  );
}

export async function blockNumber(env, opts = {}) {
  const n = hexToBigInt(await rpc(env, 'eth_blockNumber', [], opts));
  if (n === null) throw new RpcError('eth_blockNumber returned nonsense');
  return Number(n);
}

/**
 * ERC-20 Transfers into any of `recipients`, in one call.
 *
 * topics[2] takes an array, which the node treats as OR — so a hundred open
 * bills across a hundred venues is still one request per block range, not a
 * hundred. Anything else would not survive a busy Saturday.
 */
export async function transfersTo(env, { token, recipients, fromBlock, toBlock }, opts = {}) {
  // Deduped here rather than trusting the caller: two venues sharing a wallet,
  // or two open bills on one, would otherwise repeat the same topic and make
  // the filter bigger than it needs to be for no benefit.
  const seen = new Set();
  for (const r of recipients || []) {
    const t = addressTopic(r);
    if (t) seen.add(t);
  }
  const tops = [...seen];
  if (!tops.length) return [];

  const logs = await rpc(env, 'eth_getLogs', [{
    address: token,
    fromBlock: '0x' + Number(fromBlock).toString(16),
    toBlock: '0x' + Number(toBlock).toString(16),
    topics: [TRANSFER_TOPIC, null, tops],
  }], opts);

  if (!Array.isArray(logs)) return [];
  return logs.map((l) => ({
    tx_hash: l.transactionHash,
    log_index: Number(hexToBigInt(l.logIndex) ?? 0),
    block_number: Number(hexToBigInt(l.blockNumber) ?? 0),
    token: String(l.address || '').toLowerCase(),
    from: topicAddress(l.topics?.[1]),
    to: topicAddress(l.topics?.[2]),
    // `data` is the uint256 value. A Transfer log has exactly one non-indexed
    // parameter, so the whole data field is the amount.
    value: hexToBigInt(l.data),
    // Some providers hand back the block time with the log, which saves a
    // second call. Absent on others, so it is a bonus and never a requirement.
    block_time: l.blockTimestamp ? Number(hexToBigInt(l.blockTimestamp) ?? 0) || null : null,
  })).filter((l) => l.to && l.value !== null);
}

/**
 * When each of these blocks happened, in seconds.
 *
 * Asked one block at a time, but only for blocks that actually carried a
 * transfer into one of our wallets — a handful a day, not a scan.
 */
export async function blockTimes(env, numbers, opts = {}) {
  const out = new Map();
  for (const n of new Set(numbers)) {
    const b = await rpc(env, 'eth_getBlockByNumber',
      ['0x' + Number(n).toString(16), false], opts).catch(() => null);
    const t = b?.timestamp ? Number(hexToBigInt(b.timestamp) ?? 0) : 0;
    if (t) out.set(n, t);
  }
  return out;
}

/* ── matching a transfer to a bill ───────────────────────────────────────── */

/**
 * Decide what a transfer means for a bill.
 *
 * Exported and pure so the decision can be tested without a chain: this is
 * the function that decides whether a merchant gets billed, and it should be
 * possible to read every branch of it in one screen.
 */
/**
 * Clock slack between D1 and the chain when deciding "did this arrive after
 * the bill existed". Two minutes is far more than either drifts, and the real
 * sequence has a person scanning a code and opening a wallet, which is never
 * two minutes of negative time.
 */
export const CLOCK_GRACE_S = 120;

export function classify(bill, log) {
  if (!bill) return { outcome: 'no_bill', settle: false };
  const want = BigInt(bill.crypto_base_units || '0');
  if (want <= 0n) return { outcome: 'no_amount', settle: false };

  // Money that landed BEFORE the bill was written cannot be payment for it.
  //
  // The date is a precondition, not an option: sweep() will not hand a log to
  // this function until it knows when that log happened, precisely so this
  // branch cannot be skipped by accident. Undated money is never settled.
  //
  // Found live, on the first real payment we ever watched for. The test wallet
  // had earlier USDC in it from other traffic; the sweep looked back over the
  // recent past, found a 2.18 transfer from sixteen minutes before the bill
  // existed, and settled the bill against it. On a real venue wallet — which
  // receives money for all sorts of reasons — that means the next bill a
  // venue opens is marked paid the instant it is created: staff are told a
  // guest has paid who has not, and NUM invoices commission on a table that
  // was never settled. An amount matching by coincidence is not payment.
  if (log.block_time && bill.created_at) {
    const born = Date.parse(bill.created_at);
    if (Number.isFinite(born) && log.block_time * 1000 < born - CLOCK_GRACE_S * 1000) {
      return {
        outcome: 'predates_bill',
        settle: false,
        detail: `landed ${new Date(log.block_time * 1000).toISOString()}, before this bill existed (${bill.created_at})`,
      };
    }
  }

  // The code had already expired when this landed. The money is real and the
  // venue has it, so it is recorded loudly — but a retired code stays retired,
  // and a person decides whether to bill for it.
  if (bill.state === 'revoked') {
    return {
      outcome: 'paid_after_expiry',
      settle: false,
      detail: `sent ${log.value} against a code that had already expired — needs a human`,
    };
  }

  if (log.value < want) {
    return {
      outcome: 'underpaid',
      settle: false,
      detail: `sent ${log.value} of ${want} — flagged, not settled`,
    };
  }
  if (log.value > want) {
    // Overpayment still settles: the guest has paid the bill and more. The
    // excess is between them and the venue, and refusing to settle would
    // leave the bill open on a payment that plainly covered it.
    return { outcome: 'overpaid', settle: true, detail: `sent ${log.value} of ${want}` };
  }
  return { outcome: 'exact', settle: true };
}

/* ── the sweep ───────────────────────────────────────────────────────────── */

// A log at the tip can disappear in a reorg. Base is fast and rarely reorgs,
// but "rarely" is not "never" and the cost of being wrong is billing a
// merchant for money that was never there.
export const CONFIRMATIONS = 6;
// eth_getLogs on a huge range is refused by most providers. Chosen to cover
// well over a 15-minute cron gap on a 2-second chain with room to catch up.
export const MAX_RANGE = 3000;
/**
 * How far back each pass re-reads over ground it has already covered.
 *
 * Not paranoia — a measurement. One public endpoint answered a range that
 * provably contains a payment with HTTP 200 and an empty array: it was not an
 * archive node and said "no logs" rather than "I cannot answer that". A
 * watcher that advances its watermark on that reply walks straight past the
 * money and never looks again.
 *
 * Re-reading is free and cannot double-settle: every sighting is unique on
 * (chain, tx_hash, log_index), and a row that was already there settles
 * nothing. So we always give ourselves a second look at the recent past, and
 * a node that lies once costs us a delay instead of a payment.
 */
export const OVERLAP = 300;

async function chainState(env, chain) {
  return env.DB.prepare(
    'SELECT chain, last_block, runs, matched FROM num_chain_state WHERE chain = ?1',
  ).bind(chain).first().catch(() => null);
}

/**
 * Write down that a pass failed, and why.
 *
 * This exists because of the worst kind of bug we have shipped: the watcher
 * threw on its very first RPC call, every pass, for hours — and because
 * nothing recorded that, the console showed last_error: null and runs: 0,
 * which reads exactly like a watcher that simply has nothing to do. A money
 * process that fails must look failed. Silence is the bug.
 */
async function noteError(env, chain, e) {
  await env.DB.prepare(
    `INSERT INTO num_chain_state (chain,last_block,last_run_at,last_error,runs)
     VALUES (?1,0,?2,?3,1)
     ON CONFLICT(chain) DO UPDATE SET last_run_at=?2, last_error=?3, runs=runs+1`,
  ).bind(chain, new Date().toISOString(), String(e).slice(0, 300)).run().catch(() => {});
}

/**
 * Look for payments against every open crypto bill, and settle what has landed.
 *
 * `settleFn` is injected rather than imported so this file never has to reach
 * into the money path, and so a test can watch what it would have settled
 * without settling anything.
 */
export async function sweep(env, settleFn, { assetKey = 'usdc-base', now = null } = {}) {
  const asset = ASSETS[assetKey];
  if (!asset) return { ok: false, reason: 'unknown asset' };
  if (!endpoints(env).length) return { ok: false, reason: 'no RPC endpoint configured — set NUM_RPC_BASE' };

  // Open bills, AND bills the agent expired in the last day.
  //
  // The expired ones are deliberate. A bill code dies after 90 minutes, but
  // money does not care: a guest who pays at minute 95 has genuinely paid,
  // and the venue has genuinely received it. Watching only live codes means
  // that payment is invisible to us forever — the venue keeps the money and
  // NUM never bills for a table it filled. So we look for it, record it, and
  // flag it. We do NOT settle it: a retired code must stay retired, and a
  // human should decide whether to re-issue or write it off.
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { results: bills } = await env.DB.prepare(
    `SELECT token, business_id, target, crypto_base_units, amount, currency, created_at, state
       FROM num_paylinks
      WHERE kind = 'crypto' AND COALESCE(one_time,0) = 1
        AND settled_at IS NULL
        AND crypto_base_units IS NOT NULL
        AND COALESCE(crypto_asset,'usdc-base') = ?1
        AND (state = 'active'
             OR (state = 'revoked' AND revoked_by = 'agent' AND revoked_at >= ?2))
      LIMIT 500`,
  ).bind(assetKey, dayAgo).all().catch(() => ({ results: [] }));

  if (!bills?.length) return { ok: true, bills: 0, matched: 0, settled: 0 };

  // Wrapped, because this is the call that was dying. A throw here used to
  // escape the whole function and leave no trace at all in num_chain_state.
  let tip;
  try {
    tip = await blockNumber(env);
  } catch (e) {
    await noteError(env, asset.chain, e);
    return { ok: false, reason: String(e).slice(0, 200), bills: bills.length };
  }
  const safeTip = tip - CONFIRMATIONS;
  if (safeTip <= 0) return { ok: true, bills: bills.length, matched: 0, settled: 0, note: 'chain too young' };

  const st = await chainState(env, asset.chain);
  // First run: start just behind the tip rather than at genesis. An unpaid
  // bill older than that window is a support question, not a scan.
  const from = st?.last_block
    ? Math.max(st.last_block + 1 - OVERLAP, safeTip - MAX_RANGE, 0)
    : safeTip - 500;
  const to = Math.min(safeTip, from + MAX_RANGE);
  if (to < from) return { ok: true, bills: bills.length, matched: 0, settled: 0, note: 'caught up' };

  const recipients = [...new Set(bills.map((b) => b.target))];

  let logs;
  try {
    logs = await transfersTo(env, {
      token: asset.contract, recipients, fromBlock: from, toBlock: to,
    });
  } catch (e) {
    await noteError(env, asset.chain, e);
    return { ok: false, reason: String(e).slice(0, 200), from, to };
  }

  // Oldest first, so the earliest transfer settles a bill rather than a later
  // one that happened to be returned first.
  logs.sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index);

  // Date every transfer before judging any of them.
  //
  // Whether money arrived before or after the bill was written is the
  // difference between a settled table and a venue told a guest has paid who
  // has not, so it is not something to be optimistic about. Most providers
  // return the block time with the log; for the rest we ask, once per block.
  let stopAt = to;
  const undated = logs.filter((l) => !l.block_time).map((l) => l.block_number);
  if (undated.length) {
    const times = await blockTimes(env, undated).catch(() => new Map());
    for (const l of logs) if (!l.block_time) l.block_time = times.get(l.block_number) || null;

    // Anything still undated is left strictly alone: not recorded, not
    // settled, and NOT passed over. Holding the watermark below it means the
    // next pass sees it again — a transient RPC failure costs a quarter of an
    // hour, where writing a verdict we could not justify would cost a payment.
    const stillDark = logs.filter((l) => !l.block_time).map((l) => l.block_number);
    if (stillDark.length) {
      stopAt = Math.min(stopAt, Math.min(...stillDark) - 1);
      logs = logs.filter((l) => l.block_time && l.block_number <= stopAt);
    }
  }

  const byAddress = new Map();
  for (const b of bills) {
    const k = b.target.toLowerCase();
    if (!byAddress.has(k)) byAddress.set(k, []);
    byAddress.get(k).push(b);
  }

  let matched = 0; let settled = 0;
  const events = [];

  for (const log of logs) {
    const candidates = (byAddress.get(String(log.to).toLowerCase()) || [])
      .filter((b) => !b._done);
    // The bill this transfer is for: the cheapest open one it covers, so a
    // guest paying 73.44 settles the 73.44 bill and not a 200.00 one that
    // happens to be open on the same wallet.
    const bill = candidates
      .filter((b) => log.value >= BigInt(b.crypto_base_units || '0'))
      .sort((a, b) => (BigInt(b.crypto_base_units) < BigInt(a.crypto_base_units) ? 1 : -1))[0]
      || candidates[0] || null;

    const verdict = classify(bill, log);
    matched += bill ? 1 : 0;

    const ins = await env.DB.prepare(
      `INSERT INTO num_chain_sightings
         (chain,tx_hash,log_index,block_number,token,to_address,value_base,token_matched,outcome,detail,created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
       ON CONFLICT(chain,tx_hash,log_index) DO NOTHING`,
    ).bind(
      asset.chain, log.tx_hash, log.log_index, log.block_number, log.token, log.to,
      log.value.toString(), bill?.token ?? null, verdict.outcome, verdict.detail ?? null,
      new Date().toISOString(),
    ).run().catch(() => null);

    // Already recorded on an earlier pass — do not settle from it twice.
    if (!ins?.meta?.changes) continue;

    if (verdict.settle && bill) {
      await env.DB.prepare(
        'UPDATE num_paylinks SET onchain_tx = ?2 WHERE token = ?1 AND onchain_tx IS NULL',
      ).bind(bill.token, log.tx_hash).run().catch(() => {});
      const out = await settleFn(env, bill.business_id, bill.token, { settledBy: 'chain' })
        .catch(() => null);
      if (out?.ok) { settled++; bill._done = true; }
      events.push({ token: bill.token, tx: log.tx_hash, outcome: verdict.outcome, settled: !!out?.ok });
    } else if (bill) {
      events.push({ token: bill.token, tx: log.tx_hash, outcome: verdict.outcome, settled: false });
    }
  }

  await env.DB.prepare(
    `INSERT INTO num_chain_state (chain,last_block,last_run_at,last_error,runs,matched)
     VALUES (?1,?2,?3,NULL,1,?4)
     ON CONFLICT(chain) DO UPDATE SET
       last_block=?2, last_run_at=?3, last_error=NULL, runs=runs+1, matched=matched+?4`,
    // stopAt, not `to`: if a block could not be dated we have deliberately not
    // judged it, and the watermark must not claim we did.
  ).bind(asset.chain, stopAt, new Date().toISOString(), matched).run().catch(() => {});

  return { ok: true, chain: asset.chain, from, to: stopAt, scanned_to: to,
           bills: bills.length, logs: logs.length, matched, settled, events };
}

/** What the watcher has been doing, for the console and for a human. */
export async function watcherStatus(env) {
  const { results } = await env.DB.prepare(
    'SELECT chain, last_block, last_run_at, last_error, runs, matched FROM num_chain_state',
  ).all().catch(() => ({ results: [] }));
  return {
    configured: endpoints(env).length > 0,
    // The count, never the URLs. How many spares we carry is operationally
    // useful; which providers we lean on is not the venue's business.
    endpoints: endpoints(env).length,
    confirmations: CONFIRMATIONS,
    chains: results ?? [],
  };
}
