/**
 * qrcheck — each test plants one specific kind of rot and asserts the checker
 * finds it. A checker that passes on a healthy database proves nothing; what
 * matters is that it fails on a sick one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { checkQrs } from './qrcheck.mjs';

const NOW = new Date().toISOString();
const OLD = new Date(Date.now() - 48 * 3600_000).toISOString();

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active');
    CREATE TABLE num_resources (id TEXT PRIMARY KEY, business_id TEXT, name TEXT,
      active INTEGER DEFAULT 1);
    CREATE TABLE num_paylinks (token TEXT PRIMARY KEY, business_id TEXT, label TEXT, kind TEXT,
      target TEXT, promptpay_kind TEXT, crypto_asset TEXT, crypto_base_units TEXT,
      amount_mode TEXT, amount TEXT, currency TEXT, state TEXT, one_time INTEGER DEFAULT 0,
      resource_id TEXT, booking_id TEXT, settled_at TEXT, created_at TEXT);
    CREATE TABLE num_venue_codes (token TEXT PRIMARY KEY, business_id TEXT, resource_id TEXT,
      state TEXT DEFAULT 'active');
    CREATE TABLE num_commissions (id TEXT PRIMARY KEY, booking_id TEXT, state TEXT, amount_cs INTEGER);
  `);
  const DB = {
    prepare(sql) {
      const bound = [];
      const api = {
        bind(...a) { bound.push(...a); return api; },
        async first() { try { return d.prepare(sql).get(...bound) ?? null; } catch { return null; } },
        async all() { try { return { results: d.prepare(sql).all(...bound) }; } catch { return { results: [] }; } },
        async run() { const r = d.prepare(sql).run(...bound); return { meta: { changes: Number(r.changes) } }; },
      };
      return api;
    },
  };
  return { d, env: { DB } };
}

/** A venue with one table, one sticker and one check-in code. Healthy. */
function healthy(d) {
  d.prepare("INSERT INTO businesses (id,name,status) VALUES ('b1','Bang Tao','active')").run();
  d.prepare("INSERT INTO num_resources (id,business_id,name,active) VALUES ('r1','b1','Table 1',1)").run();
  d.prepare(`INSERT INTO num_paylinks (token,business_id,label,kind,target,promptpay_kind,
    amount_mode,currency,state,one_time,resource_id,created_at)
    VALUES ('STK1','b1','Table 1','promptpay','0812345678','phone','open','THB','active',0,'r1',?)`)
    .run(NOW);
  d.prepare("INSERT INTO num_venue_codes (token,business_id,resource_id,state) VALUES ('CHK1','b1','r1','active')").run();
}

const kinds = (r) => r.findings.map((f) => f.kind);

test('a healthy venue produces nothing critical', async () => {
  const { d, env } = db();
  healthy(d);
  const r = await checkQrs(env);
  assert.equal(r.ok, true);
  assert.equal(r.counts.critical, 0);
  assert.equal(r.checked.paylinks, 1);
  assert.equal(r.checked.active_tables, 1);
});

test('a code whose venue was deleted is critical', async () => {
  const { d, env } = db();
  healthy(d);
  d.prepare("DELETE FROM businesses WHERE id='b1'").run();
  const r = await checkQrs(env);
  assert.equal(r.ok, false);
  assert.ok(kinds(r).includes('orphan_code'));
  assert.ok(kinds(r).includes('orphan_checkin'));
});

test('a code attached to another venue’s table is critical', async () => {
  const { d, env } = db();
  healthy(d);
  d.prepare("INSERT INTO businesses (id,name) VALUES ('b2','Elsewhere')").run();
  d.prepare("INSERT INTO num_resources (id,business_id,name,active) VALUES ('r2','b2','Their table',1)").run();
  d.prepare("UPDATE num_paylinks SET resource_id='r2' WHERE token='STK1'").run();
  const r = await checkQrs(env);
  assert.equal(r.ok, false);
  assert.ok(kinds(r).includes('cross_venue'));
});

test('a payment code with no destination is critical', async () => {
  const { d, env } = db();
  healthy(d);
  d.prepare("UPDATE num_paylinks SET target='' WHERE token='STK1'").run();
  const r = await checkQrs(env);
  assert.ok(kinds(r).includes('no_target'));
});

test('a bill code with an open amount can never report what was paid', async () => {
  const { d, env } = db();
  healthy(d);
  d.prepare(`INSERT INTO num_paylinks (token,business_id,kind,target,amount_mode,currency,state,one_time,created_at)
    VALUES ('BAD','b1','promptpay','0812345678','open','THB','active',1,?)`).run(NOW);
  const r = await checkQrs(env);
  assert.equal(r.ok, false);
  assert.ok(kinds(r).includes('bill_without_amount'));
});

