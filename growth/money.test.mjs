/**
 * money — the invoice and payout path, against real SQLite.
 *
 * These are the tests that matter most in the repo: everything here either
 * bills a merchant or moves money to a host, and both are mistakes you cannot
 * take back quietly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  lastFullWeek, owed, invoiceVenue, invoiceAll, invoicesFor, invoiceLines,
  payInvoice, payee, releaseHostShare, buildPayoutRun, markPayoutSent, hostLedger,
} from './money.mjs';

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active');
    CREATE TABLE num_commissions (
      id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, business_id TEXT, place_id TEXT,
      venue_name TEXT, member_id TEXT, dest TEXT, category TEXT NOT NULL, kind TEXT NOT NULL,
      rate_bp INTEGER, flat_cs INTEGER, basis_cs INTEGER, amount_cs INTEGER,
      currency TEXT NOT NULL DEFAULT 'usd', state TEXT NOT NULL DEFAULT 'accrued',
      source TEXT, created_at TEXT NOT NULL, invoiced_at TEXT, note TEXT,
      paid_at TEXT, paid_cs INTEGER, invoice_id TEXT);
    CREATE TABLE num_invoices (
      id TEXT PRIMARY KEY, business_id TEXT NOT NULL, period_start TEXT NOT NULL,
      period_end TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'THB', amount_cs INTEGER NOT NULL,
      line_count INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'open',
      issued_at TEXT NOT NULL, due_at TEXT, paid_at TEXT, paid_cs INTEGER, paid_ref TEXT, note TEXT);
    CREATE TABLE num_hosts (id TEXT PRIMARY KEY, name TEXT, email TEXT, code TEXT,
      host_bps INTEGER DEFAULT 300, status TEXT DEFAULT 'active');
    CREATE TABLE num_host_earnings (
      id TEXT PRIMARY KEY, host_id TEXT NOT NULL, code TEXT NOT NULL, booking_ref TEXT NOT NULL,
      business_ref TEXT, guest_ref TEXT, currency TEXT NOT NULL DEFAULT 'GBP',
      booking_minor INTEGER NOT NULL, our_commission_minor INTEGER NOT NULL,
      host_share_minor INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'accrued',
      void_reason TEXT, completed_at TEXT, collected_at TEXT, payable_at TEXT, paid_at TEXT,
      payout_ref TEXT, created_at TEXT NOT NULL);
    CREATE TABLE num_payout_runs (id TEXT PRIMARY KEY, currency TEXT NOT NULL DEFAULT 'GBP',
      total_minor INTEGER NOT NULL DEFAULT 0, host_count INTEGER NOT NULL DEFAULT 0,
      line_count INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL, paid_at TEXT, paid_ref TEXT, note TEXT);
  `);
  const DB = {
    prepare(sql) {
      const bound = [];
      const api = {
        bind(...a) { bound.push(...a); return api; },
        async first() { try { return d.prepare(sql).get(...bound) ?? null; } catch { return null; } },
        async all() { try { return { results: d.prepare(sql).all(...bound) }; } catch { return { results: [] }; } },
        async run() {
          const r = d.prepare(sql).run(...bound);
          return { meta: { changes: Number(r.changes ?? 0) } };
        },
      };
      return api;
    },
  };
  return { d, env: { DB } };
}

let n = 0;
function line(d, { biz = 'biz1', amount = 24000, state = 'accrued', currency = 'THB',
  booking = null, at = '2026-08-10T12:00:00Z' } = {}) {
  const id = 'c' + (++n);
  const bk = booking || 'bk_' + id;
  d.prepare(`INSERT INTO num_commissions
    (id,booking_id,business_id,venue_name,category,kind,rate_bp,basis_cs,amount_cs,currency,state,created_at)
    VALUES (?,?,?,'Bang Tao','reservation','rate',1000,?,?,?,?,?)`)
    .run(id, bk, biz, amount * 10, amount, currency, state, at);
  return { id, booking: bk };
}

function host(d, { id = 'h1', bps = 300, status = 'active' } = {}) {
  d.prepare('INSERT INTO num_hosts (id,name,email,code,host_bps,status) VALUES (?,?,?,?,?,?)')
    .run(id, 'Ana', id + '@example.com', 'CODE' + id.toUpperCase(), bps, status);
  return id;
}

function earning(d, { hostId = 'h1', booking, minor = 100000, share = 3000, state = 'accrued',
  currency = 'GBP' } = {}) {
  const id = 'e' + (++n);
  d.prepare(`INSERT INTO num_host_earnings
    (id,host_id,code,booking_ref,currency,booking_minor,our_commission_minor,host_share_minor,state,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,'2026-08-10T12:00:00Z')`)
    .run(id, hostId, 'CODE' + hostId.toUpperCase(), booking, currency, minor,
      Math.round(minor * 0.10), share, state);
  return id;
}

/* ── the billing week ────────────────────────────────────────────────────── */

