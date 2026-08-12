// The Response Directing Manager.
//
// One brain decides which brain answers. Every ask lands here first, is
// weighed on two scales — how much the answer is worth (request demand) and
// how much it costs to produce (token cost) — and is directed to the cheapest
// model that can serve it well.
//
// The rule is not "spend less". It is spend on the turns that deserve it.
// "what time do shops open" and "book my trip to Japan and give me hotels,
// rideshare and dinner reservations" both get a good answer; only the model
// that researches them differs. The reply stays consistent across the board
// because the voice, persona, grounding and REPLY_SCHEMA are shared no matter
// which brain answers — see prompt.mjs and index.mjs.
//
//   every ask ──► classifyDemand ──► direct ──► { tier, steps, estCostUsd }
//                                             └─► cheapest capable model, then
//                                                 escalate on guard failure
//
// This is the policy from HANDOFF-response-brain §4/§4b:
//   DeepSeek Flash  → the bulk: recs, info, translations
//   Kimi K2.6       → harder prose, long context
//   Claude Opus     → money, bookings, groups, trouble, ambiguity
//
// The chain (brains.mjs) stays the decider of who actually answers; this module
// is the policy it consults. It FAILS TOWARD QUALITY: anything unrecognised,
// ambiguous, or carrying live-trip context escalates rather than economises,
// because guessing wrong in the cheap direction produces a bad answer to a
// question somebody cared about, while guessing wrong in the expensive
// direction costs a few cents.

/** How much research and capability an answer needs. */
export const TIERS = Object.freeze({
  SIMPLE: 'simple',     // single-fact lookup — a mid model is genuinely as good
  MODERATE: 'moderate', // recommendation / comparison / info — the bulk
  COMPLEX: 'complex',   // multi-step planning, long context, itinerary
  CRITICAL: 'critical', // money, bookings, trouble, groups, ambiguity — always the best
});

/**
 * Per-call token cost in US dollars, from num_usage's 14-day shape
 * (HANDOFF-response-brain §4b). These are the weights the director uses to
 * trade demand against price. `workers-ai` is unmetered on Cloudflare's edge.
 */
export const MODEL_COSTS = Object.freeze({
  'deepseek-v4-flash': 0.0007,
  'kimi-k2.6': 0.0056,
  'claude-sonnet-5': 0.02,
  'claude-opus-5': 0.0532,
  'workers-ai': 0,
});

// ── Demand signals ──────────────────────────────────────────────────────────
// Each regex is deliberately narrow. Anything that does NOT match a lower
// tier falls through to a higher one — the classifier fails toward quality.

/** Money, a commitment, trouble, or a group — never economise on these. */
const CRITICAL =
  /book|booking|reserve|reservation|pay|paid|price|cost|charge|refund|cancel|deposit|bill|invoice|wrong|broken|late|missing|complain|help me|stuck|lost|emergency|hospital|police|we are|we have|our group|party of|kids|children|family|wheelchair|allerg/i;

/** Multi-step planning / arranging / itinerary — a frontier model is better at holding it together. */
const COMPLEX =
  /plan|itinerary|schedule|arrange|organi[sz]e|coordinate|day trip|tonight then|after that|and then|give me .{8,}(?:and|,)|(?:hotel|flight|transfer|rides?hare|dinner).{0,30}(?:and|,)/i;

/** Recommendations, comparisons and research lookups — the bulk, served cheaply. */
const MODERATE =
  /recommend|best|where should i|which|compare|versus| vs |better|worth it|should i|instead|near|movies|showtimes|what'?s on|playing/i;

/** Short, single-fact lookups where a mid model is genuinely as good. */
const SIMPLE = /^(what|where|when|who|how far|how long|is|are|does|do)\b/i;

/**
 * Classify how much research an ask deserves.
 * @returns {{tier: string, signals: string[], reason: string}}
 */
