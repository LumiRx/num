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
 * Per-call cost in US dollars — REMEASURED 7 Sep 2026 from num_usage itself,
 * not from a rate card.
 *
 * ── WHY THE OLD NUMBERS WERE DANGEROUS ───────────────────────────────────
 *
 * They were derived from published per-million rates against an assumed
 * 700-in / 300-out turn. The real turn is 4,320 in / 397 out — because the
 * prompt carries persona, voice, house style, the destination guide, the
 * verified partner block and every offering attached to it. Six times the
 * input we assumed.
 *
 * So the table was wrong in the one direction that matters. It said Haiku
 * cost $0.0022; fourteen days of billing say $0.014–$0.048. It said Opus cost
 * $0.0532; the meter says $0.105. A router that trades demand against price
 * using prices that are 6–20× low will keep reaching for a model it thinks is
 * nearly free, and the bill it produces is not the bill it predicted.
 *
 * These are measured medians from num_usage over 14 days. Where a model has
 * not run enough to measure, the figure is the published rate at OUR token
 * shape and is marked as such. Re-measure when the prompt changes size — that
 * is what moves these, far more than any vendor's price list.
 */
export const MODEL_COSTS = Object.freeze({
  // Measured: 14 turns, $0.0010 median. The whole reason the backup lane is
  // affordable enough to leave switched on permanently.
  'deepseek-v4-flash': 0.0010,
  // Published rate at our shape (4.3k in / 400 out) — not enough live turns
  // to measure yet.
  'kimi-k2.6': 0.0056,
  'claude-sonnet-5': 0.02,
  // ── PUBLISHED RATES AT OUR SHAPE (4,320 in / 400 out), 7 Sep 2026 ──────
  //
  // Not yet measured on our own traffic — these are the vendor's own numbers
  // run through the token shape num_usage actually reports, which is the only
  // honest way to compare a rate card to a bill. Re-measure once each has run
  // enough real turns, and expect them to move UP rather than down: that is
  // the direction every estimate in this table has moved so far.
  'gpt-5-mini': 0.0019,   // $0.25 / $2.00 per M — strict schema, so it can carry the full reply
  'gpt-5-nano': 0.0004,   // $0.05 / $0.40 per M — strict schema, for the trivial lane
  'gemini-3-flash-lite': 0.0024,
  // xAI. OpenAI-compatible with structured outputs, so it needs no code at
  // all — it drops into either hosted slot. Priced here so that if it is ever
  // switched on, the router prices it correctly from the first turn instead of
  // treating it as unknown-and-therefore-expensive.
  'grok-4.1-fast': 0.0011,  // $0.20 / $0.50 per M
  'grok-4.3': 0.0064,
  'grok-4.6': 0.0110,
  // Measured: $0.014 on a 2.6k-in turn, $0.048 on a busier one. Taking the
  // higher figure on purpose — a router should be pessimistic about price and
  // optimistic about nothing.
  'claude-haiku-4-5': 0.048,
  // Measured: 13 turns across 4 days, $0.105 median. Twice the old estimate,
  // and about 100× the hosted lane.
  'claude-opus-5': 0.105,
  'workers-ai': 0,
});

// ── Demand signals ──────────────────────────────────────────────────────────
// Each regex is deliberately narrow. Anything that does NOT match a lower
// tier falls through to a higher one — the classifier fails toward quality.

/** Money, a commitment, trouble, or a group — never economise on these. */
/**
 * Trouble-shaped uses of "late", and not the other kind.
 *
 * `late` used to sit in the CRITICAL list on its own. Measured 7 Sep, that
 * sent "Best late dinner in Bangkok tonight, somewhere local" — a pure
 * recommendation, asked three times — to the frontier model at roughly a
 * hundred times the price of the lane that should have had it. A late dinner
 * is a meal. A late flight is a problem. Only the second one is critical.
 */
const LATE_TROUBLE = /\b(?:is|are|was|were|been|running|we'?re|i'?m|it'?s|they'?re)\s+late\b|\blate\s+(?:for|to)\b|\btoo late\b/i;

const CRITICAL =
  // `how much` / `how many baht` added 15 Aug. Widening the MODERATE pattern
  // to recognise category nouns ("spa", "dinner") pulled "how much is the spa
  // package" into the cheap lane — a PRICE question answered by a prose brain
  // that cannot see a verified figure. The money guard has to name the way
  // people actually ask what something costs, not only the word "cost".
  /book|booking|reserve|reservation|pay|paid|price|cost|charge|refund|cancel|deposit|bill|invoice|how much|order (?:me|us|a|an|the|some|dinner|lunch|breakfast|food|delivery)|place an order|deliver (?:to|it)|how many (?:baht|dollars?|usd|thb|euros?)|wrong|broken|missing|complain|help me|stuck|lost|emergency|hospital|police|we are|we have|our group|party of|kids|children|family|wheelchair|allerg/i;

