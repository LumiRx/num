/**
 * What a business actually offers, and what it charges.
 *
 * ── THE GAP THIS FILLS ───────────────────────────────────────────────────
 *
 * A traveller asks "where should we eat tonight" and NUM answers with a name,
 * a distance and whether it is open. Then they ask the question everybody asks
 * second — *what do they do, and what does it cost* — and NUM has one word for
 * it: `places.cuisine`. "Thai". That is the whole answer.
 *
 * Meanwhile the business knows its own menu, its treatment list, its room
 * types, and has no way to tell us. So the concierge either says nothing or
 * the guest opens Google, and the second one is how a directory stops being
 * worth reading.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
 *
 * Not a shop. Nothing here is bookable and nothing is payable — the booking
 * desk returns 503 and `num_paylinks` is empty, so a "buy" button would be a
 * button that cannot buy. It is the business describing itself in more than
 * one word, which is the thing NUM's whole job depends on.
 *
 * And it is not a price quote. It is what the business says it charges,
 * carried as such, so the words around it in an answer can be honest: "they
 * list the green curry at ฿180" is true; "your dinner will be ฿180" is not
 * ours to say.
 *
 * ── THREE RULES THE TESTS PIN ────────────────────────────────────────────
 *
 * 1. A PRICE MAY BE ABSENT. `price_minor` is nullable and "market price" is a
 *    real answer for a fish restaurant, a seasonal tasting menu, a tour that
 *    depends on numbers. Forcing a figure would invent one, and an invented
 *    price is the single most damaging thing this file could produce — a guest
 *    arrives expecting it.
 *
 * 2. CURRENCY IS DERIVED, NEVER DEFAULTED. A Thai restaurant priced in dollars
 *    is wrong in a way a traveller acts on. Currency comes from the business's
 *    own country; where we cannot work it out, the price is stored without one
 *    and shown as a bare number the owner can correct, rather than dressed in
 *    the wrong symbol.
 *
 * 3. A MENU IS NOT AN ANSWER. A concierge that recites 200 items is useless.
 *    The owner may store as many as they like; the answer path takes a capped,
 *    ordered slice, and `forPlaces` says so in its own signature.
 */

/**
 * Currencies whose smallest unit IS the unit — no decimals. Getting this wrong
 * prices a ¥1,200 bowl of ramen at ¥12.
 */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'IDR', 'CLP', 'ISK', 'HUF', 'TWD']);

/** Country to currency, for the destinations NUM actually serves. */
const CURRENCY_BY_COUNTRY = Object.freeze({
  TH: 'THB', GB: 'GBP', IE: 'EUR', PT: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR',
  NL: 'EUR', DE: 'EUR', AT: 'EUR', GR: 'EUR', HR: 'EUR', CZ: 'CZK', HU: 'HUF',
  DK: 'DKK', SE: 'SEK', CH: 'CHF', IS: 'ISK', TR: 'TRY', JP: 'JPY', KR: 'KRW',
  SG: 'SGD', HK: 'HKD', TW: 'TWD', MY: 'MYR', VN: 'VND', KH: 'USD', PH: 'PHP',
  AE: 'AED', LK: 'LKR', IN: 'INR', ID: 'IDR', MV: 'USD', MU: 'MUR', MX: 'MXN',
  US: 'USD', BS: 'USD', BB: 'BBD',
});

/**
 * The currency this business prices in.
 *
 * Returns null rather than guessing. A null currency renders as a bare number
 * the owner can see is missing something — a wrong symbol renders as a
 * confident lie.
 */
export const currencyFor = (country) => CURRENCY_BY_COUNTRY[String(country ?? '').toUpperCase()] ?? null;

/** How many of these units are in one whole. */
export const minorPer = (currency) => (ZERO_DECIMAL.has(String(currency ?? '').toUpperCase()) ? 1 : 100);

const SYMBOL = Object.freeze({ THB: '฿', GBP: '£', EUR: '€', USD: '$', JPY: '¥', KRW: '₩', INR: '₹', VND: '₫' });

/**
 * A price as a concierge would say it. Pure, so a test can pin every shape.
 *
 * Returns null when there is no price — the caller then says what the business
 * said instead ("market price"), or says nothing. It never returns "0" or
 * "price on request" of its own invention.
 */
