import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const NUDGE = readFileSync(join(here, 'nudge.mjs'), 'utf8');
const CLAIM = readFileSync(join(here, '..', 'growth', 'claimverify.mjs'), 'utf8');

/* ─────────────────────────────────────────────────────────────────────────
   THE SEVEN DAYS

   On 24 Aug 2026 Adam at the Holiday Inn Express Edinburgh City Centre
   started a claim on his own listing. On 30 Aug he was still waiting. Two
   separate faults, either of which alone would have caused it.
   ───────────────────────────────────────────────────────────────────────── */

// FAULT ONE: the alerting sweep read `num_app_claims`. The /api/claims/* flow
// writes `num_claims`. Different tables, so an API claim could never appear in
// any alert, ever.
test('the sweep watches the table the API flow actually writes', () => {
  assert.match(NUDGE, /FROM num_claims c JOIN places p ON p\.id = c\.place_id/,
    'the API claim table is still unwatched');
  assert.ok(
    NUDGE.includes('FROM num_app_claims c') && NUDGE.includes('FROM num_claims c'),
    'both tables must be watched — neither replaced the other',
  );
});

// Adam's row had `expires_at` NULL, and `NULL < datetime('now')` is NULL, not
// true. An expiry test would have missed him a second time.
test('a claim with no expiry is still caught', () => {
  const q = NUDGE.slice(NUDGE.indexOf('FROM num_claims c'), NUDGE.indexOf('FROM num_claims c') + 320);
  assert.ok(!/expires_at/.test(q), 'NULL < now() is NULL — an expiry test loses exactly this row');
  assert.match(q, /state NOT IN \('approved', 'rejected', 'expired'\)/);
  assert.match(q, /created_at < datetime\('now', '-2 hours'\)/, 'two hours, not a day');
});

// The daily 10am gate is right for a follow-up call and wrong for somebody
// sitting on a form having just raised their hand.
test('a waiting business does not wait for mid-morning Phuket', () => {
  // phuketHour() is called in nudgeSweep too, so anchor on the gate that
  // follows this block rather than on the first occurrence in the file.
  const start = NUDGE.indexOf('API claims that started');
  const gate = NUDGE.indexOf('const hour = phuketHour()', start);
  assert.ok(start > 0 && gate > start, 'the API claim sweep must sit before the hour gate');
  const claimBlock = NUDGE.slice(start, gate);
  assert.match(claimBlock, /await alert\(/, 'the alert must fire inside the ungated section');
  assert.match(claimBlock, /FROM num_claims c/, 'and the query must be in that same ungated section');
});

test('the alert names who is waiting and for how long', () => {
  assert.match(NUDGE, /claim\(s\) waiting on us/);
  assert.match(NUDGE, /claimant_name, c\.claimant_email/, 'a name and an address, so it can be answered');
  assert.match(NUDGE, /86400000/, 'days waiting — seven is a different message from one');
});

test('an alert fires once per claim per day, not every five minutes', () => {
  const i = NUDGE.indexOf('apiclaim:');
  assert.ok(i > 0, 'no dedupe key');
  assert.match(NUDGE.slice(i - 300, i + 40), /INSERT OR IGNORE INTO num_nudges/);
});

// FAULT TWO: even if somebody had been told, the code could not have been
// sent. sendCode spoke only Resend, and Resend was returning 401 — while
// `if (!env.RESEND_KEY)` passed, because the key was present and dead.
test('the claim code goes through the mailer, not through one transport', () => {
  assert.match(CLAIM, /await import\('\.\.\/worker\/mailer\.mjs'\)/, 'still Resend-only');
  assert.ok(!/return out === false \? \{ ok: false, error: 'send_failed' \}/.test(CLAIM),
    'the old single-transport send is still in place');
});

test('a present-but-dead key no longer passes the guard as if it worked', () => {
  assert.match(CLAIM, /if \(!env\.RESEND_KEY && !env\.EMAIL\?\.send\)/,
    'a key being set says nothing about whether it is valid — the mailer decides');
});

test('a code that could not be sent is reported loudly, not swallowed', () => {
  assert.match(CLAIM, /CODE NOT SENT/);
  assert.match(CLAIM, /recordSend\(env, 'claim-code', r\)/,
    'every attempt lands in num_health, so a silent run of failures cannot happen again');
});

// The detail that makes the whole thing sting: verification was available.
// places.email for that listing is reception@hieedinburgh.co.uk — the exact
// address he typed. channelsForClaim offers it.
test('a listing that publishes its own email offers that as a channel', () => {
  assert.match(CLAIM, /channel: 'email'/);
  assert.match(CLAIM, /Email the address on your listing/);
  assert.match(CLAIM, /the contact ALREADY PUBLISHED on the listing/,
    'the reason this is proof, kept next to the code that relies on it');
});

/* ─────────────────────────────────────────────────────────────────────────
   THE ALERTER WAS ITSELF UNREACHABLE

   On 30 Aug 2026 all three alert channels were dead at once — no webhook,
   Twilio rejecting 30034, Resend returning 401 — and nothing said so. For a
   function whose only job is to still work when other things do not, that is
   the worst available failure.
   ───────────────────────────────────────────────────────────────────────── */
const HEALTH = readFileSync(join(here, 'health.mjs'), 'utf8');

test('alert falls through to the mailer when every credential is dead', () => {
  assert.match(HEALTH, /await import\('\.\/mailer\.mjs'\)/, 'alert still has no working last resort');
  const i = HEALTH.indexOf('THE ALERTER WAS ITSELF UNREACHABLE');
  assert.ok(i > 0);
  assert.ok(i > HEALTH.indexOf('api.resend.com'), 'the fallback must come after the others, not instead of them');
});

test('it addresses the admin when no alert address is configured', () => {
  assert.match(HEALTH, /env\.ALERT_EMAIL_TO \|\| env\.ADMIN_EMAIL/,
    'ADMIN_EMAIL is bound in production and ALERT_EMAIL_TO may not be');
});

// The bug hiding inside the bug: this block read RESEND_API_KEY while every
// other caller sets RESEND_KEY, so on most deployments it never ran at all.
test('the variable-name mismatch that hid the dead channel is written down', () => {
  assert.match(HEALTH, /RESEND_API_KEY while the rest of the codebase sets/,
    'the next reader needs to know these are two different variables');
});

test('an undeliverable alert is logged as such rather than passing quietly', () => {
  assert.match(HEALTH, /ALERT UNDELIVERABLE/);
});

test('a throwing mailer never takes the alert path down', () => {
  const i = HEALTH.indexOf("await import('./mailer.mjs')");
  assert.match(HEALTH.slice(i - 120, i + 700), /catch \(e\)/);
});
