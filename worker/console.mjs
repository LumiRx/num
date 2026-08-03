// Two dashboards that read the same database from opposite ends.
//
//   /api/business/*  — what a verified owner sees about their own listing.
//                      Scoped by num_place_owners: you see your places and
//                      nothing else, and that check is on every route.
//   /api/admin/*     — what the operator sees about the whole product.
//                      Gated by the ADMIN_KEY secret. Never reachable from the
//                      app without it, and it returns aggregates plus the few
//                      raw rows an operator genuinely needs to act on.
//
// The admin side also carries the answer to "can we take 100 users?": every
// Claude call writes its real token counts to num_usage, so spend is measured
// rather than estimated.
import { maskPhone } from '../claim/verify.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const readBody = async (req) => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

const USAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS num_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  day TEXT NOT NULL,
  lane TEXT NOT NULL,
  model TEXT,
  specialist TEXT,
  place TEXT,
  in_tokens INTEGER NOT NULL DEFAULT 0,
  out_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  ms INTEGER,
  micro_usd INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_num_usage_day ON num_usage(day);
`;

let usageReady = false;
async function ensureUsage(env) {
  if (usageReady) return;
  await env.DB.batch(USAGE_SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  // Attribution was missing from the original table: turns were counted by
  // lane and by day, so "how much is this costing" had an answer and "who is
  // actually using it" did not. Added by migration rather than a schema bump
  // so existing rows survive — they simply have a null member.
  await env.DB.prepare('ALTER TABLE num_usage ADD COLUMN member_id TEXT').run().catch(() => {});
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_num_usage_member ON num_usage(member_id, day)').run().catch(() => {});
  usageReady = true;
}

// Published Claude Opus prices, per million tokens. Cache reads are the reason
// the persona sits above the breakpoint — they cost a tenth of fresh input.
const PRICE = { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 };

/**
 * Record what a turn actually cost. Fire-and-forget via ctx.waitUntil: a
 * logging failure must never cost a user their reply.
 */
export async function logUsage(env, { lane, model, specialist, place, usage, ms, memberId }) {
  if (!env.DB) return;
  try {
    await ensureUsage(env);
    const i = usage?.input_tokens ?? 0;
    const o = usage?.output_tokens ?? 0;
    const cw = usage?.cache_creation_input_tokens ?? 0;
    const cr = usage?.cache_read_input_tokens ?? 0;
    const microUsd = Math.round(
      ((i * PRICE.in + o * PRICE.out + cw * PRICE.cacheWrite + cr * PRICE.cacheRead) / 1_000_000) * 1_000_000,
    );
    await env.DB.prepare(
      `INSERT INTO num_usage (day, lane, model, specialist, place, in_tokens, out_tokens, cache_write, cache_read, ms, micro_usd, member_id)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
    ).bind(new Date().toISOString().slice(0, 10), lane, model ?? null, specialist ?? null, place ?? null, i, o, cw, cr, ms ?? null, microUsd, memberId ?? null).run();
  } catch (err) {
    console.warn('[usage]', err?.message ?? err);
  }
}

// ── business side ─────────────────────────────────────────────────────────

/** Every place this member has proved they own. The scope for everything else. */
async function ownedPlaces(env, memberId, phone) {
  const { results } = await env.DB.prepare(
    // Columns match the real num_place_owners (place_id, business_id, claim_id,
    // method, phone, verified_at, revoked_at, member_ref) — an earlier version
    // of this query invented `verified_phone` and `created_at` and 500'd.
    `SELECT p.id, p.name, p.category, p.dest, p.area, p.phone, p.website, p.rating, p.reviews, p.photo_url,
            o.business_id, o.method, o.verified_at AS owned_since
       FROM num_place_owners o JOIN places p ON p.id = o.place_id
      WHERE o.revoked_at IS NULL AND (o.member_ref = ?1 OR (?2 IS NOT NULL AND o.phone = ?2))`,
  ).bind(memberId ?? '', phone ?? null).all();
  return results ?? [];
}

