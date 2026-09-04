// One link, for every place Num ever names.
//
// Dre, 3 Sep 2026: "every time we give a recommendation for a place, we need
// to give a link to the location."
//
// ── WHY THE MODEL MAY NEVER WRITE THE LINK ───────────────────────────────
//
// A URL is the most dangerous string a language model can produce. Prices and
// ratings are checkable by the guard in quality.mjs; a plausible-looking URL
// is not, and a wrong one does not fail loudly — it opens a competitor, a
// parked domain, or a 404, while looking exactly like a working link. Num's
// whole position is "you don't have to check."
//
// So the link is never generated. It is DERIVED, here, from the verified row
// the directory already holds, and attached to the pick server-side. The
// model names a place from the block; it never types a URL.
//
// ── THE PRECEDENCE, AND WHY ──────────────────────────────────────────────
//
//   1. The venue's own website, when `alive` is not 0. `alive = 0` means Num
//      FETCHED that domain and found it dead, parked or 404 — positive
//      evidence, so we do not send a guest there. `alive = null` means never
//      checked, which is most of the directory and not a reason to withhold.
//   2. A maps link built from the coordinates. Deterministic, always
//      resolves, and puts the guest one tap from directions — which is what
//      "a link to the location" actually means to someone standing in a city
//      they do not know.
//
// A maps link is never a fallback in the apologetic sense. For a traveller on
// foot it is frequently the BETTER link: a restaurant's website tells you the
// menu, a map tells you how to get there.
//
// Coordinates over name search, always: `?q=<name>` sends "Blue Elephant" to
// whichever Blue Elephant Google likes best, in any city on earth. `?q=lat,lng`
// cannot be ambiguous. The name rides along in the query only as a label when
// coordinates are missing entirely.

/** A place row is only linkable if we know where it is or where it lives online. */
export const linkable = (p) => !!(cleanUrl(p?.website) || hasCoords(p) || (p?.name && p?.address));

const hasCoords = (p) =>
  Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)) &&
  !(Number(p.lat) === 0 && Number(p.lng) === 0);

/**
 * A website we are willing to send a guest to, or null.
 *
 * Refuses anything that is not http(s) — `javascript:` and `data:` in a
 * directory row are not a hypothetical when 2.6M rows came from open data.
 */
export function cleanUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Google Maps, from coordinates where we have them, else name + address. */
export function mapsUrl(p) {
  if (hasCoords(p)) {
    const q = `${Number(p.lat)},${Number(p.lng)}`;
    // `query_place_id` is not used: our ids are Num's, not Google's, and a
    // wrong place id silently overrides the coordinates.
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  }
  // NAME ALONE IS NOT A LOCATION. `?q=Blue Elephant` resolves to whichever
  // Blue Elephant the map likes best, in any city on earth — the precise
  // ambiguity coordinates exist to remove. An address is what makes a name
  // searchable, so both are required or neither is used. Caught by this
  // module's own test, which asked for a link to a place with a name and
  // nothing else and got a confident link to the wrong continent.
  if (!p?.name || !p?.address) return null;
  const label = `${p.name}, ${p.address}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(label)}`;
}

/**
 * The link for this place, and what kind it is — so the app can label it
 * honestly ("Website" vs "Directions") instead of showing a bare URL.
 *
 * Returns null only when the row carries no website, no coordinates and no
 * address, which for a real directory row should not happen.
 */
export function placeLink(p) {
  const site = cleanUrl(p?.website);
  // alive === 0 is a dead site we have actually fetched. Anything else
  // (null, undefined, 1) has not been disproved.
  //
  // Written as an explicit null check, not `Number(p.alive) !== 0`: most of
  // the directory has never been checked and carries `alive: null`, and
  // `Number(null)` is 0 — so the arithmetic version declared every unchecked
  // website dead and sent every guest to a map instead. Found by this
  // module's own test on the first run.
  const dead = p?.alive === 0 || p?.alive === '0';
  if (site && !dead) return { url: site, kind: 'website' };
  const maps = mapsUrl(p);
  if (maps) return { url: maps, kind: 'map' };
  // A dead website is still better than nothing if there is no map at all —
  // but say what it is, so the caller can decide.
  return site ? { url: site, kind: 'website' } : null;
}

