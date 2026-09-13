// The one file in this product where "usually right" is not a standard.
//
// A wrong restaurant costs somebody an evening. A wrong ambulance number costs
// something else, and the person dialling it has no way to know it is wrong
// until it does not connect. So this table is asserted country by country, and
// the absence of a country is asserted too — because the dangerous failure is
// not a missing number, it is a plausible one.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EMERGENCY, FALLBACK, emergencyFor, emergencyLine, haveEmergency, asksEmergency } from './emergency.mjs';
import { DESTINATIONS } from '../scripts/destinations.mjs';

describe('the numbers themselves', () => {
  test('Thailand is 1669 for an ambulance, and 911 reaches nothing', () => {
    // The whole reason this file exists.
    const th = emergencyFor('TH');
    assert.equal(th.ambulance, '1669');
    assert.equal(th.police, '191');
    assert.notEqual(th.all, '911');
    assert.match(emergencyLine('TH'), /1669/);
  });

  test('Thailand surfaces the Tourist Police, who answer in English', () => {
    assert.match(emergencyLine('TH'), /1155/);
    assert.match(emergencyLine('TH'), /English/);
  });

  test('the 112 countries are 112, not their old national numbers only', () => {
    for (const cc of ['AT', 'CZ', 'DE', 'DK', 'ES', 'FR', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'NL', 'PT', 'SE', 'CH', 'TR']) {
      assert.equal(emergencyFor(cc).all, '112', `${cc} should reach 112`);
    }
  });

  test('countries where ambulance is NOT the police number say both', () => {
    for (const [cc, amb, pol] of [['SG', '995', '999'], ['AE', '998', '999'], ['JP', '119', '110'],
      ['TW', '119', '110'], ['VN', '115', '113'], ['KH', '119', '117']]) {
      const e = emergencyFor(cc);
      assert.equal(e.ambulance, amb, `${cc} ambulance`);
      assert.equal(e.police, pol, `${cc} police`);
      const line = emergencyLine(cc);
      assert.ok(line.includes(amb) && line.includes(pol), `${cc} must print both: ${line}`);
    }
  });

  test('the ambulance is named first when the numbers differ', () => {
    // Somebody asking this at speed is more often looking at a person than a crime.
    const line = emergencyLine('TH');
    assert.ok(line.indexOf('1669') < line.indexOf('191'), line);
  });

  test('every entry is digits only — no spaces, no +country code, no words', () => {
    for (const [cc, e] of Object.entries(EMERGENCY)) {
      for (const [field, v] of Object.entries(e)) {
        // France dials 15/17/18 — two digits is a real short code, not a typo.
        assert.match(String(v), /^\d{2,4}$/, `${cc}.${field} is not a dialable short code: ${v}`);
      }
    }
  });
});

describe('what it refuses to do', () => {
  test('an unknown country returns null — never 911, never a neighbour', () => {
    for (const cc of ['ZZ', 'XX', '', null, undefined, 'BB', 'BS']) {
      assert.equal(emergencyFor(cc), null, `${cc} must not resolve`);
    }
  });

  test('Barbados and the Bahamas are absent ON PURPOSE, and stay absent', () => {
    // Both run three-digit services alongside 911 routing and neither could be
    // verified to the standard the rest of the table is held to. If somebody
    // adds them, they must add a source with them — this test is the reminder.
    assert.equal(haveEmergency('BB'), false);
    assert.equal(haveEmergency('BS'), false);
  });

  test('an unknown country gets the fallback, and the fallback is useful', () => {
    const out = emergencyLine('ZZ');
    assert.equal(out, FALLBACK);
    assert.match(out, /112/, 'the fallback must still give them something that works');
    assert.match(out, /locked screen/, 'the locked-screen point is the most useful part');
    assert.match(out, /will not guess/, 'it must say plainly that it does not know');
  });

  test('the fallback never invents a number of its own', () => {
    assert.doesNotMatch(FALLBACK, /\b911\b/, '911 is wrong nearly everywhere Num operates');
    assert.doesNotMatch(FALLBACK, /\b999\b/);
  });
});

describe('coverage against the places Num actually sends people', () => {
  test('every country Num covers is either in the table or knowingly absent', () => {
    const covered = new Set(DESTINATIONS.map((d) => d.country));
    const missing = [...covered].filter((cc) => !haveEmergency(cc));
    // The two verified-absent ones. Anything else appearing here means Num sends
    // travellers to a country it cannot answer this question for.
    assert.deepEqual(missing.sort(), ['BB', 'BS'],
      `Num covers countries with no emergency entry: ${missing.join(', ')}`);
  });
});

describe('when it fires', () => {
  test('it recognises the ways people actually ask', () => {
    for (const q of ['whats the emergency number', 'i need an ambulance', 'call the police',
      'does 911 work here', 'emergency services', 'is it 112 here']) {
      assert.equal(asksEmergency(q), true, q);
    }
  });

  test('it does not fire on ordinary conversation', () => {
    for (const q of ['book me a table for 9', 'a bar with a police theme', 'room 911',
      'i need a plumber', 'what is the area code']) {
      assert.equal(asksEmergency(q), false, q);
    }
  });
});

describe('the model is not allowed to answer this', () => {
  test('the specialist brief tells it to read the table, not recall a number', () => {
    const src = readFileSync(new URL('./specialists.mjs', import.meta.url), 'utf8');
    assert.match(src, /NEVER state an emergency number from memory/i,
      'nothing stops the brain answering this from recall');
  });
});
