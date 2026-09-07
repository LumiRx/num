/**
 * The backup that can book — and the switch that decides whether it may.
 *
 * The capability is worth having and the boundary is worth more. A brain that
 * can DESCRIBE a booking and a brain that is allowed to REQUEST one are two
 * different claims, and the whole design here is about never letting the first
 * quietly become the second.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { byId, canAct, emitsPicks, roster, chain } from './brains.mjs';
import { plan, NEEDS } from './brainscore.mjs';
import { TIERS, MODEL_COSTS } from './director.mjs';

const SRC = readFileSync(new URL('./brains.mjs', import.meta.url), 'utf8');
const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const ENV = {
  ANTHROPIC_API_KEY: 'k', AI: {},
  NUM_LLM_BASE_URL: 'https://x/v1', NUM_LLM_MODEL: 'deepseek-v4-flash',
  NUM_OPENAI_BASE_URL: 'https://api.openai.com/v1', NUM_OPENAI_MODEL: 'gpt-5-mini',
};

describe('the brain itself', () => {
  test('it is structured, unlike every other non-Anthropic brain', () => {
    const b = byId('openai');
    assert.equal(b.structured, true);
    assert.equal(b.kind, 'openai-compatible');
    assert.equal(emitsPicks(b), true);
  });

  test('it only appears once its three variables are set', () => {
    assert.equal(byId('openai').ready({}), false);
    assert.equal(byId('openai').ready(ENV), true);
    assert.ok(chain(ENV).some((b) => b.id === 'openai'));
  });

  test('it is priced, so the router never treats it as unknown-and-expensive', () => {
    assert.ok(MODEL_COSTS['gpt-5-mini'] > 0);
    assert.ok(MODEL_COSTS['gpt-5-mini'] < MODEL_COSTS['claude-haiku-4-5']);
  });
});

describe('ACTIONS ARE OFF UNTIL SOMEBODY SAYS OTHERWISE', () => {
  test('Claude may act; a new vendor may not, on its first day or any other', () => {
    assert.equal(canAct(byId('claude'), ENV), true);
    assert.equal(canAct(byId('haiku'), ENV), true);
    assert.equal(canAct(byId('openai'), ENV), false);
  });

  test('one secret turns it on — no deploy, so it can be turned off just as fast', () => {
    assert.equal(canAct(byId('openai'), { ...ENV, NUM_OPENAI_ACTIONS: '1' }), true);
    // Anything other than the exact string is off. A truthy-ish value is not
    // a decision.
    assert.equal(canAct(byId('openai'), { ...ENV, NUM_OPENAI_ACTIONS: 'true' }), false);
    assert.equal(canAct(byId('openai'), { ...ENV, NUM_OPENAI_ACTIONS: 'yes' }), false);
  });

  test('a prose brain can never act, whatever anybody sets', () => {
    for (const id of ['hosted', 'jan', 'gpt-oss-120b', 'llama-3.3-70b']) {
      assert.equal(canAct(byId(id), { ...ENV, NUM_OPENAI_ACTIONS: '1' }), false, id);
    }
  });

  test('the return strips actions rather than trusting the flag downstream', () => {
    const at = code.indexOf("brain.structured && brain.kind === 'openai-compatible'");
    const lane = code.slice(at, code.indexOf('_degraded', at) + 200);
    assert.match(lane, /actions: mayAct \? \(out\.reply\?\.actions \?\? \[\]\) : \[\]/);
    assert.match(lane, /const mayAct = canAct\(brain, env\)/);
  });

  test('a turn it could not act on is reported degraded, not passed off as complete', () => {
    const at = code.indexOf("brain.structured && brain.kind === 'openai-compatible'");
    assert.match(code.slice(at, at + 2600), /_degraded: !mayAct && \(out\.reply\?\.actions\?\.length \?\? 0\) > 0/);
  });
});

describe('what it is allowed to answer', () => {
  test('planning yes, money no — until it is trusted to act', () => {
    assert.equal(NEEDS[TIERS.COMPLEX].actions, false);
    assert.equal(NEEDS[TIERS.CRITICAL].actions, true);
    assert.ok(plan(ENV, TIERS.COMPLEX, {}).steps.some((s) => s.brain === 'openai'));
    assert.ok(!plan(ENV, TIERS.CRITICAL, {}).steps.some((s) => s.brain === 'openai'));
  });

  test('a planning turn now costs 2% of what it did', () => {
    // COMPLEX was 32 of 138 asks in a fortnight and every one went to Opus.
    const p = plan(ENV, TIERS.COMPLEX, {});
    assert.equal(p.steps[0].brain, 'openai');
    assert.ok(p.estCostUsd < MODEL_COSTS['claude-opus-5'] / 20);
  });

  test('THE OUTAGE, CLOSED: a booking with Anthropic dry, once it is trusted', () => {
    const now = Math.floor(Date.now() / 1000);
    const down = { claude: { cooling: true }, haiku: { cooling: true } };
    void now;
    const before = plan(ENV, TIERS.CRITICAL, down);
    assert.equal(before.degraded, true, 'without the flag it still falls back and says so');
    const after = plan({ ...ENV, NUM_OPENAI_ACTIONS: '1' }, TIERS.CRITICAL, down);
    assert.equal(after.steps[0].brain, 'openai');
    assert.equal(after.degraded, undefined, 'full service from a third vendor');
  });

  test('the roster says which brains may act, because that is the question on a bad night', () => {
    const r = roster(ENV);
    assert.equal(r.find((b) => b.id === 'openai').can_act, false);
    assert.equal(roster({ ...ENV, NUM_OPENAI_ACTIONS: '1' }).find((b) => b.id === 'openai').can_act, true);
    assert.equal(r.find((b) => b.id === 'claude').can_act, true);
  });
});

describe('the strict call path is strict all the way down', () => {
  const at = code.indexOf('async function callStructuredJson');
  const fn = code.slice(at, code.indexOf('async function callProse'));

  test('a schema it cannot send strictly means SKIP the brain, not send it loosely', () => {
    assert.match(fn, /if \(!format\) throw new Error/);
  });

  test('a refusal and a truncation are both failures, not answers', () => {
    assert.match(fn, /message\?\.refusal/);
    assert.match(fn, /finish_reason === 'length'/);
  });

  test('unparseable JSON throws instead of being salvaged into a card', () => {
    // The prose path salvages, and that tolerance is exactly wrong here: a
    // booking card recovered from half-parsed text is worse than no card.
    assert.match(fn, /returned unparseable JSON despite strict mode/);
    assert.doesNotMatch(fn, /readHosted|salvage/);
  });

  test('it refuses to send guest data in cleartext, like every other lane', () => {
    assert.match(fn, /refusing to send guest data in cleartext/);
  });

  test('the HTTP status rides on the error so a 402 is filed as quota', () => {
    assert.match(fn, /err\.status = res\.status/);
  });

  test('it gets the FULL concierge prompt, not a thinner one', () => {
    const lane = code.slice(code.indexOf("brain.structured && brain.kind === 'openai-compatible'"));
    assert.match(lane.slice(0, 1200), /\[persona, voice, context, style\]/);
  });

  test('the output is guarded before a guest sees it, like every other lane', () => {
    const lane = code.slice(code.indexOf("brain.structured && brain.kind === 'openai-compatible'"));
    assert.match(lane.slice(0, 1600), /\(guard \?\? guardReply\)/);
  });
});