async function businessOverview(env, url) {
  const me = url.searchParams.get('me');
  if (!me) return json({ error: 'me required' }, 400);
  const member = await env.DB.prepare('SELECT id, name, phone FROM num_members WHERE id=?1').bind(me).first();
  if (!member) return json({ error: 'sign up first' }, 404);

  const places = await ownedPlaces(env, me, member.phone);
  if (!places.length) {
    // Not an error: most people are not business owners. Say what to do next.
    return json({ places: [], claimable: true, hint: 'No verified listing on this account yet — claim one to open the business tools.' });
  }

  const ids = places.map((p) => p.id);
  const ph = ids.map((_, i) => '?' + (i + 1)).join(',');
  // What the owner actually wants to know: are people asking for us, and are
  // there events pointed at us.
  const { results: asks } = await env.DB.prepare(
    `SELECT ts, place, asked, summary, status FROM feature_requests ORDER BY id DESC LIMIT 20`,
  ).all().catch(() => ({ results: [] }));
  const { results: events } = await env.DB.prepare(
    `SELECT e.id, e.title, e.day, e.time, e.place, e.slug,
            (SELECT COUNT(*) FROM num_event_guests g WHERE g.event_id=e.id) invited,
            (SELECT COUNT(*) FROM num_event_guests g WHERE g.event_id=e.id AND g.rsvp='yes') yes
       FROM num_events e WHERE e.host_id=?1 OR e.business_id IN (${ph || "''"})
      ORDER BY e.created_at DESC LIMIT 15`,
  ).bind(me, ...ids).all().catch(() => ({ results: [] }));

  return json({
    places: places.map((p) => ({ ...p, phone: p.phone })),
    events: events ?? [],
    // Demand signal, honestly labelled: these are asks Num could not fulfil,
    // not bookings. Pretending otherwise would be inventing revenue.
    demand: (asks ?? []).filter((a) => places.some((p) => (a.summary ?? '').toLowerCase().includes(p.name.toLowerCase().slice(0, 12)))),
    claimable: false,
  });
}

/** Edit the parts of a listing an owner is allowed to change. */
async function businessUpdate(env, req) {
  const b = await readBody(req);
  const me = clip(b.me, 40);
  const member = await env.DB.prepare('SELECT id, phone FROM num_members WHERE id=?1').bind(me ?? '').first();
  if (!member) return json({ error: 'sign up first' }, 404);
  const places = await ownedPlaces(env, me, member.phone);
  const target = places.find((p) => p.id === clip(b.place_id, 60));
  // The verification is the authorisation: no owner row, no edit.
  if (!target) return json({ error: 'not your listing' }, 403);

  await env.DB.prepare(
    'UPDATE places SET phone=COALESCE(?2,phone), website=COALESCE(?3,website), area=COALESCE(?4,area) WHERE id=?1',
  ).bind(target.id, clip(b.phone, 40), clip(b.website, 200), clip(b.area, 80)).run();
  return json({ ok: true, place: await env.DB.prepare('SELECT id, name, phone, website, area FROM places WHERE id=?1').bind(target.id).first() });
}

// ── admin side ────────────────────────────────────────────────────────────

// ── admin auth ────────────────────────────────────────────────────────────
//
// The key never travels in a URL. A URL lands in browser history, in the
// address bar of a screenshot, in the Referer header of every outbound link,
// and in server logs — which is exactly how the old `?admin=<key>` scheme
// leaked. Instead: the key is posted once, exchanged for a short-lived signed
// session, and every later request carries the session in a header.

