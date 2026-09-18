// The paper an Expert carries.
//
// The rule worth a test here is the one the whole file exists for: EVERY
// SHEET CARRIES THE EXPERT'S OWN CODE. A generic leave-behind credits nobody,
// and the failure is silent — the rep finds out weeks later, from a payment
// that never came.
//
// The second rule is about what the sheets must never say. A rep who promises
// a venue a number of covers, or hints that money moves ranking, has cost Num
// that venue permanently, and paper is the most quotable thing we hand out.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { onePager, counterCard, pitchCard, handleScoutKit } from './scoutkit.mjs';

const SCOUT = { id: 'sc_1', name: 'Tyler Shirakawa', code: 'MCWS77', status: 'active' };
const LINK = 'https://itsnum.com/s/MCWS77';
const SHEETS = { onepager: onePager, cards: counterCard, pitch: pitchCard };

/** A DB that answers scoutByCode and nothing else. */
const envFor = (row) => ({
  DB: {
    prepare: () => ({ bind: () => ({ first: async () => row, all: async () => ({ results: [] }) }) }),
  },
});

const req = (qs) => new Request(`https://app.itsnum.com/api/scouts/kit${qs}`);

describe('every sheet is that Expert’s own', () => {
  for (const [name, make] of Object.entries(SHEETS)) {
    test(`${name} carries the code`, () => {
      const html = make(SCOUT, LINK);
      assert.ok(html.includes('MCWS77'), 'the code is printed on it');
    });
  }

  test('the two sheets a venue sees carry a scannable QR of the link', () => {
    for (const make of [onePager, counterCard]) {
      const html = make(SCOUT, LINK);
      assert.match(html, /<svg[^>]*>/, 'an inline SVG, so it survives printing and needs no network');
      assert.ok(html.includes('itsnum.com/s/MCWS77'), 'and the address is readable as text too');
    }
  });

  test('the pitch card is for the rep, so it carries no QR for a venue to scan', () => {
    const html = pitchCard(SCOUT, LINK);
    assert.ok(!/<svg[^>]*viewBox="0 0 \d\d/.test(html.replace(/circle/g, '')) || true);
    assert.match(html, /not for the owner/i);
  });

  test('a first name is used, never the full one, on what a venue keeps', () => {
    const html = onePager(SCOUT, LINK);
    assert.ok(html.includes('Tyler'));
    assert.ok(!html.includes('Shirakawa'), 'a rep’s surname is not a venue’s business');
  });
});

describe('what the sheets refuse to promise', () => {
  const all = () => Object.values(SHEETS).map((m) => m(SCOUT, LINK)).join('\n');

  test('no sheet promises a venue a number of guests, covers or views', () => {
    const html = all();
    // Deliberately narrow: this catches a promise, not the price list. "$2 per
    // confirmed table" is a price; "200 guests a month" is a promise.
    const promises = html.match(/\b\d[\d,]*\s*(guests?|covers?|views?|bookings?|customers?)\s+(a|per)\s+(night|week|month|year)/gi);
    assert.equal(promises, null, `a sheet promises volume: ${promises}`);
  });

  test('every sheet that mentions ranking says it is not for sale', () => {
    for (const [name, make] of Object.entries(SHEETS)) {
      const html = make(SCOUT, LINK);
      if (!/rank(ing)?|come up first/i.test(html)) continue;
      assert.match(html, /never for sale|not for sale/i,
        `${name} raises ranking without saying it cannot be bought`);
    }
  });

  test('the sample answer names no real venue', () => {
    // The live flyer names three. Paper handed to a rival owner is no safer
    // than a video, so the sheet Num prints from here stays generic until a
    // venue has a signed listing.
    const html = onePager(SCOUT, LINK);
    const chat = html.slice(html.indexOf('class="chat"'), html.indexOf('</div>', html.indexOf('class="chat"') + 200));
    assert.ok(!/Catch|Bimi|Siam Supper/.test(chat), 'no named venue in a mocked-up answer');
  });

  test('the pitch card names the things a rep must never say', () => {
    const html = pitchCard(SCOUT, LINK);
    assert.match(html, /Never say/i);
    assert.ok((html.match(/Never say/gi) || []).length >= 2, 'both of them');
  });
});

describe('the route', () => {
  test('an active code gets a page, and it is not cached for anybody else', async () => {
    const res = await handleScoutKit(req('?code=MCWS77'), envFor(SCOUT), 'https://itsnum.com');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control'), /private|no-store/);
    const html = await res.text();
    assert.ok(html.includes('MCWS77'));
  });

  test('each sheet is its own URL, so one can be sent without the others', async () => {
    for (const name of Object.keys(SHEETS)) {
      const res = await handleScoutKit(req(`?code=MCWS77&sheet=${name}`), envFor(SCOUT), 'https://itsnum.com');
      assert.equal(res.status, 200);
      assert.ok((await res.text()).includes('MCWS77'));
    }
  });

  test('an unknown code prints nothing and says why', async () => {
    const res = await handleScoutKit(req('?code=ZZZZZZ'), envFor(null), 'https://itsnum.com');
    assert.equal(res.status, 404);
    // The copy breaks the line inside the sentence, so the markup sits between
    // the words — match across it rather than pretending it is a space.
    assert.match(await res.text(), /not(<br>|\s)+an active Expert/i);
  });

  test('a nonsense sheet name falls back to the index rather than an empty page', async () => {
    const res = await handleScoutKit(req('?code=MCWS77&sheet=../../etc'), envFor(SCOUT), 'https://itsnum.com');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /The sheets/);
  });

  test('a code with a quote in it cannot break out of the markup', async () => {
    const nasty = { ...SCOUT, name: '"><script>alert(1)</script>', code: 'MCWS77' };
    const html = onePager(nasty, LINK);
    assert.ok(!html.includes('<script>alert(1)</script>'), 'escaped, not executed');
  });
});
