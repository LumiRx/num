import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ASK_FROM_DAYS, ASK_UNTIL_DAYS, shouldAsk, checkPassport, passportBlock,
} from './passportcheck.mjs';

describe('the verdict', () => {
  test('a passport that runs out before the trip is expired, full stop', () => {
    assert.equal(checkPassport({ expiry: '2026-10-01', tripDate: '2026-12-01' }).state, 'expired');
  });

  test('valid on the day but short of six months is short, not ok', () => {
    // This is the case that strands people: the passport is genuinely valid
    // and the airline refuses them anyway.
    const c = checkPassport({ expiry: '2027-01-15', tripDate: '2026-12-01' });
    assert.equal(c.state, 'short');
    assert.equal(c.needsUntil, '2027-06-01');
  });

  test('six clear months is ok', () => {
    assert.equal(checkPassport({ expiry: '2027-07-01', tripDate: '2026-12-01' }).state, 'ok');
  });

  test('exactly six months to the day clears it', () => {
    assert.equal(checkPassport({ expiry: '2027-06-01', tripDate: '2026-12-01' }).state, 'ok');
  });

  test('one day under does not', () => {
    assert.equal(checkPassport({ expiry: '2027-05-31', tripDate: '2026-12-01' }).state, 'short');
  });

  test('nothing on file is unknown, never ok', () => {
    assert.equal(checkPassport({ tripDate: '2026-12-01' }).state, 'unknown');
    assert.equal(checkPassport({ expiry: '2027-07-01' }).state, 'unknown');
    assert.equal(checkPassport({}).state, 'unknown');
  });

  test('an expiry Num cannot read is unknown, not a pass', () => {
    // passportValidFor returns null for an unparseable date. Treating that as
    // "fine" is how a garbled row clears somebody to be turned away.
    for (const bad of ['soon', '', '31/12/2027', 'null']) {
      assert.equal(checkPassport({ expiry: bad, tripDate: '2026-12-01' }).state, 'unknown', bad);
    }
  });

  test('a month boundary does not roll into the wrong month', () => {
    // 31 August plus six months is 28/29 February, not 31 February.
    const c = checkPassport({ expiry: '2027-01-01', tripDate: '2026-08-31' });
    assert.match(c.needsUntil, /^2027-0[23]-/);
  });
});

describe('asking, at most once, and only when it helps', () => {
  const base = { daysOut: 60, destination: 'Japan' };

  test('a trip in the window with nothing on file earns the question', () => {
    assert.equal(shouldAsk(base), true);
  });

  test('a trip too far out does not', () => {
    assert.equal(shouldAsk({ ...base, daysOut: ASK_FROM_DAYS + 1 }), false);
  });

  test('a trip too close does not, because there is nothing they can do', () => {
    // Below the floor Num warns; it does not ask a question whose answer can
    // only frighten somebody who cannot act on it.
    assert.equal(shouldAsk({ ...base, daysOut: ASK_UNTIL_DAYS - 1 }), false);
  });

  test('both edges of the window are inside it', () => {
    assert.equal(shouldAsk({ ...base, daysOut: ASK_FROM_DAYS }), true);
    assert.equal(shouldAsk({ ...base, daysOut: ASK_UNTIL_DAYS }), true);
  });

  test('already asked means never again', () => {
    assert.equal(shouldAsk({ ...base, asked: true }), false);
  });

  test('already on file means there is nothing to ask', () => {
    assert.equal(shouldAsk({ ...base, onFile: true }), false);
  });

  test('no destination, no question', () => {
    assert.equal(shouldAsk({ ...base, destination: null }), false);
  });

  test('no date, no question', () => {
    for (const d of [null, undefined, NaN, 'soon']) {
      assert.equal(shouldAsk({ ...base, daysOut: d }), false);
    }
  });
});

describe('the expiry date never reaches the model', () => {
  const EXPIRY = '2027-01-15';

  test('the short block does not contain the date', () => {
    const b = passportBlock({ expiry: EXPIRY, tripDate: '2026-12-01', daysOut: 60, destination: 'Japan' });
    assert.equal(b.includes(EXPIRY), false, 'the passport expiry leaked into the prompt');
  });

  test('the expired block does not contain the date', () => {
    const b = passportBlock({ expiry: '2026-10-01', tripDate: '2026-12-01', daysOut: 60, destination: 'Japan' });
    assert.equal(b.includes('2026-10-01'), false);
  });

  test('no block ever contains anything shaped like an expiry', () => {
    // A blunt instrument on purpose. needsUntil is derived from the TRIP date
    // and is allowed; anything else that looks like a date is a leak.
    for (const days of [5, 30, 60, 119]) {
      for (const expiry of [EXPIRY, '2026-10-01', '2027-07-01', null]) {
        const b = passportBlock({ expiry, tripDate: '2026-12-01', daysOut: days, destination: 'Japan' });
        if (!b) continue;
        const dates = b.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
        const allowed = checkPassport({ expiry, tripDate: '2026-12-01' }).needsUntil;
        for (const d of dates) assert.equal(d, allowed, `${d} is in the block and is not needsUntil`);
      }
    }
  });

  test('the model is told not to invent the date it was not given', () => {
    const b = passportBlock({ expiry: EXPIRY, tripDate: '2026-12-01', daysOut: 60, destination: 'Japan' });
    assert.match(b, /do not state or guess one/);
    const e = passportBlock({ expiry: '2026-10-01', tripDate: '2026-12-01', daysOut: 60, destination: 'Japan' });
    assert.match(e, /Do not state the date/);
  });
});

