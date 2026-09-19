// Splitting a bill between friends, with NUM never touching the money.
//
// The properties pinned here are the ones a person loses money over: the venue
// is never short by a penny, the fee is charged once for one dinner, and the
// same dinner cannot be paid twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { evenShares, allocateFee, splitBill, sharesFor, splitStateOf } from './billsplit.mjs';
import { settleBillCode } from './billqr.mjs';
import { billFor, billRails, feeForBill, createBillCheckout } from './billpay.mjs';

function realDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, status TEXT);
    CREATE TABLE num_business_profiles (business_id TEXT PRIMARY KEY, country TEXT);
    CREATE TABLE num_business_settings (business_id TEXT PRIMARY KEY, commission_bp INTEGER, walkin_fee_cs INTEGER);
    CREATE TABLE num_business_rails (business_id TEXT PRIMARY KEY, stripe_account_id TEXT,
      stripe_charges_enabled INTEGER DEFAULT 0, rails_off TEXT DEFAULT '[]');
    CREATE TABLE num_paylinks (token TEXT PRIMARY KEY, business_id TEXT, label TEXT, kind TEXT,
      target TEXT, promptpay_kind TEXT, amount_mode TEXT, amount TEXT, currency TEXT,
      state TEXT, created_at TEXT, booking_id TEXT, settled_at TEXT, one_time INTEGER DEFAULT 0,
      resource_id TEXT, issued_by TEXT, settled_by TEXT, crypto_asset TEXT, crypto_base_units TEXT, crypto_quote TEXT,
      checkout_session_id TEXT, payment_intent_id TEXT, charged_via TEXT, application_fee_minor INTEGER,
      pos_vendor TEXT, pos_order_id TEXT, pos_closed_at TEXT, revoked_at TEXT,
      paid_by_member TEXT, split_parent TEXT, split_for_member TEXT, split_at TEXT);
    CREATE TABLE num_bookings (id TEXT PRIMARY KEY, business_id TEXT, status TEXT, value_cs INTEGER DEFAULT 0);
    CREATE TABLE num_bill_items (id TEXT PRIMARY KEY, token TEXT, pos INTEGER, name TEXT,
      qty INTEGER, unit_minor INTEGER, line_minor INTEGER, created_at TEXT);
    INSERT INTO businesses VALUES ('b1','Bar Nine','active');
    INSERT INTO num_business_profiles VALUES ('b1','US');
    INSERT INTO num_business_settings (business_id, commission_bp, walkin_fee_cs) VALUES ('b1', 1000, 200);
    INSERT INTO num_business_rails VALUES ('b1','acct_venue',1,'[]');
    INSERT INTO num_paylinks (token,business_id,label,kind,target,amount_mode,currency,state,created_at,one_time)
      VALUES ('STICK','b1','Table 4','url','https://pay.barnine.com','open','USD','active','2026-09-17',0);
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
  return { d, env: { DB, SITE: 'https://itsnum.com', STRIPE_SECRET_KEY: 'sk_test_x' } };
}

/** A fixed bill on the table, ready to split. */
function putBill(d, { token = 'PARENT', amount = '84.00', booking = null } = {}) {
  d.prepare(`INSERT INTO num_paylinks (token,business_id,label,kind,target,amount_mode,amount,currency,state,created_at,one_time,booking_id)
             VALUES (?,'b1','Bill','url','https://pay.barnine.com','fixed',?,'USD','active','2026-09-17',1,?)`)
    .run(token, amount, booking);
}

const FOUR = [
  { member_id: 'm1', name: 'Dre' }, { member_id: 'm2', name: 'Viv' },
  { member_id: 'm3', name: 'Sam' }, { member_id: 'm4', name: 'Jo' },
];

test('an even split that does not divide leaves the odd penny with the splitter', () => {
  const parts = evenShares(2401, 3);
  assert.equal(parts.reduce((a, b) => a + b, 0), 2401, 'the venue must not be a penny short');
  assert.deepEqual(parts, [801, 800, 800]);
});

test('a split too small to make real bills is refused rather than rounded', () => {
  assert.equal(evenShares(3, 4), null);
  assert.equal(evenShares(100, 1), null);
  assert.equal(evenShares(100, 13), null);
});

test('the fee parts sum to exactly the fee on the whole dinner', () => {
  for (const [fee, shares] of [[840, [2101, 700, 700]], [7, [1, 1, 1]], [199, [500, 500, 500, 500]]]) {
    const parts = allocateFee(fee, shares);
    assert.equal(parts.reduce((a, b) => a + b, 0), fee, `${fee} across ${shares}`);
    assert.ok(parts.every((p) => p >= 0));
  }
});

