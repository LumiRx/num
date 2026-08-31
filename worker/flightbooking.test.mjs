import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAX, yearsBetween, paxTypeOn, passportValidFor, PASSPORT_MONTHS_REQUIRED,
  FIELDS, PER_PASSENGER, PER_BOOKING, fieldFor,
  STATE, startBooking, apply, nextPrompt, remaining,
  preflight, complete, readyToIssue, bookingBlock,
} from './flightbooking.mjs';
import {
  ISSUERS, SIM_MARK, SIM_PNR_RE, isSimulated, issuerFor, canIssue, canSimulate, issue,
} from './issuer.mjs';
import {
  itinerary, subject, textEmail, htmlEmail, smsConfirm, smsReminder, confirmations, longDate, money, SMS_SEGMENT,
} from './flightconfirm.mjs';
import { canIssueFlight } from './services.mjs';

const OFFER = {
  carrier: 'EK', flight_no: '007', origin: 'DXB', dest: 'LHR',
  origin_name: 'Dubai International', dest_name: 'London Heathrow',
  depart_date: '2026-09-14', depart_time: '08:30', arrive_time: '13:15', duration: '7h 45m',
  return_date: '2026-09-21', return_flight_no: '008', return_depart_time: '14:30', return_arrive_time: '00:35',
  cabin: 'Economy', baggage: '25kg checked + 7kg cabin',
  currency: 'USD', fare_cs: 44500, tax_cs: 5500, fee_cs: 1500, price: 51500,
};

const ADULT = {
  given_name: 'Alexandra', family_name: 'Johnson', dob: '1991-04-08',
  nationality: 'GB', passport_number: '561234789', passport_expiry: '2031-02-17',
};
const CONTACT = { email: 'alex.johnson@example.com', phone: '+447700900123' };

/** Answer whatever is asked next, until nothing is. */
function fill(booking, pax = [ADULT], contact = CONTACT) {
  let b = booking;
  for (let i = 0; i < 60; i++) {
    const p = nextPrompt(b);
    if (!p) break;
    const v = p.per === 'booking' ? contact[p.key] : pax[p.index][p.key];
    const r = apply(b, p.key, v, p.index ?? 0);
    if (!r.ok) throw new Error(`${p.key}: ${r.error}`);
    b = r.booking;
  }
  return b;
}

/* ─────────────────────────────────────────────────────────────────────────
   AGE IS TAKEN AT THE FLIGHT DATE

   A child born 2024-09-20 is an infant leaving on the 14th and two years old
   coming back on the 21st. Ticketed as an infant both ways, the return is
   refused — the airline needs a seat for a two-year-old. Computing age at
   booking time instead of flight time produces exactly that ticket.
   ───────────────────────────────────────────────────────────────────────── */

test('age is calendar-correct, not 365.25 days', () => {
  assert.equal(yearsBetween('1991-04-08', '2026-04-07'), 34, 'the day before the birthday');
  assert.equal(yearsBetween('1991-04-08', '2026-04-08'), 35, 'on the birthday');
  assert.equal(yearsBetween('2024-02-29', '2026-02-28'), 1, 'a leap-day birthday has not come round yet');
  assert.equal(yearsBetween('bad', '2026-01-01'), null);
});

test('the fare type is taken on the day of each flight', () => {
  assert.equal(paxTypeOn('2024-09-20', '2026-09-14'), PAX.INFANT, 'still under two on the way out');
  assert.equal(paxTypeOn('2024-09-20', '2026-09-21'), PAX.CHILD, 'two years old on the way back');
  assert.equal(paxTypeOn('2015-01-01', '2026-09-14'), PAX.CHILD);
  assert.equal(paxTypeOn('2014-01-01', '2026-09-14'), PAX.ADULT, 'twelve is an adult fare');
  assert.equal(paxTypeOn('2027-01-01', '2026-09-14'), null, 'not born yet is not a passenger');
});

test('a birthday mid-trip is BLOCKING, not a note', () => {
  const infant = { ...ADULT, given_name: 'Rosa', dob: '2024-09-20' };
  const b = fill(startBooking(OFFER, 2), [ADULT, infant]);
  const pf = preflight(b);
  const hit = pf.blocking.find((x) => x.code === 'pax_type_changes');
  assert.ok(hit, 'a ticket the airline refuses on the return is not a warning');
  assert.match(hit.message, /infant on the way out and a child on the way back/);
});

