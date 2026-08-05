// A reward that can never be granted is not a reward, it is a promise.
//
// `/ref/signup` wrote conversions as `verified=0, reward_status='pending'`
// under a comment saying rewards are granted on verified conversions. Nothing
// granted them. `reward_status` existed in exactly two places in the whole
// codebase — that comment and the INSERT — with no UPDATE anywhere, so five
// real referrals sat pending and would have stayed pending even after SMS
// verification began working. The people who advocated for Num got nothing,
// and the flywheel never turned once.
//
// These tests pin the earning half. The crediting half deliberately lives with
// the payout desk, and the last test here holds that line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EARN_TRIGGERS } from './referral.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const referral = readFileSync(join(HERE, 'referral.mjs'), 'utf8');

/**
 * Source with comments removed.
 *
 * A test that greps raw source cannot tell "this code writes the ledger" from
 * "this comment explains why it must not". The first version of the boundary
 * test below failed on its own explanatory prose, which would have pushed the
 * fix toward wording the comment around the test — exactly backwards. Strip
 * the prose and assert against what actually executes.
 */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const referralCode = code(referral);
const social = readFileSync(join(HERE, 'social.mjs'), 'utf8');
const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');

/** Just the UPDATE statement, so a decoy elsewhere in the file cannot satisfy it. */
const updateStmt = referralCode.slice(
  referralCode.indexOf('UPDATE num_referral_conversions'),
  referralCode.indexOf('.bind(memberId, trigger)'),
);

test('something, somewhere, actually marks a referral earned', () => {
  // The original bug, stated plainly.
  //
  // Scoped to the UPDATE on purpose. Asserting `/reward_status = 'earned'/`
  // against the whole file passes even when the UPDATE is changed back to
  // 'pending', because the read query further down also contains that string.
  // A guard satisfied by a decoy is not a guard — this is the same mistake as
  // matching with `.some()` across a collection.
  assert.ok(updateStmt.length > 0,
    'no code path moves a conversion off pending — rewards can be recorded but never granted');
  assert.match(updateStmt, /reward_status = 'earned'/,
    "the update does not set reward_status to 'earned', so conversions stay pending forever");
  assert.match(updateStmt, /verified = 1/, 'the update never marks the conversion verified');
});

test('earning does not depend solely on SMS', () => {
  // Gating only on phone_verified is precisely what stranded these five, and
  // A2P approval is outside our control.
  assert.ok(EARN_TRIGGERS.includes('first_ask'),
    'the only trigger depends on SMS verification — an approval we do not control can freeze the growth loop again');
  assert.ok(EARN_TRIGGERS.includes('phone_verified'),
    'verification no longer earns, so the loop gets weaker rather than stronger when A2P finally clears');
});

test('both triggers are actually wired to real events', () => {
  // A trigger listed but never called is the same failure in a new costume.
  assert.match(social, /markReferralEarned\(env, row\.id, 'phone_verified'\)/,
    'verification does not mark the referral earned');
  assert.match(index, /markReferralEarned\(env, parsed\.state\.me\.id, 'first_ask'\)/,
    'asking the concierge does not mark the referral earned');
});

test('marking is idempotent, so the hot path can call it every time', () => {
  // Without the guard, every message would re-stamp earned_at and a
  // "you earned a reward" notification would fire on each one.
  assert.match(referral, /COALESCE\(verified, 0\) = 0/,
    'the update has no already-earned guard — repeated calls would re-stamp the row on every request');
});

test('referral bookkeeping can never break the thing the person was doing', () => {
  // Verifying a phone and asking a question both matter more than a reward
  // ledger. A throw here would fail a verification for a marketing feature.
  assert.match(referral, /catch \(err\)/, 'markReferralEarned can throw into its callers');
  assert.match(social, /markReferralEarned\([^)]*\)\.catch\(/,
    'verification awaits or fails on referral bookkeeping');
  assert.match(index, /ctx\.waitUntil\(markReferralEarned/,
    'the concierge path blocks on referral bookkeeping instead of deferring it');
});

test('the app records who is owed but never moves the money', () => {
  // wrangler.app.jsonc: the payout desk owns every write to 5arz-ledger, and
  // AGENTS.md §8 makes that ledger the single truth for money. Two systems
  // writing a balance is how they start disagreeing about what someone is owed.
  assert.ok(!/stars_ledger/.test(referralCode),
    'the app writes the money ledger directly — that belongs to the payout desk');
  assert.ok(!/stars_earned/.test(referralCode),
    'the app moves a member balance directly — that belongs to the payout desk');
  assert.match(referral, /earnedAwaitingPayout/,
    'nothing exposes who is owed, so the desk has no way to pay anyone');
});

test('money is never silently rounded', () => {
  // reward_cs is cents; a Star is 100 cents. A reward that is not a whole
  // number of Stars must surface, not quietly become one.
  //
  // Scoped to the line that computes the figure. Checking the whole file lets
  // the guard be satisfied by the explanatory `note` below it while the actual
  // conversion silently rounds — money would be wrong and the test still green.
  const starsLine = referralCode.match(/stars:.*$/m)?.[0] ?? '';
  assert.match(starsLine, /reward_cs % 100 === 0/,
    'cents are converted to Stars without checking the division is exact');
  assert.ok(!/Math\.round|Math\.floor|Math\.ceil|toFixed/.test(starsLine),
    'the Stars figure is rounded — a reward that is not a whole number of Stars must surface, never be quietly adjusted');
  assert.match(referral, /do not round/i,
    'a non-whole reward has no instruction attached, so someone will round it');
});