test('the week billed is always a week that has finished', () => {
  // Wednesday 12 Aug 2026
  const w = lastFullWeek(new Date('2026-08-12T09:00:00Z'));
  assert.equal(w.start.slice(0, 10), '2026-08-03', 'the Monday before last');
  assert.equal(w.end.slice(0, 10), '2026-08-09', 'through Sunday');
  assert.ok(new Date(w.end) < new Date('2026-08-12T09:00:00Z'));
});

test('on a Monday it bills the week that just closed, not the one starting', () => {
  const w = lastFullWeek(new Date('2026-08-10T00:30:00Z')); // Monday
  assert.equal(w.start.slice(0, 10), '2026-08-03');
  assert.equal(w.end.slice(0, 10), '2026-08-09');
});

/* ── what is owed ────────────────────────────────────────────────────────── */

test('a booking whose bill we never saw is counted but never summed', async () => {
  const { d, env } = db();
  line(d, { amount: 24000 });
  line(d, { amount: 0, state: 'awaiting_value' });
  const o = await owed(env, 'biz1');
  assert.equal(o.total_cs, 24000, 'only the line with a real basis');
  assert.equal(o.awaiting, 1);
  assert.equal(o.lines.length, 2, 'the awkward row is still shown');
});

/* ── invoicing ───────────────────────────────────────────────────────────── */

test('an invoice claims its lines so the same dinner is never billed twice', async () => {
  const { d, env } = db();
  line(d, { amount: 24000 });
  line(d, { amount: 18500 });

  const first = await invoiceVenue(env, 'biz1');
  assert.equal(first.ok, true);
  assert.equal(first.amount_cs, 42500);
  assert.equal(first.line_count, 2);

  const second = await invoiceVenue(env, 'biz1');
  assert.equal(second.skipped, 'nothing owed', 'a second Monday must not re-bill the same week');
  assert.equal((await owed(env, 'biz1')).total_cs, 0);
});

test('a line dated after the billed week waits for the next invoice', async () => {
  const { d, env } = db();
  line(d, { amount: 10000, at: '2026-08-05T12:00:00Z' });   // inside
  line(d, { amount: 99900, at: '2026-08-12T12:00:00Z' });   // after the week end
  const out = await invoiceVenue(env, 'biz1', { period: lastFullWeek(new Date('2026-08-12T09:00:00Z')) });
  assert.equal(out.line_count, 1);
  assert.equal(out.amount_cs, 10000);
});

test('an awaiting_value line is never invoiced', async () => {
  const { d, env } = db();
  line(d, { amount: 0, state: 'awaiting_value' });
  const out = await invoiceVenue(env, 'biz1');
  assert.equal(out.skipped, 'nothing owed', 'billing a number we do not have is how you lose a merchant');
});

test('baht and dollars are never added together on one invoice', async () => {
  const { d, env } = db();
  line(d, { amount: 24000, currency: 'THB' });
  line(d, { amount: 5000, currency: 'USD' });
  const out = await invoiceVenue(env, 'biz1');
  assert.equal(out.currency, 'THB');
  assert.equal(out.line_count, 1);
  assert.equal(out.amount_cs, 24000);
  const still = await owed(env, 'biz1');
  assert.equal(still.total_cs, 5000, 'the other currency is still owed, not lost');
});

test('invoiceAll cuts one invoice per venue', async () => {
  const { d, env } = db();
  line(d, { biz: 'biz1', amount: 24000 });
  line(d, { biz: 'biz2', amount: 11000 });
  line(d, { biz: 'biz2', amount: 9000 });
  const out = await invoiceAll(env);
  assert.equal(out.invoiced, 2);
  assert.equal((await invoicesFor(env, 'biz2'))[0].amount_cs, 20000);
});

