// The cost-vs-demand brain. These tests express the new routing policy.
// Every test is about the direction the classifier fails in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIERS, MODEL_COSTS, classifyDemand, claudeModelFor, direct, afterFailure } from './director.mjs';

// ── tier classification ────────────────────────────────────────────────────

test('money, commitments and trouble classify as CRITICAL', () => {
  for (const q of [
    'book a table for tonight',
    'how much does the airport transfer cost',
    'cancel my reservation',
    'can I get a refund',
    'my driver is late',
    'the booking is wrong',
    'help me I am lost',
    'we are six people',
    'party of four',
    'kids with allergies',
  ]) {
    const { tier, signals } = classifyDemand(q);
    assert.equal(tier, TIERS.CRITICAL, `"${q}" was not critical (got ${tier}, signals: ${signals.join(',')})`);
  }
});

test('multi-step planning classifies as COMPLEX', () => {
  for (const q of [
    'plan our day tomorrow',
    'what is the itinerary for tonight then after that',
    'arrange a transfer',
    'coordinate hotel and dinner',
    'schedule my week',
  ]) {
    const { tier } = classifyDemand(q);
    assert.equal(tier, TIERS.COMPLEX, `"${q}" was not complex (got ${tier})`);
  }
});

test('recommendations and comparisons classify as MODERATE — the bulk', () => {
  for (const q of [
    'where should I get breakfast',
    'what movies are playing tonight',
    'best beach in Phuket',
    'recommend a restaurant near me',
    'kata or karon which is better',
    'should I rent a scooter or get taxis',
    'what is worth it in Phuket',
    'showtimes for dune',
  ]) {
    const { tier, signals } = classifyDemand(q);
    assert.equal(tier, TIERS.MODERATE, `"${q}" was not moderate (got ${tier}, signals: ${signals.join(',')})`);
  }
});

test('short single-fact lookups classify as SIMPLE', () => {
  for (const q of [
    'what time do shops open',
    'where is the old town',
    'how far is the airport',
    'when does the ferry leave',
  ]) {
    const { tier } = classifyDemand(q);
    assert.equal(tier, TIERS.SIMPLE, `"${q}" was not simple (got ${tier})`);
  }
});

test('a live trip makes any ask CRITICAL', () => {
  assert.equal(classifyDemand('what time is it', { bookings: [{ id: 'b1' }] }).tier, TIERS.CRITICAL);
  assert.equal(classifyDemand('what time is it', { party: { id: 'p1' } }).tier, TIERS.CRITICAL);
  assert.equal(classifyDemand('what time is it', { tripCheck: true }).tier, TIERS.CRITICAL);
});

test('silence, noise and long asks escalate', () => {
  assert.equal(classifyDemand('').tier, TIERS.CRITICAL, 'empty ask went simple');
  assert.equal(classifyDemand('asdkjhasd').tier, TIERS.COMPLEX, 'unrecognised did not escalate');
  assert.equal(classifyDemand('x'.repeat(200)).tier, TIERS.COMPLEX, 'long ask went cheap');
});

test('an ask LOOKING simple but touching money is CRITICAL', () => {
  for (const q of [
    'what does a car to the airport cost',
    'where can I book a table',
    'when should I cancel',
    'how long is the refund',
  ]) {
    assert.equal(classifyDemand(q).tier, TIERS.CRITICAL,
      `"${q}" matched SIMPLE before CRITICAL — it is about money`);
  }
});

// ── claudeModelFor ─────────────────────────────────────────────────────────

test('SIMPLE tier maps to the easy Claude model', () => {
  assert.equal(claudeModelFor(TIERS.SIMPLE, {}), 'claude-sonnet-5');
  assert.equal(claudeModelFor(TIERS.SIMPLE, { NUM_MODEL_EASY: 'custom-easy' }), 'custom-easy');
});

