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
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
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
 * Whether this turn's answer belongs to everyone or only to the person who
 * asked. Strict by design — the cost of a false negative is a few tokens, the
 * cost of a false positive is showing one guest another guest's trip.
 */
export function cacheable({ userText, profile, state, reply }) {
  const q = String(userText ?? '');
  if (q.length < 3 || q.length > 300) return false;
  // A profile in play means the answer was shaped by who asked.
  if (profile && Object.keys(profile).length) return false;
  // An in-progress trip means the same.
  if (state && (state.bookings?.length || state.party || state.tripCheck)) return false;
  // Actions do things. Replaying a stored one would re-trigger the doing.
  if (reply?.actions?.length) return false;
  // First and second person mean the guest is talking about themselves.
  // Bare "we" belongs here as much as "we're" — "what did we book" is as
  // personal as "where is my booking", and it was the case this list missed.
  if (/\b(my|mine|i|i'm|im|we|we're|were|us|our|ours|me)\b/i.test(q)) return false;
  return true;
}

const KEY = (q, place, lang) => `${normalize(q)}|${place ?? ''}|${String(lang ?? 'en').slice(0, 2)}`;

/** Look for an answer we already have. Never throws — a cache is an optimisation. */
export async function readCache(env, { userText, place, lang }) {
  if (!env?.DB) return null;
  try {
    const row = await env.DB.prepare(
      'SELECT payload, expires_at FROM num_answer_cache WHERE k = ? LIMIT 1',
    ).bind(KEY(userText, place, lang)).first();
    if (!row) return null;
    if (Number(row.expires_at) < Math.floor(Date.now() / 1000)) return null;
    // Count the hit without blocking the reply on it.
    env.DB.prepare('UPDATE num_answer_cache SET hits = hits + 1 WHERE k = ?')
      .bind(KEY(userText, place, lang)).run().catch(() => {});
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

/** Store an answer for the next person who asks it. Never throws. */
export async function writeCache(env, { userText, place, lang, reply }) {
  if (!env?.DB) return;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS num_answer_cache (
         k TEXT PRIMARY KEY,
         payload TEXT NOT NULL,
         expires_at INTEGER NOT NULL,
         hits INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL
       )`,
    ).run();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'INSERT OR REPLACE INTO num_answer_cache (k, payload, expires_at, hits, created_at) VALUES (?, ?, ?, 0, ?)',
    ).bind(
      KEY(userText, place, lang),
      // Only the parts that are the same for everyone. `actions` is excluded
      // above by cacheable(); this is belt and braces.
      JSON.stringify({ reply: reply.reply, card: reply.card ?? null, chips: reply.chips ?? null }),
      now + ttlFor(userText),
      now,
    ).run();
  } catch {
    /* a cache that cannot write must never break a reply */
  }
}
