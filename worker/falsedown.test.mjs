/**
 * ONE BOUNCED EMAIL SAID "🔴 NUM IS DOWN".
 *
 * 12 Sep 2026, 19:00. Dre's phone said the product was down. It was not. The
 * health run that sent that text reads, in full:
 *
 *     site_public   ok
 *     d1_write      ok
 *     brain         ok
 *     brains_state  ok (nothing cooling)
 *     attribution   ok
 *     failures      FAIL   ← the only one
 *
 * The chain, exactly:
 *
 *   18:45:17  Resend webhook: ckrcbuilt@thecounternorcal.com bounced.
 *             maildelivery.mjs records it at severity HIGH and tells nobody
 *             — recording is not telling.
 *   18:55:08  Health runs. The row is 9 seconds inside the 600-second grace,
 *             so `blind` is still false. Verdict ok.
 *   19:00:16  Health runs. The row has settled. `blind` = "settled, not low,
 *             nobody told" → true. `failures` is on the DOWN list.
 *             Verdict DOWN. Text sent.
 *   19:00:17  That very alert is recorded as open failure number eleven.
 *
 * And it would never clear: a bounce row resolves only on a later successful
 * delivery to the same address, which for a dead mailbox never comes. The
 * verdict was stuck at 503 for ever — which is worse than no alarm, because
 * it masks the next real outage.
 *
 * Three things are fixed and pinned here. None of them weakens the 3 Sep
 * protection this ledger was built for: an alert that NO channel carried
 * still stays open, still untold, still blind.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { record, resolve, told, summary } from './failures.mjs';

const MAILDELIVERY = readFileSync(new URL('./maildelivery.mjs', import.meta.url), 'utf8');
const HEALTH = readFileSync(new URL('./health.mjs', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');

let db; let env;

/**
 * A NEW binding object over the same database.
 *
 * `ensure()` keys its "already built" flag on the binding via a WeakSet, so
 * reusing one binding would skip the migration the tests below are about —
 * which is exactly what a fresh Worker isolate does NOT do.
 */
const binding = () => ({
  prepare(sql) {
    let bound = [];
    const api = {
      bind(...a) { bound = a; return api; },
      async run() { const r = db.prepare(sql).run(...bound); return { meta: { changes: r.changes } }; },
      async first() { const r = db.prepare(sql).get(...bound); return r ? { ...r } : null; },
      async all() { return { results: db.prepare(sql).all(...bound).map((r) => ({ ...r })) }; },
    };
    return api;
  },
});

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  env = { DB: binding() };
});

/** Push a row's clock back so the 600-second grace has expired. */
const settle = (id) => db.prepare('UPDATE num_failures SET first_seen = first_seen - 3600 WHERE id LIKE ?').run(`%${id}%`);

