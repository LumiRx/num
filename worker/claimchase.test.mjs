import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chaseStalledClaims, chaseEmail, dueRound, ageHours, attributeClaim, ROUNDS } from './claimchase.mjs';

/* A tiny D1 that records what it was asked, so the LOCK can be tested rather
   than assumed. `reminders` is a real Set with the same uniqueness the
   (claim_id, round) primary key gives us in production. */
function db({ rows = [], failInsert = false } = {}) {
  const reminders = new Set();
  const events = [];
  const invites = [];
  return {
    reminders, events, invites,
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async all() { return { results: rows }; },
              async run() {
                if (/INSERT OR IGNORE INTO num_claim_reminders/.test(sql)) {
                  const key = `${args[0]}:${args[1]}`;
                  if (failInsert || reminders.has(key)) return { meta: { changes: 0 } };
                  reminders.add(key);
                  return { meta: { changes: 1 } };
                }
                if (/DELETE FROM num_claim_reminders/.test(sql)) {
                  reminders.delete(`${args[0]}:${args[1]}`);
                  return { meta: { changes: 1 } };
                }
                if (/num_claim_events/.test(sql)) { events.push(args); return { meta: { changes: 1 } }; }
                if (/UPDATE num_invites/.test(sql)) { invites.push(args); return { meta: { changes: 1 } }; }
                return { meta: { changes: 0 } };
              },
              async first() { return null; },
            };
          },
          async all() { return { results: rows }; },
          async run() { return { meta: { changes: 0 } }; },
        };
      },
    },
  };
}

const adam = {
  id: 'clm_adam', place_id: 'p_hie', claimant_name: 'Adam',
  claimant_email: 'reception@hieedinburgh.co.uk',
  created_at: '2026-08-24 16:31:15', place_name: 'Holiday Inn Express Edinburgh City Centre',
};
const NOW = new Date('2026-09-07T18:00:00Z');

test('the rounds are three, then silence', () => {
  assert.equal(ROUNDS.length, 3);
  assert.equal(dueRound(0), 0, 'a claim started seconds ago is not stalled');
  assert.equal(dueRound(1.9), 0);
  assert.equal(dueRound(2), 1);
  assert.equal(dueRound(71), 1);
  assert.equal(dueRound(72), 2);
  assert.equal(dueRound(168), 3);
  assert.equal(dueRound(24 * 365), 3, 'a fourth round must never appear with age alone');
});

test('age is read as UTC, not local', () => {
  // D1 writes "YYYY-MM-DD HH:MM:SS" with no zone and means UTC. Parsing it
  // without the Z is a no-op on a UTC worker and shifts every age by the
  // offset on a developer's machine — enough to fire round 2 on day one.
  const h = ageHours('2026-09-07 12:00:00', new Date('2026-09-07T18:00:00Z'));
  assert.equal(h, 6);
});

test('Adam gets written to, not just alerted about', async () => {
  const d = db({ rows: [adam] });
  const seen = [];
  const out = await chaseStalledClaims({ DB: d.DB, SITE: 'https://itsnum.com' }, {
    mailer: async (_e, m) => { seen.push(m); return { ok: true }; }, now: NOW,
  });
  assert.equal(out.sent, 1);
  assert.equal(seen[0].to, 'reception@hieedinburgh.co.uk');
  assert.match(seen[0].subject, /Holiday Inn Express/);
  assert.match(seen[0].text, /https:\/\/itsnum\.com\/claim\/\?p=p_hie/, 'no way back to where he stopped');
  assert.match(seen[0].text, /List|—/);
  assert.ok(seen[0].headers['List-Unsubscribe'], 'no one-click unsubscribe');
});

test('a round is sent AT MOST ONCE, forever — not once a day', async () => {
  // The bug this guards: a per-day dedupe on a sweep that runs every five
  // minutes is how an alert nearly went out 288 times in one day.
  const d = db({ rows: [adam] });
  let sends = 0;
  const env = { DB: d.DB };
  const mailer = async () => { sends++; return { ok: true }; };
  for (let i = 0; i < 50; i++) await chaseStalledClaims(env, { mailer, now: NOW });
  assert.equal(sends, 1, `sent ${sends} copies of the same round`);
});

test('the lock is taken BEFORE the send, and released if the send fails', async () => {
  const d = db({ rows: [adam] });
  const env = { DB: d.DB };
  let attempt = 0;
  const flaky = async () => { attempt++; return attempt === 1 ? { ok: false, error: 'resend 503' } : { ok: true }; };
  const first = await chaseStalledClaims(env, { mailer: flaky, now: NOW });
  assert.equal(first.failed, 1);
  assert.equal(d.reminders.size, 0, 'a transport outage permanently silenced a real business');
  const second = await chaseStalledClaims(env, { mailer: flaky, now: NOW });
  assert.equal(second.sent, 1, 'the retry never happened');
});

test('nobody is chased who is not actually waiting', async () => {
  const fresh = { ...adam, created_at: '2026-09-07 17:41:00' };   // 19 minutes old
  const d = db({ rows: [fresh] });
  const out = await chaseStalledClaims({ DB: d.DB }, { mailer: async () => ({ ok: true }), now: NOW });
  assert.equal(out.sent, 0);
  assert.equal(out.skipped, 1);
});

test('the copy names the place and never claims we sent a code', async () => {
  const m = chaseEmail({ placeName: 'Arroyo del Sol', claimantName: 'Larry', resumeUrl: 'https://x/y', round: 1 });
  assert.match(m.text, /Arroyo del Sol/);
  assert.match(m.text, /Hi Larry,/);
  assert.ok(!/we sent you a code|check your inbox for the code/i.test(m.text),
    'the whole point is that no code was ever sent — do not tell them to look for one');
  assert.match(chaseEmail({ placeName: 'X', resumeUrl: 'u', round: 3 }).text, /last time we will write/);
});

/* ── attribution ──────────────────────────────────────────────────────── */

test('a claim is attributed to the invite by domain, not exact address', async () => {
  // The invite went to info@c-ohomenetwork.com; Larry claimed from
  // larry@c-ohomenetwork.com four minutes later, and the exact-match join
  // reported the campaign as having converted nobody.
  const d = db();
  const r = await attributeClaim({ DB: d.DB }, { claimId: 'c1', email: 'larry@c-ohomenetwork.com' });
  assert.equal(r.matched, 1);
  assert.equal(d.invites[0][0], 'c-ohomenetwork.com');
});

test('freemail is never attributed to anyone', async () => {
  const d = db();
  for (const e of ['a@gmail.com', 'b@yahoo.com', 'c@icloud.com', 'd@outlook.com']) {
    const r = await attributeClaim({ DB: d.DB }, { claimId: 'c', email: e });
    assert.equal(r.matched, 0, `${e} was attributed to an invite`);
  }
  assert.equal(d.invites.length, 0, 'a freemail claim wrote to num_invites');
});

test('a malformed address attributes nothing', async () => {
  const d = db();
  for (const e of ['', null, 'nope', '@nodomain']) {
    assert.equal((await attributeClaim({ DB: d.DB }, { email: e })).matched, 0);
  }
});
