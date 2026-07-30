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
  return 'small';
}

export const SMALL_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

function smallSystem(profile = {}, place = null) {
  const facts = [];
  if (place) facts.push(`current place: ${place}`);
  for (const [k, v] of Object.entries(profile ?? {})) facts.push(`${k}: ${v}`);
  return (
    'You are Num, a warm, brisk personal concierge. Reply in under 50 words of plain prose. ' +
    'NEVER output JSON, brackets, or role labels. ' +
    'If the user wants a booking, a recommendation, or anything requiring action, reply exactly "HANDOFF".' +
    (facts.length ? '\nKnown facts:\n' + facts.map((f) => `- ${f}`).join('\n') : '')
  );
}

/**
 * Small-lane answer via Workers AI. Returns the reply string, or null on any
 * failure — the caller falls through to the big lane, never to an error.
 */
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
