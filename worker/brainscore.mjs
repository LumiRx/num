/**
 * WHICH BRAIN, DECIDED PER TURN — the scoring layer.
 *
 * ── The problem with a hard-coded order ───────────────────────────────────
 *
 * director.mjs used to name brains by hand: Haiku, then hosted-flash, then
 * hosted-mid, then Claude. That order was right when it was written and it
 * ages badly, because it encodes four things that all move independently:
 *
 *   · WHAT THE TURN NEEDS   — a booking needs a structured brain; "what time
 *                             does it open" needs almost nothing.
 *   · WHAT A BRAIN CAN DO   — the hosted lane gained `picks` on 7 Sep and the
 *                             hard-coded order knew nothing about it.
 *   · WHAT IT COSTS         — measured, and it moves whenever the prompt grows.
 *   · WHETHER IT IS ALIVE   — Anthropic has been out of credit since 5 Sep.
 *
 * Adding a vendor should be a line of config. Under a hard-coded order it is
 * a code change, a review and a deploy — which is why, on the night both
 * Anthropic brains died, nobody could put a third one in front of them.
 *
 * ── How it scores ─────────────────────────────────────────────────────────
 *
 * Every configured brain is scored on the same three questions, in this
 * order, because they are not equally important:
 *
 *   1. CAN IT DO WHAT THIS TURN NEEDS? A brain that cannot is not ranked
 *      below the others, it is REMOVED. A booking answered by a brain that
 *      cannot book is not a cheap answer, it is a wrong one.
 *   2. IS IT HEALTHY? A brain in cooldown is not a candidate, and one that
 *      has been failing is pushed down rather than out — a brain recovering
 *      from a wobble is still worth trying after the healthy ones.
 *   3. WHAT DOES IT COST? Only now, and only among brains that can actually
 *      serve the turn. This is the LAST question, never the first.
 *
 * The result is an ordered list of steps in exactly the shape direct()
 * already returns, so nothing downstream has to know this file exists.
 *
 * ── What it deliberately will not do ──────────────────────────────────────
 *
 * It never lets price beat capability. There is no weighting, no tunable
 * knob, no "sometimes the cheap one is close enough" — capability is a filter
 * and cost is a sort, and those are different kinds of thing. A knob that
 * could trade a booking for a saving would eventually be turned.
 */
import { BRAINS, byId, emitsPicks, canAct } from './brains.mjs';
import { MODEL_COSTS, TIERS, normaliseModel } from './director.mjs';

/**
 * What a turn of each tier actually requires of a brain.
 *
 * `structured` means the full REPLY_SCHEMA — cards, actions, bookings.
 * `picks` means it can name places the app will render as tappable cards.
 * A SIMPLE turn requires neither, which is why almost anything can serve it.
 */
export const NEEDS = Object.freeze({
  [TIERS.SIMPLE]: { structured: false, picks: false, actions: false },
  [TIERS.MODERATE]: { structured: false, picks: true, actions: false },
  // COMPLEX is planning — it needs the full schema shape (a card, an
  // itinerary) but nothing has to HAPPEN yet. CRITICAL is money and
  // commitment, and that is the tier where a brain must actually be allowed
  // to act. Splitting the two is what lets a new structured vendor carry real
  // work on its first day without being handed the booking rail as well.
  [TIERS.COMPLEX]: { structured: true, picks: true, actions: false },
  [TIERS.CRITICAL]: { structured: true, picks: true, actions: true },
});

/** The models a brain may be asked to run, cheapest first. */
function modelsFor(brain, env) {
  if (brain.kind === 'anthropic') {
    return brain.id === 'haiku'
      ? [env.NUM_MODEL_BULK || 'claude-haiku-4-5-20251001']
      : [env.NUM_MODEL_STRONG || 'claude-opus-5'];
  }
  if (brain.kind === 'workers-ai') return [brain.model];
  // An OpenAI-compatible brain can hold two rungs on one bill — a flash model
  // for the bulk and a stronger one behind it. Both are config, not code.
  const flash = env.NUM_HOSTED_FLASH || (brain.env?.model ?? []).map((n) => env[n]).find((v) => v) || 'default';
  const mid = env.NUM_HOSTED_MID || null;
  return mid && mid !== flash ? [flash, mid] : [flash];
}

