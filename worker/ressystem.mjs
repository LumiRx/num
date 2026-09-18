/**
 * WHICH RESERVATION SYSTEM DOES THIS VENUE ALREADY RUN — read it, don't ask.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────
 *
 * A venue worth listing usually already books tables somehow. Asking them to
 * abandon that for NUM is not an offer, it is an insult with a signup form
 * attached. The only honest propositions are: send you the booking in a form
 * you can act on, or send you the guest and get out of the way.
 *
 * Both require knowing what they run. A form field asking "which system?" gets
 * answered by roughly nobody, so the field is the fallback and the website is
 * the first source: a restaurant that books on OpenTable has an OpenTable
 * widget on its own homepage, and that is a fact we can read rather than a
 * question we have to make somebody answer.
 *
 * ── WHAT "INTEGRATE" HONESTLY MEANS, PER SYSTEM ──────────────────────────
 *
 * Almost none of these have a public, self-serve booking API. Most have a
 * PARTNER programme: an application, a commercial agreement, sandbox
 * credentials, and a human on both sides. That is a real path and it is not a
 * fast one, so `reach` records which kind of door each system has, and nothing
 * in this file pretends a partner programme is an integration we already have.
 *
 *   open     credentials a developer can obtain without a signed agreement
 *   partner  a real API exists, behind an application and an agreement
 *   none     no third-party booking API at all; handoff is the ceiling
 *   unknown  not yet researched — the agent's queue, not a guess
 *
 * Checked 18 Sep 2026: OpenTable publishes a partner Booking API with a
 * sandbox, docs at docs.opentable.com and an application at
 * opentable.com/restaurant-solutions/api-partners/become-a-partner/. That is
 * the nearest thing to a real door in this whole list, and it is the one to
 * knock on first, because it is also where the venues that turned us down for
 * texting actually live.
 *
 * ── THE HANDOFF IS THE PRODUCT UNTIL AN INTEGRATION SHIPS ────────────────
 *
 * Every entry that can carry a party size and a time in its URL does. A guest
 * who taps through to OpenTable with the date, time and covers already filled
 * in has had most of the work done for them, and the venue's own system stays
 * the single source of truth about its own tables — which is what the venue
 * wanted in the first place. It is not as good as a booking NUM confirms. It
 * is enormously better than a phone number and a shrug, and it works today.
 *
 * ── AND WHAT IT DOES NOT DO ──────────────────────────────────────────────
 *
 * A handoff is not a booking. Nothing here may record one, bill for one, or
 * tell a guest a table is held. `commission.mjs` accrues on a CONFIRMED
 * booking and a handoff never reaches it. We logged that we sent someone; that
 * is all we know, and it is all we say.
 */

/**
 * `match` is tested against the page's HTML and against its own URL.
 * `link(url, ask)` returns a prefilled booking URL, or null when the system
 * takes no parameters — in which case the venue's plain link is used and the
 * guest fills the form themselves.
 */
const P = (ask) => ({
  covers: Math.min(Math.max(Number(ask?.party) || 2, 1), 20),
  date: /^\d{4}-\d{2}-\d{2}$/.test(String(ask?.date ?? '')) ? String(ask.date) : null,
  time: /^\d{2}:\d{2}$/.test(String(ask?.time ?? '')) ? String(ask.time) : null,
});

const setp = (u, pairs) => {
  const url = new URL(u);
  for (const [k, v] of Object.entries(pairs)) if (v != null) url.searchParams.set(k, String(v));
  return url.toString();
};

