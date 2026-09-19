// Talking to a business, in both directions.
//
// The thing being protected here is small and specific: a restaurant wrote to
// NUM and nobody found out. Of 3,538 invitations, 77 businesses reached the
// claim page and 2 were ever verified, and the one substantive reply anybody
// can point to arrived as a screenshot because Reply-To pointed at a personal
// mailbox on another company's domain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  parseMessage, splitMessage, decodeWords, htmlToText, topReply, readBody,
} from './mailparse.mjs';
import {
  openThread, matchThread, record, markSent, waiting, conversation,
  keyFromAddress, replyAddress, inboundReady, bareAddress, newReplyKey, __resetReady as resetThreads,
} from './bizthread.mjs';
import { handleInboundEmail } from './bizinbound.mjs';
import { stateOf, nextMove, STEPS } from './bizstate.mjs';
import { guard, factsBlock, PRICE_FACTS } from './bizreply.mjs';
import { compose, runFollowup, __resetReady as resetFollowups } from './bizfollowup.mjs';
import { senderFor, outreachIsolated, MAIL_KIND } from './mailer.mjs';

const NOW = new Date().toISOString().slice(0, 19).replace('T', ' ');

function realDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, status TEXT);
    CREATE TABLE num_business_profiles (business_id TEXT PRIMARY KEY, city TEXT, area TEXT);
    CREATE TABLE num_suppressions (email TEXT PRIMARY KEY, reason TEXT, note TEXT);
    CREATE TABLE num_invites (token TEXT PRIMARY KEY, email TEXT, business_name TEXT, dest TEXT,
      country TEXT, provider_id TEXT, status TEXT, error TEXT, sent_at TEXT, opened_at TEXT,
      clicked_at TEXT, unsubscribed_at TEXT, open_count INTEGER DEFAULT 0, click_count INTEGER DEFAULT 0);
    CREATE TABLE claims (id INTEGER PRIMARY KEY AUTOINCREMENT, business_name TEXT, contact_name TEXT,
      phone TEXT, email TEXT, place_id TEXT, state TEXT, created_at TEXT,
      booking_via TEXT, booking_system TEXT, booking_url TEXT);
    CREATE TABLE num_claims (id TEXT PRIMARY KEY, place_id TEXT, state TEXT, channel TEXT,
      sent_at TEXT, expires_at TEXT, attempts INTEGER, created_at TEXT);
    CREATE TABLE num_place_owners (place_id TEXT PRIMARY KEY, business_id TEXT, method TEXT,
      verified_at TEXT, revoked_at TEXT);
    CREATE TABLE num_booking_channels (place_id TEXT PRIMARY KEY, business_id TEXT, via TEXT,
      sms_to TEXT, email_to TEXT, system_name TEXT, booking_url TEXT, integration TEXT);
    CREATE TABLE num_business_groups (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE num_business_group_sites (business_id TEXT PRIMARY KEY, group_id TEXT, place_id TEXT);
  `);
  const DB = {
    prepare(sql) {
      const bound = [];
      const api = {
        bind(...a) { bound.push(...a); return api; },
        async first() { try { return d.prepare(sql).get(...bound) ?? null; } catch { return null; } },
        async all() { try { return { results: d.prepare(sql).all(...bound) }; } catch { return { results: [] }; } },
        async run() { const r = d.prepare(sql).run(...bound); return { meta: { changes: Number(r.changes ?? 0) } }; },
      };
      return api;
    },
    async batch(st) { const o = []; for (const x of st) o.push(await x.run()); return o; },
  };
  resetThreads(); resetFollowups();
  return { d, env: { DB, MAIL_REPLY_BASE: 'reply@itsnum.com', SITE: 'https://itsnum.com' } };
}

/* ══ 1. Reading what they sent ══════════════════════════════════════════ */

const GMAIL_REPLY = [
  'Delivered-To: reply+abc123def456@itsnum.com',
  'Message-ID: <CAF=1@mail.gmail.com>',
  'In-Reply-To: <invite-99@itsnum.com>',
  'Subject: =?UTF-8?B?UmU6IEh1Z2/igJlzIC0gY2xhaW0=?=',
  'From: Bill <bill@hugos.example>',
  'To: reply+abc123def456@itsnum.com',
  'Content-Type: multipart/alternative; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset="UTF-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Yes please =E2=80=94 we=E2=80=99d like email bookings.',
  '',
  'On Thu, Sep 18, 2026 at 4:02 PM NUM <hello@itsnum.com> wrote:',
  '> Claim your profile',
  '',
  '--b1',
  'Content-Type: text/html; charset="UTF-8"',
  '',
  '<p>Yes please</p>',
  '--b1--',
].join('\r\n');

test('a real Gmail reply is read, decoded and attributed', () => {
  const m = parseMessage(GMAIL_REPLY);
  assert.equal(m.subject, 'Re: Hugo’s - claim', 'the RFC 2047 subject was not decoded');
  assert.equal(m.messageId, 'CAF=1@mail.gmail.com');
  assert.equal(m.inReplyTo, 'invite-99@itsnum.com');
  assert.equal(m.kind, 'plain', 'the plain part must win over the HTML one');
  assert.match(m.text, /Yes please — we’d like email bookings\./, 'quoted-printable was not decoded');
  assert.equal(m.auto, false);
});

test('the quoted history is dropped for the summary and kept in the record', () => {
  const m = parseMessage(GMAIL_REPLY);
  const top = topReply(m.text);
  assert.match(top, /Yes please/);
  assert.ok(!/Claim your profile/.test(top), 'the quoted original is still in the summary');
  // But the full text keeps it: a venue that answers inline under each
  // question would come out blank if we stored only the top.
  assert.match(m.text, /Claim your profile/);
});

test('an HTML-only message is flattened rather than stored as tags', () => {
  const raw = ['Subject: hi', 'Content-Type: text/html', '', '<p>We use <b>OpenTable</b>.</p><div>Call me</div>'].join('\r\n');
  const m = parseMessage(raw);
  assert.equal(m.kind, 'html');
  assert.equal(m.text, 'We use OpenTable.\nCall me');
});

test('an out-of-office is recognised, because it is not a person answering', () => {
  const raw = ['Subject: Automatic reply: away', 'From: a@b.example', 'Auto-Submitted: auto-replied', '', 'Back Monday'].join('\r\n');
  assert.equal(parseMessage(raw).auto, true);
});

test('an attachment is named and its bytes are not kept', () => {
  const raw = [
    'Content-Type: multipart/mixed; boundary="x"', '', '--x',
    'Content-Type: text/plain', '', 'Menu attached', '', '--x',
    'Content-Type: application/pdf; name="menu.pdf"',
    'Content-Disposition: attachment; filename="menu.pdf"', '', 'JVBERi0=', '--x--',
  ].join('\r\n');
  const m = parseMessage(raw);
  assert.equal(m.text.trim(), 'Menu attached');
  assert.deepEqual(m.attachments.map((a) => a.filename), ['menu.pdf']);
});

test('a message with no headers at all still yields its text', () => {
  // The floor: whatever arrives, something readable comes back, because the
  // alternative is losing a business's reply to a parser edge case.
  assert.equal(readBody('just a line').text, 'just a line');
  assert.deepEqual(splitMessage('no headers here').headers, {});
});

/* ══ 2. Finding the thread it belongs to ════════════════════════════════ */

test('the reply address carries the thread, and reads back out of it', () => {
  const key = newReplyKey();
  const addr = replyAddress({ MAIL_REPLY_BASE: 'reply@itsnum.com', MAIL_INBOUND_READY: 'true' }, key);
  assert.equal(addr, `reply+${key}@itsnum.com`);
  assert.equal(keyFromAddress(`NUM <${addr}>`), key);
  assert.equal(keyFromAddress('hello@itsnum.com'), null, 'a plain address has no key to find');
  assert.equal(bareAddress('Bill <bill@hugos.example>'), 'bill@hugos.example');
});

test('the per-thread reply address stays off until a reply could actually arrive', () => {
  // On 19 Sep 2026 a host welcome to launchcheck@itsnum.com BOUNCED \u2014 our own
  // domain, refusing a local part nothing routes. Email Routing delivers only
  // the addresses a rule names, and there is no catch-all. So a Reply-To of
  // reply+key@itsnum.com would bounce, and a business hitting reply would get
  // a delivery failure FROM US. That is worse than the problem it fixes.
  const before = { MAIL_REPLY_TO: 'info@thatislumi.com', MAIL_REPLY_BASE: 'reply@itsnum.com' };
  assert.equal(replyAddress(before, 'abc123'), 'info@thatislumi.com',
    'without inbound routing it must fall back, not hand out a bouncing address');
  assert.equal(inboundReady(before).ready, false);
  assert.match(inboundReady(before).why, /catch-all/i);

  const after = { ...before, MAIL_INBOUND_READY: 'true' };
  assert.equal(replyAddress(after, 'abc123'), 'reply+abc123@itsnum.com');
  assert.equal(inboundReady(after).ready, true);
});

test('a reply is matched by its key, and the record says so', async () => {
  const { env } = realDb();
  const t = await openThread(env, { email: 'bill@hugos.example', businessName: "Hugo's" });
  const m = await matchThread(env, { to: [`reply+${t.reply_key}@itsnum.com`], from: 'someone-else@elsewhere.example' });
  assert.equal(m.thread.id, t.id);
  assert.equal(m.how, 'key', 'the key must win over the From address');
});

test('without a key it falls to the headers, and then to the address', async () => {
  const { env } = realDb();
  const t = await openThread(env, { email: 'bill@hugos.example' });
  await record(env, t.id, { direction: 'out', messageId: 'inv-1@itsnum.com', subject: 'Claim' });

  const byHeader = await matchThread(env, { to: ['hello@itsnum.com'], inReplyTo: '<inv-1@itsnum.com>', from: 'someone@else.example' });
  assert.equal(byHeader.how, 'headers');
  assert.equal(byHeader.thread.id, t.id);

  const byAddr = await matchThread(env, { to: ['hello@itsnum.com'], from: 'Bill <bill@hugos.example>' });
  assert.equal(byAddr.how, 'address');
  // Recorded rather than hidden: two people at one restaurant will land wrong
  // here sometimes, and whoever reads the thread is entitled to know.
  assert.equal(byAddr.thread.id, t.id);
});

test('a message that matches nothing is still kept', async () => {
  const { env } = realDb();
  const m = await matchThread(env, { to: ['hello@itsnum.com'], from: 'stranger@nowhere.example' });
  assert.equal(m.thread, null);
  // The inbound handler opens one — a person wrote to us, and that is worth
  // more than a silent discard. Asserted end to end below.
});

test('the same message delivered twice is one row', async () => {
  const { env } = realDb();
  const t = await openThread(env, { email: 'bill@hugos.example' });
  const a = await record(env, t.id, { direction: 'in', messageId: 'dup@x', body: 'hello' });
  const b = await record(env, t.id, { direction: 'in', messageId: 'dup@x', body: 'hello' });
  assert.equal(b.duplicate, true);
  assert.equal(a.id, b.id);
  assert.equal((await conversation(env, t.id)).length, 1);
});

test('an inbound message raises the flag and only a send lowers it', async () => {
  const { env } = realDb();
  const t = await openThread(env, { email: 'bill@hugos.example', businessName: "Hugo's" });
  await record(env, t.id, { direction: 'in', body: 'can we claim without texts?' });
  assert.equal((await waiting(env)).length, 1);

  // Drafting does not count. Neither does approving.
  const draft = await record(env, t.id, { direction: 'out', body: 'yes', state: 'draft' });
  assert.equal((await waiting(env)).length, 1, 'a draft is not an answer');

  await markSent(env, draft.id, 'em_1');
  assert.equal((await waiting(env)).length, 0);
});

test('the desk is a queue and not a stack', async () => {
  // A business that wrote four days ago is the one being let down. Newest
  // first would bury them under this morning's arrivals for ever.
  const { d, env } = realDb();
  const a = await openThread(env, { email: 'old@x.example' });
  const b = await openThread(env, { email: 'new@x.example' });
  await record(env, a.id, { direction: 'in', body: 'four days ago' });
  await record(env, b.id, { direction: 'in', body: 'this morning' });
  d.prepare("UPDATE num_biz_threads SET last_in_at = datetime('now','-4 days') WHERE id = ?").run(a.id);
  const q = await waiting(env);
  assert.equal(q[0].email, 'old@x.example');
  assert.ok(q[0].waiting_hours >= 90, `waited ${q[0].waiting_hours}h`);
});

/* ══ 3. The inbound handler ═════════════════════════════════════════════ */

function fakeMessage(raw, { to = 'reply+k@itsnum.com', from = 'bill@hugos.example' } = {}) {
  const forwarded = [];
  return {
    from, to, forwarded,
    raw: new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(raw)); c.close(); },
    }),
    forward: async (addr) => { forwarded.push(addr); },
  };
}

test('a human gets the copy before anything else can go wrong', async () => {
  const { env } = realDb();
  const msg = fakeMessage(GMAIL_REPLY);
  await handleInboundEmail(msg, { ...env, MAIL_INBOUND_FORWARD: 'dre@thatislumi.example' }, null);
  assert.deepEqual(msg.forwarded, ['dre@thatislumi.example'],
    'forwarding must happen first — it is the fallback for every bug after it');
});

test('an unmatched reply opens a thread rather than vanishing', async () => {
  const { env } = realDb();
  const raw = ['Message-ID: <x@y>', 'Subject: are you real', 'From: stranger@nowhere.example', '', 'Who are you?'].join('\r\n');
  await handleInboundEmail(fakeMessage(raw, { from: 'stranger@nowhere.example', to: 'hello@itsnum.com' }), env, null);
  const q = await waiting(env);
  assert.equal(q.length, 1);
  assert.equal(q[0].email, 'stranger@nowhere.example');
  assert.equal(q[0].state, 'wrote_in');
});

test('an auto-reply lands on the thread and does not claim they answered', async () => {
  const { env } = realDb();
  const t = await openThread(env, { email: 'bill@hugos.example' });
  const raw = [
    `To: reply+${t.reply_key}@itsnum.com`, 'Message-ID: <oo@x>',
    'Subject: Automatic reply: Out of office', 'From: bill@hugos.example',
    'Auto-Submitted: auto-replied', '', 'Back Monday',
  ].join('\r\n');
  await handleInboundEmail(fakeMessage(raw, { to: `reply+${t.reply_key}@itsnum.com` }), env, null);
  assert.equal((await conversation(env, t.id)).length, 1, 'it is still on the record');
  assert.equal((await waiting(env)).length, 0, 'a mail server is not a person answering');
});

/* ══ 4. Where the business actually is ══════════════════════════════════ */

test('the step is derived from evidence, never from a status column', async () => {
  const { d, env } = realDb();
  d.prepare('INSERT INTO num_invites (token,email,business_name,status,sent_at,opened_at,clicked_at) VALUES (?,?,?,?,?,?,?)')
    .run('t1', 'bill@hugos.example', "Hugo's", 'sent', NOW, NOW, NOW);
  let s = await stateOf(env, { email: 'bill@hugos.example' });
  assert.equal(s.step, 'clicked');
  assert.match(s.next.say, /refused to submit without a mobile/, 'the honest reason they may have stopped');

  d.prepare('INSERT INTO claims (business_name,email,place_id,created_at) VALUES (?,?,?,?)')
    .run("Hugo's", 'bill@hugos.example', 'p1', NOW);
  s = await stateOf(env, { email: 'bill@hugos.example' });
  assert.equal(s.step, 'applied');
  assert.equal(s.next.blocked_by, 'us', 'they applied and we sent nothing — ours');

  d.prepare('INSERT INTO num_place_owners (place_id,business_id,method,verified_at) VALUES (?,?,?,?)')
    .run('p1', 'b1', 'email', NOW);
  s = await stateOf(env, { email: 'bill@hugos.example' });
  assert.equal(s.step, 'verified');
});

test('"configured" is not "live" when a booking could not actually reach them', async () => {
  const { d, env } = realDb();
  d.prepare('INSERT INTO claims (business_name,email,place_id,created_at) VALUES (?,?,?,?)')
    .run("Hugo's", 'bill@hugos.example', 'p1', NOW);
  d.prepare('INSERT INTO num_place_owners (place_id,business_id,method,verified_at) VALUES (?,?,?,?)')
    .run('p1', 'b1', 'email', NOW);
  // They chose email and gave no address. That is configured and unreachable,
  // and calling it live would be the `onboarded` column all over again.
  d.prepare('INSERT INTO num_booking_channels (place_id,business_id,via) VALUES (?,?,?)').run('p1', 'b1', 'email');
  let s = await stateOf(env, { email: 'bill@hugos.example' });
  assert.equal(s.step, 'configured');
  assert.equal(s.reachable, false);
  assert.match(s.next.say, /cannot reach them/);

  d.prepare("UPDATE num_booking_channels SET email_to='res@hugos.example' WHERE place_id='p1'").run();
  s = await stateOf(env, { email: 'bill@hugos.example' });
  assert.equal(s.step, 'live');
  assert.equal(s.reachable, true);
});

test('somebody who unsubscribed is never chased again', async () => {
  const { d, env } = realDb();
  d.prepare('INSERT INTO num_invites (token,email,status,sent_at,clicked_at,unsubscribed_at) VALUES (?,?,?,?,?,?)')
    .run('t1', 'go@away.example', 'sent', NOW, NOW, NOW);
  const s = await stateOf(env, { email: 'go@away.example' });
  assert.equal(s.unsubscribed, true);
  assert.equal(s.next.do, 'nothing');
  assert.equal(s.next.blocked_by, 'them');
});

test('an open is treated as the weak signal it is', () => {
  const n = nextMove({ step: 'opened' });
  assert.match(n.say, /not the same as read/, 'chasing image proxies is not follow-up');
  assert.equal(n.do, 'wait');
  assert.ok(STEPS.indexOf('opened') < STEPS.indexOf('clicked'));
});

/* ══ 5. What a drafted reply is not allowed to say ══════════════════════ */

const CLEAN = 'Yes, you can claim it without turning text bookings on. Pick "just list us" '
  + 'and nothing will ever be sent to you. Your four sites can sit under one account, each '
  + 'keeping its own hours and address. Which reservation system do you run?';

test('a clean draft passes', () => {
  assert.deepEqual(guard(CLEAN, { step: 'clicked' }), { ok: true });
});

test('a draft that invents a price is refused', () => {
  // The expensive kind of wrong: a figure in writing, from the company, to a
  // merchant who will hold us to it.
  const bad = `${CLEAN} Our commission is 7% of the bill.`;
  const out = guard(bad, {});
  assert.equal(out.ok, false);
  assert.match(out.why, /figure we did not publish/);
  // The published ones are fine \u2014 including at the end of a sentence, where
  // the full stop rides into the match and the first version of the guard
  // refused our own price list.
  assert.equal(guard(`${CLEAN} A completed table booking is $2.00.`, {}).ok, true);
  assert.equal(guard(`${CLEAN} Rooms are 15%.`, {}).ok, true);
  assert.ok(PRICE_FACTS.join(' ').includes('$2.00'));
});

test('a draft that invents a link is refused', () => {
  const out = guard(`${CLEAN} Set it up at https://itsnum.com/partners/opentable-setup`, {});
  assert.equal(out.ok, false);
  assert.match(out.why, /invented or unapproved link/);
});

