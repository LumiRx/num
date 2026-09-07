/**
 * Filling in a business's own details, without ever putting words in its mouth.
 *
 * ── WHAT THIS IS FOR ─────────────────────────────────────────────────────
 *
 * A claimed listing is only as good as the `places` row underneath it, and
 * that row came from an OSM/Google import that is complete for some venues and
 * threadbare for others. The readiness checklist reports the holes honestly
 * (`hours`, `phone`, `address` missing) and then asks the owner to fix them —
 * which is the right list and the wrong amount of work. Most of it is
 * published on their own website already.
 *
 * So each business's agent goes and looks, and fills in what it can.
 *
 * ── THE LINE, AND WHY IT IS DRAWN HERE ───────────────────────────────────
 *
 * Two sources, and they are NOT treated the same:
 *
 *   · THE BUSINESS'S OWN WEBSITE. Schema.org LocalBusiness markup that the
 *     business published about itself. This is the business's own statement,
 *     on a domain it controls, and it is the only source good enough to write
 *     into a listing unattended — and then only into a field that is EMPTY.
 *
 *   · A SEARCH ENGINE'S KNOWLEDGE PANEL. Third-party, frequently stale, and
 *     not the business talking. Every value from here is a PROPOSAL the owner
 *     confirms. It never lands on its own.
 *
 * The temptation is to auto-apply both — the checklist empties faster and the
 * dashboard looks finished. But `bizonboard.mjs` already names the stake:
 * hours are "the single thing that matters most... the detail people act on."
 * A wrong opening time from a stale panel sends a traveller to a locked door,
 * and NUM told them to go. A field we left visibly empty costs a business
 * nothing; a field we filled in wrongly costs it a guest, and costs NUM the
 * only thing it sells.
 *
 * ── AND NOTHING EVER OVERWRITES AN OWNER ─────────────────────────────────
 *
 * No source, however good, replaces a value already on the listing. An owner
 * who typed their holiday hours in December must not find them reverted in
 * January because a crawler still had the old ones. `EMPTY FIELDS ONLY` is
 * checked at write time, not at propose time, so a race cannot beat it.
 */

const FIELDS = Object.freeze(['phone', 'website', 'address', 'hours', 'cuisine']);

/** Human labels, for the confirmation page. Same words as the checklist. */
export const FIELD_LABEL = Object.freeze({
  phone: 'Phone', website: 'Website', address: 'Address',
  hours: 'Opening hours', cuisine: 'Cuisine or speciality',
});

/**
 * Which sources may write unattended.
 *
 * `own_site` only. Adding a source to this set is the single most dangerous
 * one-line change in this file, so it is a named constant with this comment
 * attached rather than a boolean somewhere in the flow.
 */