export const SYSTEMS = Object.freeze([
  {
    key: 'opentable', name: 'OpenTable', vertical: 'restaurant', reach: 'partner',
    match: [/opentable\.com/i, /otrestaurant/i, /restref=/i],
    apply: 'https://www.opentable.com/restaurant-solutions/api-partners/become-a-partner/',
    docs: 'https://docs.opentable.com/',
    contact: 'API@opentable.com',
    note: 'Booking API, Sync API and CRM API, with a sandbox. Application and agreement required.',
    link: (u, ask) => {
      const p = P(ask);
      // OpenTable reads a single ISO-ish datetime rather than two fields.
      const dt = p.date ? `${p.date}T${p.time ?? '19:00'}` : null;
      return setp(u, { covers: p.covers, dateTime: dt });
    },
  },
  {
    key: 'resy', name: 'Resy', vertical: 'restaurant', reach: 'partner',
    match: [/resy\.com/i, /widgets\.resy\.com/i, /resy[-_]?widget/i],
    note: 'Widget and internal API exist; third-party booking access is by arrangement.',
    link: (u, ask) => { const p = P(ask); return setp(u, { seats: p.covers, date: p.date }); },
  },
  {
    key: 'sevenrooms', name: 'SevenRooms', vertical: 'restaurant', reach: 'partner',
    match: [/sevenrooms\.com/i, /sr[-_]?widget/i],
    note: 'Marketing names an API and 100+ integrations; the booking side is a partner conversation, not documented publicly. Research before promising.',
    link: (u, ask) => { const p = P(ask); return setp(u, { party_size: p.covers, date: p.date }); },
  },
  {
    key: 'tock', name: 'Tock', vertical: 'restaurant', reach: 'unknown',
    match: [/exploretock\.com/i, /\btock\b.{0,20}reservation/i],
    link: (u, ask) => { const p = P(ask); return setp(u, { size: p.covers, date: p.date, time: p.time }); },
  },
  {
    key: 'yelp', name: 'Yelp Reservations', vertical: 'restaurant', reach: 'none',
    match: [/yelp\.com\/reservations/i, /yelpreservations/i],
    note: 'Yelp has wound its reservations product down over time. Treat as handoff only.',
    link: (u, ask) => { const p = P(ask); return setp(u, { covers: p.covers, date: p.date }); },
  },
  {
    key: 'tablecheck', name: 'TableCheck', vertical: 'restaurant', reach: 'partner',
    match: [/tablecheck\.com/i], note: 'Strong in Japan and APAC; publishes developer documentation.',
    link: (u, ask) => { const p = P(ask); return setp(u, { num_people: p.covers, date: p.date, time: p.time }); },
  },
  {
    key: 'eveve', name: 'Eveve', vertical: 'restaurant', reach: 'unknown',
    match: [/eveve\.com/i, /\beveve\b/i], link: (u, ask) => setp(u, { covers: P(ask).covers }),
  },
  {
    key: 'quandoo', name: 'Quandoo', vertical: 'restaurant', reach: 'partner',
    match: [/quandoo\./i], link: (u, ask) => { const p = P(ask); return setp(u, { capacity: p.covers, date: p.date }); },
  },
  {
    key: 'formitable', name: 'Formitable', vertical: 'restaurant', reach: 'partner',
    match: [/formitable\.com/i], link: (u, ask) => setp(u, { guests: P(ask).covers }),
  },
  {
    key: 'toast', name: 'Toast Tables', vertical: 'restaurant', reach: 'partner',
    match: [/toasttab\.com\/(tables|reservations)/i], link: (u, ask) => setp(u, { partySize: P(ask).covers }),
  },
  {
    key: 'mews', name: 'Mews', vertical: 'hotel', reach: 'open',
    match: [/mews\.com/i, /app\.mews\.com\/distributor/i],
    note: 'Mews Connector API has public documentation and a developer portal.',
    link: (u, ask) => setp(u, { adultCount: P(ask).covers }),
  },
  {
    key: 'cloudbeds', name: 'Cloudbeds', vertical: 'hotel', reach: 'open',
    match: [/cloudbeds\.com/i, /hotels\.cloudbeds\.com/i],
    note: 'Public API documentation and a marketplace onboarding path.',
    link: (u) => u,
  },
  {
    key: 'siteminder', name: 'SiteMinder', vertical: 'hotel', reach: 'partner',
    match: [/siteminder\.com/i, /book-directonline\.com/i], link: (u) => u,
  },
  {
    key: 'mindbody', name: 'Mindbody', vertical: 'spa', reach: 'partner',
    match: [/mindbodyonline\.com/i, /clients\.mindbodyonline/i], link: (u) => u,
  },
  {
    key: 'fresha', name: 'Fresha', vertical: 'salon', reach: 'unknown',
    match: [/fresha\.com/i], link: (u) => u,
  },
  {
    key: 'booksy', name: 'Booksy', vertical: 'salon', reach: 'unknown',
    match: [/booksy\.com/i], link: (u) => u,
  },
  {
    key: 'vagaro', name: 'Vagaro', vertical: 'salon', reach: 'unknown',
    match: [/vagaro\.com/i], link: (u) => u,
  },
  {
    key: 'square', name: 'Square Appointments', vertical: 'salon', reach: 'open',
    match: [/squareup\.com\/appointments/i, /square\.site\/book/i],
    note: 'Square publishes a Bookings API with self-serve OAuth. The POS adapter already speaks Square.',
    link: (u) => u,
  },
  {
    key: 'fareharbor', name: 'FareHarbor', vertical: 'tour', reach: 'partner',
    match: [/fareharbor\.com/i], link: (u) => u,
  },
  {
    key: 'rezdy', name: 'Rezdy', vertical: 'tour', reach: 'open',
    match: [/rezdy\.com/i], note: 'Rezdy runs a distribution marketplace with documented APIs.',
    link: (u) => u,
  },
  {
    key: 'bokun', name: 'Bókun', vertical: 'tour', reach: 'partner',
    match: [/bokun\.io/i, /bokundev/i], link: (u) => u,
  },
  {
    key: 'calendly', name: 'Calendly', vertical: 'other', reach: 'open',
    match: [/calendly\.com/i], link: (u) => u,
  },
]);

