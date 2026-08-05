// The wallet boundary, enforced against the source itself.
//
// Comments get ignored and rules get forgotten. This test reads the actual
// Worker code and fails if anyone builds a path for 5arz Stars to enter Num.
// Run: node --test worker/cashout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WALLET_SEPARATION } from './cashout.mjs';
import { STAR_POLICY } from './pay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(HERE)
  .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
  .map((f) => ({ file: f, text: readFileSync(join(HERE, f), 'utf8') }));

/** Strip comments so prose about 5arz doesn't trip the source checks. */
const code = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the boundary is declared one-way', () => {
  assert.equal(WALLET_SEPARATION.outbound_num_to_5arz, true);
  assert.equal(WALLET_SEPARATION.inbound_from_5arz, false);
  assert.equal(WALLET_SEPARATION.shared_ledger, false);
});

/**
 * Every place a Num balance can GROW, by file and count.
 *
 * A line-local "does it mention 5arz" check is worthless — a real import would
 * fetch from 5arz in one function and credit in another, with the two never
 * appearing on the same line. So instead: the credit sites are enumerated, and
 * ANY new one fails this test. A future session adding an inbound path has to
 * come here and change the allowlist, which is exactly the moment someone
 * should be asking why.
 *
 *   errands.mjs — escrow release + its rollback. Stars already inside Num.
 *   social.mjs  — member→member transfer, that transfer's rollback, tab
 *                 settlement, and (added 2026-08-02 after a security audit)
 *                 the tab-settlement ROLLBACK, which re-credits the payer when
 *                 the settlement batch fails. All four move Stars BETWEEN Num
 *                 members or return them to where they came from; none mints,
 *                 none reaches outside.
 *   pay.mjs     — a Stripe-paid top-up, only after a verified signature.
 *   cashout.mjs — the rollback when filing a cash-out request fails.
 *
 * Note what is NOT here and never should be: anything sourced from 5arz.
 */
const CREDIT_SITES = { 'errands.mjs': 2, 'social.mjs': 4, 'pay.mjs': 1, 'cashout.mjs': 1, 'bizreferral.mjs': 1 };

test('the set of places a Num balance can grow is exactly the reviewed set', () => {
  const found = {};
  for (const { file, text } of sources) {
    const n = (code(text).match(/num_star_balances\s+SET\s+stars\s*=\s*stars\s*\+/gi) ?? []).length;
    if (n) found[file] = n;
  }
  assert.deepEqual(
    found,
    CREDIT_SITES,
    'A new way to credit Num Stars appeared (or one vanished). If this is an ' +
      'inbound transfer from 5arz, it must not ship — the wallets are separate ' +
      'and only outbound cash-out crosses. Otherwise update CREDIT_SITES with a reason.',
  );
});

test('nothing fetches from 5arz hosts', () => {
  // An import would have to talk to 5arz. This Worker never should.
  const offenders = sources
    .filter(({ text }) => /fetch\([^)]*5arz/i.test(code(text)) || /api\.5arz\.com/i.test(code(text)))
    .map(({ file }) => file);
  assert.deepEqual(offenders, [], `num-app must not call 5arz for balances: ${offenders.join(', ')}`);
});

test('no Worker code reads the 5arz ledger into Num', () => {
  // The 5arz economy lives in stars_ledger / member_finance / payable_stars.
  // None of those names belong in this Worker at all.
  const foreign = /\b(stars_ledger|member_finance|payable_stars)\b/;
  const offenders = sources
    .filter(({ text }) => foreign.test(code(text)))
    .map(({ file }) => file);
  assert.deepEqual(offenders, [], `5arz ledger tables must not be queried from num-app: ${offenders.join(', ')}`);
});