export const TRUSTED_TO_APPLY = Object.freeze(new Set(['own_site']));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_business_field_proposals (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL,
  place_id     TEXT NOT NULL,
  field        TEXT NOT NULL,
  value        TEXT NOT NULL,
  source       TEXT NOT NULL,
  evidence     TEXT,
  state        TEXT NOT NULL DEFAULT 'proposed',
  decided_by   TEXT,
  decided_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bizprop_open
  ON num_business_field_proposals(business_id, field) WHERE state = 'proposed';
CREATE INDEX IF NOT EXISTS idx_bizprop_biz ON num_business_field_proposals(business_id, state);
`;

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

const clean = (v, n = 300) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s && s !== '-' && s.toLowerCase() !== 'null' ? s.slice(0, n) : null;
};
const isEmpty = (v) => !clean(v);

/* ── the business's own website ──────────────────────────────────────────── */

/**
 * Schema.org LocalBusiness, read out of the business's own page.
 *
 * Parsed from `<script type="application/ld+json">` rather than from the
 * visible HTML: scraping rendered text for an address means guessing, and a
 * guess is exactly what must not end up on a listing. Markup is the business
 * stating its own facts in a defined vocabulary, or it is nothing.
 *
 * Deliberately narrow. openingHours in schema.org has half a dozen shapes;
 * only the two unambiguous ones are read, and anything else is skipped rather
 * than approximated.
 */
export function fromJsonLd(text) {
  const out = {};
  const blocks = [...String(text ?? '').matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )].map((m) => m[1]);

  const nodes = [];
  for (const b of blocks) {
    let parsed;
    try { parsed = JSON.parse(b); } catch { continue; }
    const push = (n) => { if (n && typeof n === 'object') nodes.push(n); };
    if (Array.isArray(parsed)) parsed.forEach(push);
    else if (Array.isArray(parsed['@graph'])) parsed['@graph'].forEach(push);
    else push(parsed);
  }

  // A LocalBusiness (or any subtype — Restaurant, Hotel, CafeOrCoffeeShop…).
  // Organization is deliberately NOT accepted: it carries no opening hours and
  // its address is often a head office, not the venue a traveller walks to.
  const biz = nodes.find((n) => {
    const t = [].concat(n['@type'] ?? []).join(' ');
    return /LocalBusiness|Restaurant|Hotel|Cafe|Bar|Store|Spa|Lodging|FoodEstablishment|TouristAttraction/i.test(t);
  });
  if (!biz) return out;

  const phone = clean(biz.telephone, 40);
  if (phone) out.phone = phone;

  const url = clean(biz.url, 300);
  if (url && /^https?:\/\//i.test(url)) out.website = url;

  const a = biz.address;
  if (typeof a === 'string') out.address = clean(a, 300);
  else if (a && typeof a === 'object') {
    const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode]
      .map((x) => clean(x, 120)).filter(Boolean);
    if (parts.length >= 2) out.address = parts.join(', ').slice(0, 300);
  }

  // openingHours: only the two shapes that cannot be misread.
  const oh = biz.openingHours;
  if (typeof oh === 'string') out.hours = clean(oh, 200);
  else if (Array.isArray(oh) && oh.every((x) => typeof x === 'string')) {
    out.hours = clean(oh.join('; '), 200);
  } else if (Array.isArray(biz.openingHoursSpecification)) {
    const spans = biz.openingHoursSpecification
      .filter((s) => s?.opens && s?.closes && s?.dayOfWeek)
      .map((s) => {
        const days = [].concat(s.dayOfWeek).map((d) => String(d).split('/').pop().slice(0, 3)).join(',');
        return `${days} ${s.opens}-${s.closes}`;
      });
    if (spans.length) out.hours = clean(spans.join('; '), 200);
  }

  const desc = clean(biz.servesCuisine ?? biz.description, 200);
  if (desc) out.cuisine = desc;

  return out;
}

/** Fetch and read a business's own site. Never throws; a dead site is a null. */
async function readOwnSite(url, fetchImpl = fetch) {
  const target = clean(url, 300);
  if (!target || !/^https?:\/\//i.test(target)) return null;
  try {
    const r = await fetchImpl(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'NUM-listing-check/1.0 (+https://itsnum.com)', Accept: 'text/html' },
    });
    if (!r.ok) return null;
    // A listing page is not a download. Read a bounded prefix: the markup we
    // want is in <head> on every implementation that matters, and an unbounded
    // read is how one badly-configured site costs a whole sweep.
    const body = (await r.text()).slice(0, 400_000);
    return fromJsonLd(body);
  } catch { return null; }
}

/* ── the search panel ────────────────────────────────────────────────────── */

/**
 * What a search engine's knowledge panel holds. Same key and same endpoint
 * bizdossier.mjs already uses — one integration, not two.
 *
 * Everything from here is a proposal. See the header.
 */
async function readPanel(env, { name, dest, country }, fetchImpl = fetch) {
  if (!env?.SERPAPI_KEY || !name) return null;
  const where = [dest, country].filter(Boolean).join(' ');
  try {
    const r = await fetchImpl(
      `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(`${name} ${where}`)}&num=3&api_key=${env.SERPAPI_KEY}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) return null;
    const kg = (await r.json())?.knowledge_graph ?? {};
    const out = {};
    if (clean(kg.phone, 40)) out.phone = clean(kg.phone, 40);
    if (clean(kg.website, 300)) out.website = clean(kg.website, 300);
    if (clean(kg.address, 300)) out.address = clean(kg.address, 300);
    if (kg.hours && typeof kg.hours === 'object') {
      const spans = Object.entries(kg.hours)
        .map(([d, v]) => `${d.slice(0, 3)} ${typeof v === 'string' ? v : v?.opens ? `${v.opens}-${v.closes}` : ''}`.trim())
        .filter((x) => x.length > 4);
      if (spans.length) out.hours = clean(spans.join('; '), 200);
    }
    return out;
  } catch { return null; }
}