test('a split mints one real code per person, summing to the bill', async () => {
  const { d, env } = realDb();
  putBill(d, { amount: '84.00' });
  const out = await splitBill(env, 'PARENT', { people: FOUR });
  assert.equal(out.ok, true);
  assert.equal(out.shares.length, 4);
  assert.equal(out.shares.reduce((n, s) => n + s.amount_minor, 0), 8400);
  // Each share is a real, payable bill code of its own.
  for (const sh of out.shares) {
    const b = await billFor(env, sh.token);
    assert.equal(b.state, 'open');
    assert.equal(b.amount_minor, sh.amount_minor);
  }
});

test('the fee is charged once for one dinner, not once per friend', async () => {
  const { d, env } = realDb();
  d.prepare("INSERT INTO num_bookings VALUES ('bk1','b1','confirmed',0)").run();
  putBill(d, { amount: '84.00', booking: 'bk1' });
  const parent = await billFor(env, 'PARENT');
  const whole = await feeForBill(env, parent);
  assert.equal(whole.minor, 840); // 10% of 84.00

  const out = await splitBill(env, 'PARENT', { people: FOUR });
  const shares = await sharesFor(env, 'PARENT');
  const summed = shares.reduce((n, s) => n + Number(s.application_fee_minor), 0);
  assert.equal(summed, whole.minor, 'four shares must carry the fee for one dinner');

  // And each share reports its own allocation rather than recomputing a fee.
  const one = await feeForBill(env, await billFor(env, shares[0].token));
  assert.equal(one.basis, 'split_share');
  assert.equal(one.minor, Number(shares[0].application_fee_minor));
});

test('a share has no booking of its own, so it cannot accrue twice', async () => {
  const { d, env } = realDb();
  d.prepare("INSERT INTO num_bookings VALUES ('bk1','b1','confirmed',0)").run();
  putBill(d, { amount: '84.00', booking: 'bk1' });
  await splitBill(env, 'PARENT', { people: FOUR });
  const rows = d.prepare('SELECT booking_id FROM num_paylinks WHERE split_parent = ?').all('PARENT');
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.booking_id == null));
});

test('the parent is closed the moment it is split, so one dinner cannot be paid twice', async () => {
  const { d, env } = realDb();
  putBill(d, { amount: '84.00' });
  await splitBill(env, 'PARENT', { people: FOUR });

  // Every surface reads the same state, and it is not 'open'.
  const view = await billRails(env, 'PARENT', {});
  assert.equal(view.bill.state, 'split');

  const res = await createBillCheckout(env, 'PARENT', 'card', {});
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.match(res.reason, /share/);

  // The shares themselves are untouched by any of that.
  const shares = await sharesFor(env, 'PARENT');
  assert.equal(shares.length, 4);
  assert.ok(shares.every((sh) => sh.settled_at == null));
});

test('a bill cannot be split twice, and a share cannot be split at all', async () => {
  const { d, env } = realDb();
  putBill(d, { amount: '84.00' });
  const first = await splitBill(env, 'PARENT', { people: FOUR });
  assert.equal(first.ok, true);

  const again = await splitBill(env, 'PARENT', { people: FOUR });
  assert.equal(again.ok, false);
  assert.match(again.reason, /already been split/);

  const child = await splitBill(env, first.shares[0].token, { people: FOUR });
  assert.equal(child.ok, false);
  assert.match(child.reason, /cannot be split again/);
});

test('uneven shares that do not add up are refused, with both figures named', async () => {
  const { d, env } = realDb();
  putBill(d, { amount: '84.00' });
  const out = await splitBill(env, 'PARENT', { people: FOUR.slice(0, 2), amounts: [4000, 4000] });
  assert.equal(out.ok, false);
  assert.match(out.reason, /80\.00/);
  assert.match(out.reason, /84\.00/);
  // Nothing was minted and the parent is untouched.
  assert.deepEqual(await sharesFor(env, 'PARENT'), []);
  assert.equal((await splitStateOf(env, 'PARENT')).split_at, null);
});

test('uneven shares that do add up are minted exactly as asked', async () => {
  const { d, env } = realDb();
  putBill(d, { amount: '84.00' });
  const out = await splitBill(env, 'PARENT', { people: FOUR.slice(0, 2), amounts: [6000, 2400] });
  assert.equal(out.ok, true);
  assert.deepEqual(out.shares.map((s) => s.amount), ['60.00', '24.00']);
});