describe('what the block says, and when it says nothing', () => {
  test('a good passport produces no block at all', () => {
    // "You're all set" is a claim Num is not entitled to make: it cannot see
    // their visa, their purpose, or the airline's own policy.
    assert.equal(passportBlock({ expiry: '2027-07-01', tripDate: '2026-12-01', daysOut: 60, destination: 'Japan' }), null);
  });

  test('no trip, no block', () => {
    assert.equal(passportBlock({}), null);
    assert.equal(passportBlock({ destination: 'Japan' }), null);
  });

  test('expired comes first and is not softened into a footnote', () => {
    const b = passportBlock({ expiry: '2026-10-01', tripDate: '2026-12-01', daysOut: 40, destination: 'Japan' });
    assert.match(b, /EXPIRES BEFORE THE TRIP/);
    assert.match(b, /say it first/);
    assert.match(b, /without alarm/);
  });

  test('short says where people are actually stopped', () => {
    const b = passportBlock({ expiry: '2027-01-15', tripDate: '2026-12-01', daysOut: 60, destination: 'Japan' });
    assert.match(b, /CHECK-IN DESK/);
    assert.match(b, /not at the border/);
  });

  test('a short passport with time left is told there is time', () => {
    const far = passportBlock({ expiry: '2027-01-15', tripDate: '2026-12-01', daysOut: 90, destination: 'Japan' });
    assert.match(far, /There is time to renew/);
  });

  test('a short passport with no time is pointed at the expedited service', () => {
    const near = passportBlock({ expiry: '2027-01-15', tripDate: '2026-12-01', daysOut: 20, destination: 'Japan' });
    assert.match(near, /expedited/);
    assert.equal(/There is time to renew/.test(near), false);
  });

  test('every block tells the model to say it once', () => {
    for (const expiry of ['2027-01-15', null]) {
      const b = passportBlock({ expiry, tripDate: '2026-12-01', daysOut: 60, destination: 'Japan' });
      assert.match(b, /once|twice|Do not repeat/i);
    }
  });

  test('the ask is a question, not a form', () => {
    const b = passportBlock({ tripDate: '2026-12-01', daysOut: 60, destination: 'Japan' });
    assert.match(b, /NOT ON FILE/);
    assert.match(b, /not as a form/);
    assert.match(b, /do not raise it again/);
  });

  test('the ask never fires outside the window', () => {
    assert.equal(passportBlock({ tripDate: '2027-12-01', daysOut: 400, destination: 'Japan' }), null);
    assert.equal(passportBlock({ tripDate: '2026-09-16', daysOut: 2, destination: 'Japan' }), null);
  });
});

describe('the turn is actually wired', () => {
  const read = (f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
  const IDX = read('index.mjs');
  const PROMPT = read('prompt.mjs');

  test('the block reaches the context', () => {
    assert.match(PROMPT, /contextBlock\(\{[\s\S]{0,600}?\bpassport = null\b/);
    assert.match(PROMPT, /if \(passport\) lines\.push\(passport\)/);
    assert.match(IDX, /passport,/);
  });

  test('the database is not touched for a trip nowhere near the window', () => {
    const slice = IDX.slice(IDX.indexOf('let passport = null;'), IDX.indexOf('const groundingBlock'));
    assert.match(slice, /if \(inWindow && env\?\.DB && memberId\)/);
  });

  test('only the self row is read, not the whole party', () => {
    const slice = IDX.slice(IDX.indexOf('let passport = null;'), IDX.indexOf('const groundingBlock'));
    assert.match(slice, /SELECT passport_expires_on FROM num_passengers/);
    assert.match(slice, /is_self=1/);
    assert.match(slice, /deleted_at IS NULL/);
  });

  test('a failed lookup cannot take the turn down', () => {
    const slice = IDX.slice(IDX.indexOf('let passport = null;'), IDX.indexOf('const groundingBlock'));
    assert.match(slice, /\.catch\(\(\) => null\)/);
    assert.match(slice, /\} catch \{/);
  });

  test('the check no longer lives only inside the flight order', () => {
    // The whole point: it used to fire after somebody had already paid.
    const src = read('passportcheck.mjs');
    assert.match(src, /not only a flight Num sold/);
    assert.match(src, /import \{ passportValidFor, PASSPORT_MONTHS_REQUIRED \} from '\.\/flightbooking\.mjs'/);
  });
});