const BY_KEY = new Map(SYSTEMS.map((s) => [s.key, s]));
export const systemByKey = (k) => BY_KEY.get(String(k || '').toLowerCase()) ?? null;

/**
 * Read a page and say which systems it shows signs of.
 *
 * Returns ALL matches rather than the best one, in registry order, because a
 * page genuinely can carry two — a hotel running Mews for rooms and SevenRooms
 * for its restaurant is a normal arrangement, and picking one would silently
 * throw away the half we needed. The caller decides which is relevant, usually
 * by the venue's vertical.
 *
 * Deliberately no network here: it is a pure function over text so it can be
 * tested against real saved markup rather than against a live website that
 * changes under the test.
 */
export function detectFromHtml(html, pageUrl = '') {
  const hay = `${String(pageUrl || '')}\n${String(html || '').slice(0, 400000)}`;
  const out = [];
  for (const s of SYSTEMS) {
    if (s.match.some((re) => re.test(hay))) out.push({ key: s.key, name: s.name, reach: s.reach, vertical: s.vertical });
  }
  return out;
}

/**
 * The venue's own booking link with what we know already filled in.
 *
 * Returns null rather than a guess when we hold no link: a booking button that
 * goes to a search page is worse than no button, because the guest believes
 * they have been taken somewhere useful.
 */
export function handoffLink(systemKey, url, ask = {}) {
  if (!url) return null;
  const sys = systemByKey(systemKey);
  try {
    return sys?.link ? sys.link(url, ask) : url;
  } catch {
    // A malformed stored URL must not take down an answer. The plain link is
    // always better than nothing and always better than a thrown error.
    return url;
  }
}

/* ── The integration queue ───────────────────────────────────────────────
 *
 * One row per (system, venue) that we cannot yet book into. It is a queue and
 * not a report: something works it, and the row records what happened.
 *
 * `blocked_on` is the field that decides whether a human is interrupted.
 *   research   nobody has looked yet — the agent's job
 *   build      the door is known and open — the agent's job
 *   dre        a partner agreement, a credential, a signature or money —
 *              which no agent can produce, so a person is emailed
 *   venue      the venue has to switch something on at their end
 */
const QUEUE = `
CREATE TABLE IF NOT EXISTS num_integration_requests (
  id          TEXT PRIMARY KEY,
  system_key  TEXT,
  system_name TEXT NOT NULL,
  place_id    TEXT,
  business_id TEXT,
  venue_name  TEXT,
  booking_url TEXT,
  reach       TEXT NOT NULL DEFAULT 'unknown',
  state       TEXT NOT NULL DEFAULT 'open'
              CHECK (state IN ('open','working','blocked','shipped','dropped')),
  blocked_on  TEXT NOT NULL DEFAULT 'research'
              CHECK (blocked_on IN ('research','build','dre','venue','none')),
  findings    TEXT,
  alerted_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_integreq_state ON num_integration_requests(state, blocked_on);
CREATE UNIQUE INDEX IF NOT EXISTS idx_integreq_one
  ON num_integration_requests(system_name, COALESCE(place_id,''));
`;

