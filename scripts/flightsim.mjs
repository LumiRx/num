#!/usr/bin/env node
// Drive one flight booking from a fare to a confirmation, and print every
// step of it.
//
//   node scripts/flightsim.mjs            the happy path
//   node scripts/flightsim.mjs --family   two adults and a toddler, which is
//                                         where the interesting failures are
//   node scripts/flightsim.mjs --out DIR  also write the artifacts to disk
//
// This is not a test — the tests assert. This exists so a person can read the
// whole flow in one screen and see the exact words a traveller would get.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  startBooking, apply, nextPrompt, remaining, preflight, readyToIssue, bookingBlock, STATE,
} from '../worker/flightbooking.mjs';
import { issue, canIssue, canSimulate } from '../worker/issuer.mjs';
import { amountFor, purchase, payBlock, PAY } from '../worker/flightpay.mjs';
import { confirmations } from '../worker/flightconfirm.mjs';

const argv = process.argv.slice(2);
const FAMILY = argv.includes('--family');
// --fail-issue makes the ticket fail after the hold is placed, so the unwind
// can be watched. --fail-capture makes the money fail after the ticket.
const FAIL_ISSUE = argv.includes('--fail-issue') ? 'issue' : argv.includes('--fail-capture') ? 'capture' : null;
const OUT = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const rule = (t = '') => console.log(`\n${DIM('─'.repeat(72))}${t ? `\n${B(t)}` : ''}`);

/* The fare. Shaped exactly as a real offer from Sabre or a partner API would
   be, so nothing downstream has to change when one arrives. */
const OFFER = {
  carrier: 'EK',
  carrier_name: 'Emirates',
  flight_no: '007',
  origin: 'DXB',
  origin_name: 'Dubai International',
  dest: 'LHR',
  dest_name: 'London Heathrow',
  depart_date: '2026-09-14',
  depart_time: '08:30',
  arrive_time: '13:15',
  duration: '7h 45m',
  return_date: '2026-09-21',
  return_flight_no: '008',
  return_depart_time: '14:30',
  return_arrive_time: '00:35',
  cabin: 'Economy',
  baggage: '25kg checked + 7kg cabin',
  currency: 'USD',
  fare_cs: 44500,
  tax_cs: 5500,
  fee_cs: 1500,
  price: 51500,
};

/* What the traveller says, in the order Num asks. Keyed by field so the
   script answers whatever is asked next rather than assuming an order — if
   the field order changes, this still runs. */
const SOLO = [{
  given_name: 'Alexandra', family_name: 'Johnson', dob: '1991-04-08',
  nationality: 'GB', passport_number: '561234789', passport_expiry: '2031-02-17',
}];

const FAMILY_PAX = [
  { given_name: 'Alexandra', family_name: 'Johnson', dob: '1991-04-08', nationality: 'GB', passport_number: '561234789', passport_expiry: '2031-02-17' },
  // Passport expires two months after the trip. Valid on the day, and the
  // airline will still refuse him at the desk.
  { given_name: 'Michael', family_name: 'Johnson', dob: '1988-11-30', nationality: 'GB', passport_number: '498771230', passport_expiry: '2026-11-20' },
  // Born 2024-09-20: an infant outbound on the 14th, two years old on the
  // return on the 21st.
  { given_name: 'Rosa', family_name: 'Johnson', dob: '2024-09-20', nationality: 'GB', passport_number: '773410882', passport_expiry: '2029-06-01' },
];

const CONTACT = { email: 'alex.johnson@example.com', phone: '+447700900123' };

const PAX = FAMILY ? FAMILY_PAX : SOLO;

/* ── 1. THE FARE ─────────────────────────────────────────────────────── */
rule('1 · A FARE IS CHOSEN');
let booking = startBooking(OFFER, PAX.length);
console.log(`${OFFER.carrier_name} ${OFFER.carrier}${OFFER.flight_no}  ${OFFER.origin} → ${OFFER.dest}`);
console.log(`${OFFER.depart_date} ${OFFER.depart_time} → ${OFFER.arrive_time}  ·  returning ${OFFER.return_date}`);
console.log(`${(OFFER.price / 100).toFixed(2)} USD for ${PAX.length} passenger${PAX.length === 1 ? '' : 's'}`);
console.log(DIM(`state: ${booking.state}`));