describe('a bounce is not an outage', () => {
  test('a low-severity failure nobody was told about does not blind the ledger', async () => {
    await record(env, { kind: 'mail_bounced', subject: 'dead@example.com', detail: 'hard bounce', severity: 'low' });
    settle('mail_bounced');
    const s = await summary(env);
    assert.equal(s.open, 1, 'it is still recorded — this is not sweeping it under the rug');
    assert.equal(s.blind, false, "a dead mailbox in somebody else's company is not a Num outage");
  });

  test('the same row at HIGH is what took the product down', async () => {
    await record(env, { kind: 'mail_bounced', subject: 'dead@example.com', detail: 'hard bounce', severity: 'high' });
    settle('mail_bounced');
    assert.equal((await summary(env)).blind, true, 'this is the 12 Sep incident, reproduced');
  });

  test('maildelivery records a bounce as low and a complaint as high', () => {
    assert.match(MAILDELIVERY, /severity: complaint \? 'high' : 'low'/);
    assert.ok(!/severity: type === 'email\.complained' \? 'high' : 'high'/.test(MAILDELIVERY),
      'the ternary with two identical branches is back');
  });

  test('a complaint is high AND somebody is actually told', () => {
    // High severity with no telling path IS the bug. A spam complaint
    // threatens the sending domain every booking confirmation depends on, so
    // it must page — and paging is what sets `told`, which is what stops it
    // blinding the ledger ten minutes later.
    const i = MAILDELIVERY.indexOf('if (complaint) {');
    assert.ok(i > 0, 'a complaint no longer alerts anybody');
    assert.match(MAILDELIVERY.slice(i, i + 500), /alert\(env,/);
  });
});

describe('the alert ledger stops eating its own tail', () => {
  test('a delivered alert is closed, not left open for ever', async () => {
    await record(env, { kind: 'alert', subject: '✅ Num is healthy again.', severity: 'high' });
    await told(env, 'alert', '✅ Num is healthy again.', 'sms');
    await resolve(env, 'alert', '✅ Num is healthy again.');
    assert.equal((await summary(env)).open, 0,
      "ten of the eleven open failures on 12 Sep were Num's own alert texts");
  });

  test('health.mjs closes the row on the same branch that marks it told', () => {
    const i = HEALTH.indexOf('await markTold(env, kind, subject || text.slice(0, 100), carried);');
    assert.ok(i > 0);
    assert.match(HEALTH.slice(i, i + 1400), /await resolveFailure\(env, kind, subject \|\| text\.slice\(0, 100\)\)/);
  });

  test('AN UNDELIVERED ALERT IS STILL OPEN, STILL BLIND — 3 Sep is not undone', async () => {
    // The month of real failures reported into a dead LINE channel is the
    // whole reason this ledger exists. Nothing above may weaken it.
    await record(env, { kind: 'alert', subject: 'nobody carried this', severity: 'high' });
    settle('nobody carried this');
    const s = await summary(env);
    assert.equal(s.open, 1);
    assert.equal(s.blind, true, 'an alert nothing carried must still read as blind');
    // And health.mjs only resolves inside the `carried` branch.
    const elseAt = HEALTH.indexOf('kind: \'alert_undelivered\'');
    const resolveAt = HEALTH.indexOf('await resolveFailure(env, kind');
    assert.ok(resolveAt > 0 && resolveAt < elseAt,
      'resolve must sit in the delivered branch, never past the else');
  });
});

describe('the rows already open on 12 Sep are corrected, not just future ones', () => {
  // `record()` ratchets severity UP and never down, so without these the fix
  // applies only to rows that do not exist yet — and the alarm stays stuck.
  test('an open bounce recorded at high is regraded to low', async () => {
    // Write the row the old code would have written, bypassing record().
    await record(env, { kind: 'seed', subject: 'x', severity: 'low' });
    db.prepare(
      "INSERT INTO num_failures (id, kind, subject, detail, severity, seen, first_seen, last_seen) "
      + "VALUES ('f_mail_bounced|dead@example.com','mail_bounced','dead@example.com','bounce','high',1,1,1)",
    ).run();
    settle('mail_bounced');
    // A fresh isolate runs ensure() again.
    await record({ DB: binding() }, { kind: 'ping', subject: 'y', severity: 'low' });
    const row = db.prepare("SELECT severity FROM num_failures WHERE kind='mail_bounced'").get();
    assert.equal(row.severity, 'low');
  });

  test('the backlog of DELIVERED alerts is closed', async () => {
    // One real record first, so the table exists before the seed rows.
    await record(env, { kind: 'seed', subject: 'x', severity: 'low' });
    db.prepare(
      "INSERT INTO num_failures (id, kind, subject, detail, severity, seen, first_seen, last_seen, told) "
      + "VALUES ('f_alert|healthy','alert','✅ Num is healthy again.','','high',13,1,1,1)",
    ).run();
    db.prepare(
      "INSERT INTO num_failures (id, kind, subject, detail, severity, seen, first_seen, last_seen, told) "
      + "VALUES ('f_alert|undelivered','alert','nothing carried this','','high',1,1,1,0)",
    ).run();
    await record({ DB: binding() }, { kind: 'ping', subject: 'z', severity: 'low' });
    const kept = db.prepare("SELECT id FROM num_failures WHERE kind='alert' AND resolved_at IS NULL").all();
    assert.equal(kept.length, 1, 'exactly one alert row should survive');
    assert.match(kept[0].id, /undelivered/, 'the UNTOLD one is the one that must stay open');
  });
});

describe('a human can clear a stuck row', () => {
  test('the route exists, is admin-gated, and takes one named row', () => {
    assert.match(INDEX, /url\.pathname === '\/api\/admin\/failures\/resolve' && request\.method === 'POST'/);
    const i = INDEX.indexOf("'/api/admin/failures/resolve'");
    const block = INDEX.slice(i, i + 900);
    assert.match(block, /adminGuard/);
    assert.match(block, /if \(!body\?\.kind\) return json\(400/, 'it must not be able to clear everything at once');
  });

  test('clearing is not silencing — the condition reopens the row', async () => {
    await record(env, { kind: 'brain', subject: 'openai', severity: 'high' });
    await resolve(env, 'brain', 'openai');
    assert.equal((await summary(env)).open, 0);
    // It happens again.
    await record(env, { kind: 'brain', subject: 'openai', severity: 'high' });
    assert.equal((await summary(env)).open, 1, 'a resolved row must reopen when the fault recurs');
  });
});

describe('what the incident did NOT touch', () => {
  test('failures stays on the DOWN list — a blind ledger is still an outage', () => {
    assert.match(HEALTH, /const DOWN = \['d1_write', 'brain', 'site_public', 'failures'\]/,
      'the fix is what gets recorded at high severity, never the severity of being blind');
  });

  test('the grace period is unchanged', () => {
    const failures = readFileSync(new URL('./failures.mjs', import.meta.url), 'utf8');
    assert.match(failures, /now - r\.first_seen > 600/);
  });
});
