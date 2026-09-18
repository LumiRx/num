/**
 * Search and Suggest — "what should we do?", answered for a group.
 *
 * ── THE TWO ASKS THIS SERVES (16 Sep 2026) ──────────────────────────────
 *
 *   1. SEARCH. One box, plain words. "sunset boat", "cooking class
 *      saturday", "something Ari hasn't done". The answer comes from four
 *      sources at once, each labelled, never merged: NUM-checked places
 *      (`places`), real ticketed events (events.tm via eventsearch), bookable
 *      experiences (viator.search) and the crew's own plan history
 *      (num_plan_items). A guest who can see where a row came from can trust
 *      the rows that say "checked".
 *
 *   2. SUGGEST. "I don't know what to do." Deal three things NONE of the
 *      group has tried, with the reason in plain words. Novelty is computed
 *      from rows, not guessed: a title that already sits in any of the crew's
 *      plans is "tried"; a member fact `dislike:<slug>` is "never again".
 *
 * ── RULES, SAME AS EVERY OTHER RAIL ─────────────────────────────────────
 *
 *   · No model call. This is fan-out, filter, rank, template. A suggestion
 *     strip that costs a generation per open burns more than it earns
 *     (see suggest.mjs for the same lesson).
 *   · Every provider is wrapped in a timeout and Promise.allSettled. A slow
 *     Viator must never cost the places result.
 *   · Prices, ratings, dates are the provider's, passed through as data.
 *   · Nothing is ever called "booked" here. Search finds; the booking rails
 *     book.
 *
 * Route: GET /api/discover?mode=search|surprise&q=…&place=Kata, Phuket (or dest=slug)
 *        [&country=…&lat=…&lng=…]&me=…&plan_id=…&mood=water|food|night|sweat|culture
 */

import { search as viatorSearch, viatorReady } from './viator.mjs';
import { searchEvents } from './eventsearch.mjs';
import { loadFacts, saveFacts } from './memory.mjs';
import { resolveDest } from './suggest.mjs';
import { cityEventsFor } from './cityevents.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** Mood chips → Viator tag ids (numeric, a mesh: one product can carry several). */
export const MOOD_TAGS = Object.freeze({
  water: [21701, 21913],        // Cruises & Sailing · Tours, Sightseeing & Cruises
  food: [21567, 11965, 13121],  // Food & Drink · Dinner Cruises · Afternoon Tea
  night: [21765, 11965],        // Shows · Dinner Cruises
  sweat: [22046, 13018],        // Adventure Tours · Bike Tours
  culture: [21765, 21913],      // Shows · Sightseeing
});

/**
 * Mood chips → our own place categories. Matched as lower-case prefixes with
 * LIKE, because the directory says "thai restaurant", "attraction · temple"
 * and "massage & spa", and nobody wants to maintain an exact list of those.
 * Vocabulary checked against num-db on 16 Sep 2026 (Phuket: restaurant 5,115,
 * café 2,200, bar 1,222, diving 102, sports activity 103, nightlife 136).
 */
export const MOOD_CATEGORIES = Object.freeze({
  water: ['diving', 'tours & travel', 'beach', 'boat', 'marina', 'water'],
  food: ['street food', 'market', 'seafood', 'dessert', 'bakery', 'noodles', 'thai restaurant'],
  night: ['bar', 'nightlife', 'flea market', 'night market', 'live music'],
  sweat: ['gym & fitness', 'sports activity', 'muay thai', 'yoga', 'climbing', 'diving'],
  culture: ['attraction · temple', 'attraction · place of worship', 'museum', 'gallery', 'theatre', 'attraction'],
});

/** Lowercased, accent-stripped, punctuation-free key used for "have we done this?" */
export const slug = (s) =>
  String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Two titles count as the same thing when one contains the other's first four words. */
export function sameThing(a, b) {
  const x = slug(a), y = slug(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const head = (s) => s.split(' ').slice(0, 4).join(' ');
  return x.includes(head(y)) || y.includes(head(x));
}

const withTimeout = (p, ms, fallback) =>
  Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))])
    // A thrown error is not a timeout; say which it was, so ?debug=1 can tell
    // an expired key from a slow network.
    .catch((e) => (fallback && typeof fallback === 'object' ? { ...fallback, reason: `error: ${String(e?.message ?? e).slice(0, 80)}` } : fallback));

