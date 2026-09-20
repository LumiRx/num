// THE ASK, AND WHEN IT IS ALLOWED TO HAPPEN.
//
// Three things in this funnel have each been wired to nothing at some point in
// this product's life, and every one of them was invisible until somebody went
// looking. They are pinned here so the next regression is a failing test rather
// than another month of silence.
//
//   1. `earned: 'win'` — defined, documented, tested in upgrade.mjs, and never
//      sent by the client. Two of the offer engine's three triggers were dead.
//   2. The sign-up sheet opened 900ms after load, before the visitor had asked
//      anything — a wall in front of 561 arrivals from X on 20 Sep 2026.
//   3. Nothing capped invitations per DAY. "Never twice in a conversation" is
//      not the same as never twice in an afternoon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CONCIERGE = readFileSync(new URL('./concierge.ts', import.meta.url), 'utf8');
const SOCIAL = readFileSync(new URL('./social.ts', import.meta.url), 'utf8');
const UPGRADE = readFileSync(new URL('../../worker/upgrade.mjs', import.meta.url), 'utf8');

test('the client tells the server when something went right', () => {
  assert.match(CONCIERGE, /earned: takeWin\(\)/,
    'the client stopped sending `earned` — the offer engine is back to one live trigger');
  assert.match(CONCIERGE, /const WIN_ACTIONS = new Set\(/,
    'the list of win-shaped actions is gone');
  for (const a of ['add_booking', 'plan_create', 'book_table']) {
    assert.ok(CONCIERGE.includes(`'${a}'`), `${a} is no longer counted as a win`);
  }
});

test('a win is spent once, not once per turn forever', () => {
  const fn = CONCIERGE.slice(CONCIERGE.indexOf('const takeWin'), CONCIERGE.indexOf('function applyAction'));
  assert.match(fn, /winPending = false/, 'takeWin no longer clears the flag — one booking would pitch forever');
});

test('nothing asks a stranger to sign up before Num has answered', () => {
  assert.equal(/setTimeout\(\(\) => \{\s*if \(!store\.get\(\)\.me && !store\.get\(\)\.inviteOpen\)/.test(SOCIAL), false,
    'the 900ms sign-up wall is back — it stands in front of every arrival');
  assert.match(CONCIERGE, /maybeAskToJoin\(\);/, 'the join ask is no longer called after a reply');
});

test('the join ask stops for good once they have an account', () => {
  const fn = CONCIERGE.slice(CONCIERGE.indexOf('export function maybeAskToJoin'), CONCIERGE.indexOf('function push'));
  assert.match(fn, /if \(s\.me\) return;/,
    'a member can be asked to sign up again — which reads as the app forgetting them');
  assert.match(fn, /turns >= 1 && asked < 1/, 'the first ask no longer waits for an answer');
  assert.match(fn, /turns >= 3 && asked < 2/, 'the single reminder is gone');
});

test('invitations are capped to one a day, and only the proactive ones', () => {
  assert.match(UPGRADE, /const CAPPED = new Set\(\['win', 'limit'\]\)/,
    'the daily cap no longer names which reasons it covers');
  const capped = UPGRADE.slice(UPGRADE.indexOf('const CAPPED'), UPGRADE.indexOf('const CAPPED') + 80);
  assert.equal(capped.includes('asked'), false,
    '`asked` has been added to the daily cap — refusing to quote a price to somebody who asked is not restraint');
  assert.match(UPGRADE, /await markOfferedToday\(env, memberId\)/,
    'the day is never marked as spent, so the cap can never bite');
});

test('the cap fails open, so a broken counter cannot silence Num', () => {
  const fn = UPGRADE.slice(UPGRADE.indexOf('export async function offeredToday'), UPGRADE.indexOf('export async function markOfferedToday'));
  assert.match(fn, /return false;/, 'offeredToday no longer fails open on a read error');
});
