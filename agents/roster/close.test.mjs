import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEAT, DISQUALIFY, score, rank, readiness, isClosed, isPaying, isFreemail, QUEUE_SQL,
} from './close.mjs';
import { FIRST_CLOSE, ROSTER, byId } from './roster.mjs';
import { canAct, screen, FORBIDDEN } from './charter.mjs';
import { RESOLVERS, resolve, sendFacts } from './state.mjs';

// ─────────────────────────────────────────────────────────────────────────
//  THE RANKING IS THE AGENT
//
//  Everything else here is plumbing. If this agent ever emails a cold lead
//  while somebody who filled in the claim form is still waiting, it has
//  reproduced the exact failure it was built to end.
// ─────────────────────────────────────────────────────────────────────────

test('a pending claim outranks every other contact NUM holds', () => {
  const queue = rank([
    { email: 'cold@example.com' },
    { email: 'asked@example.com', dest_asks: 279 },
    { email: 'silent@example.com', invite_status: 'sent' },
    { email: 'opened@example.com', invite_status: 'sent', opened_at: '2026-08-01' },
    { email: 'clicked@example.com', invite_status: 'sent', clicked_at: '2026-08-01' },
    { email: 'reception@hieedinburgh.co.uk', claim_state: 'pending' },
  ]);
  assert.equal(queue[0].email, 'reception@hieedinburgh.co.uk');
  assert.equal(queue[0].heat, HEAT.claimed_pending);
  assert.match(queue[0].why, /waiting on us/);
});

test('the whole queue is ordered by how warm it is, not by how big it is', () => {
  const queue = rank([
    { email: 'cold@x.com' },
    { email: 'clicked@x.com', clicked_at: '2026-08-01' },
    { email: 'asked@x.com', dest_asks: 279 },
    { email: 'claim@x.com', claim_state: 'pending' },
  ]);
  assert.deepEqual(queue.map((c) => c.email), ['claim@x.com', 'clicked@x.com', 'asked@x.com', 'cold@x.com']);
});

// 279 asks in Phuket against 5 in Edinburgh is a real signal and it is still
// the weaker one. Demand tells us where the NEXT hundred merchants are; a
// filled-in claim form tells us who is waiting right now.
test('a city full of demand still loses to one person who wrote to us', () => {
  const [first] = rank([
    { email: 'phuket@x.com', dest_asks: 279 },
    { email: 'edinburgh@x.com', claim_state: 'pending', dest_asks: 5 },
  ]);
  assert.equal(first.email, 'edinburgh@x.com');
});

// ── WHO WE MUST NOT TOUCH, WHATEVER THE DEADLINE ─────────────────────────
test('an opt-out is a floor, not a factor', () => {
  const r = score({ email: 'gone@x.com', claim_state: 'pending', opted_out: true });
  assert.equal(r.heat, 0);
  assert.equal(r.blocked, DISQUALIFY.opted_out);
});

test('unsubscribed, bounced, addressless and already-claimed all score zero', () => {
  for (const [c, why] of [
    [{ email: 'a@x.com', invite_status: 'unsubscribed' }, DISQUALIFY.unsubscribed],
    [{ email: 'b@x.com', invite_status: 'bounced' }, DISQUALIFY.bounced],
    [{ email: null, claim_state: 'pending' }, DISQUALIFY.no_address],
    [{ email: 'd@x.com', claimed: true }, DISQUALIFY.already_claimed],
  ]) {
    const r = score(c);
    assert.equal(r.heat, 0);
    assert.equal(r.blocked, why);
  }
});

test('nobody disqualified survives into the queue', () => {
  const queue = rank([
    { email: 'ok@x.com', claim_state: 'pending' },
    { email: 'gone@x.com', claim_state: 'pending', opted_out: true },
    { email: 'bounced@x.com', invite_status: 'bounced' },
  ]);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].email, 'ok@x.com');
});

// invitecron.mjs orders 7,651 freemail addresses LAST, and is right to — a
// cold campaign landing in a personal inbox burns the sending domain. But a
// receptionist who already filled in our form is not a cold lead with a bad
// address, and demoting her would be applying the right rule to the wrong
// person.
test('a warm contact is not demoted for having a personal address', () => {
  const [first] = rank([
    { email: 'sales@bigcorp.com', invite_status: 'sent' },
    { email: 'adam@gmail.com', claim_state: 'pending' },
  ]);
  assert.equal(first.email, 'adam@gmail.com');
  assert.equal(isFreemail('adam@gmail.com'), true, 'still recognised as freemail — just not penalised here');
  assert.equal(isFreemail('sales@bigcorp.com'), false);
});

// ─────────────────────────────────────────────────────────────────────────
//  READINESS — THE FIVE SILENT DAYS
//
//  The cron fired every five minutes from 27 to 30 August and was refused
//  every single time. Nothing surfaced it. An agent that reports "closed
//  nobody today" when the truth is "could not send a single email" has told
//  its operator the one thing that guarantees they look in the wrong place.
// ─────────────────────────────────────────────────────────────────────────

