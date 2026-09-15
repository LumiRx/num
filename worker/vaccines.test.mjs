import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SOURCES, YF_ALL, YF_FROM_RISK, YF_RISK_WHOLE, YF_RISK_PARTIAL, yfRisk,
  BESPOKE_SOURCE_LIST, TRANSIT_ALWAYS, TRANSIT_HOURS, DISPUTED, AGE_NOTES,
  OTHER, POLIO, COVID, vaccinesFor, vaccineBlock, handleVaccines,
  cdcPage, nathnacPage,
} from './vaccines.mjs';
import { isPublicHealth, isOfficial } from './traveldocs.mjs';

describe('risk and requirement are not the same thing', () => {
  test('a country can have the virus and require nothing', () => {
    // The mistake this whole distinction exists to stop.
    for (const cc of ['BR', 'PE', 'SD', 'TT', 'AR']) {
      assert.ok(yfRisk(cc), `${cc} should be a risk country`);
      assert.equal(Object.prototype.hasOwnProperty.call(YF_ALL, cc), false);
      assert.equal(Object.prototype.hasOwnProperty.call(YF_FROM_RISK, cc), false, cc);
    }
  });

  test('a country can have no risk at all and still demand a certificate', () => {
    for (const cc of ['AU', 'SG', 'CN', 'MT', 'SA', 'ZA', 'AL']) {
      assert.equal(yfRisk(cc), null, `${cc} should have no yellow fever risk`);
      assert.ok(Object.prototype.hasOwnProperty.call(YF_FROM_RISK, cc), cc);
    }
  });

  test('risk is reported as whole or partial, never as a bare boolean', () => {
    assert.equal(yfRisk('GH'), 'whole');
    assert.equal(yfRisk('BR'), 'partial');
    assert.equal(yfRisk('JP'), null);
  });

  test('no country is in both risk lists', () => {
    for (const cc of YF_RISK_WHOLE) {
      assert.equal(YF_RISK_PARTIAL.includes(cc), false, `${cc} is in both risk lists`);
    }
  });

  test('no country is in both requirement lists', () => {
    for (const cc of Object.keys(YF_ALL)) {
      assert.equal(Object.prototype.hasOwnProperty.call(YF_FROM_RISK, cc), false,
        `${cc} both requires it from everyone and only from risk arrivals`);
    }
  });

  test('the two lists together are every country WHO names', () => {
    // WHO's Annex 1 has 120 ROWS. This table has 119 KEYS, and the difference
    // is not a missing country: Bonaire, Sint Eustatius and Saba are three
    // rows in WHO's list and one ISO-3166 code (BQ). Counting rows against
    // codes is comparing two different units — which is exactly why the
    // six-month Sint Eustatius threshold lives in AGE_NOTES rather than
    // being averaged into BQ's number.
    assert.equal(Object.keys(YF_ALL).length, 19);
    assert.equal(Object.keys(YF_FROM_RISK).length, 100);
    assert.match(AGE_NOTES.BQ, /share one country code/);
  });

  test('every code in every list is a two-letter code', () => {
    const all = [
      ...Object.keys(YF_ALL), ...Object.keys(YF_FROM_RISK),
      ...YF_RISK_WHOLE, ...YF_RISK_PARTIAL, ...TRANSIT_ALWAYS,
      ...POLIO.exitFrom, ...POLIO.entryCondition,
    ];
    for (const cc of all) assert.match(cc, /^[A-Z]{2}$/, cc);
  });
});

describe('the ages, including the ones that are odd', () => {
  test('nine months and one year are both real thresholds', () => {
    assert.equal(YF_ALL.GH, 9);
    assert.equal(YF_ALL.UG, 12);
    assert.equal(YF_ALL.CM, 12);
  });

  test('Sierra Leone publishes no age and that is stored as null, not as zero', () => {
    // null means "no threshold published". 0 would read as a number and get
    // formatted as an age, which would be Num inventing a rule.
    assert.equal(YF_ALL.SL, null);
    assert.ok('SL' in YF_ALL);
  });

  test('Kazakhstan likewise', () => {
    assert.equal(YF_FROM_RISK.KZ, null);
  });

  test('Honduras is the only upper limit anywhere, and it is flagged disputed', () => {
    const r = vaccinesFor('HN');
    const yf = r.rules.find((x) => x.kind === 'yellow_fever');
    assert.equal(yf.maxAgeMonths, 720);
    assert.match(yf.disputed, /disagree/);
  });

  test('the six-month island is named rather than averaged away', () => {
    assert.match(AGE_NOTES.BQ, /Sint Eustatius is 6 months/);
    const r = vaccinesFor('BQ');
    assert.match(r.rules[0].note, /which island/);
  });

  test('an age is said in years when it divides, months when it does not', () => {
    const b = vaccineBlock(vaccinesFor('UG'));
    assert.match(b, /1 year and older/);
    const c = vaccineBlock(vaccinesFor('GH'));
    assert.match(c, /9 months and older/);
  });
});