export function formatPrice({ price_minor: minor, currency, unit, price_note: note } = {}) {
  const hasPrice = Number.isFinite(Number(minor)) && Number(minor) >= 0 && minor !== null;
  if (!hasPrice) return note ? String(note).slice(0, 40) : null;

  const cur = String(currency ?? '').toUpperCase();
  const per = minorPer(cur);
  const whole = Number(minor) / per;
  const shown = per === 1
    ? whole.toLocaleString('en-GB')
    : whole.toLocaleString('en-GB', { minimumFractionDigits: whole % 1 ? 2 : 0, maximumFractionDigits: 2 });

  const money = cur ? `${SYMBOL[cur] ?? ''}${shown}${SYMBOL[cur] ? '' : ` ${cur}`}` : shown;
  const prefix = note ? `${String(note).slice(0, 20)} ` : '';
  const suffix = unit && unit !== 'item' ? ` per ${unit}` : '';
  return `${prefix}${money}${suffix}`.trim();
}

/** Units an offering can be priced by. A closed list, so an answer reads cleanly. */
export const UNITS = Object.freeze(['item', 'person', 'night', 'hour', 'day', 'session', 'group']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_business_offerings (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL,
  place_id     TEXT NOT NULL,
  section      TEXT,
  name         TEXT NOT NULL,
  description  TEXT,
  price_minor  INTEGER,
  price_note   TEXT,
  currency     TEXT,
  unit         TEXT NOT NULL DEFAULT 'item',
  available    TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bizoffer_place ON num_business_offerings(place_id, active, position);
CREATE INDEX IF NOT EXISTS idx_bizoffer_biz   ON num_business_offerings(business_id, position);
`;

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

const clean = (v, n) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, n) : null;
};

/**
 * Everything this business has listed, in its own order. The owner's view, so
 * inactive rows are included — hidden is a state they chose, not a deletion.
 */
export async function listFor(env, businessId) {
  if (!env?.DB || !businessId) return [];
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT * FROM num_business_offerings WHERE business_id = ?1
      ORDER BY position ASC, rowid ASC`,
  ).bind(String(businessId)).all().catch(() => ({ results: [] }));
  return (results ?? []).map((r) => ({ ...r, active: !!r.active, price_label: formatPrice(r) }));
}

/**
 * What the concierge may say about these places.
 *
 * Capped per place, active only, in the owner's order. The cap is in the
 * signature rather than hidden inside, because a caller that wants more should
 * have to ask for it and think about what a 200-line answer reads like.
 */
export async function forPlaces(env, placeIds, { perPlace = 8 } = {}) {
  const ids = [...new Set((placeIds ?? []).map(String).filter(Boolean))].slice(0, 20);
  if (!env?.DB || !ids.length) return new Map();
  await ensure(env);
  const marks = ids.map((_, i) => `?${i + 1}`).join(',');
  const { results } = await env.DB.prepare(
    `SELECT place_id, section, name, description, price_minor, price_note, currency, unit, available, position
       FROM num_business_offerings
      WHERE active = 1 AND place_id IN (${marks})
      ORDER BY place_id, position ASC, rowid ASC`,
  ).bind(...ids).all().catch(() => ({ results: [] }));

  const out = new Map();
  for (const r of results ?? []) {
    const list = out.get(r.place_id) ?? [];
    if (list.length >= perPlace) continue;
    list.push({
      name: r.name,
      section: r.section ?? null,
      description: r.description ?? null,
      // The formatted string, not the raw minor units: the answer path should
      // never be doing currency arithmetic, and a model handed `18000` will
      // eventually say "eighteen thousand".
      price: formatPrice(r),
      available: r.available ?? null,
    });
    out.set(r.place_id, list);
  }
  return out;
}

/**
 * Add or change one.
 *
 * Currency is taken from the business's own profile country and cannot be set
 * by the caller — an owner mistyping a currency prices their menu wrongly for
 * every traveller, and the country is a fact we already hold.
 */
