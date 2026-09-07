// The policy that was never kept.
//
// num_retention_policy had twelve rows and no reader. These tests pin the
// sweep to what the table says — and to the two things it must refuse:
// executing an identifier it did not verify, and touching a row whose
// strategy it does not understand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPolicy, runRetention } from './retention.mjs';

/** A DB that knows some tables and records every statement it is asked to run. */
function fakeDb(tables) {
  const ran = [];
  const db = {
    ran,
    prepare(sql) {
      const stmt = { sql, args: [] };
      const exec = async () => {
        ran.push({ sql, args: stmt.args });
        if (/FROM sqlite_master/.test(sql)) return tables[stmt.args[0]] ? { 1: 1 } : null;
        if (/^PRAGMA table_info\((\w+)\)/.test(sql)) {
          const t = sql.match(/\((\w+)\)/)[1];
          return { results: Object.entries(tables[t] ?? {}).map(([name, type]) => ({ name, type })) };
        }
        if (/FROM num_retention_policy/.test(sql)) return { results: tables.__policies ?? [] };
        return { meta: { changes: 3 } };
      };
      return {
        bind(...a) { stmt.args = a; return this; },
        first: exec, all: exec, run: exec,
      };
    },
  };
  return db;
}

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);

test('delete uses epoch seconds for an INTEGER column and text for a TEXT column', async () => {
  const db = fakeDb({ num_messages: { created_at: 'INTEGER' }, num_web_events: { created_at: 'TEXT' } });
  const a = await applyPolicy({ DB: db }, { table_name: 'num_messages', time_column: 'created_at', strategy: 'delete', retain_days: 365 }, { now: NOW });
  assert.equal(a.rows, 3);
  assert.equal(typeof a.cutoff, 'number');
  assert.equal(a.cutoff, Math.floor((NOW - 365 * 86400 * 1000) / 1000));
  const b = await applyPolicy({ DB: db }, { table_name: 'num_web_events', time_column: 'created_at', strategy: 'delete', retain_days: 90 }, { now: NOW });
  assert.match(String(b.cutoff), /^2026-06-06 12:00:00$/, 'a TEXT time column must get a comparable datetime string');
  const del = db.ran.filter((r) => /^DELETE FROM num_messages WHERE created_at < \?1$/.test(r.sql));
  assert.equal(del.length, 1, 'exactly one DELETE, parameterised');
});

test('anonymise nulls the subject and keeps the row', async () => {
  const db = fakeDb({ num_bookings: { created_at: 'INTEGER', member_ref: 'TEXT', amount: 'INTEGER' } });
  const r = await applyPolicy({ DB: db }, { table_name: 'num_bookings', time_column: 'created_at', subject_column: 'member_ref', strategy: 'anonymise', retain_days: 2555 }, { now: NOW });
  assert.equal(r.rows, 3);
  assert.ok(db.ran.some((x) => /^UPDATE num_bookings SET member_ref = NULL WHERE created_at < \?1 AND member_ref IS NOT NULL$/.test(x.sql)));
  assert.ok(!db.ran.some((x) => /^DELETE FROM num_bookings/.test(x.sql)), 'a financial record was deleted');
});

test('archive has nowhere to go yet and says so instead of deleting', async () => {
  const db = fakeDb({ num_wallet_txns: { created_at: 'INTEGER' } });
  const r = await applyPolicy({ DB: db }, { table_name: 'num_wallet_txns', time_column: 'created_at', strategy: 'archive', retain_days: 2555 }, { now: NOW });
  assert.match(r.skipped, /no archive destination/);
  assert.ok(!db.ran.some((x) => /^(DELETE|UPDATE) /.test(x.sql)));
});

test('a policy row is data, not code: unverified identifiers never reach SQL', async () => {
  const db = fakeDb({ num_messages: { created_at: 'INTEGER' } });
  const bad = [
    { table_name: 'num_messages; DROP TABLE num_members', time_column: 'created_at', strategy: 'delete', retain_days: 1 },
    { table_name: 'num_messages', time_column: 'created_at OR 1=1', strategy: 'delete', retain_days: 1 },
    { table_name: 'num_ghosts', time_column: 'created_at', strategy: 'delete', retain_days: 1 },
    { table_name: 'num_messages', time_column: 'nope', strategy: 'delete', retain_days: 1 },
    { table_name: 'num_messages', time_column: 'created_at', strategy: 'shred', retain_days: 1 },
    { table_name: 'num_messages', time_column: 'created_at', strategy: 'delete', retain_days: 0 },
  ];
  for (const p of bad) {
    const r = await applyPolicy({ DB: db }, p, { now: NOW });
    assert.ok(r.skipped, `${JSON.stringify(p)} was not refused`);
  }
  assert.ok(!db.ran.some((x) => /DROP|OR 1=1|num_ghosts|nope/.test(x.sql)), 'an unverified identifier was interpolated');
  assert.ok(!db.ran.some((x) => /^(DELETE|UPDATE) /.test(x.sql)), 'something was executed');
});

test('the sweep records what it did on the policy row and drains the queues', async () => {
  const db = fakeDb({
    num_messages: { created_at: 'INTEGER', purge_after: 'INTEGER' },
    num_answer_cache: { expires_at: 'INTEGER' },
    __policies: [
      { table_name: 'num_messages', time_column: 'created_at', strategy: 'delete', retain_days: 365, active: 1 },
      { table_name: 'num_ghosts', time_column: 'created_at', strategy: 'delete', retain_days: 1, active: 1 },
    ],
  });
  const report = await runRetention({ DB: db }, { now: NOW });
  assert.equal(report.policies.length, 2);
  assert.equal(report.policies[0].rows, 3);
  assert.ok(report.policies[1].skipped, 'one bad row must not stop the sweep');
  assert.ok(db.ran.some((x) => /^UPDATE num_retention_policy SET last_purged_at/.test(x.sql)), 'last_purged_at was never written — the policy still reads as unenforced');
  assert.equal(report.queues.messages_purged, 3);
  assert.equal(report.queues.answer_cache_expired, 3);
});
