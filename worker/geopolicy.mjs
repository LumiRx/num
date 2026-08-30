// Where the concierge is standing changes what it may say.
//
// ── WHY A FILTER AND NOT JUST A PROMPT ───────────────────────────────────
//
// The system prompt is where you tell a model what to do. It is not where you
// find out whether it did. Num answers thousands of turns from a model that
// has been asked, in the same breath, to be warm, opinionated and decisive —
// and the failure mode of a warm, opinionated concierge in Riyadh is naming a
// bar. Under Saudi's Anti-Cyber Crime Law and UAE Federal Decree-Law 34/2021
// that is not a bad recommendation, it is up to five years and SAR 3m, and
// the liability lands on the platform.
//
// So this runs AFTER generation, on the text about to be sent. A prompt is a
// request; this is a gate.
//
// ── THE DISTINCTION THAT MATTERS MOST ────────────────────────────────────
//
// Answering is not recommending, and a filter that cannot tell them apart is
// worse than none. "Can I drink in Dubai?" deserves a true answer — yes, in
// licensed venues. "Is alcohol legal in Saudi Arabia?" deserves a true answer
// — no, and pretending otherwise gets somebody arrested. What is forbidden is
// SENDING SOMEBODY SOMEWHERE: naming a bar in Riyadh, surfacing a gay club in
// either country, pointing at a casino.
//
// A traveller who asks an honest question and gets a wall is not being
// protected. They are being failed, and they will go and ask something less
// careful instead.
//
// ── AND THE SECOND DISTINCTION: THE TWO COUNTRIES ARE NOT ONE ────────────
//
// The Gulf is not one market. In the UAE alcohol is legal in licensed venues
// and naming one is ordinary journalism; Time Out Dubai does it weekly. In
// Saudi Arabia it is prohibited outright. A filter that applied Saudi rules
// to Dubai would delete most of what makes Num useful there, and a filter
// that applied Dubai's rules to Riyadh would be the actual offence. So the
// policy is per country and the shared parts are the shared parts only.

/** What a rule does when it matches. */
export const BLOCK = 'block';
export const DISCLOSE = 'disclose';

/**
 * Recommendation shapes. The filter is looking for Num SENDING somebody, not
 * for a topic being discussed, so the topic terms below only matter within
 * reach of one of these.
 */
const SENDING = /\b(recommend|i'?d go|i would go|head (?:to|over)|go to|try|check out|worth a visit|book|reserve|take you|best (?:place|spot|bar|club)|my pick|you'?ll love|pop (?:in|into)|drop by|make your way)\b/i;

/**
 * Refusal and negation. A reply that says "I can't point you at a bar here"
 * contains both a topic term and a sending verb, and it is exactly the
 * behaviour we want. Flagging it would train us to weaken the prompt that
 * produced the right answer.
 */
