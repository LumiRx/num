// The layer that lets NUM tell adequate from excellent — and stops it
// recommending a restaurant that has been stripped of its stars.
//
// Every rule here was written against something the 19 Sep research actually
// found: Masa demoted three stars to two, LA's 715/Camphor/Morihiro stripped
// entirely, Angel's Share relocated, Baan Tepa dropped out of Asia's top 50.
// None of that is visible in any ratings API, and all of it would have been
// recommended confidently and wrongly.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WEIGHTS, SAYABLE, decay, scoreFor, sayIt, warnings, STALE_DAYS } from './editorial.mjs';

const NOW = new Date('2026-09-19T00:00:00Z');
const row = (o) => ({ source: 'Michelin', awarded_on: '2026-06-01', accolade: 'x', weight: 0, ...o });

describe('decay', () => {
  test('a current accolade counts in full', () => {
    assert.equal(decay('2026-06-01', NOW), 1);
  });

  test('an accolade announced ahead of time still counts', () => {
    // Guides publish the following year's edition. A star dated in the future
    // is real, not a data error.
    assert.equal(decay('2026-11-01', NOW), 1);
  });

  test('it fades rather than falling off a cliff', () => {
    const two = decay('2024-03-01', NOW);   // ~30 months
    const four = decay('2022-09-01', NOW);  // ~48 months
    assert.ok(two > 0 && two < 1, `expected partial credit, got ${two}`);
    assert.equal(four, 0);
    assert.ok(decay('2025-09-01', NOW) > two, 'newer must be worth more');
  });

  test('an undated accolade is worth nothing', () => {
    // The whole mechanism rests on the date. Scoring an undated one is how a
    // 2019 star stays live for ever.
    assert.equal(decay(null, NOW), 0);
    assert.equal(decay('not a date', NOW), 0);
  });
});

describe('scoring', () => {
  test('a three-star kitchen outranks a well-documented one', () => {
    // Before this existed "has a phone and a website" was worth 10 points and
    // three Michelin stars were worth nothing.
    assert.ok(WEIGHTS.michelin_3 > 20 + 12, 'an accolade must beat contact completeness plus claimed');
  });

  test('corroboration helps, but does not stack without limit', () => {
    const one = scoreFor([row({ weight: WEIGHTS.michelin_3 })], NOW);
    const many = scoreFor([
      row({ weight: WEIGHTS.michelin_3 }),
      row({ weight: WEIGHTS.list_top50, source: '50 Best' }),
      row({ weight: WEIGHTS.consensus_2, source: 'Time Out' }),
      row({ weight: WEIGHTS.critic_single, source: 'Infatuation' }),
    ], NOW);
    assert.ok(many > one, 'agreement between critics should count for something');
    assert.ok(many < one + 13, `four write-ups must not bury a quieter better venue (${many} vs ${one})`);
  });

  test('a revoked star drops a venue BELOW having no accolade at all', () => {
    // 715, Camphor and Morihiro lost their LA stars in the 2026 guide. A
    // guest reading last year's guidebook already thinks they are starred.
    const stripped = scoreFor([
      row({ weight: WEIGHTS.michelin_1, awarded_on: '2025-06-01' }),
      row({ weight: WEIGHTS.star_revoked, accolade: 'Michelin star removed', awarded_on: '2026-06-01' }),
    ], NOW);
    assert.ok(stripped < 0, `a stripped venue must be pushed down, got ${stripped}`);
  });

  test('losses stack in full', () => {
    const once = scoreFor([row({ weight: WEIGHTS.star_revoked })], NOW);
    const twice = scoreFor([
      row({ weight: WEIGHTS.star_revoked }),
      row({ weight: WEIGHTS.star_revoked, source: '50 Best', accolade: 'dropped' }),
    ], NOW);
    assert.ok(twice < once, 'being judged badly twice is twice the warning');
  });

  test('an unsourced row may not score', () => {
    // Attribution is what the concierge says out loud. A claim with no source
    // is a claim NUM cannot defend.
    assert.equal(scoreFor([row({ weight: WEIGHTS.michelin_3, source: null })], NOW), 0);
    assert.equal(scoreFor([row({ weight: WEIGHTS.michelin_3, source: '' })], NOW), 0);
  });

  test('nothing known scores nothing, and does not throw', () => {
    assert.equal(scoreFor([], NOW), 0);
    assert.equal(scoreFor(null, NOW), 0);
    assert.equal(scoreFor([null, undefined, {}], NOW), 0);
  });
});

describe('what the concierge says', () => {
  test('it names the accolade, the year and who gave it', () => {
    const line = sayIt([row({ weight: WEIGHTS.michelin_2, accolade: 'Two Michelin stars', awarded_on: '2026-06-01' })], NOW);
    assert.equal(line, 'Two Michelin stars, 2026 (Michelin)');
  });

  test('it picks the strongest live claim, not the newest row', () => {
    const line = sayIt([
      row({ weight: WEIGHTS.critic_single, accolade: 'Critics pick', source: 'Time Out', awarded_on: '2026-09-01' }),
      row({ weight: WEIGHTS.michelin_3, accolade: 'Three Michelin stars', awarded_on: '2026-06-01' }),
    ], NOW);
    assert.match(line, /Three Michelin stars/);
  });

  test('a thin claim is not worth saying', () => {
    assert.equal(sayIt([row({ weight: WEIGHTS.critic_single, accolade: 'Mentioned' })], NOW), null);
    assert.ok(WEIGHTS.critic_single < SAYABLE, 'a single passing mention must stay below the say-it bar');
  });

  test('a faded accolade stops being said', () => {
    const old = sayIt([row({ weight: WEIGHTS.michelin_3, accolade: 'Three Michelin stars', awarded_on: '2021-06-01' })], NOW);
    assert.equal(old, null, 'a five-year-old star is not a claim NUM should make today');
  });

  test('nothing to say returns null rather than filler', () => {
    assert.equal(sayIt([], NOW), null);
    assert.equal(sayIt(null, NOW), null);
  });
});

describe('warnings', () => {
  test('a live revocation is surfaced', () => {
    const w = warnings([row({ weight: WEIGHTS.star_revoked, accolade: 'Michelin star removed', awarded_on: '2026-06-01' })], NOW);
    assert.deepEqual(w, ['Michelin star removed — Michelin, 2026']);
  });

  test('an ancient revocation is not held against a venue for ever', () => {
    assert.deepEqual(warnings([row({ weight: WEIGHTS.star_revoked, awarded_on: '2019-01-01' })], NOW), []);
  });
});

describe('the freshness queue', () => {
  test('stale is measured in months, not days', () => {
    assert.ok(STALE_DAYS >= 30 && STALE_DAYS <= 180, `STALE_DAYS is ${STALE_DAYS}`);
  });
});
