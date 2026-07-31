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
  usageReady = true;
}

// Published Claude Opus prices, per million tokens. Cache reads are the reason
// the persona sits above the breakpoint — they cost a tenth of fresh input.
const PRICE = { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 };

/**
 * Record what a turn actually cost. Fire-and-forget via ctx.waitUntil: a
 * logging failure must never cost a user their reply.
 */
export async function logUsage(env, { lane, model, specialist, place, usage, ms }) {
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
      `INSERT INTO num_usage (day, lane, model, specialist, place, in_tokens, out_tokens, cache_write, cache_read, ms, micro_usd)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
    ).bind(new Date().toISOString().slice(0, 10), lane, model ?? null, specialist ?? null, place ?? null, i, o, cw, cr, ms ?? null, microUsd).run();
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

async function mintSession(env) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ exp: Date.now() + SESSION_HOURS * 3600_000 })));
  return `${payload}.${await hmac(env, payload)}`;
}

async function sessionValid(env, token) {
  const [payload, sig] = String(token ?? '').split('.');
  if (!payload || !sig) return false;
  if (!safeEq(sig, await hmac(env, payload))) return false;
  try {
    const { exp } = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

async function adminSession(env, req) {
  const b = await readBody(req);
  if (!env.ADMIN_KEY) return json({ error: 'No admin key is configured on this Worker yet.' }, 503);
  if (!safeEq(b.key, env.ADMIN_KEY)) return json({ error: 'That key does not match.' }, 401);
  return json({ token: await mintSession(env), expires_in_hours: SESSION_HOURS });
}

const isAdmin = async (env, req) =>
  !!env.ADMIN_KEY && (await sessionValid(env, req.headers.get('X-Admin-Session')));

const count = async (env, sql, ...binds) => {
  try {
    const r = await env.DB.prepare(sql).bind(...binds).first();
    return r ? Object.values(r)[0] ?? 0 : 0;
  } catch {
    return 0; // a table that doesn't exist yet is a zero, not a 500
  }
};

async function adminOverview(env, url) {
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
    ['guestProfiles', 'SELECT COUNT(*) n FROM num_guest_profiles'],
    // the business side
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

  const [usageByDay, topAsks, recent, leaders, leadsByDest, brainCost, latestBuzz, bizRows, recentReq] = await Promise.all([
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
  });
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
      if (path === '/admin/overview') return await adminOverview(env, url);
      if (path === '/admin/resolve' && post) return await adminResolve(env, request);
      return json({ error: 'not found' }, 404);
    }
    return json({ error: 'not found' }, 404);
  } catch (err) {
    console.error('[console]', path, err?.message ?? err);
    return json({ error: 'that didn’t go through — try again in a moment' }, 500);
  }
}