/* ── 2. COLLECTION ───────────────────────────────────────────────────── */
rule('2 · NUM COLLECTS, ONE THING AT A TIME');
let asked = 0;
let guard = 0;
while (guard++ < 50) {
  const p = nextPrompt(booking);
  if (!p) break;
  asked += 1;
  const value = p.per === 'booking' ? CONTACT[p.key] : PAX[p.index][p.key];

  const who = p.per === 'passenger' && PAX.length > 1 ? ` ${DIM(`(${p.who})`)}` : '';
  console.log(`\n${B('Num')}  asks for ${p.ask}${who}`);
  if (p.why) console.log(DIM(`      because ${p.why}`));
  console.log(`${B('Them')} ${value}`);

  const r = apply(booking, p.key, value, p.index ?? 0);
  if (!r.ok) {
    console.log(R(`      ✗ ${r.error}`));
    break;
  }
  booking = r.booking;
  const rem = remaining(booking);
  console.log(DIM(`      ${rem.have}/${rem.total} collected`));
}
console.log(`\n${asked} questions asked. state: ${B(booking.state)}`);

/* ── 3. A REJECTED ANSWER ────────────────────────────────────────────── */
rule('3 · WHAT A BAD ANSWER DOES');
for (const [k, v] of [['passport_number', 'ABC'], ['phone', '07700 900123'], ['dob', 'about 1991']]) {
  const r = apply(booking, k, v, 0);
  console.log(`${B('Them')} ${k} = "${v}"`);
  console.log(`${R('      ✗')} ${r.error}`);
  console.log(DIM('      the booking is unchanged — a bad answer never half-applies'));
}

/* ── 4. PREFLIGHT ────────────────────────────────────────────────────── */
rule('4 · THE CHECKS THAT HAPPEN BEFORE ANY MONEY MOVES');
const pf = preflight(booking);
if (!pf.blocking.length && !pf.warnings.length) console.log(G('Nothing to flag. This trip works.'));
for (const b of pf.blocking) console.log(`${R('BLOCKING')}  ${b.message}\n${DIM(`          code: ${b.code}`)}`);
for (const w of pf.warnings) console.log(`${Y('NOTE')}      ${w.message}`);

const ready = readyToIssue(booking);
console.log(`\nreadyToIssue: ${ready.ok ? G('yes') : R(`no — ${ready.reason}`)}`);

/* ── 5. WHAT THE CONCIERGE IS TOLD ───────────────────────────────────── */
rule('5 · THE PROMPT BLOCK THE MODEL ACTUALLY SEES');
console.log(DIM(bookingBlock(booking).trim()));

if (!ready.ok) {
  rule('STOPPED');
  console.log(R('This booking cannot be issued, and Num will not take the money.'));
  console.log('Fix the blocking items above and run again.\n');
  process.exit(0);
}

/* ── 5b. THE MONEY, READ BACK ────────────────────────────────────────── */
rule('6 · WHAT THEY ARE TOLD BEFORE THEY PAY');
console.log(DIM(payBlock(booking, {}).trim()));

/* ── 6. AUTHORISE → ISSUE → CAPTURE ──────────────────────────────────── */
rule('7 · AUTHORISE → ISSUE → CAPTURE');
const env = { FLIGHT_ISSUER: 'simulated' };
console.log(`issuer configured: ${B('simulated')}`);
console.log(`canSimulate: ${canSimulate(env)}   canIssue (real tickets): ${canIssue(env) ? R('true') : G('false')}`);
console.log(DIM('the simulator can never make canIssue true — the concierge still says Num cannot book'));

booking.state = STATE.ISSUING;
let seed = 42;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