test('MODERATE and above map to the strong model (Claude path)', () => {
  for (const t of [TIERS.MODERATE, TIERS.COMPLEX, TIERS.CRITICAL]) {
    assert.equal(claudeModelFor(t, {}), 'claude-opus-5');
    assert.equal(claudeModelFor(t, { NUM_MODEL_STRONG: 'custom-strong' }), 'custom-strong');
  }
});

// ── direct ──────────────────────────────────────────────────────────────────

test('NUM_MODEL kill switch overrides everything', () => {
  const d = direct('what time do shops open', {}, { NUM_MODEL: 'claude-sonnet-5' });
  assert.equal(d.steps.length, 1);
  assert.equal(d.steps[0].brain, 'claude');
  assert.equal(d.steps[0].model, 'claude-sonnet-5');

  const d2 = direct('book a car', {}, { NUM_MODEL: 'claude-opus-5' });
  assert.equal(d2.steps[0].model, 'claude-opus-5');
});

// == THE BULK LANE IS HAIKU, FROM 30 AUG =====================================
//
// These four tests previously asserted that the bulk went to the `hosted`
// brain (DeepSeek flash, then Kimi). Measured against the live table that
// route failed 66 per cent of the time - 81 of 122 turns degraded - while the
// Workers AI brain behind it failed 10 of 10. The bulk now goes to Haiku,
// which is a STRUCTURED brain, so the cheap lane keeps the cards, actions and
// chips that every prose brain is correctly forbidden from producing.
//
// The escalation shape is unchanged and still tested: cheapest capable first,
// Claude Opus as the floor, and nothing can strand a turn.
test('MODERATE with only a hosted brain: DeepSeek leads, Anthropic behind it', () => {
  // CHANGED 7 Sep 2026. This used to pin Haiku at the front, from 30 Aug when
  // the hosted lane was failing 66% of the time and could not produce a card.
  // Both of those facts have since changed: the hosted lane is at zero
  // failures and now returns picks, and it costs 1/48th of Haiku. So the
  // cheap independent bill leads and Anthropic is the backstop.
  const env = { NUM_LLM_BASE_URL: 'https://api.example.com/v1' };
  const d = direct('where should I get breakfast', {}, env);
  assert.equal(d.tier, TIERS.MODERATE);
  assert.deepEqual(d.steps.map((x) => x.brain), ['hosted', 'hosted', 'haiku', 'claude']);
  assert.equal(d.steps[0].model, 'deepseek-v4-flash');
  assert.equal(d.steps[1].model, 'kimi-k2.6');
  assert.equal(d.steps[3].model, 'claude-opus-5');
  assert.equal(d.estCostUsd, MODEL_COSTS['deepseek-v4-flash'], 'the quote must be the brain that will answer');
});

test('MODERATE without a hosted brain: Haiku then Claude', () => {
  const d = direct('where should I get breakfast', {}, {});
  assert.equal(d.steps.length, 2);
  assert.equal(d.steps[0].brain, 'haiku');
  assert.equal(d.steps[1].brain, 'claude');
  assert.equal(d.steps[1].model, 'claude-opus-5');
});

test('SIMPLE takes the same lane as MODERATE — a lookup deserves no more', () => {
  const env = { NUM_LLM_BASE_URL: 'https://api.example.com/v1' };
  const d = direct('what time do shops open', {}, env);
  assert.equal(d.tier, TIERS.SIMPLE);
  assert.equal(d.steps[0].brain, 'hosted');
  assert.equal(d.estCostUsd, MODEL_COSTS['deepseek-v4-flash']);
});

test('the bulk model is overridable without a deploy', () => {
  const d = direct('what time do shops open', {}, { NUM_MODEL_BULK: 'claude-sonnet-5' });
  assert.equal(d.steps[0].brain, 'haiku');
  assert.equal(d.steps[0].model, 'claude-sonnet-5');
});

