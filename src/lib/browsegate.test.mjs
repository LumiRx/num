// LOOKING IS NOT SENDING.
//
// Dre, 19 Sep 2026: "if you don't invite a friend it doesn't search on the
// widgets. I tried flights and hotels, same thing — if you don't invite a
// friend it won't search or populate in chat."
//
// Two bugs wearing one coat. A feature page composes its question and hands
// it to askNum(), so filling in a flight search WAS sending a message and the
// send gate refused it — and the sheet the refusal opened was the bare invite
// draft, whose first screen is about inviting people. So the app answered
// "search my flights" with "invite a friend".
//
// This file holds both halves down: the lookup goes through, and the sheet
// that does open asks for the thing it actually wants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const code = (p) => read(p)
  // Only line-leading block comments: a bare /\*[\s\S]*?\*\/ also matches the
  // `/*` inside a regex literal and swallows whatever sits above it.
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');

const gate = read('./gate.ts');
const gateCode = code('./gate.ts');
const concierge = code('./concierge.ts');
const sendgate = code('../../worker/sendgate.mjs');
const sendgateRaw = read('../../worker/sendgate.mjs');

/* ── the client half ───────────────────────────────────────────────────── */

test('a browse ask does not need a proved number, but does need a member', () => {
  assert.match(gateCode, /export const mayBrowse[^\n]*=>\s*!!me\?\.id/,
    'mayBrowse has stopped requiring a member — an anonymous device would be let through');
  assert.match(gateCode, /if \(opts\?\.browse && mayBrowse\(s\.me\)\) return true;/,
    'mayAsk no longer honours the browse flag');
});

test('the free-answer gate is untouched for ordinary messages', () => {
  // The loosening is for lookups only. A typed question from somebody NUM
  // cannot reach is still the thing the gate was built for.
  assert.match(gateCode, /return gateOpen\(s\.me, s\.msgs\);/);
  assert.match(gateCode, /export const FREE_ANSWERS = 1;/);
});

test('askNum takes the flag and passes it to the server', () => {
  assert.match(concierge, /export async function askNum\(text: string, opts\?: \{ browse\?: boolean \}\)/);
  assert.match(concierge, /mayAsk\(\{ browse: opts\?\.browse \}\)/);
  assert.match(concierge, /opts\?\.browse \? \{ browse: true \} : \{\}/,
    'the flag never reaches the worker, so the server gate still refuses the search');
});

test('the widgets that search are marked as lookups', () => {
  for (const [file, what] of [
    ['../components/app/FeaturePage.tsx', 'the feature pages — flights and stays among them'],
    ['../components/app/DayWidgets.tsx', 'the trip-check widget'],
    ['../components/app/DashView.tsx', 'the "when should I leave" widget'],
  ]) {
    assert.match(code(file), /askNum\([\s\S]{0,200}?\{ browse: true \}\)/, `${what} still sends as a message`);
  }
});

test('the things that create an obligation are NOT marked as lookups', () => {
  // A booking, a bill, a plan or an invite has to reach somebody afterwards.
  // That is the gate's whole reason and it keeps applying to them.
  for (const file of [
    '../components/app/TonightStrip.tsx',    // "get me a table tonight"
    '../components/app/DiscoverSheet.tsx',   // "book it if you can"
    // Its three rails read "whether you can get us in" and "hold us a table
    // if they take them". Marked browse for an hour on 20 Sep, which was
    // wrong by the rule two tests up: those create something to deliver.
    '../components/app/NightlifeSheet.tsx',
  ]) {
    assert.ok(!/browse: true/.test(code(file)), `${file} marked a booking as a lookup`);
  }
});

/* ── the sheet that opens ──────────────────────────────────────────────── */

test('a refusal opens the ACCOUNT screen, never the invite-a-friend one', () => {
  assert.ok(!/inviteOpen: \{\},/.test(gateCode.replace(/needAccount[\s\S]*/, '')),
    'holdAndAsk still opens the bare invite draft');
  assert.match(gateCode, /inviteOpen: \{ intent: 'account' \}/);
  assert.match(concierge, /store\.set\(\{ inviteOpen: \{ intent: 'account' \} \}\);/,
    'the 403 path still lands the person on invite-a-friend');
});

/* ── the server half ───────────────────────────────────────────────────── */

test('the worker honours browse, with a member id and a finite cap', () => {
  assert.match(sendgate, /export const BROWSE_CAP = \d+;/);
  assert.match(sendgate, /if \(body\?\.browse === true\)/);
  // It sits BELOW the member lookup, so an unknown id is still refused.
  assert.ok(sendgate.indexOf('unknown_member') < sendgate.indexOf('browse === true'),
    'the browse allowance is checked before we know the member exists');
  assert.match(sendgate, /FROM num_asks WHERE member_id = \?1 AND ts >/,
    'the cap counts nothing, or counts a column num_asks does not have');
});

test('the browse cap fails open by one, not closed', () => {
  // If the ask log cannot be read we let the search through. Telling a
  // signed-in member their search is broken because our telemetry is would be
  // the wrong way round.
  assert.match(sendgate, /if \(!Number\.isFinite\(n\) \|\| n < BROWSE_CAP\) return \{ ok: true, reason: 'browse' \};/);
});

test('the reason the door opened is written down where the next person reads it', () => {
  // Not decoration. This file loosens a gate that was added deliberately
  // three days ago; an unexplained loosening gets reverted by whoever finds
  // it next, and then the widgets break again.
  assert.match(gate, /LOOKING IS NOT SENDING/);
  assert.match(sendgateRaw, /NOT A SECURITY CONTROL/,
    'the worker does not say plainly that the flag is client-set');
});
