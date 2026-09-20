/**
 * The nine hours nobody was told about.
 *
 * These tests hold down the four properties that separate an alarm worth
 * having from one that gets muted: it fires when members genuinely cannot
 * sign in, it stays quiet when there is no evidence either way, it does not
 * repeat itself, and it says when it is over.
 *
 * The first test replays the real 20 Sep 2026 numbers. If that one ever goes
 * green-to-red, the outage this file was written for could happen again.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  assess, messageFor, minutesAgo, alertOnSms, PER_NUMBER, NEEDS_HUMAN, MIN_ATTEMPTS, BLOCKED_CLASS,
} from './smsalert.mjs';

let db; let env; let sent;
const d1 = (database) => ({
  prepare: (sql) => {
    const st = { sql, binds: [] };
    st.bind = (...a) => { st.binds = a; return st; };
    const run = () => {
      const text = sql.replace(/\?(\d+)/g, () => '?');
      const order = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]) - 1);
      return { text, args: order.map((n) => st.binds[n]) };
    };
    st.first = async () => { const { text, args } = run(); return database.prepare(text).get(...args) ?? null; };
    st.all = async () => { const { text, args } = run(); return { results: database.prepare(text).all(...args) }; };
    st.run = async () => { const { text, args } = run(); const r = database.prepare(text).run(...args); return { meta: { changes: r.changes } }; };
    return st;
  },
});

/** A send event, `minsAgo` minutes in the past. */
const ev = (outcome, reason, minsAgo = 1, via = 'verify') =>
  db.prepare("INSERT INTO num_signin_events (stage, outcome, reason, via, ts) VALUES ('send', ?, ?, ?, datetime('now', ?))")
    .run(outcome, reason, via, `-${minsAgo} minutes`);

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_signin_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT, stage TEXT NOT NULL,
    outcome TEXT NOT NULL, reason TEXT, via TEXT, ts TEXT NOT NULL DEFAULT (datetime('now')));`);
  sent = [];
  env = { DB: d1(db) };
});

const fire = () => alertOnSms(env, { alertFn: async (t) => { sent.push(t); return { carried: 'test' }; } });

describe('assess — what counts as evidence', () => {
  test('20 Sep 2026 replay: 71 failures, zero deliveries, is an outage', () => {
    const a = assess([{ outcome: 'failed', reason: '20003', n: 71 }]);
    assert.equal(a.level, 'down');
    assert.equal(a.needs_human, true);
    assert.equal(a.reason, '20003');
  });

  test('one success is enough to say the channel is up', () => {
    const a = assess([
      { outcome: 'ok', reason: null, n: 1 },
      { outcome: 'failed', reason: '30005', n: 12 },
    ]);
    assert.equal(a.level, 'ok');
  });

  test('no attempts is quiet, never down — 4am is not an outage', () => {
    assert.equal(assess([]).level, 'quiet');
  });

  test('bad phone numbers alone are quiet, not down', () => {
    for (const code of PER_NUMBER) {
      const a = assess([{ outcome: 'failed', reason: code, n: 9 }]);
      assert.equal(a.level, 'quiet', `${code} must not be evidence of an outage`);
      assert.equal(a.skipped, 9);
      assert.equal(a.attempts, 0);
    }
  });

  test('a real failure still counts when bad numbers are mixed in', () => {
    const a = assess([
      { outcome: 'failed', reason: '60200', n: 20 },
      { outcome: 'failed', reason: '20003', n: 4 },
    ]);
    assert.equal(a.level, 'down');
    assert.equal(a.attempts, 4);
    assert.equal(a.skipped, 20);
  });

  test('below the evidence bar it is suspect, not down', () => {
    const a = assess([{ outcome: 'failed', reason: '20003', n: MIN_ATTEMPTS - 1 }]);
    assert.equal(a.level, 'suspect');
  });

  test('the dominant reason wins, so the message points at one console', () => {
    const a = assess([
      { outcome: 'failed', reason: '30034', n: 2 },
      { outcome: 'failed', reason: '20003', n: 9 },
    ]);
    assert.equal(a.reason, '20003');
  });
});

describe('the words', () => {
  test('a known code carries its remedy, not just its number', () => {
    const m = messageFor(assess([{ outcome: 'failed', reason: '20003', n: 71 }]), {
      lastOkAt: '2026-09-20 08:30:56', now: new Date('2026-09-20T12:02:00Z'),
    });
    assert.match(m, /SIGN-IN DOWN/);
    assert.match(m, /Billing/);
    assert.match(m, /3h 31m ago/);
  });

  test('an unknown code still says where to look', () => {
    const m = messageFor(assess([{ outcome: 'failed', reason: '59999', n: 5 }]));
    assert.match(m, /59999/);
    assert.match(m, /Monitor/);
  });

  test('every needs-human code names a console, never just an error number', () => {
    for (const [code, remedy] of Object.entries(NEEDS_HUMAN)) {
      assert.match(remedy, /Console|VERIFY_SERVICE_SID/, `${code} must tell Dre where to go`);
    }
  });

  test('minutesAgo handles D1 space-separated timestamps', () => {
    assert.equal(minutesAgo('2026-09-20 08:00:00', new Date('2026-09-20T08:45:00Z')), '45m ago');
    assert.equal(minutesAgo('nonsense'), 'unknown');
  });
});

describe('alertOnSms — one tick', () => {
  test('fires once on an outage and names the failure', async () => {
    for (let i = 0; i < 5; i += 1) ev('failed', '20003', 2);
    const r = await fire();
    assert.equal(r.level, 'down');
    assert.equal(sent.length, 1);
    assert.match(sent[0], /SIGN-IN DOWN/);
  });

  test('does not fire twice in the same hour', async () => {
    for (let i = 0; i < 5; i += 1) ev('failed', '20003', 2);
    await fire();
    await fire();
    await fire();
    assert.equal(sent.length, 1, 'a five-minute cron must not send twelve texts an hour');
  });

  test('stays silent when codes are sending', async () => {
    ev('ok', null, 2);
    ev('failed', '30005', 3);
    const r = await fire();
    assert.equal(r.level, 'ok');
    assert.equal(sent.length, 0);
  });

  test('stays silent overnight when nobody is signing in', async () => {
    const r = await fire();
    assert.equal(r.level, 'quiet');
    assert.equal(sent.length, 0);
  });

  test('ignores failures older than the window', async () => {
    for (let i = 0; i < 9; i += 1) ev('failed', '20003', 120);
    const r = await fire();
    assert.equal(r.level, 'quiet');
    assert.equal(sent.length, 0);
  });

  test('email codes never mask a dead SMS channel', async () => {
    for (let i = 0; i < 5; i += 1) ev('failed', '20003', 2);
    for (let i = 0; i < 20; i += 1) ev('ok', null, 1, 'email');
    const r = await fire();
    assert.equal(r.level, 'down', 'the email fallback carrying the load is not SMS being up');
    assert.equal(sent.length, 1);
  });

  test('sends exactly one all-clear, then resets for the next outage', async () => {
    for (let i = 0; i < 5; i += 1) ev('failed', '20003', 2);
    await fire();
    assert.equal(sent.length, 1);

    db.exec("DELETE FROM num_signin_events");
    ev('ok', null, 1);
    await fire();
    assert.equal(sent.length, 2);
    assert.match(sent[1], /back up/);

    await fire();
    assert.equal(sent.length, 2, 'an all-clear repeats as little as an alarm does');

    db.exec("DELETE FROM num_signin_events");
    for (let i = 0; i < 5; i += 1) ev('failed', '20003', 2);
    await fire();
    assert.equal(sent.length, 3, 'the next outage must alert again from scratch');
  });

  test('survives a missing table rather than taking the cron down', async () => {
    db.exec('DROP TABLE num_signin_events');
    const r = await alertOnSms(env, { alertFn: async () => ({}) });
    assert.ok(r);
    assert.equal(r.sent.length, 0);
  });
});

describe('a healthy channel that still locks a country out', () => {
  // 20 Sep 2026, 22:49Z. The account had been restored hours earlier and
  // codes were sending to the US. Every send to Indonesia was refused 60605.
  // Nothing in the product would ever have gone red: 22 Indonesian signups
  // that morning, zero verified, no alert, no failing check.
  test('60605 alerts even while codes are sending elsewhere', async () => {
    ev('ok', null, 2);
    ev('ok', null, 3);
    for (let i = 0; i < 9; i += 1) ev('failed', '60605', 1);
    const r = await fire();
    assert.equal(r.level, 'ok', 'the channel genuinely is up — that is the whole trap');
    assert.equal(sent.length, 1, 'and somebody is still told');
    assert.match(sent[0], /60605/);
    assert.match(sent[0], /Geo permissions/);
  });

  test('Fraud Guard blocks are surfaced too, though they never count as an outage', async () => {
    ev('ok', null, 2);
    for (let i = 0; i < 4; i += 1) ev('failed', '60410', 1);
    const a = assess([{ outcome: 'ok', reason: null, n: 1 }, { outcome: 'failed', reason: '60410', n: 4 }]);
    assert.equal(a.attempts, 1, '60410 names specific numbers, so it is not evidence about the channel');
    const r = await fire();
    assert.equal(r.level, 'ok');
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Fraud Guard/);
  });

  test('a blocked country is reported once a day, not every five minutes', async () => {
    ev('ok', null, 2);
    for (let i = 0; i < 9; i += 1) ev('failed', '60605', 1);
    await fire();
    await fire();
    await fire();
    assert.equal(sent.length, 1);
  });

  test('an ordinary handset rejection is not treated as a locked-out country', async () => {
    ev('ok', null, 2);
    for (let i = 0; i < 6; i += 1) ev('failed', '30005', 1);
    const r = await fire();
    assert.equal(r.level, 'ok');
    assert.equal(sent.length, 0, 'per-handset noise must not become a daily message');
  });

  test('an outage and a blocked country are both reported, not one instead of the other', async () => {
    for (let i = 0; i < 5; i += 1) ev('failed', '20003', 2);
    for (let i = 0; i < 4; i += 1) ev('failed', '60605', 1);
    const r = await fire();
    assert.equal(r.level, 'down');
    assert.equal(sent.length, 2);
    assert.ok(sent.some((t) => /SIGN-IN DOWN/.test(t)));
    assert.ok(sent.some((t) => /60605/.test(t)));
  });

  test('every blocked-class code names the console page that fixes it', () => {
    for (const [code, remedy] of Object.entries(BLOCKED_CLASS)) {
      assert.match(remedy, /Twilio Console/, `${code} must say where to go`);
    }
  });
});
