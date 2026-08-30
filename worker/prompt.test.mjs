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

test('the CONTACT RULE tells the model to hand over phone/address when it cannot book', () => {
  const block = contextBlock({ partners: [{ name: 'X', category: 'Restaurant' }] });
  assert.match(block, /CONTACT RULE/);
  assert.match(block, /no "bookable via" tag means Num cannot complete a reservation there/);
  assert.match(block, /never leave a recommendation as a bare name/i);
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

test('the reply schema still requires three recommendations, one per line, with a pick', () => {
  const desc = REPLY_SCHEMA.properties.reply.description;
  assert.match(desc, /give THREE options, always/);
  assert.match(desc, /ONE PER LINE/);
  assert.match(desc, /say which ONE you would pick/);
});

test('the reply schema ties the phone/address fallback to the moment Num cannot book it', () => {
  const desc = REPLY_SCHEMA.properties.reply.description;
  assert.match(desc, /no "bookable via" tag, add its phone number and address/);
  assert.match(desc, /never invented/);
});
