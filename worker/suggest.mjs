/**
 * What Num should offer to do next, built from what Num can actually do HERE.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * The starter strip used to be ten hard-coded prompts, identical in every
 * city. "Check crypto" and "Club table" shipped to a guest in a town with no
 * nightlife and no exchange; "Order food" shipped to a destination with no
 * delivery partner. A suggestion that cannot be fulfilled is worse than no
 * suggestion — it is a promise the next screen breaks, and it is the first
 * thing a new guest taps.
 *
 * Everything below is derived from rows: a category is only offered where the
 * directory actually holds enough verified places to answer it, and the
 * showcase line only claims a capability the destination can serve. The list
 * is therefore self-populating — a new city with 200 cafés starts offering
 * coffee the moment the rows land, with no deploy and no copywriting.
 *
 * ── WHY IT COSTS NO TOKENS ───────────────────────────────────────────────
 *
 * No model is consulted. This is two indexed reads and a template, cached in
 * D1 per destination, because a suggestion strip that costs a generation on
 * every app open would burn more than the answers it invites.
 */

/**
 * Category prefix → the ask a guest would actually type.
 *
 * Matched as a PREFIX against `places.category`, because the directory splits
 * finely ("Shopping · jewellery", "Japanese Restaurant", "Attraction · church")
 * and the guest does not. One entry per thing a traveller wants, ordered by
 * how often it is the reason someone opens a concierge at all.
 */
const CATEGORY_STARTERS = [
  { match: /^(restaurant|street food|japanese|chinese|thai|indian|italian|seafood)/i, emoji: '🍽️', label: 'Dinner tonight', prompt: 'Where should we eat tonight?', min: 8 },
  { match: /^caf[eé]/i, emoji: '☕', label: 'Good coffee', prompt: 'Where is the best coffee near me?', min: 5 },
  { match: /^(beauty & spa|massage & spa|spa)/i, emoji: '💆', label: 'Massage & spa', prompt: 'Where should I go for a massage?', min: 5 },
  { match: /^bar/i, emoji: '🍸', label: 'Drinks tonight', prompt: 'Where should we go for drinks tonight?', min: 5 },
  { match: /^attraction/i, emoji: '📍', label: 'Things to do', prompt: 'What should we do here today?', min: 5 },
  { match: /^(tours & travel|tour)/i, emoji: '🗺️', label: 'Day trips', prompt: 'What day trips are worth doing from here?', min: 3 },
  { match: /^hotel/i, emoji: '🛏️', label: 'Where to stay', prompt: 'Which area is best to stay in here?', min: 8 },
  { match: /^(bakery|dessert)/i, emoji: '🥐', label: 'Something sweet', prompt: 'Where do I find the best pastries or dessert nearby?', min: 4 },
  { match: /^(shopping|souvenirs)/i, emoji: '🛍️', label: 'Shopping', prompt: 'Where should I shop around here?', min: 8 },
  { match: /^(gym & fitness|gym)/i, emoji: '🏋️', label: 'Gym nearby', prompt: 'Is there a good gym near me?', min: 3 },
  { match: /^(pharmacy|hospital|clinic|dentist)/i, emoji: '🩺', label: 'Pharmacy / clinic', prompt: 'Where is the nearest pharmacy?', min: 2 },
  { match: /^gallery/i, emoji: '🎨', label: 'Art & galleries', prompt: 'Any galleries worth seeing here?', min: 3 },
];

/**
 * Capabilities Num has everywhere, independent of the local directory.
 *
 * Kept SEPARATE from the category list on purpose: these are true because of
 * how the product is wired, not because of what rows exist in this city, so
 * they must not be filtered by a place count that has nothing to do with them.
 */
const UNIVERSAL_STARTERS = [
  { emoji: '🚗', label: 'Car to the airport', prompt: 'Get me a car to the airport tomorrow morning' },
  { emoji: '✈️', label: 'Find a flight', prompt: 'What flights are there to Bangkok on Friday?' },
  { emoji: '🧳', label: 'Plan with friends', prompt: 'Start a group plan I can build with my friends' },
  { emoji: '💌', label: 'Invite a friend', prompt: 'Send an invite to a friend so we can plan together' },
];

/**
 * The rotating showcase line — one at a time, so the guest keeps discovering
 * something new instead of reading the same ten chips forever.
 *
 * Each carries the capability it depends on. A line is only ever shown when
 * the destination can actually serve it, which is the difference between a
 * demo and a lie.
 */
const SHOWCASE = [
  { needs: 'food', text: 'Ask me to find dinner for six, tonight, walkable.' },
  { needs: 'food', text: 'Tell me what you feel like eating and I will pick the place.' },
  { needs: 'spa', text: 'Ask me for a massage in the next two hours.' },
  { needs: 'bar', text: 'Ask me where the locals actually drink.' },
  { needs: 'attraction', text: 'Ask me what is worth seeing if you only have one day.' },
  { needs: 'cafe', text: 'Ask me for a quiet café with good wifi to work from.' },
  { needs: null, text: 'Ask me to get you to the airport and I will sort the car.' },
  { needs: null, text: 'Ask me anything in your own language — I answer in it.' },
  { needs: null, text: 'Tell me your budget and I will stay inside it.' },
  { needs: null, text: 'Start a plan and invite your friends — everyone sees one thread.' },
  { needs: 'tours', text: 'Ask me which day trip is worth the early start.' },
  { needs: null, text: 'Tell me once that you are pescatarian; I will remember it.' },
];

