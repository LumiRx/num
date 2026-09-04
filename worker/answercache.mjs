/**
 * The answer we already paid for.
 *
 * Every guest in Patong asks about the same twenty beaches, the same ten
 * restaurants, the same airport transfer. Until now each one of those cost a
 * full frontier-model generation, every single time, forever. In a concierge
 * product repeat questions are not a long tail — they are a very short head,
 * and paying for the same sentence four hundred times is the largest single
 * waste in the system.
 *
 * A hit costs one D1 read and zero tokens. It also returns in milliseconds
 * rather than seconds, so the cheapest change here is also the fastest one.
 *
 * ── WHAT MUST NEVER BE CACHED ─────────────────────────────────────────────
 *
 * Anything shaped by who is asking. If the reply used the guest's profile,
 * party size, or trip state, it is theirs — serving it to the next person is
 * both wrong and a privacy failure. `cacheable()` is deliberately strict:
 * a missed cache costs money, a wrong hit costs trust.
 *
 * ── WHY TTL IS PER-INTENT ─────────────────────────────────────────────────
 *
 * A beach is in the same place next month. Opening hours are not, and a price
 * certainly is not. One global TTL either throws away good answers or serves
 * stale ones; there is no single number that is right for both.
 */

/**
 * Collapse the many ways people type one question into a single key.
 *
 * "Best beach in Phuket?", "best beaches phuket", "what's the best beach in
 * phuket" are one question. Without this the cache would hold a thousand keys
 * and hit none of them.
 */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    // \p{M} belongs with \p{L}: in Thai, Arabic, Hindi and decomposed
    // Vietnamese the vowels and tones ARE combining marks. Dropping them does
    // not just mangle the key — it collapses distinct questions onto the same
    // one, and this is a cache. Two different questions sharing a key means
    // the second person is served the answer to the first person's question.
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    // Filler that changes the typing and not the question.
    .replace(/\b(the|a|an|is|are|whats|what|s|please|pls|can|you|i|me|my|do|does|any|some|good|for|to|of|in|at|on|near|around)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // "beach" and "beaches" are one question. Without stemming they are two
    // keys that each miss, which is most of the saving lost to an "es".
    .split(' ')
    .map(stem)
    .join(' ')
    .trim();
}