let qready = false;
async function ensureQueue(env) {
  if (qready || !env?.DB) return;
  await env.DB.batch(QUEUE.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  qready = true;
}
export function __resetQueueReady() { qready = false; }

/**
 * Ask for an integration. Idempotent per (system, place) — a venue that says
 * "OpenTable" three times through three different forms is one piece of work,
 * and three rows would be three people researching the same thing.
 */
export async function requestIntegration(env, {
  systemKey = null, systemName, placeId = null, businessId = null,
  venueName = null, bookingUrl = null, note = null,
} = {}) {
  const name = String(systemName || systemByKey(systemKey)?.name || '').trim();
  if (!env?.DB || !name) return { ok: false, error: 'no_system' };
  await ensureQueue(env);

  const sys = systemByKey(systemKey);
  const reach = sys?.reach ?? 'unknown';
  // Where it starts. A system we have never heard of starts at research; one
  // whose door we already documented starts at build; one whose door is a
  // signature starts, honestly, at Dre.
  const blocked = reach === 'unknown' ? 'research' : reach === 'partner' ? 'dre' : 'build';
  const id = `ir_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;

  await env.DB.prepare(
    `INSERT INTO num_integration_requests
       (id, system_key, system_name, place_id, business_id, venue_name, booking_url, reach, blocked_on, findings)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
     ON CONFLICT(system_name, COALESCE(place_id,'')) DO UPDATE SET
       business_id = COALESCE(excluded.business_id, num_integration_requests.business_id),
       booking_url = COALESCE(excluded.booking_url, num_integration_requests.booking_url),
       venue_name  = COALESCE(excluded.venue_name,  num_integration_requests.venue_name),
       updated_at  = datetime('now')`,
  ).bind(
    id, sys?.key ?? null, name, placeId, businessId, venueName, bookingUrl, reach, blocked,
    note ? String(note).slice(0, 2000) : (sys?.note ?? null),
  ).run().catch(() => {});

  const row = await env.DB.prepare(
    "SELECT * FROM num_integration_requests WHERE system_name = ?1 AND COALESCE(place_id,'') = COALESCE(?2,'')",
  ).bind(name, placeId).first().catch(() => null);
  return { ok: true, request: row, needsHuman: row?.blocked_on === 'dre' };
}

/** What the agent should pick up next. Oldest first — a queue, not a stack. */
export async function openWork(env, { limit = 20 } = {}) {
  if (!env?.DB) return [];
  await ensureQueue(env);
  const { results } = await env.DB.prepare(
    `SELECT * FROM num_integration_requests
      WHERE state IN ('open','working') AND blocked_on IN ('research','build')
      ORDER BY created_at ASC LIMIT ?1`,
  // An unreadable queue is not an empty queue. Swallowing this would make the
  // agent report "nothing to do" for ever, quietly, which is the exact shape
  // of failure the drain and the consent gate both took months to notice.
  ).bind(limit).all();
  return results ?? [];
}

/** What only a person can unblock, and has not been told about yet. */
export async function needsHuman(env, { limit = 20 } = {}) {
  if (!env?.DB) return [];
  await ensureQueue(env);
  const { results } = await env.DB.prepare(
    `SELECT * FROM num_integration_requests
      WHERE state IN ('open','working','blocked') AND blocked_on = 'dre' AND alerted_at IS NULL
      ORDER BY created_at ASC LIMIT ?1`,
  // And here least of all: an error swallowed here means Dre is never told
  // about the work only he can do, and nothing anywhere says so.
  ).bind(limit).all();
  return results ?? [];
}

export async function recordProgress(env, id, { state, blockedOn, findings } = {}) {
  if (!env?.DB || !id) return { ok: false };
  await ensureQueue(env);
  await env.DB.prepare(
    `UPDATE num_integration_requests
        SET state      = COALESCE(?2, state),
            blocked_on = COALESCE(?3, blocked_on),
            findings   = COALESCE(?4, findings),
            updated_at = datetime('now')
      WHERE id = ?1`,
  ).bind(id, state ?? null, blockedOn ?? null, findings ? String(findings).slice(0, 4000) : null)
    .run().catch(() => {});
  return { ok: true };
}

export async function markAlerted(env, ids = []) {
  if (!env?.DB || !ids.length) return;
  await ensureQueue(env);
  for (const id of ids) {
    await env.DB.prepare("UPDATE num_integration_requests SET alerted_at = datetime('now') WHERE id = ?1")
      .bind(id).run().catch(() => {});
  }
}

/**
 * Fetch a venue's own website and read what it books on.
 *
 * Separate from `detectFromHtml` because that one is a pure function and this
 * one is the internet: it times out, it 403s at a bot wall, it redirects to a
 * parked domain. Every one of those is a normal Tuesday and none of them is an
 * error worth failing a signup over, so this returns `{ ok:false, reason }`
 * and the caller falls back to asking the venue — which is what the claim form
 * does anyway.
 *
 * Only the homepage, and only the first 400 KB of it. A booking widget lives
 * above the fold or in the page's script tags; crawling a site to find one is
 * a different program with a different budget.
 */
export async function detectForWebsite(url, { timeoutMs = 6000, fetchImpl = fetch } = {}) {
  let target;
  try {
    target = new URL(/^https?:\/\//i.test(String(url)) ? String(url) : `https://${url}`);
  } catch { return { ok: false, reason: 'bad_url', systems: [] }; }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { ok: false, reason: 'bad_scheme', systems: [] };
  }

  const stop = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  let res;
  try {
    res = await fetchImpl(target.toString(), {
      signal: stop,
      redirect: 'follow',
      // Announced, not disguised. A site that does not want to be read by a
      // machine is entitled to say so, and pretending to be a browser to get
      // round that is the beginning of a different kind of company.
      headers: { 'user-agent': 'NUM/1.0 (+https://itsnum.com/for-ai) reservation-system-detector' },
    });
  } catch (e) {
    return { ok: false, reason: `fetch_failed: ${String(e?.message ?? e).slice(0, 80)}`, systems: [] };
  }
  if (!res?.ok) return { ok: false, reason: `http_${res?.status ?? 0}`, systems: [] };

  const html = (await res.text().catch(() => '')).slice(0, 400000);
  if (!html) return { ok: false, reason: 'empty', systems: [] };
  return { ok: true, reason: 'read', url: res.url || target.toString(), systems: detectFromHtml(html, res.url || target.toString()) };
}
