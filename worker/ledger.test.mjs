/**
 * One ledger, read by whoever is looking at it.
 *
 * The properties pinned here are the ones a person loses money over, or loses
 * trust over: nothing is summed across currencies, pending money is never
 * counted as moved, a bill with no payer belongs to nobody, and a fee taken
 * at source is a separate line from a fee on a statement — which is how the
 * double charge found on 19 Sep 2026 becomes visible rather than netted away.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ACTOR, DIRECTION, ENTRY, totals, chargedTwice,
  memberEntries, memberOpen, businessEntries, ledgerFor,
} from './ledger.mjs';

function world() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, status TEXT);
    CREATE TABLE num_paylinks (token TEXT PRIMARY KEY, business_id TEXT, label TEXT,
      amount TEXT, currency TEXT, state TEXT, created_at TEXT, settled_at TEXT,
      charged_via TEXT, application_fee_minor INTEGER, revoked_at TEXT,
      paid_by_member TEXT, split_parent TEXT, split_for_member TEXT, split_at TEXT);
    CREATE TABLE num_commissions (id TEXT PRIMARY KEY, booking_id TEXT, business_id TEXT,
      amount_cs INTEGER, currency TEXT, state TEXT, created_at TEXT, invoice_id TEXT, note TEXT);
    CREATE TABLE num_business_payouts (id TEXT PRIMARY KEY, business_id TEXT, account_id TEXT,
      amount_minor INTEGER, currency TEXT, status TEXT, arrives_on TEXT, failure TEXT,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE num_venue_payouts (id TEXT PRIMARY KEY, booking_id TEXT, business_id TEXT,
      kind TEXT, gross_cs INTEGER, share_bps INTEGER, amount_cs INTEGER, currency TEXT,
      state TEXT, created_at TEXT, paid_at TEXT);
    INSERT INTO businesses VALUES ('b1','Bar Nine','active');
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

const paid = (d, o) => d.prepare(
  `INSERT INTO num_paylinks (token,business_id,label,amount,currency,state,created_at,settled_at,
     charged_via,application_fee_minor,paid_by_member,split_parent,split_for_member)
   VALUES (?,?,?,?,?,'active',?,?,?,?,?,?,?)`,
).run(o.token, 'b1', o.label ?? 'Bill', o.amount, o.currency ?? 'USD',
  o.created ?? '2026-09-18 12:00:00', o.settled ?? '2026-09-18 20:00:00',
  o.via ?? 'card', o.fee ?? null, o.payer ?? null, o.parent ?? null, o.forMember ?? null);

/* ── the member ────────────────────────────────────────────────────────── */

test('a bill with no payer stamped belongs to nobody', async () => {
  const { d, env } = world();
  paid(d, { token: 'B1', amount: '24.00', payer: null });
  assert.deepEqual(await memberEntries(env, 'm1'), []);
});

test('a bill a member paid is one line out, with the rail that settled it', async () => {
  const { d, env } = world();
  paid(d, { token: 'B1', amount: '24.00', payer: 'm1', via: 'pay_by_bank' });
  const [e] = await memberEntries(env, 'm1');
  assert.equal(e.kind, 'bill_paid');
  assert.equal(e.direction, DIRECTION.OUT);
  assert.equal(e.amount_minor, 2400);
  assert.equal(e.amount, '24.00');
  assert.equal(e.counterparty, 'Bar Nine');
  assert.equal(e.note, 'pay_by_bank');
  assert.equal(e.state, 'settled');
});

test('a share of somebody else’s dinner is named as one', async () => {
  const { d, env } = world();
  paid(d, { token: 'S1', amount: '18.75', payer: 'm1', parent: 'PARENT' });
  const [e] = await memberEntries(env, 'm1');
  assert.equal(e.kind, 'share_paid');
  assert.equal(e.what, ENTRY.share_paid);
});

test('a share waiting to be paid is pending and is not in the history', async () => {
  const { d, env } = world();
  d.prepare(`INSERT INTO num_paylinks (token,business_id,amount,currency,state,created_at,split_for_member,split_parent)
             VALUES ('S2','b1','18.75','USD','active','2026-09-18 20:00:00','m1','PARENT')`).run();
  assert.deepEqual(await memberEntries(env, 'm1'), [], 'unpaid money must not appear as spent');
  const [o] = await memberOpen(env, 'm1');
  assert.equal(o.kind, 'share_owed');
  assert.equal(o.state, 'pending');
  assert.equal(o.amount, '18.75');
});

test('a revoked share is not money anybody owes', async () => {
  const { d, env } = world();
  d.prepare(`INSERT INTO num_paylinks (token,business_id,amount,currency,state,created_at,split_for_member,revoked_at)
             VALUES ('S3','b1','18.75','USD','revoked','2026-09-18 20:00:00','m1','2026-09-18 20:05:00')`).run();
  assert.deepEqual(await memberOpen(env, 'm1'), []);
});

