// The words that cost $100,000 if Num says them.
//
// Every test here drives the REAL modules with REAL inputs. None of them reads
// source text and matches a pattern against it — the repo already learned that
// lesson once (preflight.mjs: "the first guard on this was a regex over
// pay.mjs, and a `true ||` mutation sailed straight past it").
//
// Run: node --test worker/travelspeak.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan, rewrite, rewriteLabel, scrubPayload, RULES } from './travelspeak.mjs';
import { lintAll, literals, LINTED } from '../scripts/travelspeak-lint.mjs';

/* ── LAYER 2: the runtime filter ───────────────────────────────────────── */

test('every forbidden phrasing in the counsel memo is caught in a travel sentence', () => {
  const forbidden = [
    "I'll book that flight for you.",
    'Booked! Your flight leaves at 23:59.',
    'Your booking is confirmed for the Bangkok flight.',
    "I've arranged your flight to Phuket.",
    'Leave the booking with me — the flight is sorted.',
    'I can arrange flights.',
    "We'll handle the booking for that flight.",
    'Your ticket is ready.',
    'I have reserved the hotel room for you.',
    "I'll hold that fare for an hour.",
    "I'll reserve the hotel for those nights.",
    "We'll arrange the airport transfer.",
    'I can book the train for you.',
    'Your e-ticket is attached.',
    'Your boarding pass will arrive by email.',
    'The booking reference is ABC123.',
  ];
  for (const s of forbidden) {
    const { ok, hits } = scan(s);
    assert.equal(ok, false, `NOT CAUGHT: ${s}`);
    assert.ok(hits.length > 0, `no hits for: ${s}`);
  }
});

test('casing is irrelevant — the same sentence is caught shouted, whispered and title-cased', () => {
  for (const s of [
    'I have BOOKED your flight.',
    'i have booked your flight.',
    'I Have Booked Your Flight.',
    'i HaVe BoOkEd YoUr FlIgHt.',
  ]) {
    assert.equal(scan(s).ok, false, `NOT CAUGHT: ${s}`);
  }
});

test('possessives do not smuggle a term past the word boundary', () => {
  for (const s of [
    "Your booking's confirmed for the flight.",
    "Your ticket's ready for the flight to Bangkok.",
    "The flight booking's all set.",
    "Num's booked your flight.",
  ]) {
    assert.equal(scan(s).ok, false, `NOT CAUGHT: ${s}`);
  }
});

test('RESTAURANTS ARE NOT TRAVEL — table language survives untouched', () => {
  const fine = [
    "I'll book you a table at Bestia for four at 20:00.",
    "Booked — the restaurant has your table at 20:00.",
    'Your booking at the restaurant is confirmed for eight covers.',
    "I've reserved the table for tonight.",
    "I'll hold the table for twenty minutes while you decide.",
    "I'll book the massage for 4pm.",
    "I've arranged the barber appointment for Thursday.",
    "Your booking for the cinema screening is confirmed.",
    "I'll book the tennis court for Saturday.",
    "I've reserved two seats for the concert.",
  ];
  for (const s of fine) {
    const r = rewrite(s);
    assert.equal(r.changed, false, `OVER-BLOCKED (a working feature would break): ${s} -> ${r.text}`);
    assert.equal(r.text, s);
  }
});

test('a denial is the behaviour we want, not the offence', () => {
  for (const s of [
    "I can't book flights — the travel partner issues the ticket.",
    "I don't book flights or hotels.",
    'Num never books your flight; you complete it on their site.',
    'I am not able to arrange the flight.',
  ]) {
    const r = rewrite(s);
    assert.equal(r.changed, false, `a denial was rewritten: ${s} -> ${r.text}`);
  }
});

test('the permitted framing from §10.3 passes verbatim', () => {
  for (const s of [
    'I found this on LetsGo2Trip — $420, departs 23:59.',
    'LetsGo2Trip can issue this ticket. Want me to take you there?',
    "I don't issue tickets. LetsGo2Trip does — here's the page for this fare.",
    "Here's what it costs at LetsGo2Trip. You'll complete it on their site.",
    'Found it. Handing you to LetsGo2Trip to finish.',
  ]) {
    const r = rewrite(s);
    assert.equal(r.changed, false, `permitted copy was rewritten: ${s} -> ${r.text}`);
  }
});

test('a rewritten reply carries no forbidden term and is never empty', () => {
  const r = rewrite("Booked! I've got your ticket for the 23:59 flight and I'll hold the hotel too.");
  assert.equal(r.changed, true);
  assert.equal(scan(r.text).ok, true, `the rewrite still trips the filter: ${r.text}`);
  assert.ok(r.text.trim().length > 0);
});

test('THE FILTER REWRITES, IT NEVER BLOCKS — even an all-forbidden reply comes back with words in it', () => {
  const r = rewrite("Booked. Booked. Your ticket is ready. I've arranged your flight.");
  assert.ok(r.text.trim().length > 10, 'a reply must never be emptied');
  assert.equal(scan(r.text).ok, true);
});

test('the clean half of a mixed reply survives the rewrite', () => {
  const r = rewrite('The 23:59 gets in at 06:10 and it is non-stop. I have booked it for you.');
  assert.match(r.text, /06:10/, 'useful detail was thrown away with the offending sentence');
  assert.equal(scan(r.text).ok, true);
});

test('context from the previous turn decides an ambiguous reply', () => {
  const reply = "Done — I've booked it.";
  const travel = rewrite(reply, { context: 'what does the flight to Bangkok cost?' });
  const dinner = rewrite(reply, { context: 'can you get us a table at Bestia for four?' });
  assert.equal(travel.changed, true, 'a travel turn let "I\'ve booked it" through');
  assert.equal(dinner.changed, false, 'a restaurant turn was over-blocked');
});