/* ─────────────────────────────────────────────────────────────────────────
   THE SIX-MONTH PASSPORT RULE

   The single most common denied boarding there is, and it is knowable the
   moment we have the expiry date. Selling somebody a ticket we already know
   they cannot use is worse than refusing to sell it.
   ───────────────────────────────────────────────────────────────────────── */

test('six months beyond the LAST flight, not the first', () => {
  assert.equal(PASSPORT_MONTHS_REQUIRED, 6);
  assert.equal(passportValidFor('2027-03-21', '2026-09-21').ok, true, 'exactly six months is enough');
  assert.equal(passportValidFor('2027-03-20', '2026-09-21').ok, false, 'one day short is not');
  assert.equal(passportValidFor('2026-11-20', '2026-09-21').expired, false, 'valid on the day of travel');
  assert.equal(passportValidFor('2026-11-20', '2026-09-21').ok, false, 'and still refused at the desk');
});

test('a passport valid on the day but short of six months blocks the booking', () => {
  const short = { ...ADULT, given_name: 'Michael', passport_expiry: '2026-11-20' };
  const b = fill(startBooking(OFFER, 1), [short]);
  const r = readyToIssue(b);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'preflight');
  const hit = r.blocking.find((x) => x.code === 'passport_six_months');
  assert.match(hit.message, /valid to at least 2027-03-21/, 'tell them the date, not just the rule');
  assert.match(hit.message, /Renew first/, 'a refusal with no way forward is a dead end');
});

test('a passport that expires before the flight is its own, blunter message', () => {
  const dead = { ...ADULT, passport_expiry: '2026-09-01' };
  const b = fill(startBooking(OFFER, 1), [dead]);
  const hit = preflight(b).blocking.find((x) => x.code === 'passport_expired');
  assert.ok(hit);
  assert.match(hit.message, /before they travel/);
});

test('more infants than laps is refused', () => {
  const inf = (n) => ({ ...ADULT, given_name: n === 1 ? 'Rosa' : 'Elena', dob: '2025-06-01' });
  const b = fill(startBooking(OFFER, 3), [ADULT, inf(1), inf(2)]);
  const hit = preflight(b).blocking.find((x) => x.code === 'infants_exceed_adults');
  assert.ok(hit, 'two infants and one adult is one lap short');
  assert.match(hit.message, /not enough laps/);
});

/* ── COLLECTION ────────────────────────────────────────────────────────── */

test('every field is asked for, one at a time, and none is skipped', () => {
  let b = startBooking(OFFER, 1);
  const asked = [];
  for (let i = 0; i < 40; i++) {
    const p = nextPrompt(b);
    if (!p) break;
    asked.push(p.key);
    b = apply(b, p.key, p.per === 'booking' ? CONTACT[p.key] : ADULT[p.key], p.index ?? 0).booking;
  }
  assert.deepEqual(asked, [...PER_PASSENGER, ...PER_BOOKING]);
  assert.equal(asked.length, FIELDS.length);
  assert.equal(nextPrompt(b), null);
});

// Names and dates of birth come from memory; a passport number needs the
// document in hand. Asking for the passport first is how a conversation ends.
test('the cheap questions come before the ones that need the document', () => {
  assert.ok(PER_PASSENGER.indexOf('given_name') < PER_PASSENGER.indexOf('passport_number'));
  assert.ok(PER_PASSENGER.indexOf('dob') < PER_PASSENGER.indexOf('passport_number'));
});

test('a three-passenger booking finishes one passenger before starting the next', () => {
  let b = startBooking(OFFER, 3);
  const order = [];
  for (let i = 0; i < 40; i++) {
    const p = nextPrompt(b);
    if (!p) break;
    order.push(`${p.index ?? 'x'}:${p.key}`);
    b = apply(b, p.key, p.per === 'booking' ? CONTACT[p.key] : ADULT[p.key], p.index ?? 0).booking;
  }
  const idx = order.filter((o) => !o.startsWith('x')).map((o) => Number(o.split(':')[0]));
  assert.deepEqual(idx, [...idx].sort((a, z) => a - z), 'jumping between passengers is confusing to answer');
  assert.equal(remaining(b).left, 0);
});

test('the prompt says who it is about when there is more than one passenger', () => {
  assert.equal(nextPrompt(startBooking(OFFER, 1)).who, 'them');
  assert.equal(nextPrompt(startBooking(OFFER, 3)).who, 'passenger 1 of 3');
});

