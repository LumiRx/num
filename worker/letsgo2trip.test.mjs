import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PARAM, REF_PREFIX, newRef, lgtReady, STATED, band, expectedFor,
  DEFAULT_SURCHARGE_CS, surchargeCs, surchargeLine,
  flightLink, stayLink, flightBlock, stayBlock,
  wantsFlight, wantsStay, isoDate, openReferral,
} from './letsgo2trip.mjs';

const ENV = { LGT_PARTNER_ID: 'num' };

/* ─────────────────────────────────────────────────────────────────────────
   THE SURCHARGE

   Their p4 breakdown is $500 base + $15 issuance + $15 concierge = $530, and
   p10 shows the concierge line is a toggle switched on for partner slug
   `num`. Pages 1-5 of the customer flow never mention it. So a traveller who
   asks Num for a flight pays $15 more than one who goes direct, and Num's
   whole positioning is that it acts for the traveller.

   The fee is a commercial choice. The silence is not one Num gets to make.
   ───────────────────────────────────────────────────────────────────────── */

test('the surcharge defaults to the $15 their own deck charges', () => {
  assert.equal(surchargeCs(ENV), DEFAULT_SURCHARGE_CS);
  assert.equal(DEFAULT_SURCHARGE_CS, 1500);
  assert.match(surchargeLine(ENV), /\$15/);
});

test('the fee can be removed and cannot be hidden', () => {
  // Option A: switch it off. The sentence goes because the fee has gone.
  assert.equal(surchargeCs({ ...ENV, LGT_SURCHARGE_CS: 0 }), 0);
  assert.equal(surchargeLine({ ...ENV, LGT_SURCHARGE_CS: 0 }), '');

  // There is deliberately no flag that keeps the fee and drops the sentence.
  for (const attempt of [
    { LGT_SURCHARGE_DISCLOSED: 'false' },
    { LGT_DISCLOSE: 0 },
    { LGT_SILENT: 'true' },
    { LGT_SURCHARGE_HIDDEN: 1 },
  ]) {
    const line = surchargeLine({ ...ENV, ...attempt });
    assert.match(line, /\$15/, `${Object.keys(attempt)[0]} must not suppress the disclosure`);
  }
});

test('the disclosure says it BEFORE the click, not at checkout', () => {
  const l = surchargeLine(ENV);
  assert.match(l, /BEFORE they click/);
  assert.match(l, /never let them find it at checkout/i);
  assert.match(l, /book direct and skip it/i, 'a fee they cannot decline is not a disclosed fee');
});

// Every block that hands over a link must carry the sentence. This is the
// test that actually enforces the rule — surchargeLine() existing is worth
// nothing if a block forgets to embed it.
test('every prompt block carries the fee disclosure while the fee is on', () => {
  const f = flightLink(ENV, { origin: 'DXB', dest: 'LHR' });
  const s = stayLink(ENV, { name: 'Edinburgh' });
  for (const [what, block] of [
    ['flightBlock', flightBlock(f, ENV, { origin: 'DXB', dest: 'LHR' })],
    ['stayBlock', stayBlock(s, ENV, { name: 'Edinburgh' })],
  ]) {
    assert.match(block, /\$15 Num booking fee/, `${what} handed over a link without saying the fee`);
    assert.match(block, /BEFORE they click/, what);
  }
});

test('with the fee off, the blocks stop mentioning a fee that is not charged', () => {
  const free = { ...ENV, LGT_SURCHARGE_CS: 0 };
  const f = flightLink(free, { origin: 'DXB', dest: 'LHR' });
  assert.ok(!/booking fee/.test(flightBlock(f, free, {})), 'a fee of zero must not be announced');
});

/* ─────────────────────────────────────────────────────────────────────────
   THE RATE THAT ISN'T ONE

   The deck states the flight commission three ways. A single expected number
   here would be a fiction with a decimal point on it.
   ───────────────────────────────────────────────────────────────────────── */

test('the three stated flight rates are kept, with the page each came from', () => {
  const srcs = STATED.flight.map((r) => r.src);
  assert.equal(srcs.length, 3);
  assert.ok(srcs.every((s) => /^p\d+ /.test(s)), 'a rate with no page reference cannot be argued later');
});

