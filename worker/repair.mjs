/**
 * NUM · repair — what Num does when it got something wrong.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * On 14 Sep a guest asked for deep-tissue massage in Los Angeles and was sent
 * to a barbershop. The retrieval bug is fixed. What was never built is the
 * thing that matters more: Num had no designed behaviour for being TOLD it was
 * wrong. It would have re-guessed silently, or explained itself, and both are
 * measurably the worst options available.
 *
 * ── REPAIR IS NOT AN ERROR PATH. IT IS INFRASTRUCTURE. ───────────────────
 *
 * Across twelve languages on five continents, conversational repair happens
 * about once every 1.4 minutes, and nobody experiences it as failure
 * (Dingemanse et al. 2015, 2,053 repair sequences). Repair is also engineered
 * to be CHEAP: the whole two-turn repair sequence averages only 1.2× the
 * length of the turn that caused the trouble. So the fix is short, and it is
 * normal, and treating it as an embarrassing exception is the mistake.
 *
 * ── THE SHAPE, TAKEN FROM THIRD-POSITION REPAIR ──────────────────────────
 *
 * Schegloff (1992) describes what a speaker does on discovering, from the
 * other's response, that they were misunderstood. Four components in order:
 *
 *   1. a marker            "Ah —" / "No —"
 *   2. ACCEPT what they just said
 *   3. reject the READING, never the person
 *   4. the repair proper — the corrected goods
 *
 * Component 2 is the face-work and it is not decoration. Correcting somebody
 * costs the corrector something too: other-correction is dispreferred in every
 * language studied, which is exactly why a guest who bothers to tell us we are
 * wrong must be made to feel it was free.
 *
 * ── WHAT THE EXPERIMENTS ADD, AND WHERE THEY DISAGREE WITH HUMANS ────────
 *
 * Ashktorab et al. (CHI 2019, N=203) ranked eight breakdown strategies. The
 * winner by a wide margin (p<0.001) was OPTIONS — offering concrete things the
 * system can do. The loser was answering with the best guess and saying
 * nothing about it. Note the finding that cuts against the human-human rule:
 * users preferred the SYSTEM to do the repair work rather than being asked to
 * rephrase, because the fault costs them nothing when the other party is a
 * machine. So: never hand the work back.
 *
 * Mahmood et al. (CHI 2022, N=37) tested apology styles on a voice assistant:
 * a serious apology that ACCEPTED blame beat everything on perceived
 * intelligence (η²ₚ=.156), likeability (.175) and recovery satisfaction.
 * Blame-shifting scored BELOW saying nothing at all on willingness to use
 * again (3.24 vs 3.81, p=.016). Casual, jokey apologies underperformed
 * throughout. And admitting fault RAISED perceived competence rather than
 * lowering it — which is the counterintuitive part worth trusting.
 *
 * Kim et al. (2004, 2006): apology repairs a COMPETENCE failure; denial only
 * ever helps for an integrity failure you are actually innocent of. A wrong
 * recommendation is competence. Apologise, take it internally, move on.
 *
 * Esterwood & Robert (2023): after three violations no strategy fully restored
 * trust. So the apology is a limited resource — spend it on real errors and
 * never as punctuation.
 *
 * ── WHAT IT NEVER DOES ───────────────────────────────────────────────────
 *
 * Same line as every other module in the voice layer: this changes the WORDS
 * around a turn. It never changes which place is recommended, in what order,
 * or what anything costs. `repair.test.mjs` enforces that on the emitted text.
 */

/**
 * The guest is telling us we got it wrong.
 *
 * Deliberately narrow. A false positive makes Num apologise for an answer that
 * was fine, which is worse than missing one — over-apologising is its own
 * failure mode, and the research says each spent apology makes the next one
 * work less well.
 */
