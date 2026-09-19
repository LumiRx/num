/**
 * The sentences, read back.
 *
 * travelreferral.test.mjs established why this kind of test is worth having:
 * a prompt constant is code that produces speech, and the way it goes wrong is
 * not a crash — it is somebody softening a line during a refactor because the
 * new wording reads better, and the suite staying green while NUM starts
 * making a promise it did not mean.
 *
 * So each constant is asserted on what it must FORBID or must SAY, not on its
 * exact text. Rewording is allowed. Losing the rule is not.
 *
 *   node --test worker/staysprompt.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  HELD_IS_NOT_BOOKED, PRICE_EXPIRES, NO_INVENTED_COMPARISON, SAY_THE_TERMS,
  HUMAN_CONFIRMS, WHAT_YOU_CAN_DO, MEMBER_RATE_LINE, WHAT_COUNTS_AS_A_STAY,
  NO_SUPPLIER, stayBlock,
} from './staysprompt.mjs';

describe('the refusals survive rewording', () => {
  test('held is kept apart from booked', () => {
    assert.match(HELD_IS_NOT_BOOKED, /not a reservation/i);
    assert.match(HELD_IS_NOT_BOOKED, /confirmation code/i);
  });

  test('a stale price may not be repeated', () => {
    assert.match(PRICE_EXPIRES, /never repeat/i);
    assert.match(PRICE_EXPIRES, /before they commit/i);
  });

  test('no invented comparison, and no competitor named', () => {
    assert.match(NO_INVENTED_COMPARISON, /cheapest/i);
    for (const site of ['Booking.com', 'Kayak', 'Expedia', 'Agoda']) {
      assert.ok(NO_INVENTED_COMPARISON.includes(site), `${site} is not named as forbidden`);
    }
    assert.match(NO_INVENTED_COMPARISON, /you have not compared anything/i);
  });

  test('the three terms are all named', () => {
    assert.match(SAY_THE_TERMS, /cancel/i);
    assert.match(SAY_THE_TERMS, /total/i);
    assert.match(SAY_THE_TERMS, /owed at the hotel/i);
  });

  test('the model never books and never asks for a card', () => {
    assert.match(HUMAN_CONFIRMS, /you do not book/i);
    assert.match(HUMAN_CONFIRMS, /card number|CVV/i);
  });

  test('and it is told it CAN book, so it stops under-promising', () => {
    assert.match(WHAT_YOU_CAN_DO, /confirmation code/i);
    assert.match(WHAT_YOU_CAN_DO, /only suggest/i);
  });

  test('the member figure is never said to somebody signed out', () => {
    assert.match(MEMBER_RATE_LINE, /never say the member figure|NEVER say the member figure/i);
    assert.match(MEMBER_RATE_LINE, /supplier term/i,
      'if this reads as a marketing choice, somebody will override it for a campaign');
  });

  test('student halls are never offered as a hotel', () => {
    assert.match(WHAT_COUNTS_AS_A_STAY, /student halls|staff residence/i);
  });

  test('with no supplier, NUM may not estimate', () => {
    assert.match(NO_SUPPLIER, /never estimate/i);
    assert.match(NO_SUPPLIER, /"from"/i);
    assert.match(NO_SUPPLIER, /direct to the hotel/i);
  });
});

describe('the assembled block', () => {
  test('capability comes first, so the model knows what it is before what it must not do', () => {
    const b = stayBlock({ signedIn: true, canBook: true });
    assert.ok(b.indexOf(WHAT_YOU_CAN_DO) === 0, 'a prompt that opens on refusals produces a model that hedges');
  });

  test('without booking, the booking-only lines are absent', () => {
    const b = stayBlock({ signedIn: true, canBook: false });
    assert.ok(!b.includes(WHAT_YOU_CAN_DO));
    assert.ok(!b.includes(HELD_IS_NOT_BOOKED));
    assert.ok(!b.includes(HUMAN_CONFIRMS));
    // The rules that apply whatever the supplier is must still be there.
    assert.ok(b.includes(SAY_THE_TERMS));
    assert.ok(b.includes(NO_INVENTED_COMPARISON));
  });

  test('a signed-out turn is told every price it holds is a public one', () => {
    assert.match(stayBlock({ signedIn: false, canBook: true }), /NOT signed in/);
    assert.ok(!stayBlock({ signedIn: true, canBook: true }).includes('NOT signed in'));
  });

  test('every line is in the block exactly once — a repeated rule reads as emphasis and crowds the turn', () => {
    const b = stayBlock({ signedIn: false, canBook: true });
    for (const line of [SAY_THE_TERMS, PRICE_EXPIRES, NO_INVENTED_COMPARISON, MEMBER_RATE_LINE]) {
      assert.equal(b.split(line).length - 1, 1);
    }
  });
});
