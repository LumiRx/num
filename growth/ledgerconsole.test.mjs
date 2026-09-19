/**
 * The ledger where a venue actually reads it.
 *
 * ── WHY THESE ARE SOURCE ASSERTIONS ──────────────────────────────────────
 *
 * Same reason as billconsole.test.mjs: reaching this page needs a staff
 * session, a cookie and a role, and standing that up covers the plumbing
 * rather than the thing that breaks, which is wiring. `payLanding` never
 * selected `resource_id` and the whole till-bill path was dead with every
 * unit test green — caught only by rendering the page. A tile computed and
 * never rendered fails exactly that way.
 *
 * The ledger's own arithmetic is covered against a real database in
 * worker/ledger.test.mjs, and every query in it was run against production
 * D1 on 19 Sep 2026 to prove each column exists. What is left to guard is
 * that a venue can see the result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

test('the ledger module is imported, not reimplemented in the console', () => {
  assert.match(src, /import \* as LEDGER from '\.\.\/worker\/ledger\.mjs';/,
    'a second copy of the money in a second file is a second thing that can be wrong');
});

test('the tile is computed AND rendered', () => {
  assert.match(src, /ledgerTile = `/, 'nothing builds the tile');
  assert.match(src, /\$\{railsTile\}\n\$\{moneyTile\}\n\$\{ledgerTile\}/,
    'the tile is built and never placed on the page — the payLanding failure exactly');
});

test('it asks for the business ledger, not the member one', () => {
  const block = src.match(/let ledgerTile = "";[\s\S]*?\n  \}\n/)[0];
  assert.match(block, /LEDGER\.ACTOR\.BUSINESS/);
  assert.match(block, /id: biz\.id/);
});

test('a failure to read the ledger hides the tile rather than the page', () => {
  const block = src.match(/let ledgerTile = "";[\s\S]*?\n  \}\n/)[0];
  assert.match(block, /catch \(e\) \{[\s\S]*?ledgerTile = "";/,
    'a venue must still be able to reach their rails and their till');
});

/* ── the double charge ───────────────────────────────────────────────────
 * While growth/money.mjs:invoiceVenue bills every accrued commission line
 * regardless of what Stripe already took at source, a bill can carry both
 * charges. The venue is the party who loses by it, so the venue is shown it
 * in their own console rather than finding it on a statement. */

test('a venue charged twice is told so, above everything else', () => {
  const block = src.match(/let ledgerTile = "";[\s\S]*?\n  \}\n/)[0];
  assert.match(block, /L\.charged_twice/, 'the list is read');
  assert.match(block, /charged our fee twice/);
  assert.match(block, /\$\{warn\}\n<div class="tile noprint" id="ledger">/,
    'the warning must sit above the ledger, not inside it where it scrolls away');
});

test('the warning tells them what to do and that they owe it once', () => {
  const block = src.match(/let ledgerTile = "";[\s\S]*?\n  \}\n/)[0];
  assert.match(block, /You owe it once/);
  assert.match(block, /quoting the bill code/,
    'a venue told they were overcharged and not how to fix it is worse off than one who was not told');
});

test('the warning disappears when there is nothing to warn about', () => {
  const block = src.match(/let ledgerTile = "";[\s\S]*?\n  \}\n/)[0];
  assert.match(block, /\(L\.charged_twice \|\| \[\]\)\.length\s*\n?\s*\?/,
    'an empty box that says nothing is wrong trains people to ignore the box');
});

/* ── what the tile may not claim ─────────────────────────────────────── */

test('unsettled lines say so on the row rather than counting silently', () => {
  const block = src.match(/let ledgerTile = "";[\s\S]*?\n  \}\n/)[0];
  assert.match(block, /e\.state === "settled" \? "" :/,
    'a payout in transit rendered like a paid one is a venue planning around money that has not arrived');
});

test('the tile says out loud that currencies are not added together', () => {
  const block = src.match(/let ledgerTile = "";[\s\S]*?\n  \}\n/)[0];
  assert.match(block, /added across currencies/,
    'a venue taking dollars and baht must be told the figures are separate, not left to assume');
});

test('an empty ledger says what will appear, not nothing', () => {
  const block = src.match(/let ledgerTile = "";[\s\S]*?\n  \}\n/)[0];
  assert.match(block, /Nothing yet\. Every bill, fee and payout appears here/,
    'a blank tile reads as broken to a venue who has just connected');
});
