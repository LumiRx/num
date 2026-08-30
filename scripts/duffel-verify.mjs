#!/usr/bin/env node
/**
 * NUM · Duffel live verification
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * worker/duffel.mjs passed 29 tests before it had ever sent a packet. Every
 * one of those tests ran against responses transcribed from Duffel's own
 * documentation, so a green run proved that the code does what the docs
 * describe — and nothing whatsoever about whether Duffel agrees. Those are
 * different claims and the gap between them is where integrations die: a
 * header Duffel stopped accepting, a version string that moved, a token with
 * the wrong scopes, an account that is not through KYC.
 *
 * This script closes that gap and only that gap. It runs on the machine that
 * HAS the token — Andre's Mac — because the agent that wrote it does not have
 * one and must not.
 *
 * ── WHAT IT DOES, AND WHAT IT REFUSES TO DO ──────────────────────────────
 *
 *   1. Loads the token and says which ESTATE it is (test or live), read off
 *      the token prefix rather than off any config, because config can lie
 *      about a credential and a prefix cannot.
 *   2. Runs ONE real offer request against api.duffel.com for a fixed route.
 *      Searching is free in both estates. This is the only network call it
 *      makes on purpose.
 *   3. Prints the offer count and the cheapest offer, in full, so a human can
 *      see that the numbers are real numbers.
 *   4. Attempts a create — and asserts it is REFUSED by the gate in
 *      worker/duffel.mjs. It catches the refusal and reports it as a pass.
 *      It never sets a flag, never passes adminKey, never edits an env var to
 *      get past anything. A verification script that unlocks the thing it is
 *      verifying is not a verification script.
 *
 * Two independent safeties sit under step 4, because one safety is a safety
 * nobody checks:
 *
 *   · If `permitted(env, 'create')` reports the gate is OPEN, the create is
 *     NOT attempted at all and the script FAILS. An open commit gate is not a
 *     pass with a warning — it is the exact state the go-live checklist in
 *     HQ/divisions/num/DUFFEL_INTEGRATION.md exists to prevent, and finding it
 *     unexpectedly means stop.
 *   · `fetch` is wrapped for the whole run so that a POST to /air/orders or
 *     /air/order_cancellations throws locally instead of leaving the machine.
 *     If the gate ever failed to fire, this is what stands between a test run
 *     and a real ticket on a real credit line.
 *
 * ── RUNNING IT ───────────────────────────────────────────────────────────
 *
 *   DUFFEL_ACCESS_TOKEN='duffel_…' node scripts/duffel-verify.mjs
 *
 * or put DUFFEL_ACCESS_TOKEN in .dev.vars (gitignored) and just:
 *
 *   node scripts/duffel-verify.mjs
 *
 * Exit 0 means every check passed. Any other exit code means at least one did
 * not, and the failing line says which. The token is never printed, never
 * written to a file, and never sent anywhere except api.duffel.com's own
 * Authorization header.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  duffelReady, duffelMode, duffelCommitState, permitted,
  searchOffers, normalizeOffers, createOrder,
} from '../worker/duffel.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── output ────────────────────────────────────────────────────────────────
const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[1m', d: '\x1b[2m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', b: '', d: '', x: '' };

let failures = 0;
const pass = (msg, detail) => console.log(`  ${C.g}PASS${C.x}  ${msg}${detail ? `\n        ${C.d}${detail}${C.x}` : ''}`);
const fail = (msg, detail) => {
  failures += 1;
  console.log(`  ${C.r}FAIL${C.x}  ${msg}${detail ? `\n        ${detail}` : ''}`);
};
const rule = (title) => console.log(`\n${C.b}${title}${C.x}\n${'─'.repeat(72)}`);

// ── the token, from the environment or from .dev.vars ────────────────────
//
// .dev.vars is wrangler's local secret file and is gitignored. It is read
// here so that the person running this does not have to paste a live
// credential onto a shell line where it lands in ~/.zsh_history.
function loadToken() {
  if (process.env.DUFFEL_ACCESS_TOKEN) return { token: process.env.DUFFEL_ACCESS_TOKEN.trim(), from: 'process.env' };
  const p = join(ROOT, '.dev.vars');
  if (!existsSync(p)) return { token: null, from: null };
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*DUFFEL_ACCESS_TOKEN\s*=\s*(.*)$/.exec(line);
    if (m) return { token: m[1].trim().replace(/^["']|["']$/g, ''), from: '.dev.vars' };
  }
  return { token: null, from: null };
}

// ── the money guard ───────────────────────────────────────────────────────
//
// Wrapped for the entire run, not just around the create attempt, so that
// nothing added to this script later can quietly acquire the ability to spend.
const realFetch = globalThis.fetch;
let blocked = 0;
globalThis.fetch = async (url, init = {}) => {
  const path = (() => { try { return new URL(String(url)).pathname; } catch { return String(url); } })();
  const method = String(init.method ?? 'GET').toUpperCase();
  if (method === 'POST' && (path === '/air/orders' || path === '/air/order_cancellations' || /\/actions\/cancel$/.test(path))) {
    blocked += 1;
    const err = new Error(`duffel-verify refuses to send ${method} ${path} — this script never commits.`);
    err.status = 599;
    throw err;
  }
  return realFetch(url, init);
};

// ── the fixed sample route ────────────────────────────────────────────────
//
// LHR→JFK because Duffel Airways (the test-mode carrier) always serves it, so
// the same request is meaningful in both estates and a zero-offer result means
// something is wrong rather than "that route is quiet today". 21 days out:
// far enough that inventory exists, near enough that the fares are real.
const DEPART = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
const ROUTE = {
  slices: [{ origin: 'LHR', destination: 'JFK', departure_date: DEPART }],
  passengers: [{ type: 'adult' }],
  cabin_class: 'economy',
};

const money = (o) => (o.total == null ? '—' : `${o.total} ${o.currency ?? ''}`.trim());

async function main() {
  console.log(`\n${C.b}NUM · Duffel live verification${C.x}  ${C.d}${new Date().toISOString()}${C.x}`);

  // ── 1. the credential ───────────────────────────────────────────────────
  rule('1 · CREDENTIAL');
  const { token, from } = loadToken();
  if (!token) {
    fail('DUFFEL_ACCESS_TOKEN is not set.',
      'Set it in the shell or add it to .dev.vars. In production it belongs in Wrangler:\n        '
      + 'npx wrangler secret put DUFFEL_ACCESS_TOKEN');
    return;
  }
  const env = { DUFFEL_ACCESS_TOKEN: token, ...pickBookingVars() };

  if (!duffelReady(env)) { fail('the token loaded but duffelReady() says no — it is empty or whitespace.'); return; }

  // Shape gate. A malformed token must be diagnosed HERE, in plain English, and
  // never handed to fetch() — an Authorization header rejects any byte above
  // 255 with "Cannot convert argument to a ByteString", which names a character
  // index and tells you nothing about what you actually did wrong. The most
  // common mistake by far is pasting a placeholder from documentation or chat
  // (`duffel_live_…`) instead of the real value; the ellipsis is U+2026 and lands
  // at exactly index 19 of `Bearer duffel_live_…`. Say so.
  const nonAscii = [...token].find((ch) => ch.codePointAt(0) > 126);
  if (nonAscii) {
    const cp = nonAscii.codePointAt(0);
    fail('the token contains a character that cannot go in an HTTP header.',
      `Found ${JSON.stringify(nonAscii)} (U+${cp.toString(16).toUpperCase().padStart(4, '0')}) in a ${token.length}-character value.\n        `
      + (cp === 0x2026
        ? 'That is a horizontal ellipsis — you pasted a PLACEHOLDER, not the token.\n        '
          + 'Copy the real value from the Duffel dashboard (Copy button on the token page).'
        : 'Duffel tokens are plain ASCII. Re-copy the value; something mangled it.'));
    return;
  }
  if (!/^duffel_(test|live)_[A-Za-z0-9_-]+$/.test(token)) {
    fail('the token is not shaped like a Duffel access token.',
      'Expected duffel_test_… or duffel_live_… followed by URL-safe characters.');
    return;
  }
  if (token.length < 30) {
    fail(`the token is only ${token.length} characters — far too short to be real.`,
      'A real Duffel token is ~40-50 characters. You have most likely pasted a truncated\n        '
      + 'or masked value (the dashboard shows it as duffel_live_****…QIJbw). Use the Copy button.');
    return;
  }

  // Shape only. The value is never printed, here or anywhere.
  pass(`token loaded from ${from}`, `prefix "${token.slice(0, 12)}…", ${token.length} characters, no surrounding whitespace: ${token === token.trim()}`);

  // ── 2. the estate ───────────────────────────────────────────────────────
  rule('2 · ESTATE');
  const estate = duffelMode(env);
  if (estate === 'live') {
    console.log(`  ${C.r}${C.b}╔══════════════════════════════════════════════════════════════════╗${C.x}`);
    console.log(`  ${C.r}${C.b}║  ESTATE: LIVE — THIS IS REAL AIRLINE INVENTORY                   ║${C.x}`);
    console.log(`  ${C.r}${C.b}╚══════════════════════════════════════════════════════════════════╝${C.x}`);
    console.log(`  ${C.y}The search below is FREE and takes nothing out of inventory.${C.x}`);
    console.log(`  ${C.y}A commit is NOT free: creating an order on this token spends real${C.x}`);
    console.log(`  ${C.y}money and issues a real ticket. Nothing in this script commits, and${C.x}`);
    console.log(`  ${C.y}every offer id printed below is a live-inventory offer id — do not${C.x}`);
    console.log(`  ${C.y}paste one into anything that creates an order.${C.x}`);
  } else {
    console.log(`  ${C.g}${C.b}ESTATE: TEST${C.x} — Duffel test mode. Play inventory, play money.`);
  }
  pass(`estate detected as "${estate}", read off the token prefix`,
    'The estate cannot be overridden by config; there is one base URL and two kinds of key.');

  // ── 3. a real search ────────────────────────────────────────────────────
  rule('3 · SEARCH (free, holds nothing)');
  console.log(`  ${C.d}POST https://api.duffel.com/air/offer_requests — LHR→JFK ${DEPART}, 1 adult, economy${C.x}`);
  let offers = [];
  let searchOk = false;
  const started = Date.now();
  try {
    const rs = await searchOffers(env, ROUTE);
    offers = normalizeOffers(rs);
    searchOk = true;
    pass(`Duffel answered in ${Date.now() - started}ms`, `offer_request_id ${rs?.id ?? '—'}`);
  } catch (err) {
    fail('the offer request failed.',
      `${err.status ?? '?'} ${err.message}${err.code ? ` (code ${err.code})` : ''}${err.requestId ? `\n        request_id ${err.requestId} — quote this to Duffel support` : ''}`);
    // Deliberately NOT a return. Section 4 asks whether the commit gate is
    // shut, and that question is independent of whether search worked — in
    // fact it matters more when something is already wrong.
  }

  if (searchOk) console.log(`\n  OFFERS RETURNED: ${C.b}${offers.length}${C.x}`);
  if (!searchOk) {
    // The failure above is already counted. Saying nothing more here keeps the
    // report honest: "zero offers" is a different finding from "no answer".
  } else if (!offers.length) {
    fail('zero offers came back.',
      'The call succeeded, so the credential works — but a search that returns nothing is not a working search. '
      + 'Check that the account is through Duffel KYC and has airline content enabled.');
  } else {
    const cheapest = [...offers].sort((a, b) => Number(a.total ?? Infinity) - Number(b.total ?? Infinity))[0];
    const seg = cheapest.slices?.[0]?.segments ?? [];
    console.log(`\n  ${C.b}CHEAPEST${C.x}`);
    console.log(`    price        ${C.b}${money(cheapest)}${C.x}   (base ${cheapest.base ?? '—'} / tax ${cheapest.tax ?? '—'})`);
    console.log(`    airline      ${cheapest.owner ?? '—'} (${cheapest.owner_iata ?? '—'})`);
    console.log(`    offer id     ${cheapest.id}`);
    console.log(`    expires at   ${cheapest.expires_at ?? '—'}`);
    console.log(`    instant pay  ${cheapest.requires_instant_payment === null ? '—' : cheapest.requires_instant_payment}`);
    for (const s of seg) {
      console.log(`    ${s.from}→${s.to}  ${s.depart} → ${s.arrive}  ${s.carrier ?? '—'} ${s.flight ?? ''}  ${s.cabin ?? ''}`);
    }
    pass(`${offers.length} offers, cheapest ${money(cheapest)}`, 'These are real prices from the real API. The mocked tests could not have told you this.');
    if (!cheapest.total || !cheapest.currency) {
      fail('the cheapest offer has no price or no currency after normalization.',
        'normalizeOffers() is reading fields Duffel no longer sends. The app renders this shape.');
    }
  }

  // ── 4. the commit gate ──────────────────────────────────────────────────
  rule('4 · COMMIT GATE (must refuse)');
  const gate = permitted(env, 'create');
  console.log(`  ${C.d}DUFFEL_BOOKING_ENABLED=${fmt(env.DUFFEL_BOOKING_ENABLED)}  DUFFEL_BOOKING_LIVE=${fmt(env.DUFFEL_BOOKING_LIVE)}  commit state: ${duffelCommitState(env)}${C.x}`);

  if (gate.ok) {
    // Deliberately do NOT attempt the create. The gate being open is the
    // finding; proving it by booking something would be insane.
    fail('THE COMMIT GATE IS OPEN.',
      `${C.r}permitted(env,'create') returned ok on a ${estate} token. No create was attempted.\n        `
      + `If this is the live estate, Num can currently issue tickets, and the go-live checklist in\n        `
      + `HQ/divisions/num/DUFFEL_INTEGRATION.md has not been completed. Unset DUFFEL_BOOKING_ENABLED\n        `
      + `and DUFFEL_BOOKING_LIVE before doing anything else.${C.x}`);
  } else {
    pass('the gate refuses a commit before any validation runs', `${gate.status} — ${gate.why}`);

    // Now do it for real: call the function the app would call, and catch the
    // refusal. This proves the refusal happens in the code path, not just in
    // the predicate a caller is trusted to ask first.
    const before = blocked;
    try {
      await createOrder(env, {
        selected_offers: [offers[0]?.id ?? 'off_verify_never_used'],
        passengers: [{
          id: offers[0]?.passenger_ids?.[0] ?? 'pas_verify_never_used',
          given_name: 'Verify', family_name: 'Script', born_on: '1990-01-01',
          gender: 'f', title: 'ms', email: 'verify@example.invalid', phone_number: '+441234567890',
        }],
        payments: [{ type: 'balance', amount: offers[0]?.total ?? '1.00', currency: offers[0]?.currency ?? 'GBP' }],
      }, { idem: `verify-${Date.now()}` });
      fail('createOrder() RETURNED instead of throwing.',
        'A commit path that the gate said was shut has just run. Stop and read worker/duffel.mjs#permitted.');
    } catch (err) {
      if (err.status === 403) {
        pass('createOrder() threw 403 and never reached the network', err.message);
      } else if (err.status === 599) {
        fail('createOrder() got past the gate and tried to POST /air/orders.',
          'The local money guard in this script stopped it. That guard is a backstop, not the design — '
          + 'the gate in worker/duffel.mjs should have refused first. This is a real defect.');
      } else {
        fail(`createOrder() threw something other than the gate refusal: ${err.status ?? '?'} ${err.message}`,
          'Expected a 403 from permitted(). Anything else means the gate is not the first thing that runs.');
      }
    }
    if (blocked > before) fail(`${blocked - before} commit request(s) had to be blocked locally.`, 'The gate did not hold on its own.');
    else pass('nothing was sent to Duffel’s order endpoints', 'The local money guard was never triggered — the gate held on its own.');
  }

  // ── 5. what is still missing ────────────────────────────────────────────
  rule('5 · STILL REQUIRED BEFORE ANY REAL BOOKING');
  for (const line of [
    'a passenger record model — num_members has no DOB, gender, title or email',
    'a form of payment — no funded Duffel Balance and no card on file',
    'Duffel live-mode KYC signed off',
    'the California Seller of Travel registration',
    'a test-mode booking completed first, on a separate duffel_test_ token',
  ]) console.log(`  ${C.y}·${C.x} ${line}`);
  console.log(`  ${C.d}Full checklist: HQ/divisions/num/DUFFEL_INTEGRATION.md § go-live gate${C.x}`);
}

/** Only the two booking switches are read from the environment — nothing else. */
function pickBookingVars() {
  const out = {};
  if (process.env.DUFFEL_BOOKING_ENABLED != null) out.DUFFEL_BOOKING_ENABLED = process.env.DUFFEL_BOOKING_ENABLED;
  if (process.env.DUFFEL_BOOKING_LIVE != null) out.DUFFEL_BOOKING_LIVE = process.env.DUFFEL_BOOKING_LIVE;
  return out;
}
const fmt = (v) => (v == null ? '(unset)' : JSON.stringify(v));

main()
  .catch((err) => { fail('the script itself threw.', err?.stack ?? String(err)); })
  .finally(() => {
    globalThis.fetch = realFetch;
    console.log(`\n${'═'.repeat(72)}`);
    if (failures) {
      console.log(`${C.r}${C.b}VERIFICATION FAILED${C.x} — ${failures} check${failures === 1 ? '' : 's'} did not pass.\n`);
      process.exit(1);
    }
    console.log(`${C.g}${C.b}VERIFICATION PASSED${C.x} — search is live and the commit path is shut.\n`);
    process.exit(0);
  });