/** Crude, deliberate stemmer: singularise, and nothing else. */
function stem(w) {
  if (w.length <= 3) return w;
  if (/(ch|sh|s|x|z)es$/.test(w)) return w.slice(0, -2);
  if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
  // "ss" is not a plural — "class", "address".
  if (/[^s]s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** How long an answer of this kind stays true, in seconds. */
export function ttlFor(text) {
  const t = String(text ?? '').toLowerCase();
  // Anything with a time or a price in it goes stale within the hour.
  if (/\b(open|close|closing|hours|today|tonight|now|price|cost|how much|available|showtime|book)\b/.test(t)) return 3600;
  // Recommendations drift with seasons and closures, but not by the day.
  if (/\b(best|where|recommend|top|good)\b/.test(t)) return 7 * 86400;
  return 86400;
}

/**
 * Words that make a question ABOUT the asker rather than about the place they
 * are standing in.
 *
 * ── WHY THE OLD PRONOUN RULE HAD TO GO ───────────────────────────────────
 *
 * This used to reject any question containing i / me / my / we / our. It read
 * as a safe privacy rule and it was, in fact, a total cache outage: measured
 * on 30 Aug the table held 9 entries and had served ZERO hits in its life,
 * while 383 asks collapsed to only 99 distinct questions. Every one of the top
 * nine repeats was blocked by a pronoun — "my group needs dinner ideas in
 * patong tonight" (217 times), "i'm in phuket. where should we eat tonight?"
 * (21), "book me a massage nearby" (13). Travellers phrase everything in the
 * first person; a rule that bans the first person bans the product.
 *
 * The real distinction is not the pronoun, it is what the pronoun POINTS AT.
 * "where should we eat tonight" points at a town and a time of day and is the
 * same answer for everyone standing there. "where is my booking" points at a
 * row in a database with one person's name on it. Only the second is personal,
 * and these patterns look for that — a possessive attached to something we
 * actually hold about someone, a question about their own record, or a stated
 * attribute that reshapes the recommendation itself.
 */
const PERSONAL_STATE =
  /\b(?:my|our|mine|ours)\b(?:\s+\w+){0,2}\s+(?:booking|reservation|flight|hotel|room|trip|itinerary|table|car|ride|driver|order|bill|tab|payment|card|account|profile|itin|party|wife|husband|partner|birthday|anniversary|visa|passport|luggage|bag|name|number|email|phone|address)\b/i;

/** Asking after their own record — "what did I book", "where am I staying". */
const OWN_RECORD =
  /\b(?:i|we|my|our|me|us)\b[^?.!]{0,40}\b(?:booked|reserved|staying|stayed|owe|owed|paid|ordered|confirmed|cancelled|canceled|scheduled|checked in)\b|\b(?:did|do|have|has|am|are|is)\b[^?.!]{0,20}\b(?:i|we)\b[^?.!]{0,30}\b(?:book|reserve|order|pay|owe|confirm|cancel|stay)\b/i;

/**
 * A request to DO something, not to know something.
 *
 * These must never be answered from cache even when the wording is identical,
 * because the stored reply is a promise — "I'll get that locked in" — and
 * replaying a promise to a second guest makes it a lie. The reply to an action
 * turn is also the one place a stale answer costs somebody a table rather than
 * a few tokens.
 */
const ACTION_REQUEST =
  /\b(?:book|booking|reserve|reservation|order|cancel|change|reschedule|move|hold|pay|paid|charge|refund|deposit|confirm|get me|send me|call|arrange|hire)\b/i;

/**
 * A stated attribute changes which answer is RIGHT for this person, so the
 * answer is theirs even though the question sounds generic.
 */
const STATED_ATTRIBUTE =
  /\b(?:i|we)(?:'m|'re|\s+am|\s+are)\b[^.?!]{0,40}\b(?:vegan|vegetarian|pescatarian|halal|kosher|gluten[- ]?free|allergic|celiac|coeliac|pregnant|disabled|diabetic|sober|teetotal)\b|\b(?:my|our)\s+(?:allerg|diet|budget|dietary)/i;

/**
 * Profile keys that genuinely reshape a recommendation, as opposed to merely
 * existing.
 *
 * The old rule rejected the turn whenever ANY profile was present. Since
 * durable member memory shipped on 29 Aug every returning member has a
 * profile, so that rule quietly meant "the better Num's memory gets, the less
 * it can cache" — the two best features cancelling each other out.
 *
 * A stored first name or interface language does not change which beach is
 * best; language is part of the cache key already. A nut allergy, a
 * wheelchair, a child, a budget — those change the answer, and a turn shaped
 * by one of them must never be served to the next person.
 */
const SHAPING_KEY = new RegExp([
  // What they cannot or will not eat, drink or reach.
  'diet|allerg|vegan|vegetarian|pescatarian|halal|kosher|gluten|intoleran',
  'accessib|wheelchair|mobility|pregnan|medical|religio|sober|alcohol',
  // Who is travelling with them.
  'kid|child|infant|toddler|baby|elder|senior|dog|pet',
  // What they can spend.
  'budget|cheap|afford|luxur|splurge|price range',
  // ── TASTE ────────────────────────────────────────────────────────────
  // Added after worker/answercache.test.mjs caught it: a stored
  // `likes: seafood` does not merely describe the guest, it changes which
  // three restaurants are the RIGHT three. A preference is as answer-shaping
  // as an allergy — it just fails softly rather than dangerously, which is
  // precisely why it is the one that would have slipped through.
  'like|love|hate|prefer|favou?rite|avoid|cuisine|taste|interest|style|vibe',
].join('|'), 'i');

/** True when the stored profile would have changed what a good answer says. */
export function profileShapesAnswer(profile) {
  if (!profile || typeof profile !== 'object') return false;
  return Object.entries(profile).some(([k, v]) => {
    if (v == null || String(v).trim() === '') return false;
    return SHAPING_KEY.test(String(k)) || SHAPING_KEY.test(String(v));
  });
}

/** Questions whose answer depends on where the asker is standing. */
const NEAR_ME = /\b(near|nearby|nearest|close|closest|around here|walking distance|walk(?:able)? to|by me|near me|from here|here)\b/i;

/**
 * Whether this turn's answer belongs to everyone or only to the person who
 * asked. Still strict where it counts — the cost of a false negative is a few
 * tokens, the cost of a false positive is showing one guest another guest's
 * trip — but strict about the right thing.
 */
export function cacheable({ userText, profile, state, reply, pos }) {
  const q = String(userText ?? '');
  if (q.length < 3 || q.length > 300) return false;
  // "Near me" is a question about a POSITION, and the answer was built from
  // a 4 km ring around one. Without a position in the key, the guest in Kata
  // is served the guest in Patong's "near you" for a week — and normalize()
  // deletes the word "near", so the key cannot even tell the two questions
  // apart. Cache these only when the caller supplied where the asker was.
  if (NEAR_ME.test(q) && !(pos && Number.isFinite(+pos.lat) && Number.isFinite(+pos.lng))) return false;
  // An in-progress trip means the answer was written against it.
  if (state && (state.bookings?.length || state.party || state.tripCheck)) return false;
  // Actions do things. Replaying a stored one would re-trigger the doing.
  if (reply?.actions?.length) return false;
  // A card is a booking state — confirmed, held, paid. Always one person's.
  if (reply?.card) return false;
  // A request to act is never answered from a recording.
  if (ACTION_REQUEST.test(q)) return false;
  if (PERSONAL_STATE.test(q)) return false;
  if (OWN_RECORD.test(q)) return false;
  if (STATED_ATTRIBUTE.test(q)) return false;
  if (profileShapesAnswer(profile)) return false;
  return true;
}

/**
 * ~1 km cell from a coordinate (two decimals of a degree ≈ 1.1 km of
 * latitude). Coarse on purpose: neighbours share an answer, districts don't.
 */
const cell = (pos) => (pos && Number.isFinite(+pos.lat) && Number.isFinite(+pos.lng))
  ? `${(+pos.lat).toFixed(2)},${(+pos.lng).toFixed(2)}`
  : '';

const KEY = (q, place, lang, pos) => `${normalize(q)}|${place ?? ''}|${String(lang ?? 'en').slice(0, 2)}|${cell(pos)}`;

/** Look for an answer we already have. Never throws — a cache is an optimisation. */
export async function readCache(env, { userText, place, lang, pos }) {
  if (!env?.DB) return null;
  try {
    const row = await env.DB.prepare(
      'SELECT payload, expires_at FROM num_answer_cache WHERE k = ? LIMIT 1',
    ).bind(KEY(userText, place, lang, pos)).first();
    if (!row) return null;
    if (Number(row.expires_at) < Math.floor(Date.now() / 1000)) return null;
    // Count the hit without blocking the reply on it.
    env.DB.prepare('UPDATE num_answer_cache SET hits = hits + 1 WHERE k = ?')
      .bind(KEY(userText, place, lang, pos)).run().catch(() => {});
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

let tableReady = false;

/** Store an answer for the next person who asks it. Never throws. */
export async function writeCache(env, { userText, place, lang, reply, pos }) {
  if (!env?.DB) return;
  try {
    if (!tableReady) {
      // Once per isolate, not once per write — this ran a DDL statement in
      // front of every cached answer.
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS num_answer_cache (
           k TEXT PRIMARY KEY,
           payload TEXT NOT NULL,
           expires_at INTEGER NOT NULL,
           hits INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL
         )`,
      ).run();
      tableReady = true;
    }
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'INSERT OR REPLACE INTO num_answer_cache (k, payload, expires_at, hits, created_at) VALUES (?, ?, ?, 0, ?)',
    ).bind(
      KEY(userText, place, lang, pos),
      // Only the parts that are the same for everyone. `actions` is excluded
      // above by cacheable(); this is belt and braces.
      //
      // `picks` ARE the answer. They are place facts — id, name, one reason,
      // and whatever resolvePicks attached from the directory — identical
      // for every asker at this place and cell. Leaving them out meant a
      // cache hit returned "Three near you — the first is what I'd do" with
      // no cards under it, and the quality gate never saw that reply.
      JSON.stringify({ reply: reply.reply, picks: Array.isArray(reply.picks) ? reply.picks : [], card: reply.card ?? null, chips: reply.chips ?? null }),
      now + ttlFor(userText),
      now,
    ).run();
  } catch {
    /* a cache that cannot write must never break a reply */
  }
}
