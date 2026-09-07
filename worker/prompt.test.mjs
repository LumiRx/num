// PERSONA + contextBlock — the two things every reply is built from.
//
// Three real gaps drove these tests (26 Aug): guests were re-asked things
// they'd already told Num because nothing server-side outlived localStorage
// (see memory.mjs — orthogonal to this file, but the KNOWN FACTS block here
// is the other half of that fix), replies read as one dense paragraph
// because nothing told the model to use the line breaks the app already
// renders (ThreadView.tsx: whiteSpace: 'pre-line'), and a place Num could
// not book was handed over as a bare name even when Num held its phone
// number and address the whole time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSONA, REPLY_SCHEMA, contextBlock } from './prompt.mjs';

test('a place with an address surfaces it in the partner line', () => {
  const block = contextBlock({
    partners: [{ name: 'Nong Beach Cafe', category: 'Cafe', phone: '+66812345678', address: '12 Beach Rd, Patong' }],
  });
  assert.match(block, /Nong Beach Cafe — Cafe, \+66812345678, 12 Beach Rd, Patong/,
    'the address the DB actually holds never reached the model');
});

test('a place with no address is not given a fake one — the field is simply absent', () => {
  const block = contextBlock({ partners: [{ name: 'No Address Place', category: 'Bar' }] });
  assert.match(block, /No Address Place — Bar$/m);
});

test('the CONTACT RULE points at the card, not at the prose', () => {
  // This test used to assert the opposite: "never leave a recommendation as a
  // bare name" — meaning hand the number and address over IN THE REPLY. That
  // was correct until `picks` shipped on 3 Sep and the app began rendering a
  // tappable call button, a map and the address on each pick's own card.
  //
  // From then on the model was reading two rules on the same turn: the reply
  // schema saying "do NOT repeat the names, phone numbers, addresses or links
  // in this prose field", and this one saying hand them over. This one sits
  // next to the actual rows, so this one won — and on 7 Sep a guest was given
  // "Lula is at 3542 Hollydale Dr #1/2 and their number is (213) 448-0661"
  // typed into a sentence, where a thumb cannot tap it.
  //
  // The concern the old test guarded is real and is unchanged: a guest must
  // never be left with a name they cannot act on. What changed is WHERE the
  // means of acting lives.
  const block = contextBlock({ partners: [{ name: 'X', category: 'Restaurant' }] });
  assert.match(block, /CONTACT RULE/);
  assert.match(block, /no "bookable via" tag means Num cannot complete a reservation there/);
  assert.match(block, /PUT THE PLACE IN `picks`/,
    'the rule no longer routes the guest to the card');
  assert.ok(!/never leave a recommendation as a bare name/i.test(block),
    'the old prose-handover rule is back, and it beats the reply schema every time');
  // The honest half is not lost: where Num holds nothing, it must say so
  // rather than implying the guest can reach them.
  assert.match(block, /neither a number nor an address/i);
});

test('the BOOKING and OPENING HOURS rules survive — the new CONTACT rule must not replace them', () => {
  const block = contextBlock({ partners: [{ name: 'X', category: 'Restaurant' }] });
  assert.match(block, /OPENING HOURS RULE/);
  assert.match(block, /BOOKING RULE/);
});

test('with no partners at all, contextBlock still returns cleanly (no partner section, no crash)', () => {
  const block = contextBlock({});
  assert.equal(typeof block, 'string');
  assert.ok(!/CONTACT RULE/.test(block), 'the contact rule is part of the partner section and must not appear without one');
});

test('PERSONA tells the model to format for a phone screen, not one dense paragraph', () => {
  assert.match(PERSONA, /FORMAT FOR A PHONE SCREEN/);
  assert.match(PERSONA, /blank line between distinct ideas/);
});

test('PERSONA tells the model to stay on the topic the guest raised', () => {
  assert.match(PERSONA, /STAY ON THE TOPIC THEY RAISED/);
});

// ── 3 Sep 2026 ────────────────────────────────────────────────────────────
// These two tests asserted the same properties against the REPLY PROSE, which
// was where recommendations used to live. They are re-pointed, not relaxed:
// the properties are unchanged, the structure that carries them moved.
//
//   "three options, one per line, and say which you'd pick" was a way of
//   making a paragraph scannable. It is now a list of cards, which is
//   scannable by construction — so the assertion moves to `picks` existing,
//   being sourced only from the verified block, and the prose being told to
//   stop repeating it.
//
//   "phone and address when Num cannot book it" is no longer an instruction
//   the model can forget: placelink.mjs attaches phone, address AND a link to
//   every pick from the verified row, and resolvePicks DROPS any pick it
//   cannot attach one to. The guarantee got stronger, so it is asserted where
//   it is now enforced — see worker/placelink.test.mjs.

test('recommendations are structured, and the prose is told not to repeat them', () => {
  const desc = REPLY_SCHEMA.properties.reply.description;
  assert.match(desc, /RECOMMENDATIONS GO IN `picks`, NOT IN THIS FIELD/);
  assert.match(desc, /Do NOT repeat the names, phone numbers, addresses or links/);
  assert.match(desc, /Never write a URL here/);
});

test('picks exist, are required, and may only name places from the verified block', () => {
  const picks = REPLY_SCHEMA.properties.picks;
  assert.ok(picks, 'picks is missing from the schema — the reply description has referenced it since August');
  assert.ok(REPLY_SCHEMA.required.includes('picks'));
  const items = picks.anyOf.find((x) => x.type === 'array');
  assert.match(items.description, /ONLY places from the VERIFIED NEARBY PARTNERS/);
  assert.deepEqual(items.items.required, ['name', 'why']);
  // The model supplies identity and reasoning only. Nothing tappable — no
  // url, link, phone or address field exists here for it to fill in, which is
  // what makes a hallucinated link structurally impossible rather than merely
  // discouraged.
  const props = Object.keys(items.items.properties);
  assert.deepEqual(props.sort(), ['id', 'name', 'why']);
  for (const banned of ['url', 'link', 'website', 'phone', 'address', 'map']) {
    assert.equal(props.includes(banned), false, `the model must not be able to write "${banned}" — links are attached server-side`);
  }
});

test('PERSONA carries the same rule, so it holds on every turn and not just recommendations', () => {
  assert.match(PERSONA, /EVERY PLACE YOU NAME GOES IN THE "picks" FIELD, AND NEVER IN PROSE/);
  assert.match(PERSONA, /You never write a web address, ever/);
});

test('a hungry guest is asked HOW they want to eat, not sent to a delivery app', () => {
  // Reported by real guests: asking about food pushed them straight to
  // DoorDash / Uber Eats when what they wanted was a table. A concierge that
  // answers the wrong question quickly is worse than one that asks.
  assert.match(PERSONA, /HOW SOMEONE EATS IS A QUESTION, NOT AN ASSUMPTION/);
  assert.match(PERSONA, /Eat there.*Delivery.*Pick up/s, 'the three choices are not offered as chips');
  assert.match(PERSONA, /do NOT emit a service action yet/i);
  // And the escape hatch, so it does not become obtuse.
  assert.match(PERSONA, /Skip the question ONLY when they have already told you/);
});

test('the food action itself carries the constraint, not just the persona', () => {
  // A rule that lives only in prose is one the model can drift past. The
  // schema description is read at the moment the action is chosen.
  const schema = JSON.stringify(REPLY_SCHEMA);
  assert.match(schema, /`food` means DELIVERY and nothing else/);
  assert.match(schema, /A guest who wants to eat out is `table`/);
});