export async function upsert(env, businessId, input = {}) {
  if (!env?.DB || !businessId) return { ok: false, error: 'no business' };
  await ensure(env);

  const name = clean(input.name, 120);
  if (!name) return { ok: false, error: 'Give it a name — that is what a traveller hears.' };

  const owner = await env.DB.prepare(
    `SELECT o.place_id, p.country FROM num_place_owners o
       LEFT JOIN num_business_profiles p ON p.business_id = o.business_id
      WHERE o.business_id = ?1 AND o.revoked_at IS NULL LIMIT 1`,
  ).bind(String(businessId)).first().catch(() => null);
  if (!owner?.place_id) return { ok: false, error: 'This account has no listing yet.' };

  const currency = currencyFor(owner.country);
  const per = minorPer(currency);

  // A price typed as "180" or "12.50" becomes minor units. Empty stays NULL —
  // see rule 1 in the header: absence is a real answer.
  let priceMinor = null;
  const raw = String(input.price ?? '').replace(/[^0-9.]/g, '').trim();
  if (raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'That price did not read as a number.' };
    priceMinor = Math.round(n * per);
    if (priceMinor > 100_000_000) return { ok: false, error: 'That price looks like a typo.' };
  }

  const unit = UNITS.includes(String(input.unit)) ? String(input.unit) : 'item';
  const row = {
    section: clean(input.section, 60),
    name,
    description: clean(input.description, 300),
    price_minor: priceMinor,
    price_note: clean(input.price_note, 40),
    currency,
    unit,
    available: clean(input.available, 80),
    position: Number.isFinite(Number(input.position)) ? Number(input.position) : 0,
    active: input.active === false || input.active === 0 || input.active === '0' ? 0 : 1,
  };

  const id = clean(input.id, 40);
  if (id) {
    // Scoped to the business on the row, not to the id alone: an id from
    // another account must not be editable by guessing it.
    const res = await env.DB.prepare(
      `UPDATE num_business_offerings
          SET section=?3, name=?4, description=?5, price_minor=?6, price_note=?7,
              currency=?8, unit=?9, available=?10, position=?11, active=?12,
              updated_at=datetime('now')
        WHERE id=?1 AND business_id=?2`,
    ).bind(id, String(businessId), row.section, row.name, row.description, row.price_minor,
      row.price_note, row.currency, row.unit, row.available, row.position, row.active)
      .run().catch(() => null);
    if (!res?.meta?.changes) return { ok: false, error: 'That item is no longer on your list.' };
    return { ok: true, id, updated: true };
  }

  const newId = `off_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  await env.DB.prepare(
    `INSERT INTO num_business_offerings
       (id, business_id, place_id, section, name, description, price_minor, price_note,
        currency, unit, available, position, active)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
  ).bind(newId, String(businessId), owner.place_id, row.section, row.name, row.description,
    row.price_minor, row.price_note, row.currency, row.unit, row.available, row.position, row.active)
    .run();
  return { ok: true, id: newId, updated: false };
}

/**
 * Take one off the list.
 *
 * Deactivates rather than deletes. An owner who hides a seasonal dish in
 * October wants it back in June, and a delete makes them retype it — but the
 * concierge stops saying it either way, which is the part that matters.
 */
export async function hide(env, businessId, id) {
  if (!env?.DB || !businessId || !id) return { ok: false };
  await ensure(env);
  const res = await env.DB.prepare(
    `UPDATE num_business_offerings SET active = 0, updated_at = datetime('now')
      WHERE id = ?1 AND business_id = ?2`,
  ).bind(String(id), String(businessId)).run().catch(() => null);
  return { ok: !!res?.meta?.changes };
}

/** Put it back. */
export async function show(env, businessId, id) {
  if (!env?.DB || !businessId || !id) return { ok: false };
  await ensure(env);
  const res = await env.DB.prepare(
    `UPDATE num_business_offerings SET active = 1, updated_at = datetime('now')
      WHERE id = ?1 AND business_id = ?2`,
  ).bind(String(id), String(businessId)).run().catch(() => null);
  return { ok: !!res?.meta?.changes };
}

/** How many a business has listed — for the readiness checklist and the nav. */
export async function countFor(env, businessId) {
  if (!env?.DB || !businessId) return 0;
  await ensure(env);
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM num_business_offerings WHERE business_id = ?1 AND active = 1',
  ).bind(String(businessId)).first().catch(() => null);
  return Number(row?.n ?? 0);
}