/** What one call to this model costs us, as best we know. */
export function costOf(model, kind = null) {
  // Workers AI is neuron-billed on Cloudflare's edge, not token-billed, and
  // the cost table keys it by KIND rather than by model id. Looking it up by
  // model returned "unknown", which this function prices as expensive — so
  // the only genuinely free brains in the chain were sorting LAST, behind
  // every paid one, on exactly the trivial turns they exist to absorb.
  if (kind === 'workers-ai') return MODEL_COSTS['workers-ai'] ?? 0;
  const c = MODEL_COSTS[normaliseModel(model)];
  // An unknown model is priced as EXPENSIVE, not free. A null cost sorted as
  // zero is how an unpriced vendor quietly becomes the default choice.
  return Number.isFinite(c) ? c : Number.MAX_SAFE_INTEGER;
}

/**
 * How well a brain has been answering lately, 0 to 1, or undefined when we
 * have not measured it.
 *
 * Kept separate from `health` on purpose: health is "did the call succeed",
 * quality is "was the answer any good", and a brain can be perfectly healthy
 * and perfectly useless. Fed from num_asks.quality by the caller; unknown is
 * treated as fine, because a brain nobody has measured deserves its first
 * turn rather than permanent last place.
 */
export function qualityBand(q) {
  if (!Number.isFinite(q)) return 0;
  if (q >= 0.8) return 0;
  if (q >= 0.5) return 1;
  return 2;
}

/**
 * Rank every configured brain for this turn.
 *
 * @param env    the Worker env — decides what is configured
 * @param tier   from director.classifyDemand
 * @param health optional map of brain id → { cooling: bool, fails: number }
 * @returns {{steps: Array<{brain,model,cost,why}>, dropped: Array<{brain,why}>}}
 */
export function rank(env = {}, tier = TIERS.MODERATE, health = {}, quality = {}, allowFallback = true) {
  const need = NEEDS[tier] ?? NEEDS[TIERS.CRITICAL];
  const steps = [];
  const dropped = [];

  for (const brain of BRAINS) {
    if (!brain.ready(env)) { dropped.push({ brain: brain.id, why: 'not configured' }); continue; }

    // 1. CAPABILITY — a filter, never a penalty.
    if (need.structured && brain.structured !== true) {
      dropped.push({ brain: brain.id, why: 'cannot produce cards or actions, and this turn may need them' });
      continue;
    }
    if (need.picks && !emitsPicks(brain)) {
      dropped.push({ brain: brain.id, why: 'cannot name places the app can render' });
      continue;
    }
    if (need.actions && !canAct(brain, env)) {
      dropped.push({ brain: brain.id, why: 'not trusted to act — it can describe a booking but not request one' });
      continue;
    }

    // 2. HEALTH — cooling is out; a recent failure sinks but does not sink out
    //    of sight. `fails` is capped so a brain that failed forty times is not
    //    ranked below one that failed forty thousand: past a point they are
    //    the same brain, and the cap keeps the sort about price again once
    //    everything is equally unwell.
    const h = health?.[brain.id] ?? {};
    if (h.cooling) { dropped.push({ brain: brain.id, why: 'in cooldown after repeated failures' }); continue; }
    const penalty = Math.min(Number(h.fails) || 0, 3);

    for (const model of modelsFor(brain, env)) {
      steps.push({
        brain: brain.id,
        model,
        cost: costOf(model, brain.kind),
        penalty,
        quality: qualityBand(quality?.[brain.id]),
        why: `${brain.id}: ${need.structured ? 'can book' : need.picks ? 'can show places' : 'can answer'}`,
      });
    }
  }

  // 3. COST — last, and only among brains that survived the filter. Health
  //    outranks price so a wobbling cheap brain does not hold the front of the
  //    queue; between equals, the cheaper one goes first.
  //    Order of tie-breaks, and the order is the policy: how good the answers
  //    have been, then how reliably the call succeeds, then what it costs.
  //    Price is genuinely last.
  steps.sort((a, b) => a.quality - b.quality || a.penalty - b.penalty || a.cost - b.cost);

  // ── NEVER HAND BACK NOTHING ────────────────────────────────────────────
  //
  // If the capability filter emptied the list — a booking turn with every
  // structured brain out of credit, which is exactly where this product has
  // been since 5 Sep — we do NOT return an empty plan and let the turn die.
  // We fall back to whatever is alive, in the same order, and mark the plan
  // degraded so the caller can tell the guest the truth about what it can do.
  //
  // A guest who gets a good recommendation and an honest "I can't book that
  // for you right now" has been served. A guest who gets nothing has not.
  if (!steps.length) {
    // Step DOWN one capability at a time, never straight to the floor. When
    // the booking brains are out, the next best thing is a brain that can
    // still show place cards — not the cheapest thing in the building. Going
    // straight to SIMPLE sorted the free prose models ahead of the hosted
    // lane and answered a restaurant question with a paragraph while a
    // card-capable brain sat idle.
    // `allowFallback: false` on the way down — without it, a chain with
    // nothing alive at all bounces between MODERATE and SIMPLE for ever. One
    // step down, then the honest empty answer.
    for (const softer of allowFallback ? [TIERS.MODERATE, TIERS.SIMPLE] : []) {
      if (softer === tier) continue;
      const { steps: any } = rank(env, softer, health, quality, false);
      if (any.length) {
        return { steps: any, dropped, degraded: true, reason: `nothing configured can do what this turn needs — falling back to a brain that ${softer === TIERS.MODERATE ? 'can still show places but cannot book' : 'can only answer in prose'}` };
      }
    }
    return { steps: [], dropped, degraded: true, reason: 'no brain is configured and healthy' };
  }

  return { steps: steps.map(({ penalty, quality: q, ...s }) => s), dropped, degraded: false };
}