/** Which showcase capability a category satisfies. */
const CAPABILITY = [
  [/^(restaurant|street food|japanese|chinese|thai|indian|italian|seafood)/i, 'food'],
  [/^caf[eé]/i, 'cafe'],
  [/^(beauty & spa|massage & spa|spa)/i, 'spa'],
  [/^bar/i, 'bar'],
  [/^attraction/i, 'attraction'],
  [/^(tours & travel|tour)/i, 'tours'],
];

/**
 * A stable-per-window index, so the showcase line rotates on its own without
 * any stored cursor and without changing under the guest mid-read.
 */
export function rotationIndex(now = Date.now(), windowMs = 90_000) {
  return Math.floor(now / windowMs);
}

/**
 * Turn whatever the client knows about where the guest is into a dest slug.
 *
 * The app holds a DISPLAY name ("Phuket", "Kata, Phuket") — it has never had
 * the slug. Resolving on the client was the original shape of this and it
 * silently produced `undefined` on every call, which would have looked exactly
 * like a working feature that always served the generic fallback. Resolve it
 * here, where the destinations table is.
 */
export async function resolveDest(env, raw) {
  const q = String(raw ?? '').trim();
  if (!env?.DB || !q) return null;
  // An exact slug is the cheap, common case once the client caches one.
  try {
    const bySlug = await env.DB.prepare(
      'SELECT slug FROM destinations WHERE slug = ?1 LIMIT 1',
    ).bind(q.toLowerCase()).first();
    if (bySlug?.slug) return String(bySlug.slug);

    // "Kata, Phuket" — the city is the part after the last comma, and the
    // whole string is tried first so "Chiang Mai" is not read as "Mai".
    const candidates = [q, ...q.split(',').map((p) => p.trim()).reverse()]
      .filter(Boolean)
      .slice(0, 4);
    for (const c of candidates) {
      const row = await env.DB.prepare(
        'SELECT slug FROM destinations WHERE lower(name) = lower(?1) LIMIT 1',
      ).bind(c).first();
      if (row?.slug) return String(row.slug);
    }
  } catch {
    return null;
  }
  return null;
}

/** Read what this destination can actually answer. Never throws. */
export async function categoriesFor(env, dest) {
  if (!env?.DB || !dest) return [];
  try {
    const res = await env.DB.prepare(
      `SELECT category, COUNT(*) AS n
         FROM places
        WHERE dest = ?1 AND category IS NOT NULL
          AND (alive IS NULL OR alive = 1)
        GROUP BY category`,
    ).bind(String(dest).slice(0, 60)).all();
    return (res?.results ?? []).map((r) => ({ category: String(r.category ?? ''), n: Number(r.n ?? 0) }));
  } catch {
    return [];
  }
}

/**
 * Build the strip.
 *
 * `dest` unknown, or a destination with nothing in it, still returns the
 * universal capabilities — an empty strip would teach a new guest that Num
 * does nothing, which is the opposite of what this is for.
 */
export function buildSuggestions(categoryRows, { now = Date.now(), max = 8 } = {}) {
  const rows = Array.isArray(categoryRows) ? categoryRows : [];
  const total = (re) => rows.filter((r) => re.test(r.category)).reduce((a, r) => a + r.n, 0);

  const local = CATEGORY_STARTERS
    .map((s) => ({ ...s, count: total(s.match) }))
    .filter((s) => s.count >= s.min)
    // Most-covered first: the thing this town has most of is the thing we are
    // most likely to answer well.
    .sort((a, b) => b.count - a.count)
    .map(({ emoji, label, prompt }) => ({ emoji, label, prompt }));

  const capabilities = new Set(
    CAPABILITY.filter(([re]) => total(re) >= 5).map(([, cap]) => cap),
  );

  // Local first — a guest standing in a town wants the town, not the feature
  // list — then the universal capabilities to fill the strip.
  const starters = [...local, ...UNIVERSAL_STARTERS].slice(0, max);

  const eligible = SHOWCASE.filter((s) => s.needs === null || capabilities.has(s.needs));
  const pool = eligible.length ? eligible : SHOWCASE.filter((s) => s.needs === null);
  const rotating = pool[rotationIndex(now) % pool.length] ?? null;

  return {
    starters,
    rotating: rotating ? rotating.text : null,
    // Named so the client (and a future us) can tell a real local strip from
    // the universal fallback without guessing from its contents.
    grounded: local.length > 0,
  };
}

/** The endpoint body. One D1 read, no model call. */
export async function handleSuggest(request, env) {
  const url = new URL(request.url);
  const asked = url.searchParams.get('dest') ?? url.searchParams.get('place') ?? '';
  const dest = await resolveDest(env, asked);
  const rows = dest ? await categoriesFor(env, dest) : [];
  const body = buildSuggestions(rows);
  return new Response(JSON.stringify({ ...body, dest }), {
    headers: {
      'Content-Type': 'application/json',
      // Short and public: the answer is identical for everyone in a city, and
      // the rotation window is 90s anyway.
      'Cache-Control': 'public, max-age=60',
    },
  });
}