test('what is owed is never folded into what was spent', async () => {
  const { d, env } = world();
  paid(d, { token: 'B1', amount: '10.00', payer: 'm1' });
  d.prepare(`INSERT INTO num_paylinks (token,business_id,amount,currency,state,created_at,split_for_member)
             VALUES ('S4','b1','90.00','USD','active','2026-09-18 21:00:00','m1')`).run();
  const out = await ledgerFor(env, { actor: ACTOR.MEMBER, id: 'm1' });
  assert.equal(out.open.length, 1);
  const spent = out.totals.find((t) => t.kind === 'bill_paid');
  assert.equal(spent.amount, '10.00', 'the 90 owed must not be in the 10 spent');
});

/* ── currencies ────────────────────────────────────────────────────────── */

test('dollars and baht are two totals, never one number', async () => {
  const { d, env } = world();
  paid(d, { token: 'B1', amount: '70.00', currency: 'USD', payer: 'm1' });
  paid(d, { token: 'B2', amount: '70.00', currency: 'THB', payer: 'm1' });
  const out = await ledgerFor(env, { actor: ACTOR.MEMBER, id: 'm1' });
  const rows = out.totals.filter((t) => t.kind === 'bill_paid');
  assert.equal(rows.length, 2, 'a ฿70 walk-in once rendered as $70.00 thirty-three times over');
  assert.deepEqual(out.currencies, ['THB', 'USD']);
});

test('a total carries its own currency, so a screen cannot label it wrongly', () => {
  const rows = totals([
    { kind: 'bill_paid', state: 'settled', amount_minor: 100, currency: 'THB' },
    { kind: 'bill_paid', state: 'settled', amount_minor: 100, currency: 'USD' },
  ]);
  assert.deepEqual(rows.map((r) => r.currency), ['THB', 'USD']);
});