/** A ~5 km cell (two decimals of a degree), the unit a "near me" lookup is shared at. */
export const cell = (lat, lng) => `${(Math.round(lat * 50) / 50).toFixed(2)}_${(Math.round(lng * 50) / 50).toFixed(2)}`;

export function haversineKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v == null || Number.isNaN(Number(v)))) return null;
  const R = 6371, toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

/* ── Sources ───────────────────────────────────────────────────────────── */

/** NUM-checked places, by free text or by mood category. */
export async function placesFor(env, { dest, q, mood, lat, lng, limit = 8 }) {
  if (!env?.DB || !dest) return [];
  const cats = mood ? MOOD_CATEGORIES[mood] ?? [] : [];
  const like = q ? `%${slug(q).split(' ').filter((w) => w.length > 2)[0] ?? ''}%` : null;
  try {
    let sql = `SELECT id, name, category, area, lat, lng, rating, reviews, photo_url
                 FROM places WHERE dest = ?1 AND (alive IS NULL OR alive = 1)`;
    const binds = [String(dest).slice(0, 60)];
    if (cats.length) { sql += ` AND (${cats.map((_, i) => `lower(category) LIKE ?${i + 2}`).join(' OR ')})`; binds.push(...cats.map((c) => `${c}%`)); }
    else if (like && like !== '%%') { sql += ' AND (lower(name) LIKE ?2 OR lower(category) LIKE ?2)'; binds.push(like); }
    sql += ' ORDER BY rating DESC NULLS LAST LIMIT ?' + (binds.length + 1);
    binds.push(limit);
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return (results ?? []).map((r) => ({
      source: 'num', id: `pl_${r.id}`, title: r.name, sub: [r.category ? String(r.category).replace(/ location$/i, '') : null, r.area].filter(Boolean).join(' · '),
      image: r.photo_url ?? null, rating: r.rating ?? null, reviews: r.reviews ?? null, price: null, currency: null, url: null,
      lat: r.lat ?? null, lng: r.lng ?? null, distance_km: haversineKm(lat, lng, r.lat, r.lng),
      label: 'Checked by NUM',
    }));
  } catch { return []; }
}

/** Real ticketed events near the coordinate (Ticketmaster where it actually has inventory). */
export async function eventsFor(env, { dest, lat, lng, country, fetchImpl, near = false }) {
  // With the person's own position, search a tight ring around THEM rather
  // than the city's centre, cached per ~5 km cell so neighbours share a
  // lookup. "Near me" is the whole point of Tonight: a listing across town
  // is not tonight, it is a plan.
  const mine = near && Number.isFinite(lat) && Number.isFinite(lng);
  const key = mine ? `near_${cell(lat, lng)}` : dest;
  const found = await withTimeout(
    searchEvents(env, { dest: key, lat, lng, country, days: mine ? 3 : 7, radiusMiles: mine ? 10 : 25, size: mine ? 14 : 8, fetchImpl }),
    4000, { reason: 'timeout' },
  );
  const list = found?.events ?? found?.result?.events ?? [];
  const out = list.map((e) => {
    // Distance only from the person's own fix — from a city centroid it would
    // read as a fact about them and be wrong by the width of the city.
    const km = mine && e.lat != null && e.lng != null ? haversineKm(lat, lng, e.lat, e.lng) : null;
    return {
      source: 'ticketmaster', id: `tm_${e.id}`, title: e.name, sub: [e.venue, e.date, e.time].filter(Boolean).join(' · '),
      image: e.image ?? null, rating: null, price: e.from ?? null, currency: e.currency ?? null, url: e.url ?? null,
      starts_on: e.date ?? null, starts_at: e.date && e.time ? `${e.date}T${e.time}` : null, venue: e.venue ?? null,
      lat: e.lat ?? null, lng: e.lng ?? null, distance_km: km == null ? null : Math.round(km * 10) / 10, label: 'Listed on Ticketmaster',
      // The genre travels so NIGHTLIFE can keep the club nights and leave the matinees.
      genre: e.genre ?? null,
    };
  });
  return Object.assign(out, { reason: found?.reason ?? (list.length ? 'ok' : 'empty') });
}