// A Stripe stub, so the sequence is real and no money is touched. Every call
// is printed, in the order it actually happens.
const stripeCalls = [];
globalThis.fetch = async (url, init) => {
  const path = String(url).replace('https://api.stripe.com/v1', '');
  stripeCalls.push(path);
  const fail = FAIL_ISSUE && path.endsWith('/capture');
  const body = path === '/payment_intents' ? { id: 'pi_sim1', client_secret: 'pi_sim1_secret', status: 'requires_capture' }
    : path.endsWith('/capture') ? { id: 'pi_sim1', status: 'succeeded', amount_received: amountFor(OFFER).total_cs }
      : path.endsWith('/cancel') ? { id: 'pi_sim1', status: 'canceled' } : {};
  return { ok: !fail, status: fail ? 402 : 200, json: async () => (fail ? { error: { message: 'declined' } } : body) };
};

const amt = amountFor(OFFER);
console.log(`\namount   ${(amt.total_cs / 100).toFixed(2)} ${amt.currency.toUpperCase()}`);
console.log(`          fare ${(amt.fare_cs / 100).toFixed(2)} + tax ${(amt.tax_cs / 100).toFixed(2)} + Num fee ${(amt.fee_cs / 100).toFixed(2)}`);
console.log(DIM(`          ours ${(amt.ours_cs / 100).toFixed(2)} · passing through ${(amt.passthrough_cs / 100).toFixed(2)}`));

const bought = await purchase({ STRIPE_SECRET_KEY: 'sk_test_sim' }, booking, {
  ref: 'NUMSIM001',
  issueFn: async () => {
    const r = await issue(env, booking, { rand, now: () => new Date('2026-08-30T18:42:00Z') });
    if (FAIL_ISSUE === 'issue') return { ok: false, error: 'no_seats', message: 'The fare went while they were typing.' };
    return r;
  },
});

console.log(`\nStripe calls, in order:`);
for (const c of stripeCalls) console.log(`  ${c}`);

if (!bought.ok) {
  console.log(`\n${R('purchase failed at: ' + bought.stage)}`);
  console.log(bought.message);
  if (bought.voided) console.log(G('The hold was cancelled. No money moved.'));
  if (bought.needsHuman) console.log(R('TICKET EXISTS, MONEY DID NOT ARRIVE — a human must resolve this.'));
  console.log('');
  process.exit(0);
}

const issued = bought.issued;
booking.state = STATE.ISSUED;
console.log(`\ncaptured ${G((bought.captured_cs / 100).toFixed(2) + ' ' + amt.currency.toUpperCase())} — after the ticket, never before`);
console.log(`\nresult: ${issued.ok ? G('issued') : R('failed')}`);
console.log(`reference   ${B(issued.reference)}`);
console.log(`airline ref ${issued.airline_ref}`);
for (const t of issued.tickets) console.log(`ticket      ${t.passenger.padEnd(22)} ${t.number}`);

/* ── 7. CONFIRMATIONS ────────────────────────────────────────────────── */
const out = confirmations(booking, issued);

rule('8 · THE EMAIL — SUBJECT');
console.log(out.email.subject);

rule('8 · THE EMAIL — PLAIN TEXT');
console.log(out.email.text);

rule('9 · THE SMS');
console.log(`to ${out.sms.to}`);
console.log(`${B(out.sms.body)}`);
console.log(DIM(`${out.sms.length} chars · ${out.sms.segments} segment${out.sms.segments === 1 ? '' : 's'}`));

rule('10 · THE DAY-BEFORE REMINDER');
console.log(`${B(out.reminder.body)}`);
console.log(DIM(`${out.reminder.length} chars · ${out.reminder.segments} segment${out.reminder.segments === 1 ? '' : 's'}`));

if (OUT) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'confirmation.html'), out.email.html);
  writeFileSync(join(OUT, 'confirmation.txt'), `Subject: ${out.email.subject}\nTo: ${out.email.to}\n\n${out.email.text}`);
  writeFileSync(join(OUT, 'messages.txt'),
    `CONFIRMATION SMS → ${out.sms.to}\n${out.sms.body}\n\nREMINDER SMS → ${out.reminder.to}\n${out.reminder.body}\n`);
  writeFileSync(join(OUT, 'booking.json'), JSON.stringify({ booking, issued, itinerary: out.itinerary }, null, 2));
  rule('WRITTEN');
  console.log(`${OUT}/confirmation.html\n${OUT}/confirmation.txt\n${OUT}/messages.txt\n${OUT}/booking.json`);
}
console.log('');
