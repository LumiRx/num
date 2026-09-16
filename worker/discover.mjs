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
 * Route: GET /api/discover?mode=search|surprise&q=…&dest=…&country=…
 *        &lat=…&lng=…&me=…&plan_id=…&mood=water|food|night|sweat|culture
 */

import { search as viatorSearch, viatorReady } from './viator.mjs';
import { searchEvents } from './eventsearch.mjs';
import { loadFacts } from './memory.mjs';

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
  Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]).catch(() => fallback);

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
    let sql = `SELECT id, name, category, area, lat, lng, rating, photo_url
                 FROM places WHERE dest = ?1 AND (alive IS NULL OR alive = 1)`;
    const binds = [String(dest).slice(0, 60)];
    if (cats.length) { sql += ` AND (${cats.map((_, i) => `lower(category) LIKE ?${i + 2}`).join(' OR ')})`; binds.push(...cats.map((c) => `${c}%`)); }
    else if (like && like !== '%%') { sql += ' AND (lower(name) LIKE ?2 OR lower(category) LIKE ?2)'; binds.push(like); }
    sql += ' ORDER BY rating DESC NULLS LAST LIMIT ?' + (binds.length + 1);
    binds.push(limit);
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return (results ?? []).map((r) => ({
      source: 'num', id: `pl_${r.id}`, title: r.name, sub: [r.category, r.area].filter(Boolean).join(' · '),
      image: r.photo_url ?? null, rating: r.rating ?? null, price: null, currency: null, url: null,
      lat: r.lat ?? null, lng: r.lng ?? null, distance_km: haversineKm(lat, lng, r.lat, r.lng),
      label: 'Checked by NUM',
    }));
  } catch { return []; }
}

/** Real ticketed events near the coordinate (Ticketmaster where it actually has inventory). */
export async function eventsFor(env, { dest, lat, lng, country, fetchImpl }) {
  const found = await withTimeout(searchEvents(env, { dest, lat, lng, country, days: 7, fetchImpl }), 4000, null);
  const list = found?.events ?? found?.result?.events ?? [];
  return list.map((e) => ({
    source: 'ticketmaster', id: `tm_${e.id}`, title: e.name, sub: [e.venue, e.date, e.time].filter(Boolean).join(' · '),
    image: e.image ?? null, rating: null, price: e.from ?? null, currency: e.currency ?? null, url: e.url ?? null,
    lat: null, lng: null, distance_km: null, label: 'Listed on Ticketmaster',
  }));
}

/** Bookable experiences (Viator Basic Access: search + attributed link, never "booked"). */
export async function experiencesFor(env, { dest, country, lat, lng, mood, currency = 'USD', fetchImpl }) {
  if (!viatorReady(env)) return [];
  const tags = mood ? MOOD_TAGS[mood] ?? null : null;
  const r = await withTimeout(viatorSearch(env, { name: dest, country, lat, lng, currency, count: 12, tags }, fetchImpl), 8000, null);
  if (!r?.ok) return [];
  return r.products.map((p) => ({
    source: 'viator', id: `vi_${p.code}`, title: p.title, sub: [p.duration, p.reviews ? `${p.reviews} reviews` : null].filter(Boolean).join(' · '),
    image: p.image ?? null, rating: p.rating ?? null, price: p.from ?? null, currency: p.currency ?? null, url: p.url,
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

/** Never-tried first, then closer, then cheaper, then better rated. */
export function rank(items) {
  const price = (i) => (i.price == null ? 1e9 : Number(i.price));
  return [...items].sort((a, b) =>
    Number(b.novelty?.never_tried) - Number(a.novelty?.never_tried)
    || (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9)
    || price(a) - price(b)
    || (b.rating ?? 0) - (a.rating ?? 0));
}

/** Three cards, one per source where possible, so a deal is never three boat trips. */
export function dealThree(ranked) {
  const out = [], seen = new Set();
  for (const i of ranked) { if (!seen.has(i.source) && i.novelty?.never_tried) { out.push(i); seen.add(i.source); } if (out.length === 3) return out; }
  for (const i of ranked) { if (!out.includes(i) && i.novelty?.never_tried) out.push(i); if (out.length === 3) return out; }
  for (const i of ranked) { if (!out.includes(i)) out.push(i); if (out.length === 3) break; }
  return out;
}

/* ── Route ─────────────────────────────────────────────────────────────── */

export async function handleDiscover(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const g = (k) => url.searchParams.get(k);
  const mode = g('mode') === 'surprise' ? 'surprise' : 'search';
  const q = String(g('q') ?? '').slice(0, 120);
  const dest = g('dest'), country = String(g('country') ?? '').toUpperCase().slice(0, 2);
  const lat = g('lat') == null ? null : Number(g('lat')), lng = g('lng') == null ? null : Number(g('lng'));
  const me = g('me'), planId = g('plan_id'), mood = MOOD_TAGS[g('mood')] ? g('mood') : null;
  if (!dest) return json({ ok: false, error: 'dest required' }, 400);
  if (mode === 'search' && !q) return json({ ok: false, error: 'q required for search' }, 400);

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
  });
}
