// THE MENU, AND THE END OF THE PER-BOOKING FEE (7 Sep 2026).
//
// Two changes in one pass, and they are the same change seen twice: NUM stops
// taxing the host for using the product, and starts making it easy for their
// client to ask. Revenue is the subscription. Everything else is the service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOOKING_FEE_MINOR, bookingFeeFor } from '../worker/servicefee.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const worker = read('growth/worker.js');
const memberPage = read('public/my-host/index.html');
const hostsPage = read('public/hosts/index.html');
const consolePage = read('public/host/index.html');

/* ── 1. THE FEE IS GONE, AND STAYS GONE ──────────────────────────────── */

test('the per-booking fee is zero at its one definition', () => {
  assert.equal(BOOKING_FEE_MINOR, 0, 'the per-booking fee is back — that was removed on purpose');
});

test('nobody is charged for a booking, hosted or not', async () => {
  const db = (row) => ({ DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) } });
  for (const [label, row] of [['hosted', { host_id: 'h_1' }], ['unhosted', null]]) {
    const f = await bookingFeeFor(db(row), 'm_1');
    assert.equal(f.fee_minor, 0, `${label}: a fee came back`);
    assert.equal(f.member_pays_minor, 0, `${label}: the member is being charged`);
    assert.equal(f.payer, 'nobody', `${label}: somebody is still named as the payer`);
  }
});

test('confirming a booking cannot accrue anything', () => {
  // The write is kept so history survives and so a future fee has one home.
  // What matters is that the value it stamps is the zero constant, not a
  // literal somebody could raise here without touching servicefee.mjs.
  const reqs = worker.slice(worker.indexOf('async function hostRequests'), worker.indexOf('async function hostNetwork'));
  assert.match(reqs, /booking_fee_minor = CASE WHEN \? = 'confirmed'/, 'the fee write vanished — history will not survive');
  assert.ok(!/BOOKING_FEE_MINOR\s*=\s*[1-9]/.test(worker), 'a non-zero fee has been reintroduced in the growth worker');
  assert.match(reqs, /BOOKING_FEE_MINOR/, 'the fee write no longer reads the shared constant');
});

test('the invoicing sweep can never find anything to bill', () => {
  // worker/hostmoney.mjs selects `booking_fee_minor > 0`. With the constant at
  // zero nothing new qualifies — which is why the sweep did not need editing.
  const money = read('worker/hostmoney.mjs');
  assert.match(money, /booking_fee_minor > 0/,
    'the sweep no longer filters on a positive fee — with the fee at 0 it could now invoice zero-value rows');
});

test('a charge appearing after the change is treated as a breach', () => {
  const integ = read('worker/hostintegrity.mjs');
  assert.match(integ, /fee_charged_after_it_was_removed/,
    'nothing reports a per-booking fee creeping back in');
  assert.ok(!/confirmed_without_fee/.test(integ),
    'the check that demanded a fee on confirmed work is still there — it now fails on correct data');
});

test('no surface still promises a per-booking fee', () => {
  for (const [name, page] of [['/hosts/', hostsPage], ['console', consolePage],
                              ['flyer', read('public/flyers/hosts/index.html')]]) {
    assert.ok(!/&pound;5 (per|for each|when you)|£5 (per|for each|when you)/.test(page),
      `${name} still advertises a per-booking fee`);
  }
  const mail = worker.slice(worker.indexOf('subject: "Your NUM host account'), worker.indexOf('This is your invite link'));
  assert.ok(!/£5/.test(mail), 'the welcome email still promises a £5 booking fee');
  assert.match(mail, /no fee per booking/i, 'the welcome email does not say there is no per-booking fee');
});

test('the pages say what replaced it', () => {
  assert.match(hostsPage, /no fee per booking, no commission on your work/i,
    '/hosts/ does not state the new model');
  assert.match(consolePage, /Confirming costs you nothing/i,
    'the console does not tell a host that confirming is free');
});