test('a draft that promises is refused', () => {
  for (const bad of [
    `${CLEAN} Your table is confirmed.`,
    `${CLEAN} We will ship the SevenRooms integration next month.`,
    `${CLEAN} It is guaranteed.`,
  ]) {
    const out = guard(bad, {});
    assert.equal(out.ok, false, bad);
    assert.match(out.why, /promises something/);
  }
});

test('nothing is drafted to somebody who unsubscribed', () => {
  assert.equal(guard(CLEAN, { unsubscribed: true }).ok, false);
});

test('the facts block says plainly what has NOT happened', async () => {
  // A model told only what is true will invent the rest. It is told the
  // negatives too, in the same voice, so "they have not proved the listing" is
  // as available to it as anything else.
  const { env } = realDb();
  const t = await openThread(env, { email: 'bill@hugos.example', businessName: "Hugo's" });
  const s = await stateOf(env, { email: 'bill@hugos.example' });
  const facts = factsBlock(s, t);
  assert.match(facts, /have NOT yet proved they control the listing/);
  assert.match(facts, /Nobody has asked them how bookings should reach them/);
});

/* ══ 6. The one follow-up ═══════════════════════════════════════════════ */

test('it will not send while the bounce breaker is over its ceiling', async () => {
  const { d, env } = realDb();
  for (let i = 0; i < 60; i++) {
    d.prepare('INSERT INTO num_invites (token,email,status,sent_at) VALUES (?,?,?,?)')
      .run(`b${i}`, `b${i}@x.example`, 'bounced_permanent', NOW);
  }
  const out = await runFollowup(env, { dryRun: false });
  assert.equal(out.sent, 0);
  assert.match(out.reason, /breaker/);
});

