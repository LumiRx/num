/**
 * THE PAPERWORK RAIL, AND THE ONE RULE THAT CANNOT BEND.
 *
 * Dre, 14 Sep 2026: "this is one of the hardest for people to figure out."
 *
 * The hardest part is not finding the form. It is that searching for the form
 * returns a page of sites built to be mistaken for the government. Search
 * "ETIAS" and you get etiaspro, etiasanswers, etias.com. Search "UK ETA" and
 * you get etagov.uk. They take a free or £20 government form and charge three
 * to five times for it, and the people who fall for them are people who were
 * being careful.
 *
 * So the single hardest rule in this file is asserted first and hardest:
 * every link is an official government address, and the build fails if one
 * ever is not.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COVERED, DOCS, KIND, OFFICIAL_HOSTS, SCHENGEN, docsBlock, docsFor,
  handleTravelDocs, isOfficial, urgency,
} from './traveldocs.mjs';

const everyDoc = () => Object.values(DOCS).flat();

describe('every link is the government, and nothing else ever', () => {
  test('every seeded URL is https and on the official allowlist', () => {
    for (const d of everyDoc()) {
      assert.ok(isOfficial(d.url), `${d.name} points somewhere that is not an official host: ${d.url}`);
    }
  });

  test('the allowlist itself contains only government domains', () => {
    // The check that stops the allowlist being widened to "fix" a link.
    // Not every government lives under .gov: Canada is canada.ca, the EU is
    // europa.eu, Korea is .go.kr, New Zealand is .govt.nz. The list is
    // explicit rather than clever, because a regex loose enough to cover
    // them all is loose enough to let an impostor in.
    const ok = /(\.gov(\.[a-z]{2})?$|\.go\.[a-z]{2}$|\.govt\.nz$|^www\.canada\.ca$|europa\.eu$)/;
    for (const h of OFFICIAL_HOSTS) {
      assert.match(h, ok, `${h} is not a government host`);
    }
  });

  test('no known copycat or agency domain can ever be reached', () => {
    // Named, so the intent survives a refactor. These are real sites that
    // rank above the government for their own scheme's name.
    const impostors = [
      'etias.com', 'etiaspro.com', 'etiasanswers.com', 'etagov.uk',
      'visahq.com', 'ivisa.com', 'evisa.com', 'schengentraveler.com',
    ];
    const hosts = new Set(OFFICIAL_HOSTS);
    for (const bad of impostors) {
      assert.equal(hosts.has(bad), false, `${bad} is on the allowlist`);
      assert.equal(isOfficial(`https://${bad}/apply`), false, `${bad} passes isOfficial`);
    }
  });

  test('http is never official, even on a real government host', () => {
    assert.equal(isOfficial('http://esta.cbp.dhs.gov/'), false);
    assert.equal(isOfficial('https://esta.cbp.dhs.gov/'), true);
  });

  test('a lookalike subdomain does not pass', () => {
    assert.equal(isOfficial('https://esta.cbp.dhs.gov.evil.com/'), false);
    assert.equal(isOfficial('https://www.gov.uk.fake.co/'), false);
  });

  test('nonsense fails closed', () => {
    for (const v of [null, undefined, '', 'not a url', 'javascript:alert(1)']) {
      assert.equal(isOfficial(v), false);
    }
  });
});

describe('what a traveller gets asked for', () => {
  test('Thailand is an arrival card, and it is free', () => {
    const [d] = docsFor('TH').docs;
    assert.equal(d.kind, KIND.ARRIVAL_CARD);
    assert.equal(d.free, true, 'their own page says no fees — the copycats charge for it');
    assert.match(d.url, /^https:\/\/tdac\.immigration\.go\.th/);
  });

  test('any Schengen country answers with ETIAS, not with nothing', () => {
    // A traveller going to Portugal should not be told Num knows nothing
    // because the row is filed under the area rather than the country.
    for (const cc of ['FR', 'PT', 'EE', 'IS', 'CH']) {
      const out = docsFor(cc);
      assert.equal(out.covered, true, cc);
      assert.equal(out.docs[0].name, 'ETIAS', cc);
    }
    assert.equal(SCHENGEN.length >= 29, true);
  });

  test('India carries two different things, and they are different kinds', () => {
    const kinds = docsFor('IN').docs.map((d) => d.kind);
    assert.deepEqual(kinds, [KIND.VISA, KIND.ARRIVAL_CARD]);
  });

  test('case and whitespace do not defeat it', () => {
    assert.equal(docsFor(' th ').docs.length, 1);
    assert.equal(docsFor('gb').docs[0].name, 'UK ETA');
  });

  test('an unseeded country is honest, not invented', () => {
    const out = docsFor('BR');
    assert.equal(out.covered, false);
    assert.deepEqual(out.docs, []);
  });

  test('a bad code is not treated as a country', () => {
    for (const v of ['', 'X', 'THAI', '12', null]) assert.equal(docsFor(v).covered, false);
  });

  test('forty destinations are covered today', () => {
    assert.equal(COVERED.length, 40);
    assert.ok(COVERED.includes('TH') && COVERED.includes('FR') && COVERED.includes('US'));
  });
});

describe('urgency is measured in the only unit that matters', () => {
  test('a visa nine days out is urgent; an authorisation nine days out is not', () => {
    // A visa can be three weeks and an appointment. An ESTA is minutes.
    // Treating them the same either panics people or fails to warn them.
    assert.equal(urgency(KIND.VISA, 9), 'urgent');
    assert.equal(urgency(KIND.AUTHORISATION, 9), 'soon');
    assert.equal(urgency(KIND.AUTHORISATION, 2), 'urgent');
  });

  test('a long runway is calm', () => {
    assert.equal(urgency(KIND.VISA, 60), 'fine');
    assert.equal(urgency(KIND.AUTHORISATION, 30), 'fine');
  });

  test('an arrival card only matters near the end, and then it does', () => {
    assert.equal(urgency(KIND.ARRIVAL_CARD, 30), 'fine');
    assert.equal(urgency(KIND.ARRIVAL_CARD, 2), 'soon');
  });

  test('no date is "unknown", never a guess', () => {
    assert.equal(urgency(KIND.VISA, null), 'unknown');
    assert.equal(urgency(KIND.VISA, 'soon'), 'unknown');
  });
});

describe('what the concierge is told', () => {
  test('an uncovered country produces no block at all, rather than an empty one', () => {
    assert.equal(docsBlock('BR'), null);
    assert.equal(docsBlock('ZZ'), null);
  });

  test('the block names the document and hands over the official link', () => {
    const b = docsBlock('TH', { daysOut: 5, place: 'Thailand' });
    assert.match(b, /TDAC/);
    assert.match(b, /https:\/\/tdac\.immigration\.go\.th/);
    assert.match(b, /OFFICIAL LINK \(the only one you may ever give\)/);
  });

  test('it forbids inventing the rule for the traveller', () => {
    // The requirement depends on the passport, and the passport is not in
    // the model's context. Stating it anyway is how somebody gets turned
    // away at a desk holding a Num answer.
    const b = docsBlock('US');
    assert.match(b, /DO NOT STATE THE RULE FOR THEM/);
    assert.match(b, /depends on their passport/);
  });

  test('it forbids quoting a fee or a processing time', () => {
    const b = docsBlock('GB');
    assert.match(b, /NEVER quote a fee, a processing time or a validity period/);
    assert.match(b, /remembered as a promise/);
  });

  test('a free document says so, because that is the scam', () => {
    const b = docsBlock('TH');
    assert.match(b, /FREE on the official site/);
    assert.match(b, /Anyone charging for it is not the government/);
  });

  test('ETIAS is handled as the moving target it is', () => {
    // Saying "you need ETIAS" when it is not in force is a false alarm.
    // Saying "you do not" on the day it starts is a missed flight. The only
    // safe answer names the page that holds the date.
    const b = docsBlock('FR', { daysOut: 40 });
    assert.match(b, /NOT IN FORCE YET/);
    assert.match(b, /Do NOT say it is required and do NOT say it is not|Do NOT say it is required/);
  });

  test('it warns about the copycats in the model’s own instructions', () => {
    const b = docsBlock('GB');
    assert.match(b, /copycat sites/);
    assert.match(b, /Never a search result/);
  });

  test('it tells the model to mention it once, not to nag', () => {
    assert.match(docsBlock('TH'), /ONE mention, then drop it/);
  });

  test('urgency reaches the block when a date is known', () => {
    assert.match(docsBlock('VN', { daysOut: 9 }), /urgency with 9 days to go: urgent/);
    assert.doesNotMatch(docsBlock('VN'), /urgency with/);
  });
});

describe('the route', () => {
  const get = (qs) => handleTravelDocs(new Request(`https://app.itsnum.com/api/travel/docs${qs}`));

  test('a covered country comes back with official links', async () => {
    const body = await (await get('?to=TH')).json();
    assert.equal(body.covered, true);
    assert.equal(body.docs[0].name, 'TDAC');
    assert.ok(isOfficial(body.docs[0].official_url));
  });

  test('every URL the route can ever emit is official', async () => {
    for (const cc of COVERED) {
      const body = await (await get(`?to=${cc}`)).json();
      for (const d of body.docs ?? []) {
        assert.ok(isOfficial(d.official_url), `${cc} ${d.name} → ${d.official_url}`);
      }
    }
  });

  test('days turn into urgency', async () => {
    const body = await (await get('?to=VN&days=9')).json();
    assert.equal(body.docs[0].urgency, 'urgent');
  });

  test('an uncovered country admits it and still gives a real starting point', async () => {
    const res = await get('?to=BR');
    assert.equal(res.status, 200, 'not knowing is an answer, not an error');
    const body = await res.json();
    assert.equal(body.covered, false);
    assert.match(body.why, /has not verified/);
    assert.ok(isOfficial(body.start_here), 'even the fallback must be a government address');
    assert.match(body.start_here, /travel\.state\.gov/);
  });

  test('a bad code is a 400 that says what a good one looks like', async () => {
    const res = await get('?to=THAILAND');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /two-letter country code/);
    assert.ok(Array.isArray(body.covered));
  });

  test('the answer says out loud that it is not personal advice', async () => {
    const body = await (await get('?to=US')).json();
    assert.match(body.note, /depends on your passport/);
  });
});

describe('the turn is actually wired', () => {
  const read = (f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
  const IDX = read('index.mjs');
  const PROMPT = read('prompt.mjs');

  test('the block is built from the destination country and reaches the context', () => {
    assert.match(IDX, /docsBlock\(grounding\?\.place\?\.country_code \?\? null/);
    assert.match(IDX, /entryDocs,/);
    assert.match(PROMPT, /if \(entryDocs\) lines\.push\(entryDocs\)/);
    assert.match(PROMPT, /entryDocs = null \} = \{\}\) \{/);
  });

  test('the route is mounted', () => {
    assert.match(IDX, /url\.pathname === '\/api\/travel\/docs'/);
  });

  test('a missing trip date produces no date, never a zero', () => {
    // Number(null) is 0, and 0 days out is "you fly today". A guest with no
    // trip booked must not be shouted at about a visa.
    const at = IDX.indexOf('function daysToTrip');
    const fn = IDX.slice(at, IDX.indexOf('\n}', at));
    assert.match(fn, /if \(!raw\) return null/);
    assert.match(fn, /days < 0 \? null : days/, 'a trip in the past is over, not urgent');
  });

  test('the persona carries the rule, including the copycat warning', () => {
    assert.match(PROMPT, /PAPERWORK IS THE FAVOUR NOBODY ELSE DOES/);
    assert.match(PROMPT, /never an agency/);
    assert.match(PROMPT, /You do NOT decide whether they personally need it/);
  });
});
