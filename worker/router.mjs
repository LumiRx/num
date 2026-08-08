// Model routing + output guard for /api/num.
//
// Two jobs, both about what leaves the Worker:
//
//  1. pickLane / smallReply — cost control. Chit-chat ("thanks!", "sounds
//     good") doesn't need Claude carrying the full concierge brain; it goes to
//     a fast Workers AI model with a ~60-token prompt. Anything that smells
//     like money, dates, places, or action routes big — a wrong route is a
//     worse answer to a user, and the concierge is the product (see
//     ai/router.js, the LINE brain's version of the same idea).
//
//  2. guardReply — the last gate before any reply reaches the user. Structured
//     output occasionally leaks JSON scaffolding into the reply field
//     ('", chips: null, actions: []}…'); the guard salvages clean prose when
//     it can and rejects the reply when it can't.

const HAS_DIGIT_OR_DATE = /\d|tomorrow|tonight|monday|next week|am|pm/i;
const ACTION_VERB = /book|order|get me|reserve|hold|cancel|change|move|pay|hire|meeting|table|car|flight|hotel|transfer|club/i;
const PLACE_QUESTION = /where|recommend|best|near/i;
// Short, verbless, digitless — and yet every one of these needs the full brain
// and the trip state. "run a trip check" used to route small and come back with
// a generic "what would you like to do?", which is the worst possible answer to
// someone asking whether their trip is in order.
const NEEDS_THE_BRAIN =
  /trip check|check my trip|am i ready|what needs me|anything i should know|invite|rsvp|event|guest list|group plan|plan with|massage|spa|ride|taxi|uber|grab|lyft|bolt|careem|delivery|deliver|eat|hungry|crypto|bitcoin|wallet|what'?s new|whats new/i;

/**
 * Which model answers this message. 'small' ONLY when the message is short,
 * carries no numbers/dates, no action verbs, no place-hunting, and the user is
 * already onboarded (place known) — i.e. greetings, thanks, acknowledgments,
 * emoji, small talk. Everything else is 'big'.
 */
export function pickLane(text, state = {}) {
  const s = typeof text === 'string' ? text : '';
  if (!state?.onboarded) return 'big';
  if (s.length >= 90) return 'big';
  if (HAS_DIGIT_OR_DATE.test(s)) return 'big';
  if (ACTION_VERB.test(s)) return 'big';
  if (PLACE_QUESTION.test(s)) return 'big';
  if (NEEDS_THE_BRAIN.test(s)) return 'big';
  return 'small';
}

export const SMALL_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/**
 * The cheap model agrees to the ban list and then writes "how can I help you
 * today?" anyway. Asking a 70B model nicely is not a control; this is. Any
 * small-lane reply matching these falls through to the real brain, which costs
 * a few cents and keeps Num sounding like Num.
 */
const SWITCHBOARD =
  /how (?:can|may) i (?:help|assist)|here to (?:help|assist)|let me know if|feel free to|what'?s up\??$|is there anything (?:else )?i can/i;

function smallSystem(profile = {}, place = null) {
  const facts = [];
  if (place) facts.push(`current place: ${place}`);
  for (const [k, v] of Object.entries(profile ?? {})) facts.push(`${k}: ${v}`);
  // The cheap lane still has to sound like Num — a user cannot tell which model
  // answered, and "Welcome to Bangkok, how can I help you today?" reads like a
  // hotel switchboard, not the assistant they met a minute ago.
  return (
    'You are Num — a personal assistant who genuinely enjoys this job. Warm, easy, never formal, never corporate.\n' +
    'Reply in ONE short sentence, under 25 words, the way a friend texts back. Then stop.\n' +
    'BANNED, never write these: "How can I help you today", "How may I assist", "What\'s up", "Let me know if", ' +
    '"I am here to help", "Feel free to". They read like a switchboard, not a person.\n' +
    'Do not ask a generic question. Either acknowledge warmly and stop, or offer ONE specific thing.\n' +
    'Examples of the right register:\n' +
    '  user: thanks!            you: Any time.\n' +
    '  user: nice one           you: Glad that landed.\n' +
    '  user: hey                you: Hey — I\'m here whenever you need something sorted.\n' +
    '  user: ok cool            you: Consider it noted.\n' +
    'NEVER output JSON, brackets, or role labels. ' +
    'If the user wants a booking, a recommendation, a suggestion, or anything requiring action or knowledge, reply exactly "HANDOFF".' +
    (facts.length ? '\nKnown facts:\n' + facts.map((f) => `- ${f}`).join('\n') : '')
  );
}

/**
 * Small-lane answer via Workers AI. Returns the reply string, or null on any
 * failure — the caller falls through to the big lane, never to an error.
 */
/** True when a small-lane reply is corporate filler and must not be sent. */
export const soundsLikeASwitchboard = (t) => SWITCHBOARD.test(String(t ?? ''));