describe('what Num will and will not say about a traveller', () => {
  test('an everyone-rule is stated flatly, because it is flat', () => {
    const b = vaccineBlock(vaccinesFor('GH'), { country_name: 'Ghana' });
    assert.match(b, /required from EVERY arrival/);
    assert.match(b, /not conditional on where they have been/);
  });

  test('a from-risk rule with no known route is NEVER resolved to "you are exempt"', () => {
    // The single most dangerous sentence this layer could produce.
    const r = vaccinesFor('TH');
    assert.equal(r.rules[0].triggered, 'unknown');
    const b = vaccineBlock(r);
    assert.match(b, /does NOT know whether this applies/);
    assert.match(b, /never as "you do not need it"/);
  });

  test('triggered is only ever yes or unknown — there is no no', () => {
    for (const from of [[], ['JP'], ['BR'], ['FR', 'DE']]) {
      const r = vaccinesFor('TH', { from });
      assert.ok(['yes', 'unknown'].includes(r.rules[0].triggered));
    }
  });

  test('a known risk country in their route is raised explicitly', () => {
    const r = vaccinesFor('TH', { from: ['BR', 'JP'] });
    assert.equal(r.rules[0].triggered, 'yes');
    assert.deepEqual(r.rules[0].riskCountriesSeen, ['BR']);
    assert.match(vaccineBlock(r), /THEY HAVE BEEN IN ONE: BR/);
  });

  test('a country with its own source list says so instead of using WHO’s', () => {
    for (const cc of Object.keys(BESPOKE_SOURCE_LIST)) {
      const r = vaccinesFor(cc);
      const yf = r.rules.find((x) => x.kind === 'yellow_fever');
      assert.ok(yf.ownList, `${cc} has a bespoke list that never reaches the caller`);
    }
    assert.match(vaccineBlock(vaccinesFor('CO')), /only to arrivals from Angola/);
  });

  test('transit rules that differ from the default are carried', () => {
    assert.equal(vaccinesFor('GY').rules[0].transitHours, 4);
    assert.equal(vaccinesFor('PY').rules[0].transitHours, 24);
    assert.equal(vaccinesFor('NG').rules[0].transitHours, 0);
    assert.equal(vaccinesFor('TH').rules[0].transitHours, null);
  });

  test('transit that always counts is said in words, not as "0 hours"', () => {
    const b = vaccineBlock(vaccinesFor('NG'));
    assert.match(b, /however brief it was/);
    assert.equal(/after 0 hours/.test(b), false);
  });

  test('a country with no rule produces no block', () => {
    assert.equal(vaccineBlock(vaccinesFor('JP')), null);
    assert.equal(vaccineBlock(vaccinesFor('IS')), null);
  });

  test('a code that is not a code is not known', () => {
    for (const bad of ['', null, 'THA', '1', 'x']) {
      assert.equal(vaccinesFor(bad).known, false);
    }
  });
});

describe('the thing clinics get wrong', () => {
  test('every block says the certificate is valid for life', () => {
    for (const cc of ['GH', 'TH', 'CO', 'SA']) {
      assert.match(vaccineBlock(vaccinesFor(cc)), /VALID FOR LIFE/, cc);
    }
  });

  test('and says so with the instrument that made it true', () => {
    assert.match(vaccineBlock(vaccinesFor('GH')), /Annex 7 since 11 July 2016/);
  });

  test('and tells the model to correct somebody who thinks theirs expired', () => {
    assert.match(vaccineBlock(vaccinesFor('GH')), /worth correcting kindly/);
  });
});