test('progress is countable, so the concierge can say how much is left', () => {
  const b = startBooking(OFFER, 2);
  assert.deepEqual(remaining(b), { have: 0, total: PER_PASSENGER.length * 2 + PER_BOOKING.length, left: 14 });
  assert.equal(remaining(fill(b, [ADULT, ADULT])).left, 0);
});

/* ── BAD ANSWERS ──────────────────────────────────────────────────────── */

test('a rejected answer changes nothing at all', () => {
  const b = startBooking(OFFER, 1);
  const r = apply(b, 'passport_number', 'ABC');
  assert.equal(r.ok, false);
  assert.equal(r.booking, b, 'the same object — a bad answer cannot half-apply');
  assert.match(r.error, /5–15 letters and digits/);
});

test('each field rejects what people actually type', () => {
  const cases = [
    ['dob', 'about 1991'], ['dob', '08/04/1991'],
    ['passport_expiry', 'next year'],
    ['email', 'alex at example dot com'], ['email', 'alex@example'],
    ['phone', '07700 900123'], ['phone', '447700900123'],
    ['nationality', 'British'],
    ['given_name', ''], ['given_name', '123'],
  ];
  for (const [k, v] of cases) {
    assert.equal(apply(startBooking(OFFER, 1), k, v).ok, false, `${k} accepted "${v}"`);
  }
});

test('answers are normalised on the way in, so the ticket is not a transcript', () => {
  let b = startBooking(OFFER, 1);
  b = apply(b, 'passport_number', ' 5612 34789 ').booking;
  assert.equal(b.passengers[0].passport_number, '561234789');
  b = apply(b, 'nationality', 'gb').booking;
  assert.equal(b.passengers[0].nationality, 'GB');
  b = apply(b, 'phone', '+44 (7700) 900-123').booking;
  assert.equal(b.contact.phone, '+447700900123');
  b = apply(b, 'email', '  Alex@Example.COM ').booking;
  assert.equal(b.contact.email, 'alex@example.com');
});

test('a field Num does not collect is refused, not quietly stored', () => {
  const r = apply(startBooking(OFFER, 1), 'frequent_flyer', 'BA12345');
  assert.equal(r.ok, false);
  assert.match(r.error, /does not collect/);
});

test('every field carries an error a person can act on', () => {
  for (const f of FIELDS) {
    assert.ok(f.error && f.error.length > 20, `${f.key} has no usable error`);
    assert.ok(f.ask && !/^please /i.test(f.ask), `${f.key}'s ask reads like a form label`);
  }
});

/* ── THE TWO GATES ────────────────────────────────────────────────────── */

test('complete and preflight ask different questions, and both must pass', () => {
  const short = { ...ADULT, passport_expiry: '2026-11-20' };
  const b = fill(startBooking(OFFER, 1), [short]);
  assert.equal(complete(b).ok, true, 'every field is present and well-formed');
  assert.equal(preflight(b).ok, false, 'and the trip still does not work');
  assert.equal(readyToIssue(b).ok, false, 'readyToIssue runs both — no caller can run one and forget the other');
});

test('an incomplete booking says which fields are missing', () => {
  const r = readyToIssue(startBooking(OFFER, 1));
  assert.equal(r.reason, 'incomplete');
  assert.equal(r.missing.length, FIELDS.length);
});

test('state moves to ready only when everything is in', () => {
  const b = startBooking(OFFER, 1);
  assert.equal(b.state, STATE.QUOTED);
  const one = apply(b, 'given_name', 'Alexandra').booking;
  assert.equal(one.state, STATE.COLLECTING);
  assert.equal(fill(b).state, STATE.READY);
});

/* ── THE PROMPT BLOCK ─────────────────────────────────────────────────── */

test('the block asks for exactly one thing and forbids pasting a form', () => {
  const s = bookingBlock(startBooking(OFFER, 1));
  assert.match(s, /ASK FOR ONE THING NOW/);
  assert.match(s, /ASK FOR THAT AND NOTHING ELSE/);
  assert.match(s, /do not paste a form/);
});

test('the block never lets the model say booked before there is a reference', () => {
  const s = bookingBlock(fill(startBooking(OFFER, 1)));
  assert.match(s, /NOTHING IS BOOKED UNTIL A PERSON TAPS CONFIRM/);
  assert.match(s, /Never say "booked", "confirmed" or "ticketed"/);
});

test('a blocked booking leads with the blocker, not with the next question', () => {
  const short = { ...ADULT, passport_expiry: '2026-11-20' };
  const s = bookingBlock(fill(startBooking(OFFER, 1), [short]));
  assert.match(s, /STOP — THIS BOOKING CANNOT BE ISSUED/);
  assert.ok(s.indexOf('STOP —') < s.indexOf('NOTHING IS BOOKED'));
});

