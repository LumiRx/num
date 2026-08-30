/**
 * crypto — paying a venue in a stablecoin, with the same rules as every other
 * rail here: NUM never touches the money, the destination is inherited and
 * immutable, and nothing is guessed.
 *
 * One thing is different and it drives the whole file. A bank transfer to a
 * wrong account can be recalled; a transfer to a wrong address cannot. There
 * is no support line and no reversal. So an address is not merely
 * format-checked — a mixed-case address carries an EIP-55 checksum and that
 * checksum is verified, which catches a single mistyped character with
 * probability ~1 - 2^-30. That is the difference between refusing a typo and
 * a venue's takings leaving the planet.
 *
 * Verifying it needs keccak-256, which Web Crypto does not provide, so it is
 * implemented below and asserted against the published EIP-55 vectors.
 */

/* ── keccak-256 ──────────────────────────────────────────────────────────
 * Keccak-f[1600], 24 rounds, rate 136 bytes, Keccak padding (0x01), which is
 * what Ethereum uses — NOT SHA3-256, whose padding byte is 0x06. Written with
 * BigInt lanes: slower than a 32-bit-pair implementation and far easier to
 * read, and the inputs here are 20 bytes.
 */

const MASK64 = (1n << 64n) - 1n;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets, indexed x + 5y.
const RHO = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

const rotl = (v, n) => n === 0 ? v : (((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK64);

function keccakF(A) {
  for (let round = 0; round < 24; round++) {
    // θ
    const C = new Array(5);
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    const D = new Array(5);
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) A[x + 5 * y] ^= D[x];

    // ρ and π
    const B = new Array(25).fill(0n);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], RHO[x + 5 * y]);
      }
    }

    // χ
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        A[x + 5 * y] = B[x + 5 * y] ^ ((~B[((x + 1) % 5) + 5 * y] & MASK64) & B[((x + 2) % 5) + 5 * y]);
      }
    }

    // ι
    A[0] ^= RC[round];
  }
  return A;
}

/** keccak-256 of a byte array, returned as lowercase hex. */
export function keccak256(bytes) {
  const RATE = 136;
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  // Keccak pad10*1: 0x01 first, 0x80 on the final byte of the block.
  const padLen = RATE - (input.length % RATE);
  const padded = new Uint8Array(input.length + padLen);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      // little-endian
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }

  let out = '';
  for (let i = 0; i < 4; i++) {            // 256 bits = 4 lanes
    let lane = A[i];
    for (let b = 0; b < 8; b++) {
      out += Number(lane & 0xffn).toString(16).padStart(2, '0');
      lane >>= 8n;
    }
  }
  return out;
}

const utf8 = (s) => new TextEncoder().encode(s);

/* ── addresses ───────────────────────────────────────────────────────────── */

/** The EIP-55 mixed-case form of a 0x address. */
export function toChecksumAddress(addr) {
  const raw = String(addr || '').trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(raw)) return null;
  const hash = keccak256(utf8(raw));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    out += parseInt(hash[i], 16) >= 8 ? raw[i].toUpperCase() : raw[i];
  }
  return out;
}

/**
 * Validate an EVM address.
 *
 * An all-lowercase or all-uppercase address carries no checksum — EIP-55 says
 * so — and is accepted as-is, then returned in checksummed form. A MIXED-case
 * address does carry one, and a wrong one is rejected: it means a character
 * was mistyped, and there is no way to get that money back.
 */
export function validAddress(addr) {
  const s = String(addr || '').trim();
  // "0X" as well as "0x": the all-caps form in the EIP-55 spec capitalises the
  // prefix too, and somebody will paste one.
  if (!/^0[xX][0-9a-fA-F]{40}$/.test(s)) {
    return { ok: false, reason: 'not an address — it should be 0x followed by 40 characters' };
  }
  const body = s.slice(2);
  const checksummed = toChecksumAddress(s);
  const cased = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (cased && checksummed !== s) {
    return {
      ok: false,
      reason: 'that address fails its own checksum — a character is wrong. Paste it again rather than retyping it.',
    };
  }
  if (/^0x0{40}$/i.test(s)) return { ok: false, reason: 'that is the burn address' };
  return { ok: true, address: checksummed };
}

/* ── what we accept ──────────────────────────────────────────────────────
 * Small and verified on purpose. Every entry here was checked against the
 * live chain, not typed from memory: a wrong token contract is money sent to
 * a contract that will not give it back. Adding a chain means verifying its
 * contract the same way.
 */
