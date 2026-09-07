/**
 * GATE ZERO: the questions that need no brain at all.
 *
 * ── The measurement that produced this file (7 Sep 2026) ──────────────────
 *
 * Every ask, however small, was costing a full model turn — and the turns are
 * not small. Measured across 14 days of real traffic: 4,320 input tokens and
 * 397 output tokens on average, $0.041 a turn, $6.41 for 155 asks. The input
 * is the bill: persona, voice, house style, the destination guide, the
 * verified partner block and every offering attached to it, re-sent in full to
 * answer "what time does it open".
 *
 * But "what time does it open" has an answer we are ALREADY HOLDING. The
 * partner row in front of us has the opening mask, the address, the phone and
 * the link. Sending 4,000 tokens to a language model so it can read one field
 * out of a block we just built is not intelligence, it is a lookup with a
 * surcharge.
 *
 * So this gate answers those from the row. Zero tokens. Milliseconds. And —
 * the part that matters more than the money — it CANNOT BE WRONG, because it
 * does not generate anything. There is no temperature on a database field.
 *
 * ── The three rules that keep it honest ───────────────────────────────────
 *
 * 1. ONE PLACE, UNAMBIGUOUSLY. It fires only when exactly one verified place
 *    is in play — named in the question, or the only place named in what Num
 *    just said. Two candidates means the guest gets a brain, because guessing
 *    which restaurant they meant is worse than spending a cent.
 *
 * 2. THE FACT MUST ACTUALLY BE THERE. No hours mask, no hours answer. It
 *    falls through to a brain rather than saying "I don't know" — an empty
 *    field is a reason to think, not a reason to shrug at somebody.
 *
 * 3. IT NEVER GUESSES WHAT WAS ASKED. The patterns are narrow and the fact
 *    types are four. Anything with a second clause, a comparison, a "should",
 *    a booking word or a plan in it is not a lookup and is not handled here.
 *
 * Everything it returns rides the same rails as a model answer: the place goes
 * in `picks`, so the app renders the usual card with its tappable call button
 * and map. The guest cannot tell this one was free, which is the point.
 */
import { openState, openLabel } from './pickdetail.mjs';

/** The four facts a row can answer on its own. */
export const FACTS = Object.freeze(['hours', 'address', 'phone', 'link']);