test('a permanent code with a fixed amount is flagged', async () => {
  const { d, env } = db();
  healthy(d);
  d.prepare("UPDATE num_paylinks SET amount_mode='fixed', amount='500.00' WHERE token='STK1'").run();
  const r = await checkQrs(env);
  assert.ok(kinds(r).includes('reusable_fixed'),
    'every guest at that table would be asked for the same figure');
});

test('a crypto code missing its asset or quote is critical', async () => {
  const { d, env } = db();
  healthy(d);
  d.prepare(`INSERT INTO num_paylinks (token,business_id,kind,target,amount_mode,amount,currency,state,one_time,created_at)
    VALUES ('C1','b1','crypto','0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed','fixed','2400.00','THB','active',1,?)`)
    .run(NOW);
  const r = await checkQrs(env);
  assert.ok(kinds(r).includes('crypto_no_asset'));
  assert.ok(kinds(r).includes('crypto_no_quote'));
});

test('two live stickers on one table is a warning', async () => {
  const { d, env } = db();
  healthy(d);
  d.prepare(`INSERT INTO num_paylinks (token,business_id,kind,target,amount_mode,currency,state,one_time,resource_id,created_at)
    VALUES ('STK2','b1','promptpay','0812345678','open','THB','active',0,'r1',?)`).run(NOW);
  const r = await checkQrs(env);
  assert.ok(kinds(r).includes('duplicate_sticker'),
    'a guest may scan a code the venue thinks is retired');
});

test('a table with no sticker is reported as information, not a fault', async () => {
  const { d, env } = db();
  d.prepare("INSERT INTO businesses (id,name) VALUES ('b1','Bang Tao')").run();
  d.prepare("INSERT INTO num_resources (id,business_id,name,active) VALUES ('r1','b1','Table 1',1)").run();
  const r = await checkQrs(env);
  assert.equal(r.ok, true, 'a venue that has not set up payment yet is not broken');
  assert.ok(kinds(r).includes('table_unprinted'));
});

test('a bill that was paid but never billed is critical', async () => {
  const { d, env } = db();
  healthy(d);
  d.prepare(`INSERT INTO num_paylinks (token,business_id,kind,target,amount_mode,amount,currency,
    state,one_time,booking_id,settled_at,created_at)
    VALUES ('P1','b1','promptpay','0812345678','fixed','2400.00','THB','active',1,'bk1',?,?)`)
    .run(NOW, NOW);
  const r = await checkQrs(env);
  assert.equal(r.ok, false);
  assert.ok(kinds(r).includes('paid_but_unbilled'));
  assert.match(r.findings.find((f) => f.kind === 'paid_but_unbilled').detail, /that fee is lost/);
});

test('a settled bill whose ledger line never got its value is a warning', async () => {
  const { d, env } = db();
  healthy(d);
  d.prepare(`INSERT INTO num_paylinks (token,business_id,kind,target,amount_mode,amount,currency,
    state,one_time,booking_id,settled_at,created_at)
    VALUES ('P1','b1','promptpay','0812345678','fixed','2400.00','THB','active',1,'bk1',?,?)`)
    .run(NOW, NOW);
  d.prepare("INSERT INTO num_commissions (id,booking_id,state,amount_cs) VALUES ('c1','bk1','awaiting_value',NULL)").run();
  const r = await checkQrs(env);
  assert.equal(r.ok, true, 'recoverable — the agent reconciles it');
  assert.ok(kinds(r).includes('ledger_awaiting'));
});

test('a bill left open for two days means the agent is not expiring them', async () => {
  const { d, env } = db();
  healthy(d);
  d.prepare(`INSERT INTO num_paylinks (token,business_id,kind,target,amount_mode,amount,currency,
    state,one_time,created_at) VALUES ('OLD','b1','promptpay','0812345678','fixed','900.00','THB','active',1,?)`)
    .run(OLD);
  const r = await checkQrs(env);
  assert.ok(kinds(r).includes('stale_bill'));
});

test('findings are ordered worst first', async () => {
  const { d, env } = db();
  healthy(d);
  d.prepare("UPDATE num_paylinks SET target='' WHERE token='STK1'").run();
  d.prepare("INSERT INTO num_resources (id,business_id,name,active) VALUES ('r9','b1','Table 9',1)").run();
  const r = await checkQrs(env);
  assert.equal(r.findings[0].severity, 'critical');
  assert.equal(r.findings[r.findings.length - 1].severity, 'info');
});

test('a check can be scoped to one venue', async () => {
  const { d, env } = db();
  healthy(d);
  d.prepare("INSERT INTO businesses (id,name) VALUES ('b2','Elsewhere')").run();
  d.prepare(`INSERT INTO num_paylinks (token,business_id,kind,target,amount_mode,currency,state,one_time,created_at)
    VALUES ('X','b2','promptpay','','open','THB','active',0,?)`).run(NOW);

  const all = await checkQrs(env);
  assert.equal(all.ok, false);
  const mine = await checkQrs(env, { businessId: 'b1' });
  assert.equal(mine.ok, true, 'another venue’s rot is not this venue’s problem');
});
