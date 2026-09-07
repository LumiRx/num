/**
 * The routing web: which brain, and why, for any turn.
 *
 * The tests that matter are the ones about ORDER OF QUESTIONS. Capability is
 * a filter and price is a sort, and the moment those two swap places a
 * booking gets answered by something that cannot book. Every assertion below
 * exists to stop that swap happening quietly in a future edit.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rank, plan, costOf, qualityBand, healthFrom, NEEDS, SLOTS } from './brainscore.mjs';
import { TIERS, MODEL_COSTS } from './director.mjs';

const FULL = { ANTHROPIC_API_KEY: 'k', NUM_LLM_BASE_URL: 'https://x/v1', NUM_LLM_MODEL: 'deepseek-v4-flash', AI: {} };
const now = Math.floor(Date.now() / 1000);
const cooling = (...ids) => Object.fromEntries(ids.map((id) => [id, { cooling: true, fails: 40 }]));
const ids = (p) => p.steps.map((s) => s.brain);

describe('capability is a filter, not a preference', () => {
  test('a booking turn only ever considers brains that can book', () => {
    for (const tier of [TIERS.COMPLEX, TIERS.CRITICAL]) {
      const p = plan(FULL, tier, {});
      assert.deepEqual(ids(p), ['haiku', 'claude'], tier);
      assert.ok(!ids(p).includes('hosted'), 'a prose brain was offered a booking turn');
    }
  });

  test('a recommendation turn considers anything that can show a place card', () => {
    const p = plan(FULL, TIERS.MODERATE, {});
    assert.ok(ids(p).includes('hosted'));
    assert.ok(!ids(p).includes('llama-3.3-70b'), 'a prose-only brain cannot render places');
  });

  test('a lookup considers everything, including the free ones', () => {
    const p = plan(FULL, TIERS.SIMPLE, {});
    assert.ok(ids(p).includes('gpt-oss-120b'));
  });

  test('the tier-to-capability table is explicit, not inferred', () => {
    assert.deepEqual(NEEDS[TIERS.CRITICAL], { structured: true, picks: true, actions: true });
    assert.deepEqual(NEEDS[TIERS.SIMPLE], { structured: false, picks: false, actions: false });
    // Planning needs the full schema shape; only money and commitment need a
    // brain that is actually allowed to make something happen. Splitting the
    // two is what lets a new structured vendor carry real work on day one
    // without being handed the booking rail with it.
    assert.equal(NEEDS[TIERS.COMPLEX].structured, true);
    assert.equal(NEEDS[TIERS.COMPLEX].actions, false);
  });

  test('a dropped brain says WHY it was dropped', () => {
    const { dropped } = rank(FULL, TIERS.CRITICAL, {});
    const hosted = dropped.find((d) => d.brain === 'hosted');
    assert.match(hosted.why, /cannot produce cards or actions/);
  });
});

describe('price is the LAST question', () => {
  test('on a lookup, the free brains go first', () => {
    const p = plan(FULL, TIERS.SIMPLE, {});
    assert.equal(p.estCostUsd, 0);
    assert.equal(ids(p)[0], 'gpt-oss-120b');
  });

  test('Workers AI is priced by KIND, not by model id', () => {
    // Looking it up by model id returned "unknown", which this file prices as
    // expensive — so the only genuinely free brains sorted LAST, behind every
    // paid one, on exactly the turns they exist to absorb.
    assert.equal(costOf('@cf/openai/gpt-oss-120b', 'workers-ai'), 0);
    assert.equal(costOf('@cf/openai/gpt-oss-120b'), Number.MAX_SAFE_INTEGER);
  });

  test('an unpriced model is treated as EXPENSIVE, never as free', () => {
    // A null cost sorted as zero is how an unmeasured vendor quietly becomes
    // the default choice for everything.
    assert.equal(costOf('some-brand-new-model'), Number.MAX_SAFE_INTEGER);
    assert.equal(costOf('claude-opus-5'), MODEL_COSTS['claude-opus-5']);
    // A dated Anthropic id still finds its family price.
    assert.equal(costOf('claude-haiku-4-5-20251001'), MODEL_COSTS['claude-haiku-4-5']);
  });

  test('among brains that can all serve the turn, the cheaper one leads', () => {
    const p = plan(FULL, TIERS.MODERATE, {});
    assert.equal(ids(p)[0], 'hosted', 'DeepSeek is ~48x cheaper than Haiku and can show places');
    assert.equal(ids(p).at(-1), 'claude');
  });
});

describe('health and quality outrank price', () => {
  test('a brain in cooldown is not a candidate at all', () => {
    const p = plan(FULL, TIERS.MODERATE, cooling('hosted'));
    assert.ok(!ids(p).includes('hosted'));
  });

  test('a brain that has been failing sinks, but is still there', () => {
    const p = plan(FULL, TIERS.MODERATE, { hosted: { fails: 3 } });
    assert.ok(ids(p).includes('hosted'), 'a wobble is not a death sentence');
    assert.notEqual(ids(p)[0], 'hosted');
  });

  test('a brain giving BAD ANSWERS sinks even while perfectly healthy', () => {
    // Health is "did the call succeed". Quality is "was the answer any good".
    // A brain can be flawlessly healthy and flawlessly useless.
    const p = plan(FULL, TIERS.MODERATE, {}, { hosted: 0.3 });
    assert.equal(ids(p)[0], 'haiku');
    assert.ok(ids(p).includes('hosted'));
  });

  test('an unmeasured brain gets its first turn rather than permanent last place', () => {
    assert.equal(qualityBand(undefined), 0);
    assert.equal(qualityBand(0.9), 0);
    assert.equal(qualityBand(0.6), 1);
    assert.equal(qualityBand(0.2), 2);
  });
});

describe('when the good brains are gone', () => {
  const down = cooling('claude', 'haiku');

  test('a booking turn falls back to a brain that can still show places', () => {
    // This is exactly where the product has been since 5 Sep.
    const p = plan(FULL, TIERS.CRITICAL, down);
    assert.equal(ids(p)[0], 'hosted', 'not the cheapest — the most capable one left');
    assert.equal(p.degraded, true);
    assert.match(p.reason, /can still show places but cannot book/);
  });

  test('it never hands back nothing while anything is alive', () => {
    const p = plan({ AI: {} }, TIERS.CRITICAL, {});
    assert.ok(p.steps.length > 0, 'a guest who gets nothing has not been served');
    assert.equal(p.degraded, true);
  });

  test('with truly nothing alive it says so instead of looping', () => {
    const p = plan({ ANTHROPIC_API_KEY: 'k' }, TIERS.CRITICAL, cooling('claude', 'haiku'));
    assert.deepEqual(p.steps, []);
    assert.match(p.reason, /no brain is configured and healthy/);
  });

  test('a healthy turn is never marked degraded', () => {
    assert.equal(plan(FULL, TIERS.CRITICAL, {}).degraded, undefined);
  });
});

describe('adding a vendor is config, not code', () => {
  test('an unconfigured brain is simply absent, with a reason', () => {
    const { dropped } = rank({ ANTHROPIC_API_KEY: 'k' }, TIERS.MODERATE, {});
    assert.ok(dropped.some((d) => d.brain === 'hosted' && d.why === 'not configured'));
  });

  test('setting the hosted variables is enough to put a vendor in the chain', () => {
    assert.ok(!ids(plan({ ANTHROPIC_API_KEY: 'k' }, TIERS.MODERATE, {})).includes('hosted'));
    assert.ok(ids(plan(FULL, TIERS.MODERATE, {})).includes('hosted'));
  });

  test('the open slots are published so nobody has to read the source to find them', () => {
    assert.deepEqual(SLOTS.map((s) => s.id), ['hosted', 'jan']);
    assert.ok(SLOTS.every((s) => s.vars.length && s.note));
  });

  test('live brain state converts straight into health, in either shape', () => {
    const rows = [{ brain: 'claude', fails: 44, cooldown_until: now + 600 }];
    assert.equal(healthFrom(rows).claude.cooling, true);
    const map = new Map([['claude', { fails: 44, cooldownUntil: now + 600 }]]);
    assert.equal(healthFrom(map).claude.cooling, true);
    assert.equal(healthFrom([{ brain: 'x', fails: 0, cooldown_until: 0 }]).x.cooling, false);
  });
});

describe('the file itself', () => {
  const SRC = readFileSync(new URL('./brainscore.mjs', import.meta.url), 'utf8');
  const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  test('there is no knob that could trade a booking for a saving', () => {
    // Capability is a filter and cost is a sort. A weighting between them
    // would eventually be tuned, and the direction it would be tuned in is
    // the one that answers a booking with a brain that cannot book.
    assert.doesNotMatch(code, /weight|WEIGHT|costWeight|tradeoff/);
    assert.match(code, /if \(need\.structured && brain\.structured !== true\)/);
  });

  test('cost is read from the measured table, never hard-coded here', () => {
    assert.doesNotMatch(code, /0\.0\d{2,}/);
    assert.match(code, /MODEL_COSTS\[/);
  });
});
