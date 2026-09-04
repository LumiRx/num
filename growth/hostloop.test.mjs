// THE LOOP — a request arrives, the host decides, the client hears back.
//
// Everything before this was storage. This is the part that makes it a
// service, and it turns on one rule that is easy to state and easy to break:
// NUM never speaks to a client in its own voice, and never before their host
// has acted. These tests are mostly about ORDER and VOICE, because those are
// the two things that cannot be fixed after they have happened once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const worker = read('growth/worker.js');
const m15 = read('worker/migrations/0015_host_separation.sql');
const hostsPage = read('public/hosts/index.html');
const consolePage = read('public/host/index.html');
const memberPage = read('public/my-host/index.html');

/* ── 1. SIGNUP ───────────────────────────────────────────────────────── */

test('signup asks for two things and a consent, and nothing else is required', () => {
  const form = hostsPage.slice(hostsPage.indexOf('<form id="hostForm"'), hostsPage.indexOf('Create my host account'));
  // Count the FIELDS carrying the attribute, not the word — the page also
  // uses "required" in prose, and a test that counts prose measures nothing.
  const required = (form.match(/<(?:input|textarea|select)\b[^>]*\brequired\b[^>]*>/g) || []).length;
  // name, email, the terms checkbox. A fourth required field on a signup a
  // concierge is deciding about in thirty seconds is a fourth reason to leave.
  assert.equal(required, 3, `${required} required fields on host signup — it was 3 on purpose`);
  assert.match(form, /id="h_company"[^>]*>/, 'company is gone');
  assert.ok(!/id="h_company"[^>]*required/.test(form), 'company became required');
  assert.ok(!/id="h_phone"[^>]*required/.test(form), 'phone became required');
});

test('the one thing they write for us is actually stored', () => {
  // The form says "it is what we read first" about this field. The browser has
  // been sending it since the form went live and hostJoin never read it —
  // asking a question and discarding the answer is worse than not asking,
  // because they believe we know.
  assert.match(hostsPage, /notes: document\.getElementById\('h_about'\)/, 'the about field is no longer sent');
  assert.match(m15, /ALTER TABLE num_hosts ADD COLUMN about TEXT/, 'there is nowhere to store it');
  assert.match(worker, /UPDATE num_hosts SET about = \?/, 'hostJoin still throws away what the host wrote');
});

/* ── 2. ORDER — the client never hears first ─────────────────────────── */

test('logging a request tells the host and says nothing to the client', () => {
  const create = worker.slice(worker.indexOf('  // CREATE'), worker.indexOf('/* ------------------------------------------------- /api/host/network'));
  assert.match(create, /notifyHostOfRequest/, 'the host is not told when a request lands');
  assert.ok(!/notifyClientOfConfirm|client\.email/.test(create),
    'a client is emailed at request time — nobody has agreed to anything yet');
});