/* ── 2. THE MENU ─────────────────────────────────────────────────────── */

test('the client is shown their host’s own services, at their host’s own prices', () => {
  const link = worker.slice(worker.indexOf('async function memberLink'), worker.indexOf('async function hostClose'));
  assert.match(link, /const menu = \(\) =>/, 'the menu is gone');
  assert.match(link, /services: menu\(\)/, 'the menu is not returned to the client');
  // Built from the host's own two columns, so a price can never appear here
  // that the host did not set.
  assert.match(link, /hostRow\.services_json/, 'the menu is not built from the services the host ticked');
  assert.match(link, /hostRow\.pricing_json/, 'the menu is not built from the host’s own price list');
  assert.match(link, /line\.unit === "quote" \? null/,
    'a "agreed per request" line is given a number — that is a quote the host never gave');
});

test('a client can only ask for something their host actually offers', () => {
  const link = worker.slice(worker.indexOf('async function memberLink'), worker.indexOf('async function hostClose'));
  assert.match(link, /if \(!offered\) return J\(\{ ok: false, error: "not_offered" \}/,
    'a request can be made for a service the host does not do');
  assert.match(link, /host_status !== "active"/, 'a closed host can still be sent work');
  assert.match(link, /row\.status === "removed"/, 'a client who left can still send requests');
});

test('the ask lands where the existing notifier will find it', () => {
  // source='client' and host_notified_at NULL is exactly what
  // worker/hostaware.mjs sweeps for. Building a second notifier here would be
  // how a host gets told twice, or not at all.
  const link = worker.slice(worker.indexOf('async function memberLink'), worker.indexOf('async function hostClose'));
  assert.match(link, /'new','client'/, "the request is not marked as coming from the client");
  assert.ok(!/notifyHostOfRequest/.test(link),
    'the client path sends its own notification — that duplicates the hostaware sweep');
  const aware = read('worker/hostaware.mjs');
  assert.match(aware, /r\.source = 'client' AND r\.host_notified_at IS NULL/,
    'the sweep no longer picks up client-made requests');
});

test('the price shown is frozen at the moment of asking', () => {
  const link = worker.slice(worker.indexOf('async function memberLink'), worker.indexOf('async function hostClose'));
  assert.match(link, /line\.price_minor \|\| 0, line\.currency/,
    'the request does not copy the price — a later edit to the host’s list would change what this client was quoted');
});

test('nothing is committed to the client by asking', () => {
  const link = worker.slice(worker.indexOf('async function memberLink'), worker.indexOf('async function hostClose'));
  assert.match(link, /'new','client'/, 'a client request does not start in the new state');
  assert.ok(!/'confirmed'/.test(link.slice(link.indexOf('action === "ask"'), link.indexOf('if (action !== "leave")'))),
    'the client path can reach a confirmed state — only the host may confirm');
  assert.match(link, /Nothing is booked until they confirm/i,
    'the client is not told that nothing is booked yet');
});

/* ── 3. THE SHEET ────────────────────────────────────────────────────── */

test('the menu is a real dialog, not a div pretending to be one', () => {
  // <dialog> gives focus trapping, Escape and an inert background for free. A
  // hand-rolled modal gets all three wrong in ways only a keyboard user hits.
  assert.match(memberPage, /<dialog class="sheet" id="menuSheet">/, 'the menu is not a dialog');
  assert.match(memberPage, /showModal\(\)/, 'the menu is not opened as a modal');
  assert.match(memberPage, /::backdrop/, 'the dialog has no backdrop styling');
});

test('the sheet handles a host who has not finished their profile', () => {
  assert.match(memberPage, /They have not listed their services yet/i,
    'an empty menu renders as a blank box that looks broken');
});

test('a quoted price and an on-request price read differently', () => {
  assert.match(memberPage, /if \(m\.price_minor == null \|\| !m\.price_minor\) return 'On request'/,
    'a line with no price renders as a number — "£0.00" reads as free');
});