const REFUSING = /\b(can'?t|cannot|not able|won'?t|will not|isn'?t (?:something|possible)|is illegal|are illegal|not legal|prohibited|banned|against the law|no alcohol|alcohol[- ]free|non[- ]alcoholic|dry|not permitted|not allowed|avoid|steer clear|instead)\b/i;

/** Distance, in characters, within which a sending verb counts as attached. */
const NEAR = 90;

const TOPICS = Object.freeze({
  alcohol: /\b(bar|bars|pub|pubs|cocktail|cocktails|brewery|wine|beer|spirits|whisky|whiskey|vodka|gin|champagne|happy hour|drinks? menu|nightcap|booze)\b/i,
  lgbtq_venue: /\b(gay bar|gay club|lgbtq?\+? (?:bar|club|venue|night|scene)|drag (?:show|bar|night)|queer (?:bar|club|night))\b/i,
  gambling: /\b(casino|casinos|roulette|blackjack table|slot machines?|betting shop|sportsbook|poker room)\b/i,
  pork: /\b(pork|bacon|ham(?:burger)?\b(?! ?burger)|prosciutto|chorizo|pancetta|pulled pork|pork belly)\b/i,
});

/**
 * Per-country rules.
 *
 * `topics` are BLOCK rules — Num must not send anybody there.
 * `disclose` is different: the fact is not forbidden, it is REQUIRED, and
 * omitting it is the harm.
 */
export const POLICIES = Object.freeze({
  AE: {
    country: 'AE', name: 'the UAE',
    block: ['lgbtq_venue', 'gambling'],
    // Alcohol is deliberately absent. It is legal in licensed venues here and
    // naming one is ordinary. Blocking it would delete most of Dubai.
    disclose: [],
    brief:
      'WHERE YOU ARE — THE UAE. Alcohol is legal in licensed venues, so naming a hotel bar or a rooftop is ' +
      'completely normal and you should do it when it is the right answer. What you must NOT do: promote drinking ' +
      'as the point of the evening, surface LGBTQ-specific venues or events, or point anybody at gambling — both ' +
      'are criminal offences here and the exposure lands on Num, not only on the traveller. ' +
      'If somebody asks directly whether something is legal, answer honestly and plainly; refusing to answer a ' +
      'straight question helps nobody and they will go and ask something less careful. ' +
      'During Ramadan, be aware of daytime hours before recommending a lunch.',
  },
  SA: {
    country: 'SA', name: 'Saudi Arabia',
    block: ['alcohol', 'lgbtq_venue', 'gambling', 'pork'],
    disclose: ['makkah'],
    brief:
      'WHERE YOU ARE — SAUDI ARABIA. Alcohol is illegal, full stop. Never name a bar, never suggest where to ' +
      'drink, and if asked, say plainly that it is not available in the Kingdom — that is the honest and useful ' +
      'answer, not a dodge. The same applies to gambling, to pork, and to LGBTQ venues, which carry severe ' +
      'penalties. Entertainment is a different matter and is opening fast: concerts, Riyadh Season, mixed venues ' +
      'and restaurants are all good answers.\n' +
      'RAMADAN IS NOT ETIQUETTE HERE. Eating or drinking in public during fasting hours is an offence, so a lunch ' +
      'recommendation in Ramadan can get somebody in real trouble. Check the date before you answer.\n' +
      'MAKKAH: non-Muslims are legally barred from the city and restricted in central Madinah. If a trip touches ' +
      'either, say so before anything else — routing somebody to a city they cannot legally enter is a genuine ' +
      'harm, not a bad suggestion.',
  },
});

/** Countries with no special rules get nothing — silence, not an empty policy. */
export const policyFor = (countryCode) => POLICIES[String(countryCode || '').toUpperCase()] || null;

/** The pre-generation instruction. Empty where there is no policy. */
export const policyBrief = (policy) => (policy ? `\n\n${policy.brief}` : '');

/**
 * Does this sentence SEND somebody to the topic, or merely discuss it?
 *
 * Sentence-scoped on purpose. A reply can refuse in one sentence and
 * recommend in the next, and screening the whole blob would let the refusal
 * launder the recommendation.
 */
function sends(sentence, re) {
  const m = re.exec(sentence);
  if (!m) return false;
  const at = m.index;
  const window = sentence.slice(Math.max(0, at - NEAR), Math.min(sentence.length, at + m[0].length + NEAR));
  if (REFUSING.test(window)) return false;
  return SENDING.test(window);
}

/**
 * Screen a reply before it is sent.
 *
 * @returns {{ok: true} | {ok: false, rule: string, sentence: string}}
 */
export function screen(reply, policy) {
  if (!policy || !reply) return { ok: true };
  const text = String(reply);
  // Split on sentence enders, keeping it crude on purpose — an over-eager
  // split only makes the window smaller, which fails safe.
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  for (const s of sentences) {
    for (const rule of policy.block) {
      const re = TOPICS[rule];
      if (re && sends(s, re)) return { ok: false, rule, sentence: s.trim().slice(0, 160) };
    }
  }
  return { ok: true };
}

/**
 * What to say instead. Never a bare refusal — the traveller asked a real
 * question and deserves the true reason plus somewhere else to go.
 */
export const SUBSTITUTES = Object.freeze({
  alcohol: 'That is one thing I genuinely cannot help with here — alcohol is not available in the Kingdom, and I would rather tell you straight than send you somewhere that does not exist. What I can do is find you somewhere worth sitting: the specialty coffee scene is very good, and the restaurant rooms are better than people expect. Want me to pick one?',
  lgbtq_venue: 'I am not able to point you towards that here, and I would rather say so plainly than pretend I have not understood. Is there something else I can line up for the evening?',
  gambling: 'Gambling is not legal here, so there is genuinely nothing for me to point you at. If it is a big night you are after though, that I can do — what sort of room are you in the mood for?',
  pork: 'That one is not available here, so I will not send you looking. Tell me what you were actually in the mood for — something rich, something smoky? — and I will find the closest thing worth eating.',
});

export const substituteFor = (rule) =>
  SUBSTITUTES[rule] || 'That is not something I can help with here. Tell me what else you need and I will sort it.';