test('a BOOKING goes straight to Claude — no economising on the money lane', () => {
  // Unchanged and not negotiable: a turn where something happens in the world
  // goes to a brain that is allowed to make it happen. Only NUM_OPENAI_ACTIONS
  // adds a second one, and that is a deliberate decision somebody has to take.
  for (const env of [{}, { NUM_LLM_BASE_URL: 'https://api.example.com/v1' }]) {
    const d = direct('book a table for tonight', {}, env);
    assert.equal(d.tier, TIERS.CRITICAL);
    assert.deepEqual(d.steps.map((x) => x.brain), ['claude']);
    assert.equal(d.steps[0].model, 'claude-opus-5');
    assert.equal(d.estCostUsd, MODEL_COSTS['claude-opus-5']);
  }
});

test('PLANNING keeps Anthropic behind it, and gains a cheaper lead when one exists', () => {
  // COMPLEX used to be Claude alone. It still is when nothing cheaper can
  // carry the full schema — the change is that a strict-schema brain may now
  // lead it, because a plan needs the SHAPE of a full answer and nothing has
  // to happen yet.
  // Without a strict-schema brain this tier is EXACTLY what it was before —
  // Claude, first and only. Haiku is cheaper, not equivalent, and "plan
  // saturday with 6 friends" starting on it was the regression this catches.
  const bare = direct('plan our day tomorrow', {}, {});
  assert.equal(bare.tier, TIERS.COMPLEX);
  assert.deepEqual(bare.steps.map((x) => x.brain), ['claude']);

  const withGpt = direct('plan our day tomorrow', {}, GPT);
  assert.equal(withGpt.steps[0].brain, 'openai');
  assert.ok(withGpt.steps.map((x) => x.brain).includes('claude'));
});

test('book my trip to Japan — the user example — is CRITICAL', () => {
  const q = 'book my trip to Japan and give me hotels and rideshare and dinner reservations';
  const { tier } = classifyDemand(q);
  assert.equal(tier, TIERS.CRITICAL, 'the flagship example must route to the best');
  const d = direct(q);
  assert.equal(d.steps[0].brain, 'claude');
  assert.equal(d.steps[0].model, 'claude-opus-5');
});

test('env overrides for hosted model names', () => {
  const env = {
    NUM_LLM_BASE_URL: 'https://api.example.com/v1',
    NUM_HOSTED_FLASH: 'custom-flash',
    NUM_HOSTED_MID: 'custom-mid',
  };
  const d = direct('where should I get breakfast', {}, env);
  // The hosted lane leads again as of 7 Sep, so its overrides are back at the
  // front. Both rungs of the one bill, in order.
  assert.equal(d.steps[0].model, 'custom-flash');
  assert.equal(d.steps[1].model, 'custom-mid');
});

// ── escalation ─────────────────────────────────────────────────────────────

test('afterFailure advances to the next step', () => {
  const d = direct('best beach in Phuket', {}, { NUM_LLM_BASE_URL: 'https://api.example.com/v1' });
  // The path walks DOWN the chain a rung at a time, and every rung is a
  // different bill or a better model. What this test is really protecting is
  // that it always ends somewhere, and that the end is Claude.
  assert.equal(d.steps[0].model, 'deepseek-v4-flash');

  const d1 = afterFailure(d, 0);
  assert.ok(d1, 'should have a next step');
  assert.equal(d1.steps[0].model, 'kimi-k2.6');

  const d2 = afterFailure(d1, 0);
  assert.ok(d2);
  assert.equal(d2.steps[0].brain, 'haiku');

  const d3 = afterFailure(d2, 0);
  assert.ok(d3);
  assert.equal(d3.steps.length, 1);
  assert.equal(d3.steps[0].brain, 'claude');
  assert.equal(d3.estCostUsd, MODEL_COSTS['claude-opus-5']);

  // Claude is the end of the path — a turn can never be stranded.
  assert.equal(afterFailure(d3, 0), null, 'no step after Claude');
});

test('afterFailure on a single-step directive returns null', () => {
  const d = direct('book a table');
  assert.equal(afterFailure(d, 0), null, 'CRITICAL has no escalation');
});

// ── cost table is sensible ─────────────────────────────────────────────────

