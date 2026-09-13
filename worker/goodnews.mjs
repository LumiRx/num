/**
 * NUM · good news — the one turn a concierge must not answer like a concierge.
 *
 * ── WHY THIS IS A MODULE AND NOT A LINE IN THE PROMPT ────────────────────
 *
 * Shelly Gable's capitalization research is one of the better-replicated
 * findings in relationship science, and it has a counterintuitive core. There
 * are four ways to answer somebody's GOOD news:
 *
 *   active-constructive   enthusiasm + questions that make them relive it
 *   passive-constructive  "nice, glad that worked out"
 *   active-destructive    finding the downside
 *   passive-destructive   changing the subject
 *
 * Only the first one works. Active-constructive responding predicts
 * relationship satisfaction (r = .29–.47), intimacy (.40–.54) and trust
 * (.33–.70); causation was established across five experiments, and in a field
 * experiment 68.3% of people returned an overpayment after enthusiastic
 * feedback against 35.9% after disparaging feedback.
 *
 * The finding that makes this worth its own module: **passive-constructive
 * predicts POORER outcomes.** The mild, warm, entirely inoffensive "lovely,
 * glad it went well" is not a neutral. It is a cost. And it is exactly what a
 * well-behaved, length-capped, efficient concierge says by default — Num's
 * house voice optimises for brevity and getting out of the way, which is
 * right for every other turn and wrong for this one.
 *
 * So this cannot be a sentence buried in the house voice. It has to be a
 * detector that fires and visibly changes the brief.
 *
 * ── THE SALES PIVOT, WHICH IS THE REAL FAILURE MODE ──────────────────────
 *
 * Clark & Mills split relationships by the rule for giving: communal ones act
 * on need and never settle up, exchange ones keep score. Aggarwal showed the
 * penalty for exchange behaviour is far HARSHER inside a warm frame than a
 * transactional one — a firm that charged to fix a problem scored 3.33 with
 * communally-primed customers against 6.04 when it did not.
 *
 * "It was perfect!" → "So glad! Shall I book you in for next week?" is that
 * penalty in one sentence. It converts the single warmest moment the
 * relationship has into a transaction, and it is what almost every product
 * does. The block below forbids it outright.
 *
 * ── WHAT IT NEVER DOES ───────────────────────────────────────────────────
 *
 * Same line as the register layer: this changes the WORDS around a turn. It
 * never changes what is recommended, in what order, or what anything costs.
 * `goodnews.test.mjs` enforces that on the emitted text.
 */

/**
 * A positive evaluation. Deliberately narrow — these are words people use
 * about something that already happened, not adjectives they use when asking.
 */
const DELIGHT = /\b(amazing|incredible|perfect|wonderful|brilliant|fantastic|superb|magical|unreal|flawless|spot on|nailed it|loved it|love(?:d)? every|best (?:meal|night|day|trip|table|one)|couldn'?t have been better|exactly what we wanted|blew (?:us|me) away)\b/i;

/**
 * Life news, which is good news even with no evaluation word attached, and is
 * the kind a friend would react to rather than file.
 */
const LIFE = /\b(got the job|got engaged|we'?re engaged|she said yes|he said yes|got married|passed (?:my|the)|we won|i won|got promoted|promotion came|baby (?:is |was )?(?:here|born)|had the baby|got in(?:to)? (?:uni|college|the))\b/i;

/**
 * Past tense or completion. A report, not a request. Without one of these,
 * "somewhere amazing" is a brief, not good news — and answering a brief with
 * delighted questions is the most annoying possible failure.
 */
const HAPPENED = /\b(was|were|had|went|got back|just back|came back|last night|yesterday|this morning|earlier|ended up|turned out|it'?s done|we did|i did|thank you for|thanks for)\b/i;

/**
 * Shapes that mean somebody is ASKING, whatever else the message contains.
 * Checked first and they win outright: a request that happens to contain a
 * warm word is still a request, and this is the false positive that would
 * make the whole feature embarrassing.
 */
const ASKING = /\b(can you|could you|would you|can i|i need|we need|i want|we want|looking for|any chance|please (?:book|find|get|sort)|book|find me|sort out|do you have|is there|what'?s the|how much|what time|any (?:update|news))\b/i;

/**
 * Did this turn carry good news?
 *
 * Conservative on purpose. A missed one costs a warm moment; a false one
 * answers a booking request with "tell me everything!", which is worse — it
 * is the exact behaviour that makes people say an app is trying too hard.
 *
 * @param {string} text the guest's latest message
 * @returns {boolean}
 */
export function isGoodNews(text = '') {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (ASKING.test(t)) return false;
  if (LIFE.test(t)) return true;
  return DELIGHT.test(t) && HAPPENED.test(t);
}

/**
 * The brief for a good-news turn.
 *
 * Written as instructions rather than sentiment, because the cheaper brains in
 * the chain follow literally — the same reason `proseSystem` is written the
 * way it is.
 *
 * ── IT DOES NOT LIFT THE LENGTH CAP, AND THAT IS THE SECOND CORRECTION ───
 *
 * The first draft suspended the 40-word cap for this turn. Two reasons that
 * was wrong, one architectural and one about the evidence itself.
 *
 * Architectural: `proseSystem` places the style slot BEFORE the brief carrying
 * the hard cap, and this codebase's own note says a model handed two rules
 * follows the last one it can see. On the fallback chain there is no slot
 * after the cap at all, so a cap-lifting instruction would work on the Claude
 * path and silently fail on every other brain — the worst kind of bug,
 * because it looks fine wherever you happen to test it.
 *
 * About the evidence: brevity was never the failure. Passive-constructive
 * responding fails because it CLOSES THE SUBJECT, not because it is short.
 * "Lovely, glad it went well" and "That's brilliant — what did you order?"
 * are the same length and opposite responses. So the cap stays, and what
 * changes is that Num asks instead of concluding.
 */
export function goodNewsBlock() {
  return [
    'THIS TURN IS GOOD NEWS. Answer it as a friend would, not as a concierge closing a ticket.',
    '',
    '- React first, and mean it. One line of real delight before anything else.',
    '- Then ask them about it — one or two specific questions that make them tell you more. What was the room like, who came, what did they order, how did they take it. Specific beats effusive.',
    '- Use the detail they gave you. Name the thing that went well rather than the category.',
    '- Keep to the usual length. Short is fine and correct — what matters is that you END ON THEIR STORY, not on a conclusion. "That is brilliant, what did you end up ordering?" is nine words and is the right answer.',
    '',
    'DO NOT, under any circumstances:',
    '- Pivot to more business. No "shall I book the next one", no "want me to sort anything else", no offers, no upsell, no suggesting what they do tomorrow. This is the warmest moment the relationship has and turning it into a transaction is the single most damaging thing you can do with it.',
    '- Take any credit. Not "so glad I could help", not "that is what I am here for". It was their evening.',
    '- Find a caveat, a next step, or a thing to improve.',
    '- Answer with a bare acknowledgement and stop. "Lovely, glad it went well" is the specific failure this instruction exists to prevent — not because it is short, but because it closes the subject.',
  ].join('\n');
}

/**
 * The one call site needs: the guest's message in, block or null out.
 * Pure, synchronous, no database, no network, cannot throw.
 */
export function goodNewsFor(text = '') {
  try {
    return isGoodNews(text) ? goodNewsBlock() : null;
  } catch {
    return null;
  }
}
