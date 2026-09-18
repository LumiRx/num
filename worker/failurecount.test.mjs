// "🔴 NUM IS DOWN — 200 open failure(s)", 18 Sep 2026 00:10, while every real
// check was green and the concierge was answering in six seconds.
//
// The 200 was 199 bounced outreach emails — low severity, address already
// suppressed, nothing for anybody to do — plus one alert of NUM's own. And it
// was 200 exactly because that is the LIMIT on the query that counts them.
// Underneath, an alert that failed to deliver kept `blind` true, so the same
// page fired every cron tick and recorded itself as another failure each time.
//
// These are the three rules that came out of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summary } from './failures.mjs';

const now = Math.floor(Date.now() / 1000);
const old = now - 3600;

/** A D1 stand-in that serves one fixed set of open rows. */
const dbOf = (rows) => ({
  prepare() {
    const s = { bind() { return s; }, run: async () => ({}), first: async () => null, all: async () => ({ results: rows }) };
    return s;
  },
});

const bounce = (n) => ({
  id: `f_mail_bounced|a${n}@example.com`, kind: 'mail_bounced', subject: `a${n}@example.com`,
  severity: 'low', told: 0, seen: 1, first_seen: old,
});

test('a wall of bounced outreach mail is not an outage', async () => {
  const rows = Array.from({ length: 199 }, (_, i) => bounce(i));
  const s = await summary({ DB: dbOf(rows) });
  assert.equal(s.open, 199, 'still recorded, every one — nothing is swept under the rug');
  assert.equal(s.actionable, 0, 'but nothing here is work: each one suppressed its own address');
  assert.equal(s.chores, 199, 'they are counted, under their own name');
  assert.equal(s.blind, false, 'and they never blind the ledger');
});

test('an alert NUM could not deliver is a broken alarm, not an open fault', async () => {
  // The loop: the DOWN alert is recorded as a high-severity failure; it is
  // untold because the channel is the thing that is broken; so the ledger
  // reports a failure, so the alert fires again, all night.
  const rows = [{ id: 'f_alert|down', kind: 'alert', subject: '🔴 NUM IS DOWN', severity: 'high', told: 0, seen: 40, first_seen: old }];
  const s = await summary({ DB: dbOf(rows) });
  assert.equal(s.open, 1, 'it stays open — an alert nobody received is the 3 Sep incident');
  assert.equal(s.actionable, 0, 'but NUM reporting its own alarm is not a second product failure');
  assert.equal(s.blind, true, 'and it still says the alarm channel is broken, which is the point');
});

test('a real failure still counts, and still says so', async () => {
  const rows = [
    { id: 'f_brain_down|x', kind: 'brain_down', subject: 'every structured brain is cooling', severity: 'high', told: 0, seen: 1, first_seen: old },
    ...Array.from({ length: 150 }, (_, i) => bounce(i)),
  ];
  const s = await summary({ DB: dbOf(rows) });
  assert.equal(s.actionable, 1, 'one thing is wrong, and the number a human reads says one');
  assert.equal(s.open, 151, 'the honest total is still there for anyone who wants it');
  assert.equal(s.chores, 150);
  assert.equal(s.high, 1);
  assert.equal(s.blind, true);
  assert.equal(s.worst[0].kind, 'brain_down', 'the worst list leads with the real failure, not the mail');
});

test('a failure recorded seconds ago gets its ten minutes before it pages anyone', async () => {
  const rows = [{ id: 'f_brain_down|x', kind: 'brain_down', subject: 'cooling', severity: 'high', told: 0, seen: 1, first_seen: now - 30 }];
  const s = await summary({ DB: dbOf(rows) });
  assert.equal(s.actionable, 1);
  assert.equal(s.blind, false, 'transients resolve themselves; a monitor that fires on them is one people close');
});
