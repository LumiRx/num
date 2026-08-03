// The money story has to be complete and it has to be true.
//
// Two failures this guards against, both of which were live:
//
//   1. The wallet rendered a SEEDED array — "Welcome stars ★100, on the
//      house" — while the real ledger sat in the database unread. The one
//      screen a person opens to ask "what happened to my money?" answered
//      with fiction.
//   2. Only `checkout.session.completed` was handled, so every payment was
//      'paid' forever. A refunded Star pack meant the money went back, the
//      Stars stayed spendable, and the wallet still showed a receipt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const pay = readFileSync(join(HERE, 'pay.mjs'), 'utf8');

test('money that comes back is handled, not just money going out', () => {
  // Stripe tells us about reversals exactly once. If we do not listen, the
  // balance is wrong and nobody finds out from inside the product.
  for (const evt of ['charge.refunded', 'charge.dispute.created', 'payment_intent.payment_failed']) {
    assert.ok(pay.includes(evt), `webhook ignores ${evt} — a reversal would leave Stars credited`);
  }
});

test('a refunded Star pack takes the Stars back', () => {
  const block = pay.slice(pay.indexOf('charge.refunded'));
  assert.match(block, /stars\s*=\s*stars\s*-\s*\?2/, 'refund does not debit the balance');
  assert.match(block, /'refund'/, 'refund is not written to the ledger');
});

test('a refunded membership stops being a membership', () => {
  const block = pay.slice(pay.indexOf('charge.refunded'));
  assert.match(block, /num_memberships SET tier='free'/, 'a refunded tier stays granted');
});

test('reversals are idempotent — Stripe delivers at least once', () => {
  const block = pay.slice(pay.indexOf('charge.refunded'), pay.indexOf('payment_intent.payment_failed'));
  assert.match(block, /state<>\?2/, 'a repeated refund event would debit the Stars twice');
});

test('the app never carries its own copy of a price', () => {
  // Two sources of truth for a price is the $1-for-★5,000 hole in a different
  // shirt: the client's copy is the one an attacker controls. The server
  // prices every pack; the app displays what it is told.
  const offenders = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) { walk(p); continue; }
      if (!/\.tsx?$/.test(p)) continue;
      const src = readFileSync(p, 'utf8');
      // A hardcoded cents figure sitting next to a Star count is a price list.
      for (const line of src.split('\n')) {
        if (/cents:\s*\d{4,}/.test(line) && !/\/\//.test(line.trim().slice(0, 2))) {
          offenders.push(`${p.replace(SRC, 'src')}: ${line.trim().slice(0, 70)}`);
        }
      }
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [], `these hardcode a price the server should own:\n  ${offenders.join('\n  ')}`);
});

test('the wallet reads the server ledger, not a seeded array', () => {
  const wallet = readFileSync(join(SRC, 'components', 'app', 'WalletSheet.tsx'), 'utf8');
  assert.ok(wallet.includes('refreshActivity'), 'wallet never asks the server what happened');
  assert.ok(!/\btxns\.map\b/.test(wallet), 'wallet is still rendering the seeded demo transactions');
});

test('every activity row is labelled by the server', () => {
  // If the client had to know that kind 'tab' means a shared bill, two
  // clients would drift and one of them would be wrong about money.
  const feed = pay.slice(pay.indexOf("path === '/activity'"));
  for (const kind of ['purchase', 'refund', 'errand', 'tab', 'cashout']) {
    assert.ok(feed.includes(`${kind}:`), `activity feed has no label for '${kind}'`);
  }
});
