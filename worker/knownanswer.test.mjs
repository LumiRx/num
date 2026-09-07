/**
 * The questions that must never reach a model, and the ones that must.
 *
 * The second half matters more. A lookup gate that fires too eagerly answers
 * a conversation with a database field, and the guest gets a worse product to
 * save a tenth of a cent — the worst trade in the building.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { factAsked, placeInPlay, knownAnswer, FACTS } from './knownanswer.mjs';
import { toHex, WIDTH } from './hours.mjs';

// A mask that is open every hour of the week, and one that is never open.
const always = () => { const m = new Uint8Array(WIDTH / 8).fill(0xff); return toHex(m); };
const never = () => toHex(new Uint8Array(WIDTH / 8));

const NAHM = {
  id: 'p1', name: 'Nahm', address: '27 South Sathorn Road', phone: '+66 2 625 3388',
  website: 'https://nahm.example', hours_mask: always(),
};
const BOLAN = { id: 'p2', name: 'Bo.lan', address: '24 Sukhumvit 53', phone: '+66 2 260 2962', website: 'https://bolan.example' };
const partners = [NAHM, BOLAN];
const ask = (text, prevAssistant = '') => knownAnswer({ text, prevAssistant, partners, tz: 'Asia/Bangkok' });

describe('what it recognises', () => {
  test('the four lookups, and only those', () => {
    assert.deepEqual([...FACTS], ['hours', 'address', 'phone', 'link']);
    assert.equal(factAsked('what time does it open'), 'hours');
    assert.equal(factAsked('are they open?'), 'hours');
    assert.equal(factAsked('is it still open'), 'hours');
    assert.equal(factAsked("what's the address"), 'address');
    assert.equal(factAsked('address for Nahm'), 'address');
    assert.equal(factAsked('what is the phone number'), 'phone');
    assert.equal(factAsked('do they have a website'), 'link');
  });

  test('an ordinary conversation is not a lookup', () => {
    for (const q of [
      'where should we eat tonight',
      'is it open, and should we go?',
      'book me a table when they open',
      'what time does it open and how much is dinner',
      'which one is better',
      'why is it closed',
      'is it any good',
      'what time does it open? is it busy?',
    ]) assert.equal(factAsked(q), null, q);
  });

  test('two facts in one sentence is a conversation', () => {
    assert.equal(factAsked('what are the hours and the address'), null);
  });

  test('a long message is never a lookup', () => {
    assert.equal(factAsked(`what time does it open ${'x'.repeat(120)}`), null);
  });
});

describe('which place it is about', () => {
  test('named in the question wins', () => {
    assert.equal(placeInPlay('address for Bo.lan', 'I would go to Nahm', partners).id, 'p2');
  });

  test('otherwise the place Num just named', () => {
    assert.equal(placeInPlay('what time does it open', 'Nahm is the one I would pick.', partners).id, 'p1');
  });

  test('TWO places in play means no answer — guessing is worse than paying', () => {
    assert.equal(placeInPlay('what time does it open', 'Nahm or Bo.lan, both good.', partners), null);
  });

  test('a place we do not hold is not a place', () => {
    assert.equal(placeInPlay('what time does Somewhere Else open', '', partners), null);
  });

  test('a very short name never matches by accident', () => {
    const rows = [{ id: 'x', name: 'Ba' }];
    assert.equal(placeInPlay('is it open', 'ba ba black sheep', rows), null);
  });
});

describe('the answers themselves', () => {
  test('hours come from the verified mask', () => {
    const out = ask('what time does it open', 'Nahm is the one.');
    assert.equal(out.fact, 'hours');
    assert.equal(out.place, 'Nahm');
    assert.match(out.reply, /open 24 hours/);
    assert.deepEqual(out.pick, { id: 'p1', name: 'Nahm', why: null });
  });

  test('a closed place is reported closed, not "probably closed"', () => {
    const shut = [{ ...NAHM, hours_mask: never() }];
    const out = knownAnswer({ text: 'is it open', prevAssistant: 'Nahm', partners: shut, tz: 'Asia/Bangkok' });
    assert.match(out.reply, /closed/);
    assert.doesNotMatch(out.reply, /probably|might|maybe|should be/i);
  });

  test('NO hours on the row means a brain gets it — never a shrug at the guest', () => {
    const unknown = [{ ...NAHM, hours_mask: null }];
    assert.equal(knownAnswer({ text: 'what time does it open', prevAssistant: 'Nahm', partners: unknown, tz: 'Asia/Bangkok' }), null);
  });

  test('the address is read out; the phone number is NOT', () => {
    // A number inside a sentence cannot be tapped by somebody walking. Same
    // rule the concierge follows — the card carries the call button.
    const addr = ask('what is the address', 'Nahm');
    assert.match(addr.reply, /27 South Sathorn Road/);
    const tel = ask('what is the phone number', 'Nahm');
    assert.doesNotMatch(tel.reply, /\+?66|\d{3}/);
    assert.match(tel.reply, /call button/);
  });

  test('a missing field falls through rather than inventing one', () => {
    const bare = [{ id: 'p9', name: 'Bare Place' }];
    for (const q of ['what is the address', 'what is the phone number', 'do they have a website']) {
      assert.equal(knownAnswer({ text: q, prevAssistant: 'Bare Place', partners: bare }), null, q);
    }
  });

  test('a pronoun with nothing behind it is not answered', () => {
    // "what time does it open" with no place named anywhere is a question we
    // cannot safely answer, even though a row exists.
    assert.equal(knownAnswer({ text: 'what time does it open', prevAssistant: 'Sure, one moment.', partners, tz: 'Asia/Bangkok' }), null);
  });

  test('no partners at all means no gate', () => {
    assert.equal(knownAnswer({ text: 'what is the address', prevAssistant: 'Nahm', partners: [] }), null);
  });
});

describe('it never generates', () => {
  test('every reply is built from row fields and fixed sentences', () => {
    const outs = [
      ask('what time does it open', 'Nahm'),
      ask('what is the address', 'Nahm'),
      ask('what is the phone number', 'Nahm'),
      ask('do they have a website', 'Nahm'),
    ];
    for (const o of outs) {
      assert.ok(o.reply.length < 120, 'a lookup answer is one short sentence');
      assert.doesNotMatch(o.reply, /I think|probably|might be|around|about|approximately/i);
    }
  });
});
