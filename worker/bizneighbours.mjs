/**
 * "Your neighbour just joined NUM" — finding who to tell, and who never to.
 *
 * ── THE ASK ──────────────────────────────────────────────────────────────
 *
 * 7 Sep 2026, Dre: "lets find business local to it and tell them aroyo is
 * signed up and they should also."
 *
 * It is a good pitch. A business believes a neighbour before it believes a
 * platform, and "the B&B up the road is on this" is the only cold opener that
 * is also a fact.
 *
 * ── THE CHANNEL IS EMAIL, AND THIS FILE WILL NOT BUDGE ON IT ─────────────
 *
 * NUM holds roughly 1.8 million business phone numbers scraped from open map
 * data, with zero consent rows against them. `smsconsent.mjs` sets out what
 * texting that list would mean: $500–$1,500 per message in TCPA statutory
 * damages, the most reliably litigated consumer statute in America, and a
 * class action arriving with its own member list. NUM's own charter already
 * said it: "Send to any number without a consent row. There is no 'probably
 * fine' here."
 *
 * So this returns EMAIL ADDRESSES and nothing else. There is no phone column
 * in the output — not masked, not optional, not "for reference". A field that
 * exists is a field somebody eventually sends to.
 *
 * ── AND WHY IT IS A LIST, NOT A SEND ─────────────────────────────────────
 *
 * Nothing here sends anything. It produces a batch for a person to read.
 * Emailing thousands of scraped addresses would burn the sending domain, and
 * the first thing to stop arriving when a domain burns is the welcome mail and
 * the go-live mail — so a blast aimed at winning new businesses would break
 * the promise to the ones already signed up. `MAX_BATCH` is small on purpose.
 */

/** A neighbourhood, not a city. Somebody two streets away is a neighbour. */
export const DEFAULT_KM = 1.6;

/**
 * How many a person will actually read before rubber-stamping the rest.
 *
 * Deliberately smaller than feels efficient. The failure this guards against
 * is not sending too few; it is a batch big enough that nobody checks it.
 */
export const MAX_BATCH = 30;

const clean = (v, n) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, n) : null;
};

const looksEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v ?? '').trim());

/**
 * Addresses that are not a business owner.
 *
 * A directory scraped off the open web collects plenty of these, and a
 * "your neighbour joined" note landing in a booking aggregator's robot inbox
 * is at best wasted and at worst a spam report against the sending domain.
 */
const NOT_A_PERSON = /^(no-?reply|do-?not-?reply|postmaster|abuse|webmaster|admin|root|mailer-daemon)@/i;

/** Domains that belong to a platform, not to the business itself. */
// The trailing separator has to be optional: written as `\.` it required a
// dot AFTER the domain, so `x@booking.com` sailed straight through the check
// meant to catch exactly that. Its own test found it.
const PLATFORM = /@(booking\.com|expedia|tripadvisor|opentable|yelp|google|facebook|wixpress|squarespace)(\.|$)/i;

export const contactable = (email) => {
  const e = String(email ?? '').trim();
  return looksEmail(e) && !NOT_A_PERSON.test(e) && !PLATFORM.test(e);
};

