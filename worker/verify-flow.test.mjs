// A verification flow with one chance is not a verification flow.
//
// The original code called sendCode() in exactly one place: the first /me POST
// carrying a phone number. Every later attempt with that number hit the
// recovery branch, which returned "Welcome back — everything on this number is
// still here" and sent nothing, and no other route could issue a code. So if
// the first text failed, arrived late, or the person closed the app before
// typing it, they were permanently unable to verify — and the product told
// them everything was fine.
//
// It was invisible while A2P blocked every send anyway. The day approval lands
// it becomes the largest drop-off in the funnel. These tests pin the three
// properties that keep it fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const social = readFileSync(join(HERE, 'social.mjs'), 'utf8');

/** The body of a named function, up to the next top-level declaration. */
function fn(name) {
  const start = social.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const next = social.indexOf('\nasync function ', start + 10);
  return social.slice(start, next < 0 ? social.length : next);
}

test('a person can get a code more than once', () => {
  // The whole bug in one assertion: if only one call site can mint a code,
  // then missing it is terminal.
  const sites = [...social.matchAll(/\bsendCode\(/g)].length;
  const issuers = [...social.matchAll(/\bissueCode\(/g)].length;
  assert.ok(issuers >= 3,
    `a code can be issued from only ${issuers} place(s) — signup, recovery and resend must all be able to send, or missing the first text is permanent`);
  assert.equal(sites, 1,
    'sendCode is called from more than one place — minting logic has been duplicated and the copies will drift');
});

test('recovery sends a code instead of a reassuring dead end', () => {
  // "Welcome back, everything is still here" while silently doing nothing is
  // worse than an error: it stops the person trying anything else.
  //
  // Re-anchored 1 Sep 2026. This used to slice from
  // `if (!holder.phone_verified) {` — the gate that made recovery
  // unavailable to exactly the members who had proved they owned their
  // number. That line is gone, so the slice silently became empty and the
  // assertion below passed on nothing.
  const me = social.slice(social.indexOf('A VERIFIED NUMBER USED TO BE SHUT'), social.indexOf('async function verifyMe'));
  assert.ok(me.length > 200, 'the recovery branch could not be located — this test is asserting on an empty string');
  assert.match(me, /issueCode\(/,
    'the recovery branch still returns without sending a code — a returning user can never verify');
  assert.ok(!/recovered_unverified/.test(me),
    'recovery still reports the old do-nothing reason instead of a real send result');
});

/**
 * Source with comments removed.
 *
 * A test that greps for a deleted line will match the comment explaining why
 * it was deleted — which is exactly what happened here, and is the second time
 * in this codebase. Prose about code is not code.
 */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('recovery is NOT gated on whether the number was verified', () => {
  // The inversion, pinned. A verified number is the one we can PROVE reaches
  // its owner, so it is the strongest case for letting a code move it — not
  // the weakest. Gating on phone_verified locked out precisely the members
  // who had done what we asked.
  const live = code(social);
  assert.ok(!/if \(!holder\.phone_verified\)/.test(live),
    'the recovery branch is gated on phone_verified again — verified members cannot change phone');
  assert.ok(!/Sign in from the device that has it/.test(live),
    'the dead-end message is back; the device it names is the one they no longer have');

  // And /verify must not throw the code away unread on the phone path.
  const verify = live.slice(live.indexOf('async function verifyMe'));
  assert.match(verify, /row\.phone_verified && !byPhone/,
    'the already-verified short-circuit still swallows the phone path, so the code can never be checked');
});

test('there is a resend route, because "I did not get it" always happens', () => {
  assert.match(social, /path === '\/resend' && post/, 'no resend endpoint is routed');
  assert.match(fn('resendCode'), /issueCode\(/, 'the resend handler does not actually issue a code');
});

test('the hash is only stored when the text actually went out', () => {
  // Storing a hash for a message that failed leaves a member who cannot
  // verify AND whose next attempt is told a code is already pending — the
  // worst of both states.
  const f = fn('issueCode');
  const guard = f.indexOf('if (!out.ok)');
  // The write that STORES a hash, not any statement that mentions the column.
  // issueCode also CLEARS code_hash on the Twilio Verify path — Verify owns the
  // code there, so a legacy pending one must not survive alongside it — and
  // that clearing statement sits above this guard by design. Matching on the
  // bound parameter pins this to the storing write, which is the one that must
  // never happen before the send is known to have succeeded.
  const write = f.indexOf('UPDATE num_members SET code_hash=?2');
  // Assert PRESENCE before ordering. `indexOf` returns -1 for a missing
  // guard, and -1 is less than any real index — so a bare `guard < write`
  // comparison passes when the check has been deleted entirely, which is the
  // very mutation this test exists to catch.
  assert.ok(guard >= 0, 'the send result is never checked — a failed text still stores a code hash');
  assert.ok(write >= 0, 'no code hash is stored at all, so nothing can ever be verified');
  assert.ok(guard < write,
    'the code hash is written before the send result is checked — a failed text would leave a pending code nobody has');
});

test('resend is cooled down, since every call spends real money', () => {
  // An unthrottled resend button is a way for a stranger to spend the Twilio
  // balance. A cooldown refuses the masher without stranding the person whose
  // first text genuinely never came.
  const f = fn('resendCode');
  assert.match(f, /RESEND_COOLDOWN_SEC/, 'resend has no cooldown — each press sends another paid SMS');
  assert.match(f, /429/, 'a throttled resend does not return 429');
  assert.match(f, /retry_after_sec/,
    'the throttle does not tell the caller when to try again, so a UI cannot show anything useful');
});

test('an already-verified member is not re-texted', () => {
  const f = fn('resendCode');
  assert.match(f, /phone_verified.*already|already: true/s,
    'resend would text somebody who is already verified — a message with no purpose, billed to us');
});

// ── THE COOLDOWN THAT WAS NOT THERE ──────────────────────────────────────
//
// Added 30 Aug 2026. The tests above pinned that a cooldown EXISTS; they
// could not see that it was measuring a column which the live path sets to
// NULL on purpose. `issueCode` clears `code_expires` on the Twilio Verify
// branch because Verify owns the code and its expiry — and Verify is the
// branch every real sign-in has taken since it was switched on. So the guard
// read null, skipped, and the rate limit was decoration.
//
// The lesson generalises past this bug: a limit tested only for its own
// presence is a limit nobody has checked is connected to anything.

test('the cooldown is not measured off a column the live path nulls out', () => {
  const f = fn('resendCode') + fn('sendGate');
  assert.ok(!/code_expires/.test(f),
    'resend is timing the cooldown off code_expires, which issueCode NULLs on the Verify path — the guard cannot fire');
  assert.match(f, /num_signin_events/,
    'the cooldown must read a record BOTH send paths write, or it only limits the path nobody uses');
});

test('cooldown arithmetic happens in SQL, not in JS Date parsing', () => {
  // datetime('now') has no timezone marker, and V8 parses "2026-08-30
  // 22:15:04" as LOCAL time. A test machine outside UTC would silently
  // mis-measure every cooldown — including reporting one as long expired.
  const f = fn('sendGate');
  assert.match(f, /strftime\('%s'/,
    'the elapsed time is not computed in SQL, so it depends on the runtime timezone');
  assert.ok(!/new Date\(.*ts/.test(f), 'a bare timestamp string is being handed to new Date()');
});

test('resend works for somebody who has no member id — which is most of them', () => {
  // Recovery withholds the id by design (SEC-001): /me answers 202 with no id
  // and only /verify releases it. An id-only resend endpoint therefore failed
  // exactly the person staring at a code box that never filled.
  const f = fn('resendCode');
  assert.match(f, /normalisePhone\(b\.phone/,
    'resend cannot be reached by phone number, so recovery has no way to ask for another code');
  assert.match(f, /WHERE phone=\?1/, 'no lookup by number');
});

test('resend does not become a "is this person on Num" oracle', () => {
  const f = fn('resendCode');
  // An unknown number must get the same answer as a cooling-down one. A
  // distinguishable 404 would turn this into a free membership lookup for
  // anybody holding a phone book.
  assert.ok(!/unknown member/.test(f), 'an unknown number is answered distinguishably');
  const noRow = f.slice(f.indexOf('if (!row)'), f.indexOf('if (row.phone_verified)'));
  assert.match(noRow, /429/, 'the not-found branch does not answer like the throttled branch');
});

test('there is a ceiling as well as a cooldown', () => {
  // 60 seconds between sends still permits 60 paid messages an hour to one
  // number, which is a Fraud Guard trip rather than a person who needs help.
  const f = fn('sendGate');
  assert.match(f, /RESEND_MAX_PER_HOUR/, 'a cooldown alone leaves an hourly volume unbounded');
  assert.match(f, /capped: true/, 'the cap is not distinguishable from the cooldown by the client');
});

test('a resend tells the truth about the code before it', () => {
  // Verify reports carrier outcomes only on request, so a code a carrier
  // rejected leaves our side reading "ok". Saying "I have sent another code"
  // without checking is the second lie in a row.
  const f = fn('resendCode');
  assert.match(f, /attemptsForVerification/,
    'resend never asks what happened to the previous code, so it cannot report a delivery failure');
  assert.match(f, /previous/, 'the previous attempt is not returned to the caller');
});

test('the verification sid is kept, or nothing can ever be checked', () => {
  // Verify has no StatusCallback. The sid is the only handle on "did this
  // specific code arrive"; without it, delivery is unknowable after the fact.
  const issue = fn('issueCode');
  const verifyBranch = issue.slice(0, issue.indexOf('const code = generateCode()'));
  assert.match(verifyBranch, /code_sid=\?2/,
    'the Verify branch discards the verification sid, so no later check can find the attempt');
});

test('the recovery path is throttled too, not just the button', () => {
  // /me recovery takes a bare phone number from an unauthenticated caller and
  // sends a paid SMS to whoever owns it. Capping the resend button while
  // leaving that open would move the abuse rather than stop it: anybody
  // holding a member's number could text them on a loop at our expense until
  // Twilio's own 60203 fired and locked the real owner out.
  assert.match(social, /async function sendGate\(env, memberId\)/,
    'there is no shared send gate, so the two mint paths will drift');
  const calls = [...social.matchAll(/await sendGate\(/g)].length;
  assert.ok(calls >= 2,
    `sendGate guards only ${calls} of the paths that mint a code — every issueCode call site needs it`);
});

test('a throttled recovery keeps the person on the code screen', () => {
  // Refusing here does not mean no code exists — one went out seconds ago and
  // is still the code to type. Turning that into an error would send somebody
  // back to the start to ask for a code they are already holding.
  const f = fn('handleMe') || social;
  assert.match(social, /throttled: true/, 'a throttled recovery is indistinguishable from a provider failure');
  assert.match(social, /if \(!verification\.sent && !refuse\)/,
    'a throttled recovery falls into the 503 fail-closed branch meant for a dead provider');
});


test('a code that never went out does not start a cooldown', () => {
  // A failed send locking somebody out for a minute, under the words "a code
  // is on its way", is the same false claim of delivery this change exists to
  // remove — rebuilt one layer up. It is also wrong on cost: a message that
  // never left is one nobody paid for.
  const f = fn('sendGate');
  const cooldownQuery = f.slice(f.indexOf('SELECT'), f.indexOf('.bind('));
  const clauses = [...cooldownQuery.matchAll(/stage='send'/g)].length;
  const guarded = [...cooldownQuery.matchAll(/stage='send' AND outcome='ok'/g)].length;
  assert.equal(guarded, clauses,
    `${clauses - guarded} of ${clauses} cooldown clauses count failed sends, so a text that never left still throttles the person waiting for it`);
});
