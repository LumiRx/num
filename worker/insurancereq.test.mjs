import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REQUIRED, UNVERIFIED, NOT_REQUIRED_BUT_ASKED, insuranceFor, insuranceBlock, handleInsurance } from './insurancereq.mjs';
import { isOfficial } from './traveldocs.mjs';

describe('who the rule actually applies to', () => {
  test('Schengen touches visa applicants, not every visitor', () => {
    // The single most common way this gets told wrong. An American flying to
    // Paris does not need insurance to get in and must not be told they do.
    const r = insuranceFor('FR');
    assert.equal(r.required, true);
    assert.match(r.appliesTo, /Only travellers applying for a short-stay Schengen visa/);
    assert.match(r.appliesTo, /must not be told they are/);
  });

  test('all 29 Schengen states resolve to the same rule', () => {
    assert.equal(REQUIRED.SCHENGEN.countries.length, 29);
    for (const cc of REQUIRED.SCHENGEN.countries) {
      assert.equal(insuranceFor(cc).rule, 'SCHENGEN', cc);
    }
  });

  test('Ireland is not Schengen and does not pick up the rule', () => {
    assert.equal(insuranceFor('IE').required, false);
    assert.equal(insuranceFor('GB').required, false);
  });

  test('Thailand is a long-stay visa rule, not a tourist rule', () => {
    const r = insuranceFor('TH');
    assert.match(r.appliesTo, /NOT tourist entry/);
  });

  test('Qatar is a length-of-stay rule', () => {
    assert.match(insuranceFor('QA').appliesTo, /more than 30 days/);
  });

  test('Ecuador is the Galápagos, not the mainland', () => {
    assert.match(insuranceFor('EC').where, /Galápagos/);
    assert.match(insuranceFor('EC').appliesTo, /Mainland Ecuador does not require it/);
  });

  test('every block says who it applies to, not only that it exists', () => {
    for (const cc of ['FR', 'TH', 'QA', 'BY', 'EC', 'AW']) {
      const b = insuranceBlock(insuranceFor(cc));
      assert.match(b, /Who it applies to:/, cc);
    }
  });
});

describe('the two places a good policy is not enough', () => {
  test('Qatar needs a Qatari insurer, and the block insists on it', () => {
    const r = insuranceFor('QA');
    assert.match(r.mustBeLocal, /registered with Qatar’s Ministry of Public Health/);
    assert.match(insuranceBlock(r), /exactly the person who gets stopped/);
  });

  test('Thailand O-A needs the Thai scheme’s own template', () => {
    assert.match(insuranceFor('TH').mustBeLocal, /Thai scheme’s own template/);
  });

  test('nowhere else claims a local requirement it does not have', () => {
    const local = Object.values(REQUIRED).filter((r) => r.mustBeLocal);
    assert.equal(local.length, 2);
  });
});

describe('a source, or an admission', () => {
  test('every required rule carries a government link or a labelled scheme operator', () => {
    for (const [k, r] of Object.entries(REQUIRED)) {
      assert.ok(r.source || r.schemeOperator, `${k} has no source at all`);
      if (r.source) assert.ok(isOfficial(r.source), `${k}: ${r.source} is not on the government allowlist`);
    }
  });

  test('a scheme operator is never passed off as the government', () => {
    // longstay.tgia.org is an insurers' association; aruba.com is a tourism
    // authority. Neither is on the government allowlist and neither should be.
    for (const [k, r] of Object.entries(REQUIRED)) {
      if (!r.schemeOperator) continue;
      assert.equal(isOfficial(r.schemeOperator), false, `${k}: ${r.schemeOperator} is on the government list`);
    }
  });

  test('and when one is shown the block says which is which', () => {
    const b = insuranceBlock(insuranceFor('TH'));
    assert.match(b, /designated\s+operator, not a government site/);
    assert.match(b, /a copycat site catches/);
  });

  test('Russia is unverified because its only source would not load', () => {
    // The rule is probably real. Num will not cite a link it cannot open.
    const r = insuranceFor('RU');
    assert.equal(r.required, 'unverified');
    assert.match(r.why, /will not cite a link it cannot open/);
  });

  test('Cuba is unverified and says so rather than asserting or dismissing', () => {
    const r = insuranceFor('CU');
    assert.equal(r.required, 'unverified');
    const b = insuranceBlock(r);
    assert.match(b, /NOT CONFIRMED/);
    assert.match(b, /do not assert it and do not dismiss it/);
  });

  test('every unverified entry explains what was actually looked for', () => {
    for (const [cc, why] of Object.entries(UNVERIFIED)) {
      assert.ok(why.length > 40, `${cc}'s reason is too thin to be honest`);
    }
  });

  test('Saudi Arabia is recorded as included-in-the-visa, not as required', () => {
    const r = insuranceFor('SA');
    assert.equal(r.required, false);
    assert.match(r.what, /e-visa INCLUDES health cover/);
    assert.match(r.what, /visa waiver do not/);
  });

  test('Nepal is discretionary and is described as discretionary', () => {
    assert.match(NOT_REQUIRED_BUT_ASKED.NP.what, /discretionary/);
  });

  test('every url in the file is https', () => {
    const src = readFileSync(new URL('./insurancereq.mjs', import.meta.url), 'utf8');
    for (const l of src.match(/https?:\/\/[^\s'"`)]+/g) ?? []) assert.match(l, /^https:\/\//, l);
  });
});

describe('silence where there is nothing to say', () => {
  test('a country with no rule produces no block', () => {
    for (const cc of ['JP', 'US', 'AU', 'BR']) {
      assert.equal(insuranceBlock(insuranceFor(cc)), null, cc);
    }
  });

  test('a bad code is not known', () => {
    for (const bad of ['', null, 'FRA', '1']) {
      assert.equal(insuranceFor(bad).known, false);
    }
  });
});

describe('the route', () => {
  const call = (qs) => handleInsurance(new Request(`https://app.itsnum.com/api/travel/insurance${qs}`));

  test('a bad code is a 400', async () => {
    assert.equal((await call('')).status, 400);
  });

  test('a required country answers required with a minimum', async () => {
    const b = await (await call('?to=FR')).json();
    assert.equal(b.required, true);
    assert.match(b.minimum, /€30,000/);
  });

  test('an unverified country answers unverified, not false', async () => {
    const b = await (await call('?to=CU')).json();
    assert.equal(b.required, 'unverified');
  });
});
