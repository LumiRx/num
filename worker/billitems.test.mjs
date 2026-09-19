// What was on the bill. The rule under test throughout: when a bill is
// itemised, the total IS the lines — there is no second figure that can
// disagree with them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { normaliseItems, totalMinor, saveItems, itemsFor, listProducts, addProduct, archiveProduct } from './billitems.mjs';

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE num_bill_items (id TEXT PRIMARY KEY, token TEXT, pos INTEGER, name TEXT,
      qty INTEGER, unit_minor INTEGER, line_minor INTEGER, created_at TEXT);
    CREATE TABLE num_business_products (id TEXT PRIMARY KEY, business_id TEXT, name TEXT,
      price_minor INTEGER, currency TEXT, sort INTEGER DEFAULT 0, archived_at TEXT, created_at TEXT);
  `);
  const DB = {
    prepare(sql) {
      const bound = [];
      const api = {
        bind(...a) { bound.push(...a); return api; },
        async first() { return d.prepare(sql).get(...bound) ?? null; },
        async all() { return { results: d.prepare(sql).all(...bound) }; },
        async run() { const r = d.prepare(sql).run(...bound); return { meta: { changes: Number(r.changes ?? 0) } }; },
      };
      return api;
    },
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
  return { d, env: { DB } };
}

test('the total is the sum of the lines, to the penny', () => {
  const out = normaliseItems([
    { name: 'Pad Thai', qty: 2, price: '180' },
    { name: 'Singha', qty: 3, price: '90.50' },
  ]);
  assert.equal(out.ok, true);
  assert.equal(out.total_minor, 2 * 18000 + 3 * 9050);
  assert.equal(out.total, '631.50');
  assert.equal(totalMinor(out.items), out.total_minor);
});

test('a line nobody can read is refused, and the refusal says which line', () => {
  const noName = normaliseItems([{ qty: 1, price: '10' }]);
  assert.equal(noName.ok, false);
  assert.match(noName.reason, /line 1/);

  const badPrice = normaliseItems([{ name: 'Beer', qty: 1, price: '9' }, { name: 'Wine', qty: 1, price: '2,4OO' }]);
  assert.equal(badPrice.ok, false);
  assert.match(badPrice.reason, /line 2/);
  // The point of naming the row: on a bill of fourteen items, "not a plain
  // amount" on its own is a puzzle rather than a message.
  assert.match(badPrice.reason, /price/);
});

test('quantity must be a whole number of things, and more than none', () => {
  for (const qty of [0, -1, 1.5, 'two']) {
    const out = normaliseItems([{ name: 'Beer', qty, price: '9' }]);
    assert.equal(out.ok, false, `qty ${qty} should be refused`);
  }
});

test('a comped line is allowed at zero, but a bill that comes to nothing is not', () => {
  // A free dessert is a real line on a real bill. Dropping it would make the
  // printed bill disagree with what the guest ate.
  const withFreebie = normaliseItems([{ name: 'Main', qty: 1, price: '20' }, { name: 'Dessert, on us', qty: 1, price: '0' }]);
  assert.equal(withFreebie.ok, true);
  assert.equal(withFreebie.total_minor, 2000);
  assert.equal(withFreebie.items[1].line_minor, 0);

  const allFree = normaliseItems([{ name: 'Water', qty: 2, price: '0' }]);
  assert.equal(allFree.ok, false);
  assert.match(allFree.reason, /nothing/);
});

test('a negative price is never a discount', () => {
  const out = normaliseItems([{ name: 'Refund-ish', qty: 1, unit_minor: -500 }]);
  assert.equal(out.ok, false);
  assert.match(out.reason, /negative/);
});

test('minor units from a saved product are taken as given, not re-parsed', () => {
  const out = normaliseItems([{ name: 'Singha', qty: 2, unit_minor: 9050 }]);
  assert.equal(out.ok, true);
  assert.equal(out.items[0].unit_minor, 9050);
  assert.equal(out.items[0].line_minor, 18100);
});

test('an empty bill and an absurd one are both refused', () => {
  assert.equal(normaliseItems([]).ok, false);
  assert.equal(normaliseItems(null).ok, false);
  const many = Array.from({ length: 61 }, () => ({ name: 'x', qty: 1, price: '1' }));
  assert.equal(normaliseItems(many).ok, false);
});

test('lines are saved and read back in the order staff entered them', async () => {
  const { env } = db();
  const out = normaliseItems([
    { name: 'Starter', qty: 1, price: '8' },
    { name: 'Main', qty: 2, price: '17.50' },
    { name: 'Coffee', qty: 2, price: '3' },
  ]);
  assert.equal((await saveItems(env, 'tok1', out.items)).ok, true);
  const back = await itemsFor(env, 'TOK1');
  assert.deepEqual(back.map((r) => r.name), ['Starter', 'Main', 'Coffee']);
  assert.equal(back[1].line_minor, 3500);
});

test('a bill with no lines reads as no lines, never as an error', async () => {
  const { env } = db();
  assert.deepEqual(await itemsFor(env, 'NOPE'), []);
  // And on a worker that has the code but not migration 0045 at all.
  const noTable = { DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error('no such table'); } }) }) } };
  assert.deepEqual(await itemsFor(noTable, 'ANY'), []);
});

test('a saved product prices a line, and archiving it changes no bill', async () => {
  const { env } = db();
  const p = await addProduct(env, 'b1', { name: 'Singha', price: '90.50', currency: 'thb' });
  assert.equal(p.ok, true);
  assert.equal(p.price_minor, 9050);
  assert.equal(p.currency, 'THB');

  const priced = normaliseItems([{ name: p.name, qty: 2, unit_minor: p.price_minor }]);
  assert.equal((await saveItems(env, 'TOK2', priced.items)).ok, true);

  assert.equal((await archiveProduct(env, 'b1', p.id)).ok, true);
  assert.deepEqual(await listProducts(env, 'b1'), []);

  // The bill is untouched: the line copied the name and the price, and never
  // looks at the product again.
  const back = await itemsFor(env, 'TOK2');
  assert.equal(back.length, 1);
  assert.equal(back[0].unit_minor, 9050);
});

test('archiving somebody else\'s product does nothing', async () => {
  const { env } = db();
  const p = await addProduct(env, 'b1', { name: 'Singha', price: '90', currency: 'THB' });
  const out = await archiveProduct(env, 'b2', p.id);
  assert.equal(out.ok, false);
  assert.equal((await listProducts(env, 'b1')).length, 1);
});

test('a product price that is not a plain amount is refused', async () => {
  const { env } = db();
  const out = await addProduct(env, 'b1', { name: 'Mystery', price: 'nine dollars', currency: 'USD' });
  assert.equal(out.ok, false);
  assert.match(out.reason, /plain amount/);
});
