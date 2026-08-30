// The bill code. Two things must never happen: a merchant billed twice for
// one bill, and a bill code pointed at money that is not the venue's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, mintBillCode, settleBillCode } from './billqr.mjs';

/** D1 stand-in holding num_paylinks rows and recording commission settles. */
function db({ paylinks = [] } = {}) {
  const settles = [];
  const DB = {
    prepare(q) {
      let a = [];
      const stmt = {
        bind: (...args) => { a = args; return stmt; },
        first: async () => {
          if (/FROM num_paylinks\s+WHERE business_id/.test(q)) {
            return paylinks.find((p) => p.business_id === a[0] && p.state === 'active' && !p.one_time) ?? null;
          }
          if (/FROM num_paylinks WHERE token/.test(q)) {
            return paylinks.find((p) => p.token === a[0]) ?? null;
          }
          if (/FROM num_commissions/.test(q)) {
            return { id: 'cm_x', rate_bp: 1000, booking_id: a[0] };
          }
          return null;
        },
        run: async () => {
          if (/INSERT INTO num_paylinks/.test(q)) {
            // Positional, so it MUST track the INSERT in billqr.mjs. When a
            // column was added ahead of `amount`, every field after it shifted
            // and the fake reported null where the code was correct — the
            // failure looked like a bug in the worker. Kept in step here; new
            // tests use realDb() below instead, which cannot drift.
            paylinks.push({
              token: a[0], business_id: a[1], label: a[2], kind: a[3], target: a[4],
              promptpay_kind: a[5], crypto_asset: a[6], amount_mode: 'fixed', amount: a[7],
              currency: a[8], state: 'active', created_at: a[9], booking_id: a[10],
              one_time: 1, resource_id: a[11], issued_by: a[12],
              crypto_base_units: a[13], crypto_quote: a[14], settled_at: null,
            });
            return { meta: { changes: 1 } };
          }
          if (/UPDATE num_paylinks SET settled_at/.test(q)) {
            const row = paylinks.find((p) => p.token === a[0] && p.settled_at == null);
            if (!row) return { meta: { changes: 0 } };
            row.settled_at = a[1];
            return { meta: { changes: 1 } };
          }
          if (/UPDATE num_commissions/.test(q)) {
            settles.push({ id: a[0], basis_cs: a[1] });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
    batch: async () => [],
  };
  return { DB, paylinks, settles };
}

const TABLE_CODE = {
  token: 'TBL1', business_id: 'biz1', kind: 'promptpay', target: '0812345678',
  promptpay_kind: 'phone', amount_mode: 'open', amount: null, currency: 'THB',
  state: 'active', one_time: 0, settled_at: null, booking_id: null,
};

test('an amount is parsed strictly or refused', () => {
  assert.deepEqual(parseAmount('2400'), { ok: true, minor: 240000, display: '2400.00' });
  assert.deepEqual(parseAmount('2,400.50'), { ok: true, minor: 240050, display: '2400.50' });
  // A mistyped bill is the number a guest is asked to pay. Refuse, never coerce.
  for (const bad of ['2,4OO', '', '  ', '-50', '0', 'abc', '12.345', null, undefined]) {
    assert.equal(parseAmount(bad).ok, false, `should have refused: ${JSON.stringify(bad)}`);
  }
  assert.equal(parseAmount('99999999').ok, false, 'above the per-bill ceiling');
});

test('a bill code inherits the venue own payment target, never a supplied one', async () => {
  const d = db({ paylinks: [{ ...TABLE_CODE }] });
  const out = await mintBillCode({ DB: d.DB, SITE: 'https://itsnum.com' }, {
    businessId: 'biz1', bookingId: 'bk1', amount: '2400',
  });
  assert.equal(out.ok, true);
  const minted = d.paylinks.find((p) => p.one_time === 1);
  assert.equal(minted.target, '0812345678', 'the bill code must pay the venue, not anywhere else');
  assert.equal(minted.amount_mode, 'fixed');
  assert.equal(minted.amount, '2400.00');
  assert.equal(minted.booking_id, 'bk1');
  assert.match(out.url, /^https:\/\/itsnum\.com\/p\/[A-Z0-9]+$/);
});

test('no existing code means no bill code — we never invent a destination', async () => {
  const d = db({ paylinks: [] });
  const out = await mintBillCode({ DB: d.DB }, { businessId: 'biz1', amount: '500' });
  assert.equal(out.ok, false);
  assert.match(out.reason, /no active payment code/);
  assert.equal(d.paylinks.length, 0);
});

test('a bad amount mints nothing', async () => {
  const d = db({ paylinks: [{ ...TABLE_CODE }] });
  const out = await mintBillCode({ DB: d.DB }, { businessId: 'biz1', amount: 'lots' });
  assert.equal(out.ok, false);
  assert.equal(d.paylinks.length, 1, 'only the original table code should exist');
});

test('settling a bill bills the booking exactly once', async () => {
  const d = db({ paylinks: [{ ...TABLE_CODE }] });
  const env = { DB: d.DB };
  const mint = await mintBillCode(env, { businessId: 'biz1', bookingId: 'bk9', amount: '2400' });

  const first = await settleBillCode(env, mint.token);
  assert.equal(first.settled, true);
  assert.equal(first.billed, true);
  assert.equal(d.settles.length, 1, 'one settle for one bill');
  assert.equal(d.settles[0].basis_cs, 240000);

  // Guest scans twice, network retries, staff taps paid again — none may bill again.
  const second = await settleBillCode(env, mint.token);
  assert.equal(second.already, true);
  assert.equal(d.settles.length, 1, 'the merchant was billed twice for one bill');
});

test('an open table code can never be settled', async () => {
  const d = db({ paylinks: [{ ...TABLE_CODE }] });
  const out = await settleBillCode({ DB: d.DB }, 'TBL1');
  assert.equal(out.ok, false);
  assert.match(out.reason, /no amount to report/);
  assert.equal(d.settles.length, 0, 'settling an open code would report a null bill');
});

test('a bill code with no booking settles but bills nothing', async () => {
  // Founder decision: NUM-referred walk-ins are never charged.
  const d = db({ paylinks: [{ ...TABLE_CODE }] });
  const env = { DB: d.DB };
  const mint = await mintBillCode(env, { businessId: 'biz1', amount: '900' });
  const out = await settleBillCode(env, mint.token);
  assert.equal(out.settled, true);
  assert.equal(out.billed, false);
  assert.equal(d.settles.length, 0);
});

test('unknown and revoked codes are refused', async () => {
  const d = db({ paylinks: [{ ...TABLE_CODE, token: 'DEAD', state: 'revoked', amount_mode: 'fixed', amount: '100.00' }] });
  assert.equal((await settleBillCode({ DB: d.DB }, 'NOPE')).ok, false);
  assert.equal((await settleBillCode({ DB: d.DB }, 'DEAD')).ok, false);
});

/* ── the hole where a paid bill earned nothing ───────────────────────────── */

import { DatabaseSync } from 'node:sqlite';
import { _resetSchemaCache } from './commission.mjs';

/** A real SQLite database, because this test is about what the ledger records. */
function realDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, status TEXT);
    CREATE TABLE num_business_profiles (business_id TEXT PRIMARY KEY, country TEXT);
    CREATE TABLE num_business_settings (business_id TEXT PRIMARY KEY, commission_bp INTEGER,
      booking_fee_cs INTEGER, delivery_fee_cs INTEGER);
    CREATE TABLE num_resources (id TEXT PRIMARY KEY, business_id TEXT, name TEXT);
    CREATE TABLE num_paylinks (token TEXT PRIMARY KEY, business_id TEXT, label TEXT, kind TEXT,
      target TEXT, promptpay_kind TEXT, amount_mode TEXT, amount TEXT, currency TEXT,
      state TEXT, created_at TEXT, booking_id TEXT, settled_at TEXT, one_time INTEGER DEFAULT 0,
      resource_id TEXT, issued_by TEXT, settled_by TEXT, zone_type TEXT, revoked_at TEXT, revoked_by TEXT,
      crypto_asset TEXT, crypto_base_units TEXT, crypto_quote TEXT);
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
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
  return { d, env: { DB } };
}

test('a paid bill still earns when the booking never accrued upstream', async () => {
  // The hole this closes: a real guest NUM sent, a real bill they paid, and
  // nothing owed — because the confirm-time accrual was missing. Silent, and
  // it is exactly what production looked like: num_commissions had never
  // been created at all.
  const { d, env } = realDb();
  _resetSchemaCache();
  d.prepare("INSERT INTO businesses (id,name,status) VALUES ('b1','Bang Tao','active')").run();
  d.prepare("INSERT INTO num_business_profiles (business_id,country) VALUES ('b1','TH')").run();
  d.prepare("INSERT INTO num_business_settings (business_id,commission_bp) VALUES ('b1',1000)").run();
  d.prepare(`INSERT INTO num_paylinks
    (token,business_id,label,kind,target,promptpay_kind,amount_mode,currency,state,created_at,one_time)
    VALUES ('HOUSE','b1','House','promptpay','0812345678','msisdn','open','THB','active','2026-08-01',0)`).run();

  const bill = await mintBillCode(env, { businessId: 'b1', bookingId: 'bk_never_accrued', amount: '2400' });
  assert.equal(bill.ok, true);

  const out = await settleBillCode(env, bill.token);
  assert.equal(out.settled, true);
  assert.equal(out.billed, true, 'the fee must survive a missing upstream accrual');

  const line = d.prepare(
    'SELECT amount_cs, basis_cs, state, source FROM num_commissions WHERE booking_id=?')
    .get('bk_never_accrued');
  assert.equal(line.basis_cs, 240000, 'the basis is the bill the guest actually paid');
  assert.equal(line.amount_cs, 24000, '10% of it');
  assert.equal(line.state, 'accrued');
});

test('settling twice still only ever creates one ledger line', async () => {
  const { d, env } = realDb();
  _resetSchemaCache();
  d.prepare("INSERT INTO businesses (id,name,status) VALUES ('b1','Bang Tao','active')").run();
  d.prepare("INSERT INTO num_business_settings (business_id,commission_bp) VALUES ('b1',1000)").run();
  d.prepare(`INSERT INTO num_paylinks
    (token,business_id,label,kind,target,promptpay_kind,amount_mode,currency,state,created_at,one_time)
    VALUES ('HOUSE','b1','House','promptpay','0812345678','msisdn','open','THB','active','2026-08-01',0)`).run();

  const bill = await mintBillCode(env, { businessId: 'b1', bookingId: 'bk_twice', amount: '1000' });
  await settleBillCode(env, bill.token);
  await settleBillCode(env, bill.token);

  const n = d.prepare("SELECT COUNT(*) AS n FROM num_commissions WHERE booking_id='bk_twice'").get();
  assert.equal(n.n, 1, 'billing a merchant twice for one table is how you lose them');
});

/* ── crypto bills ────────────────────────────────────────────────────────── */

test('a crypto bill is quoted in the token at mint time and stamped on the code', async () => {
  const { d, env } = realDb();
  _resetSchemaCache();
  env.NUM_FX_THB_USD = '32.68';
  d.prepare("INSERT INTO businesses (id,name,status) VALUES ('b1','Bang Tao','active')").run();
  d.prepare(`INSERT INTO num_paylinks
    (token,business_id,label,kind,target,crypto_asset,amount_mode,currency,state,created_at,one_time)
    VALUES ('WALLET','b1','House','crypto','0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
            'usdc-base','open','THB','active','2026-08-01',0)`).run();

  const bill = await mintBillCode(env, { businessId: 'b1', amount: '2400' });
  assert.equal(bill.ok, true);
  assert.equal(bill.crypto.display, '73.44', '2,400 THB at 32.68');
  assert.equal(bill.crypto.base_units, '73440000');

  const row = d.prepare('SELECT kind,target,crypto_asset,crypto_base_units,crypto_quote,amount FROM num_paylinks WHERE token=?')
    .get(bill.token);
  assert.equal(row.kind, 'crypto');
  assert.equal(row.target, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'the address is inherited');
  assert.equal(row.crypto_base_units, '73440000',
    'quoting at render time would move the amount under the guest');
  assert.equal(row.amount, '2400.00', 'the bill itself stays in baht — that is what we take 10% of');
  assert.match(row.crypto_quote, /"rate":32.68/);
});

test('no exchange rate means no crypto bill, rather than a guessed one', async () => {
  const { d, env } = realDb();
  _resetSchemaCache();
  d.prepare("INSERT INTO businesses (id,name,status) VALUES ('b1','Bang Tao','active')").run();
  d.prepare(`INSERT INTO num_paylinks
    (token,business_id,label,kind,target,crypto_asset,amount_mode,currency,state,created_at,one_time)
    VALUES ('WALLET','b1','House','crypto','0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
            'usdc-base','open','THB','active','2026-08-01',0)`).run();

  const bill = await mintBillCode(env, { businessId: 'b1', amount: '2400' });
  assert.equal(bill.ok, false);
  assert.match(bill.reason, /NUM_FX_THB_USD/);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM num_paylinks WHERE one_time=1").get().n, 0,
    'nothing is written when we cannot state the amount');
});

test('the 10% is still taken on the baht bill, not on the token amount', async () => {
  const { d, env } = realDb();
  _resetSchemaCache();
  env.NUM_FX_THB_USD = '32.68';
  d.prepare("INSERT INTO businesses (id,name,status) VALUES ('b1','Bang Tao','active')").run();
  d.prepare("INSERT INTO num_business_settings (business_id,commission_bp) VALUES ('b1',1000)").run();
  d.prepare(`INSERT INTO num_paylinks
    (token,business_id,label,kind,target,crypto_asset,amount_mode,currency,state,created_at,one_time)
    VALUES ('WALLET','b1','House','crypto','0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
            'usdc-base','open','THB','active','2026-08-01',0)`).run();

  const bill = await mintBillCode(env, { businessId: 'b1', bookingId: 'bk_crypto', amount: '2400' });
  await settleBillCode(env, bill.token);
  const line = d.prepare('SELECT basis_cs, amount_cs FROM num_commissions WHERE booking_id=?').get('bk_crypto');
  assert.equal(line.basis_cs, 240000);
  assert.equal(line.amount_cs, 24000, 'the fee follows the bill, not the exchange rate');
});