/* ── the work ────────────────────────────────────────────────────────────── */

/**
 * Look this business up and record what we found.
 *
 * Returns what it did rather than writing a log line, so the agent can report
 * it and a test can assert it.
 */
export async function enrich(env, businessId, { fetchImpl = fetch } = {}) {
  if (!env?.DB || !businessId) return { applied: [], proposed: [], skipped: 'no business' };
  await ensure(env);

  const place = await env.DB.prepare(
    `SELECT p.id, p.name, p.dest, p.country, p.phone, p.website, p.address, p.hours, p.cuisine
       FROM num_place_owners o JOIN places p ON p.id = o.place_id
      WHERE o.business_id = ?1 AND o.revoked_at IS NULL LIMIT 1`,
  ).bind(String(businessId)).first().catch(() => null);
  if (!place) return { applied: [], proposed: [], skipped: 'no listing' };

  // A field the owner has already said no to is not proposed again. Without
  // this, the confirm page re-asks every sweep and becomes a thing they learn
  // to dismiss — at which point it stops working for the fields that matter.
  const declined = await declinedFields(env, businessId);
  const missing = FIELDS.filter((f) => isEmpty(place[f]) && !declined.has(f));
  if (!missing.length) return { applied: [], proposed: [], skipped: 'nothing missing' };

  // Their own site first, and only their own site can write. Note this reads
  // the website ALREADY on the listing — never a URL supplied by whoever is
  // asking, which would let anyone point us at a page they control.
  const own = place.website ? await readOwnSite(place.website, fetchImpl) : null;
  const panel = await readPanel(env, place, fetchImpl);

  const applied = [];
  const proposed = [];

  for (const field of missing) {
    const fromOwn = own?.[field] ? { value: own[field], source: 'own_site', evidence: place.website } : null;
    const fromPanel = panel?.[field] ? { value: panel[field], source: 'search_panel', evidence: 'knowledge panel' } : null;
    const pick = fromOwn ?? fromPanel;
    if (!pick) continue;

    if (TRUSTED_TO_APPLY.has(pick.source)) {
      // EMPTY-ONLY, RE-CHECKED AT WRITE TIME. The WHERE clause is the guard,
      // not the `missing` list above: an owner may have typed this value in
      // the seconds since, and a sweep must never win that race.
      const res = await env.DB.prepare(
        `UPDATE places SET ${field} = ?2
          WHERE id = ?1 AND (${field} IS NULL OR TRIM(${field}) = '')`,
      ).bind(place.id, pick.value).run().catch(() => null);
      if (res?.meta?.changes) {
        applied.push({ field, value: pick.value, source: pick.source });
        await recordProposal(env, businessId, place.id, field, pick, 'applied');
        continue;
      }
    }
    await recordProposal(env, businessId, place.id, field, pick, 'proposed');
    proposed.push({ field, value: pick.value, source: pick.source });
  }

  return { applied, proposed, place_id: place.id };
}