test('a failing send path is a blocker, and the blocker carries the actual fix', () => {
  const r = readiness({
    lastSendError: 'resend 403 {"message":"This API key is not authorized to send emails from itsnum.com"}',
    inboxReceiving: true,
    pendingClaims: 0,
  });
  assert.equal(r.ok, false);
  assert.equal(r.blockers.length, 1);
  assert.match(r.blockers[0].fix, /Resend team that owns the verified itsnum.com/);
  assert.match(r.blockers[0].fix, /wrangler secret put RESEND_KEY/);
});

test('an unknown send failure sends the reader to the evidence, not to a guess', () => {
  const r = readiness({ lastSendError: 'ECONNRESET', inboxReceiving: true, pendingClaims: 0 });
  assert.match(r.blockers[0].fix, /num_invites\.error/);
});

// 1,051 businesses were invited and asked to reply. num_inbox holds three
// demo rows. Whatever came back went somewhere nobody reads, which is worse
// than never having asked — we spent the goodwill and threw away the answer.
test('an unread inbox blocks the agent on its own', () => {
  const r = readiness({ inboxReceiving: false, pendingClaims: 0 });
  assert.equal(r.ok, false);
  assert.match(r.blockers[0].what, /reached num_inbox/);
  assert.match(r.blockers[0].fix, /cannot be answered is not an invitation/);
});

test('an unanswered claim is itself a blocker on sending anything new', () => {
  const r = readiness({ inboxReceiving: true, pendingClaims: 1 });
  assert.equal(r.ok, false);
  assert.match(r.blockers[0].what, /1 claim sitting unanswered/);
  assert.match(r.blockers[0].fix, /not a lead, it is a customer being kept waiting/);
});

test('a clean system reports ready without inventing reassurance', () => {
  assert.deepEqual(readiness({ inboxReceiving: true, pendingClaims: 0 }), { ok: true, blockers: [] });
});

// ─────────────────────────────────────────────────────────────────────────
//  SIGNED IS NOT PAYING
//
//  The 24-hour target turns on this and nothing else. Every rate in
//  commission.mjs bills after a completed booking, so a merchant who signs
//  today owes nothing today. Reporting a signature as revenue would be
//  FORBIDDEN.invent_fact aimed at ourselves — the one direction nobody audits.
// ─────────────────────────────────────────────────────────────────────────

test('a signed merchant is not a paying one until a booking completes', () => {
  const signed = {
    claim_state: 'approved',
    first_login_at: '2026-08-30',
    profile_edited_at: '2026-08-30',
    rate_disclosed_at: '2026-08-30',
  };
  assert.equal(isClosed(signed).closed, true);
  assert.equal(isPaying(signed), false, 'signing is not revenue');
  assert.equal(isPaying({ ...signed, commission_cs: 200 }), true);
});

test('three of four is not a close, and it says which one is missing', () => {
  const r = isClosed({ claim_state: 'approved', first_login_at: 'x', profile_edited_at: 'x' });
  assert.equal(r.closed, false);
  assert.deepEqual(r.missing, ['they have seen the rate they will be billed, in writing, before any booking']);
});

test('an approved claim nobody ever logged into is not a merchant', () => {
  const r = isClosed({ claim_state: 'approved' });
  assert.equal(r.closed, false);
  assert.ok(r.missing.some((m) => /logged into the console/.test(m)));
});

// ── THE CHARTER ──────────────────────────────────────────────────────────
test('the closer is on the roster and inherits every house rule', () => {
  assert.equal(byId('first-close'), FIRST_CLOSE);
  assert.ok(ROSTER.includes(FIRST_CLOSE));
  for (const rule of Object.values(FORBIDDEN)) {
    assert.ok(FIRST_CLOSE.never.includes(rule), `a deadline does not suspend: ${rule.slice(0, 40)}…`);
  }
});

// An agent measured on one outcome, given a thousand sends, will use the
// thousand sends. The ceiling is the design.
test('the closer is budgeted for precision, not volume', () => {
  assert.ok(FIRST_CLOSE.budget.perDay <= 12, 'a closer that can send 50 a day is an outreach agent wearing a hat');
  assert.ok(FIRST_CLOSE.budget.perRun <= FIRST_CLOSE.budget.perDay);
});

test('the closer may answer a claim on any day — a reply is correspondence, not a campaign', () => {
  assert.equal(FIRST_CLOSE.windows, null);
  const sunday = new Date('2026-08-30T22:00:00Z');
  const r = canAct(FIRST_CLOSE, {
    env: {},
    now: sunday,
    state: { resend_key_present: 1, send_path_proven: 1, inbox_configured: 1 },
  });
  assert.equal(r.ok, true, 'making a waiting merchant wait until Tuesday is the failure this agent ends');
});

