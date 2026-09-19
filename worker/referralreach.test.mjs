// Can the money actually reach anybody?
//
// THREE TIMES NOW this codebase has shipped a complete, tested payout
// programme with no caller: `recordRevenue` (Num Experts), `creditBizReferral`
// (business referrals), and — found 19 Sep 2026, the day the ambassador
// programme launched on top of it — `creditMemberReferral`.
//
// A unit test on the payout function passes in all three cases. That is the
// whole problem: the function was never wrong. These tests ask a different
// question, the one nobody was asking — is it REACHABLE, and does the thing
// that calls it pass it what it needs?
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(HERE, '..', f), 'utf8');

/** Every .mjs/.js under worker/ and growth/ that is not a test. */
function sources() {
  const out = [];
  for (const dir of ['worker', 'growth']) {
    for (const n of readdirSync(join(HERE, '..', dir))) {
      if (!/\.(mjs|js)$/.test(n) || n.includes('.test.')) continue;
      out.push([`${dir}/${n}`, read(`${dir}/${n}`)]);
    }
  }
  return out;
}

/** Files that call NAME as a function, ignoring its own definition. */
function callersOf(name) {
  return sources()
    .filter(([f, s]) => !s.includes(`export async function ${name}`)
      && !s.includes(`export function ${name}`))
    .filter(([, s]) => new RegExp(`\\b${name}\\s*\\(`).test(s))
    .map(([f]) => f);
}

test('creditMemberReferral is reachable — it had NO callers until 19 Sep 2026', () => {
  const callers = callersOf('creditMemberReferral');
  assert.ok(callers.length > 0,
    'nothing calls creditMemberReferral, so no member referral can ever be paid — '
    + 'this is the exact failure that hid behind passing tests three times');
});

test('the caller is where money ARRIVED, not where it was owed', () => {
  // A share paid at accrual is a share paid out of an invoice the venue has
  // not settled. markPaid is the only place a receipt is recorded.
  assert.match(markPaidBody(), /creditMemberReferral\(env/,
    'markPaid no longer credits the member referral');
});

/** The body of markPaid, so a match cannot come from a comment elsewhere in
 *  the file or from a different function that happens to look similar. */
function markPaidBody() {
  const src = read('worker/commission.mjs');
  const i = src.indexOf('export async function markPaid');
  assert.ok(i > 0, 'markPaid is gone — find where receipts are recorded now');
  const end = src.indexOf('\n}', src.indexOf('return { booking_id', i));
  return src.slice(i, end);
}

test('the caller actually reads member_id, or the hook can never fire', () => {
  // The hook reads `before.member_id`. The SELECT above it originally asked
  // for three columns and member_id was not one of them, which would have
  // made the whole thing dead code that looked live.
  const sel = markPaidBody().match(/SELECT ([^']*?) FROM num_commissions WHERE booking_id/);
  assert.ok(sel, 'the markPaid lookup changed shape');
  assert.match(sel[1], /member_id/,
    'markPaid does not select member_id, so the referral hook reads undefined and never runs');
});

test('it credits whole Stars out of what arrived, never a rounded-up payout', () => {
  const body = markPaidBody();
  assert.match(body, /const stars = Math\.floor\(delta \/ 100\)/,
    'the Star conversion is not flooring the INCREASE');
  assert.match(body, /if \(delta > 0 && before\?\.member_id\)/,
    'it must credit the increase and only when the booking knows whose it was');
});

test('a retried reconciliation cannot pay twice', () => {
  // markPaid replaces rather than adds, and is run twice by an operator
  // reconciling a remittance. Both hooks key on the same ref.
  const body = markPaidBody();
  const i = body.indexOf('creditMemberReferral(env');
  assert.ok(i > 0, 'the call site moved');
  assert.match(body.slice(i, i + 400), /ref: `comm:\$\{bookingId\}:\$\{Math\.round\(paidCents\)\}`/);
  // And the payout function itself refuses a ref it has already paid.
  assert.match(read('worker/memberreferral.mjs'), /const moveId = `memref:\$\{ref\}`/);
  assert.match(read('worker/memberreferral.mjs'), /if \(already\) return \{ credited: 0, duplicate: true \}/);
});

test('the other two programmes that were once unreachable still have callers', () => {
  // Regression cover for the same class of bug, so a refactor that strips a
  // call site fails here rather than in somebody's bank account.
  assert.ok(callersOf('businessEarned').length > 0, 'businessEarned lost its callers');
  assert.ok(callersOf('creditBizReferral').length > 0, 'creditBizReferral lost its callers');
});

test('linkReferral is reachable from signup, or nobody is ever attributed', () => {
  const callers = callersOf('linkReferral');
  assert.ok(callers.includes('worker/social.mjs'),
    'signup no longer links the referral — attribution stops and every code is decorative');
});