test('it goes only to people who clicked and never filled the form', async () => {
  const { d, env } = realDb();
  d.prepare('INSERT INTO num_invites (token,email,business_name,status,sent_at,clicked_at) VALUES (?,?,?,?,?,?)')
    .run('t1', 'clicked@x.example', 'Clicked', 'sent', NOW, NOW);
  d.prepare('INSERT INTO num_invites (token,email,status,sent_at,opened_at) VALUES (?,?,?,?,?)')
    .run('t2', 'opened@x.example', 'sent', NOW, NOW);
  d.prepare('INSERT INTO num_invites (token,email,status,sent_at,clicked_at) VALUES (?,?,?,?,?)')
    .run('t3', 'finished@x.example', 'sent', NOW, NOW);
  d.prepare('INSERT INTO claims (email,created_at) VALUES (?,?)').run('finished@x.example', NOW);
  d.prepare('INSERT INTO num_invites (token,email,status,sent_at,clicked_at,unsubscribed_at) VALUES (?,?,?,?,?,?)')
    .run('t4', 'gone@x.example', 'sent', NOW, NOW, NOW);

  const out = await runFollowup(env);
  assert.equal(out.dryRun, true, 'the default must be the harmless one');
  assert.equal(out.would_send, 1);
  assert.deepEqual(out.sample.map((s) => s.email), ['clicked@x.example']);
});