async function recordProposal(env, businessId, placeId, field, pick, state) {
  // One open proposal per field. A sweep that ran daily would otherwise stack
  // fourteen identical suggestions and the confirm page would be unusable.
  await env.DB.prepare(
    `UPDATE num_business_field_proposals SET state = 'superseded'
      WHERE business_id = ?1 AND field = ?2 AND state = 'proposed'`,
  ).bind(String(businessId), field).run().catch(() => {});
  await env.DB.prepare(
    `INSERT INTO num_business_field_proposals
       (id, business_id, place_id, field, value, source, evidence, state, decided_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8, CASE WHEN ?8 = 'applied' THEN datetime('now') ELSE NULL END)`,
  ).bind(
    `prop_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
    String(businessId), String(placeId), field,
    String(pick.value).slice(0, 400), pick.source, String(pick.evidence ?? '').slice(0, 200), state,
  ).run().catch(() => {});
}

/** What this business is being asked to confirm. */
export async function pendingFor(env, businessId) {
  if (!env?.DB || !businessId) return [];
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT id, field, value, source, evidence, created_at
       FROM num_business_field_proposals
      WHERE business_id = ?1 AND state = 'proposed'
      ORDER BY created_at ASC`,
  ).bind(String(businessId)).all().catch(() => ({ results: [] }));
  return (results ?? []).map((r) => ({ ...r, label: FIELD_LABEL[r.field] ?? r.field }));
}

/**
 * The owner's answer.
 *
 * Accepting writes it; declining records that they said no, which matters —
 * a declined value must not be proposed again next sweep, or the confirm page
 * becomes a thing they learn to dismiss.
 */
export async function decide(env, { id, accept, by = 'owner' }) {
  if (!env?.DB || !id) return { ok: false, error: 'no proposal' };
  await ensure(env);
  const row = await env.DB.prepare(
    "SELECT * FROM num_business_field_proposals WHERE id = ?1 AND state = 'proposed'",
  ).bind(String(id)).first().catch(() => null);
  if (!row) return { ok: false, error: 'that suggestion is no longer open' };

  if (accept) {
    if (!FIELDS.includes(row.field)) return { ok: false, error: 'unknown field' };
    await env.DB.prepare(`UPDATE places SET ${row.field} = ?2 WHERE id = ?1`)
      .bind(row.place_id, row.value).run();
  }
  await env.DB.prepare(
    `UPDATE num_business_field_proposals
        SET state = ?2, decided_by = ?3, decided_at = datetime('now') WHERE id = ?1`,
  ).bind(String(id), accept ? 'accepted' : 'declined', String(by).slice(0, 60)).run();
  return { ok: true, field: row.field, accepted: !!accept };
}

/**
 * Has this business already said no to this field? Checked before proposing
 * again, so a decline sticks.
 */
export async function declinedFields(env, businessId) {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT field FROM num_business_field_proposals WHERE business_id = ?1 AND state = 'declined'",
  ).bind(String(businessId)).all().catch(() => ({ results: [] }));
  return new Set((results ?? []).map((r) => r.field));
}

/**
 * Every business whose listing still has holes, oldest first.
 *
 * Capped hard: each business costs up to two outbound fetches and one of them
 * is metered. A sweep that ran across two hundred businesses every five
 * minutes would be a bill, not a feature.
 */
export async function enrichSweep(env, { limit = 5, fetchImpl = fetch } = {}) {
  if (!env?.DB) return { seen: 0, applied: 0, proposed: 0 };
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT o.business_id
       FROM num_place_owners o JOIN places p ON p.id = o.place_id
      WHERE o.revoked_at IS NULL
        AND (p.hours IS NULL OR TRIM(p.hours) = ''
          OR p.phone IS NULL OR TRIM(p.phone) = ''
          OR p.address IS NULL OR TRIM(p.address) = '')
        AND NOT EXISTS (
          SELECT 1 FROM num_business_field_proposals x
           WHERE x.business_id = o.business_id
             AND x.created_at > datetime('now','-7 days'))
      ORDER BY o.verified_at ASC
      LIMIT ?1`,
  ).bind(limit).all().catch(() => ({ results: [] }));

  let applied = 0;
  let proposed = 0;
  for (const row of results ?? []) {
    const out = await enrich(env, row.business_id, { fetchImpl }).catch(() => null);
    applied += out?.applied?.length ?? 0;
    proposed += out?.proposed?.length ?? 0;
  }
  return { seen: (results ?? []).length, applied, proposed };
}

export const __testables = { readOwnSite, readPanel, FIELDS };
