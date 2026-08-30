/**
 * crypto — the checksum is the safety rail, so it is tested against the
 * published vectors rather than against itself. If keccak256 here is wrong,
 * every address check silently becomes a format check and a typo reaches a
 * printed QR.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  keccak256, toChecksumAddress, validAddress, ASSETS,
  paymentUri, addressQrText, rateFor, quote,
} from './crypto.mjs';

const utf8 = (s) => new TextEncoder().encode(s);

/* ── keccak-256, against the known answers ───────────────────────────────── */

test('keccak256 matches the published vectors', () => {
  // The canonical empty-input digest for Keccak-256 (not SHA3-256).
  assert.equal(keccak256(new Uint8Array(0)),
    'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256(utf8('abc')),
    '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(keccak256(utf8('testing')),
    '5f16f4c7f149ac4f9510d9cf8cf384038ad348b3bcdc01915f95de12df9d1b02');
});

test('keccak256 is not SHA3-256 — the padding differs', () => {
  const sha3 = createHash('sha3-256').update('').digest('hex');
  assert.notEqual(keccak256(new Uint8Array(0)), sha3,
    'if these ever match, the padding byte is wrong and every checksum is meaningless');
});

test('keccak256 handles an input longer than one 136-byte block', () => {
  // Exercises the absorb loop. 200 bytes of 0x61.
  const long = new Uint8Array(200).fill(0x61);
  const h = keccak256(long);
  assert.match(h, /^[0-9a-f]{64}$/);
  // A different length must give a different digest — catches a padding bug
  // that silently ignores the tail.
  assert.notEqual(h, keccak256(new Uint8Array(199).fill(0x61)));
});

test('a one-character change changes the digest', () => {
  assert.notEqual(keccak256(utf8('testing')), keccak256(utf8('Testing')));
});

/* ── EIP-55, against the spec's own examples ─────────────────────────────── */

test('toChecksumAddress reproduces the EIP-55 examples', () => {
  for (const a of [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ]) {
    assert.equal(toChecksumAddress(a.toLowerCase()), a);
  }
});

test('the USDC contract we ship round-trips its own checksum', () => {
  const c = ASSETS['usdc-base'].contract;
  assert.equal(toChecksumAddress(c), c,
    'a mis-typed token contract is money sent to something that will not return it');
});

/* ── validating what a venue types ───────────────────────────────────────── */

test('a mixed-case address with a wrong character is refused', () => {
  const good = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  assert.equal(validAddress(good).ok, true);

  // one character changed, checksum now wrong
  const bad = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD';
  const out = validAddress(bad);
  assert.equal(out.ok, false);
  assert.match(out.reason, /checksum/);
});

test('an all-lowercase address is accepted and returned checksummed', () => {
  const out = validAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed');
  assert.equal(out.ok, true);
  assert.equal(out.address, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    'EIP-55 says a single-case address carries no checksum, so it cannot be wrong');
});

test('an all-uppercase address is accepted too', () => {
  const out = validAddress('0X5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED');
  assert.equal(out.ok, true);
});

test('rubbish is refused with something a person can act on', () => {
  for (const bad of ['', 'not an address', '0x123', '5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAedZZ']) {
    const out = validAddress(bad);
    assert.equal(out.ok, false, `accepted ${JSON.stringify(bad)}`);
    assert.ok(out.reason.length > 10);
  }
});

test('the burn address is refused', () => {
  assert.equal(validAddress('0x0000000000000000000000000000000000000000').ok, false);
});

/* ── the payment request a wallet reads ──────────────────────────────────── */

test('a bill encodes the token, the chain, the recipient and the exact amount', () => {
  const uri = paymentUri('usdc-base', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 73440000n);
  assert.equal(uri,
    'ethereum:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453/transfer' +
    '?address=0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed&uint256=73440000');
});

test('a payment request is refused rather than built with a bad address or no amount', () => {
  assert.equal(paymentUri('usdc-base', '0xnope', 1n), null);
  assert.equal(paymentUri('usdc-base', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 0n), null);
  assert.equal(paymentUri('no-such-asset', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 1n), null);
});

test('an open sticker encodes the bare address, never a native-coin request', () => {
  const t = addressQrText('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed');
  assert.equal(t, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  assert.ok(!t.startsWith('ethereum:'),
    'ethereum:<address> with no token means send ETH — the guest would pay the wrong asset');
});

/* ── the rate, which we never invent ─────────────────────────────────────── */

test('no configured rate means no crypto bill', () => {
  const r = rateFor({}, 'THB');
  assert.equal(r.ok, false);
  assert.match(r.reason, /NUM_FX_THB_USD/);
  assert.equal(quote({}, 'usdc-base', 240000, 'THB').ok, false);
});

test('dollars need no rate', () => {
  assert.deepEqual(rateFor({}, 'USD'), { ok: true, per_usd: 1, source: 'usd' });
});

test('a baht bill converts to token base units with integer maths', () => {
  const q = quote({ NUM_FX_THB_USD: '32.68' }, 'usdc-base', 240000, 'THB');
  assert.equal(q.ok, true);
  assert.equal(q.display, '73.44', '2,400.00 THB at 32.68 is 73.44 USDC');
  assert.equal(q.base_units, '73440000', 'USDC has 6 decimals');
  assert.equal(q.rate, 32.68);
  assert.equal(q.asset, 'USDC');
  assert.equal(q.chain_id, 8453);
  assert.ok(q.quoted_at, 'the guest must be able to see when the rate was taken');
});

test('base units are exact — no floating point in the amount', () => {
  const q = quote({ NUM_FX_THB_USD: '3' }, 'usdc-base', 100, 'THB');   // 1.00 THB
  assert.equal(q.display, '0.33');
  assert.equal(q.base_units, '330000');
  assert.equal(typeof q.base_units, 'string', 'a number would lose precision on a big bill');
});

test('an amount that rounds away to nothing is refused', () => {
  const q = quote({ NUM_FX_THB_USD: '1000000' }, 'usdc-base', 1, 'THB');
  assert.equal(q.ok, false);
  assert.match(q.reason, /nothing/);
});

test('a nonsense rate is refused rather than used', () => {
  for (const bad of ['0', '-5', 'abc', '']) {
    assert.equal(rateFor({ NUM_FX_THB_USD: bad }, 'THB').ok, false, `accepted ${bad}`);
  }
});

test('the quote a guest is shown and the URI they scan carry the same figure', () => {
  const q = quote({ NUM_FX_THB_USD: '32.68' }, 'usdc-base', 240000, 'THB');
  const uri = paymentUri('usdc-base', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', BigInt(q.base_units));
  assert.ok(uri.endsWith('&uint256=' + q.base_units),
    'if these ever diverge the guest pays one number and the venue expects another');
});