test('the message says the form was broken, because it was', () => {
  const m = compose({ businessName: "Hugo's", claimUrl: 'https://itsnum.com/claim/?ref=t1' });
  assert.match(m.subject, /broken/);
  assert.match(m.text, /said it was optional, and then refused to submit without one/);
  // And it offers the way out in the body, not only in a header.
  assert.match(m.text, /reply and say so/);
});

/* ══ 7. The sender split ════════════════════════════════════════════════ */

test('outreach and transactional can be told apart, and are not by default', () => {
  const before = { MAIL_FROM: 'NUM <hello@itsnum.com>' };
  assert.equal(senderFor(before, MAIL_KIND.OUTREACH), 'NUM <hello@itsnum.com>');
  const state = outreachIsolated(before);
  assert.equal(state.isolated, false);
  assert.match(state.why, /MAIL_FROM_OUTREACH is not set/);

  const after = { MAIL_FROM: 'NUM <hello@itsnum.com>', MAIL_FROM_OUTREACH: 'NUM <invites@mail.itsnum.com>' };
  assert.equal(senderFor(after, MAIL_KIND.OUTREACH), 'NUM <invites@mail.itsnum.com>');
  assert.equal(senderFor(after, MAIL_KIND.TRANSACTIONAL), 'NUM <hello@itsnum.com>');
  assert.equal(outreachIsolated(after).isolated, true);
});

test('a split that is only half configured reports itself as not done', () => {
  // The dangerous state: everyone believes outreach is isolated, and it is
  // the same domain with the alarm switched off.
  const half = { MAIL_FROM: 'NUM <hello@itsnum.com>', MAIL_FROM_OUTREACH: 'NUM <invites@itsnum.com>' };
  const out = outreachIsolated(half);
  assert.equal(out.isolated, false);
  assert.match(out.why, /both on itsnum\.com/);
});