/* ─────────────────────────────────────────────────────────────────────────
   THE SIMULATOR MUST NEVER PASS FOR A REAL ISSUER

   A simulated PNR looks exactly like a real one unless it is made not to.
   If one reached a traveller they would go to an airport with a reference
   that does not exist.
   ───────────────────────────────────────────────────────────────────────── */

test('the simulator cannot make Num claim it can book', () => {
  const sim = { FLIGHT_ISSUER: 'simulated' };
  assert.equal(canSimulate(sim), true, 'the pipeline runs');
  assert.equal(canIssue(sim), false, 'and the concierge still says Num cannot issue');
  assert.equal(canIssueFlight(sim), false, 'including through services.mjs, which is what the wording hangs on');
});

test('a real issuer does make it true — the gate is not simply hardcoded off', () => {
  const real = { FLIGHT_ISSUER: 'duffel', DUFFEL_ACCESS_TOKEN: 'tok', DUFFEL_ISSUING_APPROVED: 'true' };
  assert.equal(canIssue(real), true);
  assert.equal(canIssueFlight(real), true);
});

test('a credential is not approval — Duffel stays shut until the MoR decision', () => {
  assert.equal(canIssue({ FLIGHT_ISSUER: 'duffel', DUFFEL_ACCESS_TOKEN: 'tok' }), false);
  assert.equal(issuerFor({ FLIGHT_ISSUER: 'duffel', DUFFEL_ACCESS_TOKEN: 'tok' }), null);
});

test('LetsGo2Trip is real but not ready — there is no booking API yet', () => {
  assert.equal(ISSUERS.letsgo2trip.real, true);
  assert.equal(ISSUERS.letsgo2trip.ready({}), false);
  assert.equal(ISSUERS.letsgo2trip.ready({ LGT_BOOKING_API: 'x', LGT_BOOKING_KEY: 'y' }), true);
});

test('every issuer declares whether it is real, and only one is not', () => {
  for (const [id, i] of Object.entries(ISSUERS)) {
    assert.equal(typeof i.real, 'boolean', `${id} does not say whether it issues real tickets`);
  }
  assert.deepEqual(Object.values(ISSUERS).filter((i) => !i.real).map((i) => i.id), ['simulated']);
});

test('a simulated reference is not in airline format and is detectable', () => {
  const b = fill(startBooking(OFFER, 1));
  return issue({ FLIGHT_ISSUER: 'simulated' }, b).then((r) => {
    assert.equal(r.ok, true);
    assert.equal(r.simulated, true);
    assert.equal(r.note, SIM_MARK);
    assert.match(r.reference, SIM_PNR_RE);
    assert.equal(isSimulated(r.reference), true);
    assert.equal(isSimulated('ABC123'), false, 'a real six-character PNR is not flagged');
    assert.ok(!/^[A-Z0-9]{6}$/.test(r.reference), 'it must not be mistakable for an airline PNR');
    assert.match(r.airline_ref, /^SIM/, 'the airline reference is the one people paste into a website');
    assert.equal(r.tickets.length, 1);
  });
});

test('no issuer configured is a refusal with a reason, not a throw', async () => {
  const r = await issue({}, fill(startBooking(OFFER, 1)));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_issuer');
});

test('an issuer that throws becomes a result, not a 500', async () => {
  const r = await issue({ FLIGHT_ISSUER: 'letsgo2trip', LGT_BOOKING_API: 'x', LGT_BOOKING_KEY: 'y' },
    fill(startBooking(OFFER, 1)));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'issuer_failed');
  assert.match(r.message, /no booking API yet/);
});

/* ── THE CONFIRMATIONS ────────────────────────────────────────────────── */

const issued = {
  ok: true, simulated: true, note: SIM_MARK,
  reference: 'SIMUS7Y2Y', airline_ref: 'SIMSEBHK9', issued_at: '2026-08-30T18:42:00.000Z',
  tickets: [{ passenger: 'Alexandra Johnson', number: 'SIM-9710403203-1' }],
  price: 51500,
};
const BOOKED = fill(startBooking(OFFER, 1));
const OUT = confirmations(BOOKED, issued);