/* ── collection ──────────────────────────────────────────────────────────── */

test('paying an invoice clears its lines off the collections list', async () => {
  const { d, env } = db();
  line(d, { amount: 24000 });
  const inv = await invoiceVenue(env, 'biz1');

  const paid = await payInvoice(env, inv.id, { ref: 'PP-88213' });
  assert.equal(paid.ok, true);
  assert.equal(paid.lines, 1);

  const rows = await invoiceLines(env, inv.id);
  const c = d.prepare('SELECT paid_cs, paid_at FROM num_commissions WHERE id=?').get(rows[0].id);
  assert.equal(c.paid_cs, 24000, '"paid" must live on the line, not only on the invoice');
  assert.ok(c.paid_at);
});

test('paying twice does not double-count', async () => {
  const { d, env } = db();
  line(d, { amount: 24000 });
  const inv = await invoiceVenue(env, 'biz1');
  await payInvoice(env, inv.id, { ref: 'A' });
  const again = await payInvoice(env, inv.id, { ref: 'B' });
  assert.equal(again.already, true);
  const row = d.prepare('SELECT paid_ref FROM num_invoices WHERE id=?').get(inv.id);
  assert.equal(row.paid_ref, 'A', 'the first reference stands');
});

test('NUM refuses to name an account it does not have', () => {
  assert.equal(payee({}).ok, false);
  assert.match(payee({}).reason, /NUM_PAYEE_PROMPTPAY/);
});

test('a Thai bank account is offered when configured', () => {
  const p = payee({ NUM_PAYEE_PROMPTPAY: '081-234-5678', NUM_PAYEE_NAME: '5arz' });
  assert.equal(p.ok, true);
  assert.equal(p.promptpay, '0812345678');
  assert.equal(p.methods.length, 1);
});