const CORRECTING = [
  // Naming the mismatch outright — the barbershop case.
  // Contracted AND uncontracted, for the same reason as the closed/shut line
  // below: the first version of this only had "that's" and missed "that is a
  // barbershop" — the exact sentence this whole module was written for. A
  // demo caught it; the unit test had used the apostrophe form and passed.
  /\bthat(?:'?s| is) (?:a|an) \w+/i,
  /\bthat(?:'?s| is) not (?:a |an |what |the )?/i,
  /\b(?:these|those) are (?:all )?(?:not|the wrong)\b/i,
  // Restating the request against what we gave.
  /\bi (?:said|asked for|wanted|meant)\b/i,
  /\bnot what i (?:asked|said|meant|wanted)\b/i,
  // Flat verdicts.
  /\b(?:that'?s |this is )?(?:wrong|incorrect)\b/i,
  /\bwrong (?:one|place|thing|area|day|time)\b/i,
  /\bnope,? (?:that|not)\b/i,
  // The fact was stale or false.
  // Contracted AND uncontracted: "they're closed" and "they are closed" are
  // the same report, and only writing one of them is how half the cases miss.
  /\b(?:they(?:'?re| are)|it(?:'?s| is)|that(?:'?s| is)|place is) (?:closed|shut|gone|out of business|permanently closed)\b/i,
  /\bdoesn'?t exist\b/i,
  /\bnever (?:heard of|been)\b/i,
];

/**
 * "No, I meant X" — the guest is repairing OUR UNDERSTANDING rather than a
 * fact. Tracked separately because the reply differs: here Num misheard the
 * request, so the corrected goods must come from the corrected reading, and
 * there is nothing to apologise for beyond the mishearing.
 */
const REFRAMING = /\b(?:no,? i meant|i meant|not that,? i|i was asking (?:about|for)|other way round|the other one)\b/i;

/**
 * Shapes that look like corrections but are not. Checked FIRST and they win.
 *
 * "that's not cheap" is an opinion about a place, not a report that Num was
 * wrong. "I said I'd think about it" is a guest quoting themselves. Getting
 * this wrong makes Num apologetic and strange.
 *
 * "wrong side of town" was in this list and has been removed: in a concierge
 * conversation that phrase is almost always a guest telling us the AREA is
 * wrong, which is exactly a correction. It was blocking a true positive.
 */
const NOT_A_CORRECTION = [
  /\bthat'?s not (?:cheap|bad|great|for me|my (?:thing|scene)|really us)\b/i,
  /\bi said i'?d\b/i,
  /\bi meant to (?:say|ask|tell|book|call)\b/i,
];

/**
 * Did the guest just tell us we were wrong?
 *
 * @param {string} text the guest's latest message
 * @returns {null | {kind: 'fact'|'understanding'}}
 */
export function detectRepair(text = '') {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (NOT_A_CORRECTION.some((re) => re.test(t))) return null;
  if (REFRAMING.test(t)) return { kind: 'understanding' };
  if (CORRECTING.some((re) => re.test(t))) return { kind: 'fact' };
  return null;
}

/**
 * The brief for a turn where Num has been corrected.
 *
 * Written as instructions rather than sentiment, because the cheaper brains in
 * the chain follow literally.
 */
export function repairBlock(kind = 'fact') {
  const common = [
    '',
    'THE SHAPE, IN THIS ORDER:',
    '1. A short marker. "Ah —" or "No —". One or two words.',
    '2. Say back what THEY said, in their words. This is not politeness padding; it is the proof you heard it, and it is what makes correcting you free for them.',
    '3. Reject the reading, never the person. "I gave you a barbershop" — not "you asked unclearly".',
    '4. The corrected answer, IN THIS SAME MESSAGE. Not a promise to look again. The fix IS the apology.',
    '',
    'DO NOT:',
    '- Blame anything. Not the listing, not the data, not the search, not "the system". Shifting blame lands WORSE than saying nothing at all — it is the one move that makes this actively harmful.',
    '- Make a joke of it. Light apologies land worse than plain ones, every time.',
    '- Explain how it happened. They do not want the mechanism, they want the right answer. One sentence of ownership, then the goods.',
    '- Apologise more than once, or at length. They already spent something to correct you; a big apology makes them regret raising it.',
    '- Ask them to rephrase or try again. Doing the work is your job — handing it back is the worst-rated thing a system can do here.',
    '- Quietly produce a different answer as if nothing happened. That is the second worst.',
  ];

  if (kind === 'understanding') {
    return [
      'THE GUEST IS TELLING YOU THAT YOU MISUNDERSTOOD THEM. Take it at face value and do not defend the first reading.',
      ...common,
      '',
      'This one is a mishearing, not a bad answer — so own the mishearing plainly and briefly, and spend the rest of the message on the right answer.',
      'If you still cannot tell what they meant, do NOT ask an open question. Offer your best single reading for a yes or no: "You mean somewhere for bodywork, not a barber?" One word from them and you are unstuck. A bare "sorry, could you say that again" is the last resort in every language studied, and it makes them do the work.',
    ].join('\n');
  }

  return [
    'THE GUEST IS TELLING YOU THAT YOU GOT SOMETHING WRONG. They are right until proven otherwise — do not argue, do not justify the original answer.',
    ...common,
    '',
    'If the fault was a fact (closed, moved, gone), say plainly that the record was wrong rather than implying they misread it, and give what you are confident of now.',
  ].join('\n');
}

/**
 * The one call site needs: the guest's message in, block or null out.
 * Pure, synchronous, no database, no network, cannot throw.
 */
export function repairFor(text = '') {
  try {
    const hit = detectRepair(text);
    return hit ? repairBlock(hit.kind) : null;
  } catch {
    return null;
  }
}