const SESSION_HOURS = 12;
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(env, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.ADMIN_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

/** Constant-time compare — a length-independent early exit leaks the key. */
function safeEq(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint a session, stamped with WHO it belongs to.
 *
 * The key on its own is a shared secret with no identity attached: every
 * session looks the same, so "who opened the console at 3am" has no answer.
 * Carrying the operator's address in the signed payload costs nothing, cannot
 * be edited without the key, and turns an anonymous door into an attributable
 * one. It is not authentication on its own — the key is still the gate — but
 * it makes the audit log mean something.
 */
async function mintSession(env, who) {
  const payload = b64url(
    new TextEncoder().encode(JSON.stringify({ exp: Date.now() + SESSION_HOURS * 3600_000, who: who ?? null })),
  );
  return `${payload}.${await hmac(env, payload)}`;
}

/** Read the signed payload back, or null if it does not verify. */
async function sessionClaims(env, token) {
  const [payload, sig] = String(token ?? '').split('.');
  if (!payload || !sig) return null;
  if (!safeEq(sig, await hmac(env, payload))) return null;
  try {
    const c = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof c.exp === 'number' && c.exp > Date.now() ? c : null;
  } catch {
    return null;
  }
}

/** Every admin sign-in, kept. An unauditable admin door is a liability. */
const ADMIN_LOG = `
CREATE TABLE IF NOT EXISTS num_admin_logins (
  id TEXT PRIMARY KEY, who TEXT, ok INTEGER NOT NULL,
  ip TEXT, ua TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;
let adminLogReady = false;
async function logAdmin(env, req, { who, ok }) {
  try {
    if (!adminLogReady) {
      await env.DB.prepare(ADMIN_LOG.trim()).run();
      adminLogReady = true;
    }
    await env.DB.prepare('INSERT INTO num_admin_logins (id, who, ok, ip, ua) VALUES (?1,?2,?3,?4,?5)')
      .bind(
        crypto.randomUUID(),
        who ?? null,
        ok ? 1 : 0,
        // Enough to spot a pattern, not enough to be a tracking log.
        (req.headers.get('CF-Connecting-IP') ?? '').split('.').slice(0, 2).join('.') + '.x.x',
        String(req.headers.get('User-Agent') ?? '').slice(0, 120),
      )
      .run();
  } catch (e) {
    console.warn('[admin] login log failed', e?.message ?? e);
  }
}

const sessionValid = async (env, token) => !!(await sessionClaims(env, token));

async function adminSession(env, req) {
  const b = await readBody(req);
  if (!env.ADMIN_KEY) return json({ error: 'No admin key is configured on this Worker yet.' }, 503);
  const who = env.ADMIN_EMAIL ?? null;
  if (!safeEq(b.key, env.ADMIN_KEY)) {
    // Failures are logged too — a run of them is the only warning you get.
    await logAdmin(env, req, { who: null, ok: false });
    return json({ error: 'That key does not match.' }, 401);
  }
  await logAdmin(env, req, { who, ok: true });
  return json({ token: await mintSession(env, who), who, expires_in_hours: SESSION_HOURS });
}

export const isAdmin = async (env, req) =>
  !!env.ADMIN_KEY && (await sessionValid(env, req.headers.get('X-Admin-Session')));

const count = async (env, sql, ...binds) => {
  try {
    const r = await env.DB.prepare(sql).bind(...binds).first();
    return r ? Object.values(r)[0] ?? 0 : 0;
  } catch {
    return 0; // a table that doesn't exist yet is a zero, not a 500
  }
};

async function adminOverview(env, url, req) {
  await ensureUsage(env);
  const since = Number(url.searchParams.get('days')) || 7;
  const day = new Date(Date.now() - since * 86400_000).toISOString().slice(0, 10);

  // One batch, one round trip. D1 caps the terms in a compound SELECT, so
  // these stay separate statements rather than one big UNION — and a table
  // that does not exist yet resolves to zero instead of failing the request.
  const q = (sql) => env.DB.prepare(sql);
  const COUNTS = [
    ['members', 'SELECT COUNT(*) n FROM num_members'],
    ['verified', 'SELECT COUNT(*) n FROM num_members WHERE phone_verified=1'],
    ['active24', "SELECT COUNT(*) n FROM num_members WHERE seen_at > datetime('now','-1 day')"],
    ['plans', 'SELECT COUNT(*) n FROM num_plans'],
    ['planItems', 'SELECT COUNT(*) n FROM num_plan_items'],
    ['events', 'SELECT COUNT(*) n FROM num_events'],
    ['guests', 'SELECT COUNT(*) n FROM num_event_guests'],
    ['rsvpYes', "SELECT COUNT(*) n FROM num_event_guests WHERE rsvp='yes'"],
    ['invites', 'SELECT COUNT(*) n FROM num_invite_links'],
    ['joined', 'SELECT COUNT(*) n FROM num_invite_links WHERE signed_up_at IS NOT NULL'],
    ['conversions', 'SELECT COUNT(*) n FROM num_referral_conversions'],
    ['gaps', "SELECT COUNT(*) n FROM feature_requests WHERE status='new'"],
    // the website
    ['leads', 'SELECT COUNT(*) n FROM leads'],
    ['leadsNew', "SELECT COUNT(*) n FROM leads WHERE status IS NULL OR status IN ('new','')"],
    ['accounts', 'SELECT COUNT(*) n FROM accounts'],
    // the directory
    ['places', 'SELECT COUNT(*) n FROM places'],
    ['placesPhoto', 'SELECT COUNT(*) n FROM places WHERE photo_url IS NOT NULL'],
    ['destinations', 'SELECT COUNT(*) n FROM destinations'],
    ['buzz', 'SELECT COUNT(*) n FROM buzz'],
    // the LINE / WhatsApp brain
    ['msgs', 'SELECT COUNT(*) n FROM num_messages'],
    ['requests', 'SELECT COUNT(*) n FROM num_requests'],
    ['bookings', 'SELECT COUNT(*) n FROM num_bookings'],
    // ── who is actually here, and are they real ───────────────────────
    // `verified` is the number that matters most: an unverified member is a
    // device, not a person, and reinstalling mints a new one. When this sits
    // far below `members`, friends and plans WILL fragment across identities.
    // PEOPLE, not rows. Identity is device-local, so reinstalling mints a new
    // member row — counting rows counts phones-and-reinstalls, not humans. The
    // last 10 digits are the stable part of a number across the +1/spacing
    // formats we have actually stored, so they are what dedupes.
    ['people', "SELECT COUNT(DISTINCT substr(replace(replace(replace(replace(replace(phone,' ',''),'-',''),'(',''),')',''),'+',''), -10)) n FROM num_members WHERE phone IS NOT NULL"],
    ['redownloads', "SELECT COUNT(*) - COUNT(DISTINCT substr(replace(replace(replace(replace(replace(phone,' ',''),'-',''),'(',''),')',''),'+',''), -10)) n FROM num_members WHERE phone IS NOT NULL"],
    // Rows that never got as far as a number: abandoned first-opens, plus any
    // reinstall that bailed before signing up. Not people, not yet.
    ['anonDevices', 'SELECT COUNT(*) n FROM num_members WHERE phone IS NULL'],
    ['membersVerified', 'SELECT COUNT(*) n FROM num_members WHERE phone_verified = 1'],
    ['members7d', "SELECT COUNT(*) n FROM num_members WHERE created_at > datetime('now','-7 days')"],
    ['members24h', "SELECT COUNT(*) n FROM num_members WHERE created_at > datetime('now','-1 day')"],
    // ── what they ask, and how they reach us ──────────────────────────
    ['questions', 'SELECT COUNT(*) n FROM num_usage'],
    ['questions24h', "SELECT COUNT(*) n FROM num_usage WHERE created_at > datetime('now','-1 day')"],
    ['textsIn', "SELECT COUNT(*) n FROM num_inbox WHERE kind='sms'"],
    ['emailsIn', "SELECT COUNT(*) n FROM num_inbox WHERE kind='email'"],
    ['friendships', "SELECT COUNT(*) n FROM num_links WHERE state='active'"],
    ['plansAll', 'SELECT COUNT(*) n FROM num_plans'],
    ['webVisits', 'SELECT COUNT(*) n FROM num_web_events'],
    // ── growth loops ──────────────────────────────────────────────────
    ['bizReferrals', 'SELECT COUNT(*) n FROM num_biz_referrals'],
    ['bizReferralsLive', "SELECT COUNT(*) n FROM num_biz_referrals WHERE state='active'"],
    ['guestProfiles', 'SELECT COUNT(*) n FROM num_guest_profiles'],
    // the business side
    // ── the Stars economy ──────────────────────────────────────────────
    // Money in circulation is not the same as money at rest: escrow is real
    // Stars that a member no longer controls, so it is counted separately or
    // the totals lie.
    ['starsCirculating', "SELECT COALESCE(SUM(stars),0) n FROM num_star_balances WHERE member_id <> '__escrow__'"],
    ['starsEscrow', "SELECT COALESCE(SUM(stars),0) n FROM num_star_balances WHERE member_id = '__escrow__'"],
    ['starMoves', 'SELECT COUNT(*) n FROM num_star_moves'],
    ['starMoves24', "SELECT COUNT(*) n FROM num_star_moves WHERE created_at > datetime('now','-1 day')"],
    // ── live tabs ─────────────────────────────────────────────────────
    ['tabsOpen', "SELECT COUNT(*) n FROM num_tabs WHERE state='open'"],
    ['tabsAll', 'SELECT COUNT(*) n FROM num_tabs'],
    ['tabItems', 'SELECT COUNT(*) n FROM num_tab_items'],
    ['tabOnBoard', "SELECT COALESCE(SUM(i.stars),0) n FROM num_tab_items i JOIN num_tabs t ON t.id=i.tab_id WHERE t.state='open'"],
    ['tabSettled', 'SELECT COALESCE(SUM(stars),0) n FROM num_tab_settlements'],
    // ── errands ───────────────────────────────────────────────────────
    ['errandsAll', 'SELECT COUNT(*) n FROM num_errands'],
    ['errandsLive', "SELECT COUNT(*) n FROM num_errands WHERE state NOT IN ('settled','cancelled')"],
    ['errandsOpen', "SELECT COUNT(*) n FROM num_errands WHERE state='open'"],
    ['errandsDisputed', "SELECT COUNT(*) n FROM num_errands WHERE state='disputed'"],
    ['errandsPaid', "SELECT COALESCE(SUM(bounty),0) n FROM num_errands WHERE state='settled'"],
    ['errandsCommitted', "SELECT COALESCE(SUM(bounty + spend_cap),0) n FROM num_errands WHERE state NOT IN ('settled','cancelled')"],
    // ── reach ─────────────────────────────────────────────────────────
    ['pushSubs', 'SELECT COUNT(*) n FROM num_push_subs'],
    ['pushDead', 'SELECT COUNT(*) n FROM num_push_subs WHERE fails >= 5'],
    ['notifsSent', 'SELECT COUNT(*) n FROM num_notifications'],
    ['notifsDelivered', 'SELECT COUNT(*) n FROM num_notifications WHERE delivered_at IS NOT NULL'],
    // ── partners ──────────────────────────────────────────────────────
    ['airCalls', 'SELECT COUNT(*) n FROM num_air_exchanges'],
    ['airFailed', 'SELECT COUNT(*) n FROM num_air_exchanges WHERE ok=0'],
    ['sabreBookings', 'SELECT COUNT(*) n FROM num_sabre_bookings'],
    ['sabreFailed', 'SELECT COUNT(*) n FROM num_sabre_bookings WHERE ok=0'],
    ['businesses', 'SELECT COUNT(*) n FROM businesses'],
    ['claims', 'SELECT COUNT(*) n FROM num_claims'],
    ['owners', 'SELECT COUNT(*) n FROM num_place_owners'],
  ];

  const settle = async (stmt, fallback) => {
    try {
      return await stmt;
    } catch {
      return fallback;
    }
  };
  const nums = await Promise.all(COUNTS.map(([, sql]) => settle(q(sql).first(), { n: 0 })));
  const c = Object.fromEntries(COUNTS.map(([k], i) => [k, nums[i]?.n ?? 0]));

  const [usageByDay, topAsks, recent, leaders, leadsByDest, brainCost, latestBuzz, bizRows, recentReq, errandStates, recentErrands, starKinds, topUsers, retention] = await Promise.all([
    settle(
      q(`SELECT day, lane, COUNT(*) turns, SUM(in_tokens) in_tokens, SUM(out_tokens) out_tokens,
                SUM(cache_read) cache_read, SUM(micro_usd) micro_usd, AVG(ms) avg_ms
           FROM num_usage WHERE day >= '${day}' GROUP BY day, lane ORDER BY day DESC`).all(),
      { results: [] },
    ),
    settle(q('SELECT id, ts, place, summary, suggestion, status FROM feature_requests ORDER BY id DESC LIMIT 25').all(), { results: [] }),
    settle(q('SELECT id, name, phone, phone_verified, dest, created_at, seen_at FROM num_members ORDER BY created_at DESC LIMIT 25').all(), { results: [] }),
    settle(
      q(`SELECT c.code, c.owner_id, c.owner_type, COUNT(v.code) joined
           FROM num_referral_codes c LEFT JOIN num_referral_conversions v ON v.code=c.code
          GROUP BY c.code ORDER BY joined DESC LIMIT 12`).all(),
      { results: [] },
    ),
    settle(q('SELECT dest, COUNT(*) n FROM leads GROUP BY dest ORDER BY n DESC LIMIT 12').all(), { results: [] }),
    settle(
      q(`SELECT tier, COUNT(*) calls, SUM(in_tokens) in_tokens, SUM(out_tokens) out_tokens, AVG(ms) avg_ms
           FROM num_llm_calls GROUP BY tier ORDER BY calls DESC`).all(),
      { results: [] },
    ),
    settle(q('SELECT dest, title, publisher, kind, published_at FROM buzz ORDER BY seen_at DESC LIMIT 10').all(), { results: [] }),
    settle(
      q(`SELECT b.id, b.name, b.category, b.status, p.commerce_status, p.country, p.phone_e164, p.website
           FROM businesses b LEFT JOIN num_business_profiles p ON p.business_id=b.id
          ORDER BY b.created_at DESC LIMIT 15`).all(),
      { results: [] },
    ),
    settle(
      q(`SELECT id, vertical, intent, status, area, party_size, created_at FROM num_requests ORDER BY created_at DESC LIMIT 12`).all(),
      { results: [] },
    ),
    settle(q('SELECT state, COUNT(*) n, COALESCE(SUM(bounty),0) bounty FROM num_errands GROUP BY state').all(), { results: [] }),
    settle(
      q(`SELECT e.id, e.title, e.state, e.bounty, e.spend_cap, e.place, e.created_at,
                p.name AS poster, r.name AS runner
           FROM num_errands e
           LEFT JOIN num_members p ON p.id=e.poster_id LEFT JOIN num_members r ON r.id=e.runner_id
          ORDER BY e.rowid DESC LIMIT 15`).all(),
      { results: [] },
    ),
    settle(q("SELECT kind, COUNT(*) n, COALESCE(SUM(ABS(delta)),0) volume FROM num_star_moves GROUP BY kind ORDER BY n DESC").all(), { results: [] }),
    // Who is actually using it, and how much. Turns per member is the closest
    // thing to a real engagement number this product has — signups measure
    // curiosity, this measures use.
    settle(
      q(`SELECT u.member_id, m.name, COUNT(*) turns, MAX(u.day) last_day,
                COALESCE(SUM(u.micro_usd),0) micro_usd
           FROM num_usage u LEFT JOIN num_members m ON m.id = u.member_id
          WHERE u.member_id IS NOT NULL
          GROUP BY u.member_id ORDER BY turns DESC LIMIT 20`).all(),
      { results: [] },
    ),
    // The retention shape, in one row. Anyone can get signups; the gap between
    // these three is whether the thing is actually worth opening again.
    settle(
      q(`SELECT
           (SELECT COUNT(*) FROM num_members WHERE seen_at > datetime('now','-1 day')) d1,
           (SELECT COUNT(*) FROM num_members WHERE seen_at > datetime('now','-7 day')) d7,
           (SELECT COUNT(*) FROM num_members WHERE seen_at > datetime('now','-30 day')) d30,
           (SELECT COUNT(DISTINCT member_id) FROM num_usage WHERE member_id IS NOT NULL) ever_asked`).first(),
      {},
    ),
  ]);

  const spend = (usageByDay.results ?? []).reduce((n, r) => n + (r.micro_usd ?? 0), 0) / 1_000_000;
  const turns = (usageByDay.results ?? []).reduce((n, r) => n + (r.turns ?? 0), 0);

  return json({
    app: {
      members: c.members, verified: c.verified, active24: c.active24,
      plans: c.plans, planItems: c.planItems, events: c.events, guests: c.guests, rsvpYes: c.rsvpYes,
      invites: c.invites, joined: c.joined, conversions: c.conversions,
      recent: (recent.results ?? []).map((r) => ({ ...r, phone: maskPhone(r.phone) })),
      referrals: leaders.results ?? [],
    },
    // itsnum.com — the same database, the other front door.
    site: { leads: c.leads, leadsNew: c.leadsNew, accounts: c.accounts, byDest: leadsByDest.results ?? [] },
    // The LINE / WhatsApp concierge, which predates the app and shares num-db.
    brain: {
      messages: c.msgs, requests: c.requests, bookings: c.bookings, guests: c.guestProfiles,
      byTier: brainCost.results ?? [], recentRequests: recentReq.results ?? [],
    },
    directory: { places: c.places, withPhoto: c.placesPhoto, destinations: c.destinations, buzz: c.buzz, latestBuzz: latestBuzz.results ?? [] },
    business: { businesses: c.businesses, claims: c.claims, owners: c.owners, rows: bizRows.results ?? [] },
    ai: {
      window_days: since,
      turns,
      spend_usd: Number(spend.toFixed(4)),
      per_turn_usd: turns ? Number((spend / turns).toFixed(5)) : 0,
      by_day: usageByDay.results ?? [],
    },
    product: { open_feature_requests: c.gaps, asks: topAsks.results ?? [] },

    // ── the Stars economy ───────────────────────────────────────────────
    // `escrow_balanced` is the one number worth alerting on. Escrow held must
    // equal what live errands have committed; if they ever drift, money moved
    // without an errand moving, and that is a bug you want to hear about from
    // this dashboard rather than from the person who lost the Stars.
    money: {
      circulating: c.starsCirculating,
      escrow_held: c.starsEscrow,
      escrow_committed: c.errandsCommitted,
      escrow_balanced: c.starsEscrow === c.errandsCommitted,
      moves_total: c.starMoves,
      moves_24h: c.starMoves24,
      by_kind: starKinds.results ?? [],
    },
    tabs: {
      open: c.tabsOpen,
      all_time: c.tabsAll,
      items: c.tabItems,
      on_open_tabs: c.tabOnBoard,
      settled_value: c.tabSettled,
    },
    errands: {
      all_time: c.errandsAll,
      live: c.errandsLive,
      open: c.errandsOpen,
      // Disputes are the health metric here. A marketplace with a rising
      // dispute rate is failing quietly, well before anyone complains.
      disputed: c.errandsDisputed,
      bounties_paid: c.errandsPaid,
      by_state: errandStates.results ?? [],
      recent: recentErrands.results ?? [],
    },
    reach: {
      push_subscriptions: c.pushSubs,
      push_dead: c.pushDead,
      notifications_queued: c.notifsSent,
      notifications_delivered: c.notifsDelivered,
      // Queued but never delivered means the wake-ups are not landing, which
      // looks fine in every other metric.
      delivery_rate: c.notifsSent ? Number((c.notifsDelivered / c.notifsSent).toFixed(3)) : null,
    },
    partners: {
      air_calls: c.airCalls,
      air_failed: c.airFailed,
      sabre_operations: c.sabreBookings,
      sabre_failed: c.sabreFailed,
    },
    // What is ACTUALLY wired right now, read from the same predicates the code
    // paths use rather than a list someone has to remember to update.
    rails: {
      brain: !!env.ANTHROPIC_API_KEY,
      push: !!(env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT),
      courier: !!(env.DOORDASH_DEVELOPER_ID && env.DOORDASH_KEY_ID && env.DOORDASH_SIGNING_SECRET),
      air: !!(env.AIR_MCP_URL && env.AIR_API_KEY),
      flight_shopping: !!(env.SABRE_CLIENT_ID && env.SABRE_CLIENT_SECRET),
      sabre_point_of_sale: env.SABRE_PCC ?? null,
      sabre_environment: env.SABRE_ENV === 'prod' ? 'production' : 'certification',
      booking: env.SABRE_BOOKING_ENABLED === 'true',
      sms: false,
    },
    // Who is looking, and who has looked. Read back out of the signed session
    // rather than from a header, so it cannot be spoofed by the caller.
    // Engagement, kept separate from headcount on purpose: members is a
    // vanity number, turns-per-person is the one that moves when the product
    // is good.
    engagement: {
      active_1d: retention?.d1 ?? 0,
      active_7d: retention?.d7 ?? 0,
      active_30d: retention?.d30 ?? 0,
      ever_asked: retention?.ever_asked ?? 0,
      top_users: topUsers.results ?? [],
    },
    operator: {
      signed_in_as: (await sessionClaims(env, req?.headers.get('X-Admin-Session')))?.who ?? null,
      configured: env.ADMIN_EMAIL ?? null,
      recent_logins: (
        await settle(
          q('SELECT who, ok, ip, created_at FROM num_admin_logins ORDER BY rowid DESC LIMIT 10').all(),
          { results: [] },
        )
      ).results ?? [],
    },
  });
}

/**
 * The call queue: every verified claim no human has phoned yet, oldest first.
 *
 * WHY THIS EXISTS
 * /claim tells a business, in writing: "A person from our team checks the
 * listing against public records and gets in touch on the number you gave us.
 * Usually within one working day." Until this route there was no list of who
 * that was. A claim verified by SMS never passes through adminDecide, so it
 * leaves no decided_at, and the only other surface was the overview's 15-row
 * recent-businesses table, which has no contacted state and silently drops the
 * sixteenth. With 500 invites landing at once that is a promise the system
 * cannot keep and cannot even see itself failing to keep.
 *
 * Being contacted is recorded as a num_claim_events row rather than a new
 * column: that table is already the claim's audit trail, a phone call is an
 * event, and the queue therefore drains without a migration.
 */
async function adminClaims(env, url) {
  const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);

  // Age runs from created_at, not from verification: the clock the business is
  // counting starts when they filled the form, and created_at is the one
  // timestamp every claim has.
  const AGE = "ROUND((julianday('now') - julianday(c.created_at)) * 24, 1)";
  const UNCALLED =
    "NOT EXISTS (SELECT 1 FROM num_claim_events e WHERE e.claim_id = c.id AND e.event = 'contacted')";

  const [queue, review, tally] = await Promise.all([
    env.DB.prepare(
      `SELECT c.id, c.place_id, c.business_id, c.claimant_name, c.claimant_phone,
              c.claimant_email, c.channel, c.created_at, ${AGE} AS age_h,
              p.name AS place_name, p.area, p.dest, p.country,
              b.name AS business_name, pr.phone_e164, pr.vertical, pr.timezone
         FROM num_claims c
         LEFT JOIN places p               ON p.id = c.place_id
         LEFT JOIN businesses b           ON b.id = c.business_id
         LEFT JOIN num_business_profiles pr ON pr.business_id = c.business_id
        WHERE c.state = 'verified' AND ${UNCALLED}
        ORDER BY c.created_at ASC LIMIT ?1`,
    ).bind(limit).all(),
    env.DB.prepare(
      `SELECT c.id, c.place_id, c.claimant_name, c.claimant_phone, c.claimant_email,
              c.review_reason, c.created_at, ${AGE} AS age_h,
              p.name AS place_name, p.area, p.dest
         FROM num_claims c LEFT JOIN places p ON p.id = c.place_id
        WHERE c.state = 'review'
        ORDER BY c.created_at ASC LIMIT 100`,
    ).all(),
    env.DB.prepare(
      `SELECT
         SUM(c.state = 'verified')                    AS verified,
         SUM(c.state = 'review')                      AS in_review,
         SUM(c.state = 'pending')                     AS pending,
         SUM(c.state = 'verified' AND ${UNCALLED})    AS to_call,
         SUM(c.state = 'verified' AND ${UNCALLED}
             AND (julianday('now') - julianday(c.created_at)) * 24 > 24) AS overdue
       FROM num_claims c`,
    ).first(),
  ]);

  const rows = queue.results ?? [];

  // The THIRD claim table. itsnum.com's merchant form (num-growth worker,
  // claim-uk.html — the UK funnel) writes to `claims`, a table this console
  // never read. Sean's Scottish signups were real, stored, and invisible —
  // three workers, three claim tables, one dashboard reading one of them.
  // Merged here rather than migrated, because the growth worker's comment
  // says this table is its system of record and a migration under a live
  // funnel is how signups get lost twice.
  const web = await env.DB.prepare(
    `SELECT c.id, c.business_name, c.contact_name, c.phone, c.email, c.source, c.state, c.created_at,
            ROUND((julianday('now') - julianday(c.created_at)) * 24, 1) AS age_h,
            d.website, d.category, d.rating, d.summary, d.promos, d.state AS research
       FROM claims c
       LEFT JOIN num_biz_dossiers d ON d.claim_id = CAST(c.id AS TEXT)
      WHERE c.state = 'new' ORDER BY c.created_at DESC LIMIT 100`,
  ).all().catch(() => ({ results: [] }));

  return json({
    // Web/UK funnel signups awaiting first contact, each with its dossier:
    // what we found about them and draft promo options for the callback.
    // promos are marked ai_generated — preparation for the call, never sent
    // to the business unreviewed.
    web_signups: (web.results ?? []).map((r) => {
      // Parse defensively: one malformed dossier must cost ONE row's promos,
      // never the whole Claims screen.
      let promos = null;
      try { promos = r.promos ? JSON.parse(r.promos) : null; } catch { promos = { ai_generated: true, unreadable: true }; }
      return { ...r, promos };
    }),
    // The count is the truth even when the list is capped, so a queue longer
    // than the page cannot read as a queue that is finished.
    counts: {
      to_call: tally?.to_call ?? 0,
      overdue: tally?.overdue ?? 0,
      in_review: tally?.in_review ?? 0,
      verified_total: tally?.verified ?? 0,
      pending: tally?.pending ?? 0,
    },
    truncated: rows.length >= limit && (tally?.to_call ?? 0) > rows.length,
    // Past 24h we have missed what the page promised. Say so plainly here
    // rather than leaving an operator to work it out from timestamps.
    to_call: rows.map((r) => ({ ...r, overdue: Number(r.age_h) > 24 })),
    awaiting_review: review.results ?? [],
  });
}

/**
 * Record that a person phoned this claimant.
 *
 * Deliberately NOT routed through claim/verify.mjs's logEvent: that helper
 * swallows its own errors so the audit log can never break the flow it audits,
 * which is right there and wrong here. If this write fails the operator must
 * find out, because otherwise the queue looks drained and the call never
 * happened.
 */
async function adminClaimContacted(env, req) {
  const b = await readBody(req);
  const id = clip(b.claim_id ?? b.id, 64);
  if (!id) return json({ error: 'claim_id required' }, 400);

  const row = await env.DB.prepare('SELECT id, state FROM num_claims WHERE id=?1').bind(id).first();
  if (!row) return json({ error: 'no such claim' }, 404);
  if (row.state !== 'verified')
    return json({ error: `claim is ${row.state}, not verified — there is nothing to call about yet` }, 409);

  const who = clip(b.by, 60) || 'admin';
  const note = b.note ? ': ' + String(b.note).slice(0, 300) : '';
  const res = await env.DB.prepare(
    'INSERT INTO num_claim_events (claim_id, event, detail, ip) VALUES (?1,?2,?3,?4)',
  ).bind(id, 'contacted', who + note, req.headers.get('CF-Connecting-IP') ?? null).run();
  if (!res?.success) return json({ error: 'the call was not recorded — try again' }, 500);

  return json({ ok: true, claim_id: id, by: who });
}

/** Close out a flagged capability gap once it is built or answered. */
async function adminResolve(env, req) {
  const b = await readBody(req);
  const id = Number(b.id);
  if (!id) return json({ error: 'id required' }, 400);
  await env.DB.prepare('UPDATE feature_requests SET status=?2 WHERE id=?1').bind(id, clip(b.status, 20) ?? 'done').run();
  return json({ ok: true });
}

// ── router ────────────────────────────────────────────────────────────────

export async function handleConsole(request, env, path) {
  if (!env.DB) return json({ error: 'dashboards need the database binding' }, 503);
  const url = new URL(request.url);
  const post = request.method === 'POST';
  try {
    if (path.startsWith('/business')) {
      if (path === '/business/overview') return await businessOverview(env, url);
      if (path === '/business/update' && post) return await businessUpdate(env, request);
      return json({ error: 'not found' }, 404);
    }
    if (path.startsWith('/admin')) {
      // The only unauthenticated route: trade the key for a session.
      if (path === '/admin/session' && post) return await adminSession(env, request);
      if (!(await isAdmin(env, request))) return json({ error: 'unauthorized' }, 401);
      if (path === '/admin/overview') return await adminOverview(env, url, request);
      if (path === '/admin/claims' && !post) return await adminClaims(env, url);
      if (path === '/admin/claims/contacted' && post) return await adminClaimContacted(env, request);
      if (path === '/admin/resolve' && post) return await adminResolve(env, request);
      return json({ error: 'not found' }, 404);
    }
    return json({ error: 'not found' }, 404);
  } catch (err) {
    console.error('[console]', path, err?.message ?? err);
    return json({ error: 'that didn’t go through — try again in a moment' }, 500);
  }
}