test('button and chip labels are swapped whole, not sentence-rewritten', () => {
  for (const label of ['Book now', 'Confirm booking', 'Hold this fare', 'Complete booking']) {
    const r = rewriteLabel(label, { context: 'flights to Bangkok' });
    assert.equal(r.changed, true, `label not caught: ${label}`);
    assert.ok(r.text.length < 40, 'a label must stay a label');
    assert.equal(scan(r.text).ok, true);
  }
  const table = rewriteLabel('Book a table', { context: 'dinner at Bestia' });
  assert.equal(table.changed, false, 'the restaurant button was broken');
});

test('the whole concierge payload is scrubbed — reply, card and chips', () => {
  const out = scrubPayload(
    {
      reply: "Booked! Your ticket for the 23:59 flight is ready.",
      card: { title: 'Book now', meta: "I've arranged your flight.", tag: 'confirmed' },
      chips: [{ id: 'a', label: 'Confirm booking' }, { id: 'b', label: 'Something else' }],
      actions: [{ type: 'add_booking', booking: { title: 'Flight', note: "I've booked your flight." } }],
      place: 'Bangkok',
    },
    { context: 'flights to Bangkok' },
  );
  assert.equal(scan(out.reply).ok, true, out.reply);
  assert.equal(scan(out.card.title).ok, true);
  assert.equal(scan(out.card.meta).ok, true);
  for (const c of out.chips) assert.equal(scan(c.label).ok, true);
  assert.equal(scan(out.actions[0].booking.note).ok, true);
  assert.equal(out.place, 'Bangkok', 'a data field was rewritten — that breaks the product');
  assert.equal(out.chips[1].label, 'Something else', 'an innocent chip was rewritten');
  assert.ok(out._travelspeak.hits.length >= 4);
});

test('a payload with nothing to fix is returned untouched, same object', () => {
  const payload = { reply: 'Three good places near you tonight.', card: null, chips: null, actions: [] };
  assert.equal(scrubPayload(payload), payload);
});

test('a bookdesk-shaped payload is not damaged', () => {
  const out = scrubPayload(
    {
      reply: "Ready to send — I'll ask Bestia to hold a table for four at 20:00.",
      actions: [{ type: 'book_table', request: { venue_name: 'Bestia', venue_phone: '+13235551234', party_size: 4, at_time: '20:00', note: 'window table' } }],
    },
    { context: 'table for four at Bestia tonight' },
  );
  assert.equal(out.actions[0].request.venue_name, 'Bestia');
  assert.equal(out.actions[0].request.venue_phone, '+13235551234');
  assert.match(out.reply, /Bestia/);
  assert.match(out.reply, /hold a table/);
});

/* ── LAYER 1: the lint ─────────────────────────────────────────────────── */

test('the lint is clean across every linted file — this one FAILS THE BUILD', () => {
  const findings = lintAll();
  assert.deepEqual(
    findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.match}`),
    [],
  );
});

test('the lint reads string literals and ignores comments', () => {
  const src = [
    '// I have booked your flight — a comment, never seen by a guest.',
    '/* I will arrange your flight, also a comment. */',
    "const a = 'I have booked your flight.';",
  ].join('\n');
  const lits = literals(src);
  assert.equal(lits.length, 1);
  assert.equal(lits[0].text, 'I have booked your flight.');
  assert.equal(scan(lits[0].text).ok, false);
});

test('the lint catches a forbidden term planted in a persona file', () => {
  // The real regression: a persona line that teaches the model the phrasing.
  const planted = "const P = 'When they pick a fare, say you will book it and confirm the ticket.';";
  const [lit] = literals(planted);
  const { hits } = scan(lit.text, { context: lit.text, mode: 'prompt' });
  assert.ok(hits.length > 0, 'a planted violation walked past the lint');
});

test('the lint catches the exact line that was live in worker/services.mjs on 18 Aug', () => {
  // Verbatim, from the `canBook` block before this work. It ran on every
  // travel turn with SABRE_BOOKING_ENABLED set, and it is §17550.1(a) in one
  // sentence: advertising that Num can arrange.
  const wasLive =
    'BOOKING EXISTS BUT IS NOT YOURS TO TRIGGER. Num can create bookings and issue tickets, and that happens only when a ' +
    'PERSON confirms it. Your job is to get them to the edge of it: the exact fare, ' +
    'the exact times, what it costs. Then say clearly that you can book it and ask them to confirm.';
  const { hits } = scan(wasLive, { mode: 'prompt' });
  assert.ok(hits.length >= 2, `the lint would have let the real violation ship: ${JSON.stringify(hits)}`);
  assert.ok(hits.some((h) => h.rule === 'will-book'), 'missed "you can book it"');
});

test('the lint covers the files a traveller can actually read', () => {
  for (const f of ['worker/prompt.mjs', 'worker/services.mjs', 'worker/membership.mjs', 'src/components/app/MembershipCard.tsx']) {
    assert.ok(LINTED.includes(f), `${f} is not linted`);
  }
});

test('every rule has a replacement to swap in — a rule with no fix would block', () => {
  const categories = new Set(RULES.map((r) => r.category));
  for (const c of categories) {
    assert.equal(typeof rewrite(`I have ${c}`, {}).text, 'string');
  }
  assert.deepEqual([...categories].sort(), ['claims_done', 'label', 'possessive', 'promises_to_do']);
});