test('the only 5arz move is outbound, and it debits', () => {
  const cashout = code(readFileSync(join(HERE, 'cashout.mjs'), 'utf8'));
  // The one write that names 5arz is the cash-out move, and its delta is
  // negative — Stars leaving Num.
  assert.match(cashout, /num_star_moves[\s\S]*'cashout'[\s\S]*'5arz'/);
  assert.match(cashout, /stars = stars - \?2/); // debit on request
  assert.doesNotMatch(cashout, /INSERT INTO num_star_moves[^\n]*'5arz'[^\n]*\+/);
});

test('every cash-out this Worker files is stamped origin=num', () => {
  const cashout = code(readFileSync(join(HERE, 'cashout.mjs'), 'utf8'));
  // A constant, not a request field — so a caller can never file a request
  // claiming to be a 5arz-native payout and ride the Num queue's open switch.
  assert.match(cashout, /const ORIGIN = 'num'/);
  assert.match(cashout, /INSERT INTO num_cashouts[^;]*origin[^;]*ORIGIN/s);
  assert.doesNotMatch(cashout, /origin:\s*(b\.|body\.|clip\(b\.)/);
});

test('the payout desk is asked BEFORE any Star is debited', () => {
  // The ordering IS the fix. Debiting first and queueing second is what lost
  // money: the desk read a different database, never saw the request, and the
  // Stars were simply gone. A future refactor that "tidies" the debit back up
  // above the desk call must fail here.
  const src = code(readFileSync(join(HERE, 'cashout.mjs'), 'utf8'));
  const deskAt = src.indexOf('queuePayout(env');
  const debitAt = src.indexOf('stars = stars - ?2');
  assert.ok(deskAt > 0, 'cash-out must call the payout desk');
  assert.ok(debitAt > 0, 'cash-out must debit somewhere');
  assert.ok(deskAt < debitAt, 'the desk must be asked before the balance is touched');
});

test('cash-out cannot be opened without a bridge to the desk', () => {
  // CASHOUT_OK=1 alone used to be enough to promise a payout over a road that
  // didn't arrive. Both, or neither.
  const src = code(readFileSync(join(HERE, 'cashout.mjs'), 'utf8'));
  assert.match(src, /CASHOUT_OK === '1' && deskReady\(env\)/);
});

test('purchased Stars are never cashable', () => {
  assert.equal(STAR_POLICY.earned_cashable, true);
  assert.equal(STAR_POLICY.purchased_cashable, false);
  const cashout = code(readFileSync(join(HERE, 'cashout.mjs'), 'utf8'));
  // Cashability is computed from move kinds, never from the raw balance.
  assert.match(cashout, /EARNED_KINDS/);
  assert.doesNotMatch(cashout, /cashable:\s*balance\b/);
});

// ── One ledger, or none of this means anything ────────────────────────────
//
// Star purchases were written to `num_star_ledger`. Nothing reads that table:
// errands, social, cash-out, the console and the wallet history all read
// num_star_moves. So the balance was right and the history was blank — the one
// Star event a person actually paid money for was the one they couldn't see,
// and the audit trail didn't have it either.
//
// It was also the reason bought Stars couldn't be cashed out: not because we
// decided that, but because they sat in a table the cash-out audit never
// looked at. Safe by accident is a thing that stops being safe the moment
// someone "fixes" the inconsistency without knowing why it was there.
test('every Star movement is written to the one table everything reads', () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith('.mjs') && !f.includes('.test.'));
  const strays = [];
  for (const f of files) {
    const src = readFileSync(join(HERE, f), 'utf8');
    for (const line of src.split('\n')) {
      // A write to any Star table that ISN'T num_star_moves / num_star_balances.
      const m = /(?:INSERT\s+INTO|UPDATE)\s+(num_star_[a-z_]+)/i.exec(line);
      if (m && !['num_star_moves', 'num_star_balances'].includes(m[1].toLowerCase())) {
        strays.push(`${f}: writes ${m[1]}`);
      }
    }
  }
  assert.deepEqual(
    strays,
    [],
    `these write Stars somewhere the history and the cash-out audit never read:\n  ${strays.join('\n  ')}`,
  );
});
