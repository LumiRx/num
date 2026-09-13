/**
 * NUM · register — matching HOW Num talks to how this person talks.
 *
 * ── THE GAP THIS FILLS ───────────────────────────────────────────────────
 *
 * `soulprofile.mjs` learns WHAT to recommend. `specialists.mjs` holds the
 * house VOICE, one voice, the same for everybody. Nothing decides how Num
 * sounds to THIS person.
 *
 * That gap is worth closing because of one finding. Montoya, Horton &
 * Kirchner's meta-analysis (2008) shows that ACTUAL similarity predicts
 * liking at r = .55 when two parties never interact, r = .25 after a short
 * conversation, and r = .12 in established relationships — and, corrected for
 * publication bias in field studies, nothing at all. PERCEIVED similarity does
 * not decay. It keeps predicting liking at every stage.
 *
 * Num cannot be like anybody. It can sound like them, and the evidence says
 * that is the half that was carrying the weight.
 *
 * The specific mechanism is language style matching: Ireland, Slatcher,
 * Eastwick, Scissors, Finkel & Pennebaker (2011) found speed-daters above the
 * median for style matching were about three times likelier to want contact
 * (OR 3.05), and couples above the median about twice as likely to still be
 * together three months later (OR 1.95). It works entirely below conscious
 * awareness — undetectable by the speakers themselves AND by trained
 * observers. That last part is why this module reads behaviour and never asks.
 * People cannot report how they write. They report how they would like to.
 *
 * ── WHY THERE IS NO TABLE, AND NO MIGRATION ──────────────────────────────
 *
 * The first design stored dials per subject, like soulprofile. It was wrong.
 *
 * Register is not a lasting fact about a person, it is a property of how they
 * are typing right now — and the messages are already in `history` on every
 * turn. Computing it there costs one pass over at most fourteen strings and
 * buys four things a table cannot:
 *
 *   1. NOTHING IS STORED. There is no row to leak, subpoena or migrate. This
 *      is the strongest possible version of the rule the soulprofile file
 *      already states — store the operational preference, never the reason.
 *      Here we store neither. Two of three live markets are GDPR and an
 *      inferred communication profile is a far heavier thing to hold than
 *      "avoids shellfish".
 *   2. It cannot go stale. Somebody who writes three-word messages on a bad
 *      morning and paragraphs that evening gets both, correctly, with no
 *      decay rule to tune.
 *   3. It works on the first conversation, for anonymous devices, with no
 *      account — the same reason soulprofile is keyed on `member_id ?? anon_id`.
 *   4. No migration. Applied migrations in this repo are sealed by content
 *      hash for a good reason; the cheapest change is the one that needs none.
 *
 * ── THE CONFIDENCE RULE, BORROWED WHOLE ──────────────────────────────────
 *
 * soulprofile's CONFIDENT_AT = 3: one mention is a mood, three is a pattern.
 * The same number applies here. Under three messages from the guest this
 * module returns null and Num behaves exactly as it does today. A voice that
 * reshapes itself around a single "hi" is worse than one that never adapts,
 * because the guest notices it guessing.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────
 *
 * It never changes WHICH place is recommended, in what order, or what
 * anything costs. It only changes the words around an answer that was already
 * decided. `register.test.mjs` asserts that this file contains no venue,
 * ranking, price or ordering vocabulary at all — the guardrail has to live
 * somewhere, and the cheapest place is a grep over the one file that could
 * break it.
 */

/**
 * Three of the guest's own messages before anything adapts.
 * Same number, same reason, as soulprofile's CONFIDENT_AT.
 */
export const CONFIDENT_AT = 3;

/** How far back we look. The turn already slices history to 14. */
const WINDOW = 8;

/** Messages before Num will drop warmth. See the note at the warmth branch. */
export const BRISK_AT = 5;