test('the band prices every reading against the deck\'s own $530 example', () => {
  const b = band('flight', 53000);
  assert.equal(b.low, 795, '1.5% of $530');
  assert.equal(b.high, 1500, '$15 flat per passenger');
  assert.equal(b.spread, 705);
  assert.deepEqual(b.readings.map((r) => r.cs).sort((a, z) => a - z), [795, 1000, 1500]);
});

// The hotel ambiguity is worse than the flight one: "revenue share" is never
// defined against gross or against their margin, and the two readings differ
// by more than an order of magnitude on the same booking.
test('the hotel readings are kept apart, because 5% and 6% are not the same contract', () => {
  const b = band('stay', 40000);
  assert.equal(b.low, 2000, '5% of $400');
  assert.equal(b.high, 2400, '6% of $400');
});

test('an unknown product or a zero booking has no band rather than a made-up one', () => {
  assert.equal(band('spaceflight', 53000), null);
  assert.equal(band('flight', 0), null);
  assert.equal(band('flight', -1), null);
});

test('expected commission is null until a human agrees a rate', () => {
  assert.equal(expectedFor(ENV, 'flight', 53000), null,
    'writing a guess here makes the first statement reconcile against our own invention');
  const agreed = { ...ENV, LGT_RATE: '{"flight":{"flat_cs":1500},"stay":{"bp":600}}' };
  assert.equal(expectedFor(agreed, 'flight', 53000), 1500);
  assert.equal(expectedFor(agreed, 'stay', 40000), 2400);
});

test('a malformed rate table leaves the commission unknown rather than half-applied', () => {
  assert.equal(expectedFor({ ...ENV, LGT_RATE: '{not json' }, 'flight', 53000), null);
  assert.equal(expectedFor({ ...ENV, LGT_RATE: '{"flight":{}}' }, 'flight', 53000), null);
});

/* ── THE LINK ──────────────────────────────────────────────────────────── */

test('the rail is silent until a partner id is configured', () => {
  assert.equal(lgtReady({}), false);
  assert.equal(flightLink({}, { origin: 'DXB', dest: 'LHR' }), null);
  assert.equal(stayLink({}, { name: 'Dubai' }), null);
});

test('the flight link matches their own p8 link-builder example', () => {
  const { url, prefilled } = flightLink(
    { ...ENV, LGT_CAMPAIGN: 'summer_influencer_promo_2026' },
    { origin: 'dxb', dest: 'lhr' },
  );
  assert.match(url, /^https:\/\/letsgo2trip\.com\/flights\?/);
  assert.match(url, /origin=DXB/, 'codes are upper-cased for them');
  assert.match(url, /dest=LHR/);
  assert.match(url, /partner_id=num/);
  assert.match(url, /utm_campaign=summer_influencer_promo_2026/);
  assert.equal(prefilled, true);
});

// Their attribution is a 30-day cookie. Num answers inside app webviews and
// over SMS, where a cookie is partitioned, ITP-capped, or simply absent when
// the link is opened on another device. The ref is ours or there is nothing.
test('every link carries a Num-generated ref, and no two are the same', () => {
  const a = flightLink(ENV, { dest: 'LHR' });
  const b = flightLink(ENV, { dest: 'LHR' });
  assert.notEqual(a.ref, b.ref);
  for (const l of [a, b]) {
    assert.ok(l.ref.startsWith(REF_PREFIX));
    assert.match(l.url, new RegExp(`${PARAM.ref}=${l.ref}`));
  }
});

test('a caller can supply the ref it already recorded', () => {
  const ref = newRef();
  assert.equal(flightLink(ENV, { dest: 'LHR', ref }).ref, ref);
});

// A search for nowhere with our marker on it is worse than no link.
test('a malformed airport code is refused rather than guessed at', () => {
  for (const bad of ['LONDON', 'D1', '', ' -- ']) {
    if (bad.trim() === '') continue;
    assert.equal(flightLink(ENV, { origin: bad, dest: 'LHR' }), null, bad);
  }
});

// But an unknown route is NOT a reason for silence — their flights page works
// perfectly well unprefilled, and Num has no IATA resolver yet.
test('no route still produces a working, attributed search', () => {
  const l = flightLink(ENV, {});
  assert.match(l.url, /letsgo2trip\.com\/flights\?partner_id=num/);
  assert.equal(l.prefilled, false);
});