test('a simulated confirmation says so in the subject, the text and the HTML', () => {
  assert.match(OUT.email.subject, /^\[SIMULATED — NOT A REAL TICKET\]/, 'the subject is what shows in a list');
  assert.match(OUT.email.text.split('\n')[0], /SIMULATED — NOT A REAL TICKET/, 'first line, not a footer');
  assert.match(OUT.email.html, /SIMULATED — NOT A REAL TICKET/);
  assert.match(OUT.sms.body, /NUM TEST/);
  assert.ok(!/Your flight is booked/.test(OUT.email.subject));
});

test('a real confirmation reads like one', () => {
  const real = confirmations(BOOKED, { ...issued, simulated: false, reference: 'K7QM2P' });
  assert.match(real.email.subject, /^Your flight is booked/);
  assert.ok(!/SIMULATED/.test(real.email.text));
  assert.ok(!/SIMULATED/.test(real.email.html));
  assert.match(real.sms.body, /^Num: booked\. K7QM2P/);
});

// The reference is what people search their inbox for at 5am. Search does
// not open attachments and does not read HTML.
test('the reference and the route are in the subject line', () => {
  assert.match(OUT.email.subject, /SIMUS7Y2Y/);
  assert.match(OUT.email.subject, /DXB→LHR/);
  assert.match(OUT.email.subject, /Mon 14 Sep 2026/);
});

test('nothing that matters exists only in the HTML', () => {
  const t = OUT.email.text;
  for (const must of ['SIMUS7Y2Y', 'SIMSEBHK9', 'DXB', 'LHR', '08:30', '13:15',
    'ALEXANDRA JOHNSON', 'SIM-9710403203-1', '25kg checked', '$515.00', 'Mon 21 Sep 2026']) {
    assert.ok(t.includes(must), `the plain-text email is missing ${must}`);
  }
});

test('the text and the HTML cannot disagree, because both read one object', () => {
  const it = itinerary(BOOKED, issued);
  for (const v of [it.reference, it.departTime, it.origin, it.dest]) {
    assert.ok(textEmail(it).includes(v), `text lost ${v}`);
    assert.ok(htmlEmail(it).includes(v), `html lost ${v}`);
  }
});

test('the money adds up and is shown to the cent', () => {
  assert.equal(OUT.itinerary.totalCs, 51500);
  assert.equal(OUT.itinerary.fareCs + OUT.itinerary.taxCs + OUT.itinerary.feeCs, 51500);
  assert.match(OUT.email.text, /Fare {10}\$445\.00/);
  assert.match(OUT.email.text, /TOTAL {9}\$515\.00/);
  assert.match(OUT.email.text, /Booking fee {3}\$15\.00/, 'the fee is a line item, never folded into the fare');
  assert.equal(money(0, 'GBP'), '£0.00');
  assert.equal(money(51500, 'AED'), 'AED 515.00');
});

test('a fee of zero is not printed as a zero line', () => {
  const free = confirmations({ ...BOOKED, offer: { ...OFFER, fee_cs: 0, price: 50000 } }, issued);
  assert.ok(!/Booking fee/.test(free.email.text));
});

test('the date format is unambiguous in every country', () => {
  assert.equal(longDate('2026-09-14'), 'Mon 14 Sep 2026');
  assert.equal(longDate('nonsense'), 'nonsense', 'a bad date is passed through, never rendered as Invalid Date');
});

test('the HTML escapes what goes into it', () => {
  const nasty = structuredClone(BOOKED);
  nasty.passengers[0].given_name = '<script>alert(1)</script>';
  const html = htmlEmail(itinerary(nasty, issued));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/i);
});

test('the confirmation SMS fits one segment and leads with the reference', () => {
  const real = confirmations(BOOKED, { ...issued, simulated: false, reference: 'K7QM2P' });
  assert.ok(real.sms.length <= SMS_SEGMENT, `${real.sms.length} chars is ${real.sms.segments} segments`);
  assert.match(real.sms.body.slice(0, 24), /K7QM2P/, 'it is read in a notification preview');
});

test('the reminder has a different job from the confirmation', () => {
  const r = smsReminder(itinerary(BOOKED, issued));
  assert.match(r.body, /tomorrow/);
  assert.match(r.body, /Check in/);
  assert.ok(r.length <= SMS_SEGMENT);
});

test('both messages go to the number that was collected', () => {
  assert.equal(OUT.sms.to, '+447700900123');
  assert.equal(OUT.reminder.to, '+447700900123');
  assert.equal(OUT.email.to, 'alex.johnson@example.com');
});