test('a bill that is already paid is never split', async () => {
  const { d, env } = realDb();
  putBill(d, { amount: '84.00' });
  d.prepare("UPDATE num_paylinks SET settled_at='2026-09-18' WHERE token='PARENT'").run();
  const out = await splitBill(env, 'PARENT', { people: FOUR });
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
});

test('the parent settles only when the shares COVER it, and then just once', async () => {
  const { d, env } = realDb();
  putBill(d, { amount: '84.00' });
  const out = await splitBill(env, 'PARENT', { people: FOUR });
  const toks = out.shares.map((s) => s.token);

  for (const t of toks.slice(0, 3)) {
    const r = await settleBillCode(env, t, { settledBy: 'stripe' });
    assert.equal(r.ok, true);
    assert.equal(r.split_parent, 'PARENT');
    assert.equal(r.billed, false, 'a share earns nothing on its own');
    assert.equal(r.parent.settled, false, 'three quarters is not a paid dinner');
  }

  const last = await settleBillCode(env, toks[3], { settledBy: 'stripe' });
  assert.equal(last.parent.settled, true);
  assert.equal(last.parent.fees_minor, out.shares.reduce((n, s) => n + s.fee_minor, 0));
  const parent = d.prepare("SELECT settled_at FROM num_paylinks WHERE token='PARENT'").get();
  assert.ok(parent.settled_at, 'the dinner is paid');
});

test('a generous friend paying two shares still covers the dinner', async () => {
  // Settlement is on money, not on a headcount: a share can be paid by anyone.
  const { d, env } = realDb();
  putBill(d, { amount: '80.00' });
  const out = await splitBill(env, 'PARENT', { people: FOUR.slice(0, 2), amounts: [4000, 4000] });
  await settleBillCode(env, out.shares[0].token, { settledBy: 'stripe' });
  const second = await settleBillCode(env, out.shares[1].token, { settledBy: 'stripe' });
  assert.equal(second.parent.settled, true);
});

test('settling the same share twice does not settle the dinner twice', async () => {
  const { d, env } = realDb();
  putBill(d, { amount: '20.00' });
  const out = await splitBill(env, 'PARENT', { people: FOUR.slice(0, 2) });
  await settleBillCode(env, out.shares[0].token, { settledBy: 'stripe' });
  const repeat = await settleBillCode(env, out.shares[0].token, { settledBy: 'stripe' });
  assert.equal(repeat.already, true);
  const parent = d.prepare("SELECT settled_at FROM num_paylinks WHERE token='PARENT'").get();
  assert.equal(parent.settled_at, null, 'one share paid twice is still one share');
});

test('settling the table by hand retires the shares nobody paid', async () => {
  // Staff close the bill because somebody paid cash. Four codes are sitting in
  // four friends' phones, and every one of them is a way to pay for a dinner
  // that is already done. A paid share is never touched — it is a real charge
  // on the venue's account with a real receipt behind it.
  const { d, env } = realDb();
  putBill(d, { amount: '80.00' });
  const out = await splitBill(env, 'PARENT', { people: FOUR.slice(0, 2) });
  await settleBillCode(env, out.shares[0].token, { settledBy: 'stripe' });

  await settleBillCode(env, 'PARENT', { settledBy: 'staff' });

  const rows = d.prepare('SELECT token, state, settled_at FROM num_paylinks WHERE split_parent = ?').all('PARENT');
  const paid = rows.find((r) => r.token === out.shares[0].token);
  const unpaid = rows.find((r) => r.token === out.shares[1].token);
  assert.equal(paid.state, 'active', 'a share that was paid stays as it is');
  assert.equal(unpaid.state, 'revoked', 'a share nobody paid cannot still take money');
});

test('once the last share lands, nothing is left live on that bill', async () => {
  const { d, env } = realDb();
  putBill(d, { amount: '90.00' });
  const out = await splitBill(env, 'PARENT', { people: FOUR.slice(0, 3) });
  for (const sh of out.shares) await settleBillCode(env, sh.token, { settledBy: 'stripe' });

  const live = d.prepare(
    "SELECT COUNT(*) n FROM num_paylinks WHERE (token='PARENT' OR split_parent='PARENT') AND settled_at IS NULL AND state='active'",
  ).get();
  assert.equal(live.n, 0, 'a paid dinner leaves no payable code behind it');
});

test('two people is the floor and twelve the ceiling', async () => {
  const { d, env } = realDb();
  putBill(d, { amount: '84.00' });
  const one = await splitBill(env, 'PARENT', { people: [FOUR[0]] });
  assert.equal(one.ok, false);
  const many = await splitBill(env, 'PARENT', { people: Array.from({ length: 13 }, (_, i) => ({ member_id: `m${i}` })) });
  assert.equal(many.ok, false);
});