test('a wallet alone is enough — this is the rail that works today', () => {
  const p = payee({ NUM_PAYEE_WALLET: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' });
  assert.equal(p.ok, true, 'PromptPay needs a Thai bank account; USDC does not');
  assert.equal(p.methods[0].kind, 'crypto');
  assert.equal(p.methods[0].asset, 'USDC');
});

test('both rails are offered when both exist, and the venue picks', () => {
  const p = payee({
    NUM_PAYEE_PROMPTPAY: '0812345678',
    NUM_PAYEE_WALLET: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  });
  assert.deepEqual(p.methods.map((m) => m.kind), ['promptpay', 'crypto']);
});

test('a bad payee wallet is ignored rather than shown to venues', () => {
  const p = payee({ NUM_PAYEE_WALLET: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD' });
  assert.equal(p.ok, false, 'a checksum failure in our OWN address must not reach a statement');
});

/* ── hosts: paid out of collected money, never invoiced money ────────────── */

test('a host is not payable until the venue has actually paid', async () => {
  const { d, env } = db();
  host(d);
  const c = line(d, { amount: 24000 });
  earning(d, { booking: c.booking });

  const inv = await invoiceVenue(env, 'biz1');
  let led = await hostLedger(env, 'h1');
  assert.equal(led.due_to_you, 0, 'invoicing is not collecting');
  assert.equal(led.waiting_on_the_venue, 3000);

  await payInvoice(env, inv.id, { ref: 'PP-1' });
  led = await hostLedger(env, 'h1');
  assert.equal(led.due_to_you, 3000, 'now the money is real');
  assert.equal(led.waiting_on_the_venue, 0);
});

test('an earning for a booking on nobody’s paid invoice is left alone', async () => {
  const { d, env } = db();
  host(d);
  const mine = line(d, { amount: 24000 });
  earning(d, { booking: mine.booking });
  earning(d, { booking: 'bk_somebody_else' });

  const inv = await invoiceVenue(env, 'biz1');
  await payInvoice(env, inv.id);
  const led = await hostLedger(env, 'h1');
  assert.equal(led.due_to_you, 3000, 'only the booking that was actually paid for');
  assert.equal(led.waiting_on_the_venue, 3000);
});

test('releasing is idempotent', async () => {
  const { d, env } = db();
  host(d);
  const c = line(d, { amount: 24000 });
  earning(d, { booking: c.booking });
  assert.equal((await releaseHostShare(env, [c.booking])).released, 1);
  assert.equal((await releaseHostShare(env, [c.booking])).released, 0);
});

/* ── the payout run ──────────────────────────────────────────────────────── */

test('a run groups a host’s earnings and cannot pick them up twice', async () => {
  const { d, env } = db();
  host(d, { id: 'h1' });
  host(d, { id: 'h2' });
  earning(d, { hostId: 'h1', booking: 'b1', share: 3000, state: 'payable' });
  earning(d, { hostId: 'h1', booking: 'b2', share: 1500, state: 'payable' });
  earning(d, { hostId: 'h2', booking: 'b3', share: 800, state: 'payable' });

  const run = await buildPayoutRun(env);
  assert.equal(run.ok, true);
  assert.equal(run.total_minor, 5300);
  assert.equal(run.hosts.length, 2);
  assert.equal(run.hosts.find((h) => h.host_id === 'h1').amount, '45.00');

  const second = await buildPayoutRun(env);
  assert.equal(second.skipped, 'nothing payable', 'a second run must not pay the same money again');
});

test('nothing is marked paid until somebody says the transfer went', async () => {
  const { d, env } = db();
  host(d);
  earning(d, { booking: 'b1', share: 3000, state: 'payable' });
  const run = await buildPayoutRun(env);

  let led = await hostLedger(env, 'h1');
  assert.equal(led.paid_to_you, 0, 'building a run is not sending money');

  const sent = await markPayoutSent(env, run.id, { ref: 'WISE-2291' });
  assert.equal(sent.earnings_paid, 1);
  led = await hostLedger(env, 'h1');
  assert.equal(led.paid_to_you, 3000);
  assert.equal(led.due_to_you, 0);

  const again = await markPayoutSent(env, run.id, { ref: 'WISE-OOPS' });
  assert.equal(again.already, true);
  assert.equal(d.prepare('SELECT paid_ref FROM num_payout_runs WHERE id=?').get(run.id).paid_ref,
    'WISE-2291');
});

test('a host who has left is not paid', async () => {
  const { d, env } = db();
  host(d, { id: 'h1', status: 'ended' });
  earning(d, { hostId: 'h1', booking: 'b1', share: 3000, state: 'payable' });
  assert.equal((await buildPayoutRun(env)).skipped, 'nothing payable');
});

test('a payout smaller than the transfer fee rolls into the next run', async () => {
  const { d, env } = db();
  host(d);
  earning(d, { booking: 'b1', share: 120, state: 'payable' });
  const run = await buildPayoutRun(env, { minMinor: 1000 });
  assert.equal(run.skipped, 'all below the minimum');
  assert.equal(run.held, 1);
  assert.equal(d.prepare("SELECT state FROM num_host_earnings WHERE booking_ref='b1'").get().state,
    'payable', 'still owed, just not sent yet');
});

test('the host ledger is worded for the host, not for our state machine', async () => {
  const { d, env } = db();
  host(d);
  earning(d, { booking: 'b1', share: 3000, state: 'accrued' });
  earning(d, { booking: 'b2', share: 2000, state: 'payable' });
  earning(d, { booking: 'b3', share: 1000, state: 'paid' });
  const led = await hostLedger(env, 'h1');
  assert.equal(led.waiting_on_the_venue, 3000);
  assert.equal(led.due_to_you, 2000);
  assert.equal(led.paid_to_you, 1000);
});

test('a run that was never sent does not block the money forever', async () => {
  const { d, env } = db();
  host(d);
  earning(d, { booking: 'b1', share: 3000, state: 'payable' });
  const run = await buildPayoutRun(env);

  // An abandoned draft: the operator closed the tab. Releasing it puts the
  // money back in the queue rather than stranding it.
  d.prepare('UPDATE num_host_earnings SET payout_ref = NULL WHERE payout_ref = ?').run(run.id);
  d.prepare("UPDATE num_payout_runs SET state='void' WHERE id = ?").run(run.id);

  const again = await buildPayoutRun(env);
  assert.equal(again.ok, true);
  assert.equal(again.total_minor, 3000);
});