test('cost table ranks models correctly', () => {
  assert.ok(MODEL_COSTS['deepseek-v4-flash'] < MODEL_COSTS['kimi-k2.6'],
    'flash must be cheaper than kimi');
  assert.ok(MODEL_COSTS['kimi-k2.6'] < MODEL_COSTS['claude-opus-5'],
    'kimi must be cheaper than opus');
  // flash is ~76× cheaper than opus — two orders of magnitude
  assert.ok(MODEL_COSTS['deepseek-v4-flash'] * 70 < MODEL_COSTS['claude-opus-5'],
    'flash must be roughly two orders of magnitude cheaper than opus');
  assert.ok(MODEL_COSTS['workers-ai'] === 0, 'workers-ai is unmetered');
});

// ── the director is actually used ──────────────────────────────────────────

test('pickModel in router.mjs delegates to the director', () => {
  import('./router.mjs').then(({ pickModel }) => {
    // The director exports are the source of truth for pickModel
    assert.equal(typeof pickModel, 'function');
    // Verify a simple fact gets the easy model
    assert.equal(pickModel('what time do shops open', {}, {}), 'claude-sonnet-5');
    // And money stays strong
    assert.equal(pickModel('book a table', {}, {}), 'claude-opus-5');
    // Kill switch
    assert.equal(pickModel('what time', {}, { NUM_MODEL: 'custom' }), 'custom');
  });
});