const SCHEMA = `CREATE TABLE IF NOT EXISTS num_neighbour_outreach (
  place_id   TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  anchor_id  TEXT,
  sent_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;
const ready = new WeakSet();
export async function ensure(env) {
  if (!env?.DB || ready.has(env.DB)) return;
  await env.DB.prepare(SCHEMA).run();
  ready.add(env.DB);
}

/**
 * Who is near this business and worth telling.
 *
 * The anchor is a listing that has actually signed up — its name is the whole
 * pitch, so a neighbour list built around an unclaimed listing would be a
 * letter saying somebody joined who did not.
 */
export async function neighboursOf(env, { placeId, km = DEFAULT_KM, limit = MAX_BATCH } = {}) {
  if (!env?.DB || !placeId) return { ok: false, error: 'place_id is required' };
  await ensure(env);

  const anchor = await env.DB.prepare(
    "SELECT id, name, lat, lng, dest, status FROM places WHERE id = ?1",
  ).bind(String(placeId)).first().catch(() => null);
  if (!anchor) return { ok: false, error: 'no such listing' };
  if (anchor.status !== 'claimed') {
    return { ok: false, error: `${anchor.name} has not claimed their listing — there is nothing to tell anyone yet` };
  }
  if (!Number.isFinite(anchor.lat) || !Number.isFinite(anchor.lng)) {
    return { ok: false, error: 'that listing has no coordinates' };
  }

  const dLat = km / 111;
  const dLng = km / (111 * Math.max(0.2, Math.cos(anchor.lat * Math.PI / 180)));
  const cap = Math.max(1, Math.min(Number(limit) || MAX_BATCH, MAX_BATCH));

  const { results } = await env.DB.prepare(
    `SELECT id, name, category, email, address, area,
            ROUND(6371*acos(MAX(-1.0, MIN(1.0,
              cos(radians(?1))*cos(radians(lat))*cos(radians(lng)-radians(?2))
              + sin(radians(?1))*sin(radians(lat))))), 2) AS km
       FROM places
      WHERE id <> ?3
        AND (alive IS NULL OR alive = 1)
        AND status <> 'claimed'
        AND email IS NOT NULL AND email <> ''
        AND cell_lat BETWEEN ?4 AND ?5 AND cell_lng BETWEEN ?6 AND ?7
        AND id NOT IN (SELECT place_id FROM num_neighbour_outreach)
      ORDER BY km ASC LIMIT ?8`,
  ).bind(
    anchor.lat, anchor.lng, anchor.id,
    Math.floor((anchor.lat - dLat) * 10), Math.floor((anchor.lat + dLat) * 10),
    Math.floor((anchor.lng - dLng) * 10), Math.floor((anchor.lng + dLng) * 10),
    cap * 4,
  ).all().catch(() => ({ results: [] }));

  const seen = new Set();
  const rows = [];
  for (const r of results ?? []) {
    if (r.km > km) continue;
    const email = String(r.email).trim().toLowerCase();
    if (!contactable(email)) continue;
    // One letter per mailbox. A chain with nine branches on one address is one
    // business reading nine copies of the same note about its own street.
    if (seen.has(email)) continue;
    seen.add(email);
    rows.push({
      place_id: r.id,
      name: clean(r.name, 120),
      category: clean(r.category, 60),
      email,
      address: clean(r.address, 200),
      km: r.km,
    });
    if (rows.length >= cap) break;
  }

  return { ok: true, anchor: { id: anchor.id, name: anchor.name, dest: anchor.dest }, km, count: rows.length, neighbours: rows };
}

/**
 * The letter.
 *
 * Short, names the neighbour, says the one thing NUM does for a listed
 * business, and gives them their own listing rather than a marketing page —
 * a business will click on itself before it clicks on us. No pitch about
 * plans: this is an introduction, not a sale.
 */
export function neighbourEmail({ anchorName, name, placeId, origin = 'https://itsnum.com' } = {}) {
  return {
    subject: `${anchorName} down the road just joined NUM`,
    body: [
      `Hi${name ? ` — ${name}` : ''},`,
      '',
      `${anchorName}, near you, has just claimed their listing on NUM.`,
      '',
      'NUM is a concierge people text when they want somewhere to go. When it '
      + 'answers, it names real places — and a business that has claimed its listing '
      + 'gets its own hours, prices and phone number read out instead of whatever the '
      + 'internet last guessed.',
      '',
      `Yours is already there: ${origin}/business?q=${encodeURIComponent(name ?? '')}`,
      '',
      'Claiming it is free and takes about a minute — we send a code to the number '
      + 'or address already published on your listing, so only you can do it.',
      '',
      'If this is not for you, ignore this and you will not hear from us again.',
      '',
      '— NUM',
    ].join('\n'),
  };
}

/** Mark a batch as written to, so nobody is told twice. */
export async function recordBatch(env, { anchorId, rows }) {
  if (!env?.DB || !rows?.length) return { ok: false };
  await ensure(env);
  await env.DB.batch(rows.map((r) => env.DB.prepare(
    `INSERT INTO num_neighbour_outreach (place_id, email, anchor_id, created_at)
     VALUES (?1,?2,?3,datetime('now')) ON CONFLICT(place_id) DO NOTHING`,
  ).bind(r.place_id, r.email, anchorId ?? null)));
  return { ok: true, recorded: rows.length };
}