test('dates and party size ride along when Num knows them', () => {
  const { url } = flightLink(ENV, {
    origin: 'DXB', dest: 'LHR', depart: '2026-09-14', return: new Date('2026-09-21T00:00:00Z'), adults: 2,
  });
  assert.match(url, /depart=2026-09-14/);
  assert.match(url, /return=2026-09-21/);
  assert.match(url, /adults=2/);
});

test('a nonsense date is dropped, not passed through', () => {
  assert.equal(isoDate('not a date'), null);
  assert.ok(!/depart=/.test(flightLink(ENV, { dest: 'LHR', depart: 'soon' }).url));
});

test('an absurd party size is ignored rather than sent', () => {
  for (const n of [0, -2, 40, 1.5]) {
    assert.ok(!/adults=/.test(flightLink(ENV, { dest: 'LHR', adults: n }).url), String(n));
  }
});

// Nothing in the deck documents their hotel query parameters, so Num does not
// yet know the city lands. Claiming a prefilled search that did not appear
// would be a lie told on their behalf.
test('the stay link never claims to be prefilled, because that is unverified', () => {
  const s = stayLink(ENV, { name: 'Edinburgh' }, { checkin: '2026-09-01', checkout: '2026-09-04' });
  assert.equal(s.prefilled, false);
  assert.match(s.url, /letsgo2trip\.com\/hotels\?/);
  assert.match(s.url, /partner_id=num/);
  assert.match(stayBlock(s, ENV, { name: 'Edinburgh' }), /opens their hotel search/);
  assert.ok(!/prefilled/i.test(stayBlock(s, ENV, { name: 'Edinburgh' }).replace(/Do not say it is prefilled/, '')));
});

/* ── WHAT NUM MUST NOT REPEAT ──────────────────────────────────────────── */

test('the blocks forbid the two claims Num cannot verify', () => {
  const f = flightBlock(flightLink(ENV, { dest: 'LHR' }), ENV, {});
  assert.match(f, /NEVER call this "verified direct inventory"/);
  assert.match(f, /markups/);
  assert.match(f, /cannot see their cost base/i);
});

test('the blocks refuse to let Num quote a fare it has not been given', () => {
  for (const b of [
    flightBlock(flightLink(ENV, { dest: 'LHR' }), ENV, {}),
    stayBlock(stayLink(ENV, { name: 'Dubai' }), ENV, { name: 'Dubai' }),
  ]) {
    assert.match(b, /CANNOT see fares|CANNOT see fares, seats/);
    assert.match(b, /cannot book it/);
  }
});

test('the blocks say who actually sells it, since Num cannot issue a ticket', () => {
  assert.match(flightBlock(flightLink(ENV, { dest: 'LHR' }), ENV, {}), /LetsGo2Trip ticket it and support it/);
});

test('no link, no block — an empty rail says nothing at all', () => {
  assert.equal(flightBlock(null, ENV, {}), '');
  assert.equal(stayBlock(null, ENV, {}), '');
  assert.equal(flightBlock({}, ENV, {}), '');
});

/* ── INTENT ────────────────────────────────────────────────────────────── */

test('the gate fires on the ways people actually ask for a flight', () => {
  for (const t of [
    'can you get me a flight to london',
    'cheapest way to fly Dubai to Edinburgh next week',
    'book me a flight friday',
    'what is the airfare DXB LHR',
    'I need a one-way to Bangkok',
  ]) assert.equal(wantsFlight(t), true, t);
});

test('the gate stays out of the way of everything else', () => {
  for (const t of [
    'where should I eat tonight',
    'is the museum open on a Monday',
    'a quiet bar near the hotel',
    'what is the weather like',
  ]) {
    assert.equal(wantsFlight(t), false, t);
    assert.equal(wantsStay(t), false, t);
  }
});

test('the stay gate catches rooms without catching restaurants', () => {
  assert.equal(wantsStay('somewhere to stay near the old town'), true);
  assert.equal(wantsStay('book a room for two nights'), true);
  assert.equal(wantsStay('a table for two at 8'), false);
});

/* ── OUR SIDE OF THE LEDGER ────────────────────────────────────────────── */

function fakeDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return { bind: (...a) => ({ run: async () => { calls.push({ sql, args: a }); return { success: true }; } }) };
    },
  };
}

