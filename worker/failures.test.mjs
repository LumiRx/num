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
import { record, resolve, told, open, summary, resolveClearedAlerts, alertAbout } from './failures.mjs';

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

/**
 * Push a row's first_seen back past the ten-minute grace.
 *
 * `blind` deliberately ignores anything recorded in the last ten minutes — a
 * failure seconds old may be resolving itself, and a monitor that fires on
 * every transient is one people learn to close. So a test about blindness
 * has to be about a row that has actually sat there.
 */
const age = async (env, seconds = 3600) => {
  await env.DB.prepare('UPDATE num_failures SET first_seen = first_seen - ?1').bind(seconds).run();
};

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
  // Asserted by membership rather than as an exact literal. The list is meant
  // to grow — 'sms' joined it on 20 Sep 2026 — and a test that pins the whole
  // array fails on every addition, which teaches the next person to edit the
  // test instead of thinking about the list.
  const DOWN = health.match(/const DOWN = \[([^\]]*)\]/);
  assert.ok(DOWN, 'the DOWN list must still exist');
  assert.match(DOWN[1], /'failures'/,
    'an unreported failure no longer pages — which is the exact month-long silence this fixes');
  for (const must of ["'d1_write'", "'brain'", "'site_public'"]) {
    assert.ok(DOWN[1].includes(must), `${must} must still take the verdict down`);
  }
  assert.match(health, /failures: await checkFailures\(env\)/);
});

test('sign-in being dead takes the verdict down', () => {
  // 20 Sep 2026: /api/health reported `sms: ok` for nine hours while 71
  // consecutive verification codes failed and nobody could open an account.
  // The check validated configuration, which was perfect, and never asked
  // whether a text had gone out.
  const DOWN = health.match(/const DOWN = \[([^\]]*)\]/);
  assert.match(DOWN[1], /'sms'/, 'a locked front door is not a degradation');
  assert.match(health, /sms: await checkSms\(env\)/,
    'checkSms must be awaited, or the check object holds a Promise and every verdict is meaningless');
  assert.match(health, /num_signin_events/,
    'checkSms must read real send outcomes, not just configuration');
});

test('the alert is written down before it is sent, not after', () => {
  const fn = health.slice(health.indexOf('export async function alert'), health.indexOf('export async function handleHealth'));
  assert.ok(fn.indexOf('await record(env,') < fn.indexOf('ALERT_WEBHOOK'),
    'the ledger write happens after a channel attempt — if the worker dies mid-alert the failure vanishes');
});

/* ── THE THIRTY-HOUR FALSE DOWN (20 Sep 2026) ────────────────────────────
 *
 * Live state at 21:10 on 20 Sep: site 200, D1 writing, brain answering,
 * storage at 12% of cap, zero actionable failures — and verdict `down`,
 * continuously, since the previous afternoon. One row was doing it:
 *
 *   kind: alert · high · told: 0 · told_via: sms
 *   "🔴 NUM IS DOWN — d1_write"                 first seen 19 Sep 16:21
 *
 * D1 recovered that evening. The row could not, because it is a record of a
 * text that failed to send, and nothing ever closed one. A real outage in
 * those thirty hours would have looked exactly like the thirty hours.
 */

test('an alert about a check that is passing again is closed', async () => {
  const env = fresh();
  await record(env, {
    kind: 'alert', subject: '🔴 NUM IS DOWN — d1_write\n\n• d1_write: writes are failing',
    detail: 'x', severity: 'high',
  });
  await age(env);
  assert.equal((await summary(env)).blind, true, 'an undelivered alert must blind — that part is right');

  const closed = await resolveClearedAlerts(env, { d1_write: { ok: true }, brain: { ok: true } });
  assert.equal(closed, 1);
  assert.equal((await open(env)).length, 0, 'the row survived the thing it was about');
});

test('an alert about a check that is STILL failing stays open and still blinds', async () => {
  const env = fresh();
  await record(env, { kind: 'alert', subject: '🔴 NUM IS DOWN — brain', detail: 'x', severity: 'high' });
  await age(env);
  assert.equal(await resolveClearedAlerts(env, { brain: { ok: false } }), 0);
  assert.equal((await summary(env)).blind, true);
});

test('all of the named checks, not just one of them', async () => {
  const env = fresh();
  await record(env, { kind: 'alert', subject: '🟠 Num is degraded — sms, push', detail: 'x', severity: 'high' });
  assert.equal(await resolveClearedAlerts(env, { sms: { ok: true }, push: { ok: false } }), 0,
    'half-better closed the alert');
  assert.equal(await resolveClearedAlerts(env, { sms: { ok: true }, push: { ok: true } }), 1);
});

test('the ledger is never asked to prove itself innocent', async () => {
  // "NUM IS DOWN — failures" names the ledger's own verdict. If that counted
  // as a check to wait on, the row would be the reason it can never close —
  // which is the loop this whole test block exists to end. It closes on the
  // state of everything ELSE.
  const env = fresh();
  await record(env, { kind: 'alert', subject: '🔴 NUM IS DOWN — failures', detail: 'x', severity: 'high' });
  assert.deepEqual(alertAbout('🔴 NUM IS DOWN — failures'), []);
  assert.equal(await resolveClearedAlerts(env, { failures: { ok: false }, brain: { ok: false } }), 0,
    'closed while the brain was down');
  assert.equal(await resolveClearedAlerts(env, { failures: { ok: false }, brain: { ok: true }, d1_write: { ok: true } }), 1);
});

test('a held recovery notice closes once we are actually healthy', async () => {
  // "✅ Num is healthy again", held by a judge, was the sixteen-lap loop of
  // 3–17 Sep. It names no checks; it is true exactly when nothing is failing.
  const env = fresh();
  await record(env, { kind: 'alert', subject: '✅ Num is healthy again.', detail: 'x', severity: 'high' });
  assert.equal(await resolveClearedAlerts(env, { brain: { ok: false } }), 0);
  assert.equal(await resolveClearedAlerts(env, { brain: { ok: true }, site_public: { ok: true } }), 1);
});

test('only alerts — a real product failure is never closed by a green check', async () => {
  // The ledger's value is that it outlives the dashboard. A ratings outage or
  // a dead mail channel is closed by somebody fixing it, not by an unrelated
  // check going green on the same run.
  const env = fresh();
  await record(env, { kind: 'ratings_refused', subject: 'serpapi 429', detail: 'x', severity: 'low' });
  await record(env, { kind: 'line_dead', subject: 'ops.alert', detail: 'x', severity: 'high' });
  assert.equal(await resolveClearedAlerts(env, { brain: { ok: true } }), 0);
  assert.equal((await open(env)).length, 2);
});

test('healthCron closes cleared alerts and re-judges on the spot', async () => {
  const src = readFileSync(new URL('./health.mjs', import.meta.url), 'utf8');
  assert.match(src, /resolveClearedAlerts/);
  assert.match(src, /if \(await resolveClearedAlerts\(env, out\.checks\)\) out = await runHealth\(env\);/,
    'a cleared row waits five more minutes for the verdict to catch up');
  // Anchored inside healthCron: there is another `INSERT INTO num_health` in
  // this file, in a different function, and indexOf would find that one.
  const cron = src.indexOf('export async function healthCron');
  const at = src.indexOf('resolveClearedAlerts(env, out.checks)', cron);
  const record_ = src.indexOf('INSERT INTO num_health', cron);
  assert.ok(at > cron && at < record_, 'the run is recorded before the stale row is let go, so it logs a false down');
});
