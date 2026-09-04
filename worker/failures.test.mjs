// THE LEDGER THAT CANNOT BE SILENCED BY THE THING IT REPORTS.
//
// 3 Sep 2026: the watchman had been reporting four real failures for a month
// and nobody could see any of them, because its delivery channel was the
// broken thing — 81 dead rows, every one line_404. An alerting system that
// only pushes has a single point of failure at exactly the moment it matters,
// and the failure is invisible by construction: the way you would find out is
// the thing that broke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { record, resolve, told, open, summary } from './failures.mjs';

/** Minimal D1 shim over node:sqlite — same shape the other worker tests use. */
function d1(db) {
  return {
    prepare(sql) {
      const st = { sql, args: [] };
      st.bind = (...a) => { st.args = a; return st; };
      const params = () => st.args.map((v) => (v === undefined ? null : v));
      const named = () => {
        // ?1-style params → positional, in order of first appearance.
        const idx = [...st.sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
        if (!idx.length) return params();
        const max = Math.max(...idx);
        const out = [];
        for (let i = 1; i <= max; i++) out.push(st.args[i - 1] ?? null);
        return out;
      };
      st.run = async () => {
        const s = db.prepare(st.sql.replace(/\?(\d+)/g, '?'));
        const r = s.run(...reorder(st.sql, st.args));
        return { meta: { changes: r.changes } };
      };
      st.first = async () => {
        const s = db.prepare(st.sql.replace(/\?(\d+)/g, '?'));
        return s.get(...reorder(st.sql, st.args)) ?? null;
      };
      st.all = async () => {
        const s = db.prepare(st.sql.replace(/\?(\d+)/g, '?'));
        return { results: s.all(...reorder(st.sql, st.args)) };
      };
      return st;
    },
  };
}
/** ?1 ?2 ?1 → the same arg repeated, in the order the SQL uses them. */
function reorder(sql, args) {
  const idx = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  if (!idx.length) return args;
  return idx.map((i) => (args[i - 1] === undefined ? null : args[i - 1]));
}

const fresh = () => ({ DB: d1(new DatabaseSync(':memory:')) });

test('a failure is written down before anybody is told', async () => {
  const env = fresh();
  const row = await record(env, { kind: 'line_dead', subject: 'ops.alert', detail: 'line_404' });
  assert.ok(row, 'nothing was recorded');
  assert.equal(row.kind, 'line_dead');
  assert.equal(row.seen, 1);
  assert.equal(row.told, 0, 'a failure starts untold — that is the whole point');
});

test('the same problem 81 times is one row, not 81', async () => {
  // 81 identical rows is not 81 problems. It is one problem and 81 reminders,
  // and it buries the other three the watchman was also reporting.
  const env = fresh();
  for (let i = 0; i < 81; i++) {
    await record(env, { kind: 'line_dead', subject: 'ops.alert', detail: 'line_404: {}' });
  }
  const rows = await open(env);
  assert.equal(rows.length, 1, 'the ledger is as noisy as the thing it replaced');
  assert.equal(rows[0].seen, 81, 'what repeats should get louder, not longer');
});

test('a problem that comes back worse never quietly downgrades', async () => {
  const env = fresh();
  await record(env, { kind: 'mail', subject: 'x', severity: 'critical' });
  await record(env, { kind: 'mail', subject: 'x', severity: 'low' });
  const [row] = await open(env);
  assert.equal(row.severity, 'critical');
});

test('resolving closes it, and it reopens untold if it comes back', async () => {
  const env = fresh();
  await record(env, { kind: 'mail', subject: 'x' });
  await told(env, 'mail', 'x', 'sms');
  assert.equal((await open(env))[0].told, 1);
  assert.equal(await resolve(env, 'mail', 'x'), true);
  assert.equal((await open(env)).length, 0);

  await record(env, { kind: 'mail', subject: 'x' });
  const back = (await open(env))[0];
  assert.ok(back, 'a returning failure stayed closed');
  assert.equal(back.told, 0, 'it came back and nobody needs telling again — that is how a month passes');
});

test('worst and oldest first', async () => {
  const env = fresh();
  await record(env, { kind: 'a', subject: '1', severity: 'low' });
  await record(env, { kind: 'b', subject: '2', severity: 'critical' });
  await record(env, { kind: 'c', subject: '3', severity: 'high' });
  const rows = await open(env);
  assert.deepEqual(rows.map((r) => r.severity), ['critical', 'high', 'low']);
});

test('blind is the state that matters, and grace stops it crying wolf', async () => {
  const env = fresh();
  await record(env, { kind: 'mail', subject: 'x', severity: 'high' });
  let s = await summary(env);
  assert.equal(s.blind, false, 'a failure seconds old should not page — it may be resolving itself');

  // Age it past the ten-minute grace.
  await env.DB.prepare('UPDATE num_failures SET first_seen = first_seen - 900').bind().run();
  s = await summary(env);
  assert.equal(s.blind, true, 'a settled failure nobody was told about is not visible anywhere');

  await told(env, 'mail', 'x', 'sms');
  s = await summary(env);
  assert.equal(s.blind, false, 'somebody was told — that is work in progress, not blindness');
});

test('a low-severity failure alone is never "blind"', async () => {
  const env = fresh();
  await record(env, { kind: 'nit', subject: 'x', severity: 'low' });
  await env.DB.prepare('UPDATE num_failures SET first_seen = first_seen - 900').bind().run();
  assert.equal((await summary(env)).blind, false);
});

test('no database is not a crash', async () => {
  assert.equal(await record({}, { kind: 'x' }), null);
  assert.deepEqual(await open({}), []);
  assert.equal(await resolve({}, 'x'), false);
});

// ── the wiring ───────────────────────────────────────────────────────────
const health = readFileSync(new URL('./health.mjs', import.meta.url), 'utf8');

test('an alert that nothing carried is recorded as critical', () => {
  assert.match(health, /kind: 'alert_undelivered'/,
    'a failed alert is a console.warn again — which is a log line with extra steps');
  assert.match(health, /severity: 'critical'/);
  assert.match(health, /let carried = null/,
    'the fire-and-forget catches made trying and succeeding indistinguishable again');
});

test('the health verdict goes DOWN when nobody could be told', () => {
  assert.match(health, /const DOWN = \['d1_write', 'brain', 'site_public', 'failures'\]/,
    'an unreported failure no longer pages — which is the exact month-long silence this fixes');
  assert.match(health, /failures: await checkFailures\(env\)/);
});

test('the alert is written down before it is sent, not after', () => {
  const fn = health.slice(health.indexOf('export async function alert'), health.indexOf('export async function handleHealth'));
  assert.ok(fn.indexOf('await record(env,') < fn.indexOf('ALERT_WEBHOOK'),
    'the ledger write happens after a channel attempt — if the worker dies mid-alert the failure vanishes');
});