/**
 * Multi-step planning / arranging / itinerary — a frontier model is better at
 * holding it together.
 *
 * ── THE COMMA BUG, FIXED 7 Sep 2026 ──────────────────────────────────────
 *
 * The last clause used to read `(?:hotel|flight|transfer|rideshare|dinner)
 * .{0,30}(?:and|,)` — a service noun followed, within thirty characters, by
 * the word "and" OR A COMMA. "Dinner tonight in Edinburgh, somewhere I
 * couldn't find on my own" matched on the comma after "Edinburgh" and went to
 * the frontier model. It was asked five times in a fortnight, and it is a
 * one-restaurant recommendation.
 *
 * A comma is punctuation, not a second task. What actually marks a multi-part
 * ask is a SECOND service noun after the conjunction — "a hotel and a
 * transfer", "dinner, then drinks". So that is what it looks for now.
 */
const SERVICE = 'hotel|flight|transfer|rides?hare|taxi|dinner|lunch|drinks|spa|massage|tour|car';
const COMPLEX = new RegExp([
  'plan|itinerary|schedule|arrange|organi[sz]e|coordinate|day trip',
  'tonight then|after that|and then',
  // "give me X and Y" — still two things, still multi-part.
  'give me .{8,}\\band\\b',
  // Two different services in one breath. The conjunction has to be followed
  // by another service, not by whatever came next in the sentence.
  `(?:${SERVICE})\\b[^.?!]{0,40}?(?:\\band\\b|,|then)\\s*(?:a |an |the |some )?(?:${SERVICE})\\b`,
].join('|'), 'i');

/**
 * Recommendations, comparisons and research lookups — the bulk, served cheaply.
 *
 * ── WIDENED 15 AUG, ON EVIDENCE ──────────────────────────────────────────
 *
 * The first version only recognised a question SHAPE — "where should I…",
 * "which…", "recommend…". Checked against the live table the day the router
 * shipped, "dinner ideas in patong tonight" classified as `unrecognised —
 * fail toward quality` and went to Opus at $0.076. So did the uptime probe,
 * which is 65% of all recorded traffic.
 *
 * That is the failure mode of a fail-safe default: it is invisible. Nothing
 * errors, every answer is good, and the bill quietly stays where it was.
 * A router only saves money on the phrasings it actually recognises, and
 * real guests do not phrase things like a test suite — they say "dinner
 * ideas", "somewhere to eat", "anywhere good for coffee", "food near me".
 *
 * These additions are all NOUN-led asks for a suggestion. The escalating
 * patterns above still win — they are tested first — so widening this cannot
 * pull money, bookings, groups or trouble down into the cheap lane. What it
 * changes is only the boundary between "cheap" and "expensive-by-default",
 * and on that boundary the honest bias is toward recognising the ask.
 */
const MODERATE = new RegExp([
  // question shapes
  'recommend|best|where should i|which|compare|versus| vs |better|worth it|should i|instead|near',
  // things to do
  'movies|showtimes|what\'?s on|playing|things to do|what to do|to see|attractions?',
  // asking for options by noun — the shape the first version missed entirely
  'ideas?|options?|suggestions?|somewhere|anywhere|any good|what\'?s good|top \\d',
  // meals and drinks, named directly
  'breakfast|brunch|lunch|dinner|eat|food|restaurants?|caf[eé]s?|coffee|bars?|drinks?',
  // the other categories guests ask for by name
  'beach(?:es)?|spa|massage|market|temple|viewpoint|nightlife|shopping',
].join('|'), 'i');

/**
 * Short, single-fact lookups where a mid model is genuinely as good.
 *
 * ── WIDENED 7 Sep 2026, ON EVIDENCE ──────────────────────────────────────
 *
 * The old pattern only fired on a leading question word, so "I land in
 * Bangkok at 11pm and I'm starving. What's actually open?" — a question about
 * OPENING HOURS — fell through every clause and landed on "unrecognised, fail
 * toward quality". It was asked three times and went to the frontier model
 * every time.
 *
 * A fail-safe default is invisible: nothing errors, the answer is good, and
 * the bill quietly stays where it was. So the lookup class now also
 * recognises what a lookup is ABOUT — hours, distance, address, contact —
 * wherever the question word sits in the sentence.
 *
 * Everything above still wins: money, commitment, trouble and multi-part asks
 * are tested first, so widening this cannot pull a booking into the cheap
 * lane.
 */
const LOOKUP_SUBJECT = /\b(?:open|opens|opening|clos(?:e|es|ed|ing)|hours|address|phone number|how far|how long|walk(?:ing)? (?:time|distance)|what time)\b/i;
const SIMPLE = /^(what|where|when|who|how far|how long|is|are|does|do)\b/i;

/**
 * Classify how much research an ask deserves.
 * @returns {{tier: string, signals: string[], reason: string}}
 */