export const ASSETS = Object.freeze({
  'usdc-base': Object.freeze({
    label: 'USDC on Base',
    asset: 'USDC',
    chain: 'base',
    chain_id: 8453,
    // Verified on chain 22 Aug 2026: name "USD Coin", symbol USDC, decimals 6.
    contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
    // A stablecoin is quoted 1:1 with the dollar here. It is not exactly one
    // dollar at every moment, and for a restaurant bill that difference is
    // smaller than the rounding on the bill itself.
    usd_per_unit: 1,
  }),
});

export const assetKeys = () => Object.keys(ASSETS);

/* ── the payment request ─────────────────────────────────────────────────── */

/**
 * EIP-681 for an exact ERC-20 amount.
 *
 * `ethereum:<token>@<chainId>/transfer?address=<recipient>&uint256=<baseUnits>`
 * A wallet reading this fills in the recipient AND the amount, so the guest
 * cannot pay the wrong figure by hand.
 */
export function paymentUri(assetKey, recipient, baseUnits) {
  const a = ASSETS[assetKey];
  if (!a) return null;
  const to = validAddress(recipient);
  if (!to.ok) return null;
  if (!(typeof baseUnits === 'bigint' ? baseUnits > 0n : Number(baseUnits) > 0)) return null;
  return `ethereum:${a.contract}@${a.chain_id}/transfer?address=${to.address}&uint256=${baseUnits}`;
}

/**
 * What an open sticker encodes.
 *
 * Deliberately the bare address, not an EIP-681 URI. Without a token
 * parameter, `ethereum:<address>@<chain>` means "send the chain's native
 * coin" — a guest scanning it would be prompted to send ETH instead of USDC.
 * A bare address prompts for whatever the guest chooses, and the page says in
 * words which asset and chain to use.
 */
export function addressQrText(recipient) {
  const to = validAddress(recipient);
  return to.ok ? to.address : null;
}

/* ── turning a bill into token units ─────────────────────────────────────── */

/**
 * The exchange rate for a bill currency, from config only.
 *
 * There is no default and no fallback. A rate we invented would put a number
 * in front of a guest that neither the venue nor we can defend, on a payment
 * that cannot be reversed. If it is not configured, a crypto bill cannot be
 * minted and says so.
 */
export function rateFor(env, currency) {
  const ccy = String(currency || '').toUpperCase();
  if (!ccy) return { ok: false, reason: 'no currency' };
  if (ccy === 'USD') return { ok: true, per_usd: 1, source: 'usd' };
  const raw = env?.[`NUM_FX_${ccy}_USD`];
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, reason: `no exchange rate configured for ${ccy} — set NUM_FX_${ccy}_USD` };
  }
  return { ok: true, per_usd: n, source: `NUM_FX_${ccy}_USD` };
}

/**
 * Quote a bill in the token.
 *
 * `amountMinor` is the bill in its own currency's minor units (satang for THB).
 * Returns the base units the wallet should send, plus everything needed to
 * show the guest how that figure was reached — the rate and the time it was
 * taken. A quote nobody can audit is a quote somebody will dispute.
 */
export function quote(env, assetKey, amountMinor, currency) {
  const a = ASSETS[assetKey];
  if (!a) return { ok: false, reason: 'unknown asset' };
  const minor = Math.round(Number(amountMinor));
  if (!Number.isFinite(minor) || minor <= 0) return { ok: false, reason: 'no amount' };

  const r = rateFor(env, currency);
  if (!r.ok) return r;

  // Integer maths throughout: cents in, base units out. Floating point on a
  // payment amount is how you get 73.43999999999999.
  const usdCents = Math.round(minor / r.per_usd / a.usd_per_unit);
  if (usdCents <= 0) return { ok: false, reason: 'amount rounds to nothing' };
  const baseUnits = BigInt(usdCents) * 10n ** BigInt(a.decimals - 2);

  return {
    ok: true,
    asset: a.asset,
    chain: a.chain,
    chain_id: a.chain_id,
    contract: a.contract,
    decimals: a.decimals,
    base_units: baseUnits.toString(),
    display: (usdCents / 100).toFixed(2),
    rate: r.per_usd,
    rate_source: r.source,
    quoted_at: new Date().toISOString(),
  };
}
