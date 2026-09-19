// MEMORY MEETS THE DIRECTORY (19 Sep 2026).
//
// Dre: "the model pulls from both memory and directory so we give the best
// places — this is very important." Until today a pick the model named from
// its own knowledge was dropped the moment it was not in the ten-row block —
// even when the same restaurant sat in the directory under the same name,
// eleventh in the ranking or two streets outside the ring. The guest lost
// the best-known place in town because a sample missed it.
//
// So a dropped pick now gets a second chance, in this order:
//   1. THE FULL DIRECTORY for this destination, by name. Found → the real
//      row, with its link, phone, address, hours and distance — the same card
//      a block pick gets, through the same resolvePicks door.
//   2. A MAP SEARCH, flagged. Not found → the guest still gets a link (a
//      search for the name in the city), the card says plainly "not in NUM's
//      directory yet", and no phone or hours are ever shown. Never a bare
//      name — the CONTACT RULE stands — and never a claim we cannot back.
//
// Bounded: at most eight lookups per answer, each by destination and a name
// prefix with LIMIT, so this can never become a scan of 2.7 million rows.
import { nameHit } from './namedplace.mjs';

const COLS = 'id, name, name_local, category, area, rating, reviews, phone, website, address, hours, cuisine, status, photo_url, photo_attr, photo_license, alive, hours_mask, booking_platform, booking_ref, num_rating, num_rating_n, lat, lng';

/** Great-circle km, for the distance a card shows. */
export function kmBetween(aLat, aLng, bLat, bLng) {
  if (![aLat, aLng, bLat, bLng].every((v) => Number.isFinite(+v))) return null;
  const r = (d) => (d * Math.PI) / 180;
  const dLat = r(bLat - aLat), dLng = r(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371 * 2 * Math.asin(Math.sqrt(h)) * 100) / 100;
}

/** The first real word of a name, for the LIKE prefix: "The Raw Bar Thonglor" → "raw". */
export function seedWord(name) {
  const STOP = new Set(['the', 'a', 'an', 'at', 'by', 'of', 'and', 'restaurant', 'cafe', 'bar', 'hotel', 'bangkok', 'phuket']);
  const w = String(name ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  return w.find((x) => x.length >= 3 && !STOP.has(x)) ?? w.find((x) => x.length >= 3) ?? null;
}

/**
 * Look the dropped names up in the whole destination. Returns the rows found
 * (with `km` from the guest when coordinates are known) and the names that
 * are not in the directory at all.
 */
export async function findInDirectory(env, { dest, lat = null, lng = null, names = [] }, { max = 8 } = {}) {
  const out = { rows: [], missing: [] };
  const want = [...new Set(names.map((n) => String(n ?? '').trim()).filter(Boolean))].slice(0, max);
  if (!env?.DB || !dest || !want.length) return { rows: [], missing: want };
  for (const name of want) {
    // "Somboon Seafood (Thonglor branch)" — the model's aside is not part of
    // the name the directory holds.
    const clean = name.replace(/\s*[([].*?[)\]]\s*/g, ' ').replace(/\s+/g, ' ').trim() || name;
    const seed = seedWord(clean);
    if (!seed) { out.missing.push(name); continue; }
    let rows = [];
    try {
      const { results } = await env.DB.prepare(
        `SELECT ${COLS} FROM places
          WHERE dest = ?1 AND (alive IS NULL OR alive = 1) AND (name LIKE ?2 OR name_local LIKE ?2)
          ORDER BY (rating IS NULL), rating DESC, reviews DESC
          LIMIT 40`,
      ).bind(dest, `%${seed}%`).all();
      rows = results ?? [];
    } catch (e) {
      console.warn('[pickrescue] lookup failed', e?.message ?? e);
    }
    // The strongest name match, then the better-rated row among equals.
    // Either direction: the row's name inside what the model wrote, or the
    // model's name inside the row's ("Laem Charoen Seafood" in "Laem Charoen
    // Seafood Central Embassy").
    const hitOf = (r) => Math.max(nameHit(r.name, clean), nameHit(clean, r.name), r.name_local ? nameHit(r.name_local, clean) : 0);
    const scored = rows.map((r) => ({ r, hit: hitOf(r) })).filter((x) => x.hit > 0);
    scored.sort((a, b) => (b.hit - a.hit) || ((b.r.rating ?? 0) - (a.r.rating ?? 0)) || ((b.r.reviews ?? 0) - (a.r.reviews ?? 0)));
    const best = scored[0]?.r;
    if (!best) { out.missing.push(name); continue; }
    out.rows.push({ ...best, km: kmBetween(lat, lng, best.lat, best.lng), _fromDirectory: true });
  }
  return out;
}

/** A search for the place in its city, on Google Maps — the link a guest can always use. */
export function mapSearchUrl(name, city) {
  const q = [name, city].filter(Boolean).join(' ');
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
}

/**
 * A pick the directory does not hold, as the app can still act on it: a map
 * search, flagged, nothing invented. Only the name and the model's why.
 */
export function unverifiedPick(pick, city) {
  const name = String(pick?.name ?? '').trim();
  if (!name) return null;
  const link = mapSearchUrl(name, city);
  return {
    id: null, name, name_local: null,
    why: String(pick?.why ?? '').trim().slice(0, 160) || null,
    link, link_kind: 'map', map: link,
    phone: null, tel: null, address: null, open_now: null, bookable: false,
    category: null, area: null, km: null, rating: null,
    photo: null, photo_attr: null, website: null, instagram: null, tiktok: null, facebook: null,
    unverified: true,
  };
}