test('a one-way trip does not print an empty return leg', () => {
  const oneway = { ...OFFER, return_date: null, return_flight_no: null };
  const b = fill(startBooking(oneway, 1));
  const o = confirmations(b, issued);
  assert.ok(!/RETURN/.test(o.email.text));
  assert.ok(!/Return/.test(o.email.html.replace(/return_/g, '')));
});

/* ─────────────────────────────────────────────────────────────────────────
   THE CONFIRMATION HAS TO ACTUALLY LEAVE

   Building the message and sending it are different problems, and for most
   of this file's life only the first was solved. That is the same bug as an
   invite cron running for five days into a dead credential.
   ───────────────────────────────────────────────────────────────────────── */
import { deliver } from './flightconfirm.mjs';

const cfOk = () => ({ send: async () => ({ messageId: 'cf_ok' }) });

test('a confirmed booking sends its confirmation and records the outcome', async () => {
  const rows = [];
  const env = { EMAIL: cfOk(), DB: { prepare: () => ({ bind: (...a) => ({ run: async () => rows.push(a) }) }) } };
  const r = await deliver(env, BOOKED, issued);
  assert.equal(r.email.ok, true);
  assert.equal(r.email.via, 'cloudflare');
  assert.deepEqual(rows[0].slice(0, 2), ['ok', 'mail:flight-confirmation']);
});

test('a booking with no email address fails loudly rather than quietly', async () => {
  const noEmail = { ...BOOKED, contact: { ...BOOKED.contact, email: null } };
  const r = await deliver({ EMAIL: cfOk() }, noEmail, issued);
  assert.equal(r.email.ok, false);
  assert.match(r.email.error, /no email address/);
});

// The traveller has paid and is waiting for a document. A send failure must
// never be swallowed, and must never be reported as a failed booking either.
test('a failed send never throws — the booking succeeded regardless', async () => {
  const env = { EMAIL: { send: async () => { throw new Error('destination not verified'); } } };
  const r = await deliver(env, BOOKED, issued);
  assert.equal(r.email.ok, false);
  assert.match(r.email.error, /destination not verified/);
  assert.equal(r.itinerary.reference, 'SIMUS7Y2Y', 'the reference is still returned to show them');
});

test('the SMS channel is injected, so this module knows nothing about Twilio', async () => {
  let got;
  const r = await deliver({ EMAIL: cfOk() }, BOOKED, issued, {
    sendSms: async (_e, to, body) => { got = { to, body }; return { ok: true }; },
  });
  assert.equal(got.to, '+447700900123');
  assert.match(got.body, /SIMUS7Y2Y/);
  assert.equal(r.sms.ok, true);
});

test('no SMS sender configured is a null result, not a failure', async () => {
  const r = await deliver({ EMAIL: cfOk() }, BOOKED, issued);
  assert.equal(r.sms, null, 'the A2P campaign is unapproved on most deployments — that is not an error');
});

test('a throwing SMS sender does not take the email down with it', async () => {
  const r = await deliver({ EMAIL: cfOk() }, BOOKED, issued, {
    sendSms: async () => { throw new Error('30034 unregistered'); },
  });
  assert.equal(r.email.ok, true);
  assert.equal(r.sms.ok, false);
  assert.match(r.sms.error, /30034/);
});

/* ── IS THE BOOKING FLOW ON THE PATH? ────────────────────────────────── */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const IDX = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.mjs'), 'utf8');

test('an open booking reaches the prompt, and only when Num can issue', () => {
  assert.match(IDX, /if \(canIssueFlight\(env \?\? \{\}\) && state\?\.flightBooking\)/,
    'collecting a passport number for a ticket Num cannot issue asks for something we have no use for');
  assert.match(IDX, /bookingBlock\(b\)/);
});

// Quoting a total while three passport numbers are still missing invites them
// to agree to a number that is not yet the number.
test('the money is read back only once everything is collected', () => {
  const i = IDX.indexOf('if (canIssueFlight(env ?? {}) && state?.flightBooking)');
  const block = IDX.slice(i, i + 1200);
  assert.match(block, /if \(readyToIssue\(b\)\.ok\)/);
  assert.ok(block.indexOf('bookingBlock(b)') < block.indexOf('payBlock(b'),
    'the questions come before the bill');
});

test('the same gate governs the booking flow and the LetsGo2Trip fallback', () => {
  assert.equal((IDX.match(/canIssueFlight\(env \?\? \{\}\)/g) || []).length, 2,
    'two gates with their own opinion is how one of them ends up wrong');
});