export async function smallReply(env, messages, profile, place) {
  if (!env?.AI?.run) return null;
  try {
    const res = await env.AI.run(SMALL_MODEL, {
      messages: [{ role: 'system', content: smallSystem(profile, place) }, ...messages.slice(-6)],
      max_tokens: 220,
    });
    const text = typeof res === 'string' ? res : res?.response;
    return typeof text === 'string' ? text.trim() : null;
  } catch (err) {
    console.warn('[router] small lane failed:', err?.message ?? err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Output guard
// ---------------------------------------------------------------------------

const LEAK_PATTERNS = [
  /"?role"?\s*[:=]/, // {"role": "assistant"…} / role = 'user'
  /\{\s*['"]?(?:reply|role)['"]?\s*:/, // a reply/role object opening mid-text
  /(?:chips|actions)['"]?\s*:\s*(?:null|\[)/, // trailing schema fields
];

const bracketCount = (s) => (s.match(/[[\]{}]/g) ?? []).length;

function isCleanProse(s) {
  if (!s) return false;
  if (s.length > 1400) return false;
  for (const re of LEAK_PATTERNS) if (re.test(s)) return false;
  if (bracketCount(s) > 8) return false;
  return true;
}

/** Cut away the JSON scaffolding a leaked reply drags along, keep the prose. */
function salvage(text) {
  let s = String(text ?? '');
  // Leading fragment glued to the front: `", chips: null, actions: ["…` etc.
  s = s.replace(/^[\s,]*(?:['"]?(?:reply|chips|actions|card)['"]?\s*:\s*(?:null|\[\]|['"]))+/, '');
  // Everything from the first trailing schema field onward is scaffolding.
  const chipsAt = s.search(/,?\s*['"]?chips['"]?\s*:\s*null/);
  if (chipsAt !== -1) s = s.slice(0, chipsAt);
  // Python-style message-history dumps start with {'role': …
  const roleAt = s.search(/\{['"]role['"]/);
  if (roleAt !== -1) s = s.slice(0, roleAt);
  s = s.trim();
  // The reply string's own closing quote survives the cut — drop it only when
  // it's unbalanced, so quoted prose keeps its quotes.
  if (s.endsWith('"') && (s.match(/"/g) ?? []).length % 2 === 1) s = s.slice(0, -1).trimEnd();
  return s;
}

/**
 * Judge (and if needed repair) a reply before it goes out.
 * @returns {{ok: boolean, cleaned: string|null}} — ok:true means `cleaned` is
 * safe to send; ok:false with a non-null `cleaned` is a best-effort truncation
 * the caller may use as a last resort.
 */
export function guardReply(text) {
  const raw = String(text ?? '').trim();
  if (isCleanProse(raw)) return { ok: true, cleaned: raw };
  const cleaned = salvage(raw);
  if (isCleanProse(cleaned)) return { ok: true, cleaned };
  // Structure survived salvage, or nothing is left. If only length failed,
  // offer a truncation the caller can fall back on; otherwise nothing usable.
  const truncated = cleaned.slice(0, 1400).trim();
  const usable = cleaned.length > 1400 && isCleanProse(truncated) ? truncated : null;
  return { ok: false, cleaned: usable };
}

/* ────────────────────────────────────────────────────────────────────────
 * Which Claude answers.
 *
 * Opus ran on every big-lane turn, including "what time is it in Phuket".
 * That is not generosity, it is not looking: the same answer comes back from
 * a cheaper model, and the budget spent on it is budget unavailable for the
 * turn that plans somebody's evening.
 *
 * The rule is not "spend less". It is spend on the turns that deserve it.
 *
 * ── FAILS TOWARD QUALITY ────────────────────────────────────────────────
 *
 * A classifier that guesses wrong in the cheap direction produces a bad
 * answer to a question somebody cared about. Guessing wrong in the expensive
 * direction costs a few cents. So this returns the strong model unless the
 * ask is *clearly* simple — silence, ambiguity, and anything unrecognised all
 * escalate. Cheap is opt-in, never the default.
 * ──────────────────────────────────────────────────────────────────────── */

/** Anything touching money, a commitment, or more than one step. */
const DESERVES_THE_BEST = new RegExp(
  [
    // Money and commitment. Never economise on a turn that can cost a guest.
    'book|booking|reserve|reservation|pay|paid|price|cost|charge|refund|cancel|deposit|bill|invoice',
    // Planning — the thing a frontier model is actually better at.
    'plan|itinerary|schedule|day trip|week|tomorrow|tonight then|after that|and then',
    // Comparison and judgement.
    'compare|versus| vs |better|worth it|should i|which one|recommend|instead',
    // Groups: more constraints to hold at once.
    'we are|we have|our group|party of|kids|children|family|wheelchair|allerg',
    // Trouble. A guest with a problem gets the best we have, always.
    'wrong|broken|late|missing|complain|help me|stuck|lost|emergency|hospital|police',
  ].join('|'),
  'i',
);

/** Short, single-fact lookups where a mid model is genuinely as good. */
const SIMPLE_LOOKUP = /^(what|where|when|who|how far|how long|is|are|does|do)\b/i;

/**
 * Pick the model for this turn.
 *
 * `NUM_MODEL` still overrides everything — a single secret puts the whole
 * product back on one model in under a minute, which is what you want at 2am
 * when a routing change is the suspect.
 */
export function pickModel(text, state = {}, env = {}) {
  if (env.NUM_MODEL) return env.NUM_MODEL;
  const strong = env.NUM_MODEL_STRONG || 'claude-opus-5';
  const easy = env.NUM_MODEL_EASY || 'claude-sonnet-5';
  const s = typeof text === 'string' ? text : '';

  // A live trip means there is context to get wrong. Never economise on it.
  if (state?.bookings?.length || state?.party?.id || state?.tripCheck) return strong;
  if (!s.trim()) return strong;
  if (s.length > 120) return strong;
  if (DESERVES_THE_BEST.test(s)) return strong;
  // Only now, having ruled out everything that matters, may it be cheap.
  if (SIMPLE_LOOKUP.test(s.trim()) && s.length <= 80) return easy;
  return strong;
}
