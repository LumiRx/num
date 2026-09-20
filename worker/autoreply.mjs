/**
 * GATE ZERO, PART TWO: the turns that carry no question at all.
 *
 * ── Why this exists (20 Sep 2026) ────────────────────────────────────────
 *
 * knownanswer.mjs answers lookups off a partner row. Over 272 real asks it
 * fired ZERO times, because the repeats people actually send are not lookups.
 * Counted from num_asks over three days:
 *
 *   "cate"                                    × 8   (three destinations)
 *   "run a trip check and tell me what needs me." × 4
 *   "ok"                                      × 3
 *   "yes"                                     × 2
 *
 * Every one of those paid for a full model turn — ~4,300 input tokens each,
 * because the bill is the system block, not the sentence. Seventeen turns of
 * persona, house style, destination guide and partner block, spent on a
 * four-letter typo and a word of agreement.
 *
 * None of the four needs a brain:
 *
 *   • A trip check is ARITHMETIC. The app has already done it — clashes,
 *     tight gaps, expiring holds, empty days — and posts the result in
 *     `state.tripCheck` (src/lib/prefs.ts). When that arithmetic found
 *     nothing wrong, there is nothing for a model to add; it is being paid
 *     to rephrase a sentence the app already wrote, in the language the app
 *     already wrote it in.
 *
 *   • "ok" is not a question. It is somebody closing a turn.
 *
 *   • "cate" is a typo, or a thumb. Whatever a model invents for it is a
 *     guess dressed as an answer, and the honest reply — say a bit more — is
 *     one we can write ourselves for nothing.
 *
 * ── The two rules that keep it honest ────────────────────────────────────
 *
 * 1. NEVER STEAL A REAL TURN. "ok" after NUM asked a question is an ANSWER
 *    to that question, and it goes to the brain. So the acknowledgement path
 *    fires only when what NUM last said asked nothing. Same for a trip check
 *    that found something: a clash needs judgement about which one to move.
 *
 * 2. ENGLISH ONLY, EXCEPT WHERE THE WORDS ARE THE APP'S. The replies below
 *    are written in English and there is no phrasebook in this worker, so
 *    answering a Thai speaker from here would be worse than paying for the
 *    model. The trip-check path is the exception and only looks like one:
 *    every word it returns came from the app already translated, and the
 *    trigger is the app's own English regex (concierge.ts), so it cannot
 *    fire on a sentence we did not write.
 */

/** Lines the app marks as things that need a person. Any one of these → brain. */
const NEEDS_JUDGEMENT = /^(?:CLASH|TIGHT|TRANSFER|HOLD EXPIRES|EMPTY DAYS|MULTI-CITY)\b/;

const TRIP_CHECK = /\b(?:trip check|am i ready|check my trip|what needs me)\b/i;

/** Bare agreement, gratitude or a closing noise — nothing asked. */
const ACK = /^(?:ok|okay|k|kk|yes|yep|yeah|yup|sure|cool|nice|great|thanks|thank you|thx|ty|got it|gotcha|perfect|awesome|sounds good|will do|no|nope)[\s.!]*$/i;

/**
 * Did NUM's last message ask something?
 *
 * A question mark anywhere is enough to step aside. Over-cautious on purpose:
 * paying for a turn we could have had free costs a cent, and answering "yes"
 * with "Any time." when NUM just asked "shall I book it?" costs a booking.
 */
const asksSomething = (prev) => /\?/.test(String(prev ?? ''));

/**
 * Short words that are a real question even at four letters. A destination
 * word, a category, a need. Anything here goes to the brain.
 */
const SHORT_BUT_REAL = new Set([
  'bar', 'bars', 'spa', 'gym', 'eat', 'tea', 'ktv', 'taxi', 'atm', 'bts', 'mrt',
  'sim', 'map', 'tip', 'tips', 'day', 'now', 'hi', 'hey', 'yo', 'food', 'cafe',
  'club', 'pool', 'boat', 'park', 'tour', 'wifi', 'visa', 'cash', 'beer', 'wine',
  'thai', 'sea', 'car', 'van', 'bike', 'walk', 'swim', 'surf', 'golf', 'gift',
  'kids', 'baby', 'dogs', 'halal', 'veg', 'sun', 'rain', 'help', 'plan', 'book',
  'menu', 'open', 'shut', 'busy', 'cost', 'near', 'here', 'home', 'work', 'call',
]);

/** True when a lone short token is almost certainly a typo or a stray tap. */
export function isFragment(text) {
  const t = String(text ?? '').trim();
  if (!t || /\s/.test(t)) return false;
  if (!/^[a-z]{2,5}$/i.test(t)) return false;
  return !SHORT_BUT_REAL.has(t.toLowerCase());
}

/** English, or no preference stated. The replies below are written in English. */
const isEnglish = (lang) => {
  const l = String(lang ?? '').trim().toLowerCase();
  return !l || l.startsWith('en');
};

/**
 * Answer without a model, or null to let a brain have it.
 *
 * @returns {{reply: string, kind: string}|null}
 */
export function autoReply({ text, prevAssistant = '', state = {}, lang = null }) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 120) return null;

  // ── A CLEAN TRIP CHECK ────────────────────────────────────────────────
  // The lines are the app's own, already in the reader's language. We only
  // decide whether any of them needs a person.
  if (TRIP_CHECK.test(t)) {
    const lines = Array.isArray(state?.tripCheck) ? state.tripCheck.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
    if (lines.length && !lines.some((l) => NEEDS_JUDGEMENT.test(l))) {
      return { reply: lines.join(' '), kind: 'tripcheck' };
    }
    return null;
  }

  if (!isEnglish(lang)) return null;

  if (ACK.test(t)) {
    if (asksSomething(prevAssistant)) return null;
    return { reply: 'Any time. Say the word when you need the next thing.', kind: 'ack' };
  }

  if (isFragment(t)) {
    return { reply: "I didn't catch that one — give me a few more words and I'll find it.", kind: 'fragment' };
  }

  return null;
}