test('a handoff opens a referral row Num can reconcile against later', async () => {
  const DB = fakeDb();
  const l = flightLink(ENV, { origin: 'DXB', dest: 'LHR' });
  const r = await openReferral({ ...ENV, DB }, {
    ref: l.ref, memberId: 'mem_1', product: 'flight',
    origin: 'DXB', destination: 'LHR', depart: '2026-09-14', adults: 2,
  });
  assert.equal(r.opened, true);
  assert.equal(DB.calls.length, 1);
  assert.match(DB.calls[0].sql, /INSERT OR IGNORE INTO num_travel_referrals/);
  assert.match(DB.calls[0].sql, /'sent'/, 'the handoff has happened — draft would mean we never gave it to anybody');
  assert.deepEqual(DB.calls[0].args.slice(0, 6), [l.ref, l.ref, 'mem_1', 'num', 'LetsGo2Trip', 'flight']);
});

// The whole reason to keep our own ledger: their statement is the only other
// account of what is owed, and it cannot be audited from outside.
test('the expected commission is written NULL while the rate is unagreed', async () => {
  const DB = fakeDb();
  await openReferral({ ...ENV, DB }, { ref: newRef(), product: 'flight', grossCs: 53000 });
  assert.equal(DB.calls[0].args[11], null, 'a guessed expectation reconciles against our own invention');
});

test('and carries the real number once a rate is agreed', async () => {
  const DB = fakeDb();
  await openReferral({ ...ENV, DB, LGT_RATE: '{"flight":{"flat_cs":1500}}' },
    { ref: newRef(), product: 'flight', grossCs: 53000 });
  assert.equal(DB.calls[0].args[11], 1500);
});

test('an anonymous traveller still gets a row — member_id is NOT NULL in the schema', async () => {
  const DB = fakeDb();
  await openReferral({ ...ENV, DB }, { ref: newRef() });
  assert.equal(DB.calls[0].args[2], 'anon');
  assert.equal(DB.calls[0].args[5], 'flight', 'the schema defaults to flight and so do we');
});

// This runs after the URL has been decided and cannot change it. A
// bookkeeping failure must not cost somebody their answer, and it must not
// cost them their link either.
test('a broken database costs a row, never a reply', async () => {
  const bad = { prepare() { throw new Error('D1 exploded'); } };
  const r = await openReferral({ ...ENV, DB: bad }, { ref: newRef() });
  assert.equal(r.opened, false);
  assert.match(r.error, /D1 exploded/);
});

test('no database and no ref are both quiet no-ops', async () => {
  assert.deepEqual(await openReferral({ ...ENV }, { ref: newRef() }), { opened: false });
  assert.deepEqual(await openReferral({ ...ENV, DB: fakeDb() }, {}), { opened: false });
});

// The false positive that made the gate worth tightening: somebody asking for
// a drink near where they are already staying, answered with a booking link
// and a fee disclosure they never asked for.
test('mentioning a hotel is not asking to book one', () => {
  for (const t of [
    'a quiet bar near the hotel',
    'is there a gym at the hotel',
    'how far is my hotel from the airport',
    'the hotel restaurant any good?',
  ]) assert.equal(wantsStay(t), false, t);

  for (const t of [
    'find me a hotel in Dubai',
    'hotels in Edinburgh under 200',
    'I need a room on the 14th',
    'three nights in Bangkok',
  ]) assert.equal(wantsStay(t), true, t);
});

test('getting a lift is not booking a flight', () => {
  assert.equal(wantsFlight('can you get me to the airport by 6'), false);
  assert.equal(wantsFlight('can you get me a flight to london'), true);
});

/* ─────────────────────────────────────────────────────────────────────────
   IS THE RAIL ACTUALLY ON THE PATH?

   Four rails shipped earlier in this session with passing unit tests and
   could not fire in production, because nothing checked they were wired in.
   A referral rail that exists but never runs is worse than none: it is a
   partnership that reports zero and nobody knows why.
   ───────────────────────────────────────────────────────────────────────── */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.mjs'), 'utf8');