test('classifyDemand is imported by router.mjs', async () => {
  // A classifier nobody imports is a file, not a saving.
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const HERE = dirname(fileURLToPath(import.meta.url));
  const router = readFileSync(join(HERE, 'router.mjs'), 'utf8');
  assert.match(router, /from ['"].\/director\.mjs['"]/,
    'router.mjs does not import the director — pickModel is not delegating');
});

// ── widened 15 Aug, on live evidence ─────────────────────────────────────
//
// The router shipped and the bill did not move. The classifier only knew
// question SHAPES ("where should I…"), so "dinner ideas in patong tonight" —
// which is 65% of all recorded traffic — read as `unrecognised` and escalated
// to Opus. A fail-safe default is invisible when it is wrong: nothing errors,
// every answer is good, and the money quietly stays where it was.

test('the phrasings real guests actually use reach the cheap lane', () => {
  const env = { NUM_LLM_BASE_URL: 'https://x/v1', NUM_LLM_MODEL: 'deepseek-v4-flash' };
  for (const q of [
    'my group needs dinner ideas in patong tonight', // the uptime probe
    'dinner ideas in patong tonight',
    'somewhere to eat near kata',
    'anywhere good for coffee',
    'best beach for sunset',
    'things to do tomorrow',
    'food near me',
    'massage recommendations',
  ]) {
    // The point of this test is that the phrasing is RECOGNISED as everyday
    // and does not land on the frontier model — not which cheap brain leads.
    const first = direct(q, {}, env).steps[0].brain;
    assert.notEqual(first, 'claude',
      `"${q}" escalated to Claude — the router saves nothing on phrasings it does not recognise`);
  }
});

test('widening the cheap lane did not leak a money question into it', () => {
  // Adding category nouns ("spa", "dinner") to MODERATE pulled "how much is
  // the spa package" down with them, on the first attempt. A price answered
  // by a prose brain that cannot see a verified figure is the exact failure
  // the money guard exists to prevent.
  const env = { NUM_LLM_BASE_URL: 'https://x/v1', NUM_LLM_MODEL: 'deepseek-v4-flash' };
  for (const q of [
    'how much is the spa package',
    'how much for a taxi to the airport',
    'how many baht is a massage',
    'what does a car to the airport cost',
    'book us a table at 8',
    'my flight got cancelled',
    'can you pay the deposit',
    'plan saturday with 6 friends',
  ]) {
    assert.equal(direct(q, {}, env).steps[0].brain, 'claude',
      `"${q}" was routed to the cheap brain — money, bookings, groups and trouble must always start on Claude`);
  }
});

test('placing an order spends money, so it never reaches the cheap lane', () => {
  // Found 30 Aug while measuring the new routing against real traffic:
  // "order dinner to my hotel tonight" was asked 6 times and classified
  // MODERATE every time, because the classifier read "dinner" and never
  // "order". A delivery request commits money exactly as a booking does.
  for (const q of ['order dinner to my hotel tonight', 'order me a coffee', 'place an order for lunch']) {
    assert.equal(direct(q, {}, {}).tier, TIERS.CRITICAL, `"${q}" was economised on`);
  }
  // ...without swallowing the idiom, which carries no commitment at all.
  assert.equal(direct('in order to get there faster what should i do', {}, {}).tier, TIERS.MODERATE,
    '"in order to" was read as placing an order');
});

// ── Added 7 Sep 2026, all four from measured production traffic ──────────
//
// Every case below was found in num_asks, not imagined. Each one was going to
// a model between fifteen and a hundred times more expensive than it needed,
// and none of them errored — which is why nobody noticed for a fortnight.

test('a late DINNER is a meal; a late FLIGHT is a problem', () => {
  // Asked three times in a fortnight and sent to the frontier model every
  // time, because `late` sat in the trouble list on its own.
  assert.equal(classifyDemand('Best late dinner in Bangkok tonight, somewhere local').tier, TIERS.MODERATE);
  assert.equal(classifyDemand('my flight is late').tier, TIERS.CRITICAL);
  assert.equal(classifyDemand('we are running late').tier, TIERS.CRITICAL);
  assert.equal(classifyDemand('too late to book?').tier, TIERS.CRITICAL);
});

test('a comma is punctuation, not a second task', () => {
  // "dinner" followed within 30 characters by a comma used to mean
  // "multi-step planning". Asked five times, frontier model five times.
  assert.equal(classifyDemand('Dinner tonight in Edinburgh, somewhere I could not find on my own').tier, TIERS.MODERATE);
  // Two actual services still escalate, which is the whole point of the rule.
  assert.equal(classifyDemand('dinner, then drinks').tier, TIERS.COMPLEX);
  assert.equal(classifyDemand('give me a hotel and a transfer').tier, TIERS.COMPLEX);
});

test('a question about opening hours is a lookup, wherever the question word sits', () => {
  assert.equal(classifyDemand("I land in Bangkok at 11pm and I'm starving. What's actually open?").tier, TIERS.SIMPLE);
  assert.equal(classifyDemand('what time does it open').tier, TIERS.SIMPLE);
  assert.equal(classifyDemand('how far is it').tier, TIERS.SIMPLE);
});

test('a one-word reply inherits the tier of what it replies to', () => {
  assert.equal(classifyDemand('Yes', { prevUser: 'Can you book me a hotel in Edinburgh' }).tier, TIERS.CRITICAL);
  assert.equal(classifyDemand('Yes', { prevUser: 'where should we eat tonight' }).tier, TIERS.MODERATE);
  assert.equal(classifyDemand('what else?', { prevUser: 'where should we eat tonight' }).tier, TIERS.MODERATE);
  assert.equal(classifyDemand('Eat there', { prevUser: "I'm in phuket. where should we eat tonight?" }).tier, TIERS.MODERATE);
  // And a greeting with nothing behind it is the cheapest turn there is.
  assert.equal(classifyDemand('Hi').tier, TIERS.SIMPLE);
  assert.equal(classifyDemand('Yes').tier, TIERS.SIMPLE);
});

test('a continuation never drags a real question down with it', () => {
  // Long enough to stand on its own is not a continuation, whatever it starts
  // with — otherwise "yes, and can you cancel my booking" answers cheaply.
  assert.equal(classifyDemand('yes, and can you cancel my booking and refund it', { prevUser: 'hi' }).tier, TIERS.CRITICAL);
});

test('the cost table is pessimistic about price, never optimistic', () => {
  // The old table was 6-20x low because it assumed a 700-token prompt against
  // a real one of 4,320. A router that under-prices a model keeps reaching for
  // it, and the bill it produces is not the bill it predicted.
  assert.ok(MODEL_COSTS['claude-opus-5'] > MODEL_COSTS['claude-haiku-4-5']);
  assert.ok(MODEL_COSTS['claude-haiku-4-5'] > MODEL_COSTS['deepseek-v4-flash']);
  assert.equal(MODEL_COSTS['workers-ai'], 0);
});

// ── THE ORDER DRE SET, 7 Sep 2026 ────────────────────────────────────────
//
// GPT-5 mini leads, DeepSeek behind it, Anthropic behind both. Written after
// four days of the Anthropic account being out of credit — but it is the right
// order on the numbers too, not only on the scar tissue.
const GPT = { NUM_OPENAI_BASE_URL: 'https://api.openai.com/v1', NUM_OPENAI_MODEL: 'gpt-5-mini', NUM_LLM_BASE_URL: 'https://x/v1' };
const ids = (d) => d.steps.map((s) => s.brain);

test('the everyday turn leads with GPT-5, then DeepSeek, then Anthropic', () => {
  const d = direct('where should we eat tonight', {}, GPT);
  assert.deepEqual(ids(d).slice(0, 2), ['openai', 'hosted']);
  assert.deepEqual(ids(d).slice(-2), ['haiku', 'claude']);
  // Three independent vendors in the chain: no single account going dark can
  // take the concierge down again. That is the whole point of the order.
  assert.equal(new Set(ids(d)).size, 4);
});

test('planning goes to GPT-5 — it was going to Opus at 55x the price', () => {
  const d = direct('plan my day in Bangkok', {}, GPT);
  assert.equal(d.tier, TIERS.COMPLEX);
  assert.equal(ids(d)[0], 'openai');
  assert.ok(d.estCostUsd < MODEL_COSTS['claude-opus-5'] / 20);
  // And Anthropic is still right behind it, not removed.
  assert.ok(ids(d).includes('claude'));
});

test('A BOOKING STAYS WITH ANTHROPIC UNTIL SOMEBODY SAYS OTHERWISE', () => {
  // GPT-5 mini can produce a booking card from its first minute. Whether it
  // may REQUEST the booking is a separate, deliberate decision. The cheapest
  // answer is never worth a booking that silently did not happen.
  const d = direct('book me a table tonight', {}, GPT);
  assert.equal(d.tier, TIERS.CRITICAL);
  assert.deepEqual(ids(d), ['claude']);
  // One secret, and only then does it lead the money lane.
  const on = direct('book me a table tonight', {}, { ...GPT, NUM_OPENAI_ACTIONS: '1' });
  assert.deepEqual(ids(on), ['openai', 'claude']);
});

test('with no OpenAI key the chain is exactly what it was yesterday', () => {
  // Adding a brain must never change the behaviour of a deployment that has
  // not configured it.
  const d = direct('where should we eat tonight', {}, { NUM_LLM_BASE_URL: 'https://x/v1' });
  assert.ok(!ids(d).includes('openai'));
  assert.equal(ids(d)[0], 'hosted');
  assert.ok(ids(d).includes('claude'));
});

test('the quoted cost is the brain that will actually answer', () => {
  // estCostUsd is what a budget is built from, so it must be the FIRST step
  // rather than whatever used to lead the lane.
  assert.equal(direct('where should we eat tonight', {}, GPT).estCostUsd, MODEL_COSTS['gpt-5-mini']);
  assert.equal(direct('book me a table tonight', {}, GPT).estCostUsd, MODEL_COSTS['claude-opus-5']);
});

test('every lane still ends at a brain that can do the whole job', () => {
  // The safety property: economising must never strand a turn. Whatever the
  // tier, Claude is the last thing standing.
  for (const q of ['what time does it open', 'where should we eat', 'plan my trip', 'book me a table']) {
    assert.ok(ids(direct(q, {}, GPT)).includes('claude'), q);
  }
});
