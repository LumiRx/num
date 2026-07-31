// On-chain checks for Base, over plain JSON-RPC.
//
// The hardcoded danger list in preflight.mjs caught one wallet because someone
// happened to know what 0x8335…2913 is. That does not scale — there are
// thousands of contract addresses and a member can paste any of them. This
// asks the chain instead:
//
//   eth_getCode  — if an address has bytecode it is a CONTRACT. Sending USDC to
//                  a contract that has no way to move it is a permanent loss,
//                  and that single check catches every case the list misses.
//   eth_getBalance / transaction count — an address that has never been seen on
//                  Base is worth a second look before a first payout.
//   balanceOf    — what the treasury actually holds, so a batch is not approved
//                  against money that is not there.
//
// Read-only. Nothing here can move funds; it exists to stop a payment, never to
// make one.

export const BASE_MAINNET = { chainId: 8453, name: 'Base', rpc: 'https://mainnet.base.org' };

/** USDC on Base. Six decimals, not eighteen — the classic way to overpay 10^12x. */
export const USDC = { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, symbol: 'USDC' };

const rpcUrl = (env) => env?.USDC_RPC_URL || BASE_MAINNET.rpc;

async function rpc(env, method, params = []) {
  const res = await fetch(rpcUrl(env), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? 'RPC error');
  return body.result;
}

/** Cents (integer USD) → USDC base units. Kept in one place, deliberately. */
export const centsToUnits = (cents) => BigInt(Math.round(cents)) * 10n ** BigInt(USDC.decimals - 2);

export const unitsToUsd = (units) => Number(BigInt(units)) / 10 ** USDC.decimals;

// ── address hygiene ─────────────────────────────────────────────────────────

const HEX40 = /^0x[0-9a-fA-F]{40}$/;

export const normaliseAddress = (raw) => {
  const a = String(raw ?? '').split(':').pop().trim();
  return HEX40.test(a) ? a.toLowerCase() : null;
};

/**
 * EIP-55 mixed-case checksum. If a member pastes a checksummed address and one
 * character is wrong, this catches it before the money goes to a stranger —
 * an all-lowercase address carries no such protection, which is why we only
 * assert when the input actually had mixed case.
 */
export async function checksumProblem(raw) {
  const a = String(raw ?? '').split(':').pop().trim();
  if (!HEX40.test(a)) return 'not a valid address';
  const body = a.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return null; // no checksum to verify
  const hash = await keccak256(new TextEncoder().encode(body.toLowerCase()));
  let expected = '0x';
  for (let i = 0; i < body.length; i++) {
    const nibble = parseInt(hash[i >> 1].toString(16).padStart(2, '0')[i & 1], 16);
    expected += nibble >= 8 ? body[i].toUpperCase() : body[i].toLowerCase();
  }
  return expected === a ? null : 'the address checksum does not match — one character is probably wrong';
}

// Minimal keccak-256. Needed only for the checksum check above; no dependency
// is worth pulling in for 60 lines that never touch a key.
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const R = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M64 = (1n << 64n) - 1n;
const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64;

export async function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    for (let round = 0; round < 24; round++) {
      const C = new Array(5);
      for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
      const D = new Array(5);
      for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] ^= D[x];

      const B = new Array(25).fill(0n);
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], R[x + 5 * y]);
      }
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & B[((x + 2) % 5) + 5 * y] & M64);
      }
      A[0] ^= RC[round];
    }
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

// ── the checks ──────────────────────────────────────────────────────────────

/**
 * Is this address a contract? The single most valuable question before sending
 * USDC, because a contract that cannot forward a token holds it forever.
 */
export async function isContract(env, address) {
  const code = await rpc(env, 'eth_getCode', [address, 'latest']);
  return typeof code === 'string' && code !== '0x' && code.length > 2;
}

/** Has this address ever done anything on Base? A fresh address is not wrong — it is worth noticing. */
export async function activity(env, address) {
  const [nonce, balance] = await Promise.all([
    rpc(env, 'eth_getTransactionCount', [address, 'latest']),
    rpc(env, 'eth_getBalance', [address, 'latest']),
  ]);
  return { nonce: Number(BigInt(nonce)), ethWei: BigInt(balance).toString(), seen: Number(BigInt(nonce)) > 0 || BigInt(balance) > 0n };
}

/** USDC balance of any address, via a plain `balanceOf` call. */
export async function usdcBalance(env, address) {
  const data = '0x70a08231' + address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const result = await rpc(env, 'eth_call', [{ to: USDC.address, data }, 'latest']);
  return BigInt(result || '0x0');
}

/**
 * Everything the chain can tell us about one destination, as findings in the
 * same shape preflight.mjs produces — so the desk merges them without caring
 * where they came from.
 */
export async function inspectDestination(env, rawAddress) {
  const address = normaliseAddress(rawAddress);
  const findings = [];
  if (!address) return { address: null, findings: [{ severity: 'block', code: 'bad_address', message: 'Not a valid Base address.' }] };

  const checksum = await checksumProblem(rawAddress);
  if (checksum) findings.push({ severity: 'block', code: 'bad_checksum', message: `That address is malformed — ${checksum}.` });

  try {
    if (await isContract(env, address)) {
      findings.push({
        severity: 'block',
        code: 'contract_address',
        message: 'That address is a smart contract, not a wallet. USDC sent to a contract that cannot forward it is gone for good.',
      });
    }
    const act = await activity(env, address);
    if (!act.seen) {
      findings.push({
        severity: 'hold',
        code: 'unused_address',
        message: 'This address has never transacted on Base. Worth a second look — a typo produces exactly this.',
      });
    }
  } catch (err) {
    findings.push({ severity: 'hold', code: 'chain_unreachable', message: `Could not reach Base to check this address (${err.message}).` });
  }
  return { address, findings };
}

/** Can the treasury actually cover this batch? Asked before anything is approved. */
export async function treasuryCheck(env, treasuryAddress, totalCents) {
  const address = normaliseAddress(treasuryAddress);
  if (!address) return { ok: false, reason: 'No treasury address configured.' };
  const [usdc, act] = await Promise.all([usdcBalance(env, address), activity(env, address)]);
  const need = centsToUnits(totalCents);
  return {
    ok: usdc >= need && BigInt(act.ethWei) > 0n,
    address,
    usdc_balance_usd: unitsToUsd(usdc),
    needed_usd: totalCents / 100,
    gas_eth_wei: act.ethWei,
    reason:
      usdc < need
        ? `Treasury holds $${unitsToUsd(usdc).toFixed(2)} USDC, the batch needs $${(totalCents / 100).toFixed(2)}.`
        : BigInt(act.ethWei) === 0n
          ? 'Treasury has no ETH on Base, so it cannot pay gas.'
          : null,
  };
}
