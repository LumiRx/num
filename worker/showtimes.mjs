// Live movie showtimes for /api/num — the data Google shows for free, fetched
// through a SERP API that licenses exactly that result (SerpAPI's structured
// showtimes feed). We do NOT scrape Google directly: viewable-for-free and
// scrapeable-without-terms are different things, and this company's whole
// pitch is provable legitimacy (see docs/cto-handoff-duke.md §8).
//
// Dark until configured. `wrangler secret put SERPAPI_KEY` on num-app is the
// only switch — no key, no fetch, and the concierge keeps its honest
// "showtimes aren't wired up yet" line. SerpAPI's free tier is 100 searches a
// month; with the day-cache below one search covers a whole city for a day,
// so the pilot fits inside free.
//
// Cache: one row per (city, day), 6h TTL, in num-db. Showtimes change daily;
// re-fetching per user message would be pure waste.

const TTL_MS = 6 * 60 * 60 * 1000;

/**
 * @returns {Promise<string|null>} a compact text block ready for the prompt,
 * or null when unconfigured / nothing found — the caller treats null as
 * "feature not present" and the model falls back to the honest no-times flow.
 */
export async function showtimesFor(env, cityLabel) {
  if (!env?.SERPAPI_KEY || !env?.DB || !cityLabel) return null;
  const day = new Date().toISOString().slice(0, 10);
  const key = `st|${String(cityLabel).toLowerCase().slice(0, 60)}|${day}`;

  try {
    const hit = await env.DB.prepare(
      'SELECT payload, fetched_at FROM showtimes_cache WHERE key=?1',
    ).bind(key).first();
    if (hit && Date.now() - Date.parse(hit.fetched_at + 'Z') < TTL_MS) return hit.payload || null;
  } catch { /* cache miss path below */ }

  try {
    const u = new URL('https://serpapi.com/search.json');
    // The place goes in q only. SerpAPI's `location` param requires a name
    // from their canonical list and 400s on anything else — "Downtown" from
    // our area labels killed every request, silently, on day one.
    u.searchParams.set('q', `movie showtimes near ${cityLabel}`);
    u.searchParams.set('api_key', env.SERPAPI_KEY);
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      // A non-ok here is config or quota, and silence cost an hour of
      // debugging already — say what happened.
      console.warn('[showtimes] http', r.status, (await r.text()).slice(0, 160));
      return null;
    }
    const d = await r.json();
    const block = formatShowtimes(d?.showtimes);
    if (!block) {
      // Schema recon, not noise: SerpAPI's showtimes live under different keys
      // for different query shapes, and we can't see the payload any other way
      // (the API key is a secret, rightly). Top-level keys only — no content.
      console.warn('[showtimes] no showtimes for', cityLabel, '| keys:', Object.keys(d).join(','));
    }
    if (block) {
      await env.DB.prepare(
        `INSERT INTO showtimes_cache (key, payload, fetched_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET payload=?2, fetched_at=datetime('now')`,
      ).bind(key, block).run().catch(() => {});
    }
    return block;
  } catch (err) {
    console.warn('[showtimes]', err?.message ?? err);
    return null;
  }
}

/**
 * SerpAPI's showtimes schema has shifted before, so this parses defensively:
 * walk whatever arrays exist, keep theater names, film names and time strings,
 * drop anything that doesn't look like one. The model gets clean lines and
 * does the talking; a schema drift degrades to null, never to garbage times.
 */
export function formatShowtimes(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const today = raw[0];
  const theaters = today?.theaters ?? today?.cinemas ?? [];
  const lines = [];
  for (const t of theaters.slice(0, 5)) {
    const name = t?.name;
    if (!name) continue;
    const films = [];
    for (const s of (t.showing ?? t.movies ?? []).slice(0, 6)) {
      const film = s?.name ?? s?.title;
      const times = (Array.isArray(s?.time) ? s.time : Array.isArray(s?.times) ? s.times : [])
        .filter((x) => /^[0-9]{1,2}[:.][0-9]{2}/.test(String(x))).slice(0, 8);
      if (film && times.length) films.push(`${film}: ${times.join(', ')}`);
    }
    if (films.length) lines.push(`- ${name}${t.address ? ` (${t.address})` : ''}\n  ${films.join('\n  ')}`);
  }
  return lines.length ? lines.join('\n') : null;
}