test('the kill switch still stops it, deadline or not', () => {
  const r = canAct(FIRST_CLOSE, {
    env: { AGENTS_PAUSED: 'true' },
    state: { resend_key_present: 1, send_path_proven: 1, inbox_configured: 1 },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /paused/);
});

test('the closer refuses to run while the send path is broken', () => {
  const r = canAct(FIRST_CLOSE, {
    env: {},
    state: { resend_key_present: 1, send_path_proven: 0, inbox_configured: 1 },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /send_path_proven/);
});

// The never-list is the part a deadline attacks. Each of these was a real
// temptation on 30 August.
test('the never-list names the four things a deadline makes tempting', () => {
  const never = FIRST_CLOSE.never.join(' ');
  assert.match(never, /cold lead while a claim sits unanswered/);
  assert.match(never, /inventing demand/);
  assert.match(never, /signed and paying are different days/);
  assert.match(never, /discount, a free period or a rate outside commission\.mjs/);
  assert.match(never, /without evidence/);
});

// ── THE COPY IT WOULD SEND ───────────────────────────────────────────────
test('the tripwires still catch a closing pitch written in a hurry', () => {
  const hits = screen(
    'Claim your listing today and we will put you at the top of the results — '
    + 'we guarantee more bookings for verified restaurants.',
  );
  const rules = hits.map((h) => h.rule);
  assert.ok(rules.includes('sell_placement'));
  assert.ok(rules.includes('invent_fact'));
});

test('the honest version of the same email passes clean', () => {
  const hits = screen(
    'NUM already holds a listing for the Holiday Inn Express Edinburgh City Centre. '
    + 'You filled in the claim form on Sunday and I am sorry it took us six days to answer. '
    + 'Claiming is free and nothing is owed until a traveller completes a booking through us — '
    + 'then it is 10% of the bill, or $2 per confirmed table where we cannot see the bill. '
    + 'Claiming does not change where you appear; placement is not something NUM sells.',
  );
  assert.deepEqual(hits, [], JSON.stringify(hits));
});

// ── THE PRECONDITION THAT WOULD HAVE CAUGHT IT ───────────────────────────
//
// resend_key_present answered YES for five days while every send was refused.
// This is the same lesson A2P taught on the SMS side: the question has to be
// about what happened, not about what is configured.
test('send_path_proven fails on the exact error production returned today', () => {
  const r = RESOLVERS.send_path_proven({}, {
    lastSendError: 'resend 403 {"statusCode":403,"name":"validation_error","message":"This API key is not authorized to send emails from itsnum.com"}',
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /not authorized to send emails from itsnum\.com/);
});

test('a bound key is not a working key, and the two preconditions disagree on purpose', () => {
  const env = { RESEND_KEY: 're_live_whatever' };
  const facts = { lastSendError: 'resend 403 not authorized to send emails from itsnum.com' };
  assert.equal(RESOLVERS.resend_key_present(env).ok, true, 'the secret really is bound');
  assert.equal(RESOLVERS.send_path_proven(env, facts).ok, false, 'and nothing is getting out');

  const r = resolve(FIRST_CLOSE, env, facts);
  assert.equal(r.ok, false);
  assert.ok(r.blocked.some((b) => b.name === 'send_path_proven'));
});

test('a send path that has never once worked is unproven, not fine', () => {
  assert.equal(RESOLVERS.send_path_proven({}, { lastSendAt: null }).ok, false);
  assert.equal(RESOLVERS.send_path_proven({}, { lastSendAt: '2026-08-30 09:00:00' }).ok, true);
});

test('sendFacts reads the latest attempt, not an average that would hide it', async () => {
  const rows = {
    'SELECT status, error': { status: 'failed', error: 'resend 403 nope', at: '2026-08-30 08:30:35' },
    'SELECT MAX(sent_at)': { at: '2026-07-30 23:43:02' },
    'SELECT COUNT(*)': { n: 46 },
  };
  const db = {
    prepare(sql) {
      const key = Object.keys(rows).find((k) => sql.startsWith(k));
      return { first: async () => rows[key] };
    },
  };
  const f = await sendFacts(db);
  assert.equal(f.lastSendError, 'resend 403 nope');
  assert.equal(f.lastSendAt, '2026-07-30 23:43:02', 'a July success does not make August fine');
  assert.equal(f.failedSince, 46);
});

test('sendFacts survives having no database rather than throwing at boot', async () => {
  assert.deepEqual(await sendFacts(null), {});
  assert.deepEqual(await sendFacts({}), {});
});

// ── THE QUERY ────────────────────────────────────────────────────────────
//
// An INNER JOIN here would have hidden the single row this agent exists to
// find: a pending claim with no matching invite, which is exactly the shape
// of the Holiday Inn row.
test('the queue query left-joins, so a claim with no invite is not lost', () => {
  assert.ok(!/\bINNER JOIN\b/i.test(QUEUE_SQL));
  assert.equal((QUEUE_SQL.match(/LEFT JOIN/g) || []).length, 3);
  assert.match(QUEUE_SQL, /num_optouts/, 'the queue must exclude opt-outs in the database, not only in score()');
});
