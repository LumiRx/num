// "Sent" is a promise to try, not evidence of delivery.
//
// sendCode returned `{ sent: true }` the moment Twilio accepted a message —
// which is the instant it is queued, not the instant a phone rings. On
// 2026-08-04 that gap cost a full day: an authentication failure was read as
// an A2P compliance problem, and then, once auth was fixed, the very first
// working send still could not be distinguished from a filtered one. Twilio
// knew the answer the whole time and we had given it nowhere to say so.
//
// These tests pin the two halves of knowing the truth: delivery receipts, and
// an opt-out that is actually recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const sms = readFileSync(join(HERE, 'sms.mjs'), 'utf8');
const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
const verify = readFileSync(join(HERE, '..', 'claim', 'verify.mjs'), 'utf8');

/** Source minus comments — a guard must assert on code, not on prose about it. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const smsCode = code(sms);

test('every message we send asks Twilio to report back', () => {
  // Without StatusCallback there are no receipts at all, and the product is
  // permanently unable to answer "did it arrive?".
  assert.match(code(verify), /StatusCallback/,
    'sends do not request delivery receipts — Twilio will never tell us what happened to a message');
  assert.match(code(verify), /https:\/\/app\.itsnum\.com\/api\/sms\/status/,
    'the callback URL is missing or not absolute — Twilio needs a full public URL');
});

test('the receipt endpoint exists and is routed', () => {
  assert.match(smsCode, /export async function handleSmsStatus/, 'no status handler');
  assert.match(code(index), /'\/api\/sms\/status'\) return await handleSmsStatus/,
    'the status endpoint is not routed — Twilio would get a 404 and the receipts vanish');
});

test('delivery receipts are signature-verified like any other webhook', () => {
  // AGENTS.md §8: every webhook verifies a signature, no assume-valid branch.
  // Unsigned, anyone could write fake "delivered" rows and hide a real outage.
  const fn = smsCode.slice(smsCode.indexOf('export async function handleSmsStatus'), smsCode.indexOf('const STOP_WORDS'));
  assert.match(fn, /validSignature\(/, 'the status webhook does not verify Twilio signatures');
  assert.match(fn, /403/, 'an unsigned status callback is not rejected');
});

test('failures are stored with the carrier code, not just a status word', () => {
  // "undelivered" alone sends you hunting. 30034 vs 30006 vs 30007 have three
  // completely different fixes, in three different systems.
  const fn = smsCode.slice(smsCode.indexOf('export async function handleSmsStatus'), smsCode.indexOf('const STOP_WORDS'));
  // Match the exact call, not the bare substring. `/ErrorCode/` is also
  // satisfied by `xErrorCode`, `ErrorCodes`, or the word appearing in a
  // variable name — so a mutation that stops reading the field entirely still
  // passes. That decoy has now bitten five separate guards in this codebase;
  // the fix each time is to assert on the precise expression that must run.
  assert.match(fn, /params\.get\(\s*'ErrorCode'\s*\)/,
    'the carrier error code is never read — a failure would be recorded with no reason attached');
  assert.match(smsCode, /30034/, 'no hint for the A2P failure — the exact code we spent a day misreading');
  assert.match(fn, /undelivered|failed/, 'a dropped message is not distinguished from a delivered one');
});

test('repeat callbacks update rather than duplicate', () => {
  // Twilio calls back several times per message (queued → sent → delivered).
  // Inserting each one turns one message into four rows and makes any count
  // of failures wrong.
  const fn = smsCode.slice(smsCode.indexOf('export async function handleSmsStatus'), smsCode.indexOf('const STOP_WORDS'));
  assert.match(fn, /ON CONFLICT\(message_sid\) DO UPDATE/,
    'each status callback inserts a new row — one message would appear as several');
});

test('STOP is recorded against the consent register', () => {
  // /sms/ promises "Reply STOP to opt out" and num_sms_consent has a
  // revoked_at column — which nothing wrote. A register that still shows
  // consent for somebody who opted out is worse than no register.
  assert.match(smsCode, /num_sms_consent SET revoked_at/,
    'nothing ever revokes consent — the opt-out we promise leaves no trace');
  for (const w of ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']) {
    assert.match(smsCode, new RegExp(`'${w}'`), `${w} is not treated as an opt-out keyword`);
  }
  assert.match(smsCode, /'START'|'UNSTOP'/, 'there is no way back in after opting out');
});

test('opt-out is handled before anything else can drop it', () => {
  // A revocation lost to a later inbox-write failure is a message we would
  // then keep sending. It also must not trigger a push notification.
  const inbound = smsCode.slice(smsCode.indexOf('export async function handleSmsInbound'), smsCode.indexOf('export async function handleSmsStatus'));
  assert.ok(inbound.indexOf('applyOptOut') < inbound.indexOf('num_inbox'),
    'opt-out is processed after the inbox write, so a failure there could lose the revocation');
  assert.ok(inbound.indexOf('applyOptOut') < inbound.indexOf('notify('),
    'an opt-out would still fire a push notification at the person asking to be left alone');
});

test('"stop by at 7" is a message, not an opt-out', () => {
  // Single word only. A concierge gets sentences containing these words all
  // day, and silently unsubscribing somebody mid-conversation is a bug they
  // would never report — they would just never hear from Num again.
  const inbound = smsCode.slice(smsCode.indexOf('export async function handleSmsInbound'), smsCode.indexOf('export async function handleSmsStatus'));
  assert.match(inbound, /split\(\/\\s\+\/\)\.length === 1/,
    'multi-word messages containing "stop" would be treated as opt-outs');
});

test('the status webhook is exempt from rate limiting', () => {
  // Twilio retries any non-2xx. Throttling receipts turns a busy minute into a
  // retry storm and drops exactly the delivery failures we need most.
  const c = code(index);
  const line = c.slice(c.indexOf('const isWebhook'), c.indexOf('const isWebhook') + 300);
  assert.match(line, /\/api\/sms\/status/, 'delivery receipts can be rate-limited away');
});
