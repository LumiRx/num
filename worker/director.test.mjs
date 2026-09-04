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
test('MODERATE with a hosted brain: Haiku first, hosted behind it, Claude last', () => {
  const env = { NUM_LLM_BASE_URL: 'https://api.example.com/v1' };
  const d = direct('where should I get breakfast', {}, env);
  assert.equal(d.tier, TIERS.MODERATE);
  assert.equal(d.steps.length, 4);
  assert.equal(d.steps[0].brain, 'haiku');
  assert.equal(d.steps[0].model, 'claude-haiku-4-5-20251001');
  assert.equal(d.steps[1].brain, 'hosted');
  assert.equal(d.steps[1].model, 'deepseek-v4-flash');
  assert.equal(d.steps[2].brain, 'hosted');
  assert.equal(d.steps[2].model, 'kimi-k2.6');
  assert.equal(d.steps[3].brain, 'claude');
  assert.equal(d.steps[3].model, 'claude-opus-5');
  assert.equal(d.estCostUsd, 0.0022, 'first step should cost as Haiku');
});

test('MODERATE without a hosted brain: Haiku then Claude', () => {
  const d = direct('where should I get breakfast', {}, {});
  assert.equal(d.steps.length, 2);
  assert.equal(d.steps[0].brain, 'haiku');
  assert.equal(d.steps[1].brain, 'claude');
  assert.equal(d.steps[1].model, 'claude-opus-5');
});

test('SIMPLE goes to Haiku too', () => {
  const env = { NUM_LLM_BASE_URL: 'https://api.example.com/v1' };
  const d = direct('what time do shops open', {}, env);
  assert.equal(d.tier, TIERS.SIMPLE);
  assert.equal(d.steps[0].brain, 'haiku');
  assert.equal(d.estCostUsd, 0.0022);
});

test('the bulk model is overridable without a deploy', () => {
  const d = direct('what time do shops open', {}, { NUM_MODEL_BULK: 'claude-sonnet-5' });
  assert.equal(d.steps[0].brain, 'haiku');
  assert.equal(d.steps[0].model, 'claude-sonnet-5');
});

test('CRITICAL and COMPLEX go straight to Claude, no escalation path needed', () => {
  for (const env of [{}, { NUM_LLM_BASE_URL: 'https://api.example.com/v1' }]) {
    const d = direct('book a table for tonight', {}, env);
    assert.equal(d.tier, TIERS.CRITICAL);
    assert.equal(d.steps.length, 1);
    assert.equal(d.steps[0].brain, 'claude');
    assert.equal(d.steps[0].model, 'claude-opus-5');
    assert.equal(d.estCostUsd, 0.0532);

    const c = direct('plan our day tomorrow', {}, env);
    assert.equal(c.tier, TIERS.COMPLEX);
    assert.equal(c.steps.length, 1);
    assert.equal(c.steps[0].brain, 'claude');
  }
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
  // Haiku leads now, so the hosted overrides sit one place further down.
  assert.equal(d.steps[1].model, 'custom-flash');
  assert.equal(d.steps[2].model, 'custom-mid');
});

// ── escalation ─────────────────────────────────────────────────────────────

test('afterFailure advances to the next step', () => {
  const d = direct('best beach in Phuket', {}, { NUM_LLM_BASE_URL: 'https://api.example.com/v1' });
  // After Haiku fails (index 0) the independent-bill brain is next.
  const d1 = afterFailure(d, 0);
  assert.ok(d1, 'should have a next step');
  assert.equal(d1.steps.length, 3);
  assert.equal(d1.steps[0].model, 'deepseek-v4-flash');

  const d2 = afterFailure(d1, 0);
  assert.ok(d2);
  assert.equal(d2.steps[0].model, 'kimi-k2.6');

  const d3 = afterFailure(d2, 0);
  assert.ok(d3);
  assert.equal(d3.steps.length, 1);
  assert.equal(d3.steps[0].brain, 'claude');
  assert.equal(d3.estCostUsd, 0.0532);

  // Claude is the end of the path
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
    assert.equal(direct(q, {}, env).steps[0].brain, 'haiku',
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