/** Bookable experiences (Viator Basic Access: search + attributed link, never "booked"). */
export async function experiencesFor(env, { dest, country, lat, lng, mood, currency = 'USD', fetchImpl }) {
  if (!viatorReady(env)) return Object.assign([], { reason: 'not_connected' });
  const tags = mood ? MOOD_TAGS[mood] ?? null : null;
  const r = await withTimeout(viatorSearch(env, { name: dest, country, lat, lng, currency, count: 12, tags }, fetchImpl), 8000, { ok: false, reason: 'timeout' });
  if (!r?.ok) return Object.assign([], { reason: r?.reason ?? 'unknown' });
  return r.products.map((p) => ({
    source: 'viator', id: `vi_${p.code}`, title: p.title, sub: [p.duration, p.reviews ? `${p.reviews} reviews` : null].filter(Boolean).join(' · '),
    image: p.image ?? null, rating: p.rating ?? null, reviews: p.reviews ?? null, price: p.from ?? null, currency: p.currency ?? null, url: p.url,
    lat: null, lng: null, distance_km: null, label: 'Bookable on Viator',
  }));
}

/**
 * What the crew has already done, saved, or refused.
 * Plans the member belongs to → every item title in those plans, with who put it there.
 * Member facts `dislike:<slug>` → never suggest again (the server-side twin of the 👎 reaction).
 */
export async function crewHistory(env, { me, planId }) {
  const out = { items: [], dislikes: new Set(), members: [] };
  if (!env?.DB || !me) return out;
  try {
    const plans = planId
      ? [{ plan_id: planId }]
      : (await env.DB.prepare('SELECT plan_id FROM num_plan_members WHERE member_id = ?1').bind(me).all()).results ?? [];
    const ids = plans.map((p) => p.plan_id).slice(0, 10);
    if (ids.length) {
      const ph = ids.map((_, i) => `?${i + 1}`).join(',');
      const { results: items } = await env.DB.prepare(
        `SELECT title, status, by_name, by_id, plan_id FROM num_plan_items WHERE plan_id IN (${ph}) ORDER BY created_at DESC LIMIT 200`,
      ).bind(...ids).all();
      out.items = items ?? [];
      const { results: members } = await env.DB.prepare(
        `SELECT DISTINCT member_id, name FROM num_plan_members WHERE plan_id IN (${ph})`,
      ).bind(...ids).all();
      out.members = (members ?? []).filter((m) => m.member_id !== me);
    }
    const facts = await loadFacts(env, me);
    for (const k of Object.keys(facts ?? {})) if (k.startsWith('dislike:')) out.dislikes.add(k.slice('dislike:'.length));
  } catch { /* history is a bonus, never a blocker */ }
  return out;
}

/* ── Ranking ───────────────────────────────────────────────────────────── */

/**
 * Stamp each candidate with what the crew has done with it, and drop what
 * must not come back. Returns the survivors with `novelty` and `reason`.
 */
export function annotate(candidates, history, { me } = {}) {
  const tried = history.items ?? [];
  const names = (history.members ?? []).map((m) => m.name).filter(Boolean);
  return candidates
    .filter((c) => c.title && !history.dislikes?.has(slug(c.title)))
    .map((c) => {
      const hits = tried.filter((t) => sameThing(t.title, c.title));
      const youDid = hits.some((h) => h.by_id === me);
      const whoDid = [...new Set(hits.map((h) => h.by_name).filter(Boolean))];
      const neverTried = hits.length === 0;
      const reason = neverTried
        ? names.length ? `None of you has done this. ${names.slice(0, 2).join(' and ')} included.` : 'You have not done this yet.'
        : youDid ? 'You have done this before.' : `${whoDid.join(', ')} did this already.`;
      return { ...c, novelty: { never_tried: neverTried, you: !youDid, done_by: whoDid }, reason };
    });
}

/**
 * Never-tried first. Then the concierge's own order: the best-regarded thing,
 * where "regarded" is the rating weighted by how many people gave it — a 5.0
 * from 3 reviews must not beat a 4.8 from 2,100. Then closer, then cheaper.
 * Leading with price would make this a comparison site (viator.mjs says the
 * same about its own sort).
 */