describe('how old the table is, said out loud', () => {
  test('every block carries the WHO publication date', () => {
    assert.match(vaccineBlock(vaccinesFor('GH')), /2022-11-19/);
  });

  test('and the response rate that makes it doubtful', () => {
    const b = vaccineBlock(vaccinesFor('GH'));
    assert.match(b, /36%/);
    assert.match(b, /none of the African ones did/);
  });

  test('it is never presented as medical advice', () => {
    assert.match(vaccineBlock(vaccinesFor('GH')), /never present this as medical advice/i);
  });

  test('the sources all carry a date', () => {
    for (const [k, v] of Object.entries(SOURCES)) {
      assert.match(v.published, /^\d{4}-\d{2}-\d{2}$/, k);
      assert.match(v.url, /^https:\/\//, k);
    }
  });
});

describe('where the links point', () => {
  test('every source is a recognised health authority or a government', () => {
    for (const [k, v] of Object.entries(SOURCES)) {
      assert.ok(isPublicHealth(v.url) || isOfficial(v.url), `${k}: ${v.url}`);
    }
  });

  test('the TravelHealthPro link uses the slug form, not the numeric one', () => {
    // /country/220/thailand returns HTTP 200 and serves TANZANIA. The legacy
    // pattern does not error, it lies.
    const u = nathnacPage('thailand');
    assert.equal(u, 'https://travelhealthpro.org.uk/countries/thailand');
    assert.equal(/\/country\/\d+\//.test(u), false);
  });

  test('fitfortravel is nowhere in this file', () => {
    // Retired; TLS certificate expired 7 June 2026; will not connect.
    const src = readFileSync(new URL('./vaccines.mjs', import.meta.url), 'utf8');
    const links = src.match(/https?:\/\/[^\s'"`)]+/g) ?? [];
    for (const l of links) assert.equal(/fitfortravel/.test(l), false, l);
  });

  test('the CDC page pattern is the current one', () => {
    assert.equal(cdcPage('ghana'), 'https://wwwnc.cdc.gov/travel/destinations/traveler/none/ghana');
  });

  test('every url in the file is https', () => {
    const src = readFileSync(new URL('./vaccines.mjs', import.meta.url), 'utf8');
    for (const l of src.match(/https?:\/\/[^\s'"`)]+/g) ?? []) {
      assert.match(l, /^https:\/\//, l);
    }
  });
});

describe('the rules that are not yellow fever', () => {
  test('Saudi Arabia carries the Hajj meningococcal requirement', () => {
    const r = vaccinesFor('SA');
    const o = r.rules.find((x) => x.kind === 'other');
    assert.match(o.what, /Meningococcal ACWY/);
    assert.match(o.detail, /at least 10 days/);
    assert.match(o.detail, /VISA condition/);
  });

  test('and admits the Saudi ministry link could not be verified', () => {
    assert.match(OTHER.SA[0].note, /404/);
  });

  test('polio is described as an exit rule, not an entry rule', () => {
    const src = readFileSync(new URL('./vaccines.mjs', import.meta.url), 'utf8');
    assert.match(src, /EXIT requirements placed[\s\S]{0,20}on infected states/);
  });

  test('a country with polio as an entry condition gets the caveat about stale lists', () => {
    const b = vaccineBlock(vaccinesFor('EG'));
    assert.match(b, /source lists are out of date/);
  });

  test('covid is recorded as no verified requirement anywhere', () => {
    assert.match(COVID.verdict, /no verified/);
    assert.ok(isPublicHealth(COVID.standing));
  });

  test('the polio statement link is a health authority', () => {
    assert.ok(isPublicHealth(POLIO.statement));
  });
});

describe('the route', () => {
  const call = (qs) => handleVaccines(new Request(`https://app.itsnum.com/api/travel/vaccines${qs}`));

  test('a bad code is a 400', async () => {
    assert.equal((await call('')).status, 400);
    assert.equal((await call('?to=GHA')).status, 400);
  });

  test('a country with no rule says so without claiming there is none', async () => {
    const b = await (await call('?to=JP')).json();
    assert.equal(b.rules.length, 0);
    assert.match(b.note, /not the same as there being none/);
  });

  test('a from list is honoured', async () => {
    const b = await (await call('?to=TH&from=BR,JP')).json();
    assert.equal(b.rules[0].triggered, 'yes');
  });

  test('the answer says certificates last a lifetime', async () => {
    const b = await (await call('?to=GH')).json();
    assert.equal(b.lifetimeCertificate, true);
  });

  test('sources travel with the answer', async () => {
    const b = await (await call('?to=GH')).json();
    assert.ok(b.sources.who_annex1.url);
    assert.ok(b.sources.cdc.published);
  });
});
