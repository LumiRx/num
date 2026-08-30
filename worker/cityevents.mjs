/**
 * cityevents.mjs — what is actually ON in a city, right now.
 *
 * WHY THIS EXISTS
 * Num answers "where should we eat" well and "what's on tonight" badly. Real
 * asks in num_asks that Num answered with restaurants when the guest wanted an
 * event: "what to do in bangkok", "where can we watch the football tonight?",
 * "plan saturday with 6 friends", and the clearest one —
 * "what can i do for fun within walking distance of sawasdee village phuket at
 * my current time". This module is the fix.
 *
 * WHY IT IS NOT `events.mjs`
 * worker/events.mjs is MEMBER-HOSTED events — a guest throws a dinner, invites
 * people, tracks RSVPs (num_events + num_event_guests). That is a different
 * product. Reusing it would have been the same silent collision that nearly
 * happened with num_hosts. City events are things the WORLD is putting on.
 *
 * ── THE RULES, WHICH ARE THE WHOLE POINT ────────────────────────────────
 * 1. NEVER serve a stale event. `expires_at` is a hard stop and the query
 *    filters on it. Sending a guest to something that finished last week burns
 *    the trust the verified-place data earned, and it is unrecoverable.
 * 2. NEVER serve an event for a city we have no place data for. `dest` must be
 *    a real destinations.slug — otherwise there are no partners to ground it
 *    against and no way to book anything around it. Seeded rows for Mexico City
 *    were deleted for exactly this reason: good events, no coverage.
 * 3. The model may only state what is in this block, verbatim. Same discipline
 *    as LIVE SHOWTIMES in prompt.mjs — an invented festival date is worse than
 *    an invented showtime, because people book flights around festivals.
 */

/** Words that mean "tell me what is happening", in the languages Num answers in. */
const EVENT_INTENT = new RegExp(
  [
    "what'?s on", 'whats on', 'what is on',
    'what to do', 'things to do', 'anything to do', 'what can i do', 'what can we do',
    'anything happening', 'anything on\\b', 'going on',
    'events?\\b', 'festival', 'concert', 'exhibition', 'gig\\b', 'show tonight',
    // article optional — the real ask in num_asks was "plan saturday with 6
    // friends", with no "my". Requiring the article missed it.
    'plan (my |our |the )?(saturday|sunday|friday|weekend|night|evening|day)',
    // "where can we watch the football tonight?" is an events question, and it
    // was the second real one this regex missed on the first pass.
    'watch the (football|game|match|fight|rugby|cricket|f1|boxing)', 'where to watch',
    'for fun', 'bored',
    // non-English, kept short and unambiguous
    'que hacer', 'qué hacer', 'quoi faire', 'was ist los', 'cosa fare',
    'ที่เที่ยว', 'มีอะไร',
  ].join('|'),
  'i',
);

/** Does this message want events rather than a table? */
export function wantsEvents(text = '') {
  return EVENT_INTENT.test(String(text));
}

/**
 * Live events for a destination.
 *
 * `limit` is small on purpose. Six recommendations is a list; three is a
 * concierge. Ordered by uniqueness first because the entire value of this over
 * a search engine is surfacing the thing a guidebook would not.
 */
export async function cityEventsFor(env, slug, { limit = 4, today = null } = {}) {
  if (!env?.DB || !slug) return [];
  const day = today || new Date().toISOString().slice(0, 10);
  try {
    const { results } = await env.DB.prepare(
      `SELECT title, venue, area, starts_on, ends_on, price_note, why, send_copy,
              date_confidence, unique_score
         FROM num_city_events
        WHERE dest = ?1
          AND state = 'live'
          -- the hard stop. an event past its expiry is never served, ever.
          AND expires_at > ?2
          -- and never one that has not started; "on now or soon", not "was on".
          AND COALESCE(ends_on, starts_on) >= ?2
        ORDER BY
          -- on right now beats starting later, whatever its score
          CASE WHEN starts_on <= ?2 THEN 0 ELSE 1 END,
          unique_score DESC,
          starts_on ASC
        LIMIT ?3`,
    )
      .bind(slug, day, limit)
      .all();
    return results ?? [];
  } catch (err) {
    // Same contract as the rest of grounding: an enhancement, never a
    // dependency. A D1 hiccup must not take the concierge down.
    console.warn('[cityevents]', err?.message ?? err);
    return [];
  }
}

/** One line per event, in the shape the model is told it may quote. */
export function formatEvents(rows = [], today = null) {
  if (!rows.length) return null;
  const day = today || new Date().toISOString().slice(0, 10);
  return rows
    .map((e) => {
      const on = e.starts_on <= day && (e.ends_on || e.starts_on) >= day;
      const when = e.ends_on && e.ends_on !== e.starts_on
        ? `${on ? 'ON NOW, ' : ''}${e.starts_on} to ${e.ends_on}`
        : `${e.starts_on}${on ? ' (today)' : ''}`;
      // A disputed date is carried through to the model rather than smoothed
      // over. Por Tor's end date differs between two sources; the model needs
      // to know that so it says "running now" instead of naming a wrong day.
      const caveat = e.date_confidence === 'disputed'
        ? ' [END DATE DISPUTED BETWEEN SOURCES — say it is running now, do not state an end date]'
        : e.date_confidence === 'approx'
          ? ' [DATE FROM A SECONDARY SOURCE — offer to confirm before they commit]'
          : '';
      return (
        `- ${e.title} — ${when}${e.venue ? `, ${e.venue}` : ''}${e.area ? `, ${e.area}` : ''}` +
        `${e.price_note ? `, ${e.price_note}` : ''}${caveat}\n` +
        `  why: ${e.why}${e.send_copy ? `\n  how to put it: ${e.send_copy}` : ''}`
      );
    })
    .join('\n');
}
