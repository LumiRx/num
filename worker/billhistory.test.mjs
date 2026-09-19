// A member's own history — and, more to the point, what stays out of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { billsFor, tabsFor, itemsOf, handleBills } from './billhistory.mjs';

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, status TEXT);
    CREATE TABLE num_paylinks (token TEXT PRIMARY KEY, business_id TEXT, label TEXT, amount TEXT,
      currency TEXT, settled_at TEXT, charged_via TEXT, split_parent TEXT, paid_by_member TEXT);
    CREATE TABLE num_bill_items (id TEXT PRIMARY KEY, token TEXT, pos INTEGER, name TEXT,
      qty INTEGER, unit_minor INTEGER, line_minor INTEGER);
    CREATE TABLE num_tabs (id TEXT PRIMARY KEY, code TEXT, title TEXT, venue TEXT, owner_id TEXT,
      currency TEXT, state TEXT, created_at TEXT, closed_at TEXT);
    CREATE TABLE num_tab_members (tab_id TEXT, member_id TEXT, name TEXT, joined_at TEXT, settled_at TEXT);
    CREATE TABLE num_tab_items (id TEXT PRIMARY KEY, tab_id TEXT, label TEXT, stars INTEGER, paid_by TEXT, shared_with TEXT);
    INSERT INTO businesses VALUES ('b1','Bar Nine','active');
    INSERT INTO businesses VALUES ('b2','The Anchor','active');

    INSERT INTO num_paylinks VALUES ('PAID1','b1','Bill · Table 4','84.50','USD','2026-09-17T20:10:00Z','card',NULL,'m1');
    INSERT INTO num_paylinks VALUES ('PAID2','b2','Bill','18.75','GBP','2026-09-18T21:00:00Z','pay_by_bank','PARENT','m1');
    INSERT INTO num_paylinks VALUES ('OPEN1','b1','Bill','40.00','USD',NULL,NULL,NULL,'m1');
    INSERT INTO num_paylinks VALUES ('OTHER','b1','Bill','12.00','USD','2026-09-18T19:00:00Z','card',NULL,'m2');
    INSERT INTO num_paylinks VALUES ('NOBODY','b1','Bill','9.00','USD','2026-09-18T18:00:00Z','card',NULL,NULL);

    INSERT INTO num_bill_items VALUES ('i1','PAID1',0,'Pad Thai',2,1800,3600);
    INSERT INTO num_bill_items VALUES ('i2','PAID1',1,'Singha',3,905,2715);

    INSERT INTO num_tabs VALUES ('t1','ABC123','Bar Nine · Friday','Bar Nine','m1','stars','open','2026-09-17',NULL);
    INSERT INTO num_tab_members VALUES ('t1','m1','Dre','2026-09-17',NULL);
    INSERT INTO num_tab_members VALUES ('t1','m2','Viv','2026-09-17',NULL);
    INSERT INTO num_tab_items VALUES ('it1','t1','Round',40,'m1',NULL);
    INSERT INTO num_tabs VALUES ('t2','XYZ789','Someone else','Elsewhere','m3','stars','open','2026-09-16',NULL);
    INSERT INTO num_tab_members VALUES ('t2','m3','Sam','2026-09-16',NULL);
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
  };
  return { d, env: { DB } };
}

test('a member sees the bills they paid, newest first', async () => {
  const { env } = db();
  const bills = await billsFor(env, 'm1');
  assert.deepEqual(bills.map((b) => b.token), ['PAID2', 'PAID1']);
  assert.equal(bills[1].venue, 'Bar Nine');
  assert.equal(bills[1].amount, '84.50');
  assert.equal(bills[1].via, 'card');
  assert.equal(bills[1].items, 2);
});

test('an unpaid bill is never listed as one they paid', async () => {
  // The payer is stamped when a payment page is OPENED. Somebody who opened
  // Stripe and walked away has paid nothing, and their history must not say
  // otherwise.
  const { env } = db();
  const bills = await billsFor(env, 'm1');
  assert.ok(!bills.some((b) => b.token === 'OPEN1'));
});

test('a bill nobody was signed in for belongs to nobody', async () => {
  // Not the nearest member, not whoever booked the table. Half the value of a
  // history is trusting that what is in it is yours.
  const { env } = db();
  for (const who of ['m1', 'm2', 'm3']) {
    const bills = await billsFor(env, who);
    assert.ok(!bills.some((b) => b.token === 'NOBODY'), `${who} must not own an anonymous bill`);
  }
});

test('one member never sees another member\'s bills', async () => {
  const { env } = db();
  assert.deepEqual((await billsFor(env, 'm2')).map((b) => b.token), ['OTHER']);
});

test('a share of a split says so on the row', async () => {
  const { env } = db();
  const bills = await billsFor(env, 'm1');
  const share = bills.find((b) => b.token === 'PAID2');
  assert.equal(share.share_of, 'PARENT');
  // £18.75 at The Anchor reads oddly next to a dinner for four, so the row
  // carries what it was a share of.
  assert.equal(share.currency, 'GBP');
});

test('tabs come back with who was on them, and only the member\'s own', async () => {
  const { env } = db();
  const tabs = await tabsFor(env, 'm1');
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].code, 'ABC123');
  assert.equal(tabs[0].people, 2);
  assert.equal(tabs[0].stars, 40);
  assert.deepEqual(await tabsFor(env, 'm4'), []);
});

test('Stars on a tab and money on a bill are never added together', async () => {
  // They are different units. A single total would be a number that means
  // nothing, so the answer keeps them apart and offers no sum.
  const { env } = db();
  const res = await handleBills(new Request('https://x/api/bills?me=m1'), env, '/');
  const body = await res.json();
  assert.ok(Array.isArray(body.bills) && Array.isArray(body.tabs));
  assert.equal(body.total, undefined);
  assert.equal(body.spent, undefined);
});

test('the lines of one of their own bills come back', async () => {
  const { env } = db();
  const items = await itemsOf(env, 'm1', 'paid1');
  assert.equal(items.length, 2);
  assert.equal(items[0].name, 'Pad Thai');
});

test('asking for somebody else\'s bill lines gets the same answer as asking for a bill that does not exist', async () => {
  const { env } = db();
  assert.equal(await itemsOf(env, 'm2', 'PAID1'), null);
  assert.equal(await itemsOf(env, 'm1', 'NOSUCH'), null);
  const res = await handleBills(new Request('https://x/api/bills/PAID1?me=m2'), env, '/PAID1');
  assert.equal(res.status, 404);
});

test('no member id is a 401, not an empty history', async () => {
  const { env } = db();
  const res = await handleBills(new Request('https://x/api/bills'), env, '/');
  assert.equal(res.status, 401);
});

test('a worker without migration 0045 answers empty rather than 500', async () => {
  const broken = { DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error('no such column: paid_by_member'); } }) }) } };
  assert.deepEqual(await billsFor(broken, 'm1'), []);
  assert.deepEqual(await tabsFor(broken, 'm1'), []);
});