/**
 * A tel: URI for a verified phone, or null.
 *
 * Kept beside the link because "call them yourself" is the other half of the
 * CONTACT RULE, and a phone number that is not tappable on a phone is a
 * number the guest has to retype while standing in the street.
 */
export function telLink(phone) {
  const s = String(phone ?? '').replace(/[^\d+]/g, '');
  if (!s || s.replace(/\D/g, '').length < 6) return null;
  return `tel:${s}`;
}

/**
 * Everything the app needs to render one place cleanly, from one verified row.
 * Every field is either from the row or derived from it — nothing here can be
 * invented, which is the entire point.
 */
export function placeContact(p) {
  const link = placeLink(p);
  return {
    id: p?.id ?? null,
    name: p?.name ?? null,
    link: link?.url ?? null,
    link_kind: link?.kind ?? null,
    map: mapsUrl(p),
    phone: p?.phone ?? null,
    tel: telLink(p?.phone),
    address: p?.address ?? null,
    open_now: typeof p?.open_now === 'boolean' ? p.open_now : null,
    bookable: !!(p?.booking_platform && p?.booking_ref),
  };
}

/**
 * Attach verified detail to the model's picks.
 *
 * The model hands us `{ id?, name, why }`. Everything a guest can tap comes
 * from the partner row we matched, never from the model. A pick that matches
 * no verified row is DROPPED — silently to the guest, loudly in the return
 * value, because the alternative is a card with a name and no way to reach it,
 * which is exactly the "bare name" the CONTACT RULE has always forbidden.
 *
 * Matching is by id first (exact, and what the block asks for), then by
 * name, case- and punctuation-insensitively — models copy names faithfully
 * but not always byte-for-byte ("Baan Rim Pa" vs "Baan Rim Pa Restaurant").
 *
 * @returns {{picks: array, dropped: string[]}}
 */
export function resolvePicks(picks, partners = []) {
  if (!Array.isArray(picks) || !picks.length) return { picks: [], dropped: [] };

  const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const byId = new Map();
  const byName = new Map();
  for (const p of partners ?? []) {
    if (p?.id != null) byId.set(String(p.id), p);
    const n = norm(p?.name);
    if (n && !byName.has(n)) byName.set(n, p);
  }

  const out = [];
  const dropped = [];
  const seen = new Set();
  for (const pick of picks) {
    const name = String(pick?.name ?? '').trim();
    if (!name) continue;
    let row = pick?.id != null ? byId.get(String(pick.id)) : null;
    if (!row) row = byName.get(norm(name));
    if (!row) {
      // A near match: the model's name contains the row's, or vice versa.
      const target = norm(name);
      for (const [n, candidate] of byName) {
        if (n && (n.includes(target) || target.includes(n))) { row = candidate; break; }
      }
    }
    if (!row) { dropped.push(name); continue; }

    const contact = placeContact(row);
    // No link means no card. A place we cannot point at is not a
    // recommendation, it is a name — and the guest is standing in a city they
    // do not know.
    if (!contact.link) { dropped.push(name); continue; }
    if (seen.has(contact.id ?? contact.name)) continue;
    seen.add(contact.id ?? contact.name);

    out.push({
      ...contact,
      // The row's name, not the model's: the directory is the authority on
      // what a place is called, including its local-script name.
      name: row.name ?? name,
      name_local: row.name_local && row.name_local !== row.name ? row.name_local : null,
      why: String(pick?.why ?? '').trim().slice(0, 160) || null,
      category: row.category ?? null,
      area: row.area ?? null,
      km: row.km ?? null,
      rating: row.rating ?? null,
    });
  }
  return { picks: out, dropped };
}