export function classifyDemand(text, state = {}) {
  const s = typeof text === 'string' ? text : '';
  const signals = [];

  // A live trip means there is context to get wrong. Never economise on it.
  if (state?.bookings?.length || state?.party?.id || state?.tripCheck) {
    signals.push('live-trip');
    return { tier: TIERS.CRITICAL, signals, reason: 'live trip context to get wrong' };
  }
  if (!s.trim()) {
    signals.push('empty');
    return { tier: TIERS.CRITICAL, signals, reason: 'empty ask — ambiguity is not simplicity' };
  }
  if (s.length > 120) {
    signals.push('long');
    return { tier: TIERS.COMPLEX, signals, reason: 'long ask — likely multi-part' };
  }
  if (CRITICAL.test(s)) {
    signals.push('critical');
    return { tier: TIERS.CRITICAL, signals, reason: 'money / commitment / trouble / group' };
  }
  if (COMPLEX.test(s)) {
    signals.push('complex');
    return { tier: TIERS.COMPLEX, signals, reason: 'multi-step planning' };
  }
  if (MODERATE.test(s)) {
    signals.push('moderate');
    return { tier: TIERS.MODERATE, signals, reason: 'recommendation / research — the bulk' };
  }
  if (SIMPLE.test(s) && s.length <= 80) {
    signals.push('simple');
    return { tier: TIERS.SIMPLE, signals, reason: 'single-fact lookup' };
  }
  // Unrecognised → escalate. Cheap is opt-in, never the default.
  signals.push('unknown');
  return { tier: TIERS.COMPLEX, signals, reason: 'unrecognised — fail toward quality' };
}

/**
 * Which Claude model a tier maps to. Used by the Claude-only path
 * (pickModel). MODERATE stays on the strong model here because the Claude
 * path is the fallback when no hosted brain is configured — a recommendation
 * answered by Claude is worth the frontier model, not a corner cut.
 */
export function claudeModelFor(tier, env = {}) {
  const strong = env.NUM_MODEL_STRONG || 'claude-opus-5';
  const easy = env.NUM_MODEL_EASY || 'claude-sonnet-5';
  return tier === TIERS.SIMPLE ? easy : strong;
}

/**
 * Direct an ask to the cheapest capable model, with an escalation path.
 *
 * `steps` is an ordered list of `{ brain, model }` to try. `estCostUsd` is the
 * cost of the first step — the one we expect to answer. If a step's output
 * fails the guard, the caller advances to the next step (see afterFailure).
 *
 * @returns {{tier: string, steps: Array<{brain: string, model: string}>, estCostUsd: number|null, signals: string[], reason: string}}
 */
export function direct(text, state = {}, env = {}) {
  const { tier, signals, reason } = classifyDemand(text, state);

  // NUM_MODEL is the 2am kill switch — one secret pins the whole product to a
  // single model when a routing change is the suspect.
  if (env.NUM_MODEL) {
    return { tier, steps: [{ brain: 'claude', model: env.NUM_MODEL }], estCostUsd: MODEL_COSTS[env.NUM_MODEL] ?? null, signals, reason };
  }

  const strong = env.NUM_MODEL_STRONG || 'claude-opus-5';
  const hosted = !!env.NUM_LLM_BASE_URL;
  const flash = env.NUM_HOSTED_FLASH || 'deepseek-v4-flash';
  const mid = env.NUM_HOSTED_MID || 'kimi-k2.6';

  switch (tier) {
    case TIERS.SIMPLE:
    case TIERS.MODERATE:
      // The bulk. When a hosted brain is configured, it answers first — flash
      // for the cheap win, kimi if the guard bounces, Claude as the floor.
      // Without a hosted brain we stay on Claude, strong for MODERATE.
      if (hosted) {
        return {
          tier,
          steps: [
            { brain: 'hosted', model: flash },
            { brain: 'hosted', model: mid },
            { brain: 'claude', model: strong },
          ],
          estCostUsd: MODEL_COSTS[flash] ?? null,
          signals,
          reason,
        };
      }
      return {
        tier,
        steps: [
          { brain: 'claude', model: claudeModelFor(tier, env) },
          { brain: 'claude', model: strong },
        ],
        estCostUsd: MODEL_COSTS[claudeModelFor(tier, env)] ?? null,
        signals,
        reason,
      };
    default: // COMPLEX and CRITICAL — the frontier model, first and only.
      return {
        tier,
        steps: [{ brain: 'claude', model: strong }],
        estCostUsd: MODEL_COSTS[strong] ?? null,
        signals,
        reason,
      };
  }
}

/**
 * Advance a directive past a step that failed the guard.
 * @returns the remaining directive, or null when the path is exhausted.
 */
export function afterFailure(directive, failedIndex = 0) {
  const steps = directive?.steps ?? [];
  const next = steps[failedIndex + 1];
  if (!next) return null;
  return {
    ...directive,
    steps: steps.slice(failedIndex + 1),
    estCostUsd: MODEL_COSTS[next.model] ?? null,
  };
}