test('the rail is imported and gated on being configured', () => {
  assert.match(SRC, /from '\.\/letsgo2trip\.mjs'/, 'the rail is not imported');
  assert.match(SRC, /if \(lgtReady\(env \?\? \{\}\) &&/,
    'an unconfigured partner id must produce silence, not a link to nowhere');
});

test('both blocks reach the prompt', () => {
  assert.match(SRC, /system\.push\(\{ type: 'text', text: flightBlock\(f, env, \{\}\) \}\)/);
  assert.match(SRC, /system\.push\(\{ type: 'text', text: stayBlock\(s, env, grounding\.place\) \}\)/);
});

// The row is the only independent record that Num sent anybody. Their ledger
// is the only other account of what is owed and cannot be audited from
// outside.
test('every handoff opens a referral row, and it is awaited', () => {
  const i = SRC.indexOf('if (lgtReady(env ?? {})');
  assert.ok(i > 0);
  const block = SRC.slice(i, i + 1400);
  assert.equal((block.match(/await openReferral\(env, \{/g) || []).length, 2,
    'both the flight and the stay handoff must record a referral');
  assert.ok(!/openReferral\(env, \{[^)]*\}\);\s*$/m.test(block.replace(/await openReferral/g, 'X')),
    'an un-awaited promise here is cancelled by the runtime and the row silently never lands');
});

test('one reply offers one booking link, not two', () => {
  const i = SRC.indexOf('if (lgtReady(env ?? {})');
  const block = SRC.slice(i, i + 1400);
  assert.match(block, /\} else if \(wantsStay\(/,
    'two booking links and two fee disclosures in one reply is a banner, not a concierge');
});

/* ─────────────────────────────────────────────────────────────────────────
   THE FALLBACK RULE

   This is the only rail that sends a traveller OUT OF THE APP to a checkout
   that charges them a fee. It exists because Num cannot issue a ticket. The
   moment Num can, it must go quiet on its own — a fallback that has to be
   remembered is a fallback that becomes permanent.
   ───────────────────────────────────────────────────────────────────────── */
import { canIssueFlight } from './services.mjs';

test('the rail stands down the moment Num can issue a ticket itself', () => {
  const i = SRC.indexOf('if (lgtReady(env ?? {})');
  assert.ok(i > 0, 'the rail is not wired');
  assert.match(
    SRC.slice(i, i + 120),
    /if \(lgtReady\(env \?\? \{\}\) && !canIssueFlight\(env \?\? \{\}\)\)/,
    'a fallback that fires while Num can book itself is not a fallback',
  );
  assert.match(SRC, /import \{ servicesBlock, optionsFor, canIssueFlight \} from '\.\/services\.mjs'/,
    'the answer must come from services.mjs, not from a second opinion here');
});

// Two places with their own view of whether Num can book is how a fallback
// quietly becomes the primary route.
test('there is exactly one definition of whether Num can issue a flight', () => {
  assert.equal(canIssueFlight({}), false, 'nothing configured means Num cannot issue');
  assert.equal(canIssueFlight({ SABRE_BOOKING_ENABLED: 'true' }), false, 'the flag alone is not enough');
  assert.equal(canIssueFlight({ SABRE_BOOKING_PATHS: '/x' }), false, 'the paths alone are not enough');
  assert.equal(canIssueFlight({ SABRE_BOOKING_ENABLED: 'true', SABRE_BOOKING_PATHS: '/x' }), true);
  const SERVICES = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'services.mjs'), 'utf8');
  assert.equal(
    (SERVICES.match(/SABRE_BOOKING_ENABLED === 'true'/g) || []).length, 1,
    'the rule is written twice — one copy will drift',
  );
});

/* ── IT MUST READ AS A LAST STEP, NOT AS THE ANSWER ─────────────────────
   A concierge that opens with a link to somebody else's website is a search
   engine with better manners. */

test('the flight block does the job first and offers the handoff last', () => {
  const b = flightBlock(flightLink(ENV, { dest: 'LHR' }), ENV, {});
  assert.match(b, /THE LAST STEP ONLY/);
  assert.match(b, /do the whole job first/i);
  assert.match(b, /Never lead with the link, never send it unasked/);
});

test('both blocks say out loud that the traveller is leaving Num', () => {
  for (const [what, b] of [
    ['flight', flightBlock(flightLink(ENV, { dest: 'LHR' }), ENV, {})],
    ['stay', stayBlock(stayLink(ENV, { name: 'Dubai' }), ENV, { name: 'Dubai' })],
  ]) {
    assert.match(b, /leaves Num/, `${what} block does not say they are leaving the app`);
    assert.match(b, /another company/, what);
  }
});

test('the flight block names who they are actually buying from', () => {
  const b = flightBlock(flightLink(ENV, { dest: 'LHR' }), ENV, {});
  assert.match(b, /buying from LetsGo2Trip rather than from us/);
  assert.match(b, /book it themselves elsewhere say that is completely fine/,
    'an option they cannot decline is not an option');
});