export const regard = (i) => (i.rating == null ? 0 : Number(i.rating) * (1 + Math.log10((i.reviews ?? 0) + 1)));
export function rank(items) {
  const price = (i) => (i.price == null ? 1e9 : Number(i.price));
  return [...items].sort((a, b) =>
    Number(b.novelty?.never_tried) - Number(a.novelty?.never_tried)
    || regard(b) - regard(a)
    || (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9)
    || price(a) - price(b));
}

/** Three cards, one per source where possible, so a deal is never three boat trips. */
export function dealThree(ranked) {
  const out = [], seen = new Set();
  for (const i of ranked) { if (!seen.has(i.source) && i.novelty?.never_tried) { out.push(i); seen.add(i.source); } if (out.length === 3) return out; }
  for (const i of ranked) { if (!out.includes(i) && i.novelty?.never_tried) out.push(i); if (out.length === 3) return out; }
  for (const i of ranked) { if (!out.includes(i)) out.push(i); if (out.length === 3) break; }
  return out;
}

/** The closest live destination to a coordinate, or null past 150 km. */
export async function nearestDest(env, lat, lng) {
  if (!env?.DB || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  try {
    const { results } = await env.DB.prepare('SELECT slug, country, lat, lng FROM destinations WHERE lat IS NOT NULL AND lng IS NOT NULL').all();
    let best = null;
    for (const r of results ?? []) {
      const km = haversineKm(lat, lng, r.lat, r.lng);
      if (km != null && km <= 150 && (!best || km < best.km)) best = { ...r, km };
    }
    return best;
  } catch { return null; }
}

/* ── Route ─────────────────────────────────────────────────────────────── */

/**
 * What "tonight" means, decided in one place. `day` is the phone's own date
 * (the worker's clock is UTC; Bangkok is already tomorrow at 17:00 UTC).
 *
 * - Nothing that has finished. A curated row counts while it is running
 *   (an exhibition that opened in August is still "on now" if it ends after
 *   today); a ticketed row counts from today.
 * - Today first; tomorrow only fills the gaps, so the strip never opens with
 *   next week. Curated rows may look two days ahead — they are rare and worth
 *   a day's notice.
 * - One card per title: Ticketmaster lists a museum's every timed slot as an
 *   event, and six copies of the same exhibition is not a night out.
 */
export function tonightPick(curated, tm, day = null, { limit = 6 } = {}) {
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(day ?? '')) ? day : new Date().toISOString().slice(0, 10);
  const plus = (n) => new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);
  const tomorrow = plus(1), soon = plus(2);
  const live = [
    ...curated.filter((r) => r.starts_on && r.starts_on <= soon && (r.ends_on ?? r.starts_on) >= today),
    ...tm.filter((r) => r.starts_on && r.starts_on >= today && r.starts_on <= tomorrow),
  ];
  const seen = new Set();
  const uniq = live.filter((r) => { const k = slug(r.title); if (seen.has(k)) return false; seen.add(k); return true; });
  const onDay = (r) => ((r.starts_on <= today && (r.ends_on ?? r.starts_on) >= today) ? 0 : r.starts_on === tomorrow ? 1 : 2);
  // Today first; within a day, nearer first when distance is known; then by start.
  const far = (r) => (r.distance_km == null ? 999 : r.distance_km);
  return uniq
    .sort((a, b) => onDay(a) - onDay(b) || far(a) - far(b) || String(a.starts_at ?? a.starts_on).localeCompare(String(b.starts_at ?? b.starts_on)))
    .slice(0, limit);
}