/**
 * The same answer in the shape director.direct() returns.
 *
 * `estCostUsd` is the cost of the step we EXPECT to answer — the first one —
 * because that is the number a budget is built from. An unknown model reports
 * null rather than a made-up figure.
 */
export function plan(env, tier, health = {}, quality = {}) {
  const { steps, dropped, degraded, reason } = rank(env, tier, health, quality);
  const first = steps[0];
  return {
    steps: steps.map(({ brain, model }) => ({ brain, model })),
    estCostUsd: first && first.cost !== Number.MAX_SAFE_INTEGER ? first.cost : null,
    considered: steps.map((s) => `${s.brain}/${s.model}@$${s.cost === Number.MAX_SAFE_INTEGER ? '?' : s.cost}`),
    dropped,
    ...(degraded ? { degraded: true, reason } : {}),
  };
}

/**
 * Read the live health of the chain out of brainstate rows.
 *
 * Shaped as its own function so `rank` stays pure and testable: the scoring
 * rules are a decision, the database is a detail.
 */
export function healthFrom(rows = [], now = Math.floor(Date.now() / 1000)) {
  const out = {};
  // Accepts either raw D1 rows or the Map that brainstate.load() returns, so
  // the caller never has to reshape live state to ask a question about it.
  const entries = rows instanceof Map
    ? [...rows.entries()].map(([brain, v]) => ({ brain, fails: v?.fails, cooldown_until: v?.cooldownUntil, class: v?.class }))
    : (rows ?? []);
  for (const r of entries) {
    if (!r?.brain) continue;
    out[r.brain] = {
      cooling: Number(r.cooldown_until ?? 0) > now,
      fails: Number(r.fails ?? 0),
      class: r.class ?? null,
    };
  }
  return out;
}

/** Every brain we could add without a code change, for the operator page. */
export const SLOTS = Object.freeze([
  { id: 'hosted', vars: ['NUM_LLM_BASE_URL', 'NUM_LLM_KEY', 'NUM_LLM_MODEL'], note: 'Any OpenAI-compatible vendor on its own bill.' },
  { id: 'jan', vars: ['OLLAMA_BASE_URL', 'OLLAMA_MODEL', 'OLLAMA_API_KEY'], note: 'Self-hosted. The one brain with no quota to run out of.' },
]);

export { byId };
