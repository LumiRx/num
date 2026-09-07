/**
 * One number, one string.
 *
 * `normalisePhone` used to return `(plus ? '+' : '') + digits` — it preserved
 * the ABSENCE of a country code and validated only 7-to-15 digits. Both halves
 * were live bugs, and both were found on 2026-08-21 by counting rows rather
 * than by reading code:
 *
 *  · `num_members.phone` is UNIQUE, but `4437079219` and `+14437079219` are
 *    different strings, so the constraint never fired. Isaiah Rich held two
 *    accounts. So did Rebekah. Each believed they had signed up once.
 *  · `+1989128566684` — thirteen digits after the +1, when NANP is ten — was
 *    accepted and stored by live code at 13:14 that day.
 *
 * It also broke the recovery path shipped days earlier: "does this number
 * already have an account?" is an exact string match, so a person who signed
 * up as `3107387319` and later typed `+1 310 738 7319` got a THIRD account
 * rather than their own back.
 *
 * Twilio Verify rejects anything that is not strict E.164 with error 60200, so
 * this is the gate that has to hold before OTP can move off Programmable
 * Messaging.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalisePhone } from '../claim/verify.mjs';

describe('the two spellings that made duplicate accounts', () => {
  test('bare national and +country collapse to one string — Isaiah', () => {
    assert.equal(normalisePhone('4437079219', 'US'), normalisePhone('+14437079219'));
  });
  test('and again with the country code typed without a plus', () => {
    assert.equal(normalisePhone('14437079219', 'US'), '+14437079219');
  });
  test('bare national and +country collapse to one string — Rebekah', () => {
    assert.equal(normalisePhone('3107387319', 'US'), normalisePhone('+13107387319'));
    assert.equal(normalisePhone('13107387319', 'US'), '+13107387319');
  });
  test('punctuation people actually type does not make a new identity', () => {
    const want = '+14437079219';
    for (const form of ['(443) 707-9219', '443.707.9219', '443 707 9219', '+1 (443) 707-9219']) {
      assert.equal(normalisePhone(form, 'US'), want, `${form} produced a different identity`);
    }
  });
});

describe('numbers that can never receive a code are refused, not stored', () => {
  test('thirteen digits after +1 is not a US number', () => {
    // The exact row live code accepted at 13:14 on 2026-08-21.
    assert.equal(normalisePhone('+1989128566684'), null);
  });
  test('a short UK number is refused', () => {
    assert.equal(normalisePhone('+44656612406'), null);
  });
  test('nine digits is not a US number either', () => {
    assert.equal(normalisePhone('443707921', 'US'), null);
  });
});

describe('a bare number without a region is refused rather than guessed', () => {
  test('no region, no plus, no number', () => {
    // 4437079219 is a Maryland mobile in the US and nothing at all in Thailand.
    // Guessing is how you text a stranger on another continent.
    assert.equal(normalisePhone('4437079219'), null);
    assert.equal(normalisePhone('4437079219', 'XX'), null);
  });
  test('the same digits in two regions are two different numbers', () => {
    assert.notEqual(normalisePhone('812345678', 'TH'), normalisePhone('4437079219', 'US'));
    assert.equal(normalisePhone('812345678', 'TH'), '+66812345678');
  });
});

describe('the regions Num actually serves', () => {
  test('UK trunk zero is stripped', () => {
    assert.equal(normalisePhone('07911123456', 'GB'), '+447911123456');
  });
  test('Thai trunk zero is stripped', () => {
    assert.equal(normalisePhone('0812345678', 'TH'), '+66812345678');
  });
  test('an already-good E.164 passes through untouched whatever the region', () => {
    assert.equal(normalisePhone('+66812345678', 'US'), '+66812345678');
    assert.equal(normalisePhone('+447911123456'), '+447911123456');
  });
  test('a country we do not have a rule for still passes on length', () => {
    // Num lists 77 destinations across 38 countries; this table is not a
    // phone-number library and must not reject the rest of the world.
    assert.equal(normalisePhone('+491701234567'), '+491701234567');
  });
});

describe('a trunk zero typed after the country code is a repair, not a rewrite', () => {
  test("Reema's real number is recovered rather than blanked", () => {
    // Stored 2026-08-14 as +44 followed by 07391794169 — the country code from
    // one place, the number written the way the UK writes it. One character
    // from working, and the first backfill plan would have thrown it away.
    assert.equal(normalisePhone('+4407391794169'), '+447391794169');
  });

  test('stripped even when the unstripped length is also valid', () => {
    // Thailand is where length alone cannot decide: +66 + 081234567 is eleven
    // digits and so is a real Thai mobile. A trunk prefix is for domestic
    // dialling only and no national number begins with 0, so the zero is
    // always the prefix.
    assert.equal(normalisePhone('+660812345678'), '+66812345678');
    assert.equal(normalisePhone('+66081234567'), '+6681234567');
  });

  test('a valid number is never touched by the repair', () => {
    for (const v of ['+447911123456', '+6676291797', '+13105550142', '+66996232171']) {
      assert.equal(normalisePhone(v), v, `${v} was rewritten`);
    }
  });

  test('the repair cannot rescue a number that is wrong for other reasons', () => {
    // 65 is not an assignable UK range at any length.
    assert.equal(normalisePhone('+44656612406'), null);
    assert.equal(normalisePhone('+1989128566684'), null);
  });
});

describe('nothing is accepted that could not be dialled', () => {
  test('empty and junk', () => {
    for (const v of [null, undefined, '', '   ', 'call the front desk', '+', '++']) {
      assert.equal(normalisePhone(v, 'US'), null, `${JSON.stringify(v)} was accepted`);
    }
  });
  test('every accepted value starts with + and is all digits after it', () => {
    for (const [v, r] of [['4437079219', 'US'], ['07911123456', 'GB'], ['+66812345678', undefined]]) {
      const out = normalisePhone(v, r);
      assert.match(out, /^\+[1-9]\d{6,14}$/, `${out} is not E.164`);
    }
  });
});

// ── 2 Sep 2026: the only real campaign arrival who tried to sign in ──────────
//
// `num_signin_events` row 6: member `mem_48bc80d044…`, stage `send`, outcome
// `failed`, reason `60200`. His stored number was `+44 991…` — ten digits
// after +44, beginning 99. Nothing in the UK numbering plan starts 99; an
// Indian mobile does. He typed a bare number while standing in Britain and
// the server put the country it could SEE on it. Sign-up now refuses a shape
// that cannot receive a text, and says which country it guessed.
import { normaliseMobile, plausibleMobile } from '../claim/verify.mjs';

describe('a number Twilio would answer 60200 to never reaches Twilio', () => {
  test('the exact shape from row 6: ten digits starting 99, region GB', () => {
    assert.equal(normaliseMobile('9919876543', 'GB'), null);
    assert.equal(normaliseMobile('+449919876543'), null);
  });
  test('the same digits with the right country code are a mobile', () => {
    assert.equal(normaliseMobile('9919876543', 'IN'), '+919919876543');
    assert.equal(normaliseMobile('+919919876543'), '+919919876543');
  });
  test('a real UK mobile still passes, with and without the trunk zero', () => {
    assert.equal(normaliseMobile('07391794169', 'GB'), '+447391794169');
    assert.equal(normaliseMobile('+447391794169'), '+447391794169');
  });
  test('a Thai landline is a phone but not a mobile — the desk may call it, sign-up may not text it', () => {
    assert.equal(normalisePhone('076360333', 'TH'), '+6676360333');
    assert.equal(normaliseMobile('076360333', 'TH'), null);
    assert.equal(normaliseMobile('0812345678', 'TH'), '+66812345678');
  });
  test('NANP: an area code cannot start 0 or 1', () => {
    assert.equal(normaliseMobile('1437079219', 'US'), null);
    assert.equal(normaliseMobile('4437079219', 'US'), '+14437079219');
  });
  test('a country we have no rule for passes on length alone — no opinion is not a refusal', () => {
    assert.equal(plausibleMobile('+2348012345678'), true);
  });
});
