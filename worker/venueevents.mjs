/**
 * Parties coming to a business — the venue's view of num_events.
 *
 * num_events.business_id has existed since 31 Jul 2026 and nothing wrote to
 * it until 4 Sep (events.mjs now resolves it from the place). This is the
 * reader: the business console lists what is coming, with the guest count,
 * so a venue is not surprised by twelve people at eight.
 *
 * Read-only, upcoming only, no guest names — the guest list is the host's.
 */
export async function upcomingEvents(env, { businessId, days = 60, limit = 20 } = {}) {
  if (!env?.DB || !businessId) return [];
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.title, e.day, e.time, e.place, e.capacity, e.state,
            (SELECT COUNT(*) FROM num_event_guests g WHERE g.event_id = e.id) AS invited,
            (SELECT COUNT(*) FROM num_event_guests g WHERE g.event_id = e.id AND g.rsvp = 'yes') AS yes,
            (SELECT COALESCE(SUM(g.plus_ones), 0) FROM num_event_guests g WHERE g.event_id = e.id AND g.rsvp = 'yes') AS plus_ones,
            m.name AS host_name
       FROM num_events e LEFT JOIN num_members m ON m.id = e.host_id
      WHERE e.business_id = ?1 AND e.state <> 'cancelled'
        AND (e.day IS NULL OR e.day >= date('now', '-1 day')) AND (e.day IS NULL OR e.day <= date('now', ?2))
      ORDER BY e.day IS NULL, e.day, e.time LIMIT ?3`,
  ).bind(String(businessId), `+${Math.max(1, Math.min(days, 365))} days`, Math.max(1, Math.min(limit, 100))).all().catch(() => ({ results: [] }));
  return (results ?? []).map((e) => ({
    id: e.id, title: e.title, day: e.day, time: e.time, place: e.place,
    host: e.host_name ?? null,
    invited: Number(e.invited ?? 0), yes: Number(e.yes ?? 0),
    // What the kitchen plans for: confirmed guests plus their plus-ones, and
    // the host. Never the invited count — that is a hope, not a headcount.
    expected: Number(e.yes ?? 0) + Number(e.plus_ones ?? 0) + 1,
    capacity: e.capacity ?? null,
  }));
}
