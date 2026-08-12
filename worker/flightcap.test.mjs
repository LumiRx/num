// The capability Num denied while having it.
//
// 9 Aug 2026, found while shooting App Store screenshots. Sabre connected,
// `flight_shopping: true` on /api/version, and the same question three times:
//
//   iPhone → real fares. HKT→BKK, USD 157.80, five departures.
//   iPad   → "Flights aren't something I can pull up or book directly yet —
//             I'll flag that to the team so it's on their radar."
//   iPad   → same denial again.
//
// It also filed a feature_request for a feature that already shipped, which is
// how a working capability quietly becomes a roadmap item.
//
// The cause was not the model being unreliable. servicesBlock printed a
// summary list where `flight` was scored by the BOOKING adapters — none
// connected — so the line read `flights: HAND-OFF`, three lines above a block
// saying "You CAN see real fares." Given a contradiction, top-down wins.
//
// These tests hold the two halves in agreement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { servicesBlock } from './services.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const SABRE = { SABRE_CLIENT_ID: 'id', SABRE_CLIENT_SECRET: 'secret' };
const flightLine = (block) =>
  block.split('\n').find((l) => l.startsWith('- flights:')) ?? '';

test('with Sabre connected, the summary does NOT call flights a hand-off', () => {
  const line = flightLine(servicesBlock({ name: 'Phuket', country_code: 'TH' }, SABRE));
  assert.ok(line, 'the flights line vanished from the services summary');
  assert.doesNotMatch(line, /HAND-OFF/,
    'flights are labelled HAND-OFF while fares are live — this is the exact contradiction that made Num deny flights it can price');
  assert.match(line, /LIVE PRICES/,
    'the summary no longer states that fares can be priced — the model has nothing up top telling it the capability exists');
});

test('the summary and the detail agree with each other', () => {
  // The failure was never one sentence being wrong. It was two sentences
  // disagreeing, and the model picking the first.
  const block = servicesBlock({ name: 'Phuket', country_code: 'TH' }, SABRE);
  assert.match(block, /You CAN see real fares/,
    'the detailed permission block is gone — nothing authorises quoting a fare');
  assert.doesNotMatch(flightLine(block), /HAND-OFF/,
    'summary still contradicts the detail');
});

test('without Sabre, flights stay an honest hand-off', () => {
  // The fix must not invent a capability. No credentials, no live prices.
  const line = flightLine(servicesBlock({ name: 'Phuket', country_code: 'TH' }, {}));
  assert.match(line, /HAND-OFF/,
    'flights claim live prices with no Sabre credentials — that is worse than the bug it replaced');
  assert.doesNotMatch(line, /LIVE PRICES/, 'a capability we do not have is being advertised');
});

test('the hand-off rule is scoped, so it cannot re-forbid pricing', () => {
  // "Num has no account with these companies yet, so you CANNOT place the
  // order yourself" read as a blanket ban when it sat under a live-price line.
  const block = servicesBlock({ name: 'Phuket', country_code: 'TH' }, SABRE);
  assert.match(block, /applies to the lines marked HAND-OFF, never to LIVE PRICES/,
    'the hand-off rule is unscoped again — it will be read as forbidding the fare search too');
});

test('the persona does not blanket-deny what the services block enables', () => {
  // Second cause, found only by asking the LIVE app after the first fix
  // shipped: PERSONA carried a hand-written "You CANNOT yet ... contact venues
  // or airlines" line. The model read it as "no flights", answered "that's
  // outside what I can touch right now", and filed a feature_request for
  // flight search — which already works. A static capability list will always
  // drift from live configuration; the fix is to say which one wins.
  const prompt = readFileSync(join(HERE, 'prompt.mjs'), 'utf8');
  assert.match(prompt, /SEEING is not BUYING/,
    'nothing separates being able to price a thing from being able to buy it — the persona will deny live fares again');
  assert.match(prompt, /Treat the SERVICES block as authoritative/,
    'the static list is no longer subordinated to live config — it will go stale and start lying');
  assert.match(prompt, /never file a feature_request for a capability that is already connected/,
    'nothing stops a shipped feature being re-filed as a roadmap item');
  assert.doesNotMatch(prompt, /CANNOT yet: take real payments or issue real tickets, contact venues or airlines/,
    'the old blanket denial is back in the persona');
});

test('a fare must come from a search, never from memory', () => {
  // Third turn of the same bug, and the most dangerous. After being told it
  // COULD quote fares, the live app stopped denying flights and started
  // INVENTING them: "AirAsia 07:15 → 08:40, about THB 2,800", no search run,
  // no card, then "I can lock in the one you choose" — a ticket it cannot
  // issue. Denying a capability is embarrassing. Inventing a price a traveller
  // budgets on is a different category of harm.
  const prompt = readFileSync(join(HERE, 'prompt.mjs'), 'utf8');
  assert.match(prompt, /LOOKING IT UP MEANS RUNNING THE SEARCH, NOT RECALLING A NUMBER/,
    'nothing forces the search — the model can write remembered fares as fact again');
  assert.match(prompt, /Do NOT write fares, departure times, or "about THB X" in your own words/,
    'the ban on prose prices is gone — invented fares will return');
  assert.match(prompt, /an honest gap beats an invented number/,
    'the fallback for "cannot search" no longer forbids guessing');
});

test('the departure airport comes from the resolved place, not a lookalike name', () => {
  // Fourth turn. With fares no longer denied OR invented, the live app read
  // "we are in kata" — a beach in Phuket, already resolved in the context
  // block — and answered "you're in Kathmandu". Close spelling, 3,000km away,
  // and the guest would have been priced from the wrong continent.
  const block = servicesBlock({ name: 'Phuket', country_code: 'TH' }, SABRE);
  assert.match(block, /WHERE THEY ARE FLYING FROM is the place in your context block/,
    'nothing pins the departure to the resolved place — a beach can become a country again');
  assert.match(block, /Kata → Phuket → HKT/,
    'the worked example is gone; the abstract rule alone did not hold last time');
  assert.match(block, /Never resolve a place name to a distant city because the spelling is close/,
    'the lookalike-name ban is gone');
});
