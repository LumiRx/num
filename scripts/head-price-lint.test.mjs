/**
 * Proves the head-price lint catches the exact card that scared a venue off,
 * and does not fire on the copy that replaced it.
 *
 * A lint nobody has tried to break is a lint that passes because it finds
 * nothing, not because there is nothing to find. Every case below is a real
 * string that was live on itsnum.com on the morning of 13 Sep 2026.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { offences, run, PRICE } from './head-price-lint.mjs';

const head = (fields) => `<!doctype html><html><head>${fields}</head><body>
  <p>10% of a restaurant bill, 15% on a room, 20% on an activity. $2 flat.</p>
  </body></html>`;

test('catches the title that was in the screenshot', () => {
  const o = offences(head('<title>NUM for Business — free listing, more bookings, 10% commission</title>'));
  assert.equal(o.length, 1);
  assert.equal(o[0].field, '<title>');
  assert.equal(o[0].figure, '10%');
});

test('catches it in og:title, twitter:title and both descriptions', () => {
  for (const f of [
    '<meta property="og:title" content="free listing, 10% commission">',
    '<meta name="twitter:title" content="free listing, 10% commission">',
    '<meta property="og:description" content="Pay 10% when a booking completes.">',
    '<meta name="twitter:description" content="Pay 10% when a booking completes.">',
    '<meta name="description" content="Pay 10% when a booking completes.">',
  ]) {
    assert.equal(offences(head(f)).length, 1, f);
  }
});

test('catches every currency the rate card uses, not just dollars', () => {
  for (const s of ['$2 flat', '£1.50 flat', '€2 flat', '฿70 flat', '20 USD', '9.99 USD']) {
    assert.match(s, PRICE, s);
  }
});

test('catches $0, because "free" is the word that belongs there', () => {
  const o = offences(head('<title>NUM Pricing — $0 to List</title>'));
  assert.equal(o.length, 1);
});

test('does not fire on the copy that replaced it', () => {
  const ok = head(`<title>NUM for Business — free listing, more bookings, pay only on results</title>
    <meta name="description" content="Free business listing for restaurants, hotels and tours — no setup fee, no monthly fee, no paid placement. You pay only when a booking NUM sent you completes, and nothing at all when it does not.">
    <meta property="og:title" content="NUM pricing — free to list, paid only when we send you a guest">`);
  assert.deepEqual(offences(ok), []);
});

test('ignores the page body, where the rate card belongs', () => {
  // The body of every fixture above carries 10%, 15%, 20% and $2.
  assert.deepEqual(offences(head('<title>Clean</title>')), []);
});

test('ignores a figure that is not a price — a date, a count, a version', () => {
  const o = offences(head(`<title>104 destinations in 38 countries</title>
    <meta name="description" content="Updated 13 Sep 2026. Version 1.0.5. Open 24 hours.">`));
  assert.deepEqual(o, []);
});

test('walks a directory and reports the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'headprice-'));
  mkdirSync(join(dir, 'business'));
  writeFileSync(join(dir, 'business', 'index.html'),
    head('<title>free listing, 10% commission</title>'));
  writeFileSync(join(dir, 'index.html'), head('<title>Clean</title>'));
  const bad = run(dir);
  assert.equal(bad.length, 1);
  assert.match(bad[0].file, /business/);
});

test('skips _backup and _to_delete trees, which are records not surfaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'headprice-'));
  mkdirSync(join(dir, '_to_delete'));
  writeFileSync(join(dir, '_to_delete', 'index.html'),
    head('<title>free listing, 10% commission</title>'));
  assert.deepEqual(run(dir), []);
});
