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
    `SELECT p.id, p.name, p.category, p.dest, p.area, p.phone, p.website, p.rating, p.reviews, p.photo_url,
            o.business_id, o.method, o.created_at AS owned_since
       FROM num_place_owners o JOIN places p ON p.id = o.place_id
      WHERE o.member_ref = ?1 OR (?2 IS NOT NULL AND o.verified_phone = ?2)`,
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

const isAdmin = (env, req, url) =>
  !!env.ADMIN_KEY && (req.headers.get('X-Admin-Key') === env.ADMIN_KEY || url.searchParams.get('key') === env.ADMIN_KEY);

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
  const since = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 7;
  const day = new Date(Date.now() - since * 86400_000).toISOString().slice(0, 10);

  const [members, verified, active24, plans, planItems, events, guests, rsvpYes, invites, joined, conversions, gaps] =
    await Promise.all([
      count(env, 'SELECT COUNT(*) n FROM num_members'),
      count(env, 'SELECT COUNT(*) n FROM num_members WHERE phone_verified=1'),
      count(env, "SELECT COUNT(*) n FROM num_members WHERE seen_at > datetime('now','-1 day')"),
      count(env, 'SELECT COUNT(*) n FROM num_plans'),
      count(env, 'SELECT COUNT(*) n FROM num_plan_items'),
      count(env, 'SELECT COUNT(*) n FROM num_events'),
      count(env, 'SELECT COUNT(*) n FROM num_event_guests'),
      count(env, "SELECT COUNT(*) n FROM num_event_guests WHERE rsvp='yes'"),
      count(env, 'SELECT COUNT(*) n FROM num_invite_links'),
      count(env, 'SELECT COUNT(*) n FROM num_invite_links WHERE signed_up_at IS NOT NULL'),
      count(env, 'SELECT COUNT(*) n FROM num_referral_conversions'),
      count(env, "SELECT COUNT(*) n FROM feature_requests WHERE status='new'"),
    ]);

  const { results: usageByDay } = await env.DB.prepare(
    `SELECT day, lane, COUNT(*) turns, SUM(in_tokens) in_tokens, SUM(out_tokens) out_tokens,
            SUM(cache_read) cache_read, SUM(micro_usd) micro_usd, AVG(ms) avg_ms
       FROM num_usage WHERE day >= ?1 GROUP BY day, lane ORDER BY day DESC`,
  ).bind(day).all();

  const { results: topAsks } = await env.DB.prepare(
    'SELECT ts, place, summary, suggestion, status FROM feature_requests ORDER BY id DESC LIMIT 25',
  ).all().catch(() => ({ results: [] }));

  const { results: recent } = await env.DB.prepare(
    'SELECT id, name, phone, phone_verified, dest, created_at, seen_at FROM num_members ORDER BY created_at DESC LIMIT 30',
  ).all();

  const { results: leaders } = await env.DB.prepare(
    `SELECT c.code, c.owner_id, c.owner_type, COUNT(v.code) joined
       FROM num_referral_codes c LEFT JOIN num_referral_conversions v ON v.code=c.code
      GROUP BY c.code ORDER BY joined DESC, c.created_at ASC LIMIT 15`,
  ).all().catch(() => ({ results: [] }));

  const spend = (usageByDay ?? []).reduce((n, r) => n + (r.micro_usd ?? 0), 0) / 1_000_000;
  const turns = (usageByDay ?? []).reduce((n, r) => n + (r.turns ?? 0), 0);

  return json({
    people: { members, verified, active24, recent: (recent ?? []).map((r) => ({ ...r, phone: maskPhone(r.phone) })) },
    usage: { plans, planItems, events, guests, rsvpYes, invites, joined, conversions },
    ai: {
      window_days: since,
      turns,
      spend_usd: Number(spend.toFixed(4)),
      per_turn_usd: turns ? Number((spend / turns).toFixed(5)) : 0,
      by_day: usageByDay ?? [],
    },
    product: { open_feature_requests: gaps, asks: topAsks ?? [] },
    referrals: leaders ?? [],
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
      if (!isAdmin(env, request, url)) return json({ error: 'unauthorized' }, 401);
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
