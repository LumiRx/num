// The three moat features, each tested at its one load-bearing rule.
//
// These are static checks against the source, same technique as the wallet
// and block tests: enumerate the property that must hold, fail with the file
// and line when it doesn't. They exist because each of these rules is
// invisible in a demo — the demo works WITHOUT the rule, right up until the
// day it very much doesn't.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(HERE, f), 'utf8');

// ── Nudges ────────────────────────────────────────────────────────────────

test('a nudge can never fire twice for the same moment', () => {
  const src = read('nudge.mjs');
  // The unique index is the guarantee; INSERT OR IGNORE is the gate.
  assert.match(src, /UNIQUE INDEX.*num_nudges\(member_id, plan_id, moment\)/s, 'dedup index missing');
  assert.match(src, /INSERT OR IGNORE INTO num_nudges/, 'nudge does not claim before sending');
  // Claim BEFORE send: the claim insert must appear before the notify call.
  assert.ok(
    src.indexOf('INSERT OR IGNORE INTO num_nudges') < src.indexOf('await notify(env'),
    'nudge sends before claiming — a crash between the two would double-send',
  );
});

test('nudges respect the night', () => {
  const src = read('nudge.mjs');
  assert.match(src, /quiet hours/, 'no quiet-hours guard');
  // And in THEIR timezone, not the server's.
  assert.match(src, /Asia\/Bangkok/, 'quiet hours not computed in Phuket time');
});

test('a dead weather API cannot kill the nudge', () => {
  const src = read('nudge.mjs');
  const fc = src.slice(src.indexOf('async function forecast'), src.indexOf('export async function nudgeSweep'));
  assert.match(fc, /catch/, 'forecast() can throw into the sweep');
  assert.match(fc, /AbortSignal.timeout/, 'forecast() can hang the sweep forever');
});

// ── Closed-loop bookings ──────────────────────────────────────────────────

test('a partner answer link is signed over id AND verdict', () => {
  const src = read('bookdesk.mjs');
  // Signed over both, so a confirm token cannot be replayed as a decline.
  assert.match(src, /book:\$\{id\}:\$\{verdict\}/, 'token does not bind the verdict');
  // And the answer endpoint actually verifies it.
  assert.match(src, /token !== \(await sign\(env, id, verdict\)\)/, 'answer endpoint does not verify the token');
});

test('a booking answer is one-way — a second tap changes nothing', () => {
  const src = read('bookdesk.mjs');
  assert.match(src, /WHERE id=\?1 AND state='requested'/, 'any state can be overwritten — yesterday’s link could un-confirm a table');
});

test('the guest is told only on the FIRST answer', () => {
  const src = read('bookdesk.mjs');
  // notify must be inside the flip.meta.changes guard.
  const answer = src.slice(src.indexOf("path === '/answer'"));
  assert.ok(
    answer.indexOf('flip.meta.changes > 0') < answer.indexOf('await notify(env'),
    'a re-tapped link would push the guest a duplicate confirmation',
  );
});

// ── Group intelligence ────────────────────────────────────────────────────

test('preferences join a plan only with that member’s consent', () => {
  const src = read('social.mjs');
  const fn = src.slice(src.indexOf('export async function groupNeeds'), src.indexOf('async function planFit'));
  assert.match(fn, /filter\(\(r\) => r\.share_prefs\)/, 'groupNeeds reads members who never consented');
});

test('consent is the member’s own to flip, and off by default', () => {
  const src = read('social.mjs');
  assert.match(src, /share_prefs INTEGER NOT NULL DEFAULT 0/, 'sharing defaults ON — consent must be opt-in');
  const share = src.slice(src.indexOf('async function planShare'), src.indexOf('FIT_FIELDS'));
  // The UPDATE is keyed on member_id = me: you can only flip your own row.
  assert.match(share, /WHERE plan_id=\?1 AND member_id=\?2/, 'someone else could flip a member’s sharing');
});

test('the fit summary is only visible to plan members', () => {
  const src = read('social.mjs');
  const fit = src.slice(src.indexOf('async function planFit'), src.indexOf('export async function handleSocial'));
  assert.match(fit, /You’re not on that plan/, 'anyone with a plan id could read the group’s diets and arrival times');
});

test('only fit fields leave the bio — never the whole profile', () => {
  const src = read('social.mjs');
  const fn = src.slice(src.indexOf('export async function groupNeeds'), src.indexOf('async function planFit'));
  // The merged output must be built from the FIT_FIELDS allowlist, not by
  // spreading the parsed bio.
  assert.match(fn, /for \(const f of FIT_FIELDS\)/, 'groupNeeds does not restrict to the allowlist');
  assert.ok(!/\.\.\.bio/.test(fn), 'groupNeeds spreads the whole bio into the plan');
});