// Deliberately narrow. Each one is a LOOKUP — a question with exactly one
// field as its answer. Anything conversational falls through.
const ASKS = Object.freeze([
  ['hours', /\b(?:what time|when)\b[^?]{0,30}\b(?:open|close|closing|shut)\b|\bopen(?:ing)? (?:time|hours|now|today|yet)\b|\bclos(?:e|es|ing) (?:time|at)\b|\bare they open\b|\bis it (?:still )?open\b|\bwhat are (?:the |their )?hours\b|\bhours\?/i],
  ['address', /\bwhat(?:'?s| is) (?:the |their )?address\b|\baddress (?:for|of|please)\b|\bwhere (?:is|are) (?:it|they|that place)\b|\bwhereabouts\b/i],
  ['phone', /\b(?:phone|telephone|contact) (?:number|no\.?)\b|\bwhat(?:'?s| is) (?:the |their )?(?:phone|number)\b|\bnumber (?:for|of) \b|\bhow do i (?:call|reach|phone) (?:them|it)\b/i],
  ['link', /\b(?:web ?site|webpage|url|link|menu online)\b/i],
]);

/**
 * Words that mean this is not a lookup, whatever else it contains.
 *
 * "Is it open, and should we go?" is a conversation. "Book me a table when
 * they open" is an action. Both contain an hours pattern and neither is a
 * question this file may answer.
 */
const NOT_A_LOOKUP =
  /\b(?:book|booking|reserve|reservation|order|cancel|pay|table|should|recommend|best|instead|compare|better|worth|plan|itinerary|why|how much|price|cost|busy|crowded|good|nice|like|vibe|which one)\b|\b(?:and|also|plus)\b|\?[^?]*\?/i;

/**
 * Which single fact is being asked for, or null.
 *
 * `and` is in the refusal list on purpose: "what are the hours and the
 * address" reads as a lookup to a pattern and is a small conversation to a
 * person. Two answers in one breath, a "should we" hiding after the
 * conjunction — a brain handles all of it well and this gate handles none of
 * it, so the conjunction itself is the signal to step aside.
 */
export function factAsked(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 120) return null;
  if (NOT_A_LOOKUP.test(t)) return null;
  const hits = ASKS.filter(([, re]) => re.test(t)).map(([k]) => k);
  // Two facts in one sentence is a small conversation, not a lookup.
  return hits.length === 1 ? hits[0] : null;
}

const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The one place this question is about, or null.
 *
 * Named in the question wins. Failing that, the only place Num named in its
 * last message — which is what "what time does it open" actually refers to.
 * Exactly one, or nothing.
 */
export function placeInPlay(text, prevAssistant, partners = []) {
  const rows = (partners ?? []).filter((p) => p?.name);
  if (!rows.length) return null;

  const findIn = (hay) => {
    const h = ` ${norm(hay)} `;
    // Longest name first, so "Krua Thai Kata" wins over "Krua Thai".
    const found = rows
      .filter((p) => {
        const n = norm(p.name);
        // Two characters would match half the alphabet; a real venue name is
        // longer than that and this is not the place to be clever.
        return n.length >= 4 && h.includes(` ${n} `);
      })
      .sort((a, b) => norm(b.name).length - norm(a.name).length);
    if (!found.length) return null;
    // Distinct places, not distinct rows — "Nahm" listed twice is still one
    // answer, but Nahm AND Bo.lan is a question we must not guess at.
    const distinct = new Set(found.map((p) => String(p.id ?? norm(p.name))));
    return distinct.size === 1 ? found[0] : null;
  };

  return findIn(text) ?? findIn(prevAssistant ?? '') ?? null;
}

const PRONOUN = /\b(?:it|they|them|there|that place|this place)\b/i;

/**
 * Answer from the row, or null to let a brain have it.
 *
 * @returns {{reply: string, fact: string, place: string, pick: object}|null}
 */
export function knownAnswer({ text, prevAssistant = '', partners = [], tz = null, now = new Date() }) {
  const fact = factAsked(text);
  if (!fact) return null;
  const row = placeInPlay(text, prevAssistant, partners);
  if (!row) return null;

  // A pronoun with no antecedent in what Num just said is a guess waiting to
  // happen. If the place came from the question itself that is fine; if it
  // came from nowhere, fall through.
  if (!norm(text).includes(norm(row.name)) && PRONOUN.test(text) && !norm(prevAssistant).includes(norm(row.name))) return null;

  const name = String(row.name);
  let reply = null;

  if (fact === 'hours') {
    const st = openState(row.hours_mask, tz, now);
    const label = openLabel(st);
    if (!label) return null;
    // Read straight off the label so this file and the card can never
    // disagree about whether somewhere is open.
    reply = st.state === 'open'
      ? (st.always ? `${name} is open 24 hours.` : `${name} is open — ${label.replace(/^Open · /, '')}.`)
      : (st.always ? `${name} is closed.` : `${name} is closed right now — ${label.replace(/^Closed · /, '')}.`);
  }

  if (fact === 'address') {
    if (!row.address) return null;
    reply = `${name} is at ${row.address}. The card below has the map.`;
  }

  if (fact === 'phone') {
    if (!row.phone) return null;
    // The number itself is NOT typed into the sentence: a number inside prose
    // cannot be tapped by somebody walking. Same rule the concierge follows —
    // see the CONTACT RULE in prompt.mjs.
    reply = `Tap the call button on ${name}'s card below and it will dial them.`;
  }

  if (fact === 'link') {
    if (!row.website) return null;
    reply = `${name}'s own page is on the card below.`;
  }

  if (!reply) return null;
  return {
    reply,
    fact,
    place: name,
    // The pick shape resolvePicks expects, so the card is built the same way
    // it is for any other answer — link, map, phone and opening state all
    // attached server-side from this same row.
    pick: { id: row.id ?? undefined, name, why: null },
  };
}
