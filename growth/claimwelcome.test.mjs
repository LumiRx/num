// The claim receipt: language routing, and the four things it must never say.
//
// Before 25 Aug 2026 a business that claimed its listing got a green screen
// and nothing else — no receipt in its inbox, nothing to forward to an owner,
// no address to reply to. These tests pin the shape of the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('./worker.js', import.meta.url)), 'utf8');

const fn = () => {
  const i = SRC.indexOf('async function sendClaimWelcome(');
  assert.ok(i > 0, 'sendClaimWelcome not found');
  return SRC.slice(i, SRC.indexOf('\n}\n', i));
};

/* ── language ───────────────────────────────────────────────────────────── */

test('Thai is chosen by COUNTRY, not by destination', () => {
  const f = fn();
  // dest would be wrong: a Thai business outside Phuket would get English.
  assert.match(f, /String\(c\.country \|\| ""\)\.toUpperCase\(\) === "TH"/);
  assert.doesNotMatch(f, /c\.dest[^)]*=== *["']phuket["']/);
});

test('both languages actually exist in the body', () => {
  const f = fn();
  const thai = [...f].filter((ch) => ch >= '฀' && ch <= '๿').length;
  assert.ok(thai > 200, `expected real Thai copy, found ${thai} Thai characters`);
  assert.match(f, /We have your claim for/);
});

/* ── it is a receipt, not a campaign ────────────────────────────────────── */

test('it does not gate on marketing consent', () => {
  // Transactional: it is the receipt for a form they just submitted. Gating it
  // on marketing_ok would mean the people most careful about their data are
  // the ones who get no confirmation that their claim landed.
  assert.doesNotMatch(fn(), /marketing_ok/);
});

test('it says out loud that claiming does not sign you up for marketing', () => {
  const f = fn();
  assert.match(f, /not be added to a marketing list/);
  assert.match(f, /ไม่ส่งอีเมลการตลาด/);
});

test('a reply address is set, because the email invites a reply', () => {
  assert.match(fn(), /reply_to:/);
});

test('it is idempotent, so a double form submit is one receipt', () => {
  assert.match(fn(), /__idem: "claimwelcome-"/);
});

/* ── the four claims that are not true yet ──────────────────────────────── */

test('it promises nothing the product cannot do today', () => {
  const f = fn();
  const forbidden = [
    [/book(ing)? (a )?table/i, 'the booking desk returns 503'],
    [/\bQR\b/, 'num_paylinks has zero rows — no venue has a pay link'],
    [/\d{1,2}\s?%/, '/business/ and commission.mjs disagree on the fee'],
    [/top of the (list|results)/i, 'gate.test.mjs fails the build on this'],
  ];
  for (const [re, why] of forbidden) {
    assert.doesNotMatch(f, re, `claim receipt must not mention this — ${why}`);
  }
});

/* ── wiring ─────────────────────────────────────────────────────────────── */

test('it is fired from claims() and never blocks the response', () => {
  const i = SRC.indexOf('async function claims(');
  const claims = SRC.slice(i, SRC.indexOf('async function sendClaimWelcome(', i));
  assert.match(claims, /ctx\.waitUntil\(sendClaimWelcome\(/,
    'must be waitUntil — a Resend outage must not fail or delay a claim');
  assert.match(claims, /\.catch\(\(\) => \{\}\)/);
  // Only when we actually have somewhere to send it.
  assert.match(claims, /if \(email && ctx/);
  // And after the row is committed, so the receipt never outruns the record.
  assert.ok(
    claims.indexOf('await env.DB.batch(work)') < claims.indexOf('ctx.waitUntil(sendClaimWelcome'),
    'the claim must be written before the receipt goes out',
  );
});