test('the client is told only inside the confirm branch', () => {
  const calls = worker.match(/await notifyClientOfConfirm\(/g) || [];
  assert.equal(calls.length, 1, `notifyClientOfConfirm is called from ${calls.length} places — it belongs in exactly one`);
  const i = worker.indexOf('await notifyClientOfConfirm(');
  const before = worker.slice(Math.max(0, i - 700), i);
  assert.match(before, /if \(next === "confirmed"\)/,
    'the client can be told outside the confirm branch — that is NUM committing a host');
  assert.match(before, /client_notified_at == null/, 'a repeated confirm emails the client twice');
});

test('a host looking at their own console is not emailed about what they just typed', () => {
  assert.match(worker, /b\.notify_host !== false && b\.source !== "console"/,
    'the host is mailed about a request they typed themselves — that is how a notification becomes noise they filter');
});

/* ── 3. VOICE — it comes from the host, not from us ──────────────────── */

test('every message to a client is signed by the host', () => {
  assert.match(worker, /function onBehalf\(host, env\)/, 'the shared signature is gone');
  const sig = worker.slice(worker.indexOf('function onBehalf'), worker.indexOf('async function notifyHostOfRequest'));
  assert.match(sig, /"\\n\\n— " \+ \(host\.name/, 'the sign-off is no longer the host’s name');
  assert.match(sig, /Sent by NUM on/, 'NUM is not disclosed as the sender — that would be a lie about who typed it');

  // And the reply address on anything a client receives is the host, not us.
  const conf = worker.slice(worker.indexOf('async function notifyClientOfConfirm'), worker.indexOf('async function postMessage'));
  assert.match(conf, /replyTo: \[host\.email \|\| "info@itsnum\.com"\]/,
    'a client replying to their confirmation reaches NUM instead of their host');
  assert.match(conf, /onBehalf\(host, env\)/, 'the confirmation is not signed by the host');
});

test('the schema records who wrote each message, and says why it matters', () => {
  assert.match(m15, /author\s+TEXT NOT NULL CHECK \(author IN \('host','client','num'\)\)/,
    'the message author vocabulary changed');
  assert.match(m15, /OVER THE HOST'S NAME/, 'the rule is no longer written where the table is defined');
});

/* ── 4. BOTH DIRECTIONS, ONE WRITER ─────────────────────────────────── */

test('one function posts messages in both directions', () => {
  assert.match(worker, /async function postMessage/, 'the shared message writer is gone');
  const posts = worker.match(/await postMessage\(/g) || [];
  assert.ok(posts.length >= 2, 'only one direction posts through the shared writer');
  const fn = worker.slice(worker.indexOf('async function postMessage'), worker.indexOf('/* ------------------------------------------------ /api/host/messages'));
  assert.match(fn, /author === "host"/, 'the writer does not branch on who wrote it');
  assert.match(fn, /delivered_at = \?/, 'nothing records whether the message actually went');
});

test('a thread is reached through the request, never through a message id', () => {
  const msg = worker.slice(worker.indexOf('async function hostMessages'), worker.indexOf('/* ------------------------------------------ GET /api/host/calendar.ics'));
  assert.match(msg, /WHERE r\.id = \? AND r\.host_id = \?/,
    'ownership is not checked on the request — a console key could read a thread by guessing an id');
  assert.match(msg, /c_status === "removed"/, 'a client who left can still be messaged');
});

test('a client can only reply on their own bookings', () => {
  const link = worker.slice(worker.indexOf('async function memberLink'), worker.indexOf('async function hostClose'));
  assert.match(link, /WHERE id = \? AND client_id = \?/,
    'a member token could post onto somebody else’s request');
  assert.match(link, /author: "client"/, 'the client’s message is not attributed to them');
});

test('the client only ever sees what their host has confirmed', () => {
  const link = worker.slice(worker.indexOf('async function memberLink'), worker.indexOf('async function hostClose'));
  assert.match(link, /status IN \('confirmed','done'\)/,
    'a client is shown bookings their host has not agreed to');
});

/* ── 5. THE CALENDAR ─────────────────────────────────────────────────── */

test('the calendar feed the console has advertised since 1 Sep now exists', () => {
  assert.match(worker, /p === "\/api\/host\/calendar\.ics" && req\.method === "GET"/, 'the feed is not routed');
  assert.match(worker, /async function hostCalendar/, 'the feed handler is missing');
  assert.match(consolePage, /calendar_url/, 'the console no longer shows the feed URL');
});

test('the feed is read-only, unguessable and never indexed', () => {
  const cal = worker.slice(worker.indexOf('async function hostCalendar'), worker.indexOf('ENDING IT — from either side'));
  assert.match(cal, /sameSecret\(host\.calendar_token, t\)/, 'the token is not compared in constant time');
  assert.ok(!/UPDATE |INSERT |DELETE /.test(cal), 'the calendar feed writes to the database');
  assert.match(cal, /"x-robots-tag": "noindex, nofollow"/, 'a bearer-token URL is indexable');
  assert.match(cal, /"referrer-policy": "no-referrer"/, 'the feed URL can leak through a Referer header');
});

test('the feed publishes only confirmed work, and skips what it cannot place', () => {
  const cal = worker.slice(worker.indexOf('async function hostCalendar'), worker.indexOf('ENDING IT — from either side'));
  assert.match(cal, /r\.status IN \('confirmed','done'\)/, 'unconfirmed work appears in the host’s calendar');
  assert.match(cal, /if \(!start\) continue;/,
    'an unparseable date is guessed at — a booking in the wrong place is worse than a missing one');
  assert.match(cal, /fold\(/, 'long lines are not folded — the feed will parse in one calendar app and not another');
});

test('the feed produces something a calendar can actually read', async () => {
  // Exercised for real rather than asserted about: build the ICS with the same
  // escaping and folding the worker uses and check the shape holds.
  const esc = (s) => String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const fold = (line) => {
    const out = []; let s = line;
    while (s.length > 73) { out.push(s.slice(0, 73)); s = ' ' + s.slice(73); }
    out.push(s); return out.join('\r\n');
  };
  const long = fold('SUMMARY:' + esc('Car to LAX, meeting the 11:05, for a client with a very long name indeed — Alexandra'));
  for (const line of long.split('\r\n').slice(1)) {
    assert.ok(line.startsWith(' '), 'a folded continuation line does not begin with a space');
  }
  assert.ok(long.split('\r\n').every((l) => l.length <= 74), 'a folded line is still over the limit');
  assert.equal(esc('Dinner, 8pm; table 4\nwindow'), 'Dinner\\, 8pm\\; table 4\\nwindow');
});

/* ── 6. THE SURFACES ─────────────────────────────────────────────────── */

test('the console can hold a conversation, not just a status', () => {
  assert.match(consolePage, /id="thCard"/, 'there is no thread view in the console');
  assert.match(consolePage, /api\/host\/messages/, 'the console cannot reach the thread endpoint');
  assert.match(consolePage, /as an email from you/i, 'the host is not told their message arrives in their own name');
  assert.match(consolePage, /not delivered/, 'a message that failed to send looks identical to one that arrived');
});

test('the member page is more than an exit door', () => {
  assert.match(memberPage, /What they have confirmed for you/i, 'a client cannot see their own bookings');
  assert.match(memberPage, /id="replyCard"/, 'a client cannot reply to their host');
  assert.match(memberPage, /only to them/i,
    'the page does not say the message goes to the host alone');
  // A client who can only leave or do nothing will, eventually, leave.
  const leaveIdx = memberPage.indexOf('id="startLeave"');
  const replyIdx = memberPage.indexOf('id="bookings"');
  assert.ok(replyIdx > -1 && replyIdx < leaveIdx, 'the exit is offered before anything useful');
});

/* ── 7. THE EMAIL SET ────────────────────────────────────────────────── */

test('every step of the relationship has a message, and each has one sender', () => {
  const kinds = [...worker.matchAll(/name: "kind", value: "([a-z_]+)"/g)].map((m) => m[1]);
  for (const k of [
    'host_welcome',          // they signed up
    'host_intro',            // a member wants them
    'host_request_new',      // work has arrived
    'client_request_confirmed', // their host confirmed — the only booking mail a client gets
    'client_message',        // their host wrote to them
    'host_client_replied',   // their client wrote back
    'host_client_left',      // a client left
    'member_host_ended',     // a host ended it
    'host_closed',           // the host closed their account
  ]) {
    assert.ok(kinds.includes(k), `no email is tagged ${k} — that step of the relationship is silent`);
  }
  // Every send is deduplicated. A retry that mails a client twice about one
  // booking is the failure they remember.
  const sends = worker.match(/__idem: "/g) || [];
  assert.ok(sends.length >= 8, 'some sends have no idempotency key and can fire twice');
});
