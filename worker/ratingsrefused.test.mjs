/**
 * A REFUSED RATINGS SEARCH HAS TO REACH A HUMAN.
 *
 * 17 Sep 2026 22:33 was the last rating this product recorded. Every search
 * afterwards returned 429 — the SerpAPI plan was spent — and the only trace
 * was a console.warn, which nobody reads because reading it means already
 * suspecting the thing it would tell you.
 *
 * Meanwhile GET /api/features reported `ratings: on`, because `ready()` asks
 * whether SERPAPI_KEY is SET. A registry whose whole purpose is to be the one
 * place an operator can believe was asserting that a feature worked while
 * every call it made was being refused.
 *
 * The repair is not to make `ready()` clever — it is derived from env on
 * purpose, and a synchronous env check cannot know about a quota. It is to
 * put the refusal somewhere a person already looks.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FEATURES } from './features.mjs';

const SRC = readFileSync(new URL('./placeratings.mjs', import.meta.url), 'utf8');
const fail = SRC.slice(SRC.indexOf('let found;'), SRC.indexOf('// Our rows within'));

describe('a refusal is recorded; weather is not', () => {
  test('429, 401 and 403 are the ones a human must act on', () => {
    assert.match(fail, /\/\\b\(429\|401\|403\)\\b\//,
      'only a spent plan or a bad key needs a person — everything else is weather');
    assert.match(fail, /kind: 'ratings_refused'/);
  });

  test('a timeout or a 5xx does NOT open a ledger row', () => {
    // Recording weather is how a ledger becomes noise, and this ledger spent
    // the night of 17 Sep being taught not to cry wolf.
    const re = new RegExp(fail.match(/\/\\b\(429\|401\|403\)\\b\/[a-z]*/)[0].slice(1, -1));
    for (const msg of ['serpapi 500', 'The operation was aborted due to timeout', 'network error', 'serpapi 502']) {
      assert.ok(!re.test(msg), `${msg} should not be recorded as an actionable refusal`);
    }
    for (const msg of ['serpapi 429', 'serpapi 401', 'serpapi 403']) {
      assert.ok(re.test(msg), `${msg} should be recorded`);
    }
  });

  test('it is LOW severity, so a duller ranking never pages anyone', () => {
    // failures.summary() counts anything above low as `actionable`, and an
    // untold actionable failure makes /api/health say DOWN. Ratings going
    // quiet is a chore with a known remedy, not an outage.
    assert.match(fail, /severity: 'low'/,
      'above low, this would make /api/health report DOWN for a ranking that got duller');
  });

  test('the row carries the remedy, not just the symptom', () => {
    assert.match(fail, /SerpAPI plan is spent/, 'it says what 429 means');
    assert.match(fail, /SERPAPI_KEY is wrong or revoked/, 'and what 401\\/403 means');
    assert.match(fail, /num_rating_runs ORDER BY ts DESC/, 'and how to confirm the fix');
    assert.match(fail, /Nothing else breaks meanwhile/, 'and how urgent it is not');
  });

  test('the ledger can never be the reason a guest ask fails', () => {
    const guarded = fail.slice(fail.indexOf("import('./failures.mjs')"));
    assert.match(guarded, /catch \{/, 'the record call is wrapped');
  });
});

describe('the registry stops claiming this works when it does not', () => {
  const ratings = FEATURES.find((f) => f.id === 'ratings');

  test('its SOP names the trap in as many words', () => {
    assert.match(ratings.sop.broken, /READS "on" WHENEVER SERPAPI_KEY IS SET/,
      'the next person should not have to rediscover that `on` here means "configured", not "working"');
    assert.match(ratings.sop.broken, /ratings_refused/, 'and where the truth is instead');
  });

  test('the check is the DATE of the last run, not the counts', () => {
    // `matched` near zero is harmless — it means the directory is thin where
    // people are asking. An OLD newest row is the real symptom, and the old
    // check line pointed at the wrong column entirely.
    assert.match(ratings.sop.check, /datetime\(ts\/1000/, 'the check reads the timestamp');
    assert.match(ratings.sop.check, /whatever `state` says above/, 'and says to distrust state when it is stale');
  });
});