/**
 * Scripts that do not put spaces between words. Thai is the one that matters
 * commercially — it is a live market — and splitting a Thai sentence on
 * whitespace returns 1, so every Thai guest would be read as maximally terse
 * and served clipped replies for ever. Japanese and Chinese have the same
 * shape. Roughly three characters to a word is the usual working figure for
 * Thai; it does not need to be exact, only not tenfold wrong.
 */
const SPACELESS = /[฀-๿぀-ヿ一-鿿]/;
const CHARS_PER_WORD = 3;

/** Any emoji, including ZWJ sequences and skin-tone modifiers. */
const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * Words that mark warmth in the guest's own writing. Kept deliberately short
 * and unambiguous: a long list starts catching politeness that is really just
 * transactional ("thanks" at the end of a complaint is not warmth).
 */
const WARM_EN = /\b(thanks|thank you|please|appreciate|lovely|amazing|perfect|brilliant|great|love it|excited|can't wait|cannot wait)\b/i;
/**
 * Thai and Japanese carry warmth in places an English word list cannot see,
 * and Thailand is a live market — an English-only reading meant every Thai
 * guest fell through to "no signal" and got the house default for ever.
 *
 * ครับ / ค่ะ / คะ are the politeness particles. They are the single strongest
 * register marker Thai has: their PRESENCE is deliberate courtesy and their
 * absence is blunt, which is exactly the axis being read here. ขอบคุณ is
 * thank-you, สวัสดี is hello.
 *
 * Japanese is deliberately thinner — ありがとう, greetings, お願い. The polite
 * です/ます forms are left out even though they mark register, because they
 * are near-universal in writing to a stranger and would mark every Japanese
 * guest warm regardless of how they actually write.
 */
const WARM_TH = /(ครับ|ค่ะ|คะ|ขอบคุณ|สวัสดี)/;
const WARM_JA = /(ありがとう|よろしく|お願い|こんにちは|おはよう)/;
const WARM = { test: (t) => WARM_EN.test(t) || WARM_TH.test(t) || WARM_JA.test(t) };
const GREETING = /^\s*(hi|hey|hello|morning|good morning|good evening|yo|hiya)\b/i;

/** Length of one message in words, script-aware. */
export function wordsIn(text = '') {
  const t = String(text ?? '').trim();
  if (!t) return 0;
  if (SPACELESS.test(t)) {
    // Strip spaces and punctuation before dividing, so a mixed Thai/English
    // line is not counted twice over.
    const dense = t.replace(/\s+/g, '');
    return Math.max(1, Math.round(dense.length / CHARS_PER_WORD));
  }
  return t.split(/\s+/).filter(Boolean).length;
}

const median = (ns) => {
  if (!ns.length) return 0;
  const s = [...ns].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Read the guest's register off their own messages.
 *
 * Returns null — meaning "say nothing, behave exactly as today" — whenever
 * there is not enough to go on. Null is the honest answer far more often than
 * a guess is, and it is the safe one: the house voice is already good.
 *
 * @param {Array<{role?: string, content?: string}>} history
 * @returns {{length: 'terse'|'expansive'|null, emoji: 'yes'|'no'|null,
 *            warmth: 'warm'|'brisk'|null, samples: number} | null}
 */
export function readRegister(history = []) {
  const mine = (Array.isArray(history) ? history : [])
    .filter((m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim())
    .slice(-WINDOW)
    .map((m) => m.content.trim());

  if (mine.length < CONFIDENT_AT) return null;

  const lengths = mine.map(wordsIn);
  const mid = median(lengths);

  // The bands are deliberately wide with dead space between them. A guest at
  // 12 words a message is just a guest; only a clear habit at either end is
  // worth acting on, and the middle is where the house voice already sits.
  let length = null;
  if (mid <= 6) length = 'terse';
  else if (mid >= 25) length = 'expansive';

  const withEmoji = mine.filter((t) => EMOJI.test(t)).length;
  let emoji = null;
  // One emoji in eight messages is punctuation, not a style. A third of
  // messages carrying one is a habit worth matching.
  if (withEmoji / mine.length >= 0.33) emoji = 'yes';
  else if (withEmoji === 0 && mine.length >= 4) emoji = 'no';

  const warmHits = mine.filter((t) => WARM.test(t) || GREETING.test(t)).length;
  // Lowercase, unpunctuated, no greeting, no thanks — the shape of somebody
  // firing off instructions. Checked as a whole-message property so a single
  // hurried line does not count.
  // Short AND unadorned. The length bound is load-bearing: without it, any
  // guest who types in lowercase without a full stop reads as brisk, which on
  // a phone is very nearly everybody. Brisk means somebody firing off
  // instructions, so it shares the terse threshold — the two are the same
  // underlying behaviour seen from different sides.
  const clipped = mine.filter((t) => (
    wordsIn(t) <= 6 && t === t.toLowerCase() && !/[.!?]$/.test(t) && !WARM.test(t) && !GREETING.test(t)
  )).length;

  let warmth = null;
  if (warmHits / mine.length >= 0.4) warmth = 'warm';
  // BRISK NEEDS MORE EVIDENCE THAN WARM DOES, and the asymmetry is deliberate.
  //
  // Short lowercase messages are simply how most people type on a phone, so a
  // low bar here would strip the greeting from nearly everybody. The cost is
  // not symmetric either: Tickle-Degnen & Rosenthal's rapport work finds
  // positivity and attentiveness carry the most weight EARLY in a
  // relationship, with coordination taking over later. So being wrongly cold
  // in the first few messages costs more than being wrongly warm, and the
  // floor for dropping warmth sits above the floor for matching length.
  else if (mine.length >= BRISK_AT && clipped / mine.length >= 0.75) warmth = 'brisk';

  if (!length && !emoji && !warmth) return null;
  return { length, emoji, warmth, samples: mine.length };
}

/**
 * Turn a register reading into the block appended to the house VOICE.
 *
 * Every line is an instruction rather than a description, because the cheaper
 * brains in the chain follow literally — the same reason `proseSystem` is
 * written the way it is.
 *
 * Two things this block may never do, and the test enforces both:
 *   - raise the length cap. The three-sentence, forty-word cap is a product
 *     decision that outranks matching. An expansive guest earns warmer
 *     phrasing, not a longer reply.
 *   - mention that any of this is happening. A guest told "I noticed you type
 *     briefly" is a guest being profiled at, which is the opposite of the
 *     effect — style matching works because it is invisible.
 */
export function registerBlock(reg) {
  if (!reg) return null;
  const lines = [];

  if (reg.length === 'terse') {
    lines.push('- This guest writes in a few words. Match it: answer first, no framing sentence, no sign-off. Well under the cap, not at it.');
  }
  if (reg.length === 'expansive') {
    lines.push('- This guest writes at length and reads the detail. Give the reason behind your choice, and the option you turned down — inside the length cap, which does not move.');
  }
  if (reg.emoji === 'yes') {
    lines.push('- Light emoji is welcome — at most one, where it carries meaning.');
  }
  if (reg.emoji === 'no') {
    lines.push('- No emoji. They use none.');
  }
  if (reg.warmth === 'warm') {
    lines.push('- They open warmly and say thank you. Return it in the phrasing — greet them back, use their name occasionally. Warmth in the words, never in extra length.');
  }
  if (reg.warmth === 'brisk') {
    lines.push('- They send instructions, not pleasantries. Skip the greeting and the warm close entirely and go straight to the answer. This is not coldness, it is respect for how they work.');
  }

  if (!lines.length) return null;
  return 'HOW THIS GUEST WRITES (mirror it; never mention it, never explain it):\n' + lines.join('\n');
}

/**
 * The one call site needs: history in, block out.
 * Pure, synchronous, no database, no network, cannot throw on bad input.
 */
export function registerFor(history = []) {
  try {
    return registerBlock(readRegister(history));
  } catch {
    // A voice adjustment is seasoning. It must never be the reason a guest
    // gets no answer — the same posture as the plan-context catch in index.
    return null;
  }
}
