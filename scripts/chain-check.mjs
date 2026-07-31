// Verify the on-chain checks against the real Base network, read-only.
import { keccak256, checksumProblem, inspectDestination, usdcBalance, unitsToUsd, centsToUnits, USDC } from '../payouts/chain.mjs';
import { readFileSync } from 'node:fs';

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// keccak-256 against the two best-known vectors.
const empty = hex(await keccak256(new Uint8Array()));
const abc = hex(await keccak256(new TextEncoder().encode('abc')));
console.log('keccak("")   ', empty, empty === 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470' ? 'OK' : 'WRONG');
console.log('keccak("abc")', abc, abc === '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45' ? 'OK' : 'WRONG');

// EIP-55: a known-good checksummed address, and the same with one char flipped.
const good = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const bad = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD';
console.log('\nchecksum good →', await checksumProblem(good) ?? 'accepted');
console.log('checksum bad  →', await checksumProblem(bad) ?? 'accepted (WRONG)');

// Amount maths — USDC has 6 decimals, not 18.
console.log('\n$1.00 →', centsToUnits(100).toString(), 'units (want 1000000)');
console.log('$110.00 →', centsToUnits(11000).toString(), 'units (want 110000000)');

// The live chain: every wallet on file.
const methods = JSON.parse(readFileSync('/tmp/pf/methods.json', 'utf8'));
console.log('\n── every payout destination, checked against Base');
for (const m of methods) {
  const out = await inspectDestination({}, m.external_id);
  const worst = out.findings.some((f) => f.severity === 'block') ? 'BLOCK' : out.findings.some((f) => f.severity === 'hold') ? 'hold ' : 'ok   ';
  console.log(`  ${worst} ${m.member_id.padEnd(20)} ${out.address}`);
  out.findings.forEach((f) => console.log(`         ${f.code}: ${f.message}`));
}

const treasuryDemo = await usdcBalance({}, USDC.address);
console.log(`\nsanity: the USDC contract itself holds $${unitsToUsd(treasuryDemo).toFixed(2)} of its own token (a real RPC round trip worked)`);
