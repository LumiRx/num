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
import { WEIGHTS, SAYABLE, decay, scoreFor, sayIt, warnings, liveWeight, isPermanent, STALE_DAYS, SCORE_TERM, stars, POINTS_PER_STAR, CLOSED_PREDICATE } from './editorial.mjs';

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

  test('positives do not stack — the strongest claim is the claim', () => {
    // Five write-ups of one award must not bury a better venue with a single
    // quieter mention. Agreement is already priced into the weights
    // (consensus_3plus 24 vs consensus_2 15), decided by whoever read the
    // sources. And this has to be expressible in SQL, because SQL is what
    // actually ranks: two implementations of "how good is this" drift.
    const one = scoreFor([row({ weight: WEIGHTS.michelin_3 })], NOW);
    const many = scoreFor([
      row({ weight: WEIGHTS.michelin_3 }),
      row({ weight: WEIGHTS.list_top50, source: '50 Best' }),
      row({ weight: WEIGHTS.consensus_2, source: 'Time Out' }),
      row({ weight: WEIGHTS.critic_single, source: 'Infatuation' }),
    ], NOW);
    assert.equal(many, one, 'four write-ups of the same venue are worth its best claim, no more');
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

describe('a closure does not fade', () => {
  // The 19 Sep hotel research turned up two properties that shut in 2020 and
  // 2021. Under the uniform decay curve both aged past 48 months, scored
  // exactly zero, and were free to be recommended again — which is the single
  // worst thing this system could do to a guest standing on a pavement.
  const shut = row({ weight: WEIGHTS.closed, accolade: 'Permanently closed', source: 'CoStar', awarded_on: '2021-01-22' });

  test('a six-year-old closure still counts in full', () => {
    assert.equal(liveWeight(shut, NOW), WEIGHTS.closed);
    assert.equal(scoreFor([shut], NOW), WEIGHTS.closed);
  });

  test('and it still outweighs anything the place once won', () => {
    const starred = row({ weight: WEIGHTS.michelin_3, awarded_on: '2026-06-01' });
    assert.ok(scoreFor([starred, shut], NOW) < 0, 'a closed three-star must not rank');
  });

  test('the guest is still warned about it', () => {
    assert.deepEqual(warnings([shut], NOW), ['Permanently closed — CoStar, 2021']);
  });

  test('only closure is permanent — a stripped star is not', () => {
    assert.ok(isPermanent(shut));
    assert.ok(!isPermanent(row({ weight: WEIGHTS.star_revoked })));
    assert.ok(!isPermanent(row({ weight: WEIGHTS.michelin_3 })));
    assert.equal(scoreFor([row({ weight: WEIGHTS.star_revoked, awarded_on: '2019-01-01' })], NOW), 0);
  });

  test('the SQL that does the real ranking carries the same exemption', async () => {
    // Two sources of truth for one number is how the score a guest feels
    // drifts away from the score this module computes. Assert they agree.
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(new URL('../scripts/rank_top_places.sql', import.meta.url), 'utf8');
    assert.match(sql, /CASE WHEN e\.weight = -100 THEN e\.weight/, 'the loss sum must exempt closures from decay');
    assert.match(sql, /e\.weight = -100\s*\n?\s*OR julianday/, 'the loss filter must exempt closures from the 1461-day cutoff');
    assert.equal(WEIGHTS.closed, -100, 'the SQL hard-codes -100; WEIGHTS.closed must match it');
  });
});

// ── THE LAYER MUST BE PLUGGED INTO THE QUERY THAT ANSWERS ────────────────
//
// For a day this layer was wired only into rank_top_places.sql, which builds
// a pre-ranked shelf. The query that actually answers a guest standing in a
// city -- queryRing in ai/places.js -- scored on rating, reviews, claimed and
// distance, and had never heard of a Michelin star. So the shelf knew Le
// Bernardin from Dunkin' while the answer did not, which is precisely how a
// 2.5-star hotel came back for "somewhere downtown". Being right in a table
// nobody reads is the same as being wrong.
describe('the nearby ranker uses this layer', () => {
  const read = async (p) => (await import('node:fs')).readFileSync(new URL(p, import.meta.url), 'utf8');

  test('ai/places.js imports the term rather than copying it', async () => {
    const src = await read('../ai/places.js');
    assert.match(src, /import \{ SCORE_TERM as EDITORIAL_TERM[^}]*\} from '\.\.\/worker\/editorial\.mjs'/,
      'the editorial term must come from the module that owns the rule');
    assert.match(src, /\+ \$\{EDITORIAL_TERM\}/, 'SCORE must actually include the editorial term');
  });

  test('the term correlates to places.id — a wrong correlation scores everything alike', () => {
    assert.match(SCORE_TERM, /e\.place_id = places\.id/);
  });

  test('closures are exempt here too, on both the sum and the filter', () => {
    assert.ok(SCORE_TERM.includes(`e.weight = ${WEIGHTS.closed} THEN e.weight`), 'closure must skip decay');
    assert.match(SCORE_TERM, /OR julianday\('now'\) - julianday\(e\.awarded_on\) < 1461\.0\)\), 0\)/);
  });

  test('the scale is honest: a three-star outranks every other term in SCORE', () => {
    // The competing terms in ai/places.js SCORE, at their maximum.
    const bestReviewBonus = 1.4, claimed = 1.5, website = 0.25, phone = 0.2;
    const threeStars = stars([row({ weight: WEIGHTS.michelin_3, awarded_on: '2026-06-01' })], NOW);
    assert.ok(threeStars > bestReviewBonus + claimed + website + phone,
      `three stars is worth ${threeStars} stars and must beat a complete, claimed, heavily reviewed record`);
  });

  test('a single city critic is a nudge, not a claim', () => {
    const one = stars([row({ weight: WEIGHTS.critic_single, awarded_on: '2026-06-01' })], NOW);
    assert.ok(one > 0 && one < 1, `one critic is worth ${one} stars — it must move the order, not decide it`);
    assert.ok(WEIGHTS.critic_single < SAYABLE, 'and it must stay below the line where NUM says it out loud');
  });

  // Scoring a closure was the first attempt and it was not enough, which is
  // the whole reason CLOSED_PREDICATE exists. This test pins the arithmetic
  // that proved it, so nobody reverts to a penalty thinking it would do.
  test('a penalty alone would NOT have been enough — hence the exclusion', () => {
    const shut = stars([
      row({ weight: WEIGHTS.michelin_3, awarded_on: '2026-06-01' }),
      row({ weight: WEIGHTS.closed, source: 'CoStar', awarded_on: '2021-01-22' }),
    ], NOW);
    const bestOpenRecord = 5.0 + 1.4 + 1.5 + 0.25 + 0.2; // every other SCORE term, maxed
    const bareOpenPlace = 3.9;                            // the COALESCE default, nothing else
    const margin = bareOpenPlace - (bestOpenRecord + shut);
    // It does fall below. By 0.13 of a star, which a few hundred metres of
    // distance erases -- and the guest is standing outside a locked door.
    assert.ok(margin > 0 && margin < 0.5,
      `a penalty leaves only ${margin.toFixed(2)} of a star between a CLOSED three-star and an ordinary open place`);
  });

  test('so a sourced closure is excluded from the query outright', async () => {
    assert.match(CLOSED_PREDICATE, /NOT EXISTS/);
    assert.ok(CLOSED_PREDICATE.includes(`e.weight = ${WEIGHTS.closed}`));
    assert.match(CLOSED_PREDICATE, /e\.source IS NOT NULL AND e\.source <> ''/,
      'an unsourced closure claim must not remove a venue from the map');
    const src = await read('../ai/places.js');
    assert.match(src, /AND \$\{CLOSED_PREDICATE\}/, 'the predicate must be in the WHERE, not just imported');
    // It sits beside the rule it mirrors.
    assert.match(src, /alive IS NULL OR alive = 1\)\s*\n\s*AND \$\{CLOSED_PREDICATE\}/);
  });
});
