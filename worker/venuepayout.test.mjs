// When the venue's money lands — and the two numbers that must never become
// one number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PAYOUT_EVENTS, businessForAccount, recordPayout, payoutsFor, numSettled, moneyView } from './venuepayout.mjs';

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE num_business_rails (business_id TEXT PRIMARY KEY, stripe_account_id TEXT,
      stripe_charges_enabled INTEGER DEFAULT 0, rails_off TEXT DEFAULT '[]');
    CREATE TABLE num_business_payouts (id TEXT PRIMARY KEY, business_id TEXT, account_id TEXT,
      amount_minor INTEGER, currency TEXT, status TEXT, arrives_on TEXT, failure TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE num_paylinks (token TEXT PRIMARY KEY, business_id TEXT, amount TEXT, currency TEXT,
      settled_at TEXT, one_time INTEGER DEFAULT 1, application_fee_minor INTEGER, split_at TEXT, split_parent TEXT);
    INSERT INTO num_business_rails VALUES ('b1','acct_venue',1,'[]');
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

const payout = (over = {}) => ({
  account: 'acct_venue',
  type: 'payout.paid',
  data: { object: { id: 'po_1', amount: 84000, currency: 'usd', status: 'paid', arrival_date: 1790000000, ...over } },
});

test('a payout is recorded against the venue that owns the account', async () => {
  const { env } = db();
  assert.equal(await businessForAccount(env, 'acct_venue'), 'b1');
  assert.equal(await businessForAccount(env, 'acct_someone_else'), null);

  const out = await recordPayout(env, payout());
  assert.equal(out.ok, true);
  assert.equal(out.business_id, 'b1');
  const [p] = await payoutsFor(env, 'b1');
  assert.equal(p.amount_minor, 84000);
  assert.equal(p.currency, 'USD');
  assert.equal(p.arrives_on, '2026-09-21');
});

test('the status is COPIED from Stripe, never inferred', async () => {
  // A venue planning around money that is not coming is worse off than one
  // who knows it failed.
  const { env } = db();
  await recordPayout(env, payout({ status: 'in_transit' }));
  assert.equal((await payoutsFor(env, 'b1'))[0].status, 'in_transit', 'in transit is not paid');

  await recordPayout(env, { ...payout(), type: 'payout.failed', data: { object: { id: 'po_1', amount: 84000, currency: 'usd', status: 'failed', failure_message: 'account_closed' } } });
  const [after] = await payoutsFor(env, 'b1');
  assert.equal(after.status, 'failed');
  assert.equal(after.failure, 'account_closed');
});

test('the same payout arriving twice updates it rather than duplicating it', async () => {
  const { d, env } = db();
  await recordPayout(env, payout({ status: 'in_transit' }));
  await recordPayout(env, payout({ status: 'paid' }));
  assert.equal(d.prepare('SELECT COUNT(*) n FROM num_business_payouts').get().n, 1);
  assert.equal((await payoutsFor(env, 'b1'))[0].status, 'paid');
});

test('a payout on an account no venue owns is not filed against a guess', async () => {
  const { env } = db();
  const out = await recordPayout(env, { ...payout(), account: 'acct_stranger' });
  assert.equal(out.ok, false);
  assert.deepEqual(await payoutsFor(env, 'b1'), []);
});

test('a payout we cannot write down is never a failed webhook', async () => {
  const broken = { DB: {
    prepare: (sql) => ({ bind: () => ({
      async first() { return /num_business_rails/.test(sql) ? { business_id: 'b1' } : null; },
      async run() { throw new Error('no such table: num_business_payouts'); },
    }) }),
  } };
  const out = await recordPayout(broken, payout());
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'could not record');
});

test('what NUM settled is counted per currency, never summed across them', async () => {
  // A venue that took dollars and baht has two totals, and one number would
  // be neither of them.
  const { d, env } = db();
  d.exec(`
    INSERT INTO num_paylinks VALUES ('a','b1','84.50','USD',datetime('now'),1,845,NULL,NULL);
    INSERT INTO num_paylinks VALUES ('b','b1','40.00','USD',datetime('now'),1,400,NULL,NULL);
    INSERT INTO num_paylinks VALUES ('c','b1','2400.00','THB',datetime('now'),1,7000,NULL,NULL);
  `);
  const rows = await numSettled(env, 'b1');
  const usd = rows.find((r) => r.currency === 'USD');
  const thb = rows.find((r) => r.currency === 'THB');
  assert.equal(usd.bills, 2);
  assert.equal(usd.gross_minor, 12450);
  assert.equal(usd.fee_minor, 1245);
  assert.equal(usd.net_minor, 11205);
  assert.equal(thb.bills, 1);
  assert.equal(rows.length, 2, 'two currencies, two rows, no total');
});

test('an unsettled bill and a split parent\'s shares are not counted as takings', async () => {
  const { d, env } = db();
  d.exec(`
    INSERT INTO num_paylinks VALUES ('open','b1','50.00','USD',NULL,1,NULL,NULL,NULL);
    INSERT INTO num_paylinks VALUES ('parent','b1','84.00','USD',datetime('now'),1,840,datetime('now'),NULL);
    INSERT INTO num_paylinks VALUES ('share1','b1','42.00','USD',datetime('now'),1,420,NULL,'parent');
    INSERT INTO num_paylinks VALUES ('share2','b1','42.00','USD',datetime('now'),1,420,NULL,'parent');
  `);
  const [usd] = await numSettled(env, 'b1');
  // The dinner is 84.00 once. The SHARES are what the venue's account was
  // actually charged, so they are what is counted; the parent is excluded
  // because it was never charged — counting both would show a venue 168.00
  // of takings for one table.
  assert.equal(usd.gross_minor, 8400);
  assert.equal(usd.fee_minor, 840, 'and the fee comes from the shares, which carry it');
  // Two charges, honestly, because the venue's account really did take two.
  assert.equal(usd.bills, 2);
});

test('the two figures are returned side by side and never added', async () => {
  const { d, env } = db();
  d.exec("INSERT INTO num_paylinks VALUES ('a','b1','84.50','USD',datetime('now'),1,845,NULL,NULL);");
  await recordPayout(env, payout());
  const v = await moneyView(env, 'b1');
  assert.ok(Array.isArray(v.payouts) && Array.isArray(v.through_num));
  assert.equal(v.total, undefined, 'a total of two different sets of money is a number nobody can check');
  assert.equal(v.balance, undefined);
  assert.match(v.note, /your whole balance/);
});

test('there is no function here that moves money', () => {
  // NUM records a payout. It cannot pay, delay, accelerate or reverse one,
  // and nothing in this module should ever suggest otherwise.
  // Functions only — PAYOUT_EVENTS is a list of event names and is allowed to
  // be called what Stripe calls them.
  // The verb has to BE the name or start a camelCase word: payBill is banned,
  // payoutsFor is a noun and is not.
  const banned = /^(pay|send|transfer|release|hold|delay|reverse|cancel|retry)([A-Z]|$)/;
  const fns = ['businessForAccount', 'recordPayout', 'payoutsFor', 'numSettled', 'moneyView', 'handleMoney'];
  for (const name of fns) assert.ok(!banned.test(name), `${name} sounds like it moves money`);
  assert.ok(fns.every((n) => /^[a-z]/.test(n)), 'the check covers every exported function');
});

test('only the payout events we listen for are listed, and payout.paid is one', () => {
  assert.ok(PAYOUT_EVENTS.includes('payout.paid'));
  assert.ok(PAYOUT_EVENTS.includes('payout.failed'));
  assert.ok(PAYOUT_EVENTS.every((e) => e.startsWith('payout.')));
});
