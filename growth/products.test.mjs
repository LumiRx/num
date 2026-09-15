// PRODUCTS & INVENTORY — a venue's own menu.
//
// The properties here are the ones that cost a venue real money when they are
// wrong: a price stored against the wrong currency, a stock edit that only the
// owner can make (so it never gets made, and the menu lies), and "not counted"
// silently becoming "zero" and taking an item off the menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const worker = readFileSync(join(HERE, 'worker.js'), 'utf8');
const sql = readFileSync(join(HERE, '..', 'worker', 'migrations', '0029_products.sql'), 'utf8');
const wrangler = readFileSync(join(HERE, 'wrangler.jsonc'), 'utf8');

const fn = (name) => {
  const i = worker.indexOf(`async function ${name}(`);
  if (i < 0) return '';
  let d = 0, started = false, j = i;
  for (; j < worker.length; j++) {
    if (worker[j] === '{') { d++; started = true; }
    else if (worker[j] === '}') { d--; if (started && d === 0) break; }
  }
  return worker.slice(i, j + 1);
};

test('the page and its form are routed, and /biz* already carries them', () => {
  assert.match(worker, /p === "\/biz\/products"/, 'the products page is not routed');
  assert.match(worker, /p === "\/api\/venue\/products" && req\.method === "POST"/, 'the save endpoint is not routed');
  assert.match(wrangler, /"itsnum\.com\/biz\*"/, '/biz/products would 404 at the zone');
  assert.match(wrangler, /"itsnum\.com\/api\/venue\/\*"/, 'the form would post into the asset worker');
});

test('it is in the nav, so it is reachable without knowing the URL', () => {
  const nav = worker.slice(worker.indexOf('const BIZ_NAV = '), worker.indexOf('function qrNav'));
  assert.match(nav, /slug: 'products'/, 'a page the nav does not list is a page nobody finds');
});

test('a price is stored in the currency it was typed in', () => {
  assert.match(sql, /currency\s+TEXT NOT NULL/, 'the row carries no currency');
  assert.match(fn('venueProductSave'), /money\.code/,
    'the price is stored without resolving the venue currency');
  // Reading back must use the ROW's currency, not the venue's current one.
  assert.match(fn('venueProductsPage'), /r\.currency \|\| money\.code/,
    'a venue correcting its country would silently reprice its whole menu');
});

test('empty stock means not counted, and never zero', () => {
  const save = fn('venueProductSave');
  assert.match(save, /stockRaw === '' \? null/, 'an empty stock box becomes a number');
  assert.match(sql, /stock\s+INTEGER,/, 'stock is not nullable, so "not counted" cannot be expressed');
  assert.match(fn('venueProductsPage'), /r\.stock === null/,
    'the page cannot tell "not counted" from "none left"');
});

test('the floor can fix stock without being the owner', () => {
  const save = fn('venueProductSave');
  assert.match(save, /const floorOnly = act === 'stock' \|\| act === 'toggle'/,
    'every edit needs owner rights, so stock never gets updated and the menu lies');
  assert.match(save, /!floorOnly && !QR\.can\(who\.role, 'settings'\)/,
    'price and name edits are no longer owner-only');
});

test('every write is scoped to the venue that asked', () => {
  const save = fn('venueProductSave');
  const updates = save.match(/UPDATE num_products[\s\S]*?WHERE[^`']*/g) || [];
  assert.ok(updates.length >= 4, `expected several updates, found ${updates.length}`);
  for (const u of updates) {
    assert.match(u, /business_id = \?2/,
      'an id alone identifies the row — one venue could edit another venue\'s menu');
  }
});

test('archiving hides, it never deletes', () => {
  const save = fn('venueProductSave');
  assert.ok(!/DELETE FROM num_products/.test(save),
    'a product on an old bill was deleted, taking the explanation for that figure with it');
  assert.match(save, /archived_at = \?3/);
  assert.match(save, /act === 'restore'/, 'an archive with no way back is a delete with extra steps');
});

test('a failed read is never shown as an empty menu', () => {
  const page = fn('venueProductsPage');
  assert.match(page, /const broke = results === null/,
    '"we could not read it" and "you have no products" are opposite facts');
  assert.match(page, /this is not an empty menu/);
});

test('prices parse the way people actually type them', async () => {
  const m = worker.match(/function priceToMinor\(raw\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'priceToMinor is gone');
  const priceToMinor = new Function('return ' + m[0])();
  assert.equal(priceToMinor('12.50'), 1250);
  assert.equal(priceToMinor('12,50'), 1250, 'a comma decimal is most of the world');
  assert.equal(priceToMinor('$12'), 1200, 'a typed currency symbol is not a syntax error');
  assert.equal(priceToMinor('12'), 1200);
  assert.equal(priceToMinor(''), null, 'empty is not free');
  assert.equal(priceToMinor('abc'), null);
  assert.equal(priceToMinor('-5'), null, 'a negative price is not a discount');
});