export async function handleDiscover(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  // 👎 from a Suggest card. Stored as a member fact so the same rule that
  // keeps a disliked place out of the concierge keeps it out of the deck.
  if (url.pathname.endsWith('/dislike')) {
    if (request.method !== 'POST') return json({ ok: false, error: 'POST' }, 405);
    const b = await request.json().catch(() => ({}));
    const me = String(b?.me ?? '').slice(0, 80), title = String(b?.title ?? '').slice(0, 120);
    if (!me || !title) return json({ ok: false, error: 'me and title required' }, 400);
    await saveFacts(env, me, [{ type: 'remember', key: `dislike:${slug(title)}`, value: title }]);
    return json({ ok: true });
  }
  const g = (k) => url.searchParams.get(k);
  const mode = g('mode') === 'surprise' ? 'surprise' : g('mode') === 'tonight' ? 'tonight' : g('mode') === 'nightlife' ? 'nightlife' : 'search';
  const q = String(g('q') ?? '').slice(0, 120);
  // The app holds a display name ("Kata, Phuket") and maybe a device fix;
  // the slug, the country and a fallback coordinate come from the
  // destinations table here, for the reason suggest.mjs gives: resolving on
  // the client silently produced `undefined` on every call.
  let dest = await resolveDest(env, g('dest') || g('place'));
  let row = null;
  // No name, but a device fix: the nearest destination NUM covers, within
  // 150 km. "Near me" from the place sheet lands here.
  if (!dest && g('lat') != null && g('lng') != null) {
    const near = await nearestDest(env, Number(g('lat')), Number(g('lng')));
    if (near) { dest = near.slug; row = near; }
  }
  if (!dest) return json({ ok: false, error: 'no_place', hint: 'Tell NUM where you are first.' }, 400);
  if (!row) { try { row = await env.DB.prepare('SELECT slug, name, country, lat, lng, tz FROM destinations WHERE slug = ?1').bind(dest).first(); } catch { /* fall back to the query */ } }
  const country = String(g('country') || row?.country || '').toUpperCase().slice(0, 2);
  const lat = g('lat') != null ? Number(g('lat')) : (row?.lat ?? null);
  const lng = g('lng') != null ? Number(g('lng')) : (row?.lng ?? null);
  const me = g('me'), planId = g('plan_id'), mood = MOOD_TAGS[g('mood')] ? g('mood') : null;
  if (mode === 'search' && !q) return json({ ok: false, error: 'q required for search' }, 400);

  // NIGHTLIFE: clubs, late bars, live music and the ticketed nights — nearest
  // first, always, with the distance on every row. Its own screen because it
  // is its own question: TONIGHT is "what should I do", this is "where is
  // everyone going", and the answer is ranked by how far away it is right now.
  // Three shelves from the same places table and ratings the concierge uses
  // (real ratings first, unrated dropped when the neighbourhood has rated
  // ones), plus Ticketmaster's music and party listings for today.
  //
  // Not promised here: entry, a table, or a cover charge NUM was never told.
  if (mode === 'nightlife') {
    const mine = g('lat') != null && g('lng') != null;
    const loc = { dest: { slug: dest, name: row?.name ?? dest, tz: row?.tz ?? null, lat: row?.lat ?? null, lng: row?.lng ?? null }, lat, lng, precise: mine, source: mine ? 'shared_location' : 'named' };
    const memberId = g('me') || null;
    const asPlace = (r) => ({
      source: 'num', id: `pl_${r.id}`, title: r.name, sub: [r.cuisine || (r.category ? String(r.category).replace(/ location$/i, '') : null), r.area].filter(Boolean).join(' · '),
      image: r.photo_url ?? null, rating: r.rating ?? null, reviews: r.reviews ?? null, price: null, currency: null, url: null,
      open_now: r.open_now ?? null, distance_km: mine && r.km != null ? Math.round(r.km * 10) / 10 : null, label: 'Checked by NUM',
    });
    // Nearest first is the ranking, and rated-first is the filter: a shelf
    // NUM puts forward only carries what it can stand behind (see TONIGHT).
    const shelf = (rows) => {
      const rated = rows.filter((r) => r.rating != null);
      const kept = rated.length >= 3 ? rated : rows;
      return kept.slice().sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9)).slice(0, 10).map(asPlace);
    };
    let clubs = [], bars = [], live = [], tm = [];
    try {
      const { enrichCell } = await import('./placeratings.mjs');
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        await Promise.race([
          Promise.all([
            enrichCell(env, { lat, lng, cat: 'night_club' }).catch(() => null),
            enrichCell(env, { lat, lng, cat: 'bar' }).catch(() => null),
          ]),
          new Promise((r) => setTimeout(r, 3500)),
        ]);
      }
      const { nearbyPlaces } = await import('../ai/places.js');
      const [r1, r2, r3, ev] = await Promise.all([
        withTimeout(nearbyPlaces(env, loc, 'nightclub club dancing', 18, null, { memberId }), 2500, { rows: [] }),
        withTimeout(nearbyPlaces(env, loc, 'bar cocktails late night', 18, null, { memberId }), 2500, { rows: [] }),
        withTimeout(nearbyPlaces(env, loc, 'live music venue jazz', 12, null, { memberId }), 2500, { rows: [] }),
        eventsFor(env, { dest, lat, lng, country, fetchImpl, near: true }),
      ]);
      clubs = shelf(r1?.rows ?? []);
      // A club is not a bar: whatever the bar search returned that is already
      // on the club shelf stays off the bar shelf.
      const clubIds = new Set(clubs.map((c) => c.id));
      bars = shelf(r2?.rows ?? []).filter((b) => !clubIds.has(b.id));
      live = shelf(r3?.rows ?? []).filter((b) => !clubIds.has(b.id));
      tm = ev ?? [];
    } catch (err) { console.warn('[discover] nightlife', err?.message ?? err); }
    // Tonight's nights: music and party listings for the day asked for, the
    // matinees and the theatre left to TONIGHT. Nearest first when we have a fix.
    const NIGHT = /music|dance|electronic|dj|house|techno|hip.?hop|r&b|club|party|night|festival|concert|rock|pop|latin|reggae/i;
    const day = g('day') || null;
    const nights = tm
      .filter((e) => (!e.genre || NIGHT.test(e.genre)) && (!day || !e.starts_on || e.starts_on === day))
      .sort((a, b) => (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9))
      .slice(0, 8);
    return json({ ok: true, mode, dest, clubs, bars, live, nights, near: mine, sources: { clubs: clubs.length, bars: bars.length, live: live.length, ticketmaster: nights.length } });
  }

  // TONIGHT: what is on, today and soon, from NUM's own checked list and
  // Ticketmaster where it has inventory. No places, no Viator — a strip for
  // the TODAY tab, each row with a start the countdown can tick from.
  if (mode === 'tonight') {
    const [tm, ours] = await Promise.all([
      eventsFor(env, { dest, lat, lng, country, fetchImpl, near: true }),
      withTimeout(cityEventsFor(env, dest, { limit: 4 }), 1500, []),
    ]);
    const curated = (ours ?? []).map((r) => ({
      source: 'num', id: `ce_${slug(r.title)}`, title: r.title, sub: [r.venue, r.area].filter(Boolean).join(' · '),
      image: null, rating: null, price: null, currency: null, price_note: r.price_note ?? null, url: null,
      starts_on: r.starts_on ?? null, ends_on: r.ends_on ?? null, starts_at: null, venue: r.venue ?? null, label: 'Checked by NUM', why: r.why ?? null,
    }));
    const items = tonightPick(curated, tm, g('day'));
    // Restaurants and bars near the person, through the same ranking the
    // concierge uses (ai/places.js: real ratings first, open now first,
    // not the same three as last time). Both rails are always there, so
    // the strip never disappears for a city with no events.
    const mine = g('lat') != null && g('lng') != null;
    const loc = { dest: { slug: dest, name: row?.name ?? dest, tz: row?.tz ?? null, lat: row?.lat ?? null, lng: row?.lng ?? null }, lat, lng, precise: mine, source: mine ? 'shared_location' : 'named' };
    const memberId = g('me') || null;
    const asPlace = (r) => ({
      source: 'num', id: `pl_${r.id}`, title: r.name, sub: [r.cuisine || (r.category ? String(r.category).replace(/ location$/i, '') : null), r.area].filter(Boolean).join(' · '),
      image: r.photo_url ?? null, rating: r.rating ?? null, reviews: r.reviews ?? null, price: null, currency: null, url: null,
      open_now: r.open_now ?? null, distance_km: mine && r.km != null ? Math.round(r.km * 10) / 10 : null, label: 'Checked by NUM',
    });
    let restaurants = [], bars = [];
    try {
      // ── RATE THE NEIGHBOURHOOD BEFORE RANKING IT ──────────────────────
      //
      // 18 Sep 2026: London had 23,561 restaurants mapped within 5 km of the
      // centre and NOT ONE carried a rating, so this shelf was ordered by
      // "has a website" and distance — which is how Pret A Manger and a
      // place in Reading ended up being what NUM suggested for dinner. The
      // enrichment already existed for the concierge (worker/placeratings.mjs)
      // and simply was not on this path. One Google Maps search per ~1 km
      // cell per category per 30 days, then everyone who asks afterwards
      // gets the benefit.
      const { enrichCell } = await import('./placeratings.mjs');
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        await Promise.race([
          Promise.all([
            enrichCell(env, { lat, lng, cat: 'restaurant' }).catch(() => null),
            enrichCell(env, { lat, lng, cat: 'bar' }).catch(() => null),
          ]),
          new Promise((r) => setTimeout(r, 3500)),
        ]);
      }
      const { nearbyPlaces } = await import('../ai/places.js');
      const [r1, r2] = await Promise.all([
        withTimeout(nearbyPlaces(env, loc, 'restaurant dinner', 14, null, { memberId }), 2500, { rows: [] }),
        withTimeout(nearbyPlaces(env, loc, 'bar cocktails', 14, null, { memberId }), 2500, { rows: [] }),
      ]);
      // A SHELF IS NOT A SEARCH RESULT. Nobody asked for these — NUM is
      // putting them forward — so it only puts forward what it can stand
      // behind. Where the neighbourhood has rated places, unrated ones are
      // dropped rather than padded in; where it has none yet (a city nobody
      // has asked about since the ratings went in) the rail shows the best
      // of what there is, because an empty shelf teaches people NUM is empty.
      const standBehind = (rows) => {
        const rated = rows.filter((r) => r.rating != null);
        return (rated.length >= 3 ? rated : rows).slice(0, 9);
      };
      restaurants = standBehind(r1?.rows ?? []).map(asPlace);
      bars = standBehind(r2?.rows ?? []).map(asPlace);
    } catch (err) { console.warn('[discover] tonight places', err?.message ?? err); }
    return json({ ok: true, mode, dest, items, restaurants, bars, sources: { num: curated.length, ticketmaster: tm.length, restaurants: restaurants.length, bars: bars.length } });
  }

  const [places, events, exps, history] = await Promise.all([
    placesFor(env, { dest, q: mode === 'search' ? q : null, mood, lat, lng }),
    eventsFor(env, { dest, lat, lng, country, fetchImpl }),
    experiencesFor(env, { dest, country, lat, lng, mood, fetchImpl }),
    crewHistory(env, { me, planId }),
  ]);

  // Search: keep rows that match the words; Surprise: everything is a candidate.
  const words = slug(q).split(' ').filter((w) => w.length > 2);
  const matches = (i) => !words.length || words.some((w) => slug(`${i.title} ${i.sub}`).includes(w));
  const pool = [...places, ...events, ...exps].filter(mode === 'search' ? matches : () => true);

  const crew = annotate(
    (history.items ?? []).map((t) => ({ source: 'crew', id: `crew_${slug(t.title)}`, title: t.title, sub: `${t.by_name ?? 'Someone'} · ${t.status}`, image: null, rating: null, price: null, currency: null, url: null, lat: null, lng: null, distance_km: null, label: 'Your crew' })).filter(matches),
    { items: [], members: history.members, dislikes: history.dislikes }, { me },
  );
  const ranked = rank(annotate(pool, history, { me }));
  const count = (src) => pool.filter((i) => i.source === src).length;
  const items = mode === 'surprise' ? dealThree(ranked) : [...ranked.slice(0, 12), ...crew.slice(0, 4)];

  return json({
    ok: true, mode, q: q || null, mood, dest,
    sources: { num: count('num'), ticketmaster: count('ticketmaster'), viator: count('viator'), crew: crew.length },
    items,
    note: items.length ? null : 'Nothing new here yet. Ask me in words and I will look wider.',
    // Why a rail came back empty. Reasons only, never keys or payloads.
    ...(g('debug') ? { why: { viator: exps.reason ?? 'ok', ticketmaster: events.reason ?? 'ok' } } : {}),
  });
}