/**
 * A reply, not a request: "yes", "ok", "that one", "I'm ready", "what else?".
 *
 * These carry no signal of their own, so the classifier used to read them as
 * unrecognised and escalate. Measured 7 Sep, "Hi" and "Yes" were being
 * answered by the frontier model at $0.105 each. The tier of a continuation
 * is the tier of the thing it continues — "yes" after "shall I book it?" is
 * still critical, and "yes" after "want three more?" is still a recommendation
 * — so it inherits rather than guesses.
 */
const CONTINUATION = /^\s*(?:yes|yeah|yep|yup|no|nope|ok|okay|sure|thanks|thank you|ta|cool|nice|hi|hey|hello|please|go|do it|sounds good|that one|the first|the second|the third|either|both|what else|anything else|more|and\b.{0,20}|i'?m ready|ready|eat there|go there|book (?:it|that)|check for .{0,20})\s*[.!?]*\s*$/i;

/** True when this message only makes sense as a reply to the previous turn. */
export function isContinuation(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  // Anything long enough to stand on its own is not a continuation, even if
  // it starts with "yes".
  if (s.length > 26) return false;
  return CONTINUATION.test(s);
}

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
  // A one-word reply inherits the tier of what it is replying to. Classifying
  // "yes" on its own merits is how a two-letter message reached the most
  // expensive model in the building.
  if (isContinuation(s)) {
    if (typeof state?.prevUser === 'string' && state.prevUser.trim()) {
      const parent = classifyDemand(state.prevUser, { ...state, prevUser: null });
      signals.push('continuation');
      return { tier: parent.tier, signals: [...signals, ...parent.signals], reason: `continuation of: ${parent.reason}` };
    }
    // Nothing to continue: this is a greeting, or a "yes" to nobody. Either
    // way it is the cheapest turn there is. "Hi" was going to the frontier
    // model at $0.105 because two letters matched no pattern and the default
    // is to escalate — a default that is right for a hard question and absurd
    // for a hello.
    signals.push('opener');
    return { tier: TIERS.SIMPLE, signals, reason: 'greeting or bare reply with nothing behind it' };
  }
  if (s.length > 120) {
    signals.push('long');
    return { tier: TIERS.COMPLEX, signals, reason: 'long ask — likely multi-part' };
  }
  if (CRITICAL.test(s) || LATE_TROUBLE.test(s)) {
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
  if ((SIMPLE.test(s) || LOOKUP_SUBJECT.test(s)) && s.length <= 90) {
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
 * Anthropic model ids carry a dated suffix ("claude-haiku-4-5-20251001") but
 * the cost table is keyed by family. Strip the date so a model rev does not
 * silently start reporting a null cost — the ledger going quiet is exactly
 * how the DeepSeek days came to cost $0.00 in our own console.
 */
export function normaliseModel(id) {
  return String(id ?? '').replace(/-\d{8}$/, '');
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
  const bulk = env.NUM_MODEL_BULK || 'claude-haiku-4-5-20251001';
  const hosted = !!env.NUM_LLM_BASE_URL;
  const flash = env.NUM_HOSTED_FLASH || 'deepseek-v4-flash';
  const mid = env.NUM_HOSTED_MID || 'kimi-k2.6';

  switch (tier) {
    case TIERS.SIMPLE:
    case TIERS.MODERATE: {
      // ── THE BULK LANE ──────────────────────────────────────────────────
      //
      // Haiku answers the everyday turn: recommendations, lookups, "what's
      // good near me". One fifth of Opus's price, a fraction of its latency,
      // and — the reason it beats every cheaper option — it is a STRUCTURED
      // brain. Every prose brain in the chain is forbidden from producing
      // cards or actions (see brains.mjs readHosted), so routing the bulk to
      // one meant the majority of turns silently lost the ability to offer a
      // booking. Haiku keeps the full schema, so the cheap lane and the
      // expensive lane produce the same SHAPE of answer and differ only in
      // how much thinking went into it.
      //
      // 7 Sep 2026: the hosted lane below now returns `picks`, so a turn that
      // lands there still arrives as tappable place cards with links, maps and
      // phone numbers. It still cannot book — that boundary is unchanged — but
      // the gap between "Haiku answered" and "the backup answered" is now one
      // capability instead of the whole card.
      //
      // Measured 30 Aug, this replaces a hosted lane that failed 66% of the
      // time (81 of 122 turns degraded) and a Workers AI lane that failed
      // 100% of the time (10 of 10). Both stay in the chain underneath as
      // free backstops; neither is asked to carry traffic any more.
      const steps = [{ brain: 'haiku', model: bulk }];
      // A configured hosted brain is still worth a try before the frontier
      // model — it is on an independent bill, which is the whole reason it
      // exists — but it now sits BEHIND Haiku rather than in front of it.
      if (hosted) steps.push({ brain: 'hosted', model: flash }, { brain: 'hosted', model: mid });
      steps.push({ brain: 'claude', model: strong });
      return { tier, steps, estCostUsd: MODEL_COSTS[normaliseModel(bulk)] ?? null, signals, reason };
    }
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
