/**
 * "What's on around here?" — when our own list has nothing.
 *
 * ── THE GAP THIS FILLS ────────────────────────────────────────────────────
 *
 * `num_city_events` holds 88 curated events across **25 destinations**. Num is
 * live in 77. So a guest standing in any of the other 52 who asks what is on
 * gets an honest shrug, and a concierge that shrugs is the one thing this
 * product cannot afford to be.
 *
 * Meanwhile `events.tm.mjs` — a complete, tested Ticketmaster Discovery search
 * — has been in this repo the whole time and **nothing has ever called it**.
 * This module is the wiring, not a new capability.
 *
 * ── WHY SEARCH RESULTS ARE LABELLED, NOT MERGED ───────────────────────────
 *
 * The curated rules are strict for good reason: never serve a stale event,
 * never serve one for a city with no place coverage, and the model may state
 * only what the block says, verbatim. An invented festival date is worse than
 * an invented showtime because people book flights around festivals.
 *
 * Live search cannot meet that bar — it is a third party's index, fetched a
 * second ago, unverified by us. So results are carried in their own block with
 * their own provenance line, and the model is told to say where they came
 * from. A guest who is told "Ticketmaster lists these, worth confirming" can
 * act on it. A guest who is told Num verified it cannot trust anything else we
 * verified.
 *
 * ── AND WHY IT IS CACHED ──────────────────────────────────────────────────
 *
 * Per destination, per day. Twenty guests in Patong asking the same evening
 * must not be twenty calls to a rate-limited free tier — the same lesson as
 * the answer cache, which cost 74% of all model spend before it was fixed.
 */

const CACHE_HOURS = 6;

/** Cached search results per destination. Never mixed with curated rows. */
async function ensure(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS num_event_search_cache (
       dest        TEXT PRIMARY KEY,
       payload     TEXT NOT NULL,
       source      TEXT NOT NULL,
       fetched_at  INTEGER NOT NULL
     )`,
  ).run();
}

async function readCache(env, dest, { now = Date.now() } = {}) {
  try {
    await ensure(env);
    const row = await env.DB.prepare(
      'SELECT payload, source, fetched_at FROM num_event_search_cache WHERE dest = ?1',
    ).bind(String(dest)).first();
    if (!row) return null;
    if (now - Number(row.fetched_at) > CACHE_HOURS * 3_600_000) return null;
    return { events: JSON.parse(row.payload), source: row.source, cached: true };
  } catch {
    return null;
  }
}

async function writeCache(env, dest, source, events, { now = Date.now() } = {}) {
  try {
    await ensure(env);
    await env.DB.prepare(
      'INSERT OR REPLACE INTO num_event_search_cache (dest, payload, source, fetched_at) VALUES (?1,?2,?3,?4)',
    ).bind(String(dest), JSON.stringify(events), source, now).run();
  } catch { /* a cache that cannot write must never cost a guest an answer */ }
}

/**
 * Look for events near a guest when we hold none of our own.
 *
 * Returns `{ events, source }` or null. NEVER throws: an events lookup is a
 * bonus on top of an answer, and a failed one must leave the concierge exactly
 * as capable as it was before.
 */
export async function searchEvents(env, { dest, lat, lng, country, days = 7, now = Date.now(), fetchImpl } = {}) {
  if (!env?.DB || !dest) return null;

  const cached = await readCache(env, dest, { now });
  if (cached) return cached.events.length ? cached : null;

  try {
    const tm = await import('./events.tm.mjs');
    if (!tm.eventsReady(env)) return null;

    const out = await tm.search(
      env,
      { lat, lng, country, days, size: 8 },
      fetchImpl ?? fetch,
    );
    if (!out?.ok) {
      // A miss is cached too, briefly. Otherwise a destination outside
      // Ticketmaster's coverage re-queries on every single ask, forever.
      await writeCache(env, dest, 'ticketmaster', [], { now });
      return null;
    }
    const events = (out.events ?? []).filter((e) => e?.name);
    await writeCache(env, dest, 'ticketmaster', events, { now });
    return events.length ? { events, source: 'ticketmaster', cached: false } : null;
  } catch {
    return null;
  }
}

/**
 * The block the model sees.
 *
 * Separate from LIVE CITY EVENTS on purpose, with the provenance stated in the
 * block itself rather than left to the model to remember. Two different levels
 * of confidence must not share one heading.
 */
export function formatSearchedEvents(found) {
  if (!found?.events?.length) return '';
  const label = found.source === 'ticketmaster' ? 'Ticketmaster' : found.source;
  const lines = found.events.slice(0, 8).map((e) => {
    const bits = [
      e.name,
      e.date ? `on ${e.date}${e.time ? ` at ${e.time}` : ''}` : null,
      e.venue ? `at ${e.venue}` : null,
      e.genre || null,
      e.from != null && e.currency ? `from ${e.from} ${e.currency}` : null,
    ].filter(Boolean);
    return `- ${bits.join(' · ')}`;
  });
  return [
    `EVENTS FOUND BY SEARCH (source: ${label} — NOT verified by Num)`,
    ...lines,
    'RULE: these come from a live third-party listing, not from Num\'s own verified data.',
    'Say where they came from and suggest the guest confirms the date and price before travelling to one.',
    'Never state one of these as though Num had checked it. If none of them fit, say so plainly.',
  ].join('\n');
}