test('pending money is never in a total', () => {
  const rows = totals([
    { kind: 'share_owed', state: 'pending', amount_minor: 9000, currency: 'USD' },
    { kind: 'bill_paid', state: 'settled', amount_minor: 1000, currency: 'USD' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount_minor, 1000);
});

/* ── the business ──────────────────────────────────────────────────────── */

test('a settled bill and the fee taken out of it are two lines, not one net figure', async () => {
  const { d, env } = world();
  paid(d, { token: 'B1', amount: '24.00', fee: 240 });
  const lines = await businessEntries(env, 'b1');
  const inLine = lines.find((l) => l.kind === 'bill_settled');
  const feeLine = lines.find((l) => l.kind === 'fee_at_source');
  assert.equal(inLine.direction, DIRECTION.IN);
  assert.equal(inLine.amount, '24.00', 'the venue must see what the guest actually paid');
  assert.equal(feeLine.direction, DIRECTION.OUT);
  assert.equal(feeLine.amount, '2.40');
  assert.match(feeLine.note, /before it reached your balance/);
});

test('a split bill is counted once, on the parent', async () => {
  const { d, env } = world();
  paid(d, { token: 'PARENT', amount: '84.00' });
  paid(d, { token: 'S1', amount: '21.00', parent: 'PARENT' });
  paid(d, { token: 'S2', amount: '21.00', parent: 'PARENT' });
  const lines = await businessEntries(env, 'b1');
  const settled = lines.filter((l) => l.kind === 'bill_settled');
  assert.equal(settled.length, 1, 'counting the shares too would double the venue’s takings');
  assert.equal(settled[0].amount, '84.00');
});

test('a Stripe payout is the venue’s own bank transfer, not income from NUM', async () => {
  const { d, env } = world();
  d.prepare(`INSERT INTO num_business_payouts (id,business_id,amount_minor,currency,status,arrives_on,created_at,updated_at)
             VALUES ('po_1','b1',150000,'USD','in_transit','2026-09-22','2026-09-19 09:00:00','2026-09-19 09:00:00')`).run();
  const [e] = (await businessEntries(env, 'b1')).filter((l) => l.kind === 'payout');
  assert.equal(e.direction, DIRECTION.OUT);
  assert.equal(e.state, 'in_transit', 'Stripe’s word, copied — in transit must not read as paid');
  assert.match(e.note, /expected 2026-09-22/);
});

test('a failed payout says why and never reads as arrived', async () => {
  const { d, env } = world();
  d.prepare(`INSERT INTO num_business_payouts (id,business_id,amount_minor,currency,status,failure,created_at,updated_at)
             VALUES ('po_2','b1',150000,'USD','failed','account_closed','2026-09-19 09:00:00','2026-09-19 09:00:00')`).run();
  const [e] = (await businessEntries(env, 'b1')).filter((l) => l.kind === 'payout');
  assert.equal(e.state, 'failed');
  assert.equal(e.note, 'account_closed');
  assert.equal(totals([e]).length, 0, 'a failed payout is not settled money');
});

test('money NUM owes the venue runs the other way and is pending until paid', async () => {
  const { d, env } = world();
  d.prepare(`INSERT INTO num_venue_payouts (id,booking_id,business_id,kind,gross_cs,share_bps,amount_cs,currency,state,created_at)
             VALUES ('vp_1','bk_1','b1','priority_seating',2000,5000,1000,'usd','accrued','2026-09-19 09:00:00')`).run();
  const [e] = (await businessEntries(env, 'b1')).filter((l) => l.kind === 'venue_share');
  assert.equal(e.direction, DIRECTION.IN, 'this is NUM paying the venue, the opposite of a Stripe payout');
  assert.equal(e.state, 'pending');
  assert.match(e.note, /not paid out yet/);
});

/* ── the defect this file was written to surface ───────────────────────── */

test('a bill charged at source AND on a statement is reported, not netted', async () => {
  const { d, env } = world();
  paid(d, { token: 'B1', amount: '24.00', fee: 200 });
  d.prepare(`INSERT INTO num_commissions (id,booking_id,business_id,amount_cs,currency,state,created_at,note)
             VALUES ('cm_bill_B1','bill:B1','b1',200,'USD','accrued','2026-09-18 20:00:01','flat $2.00')`).run();
  const lines = await businessEntries(env, 'b1');
  const twice = chargedTwice(lines);
  assert.equal(twice.length, 1);
  assert.equal(twice[0].bill, 'B1');
  assert.equal(twice[0].at_source_minor, 200);
  assert.equal(twice[0].invoiced_minor, 200);
  assert.match(twice[0].why, /at source AND a fee on a statement/);
});

test('a fee taken only at source is not a double charge', async () => {
  const { d, env } = world();
  paid(d, { token: 'B1', amount: '24.00', fee: 200 });
  assert.deepEqual(chargedTwice(await businessEntries(env, 'b1')), []);
});

test('a fee billed only on a statement is not a double charge', async () => {
  const { d, env } = world();
  paid(d, { token: 'B1', amount: '24.00', fee: null });
  d.prepare(`INSERT INTO num_commissions (id,booking_id,business_id,amount_cs,currency,state,created_at)
             VALUES ('cm_bill_B1','bill:B1','b1',200,'USD','accrued','2026-09-18 20:00:01')`).run();
  assert.deepEqual(chargedTwice(await businessEntries(env, 'b1')), []);
});

test('the venue answer carries the double-charge list; the member answer does not', async () => {
  const { d, env } = world();
  paid(d, { token: 'B1', amount: '24.00', fee: 200, payer: 'm1' });
  const biz = await ledgerFor(env, { actor: ACTOR.BUSINESS, id: 'b1' });
  const mem = await ledgerFor(env, { actor: ACTOR.MEMBER, id: 'm1' });
  assert.ok(Array.isArray(biz.charged_twice));
  assert.equal('charged_twice' in mem, false, 'a guest has no business reading our billing defects');
});

test('an invoiced fee says it has been asked for, an accrued one says it has not', async () => {
  const { d, env } = world();
  d.prepare(`INSERT INTO num_commissions (id,booking_id,business_id,amount_cs,currency,state,created_at,invoice_id)
             VALUES ('c1','bill:B1','b1',200,'USD','accrued','2026-09-18 20:00:00','inv_1')`).run();
  d.prepare(`INSERT INTO num_commissions (id,booking_id,business_id,amount_cs,currency,state,created_at)
             VALUES ('c2','bill:B2','b1',200,'USD','accrued','2026-09-18 21:00:00')`).run();
  const lines = await businessEntries(env, 'b1');
  assert.equal(lines.find((l) => l.ref === 'B1').state, 'invoiced');
  assert.equal(lines.find((l) => l.ref === 'B2').state, 'pending');
});

/* ── shape ─────────────────────────────────────────────────────────────── */

test('every kind in the vocabulary has a sentence a person can read', () => {
  for (const [k, v] of Object.entries(ENTRY)) {
    assert.equal(typeof v, 'string');
    assert.ok(v.length > 8, `${k} needs a real explanation, not a label`);
  }
});

test('the newest line is first, whichever table it came from', async () => {
  const { d, env } = world();
  paid(d, { token: 'B1', amount: '10.00', settled: '2026-09-17 20:00:00' });
  d.prepare(`INSERT INTO num_business_payouts (id,business_id,amount_minor,currency,status,created_at,updated_at)
             VALUES ('po_1','b1',5000,'USD','paid','2026-09-19 09:00:00','2026-09-19 09:00:00')`).run();
  const lines = await businessEntries(env, 'b1');
  assert.equal(lines[0].kind, 'payout');
});

test('no database is an empty ledger, not a crash', async () => {
  const out = await ledgerFor({}, { actor: ACTOR.MEMBER, id: 'm1' });
  assert.deepEqual(out.entries, []);
  assert.deepEqual(out.totals, []);
});
