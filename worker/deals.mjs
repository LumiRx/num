/**
 * The public deals feed, and the rule that keeps it out of court.
 *
 * ── WHY IT IS PUBLIC, NOT A MEMBER BENEFIT ────────────────────────────────
 *
 * California B&P §17550.27 defines a "seller of travel discount program" as a
 * membership or benefit program entitling the purchaser to travel services "at
 * a discount or reduced price or preferential treatment NOT MADE GENERALLY
 * AVAILABLE TO THE PUBLIC". A paid tier carrying deals is that, exactly, and
 * NUM cannot register as one: it operates as an exempt agent of a registered
 * agency, so §17550.27(b)(1) is unsatisfiable at any price.
 *
 * The trigger is the words "not made generally available". Give every deal to
 * everybody and the statute is never engaged. So this feed is open, signed in
 * or not, free or paying, and `/perks/` has said "free with every NUM account"
 * since before this file existed. NUM Plus buys room and research. It does not
 * buy anything on this page, and no copy may imply it does.
 *
 * ── WHY THE FEED IS ALLOWED TO BE EMPTY ───────────────────────────────────
 *
 * Asked for on 22 Sep 2026 as "make sure it's always populated". Measured the
 * same night: 0 venues with a promo line, 0 businesses on a paid tier, 0 host
 * offers. A feed that must never be empty, built on a shelf that is empty, is
 * a machine for inventing deals — and an invented deal is the one mistake this
 * product cannot survive, because the guest finds out at the till.
 *
 * So: every row here points at something NUM already holds, or at a condition
 * this file checks itself. `list()` returns `thin: true` and says so rather
 * than padding. The way to fill it is to ask venues for perks, which costs NUM
 * nothing and has never been done.
 *
 * ── AND WHY NOTHING HERE TOUCHES RANKING ──────────────────────────────────
 *
 * Same contract as venuepromo.mjs and venuedisclosure.mjs: a deal annotates a
 * place some ordinary piece of ranking already chose. It never moves one up,
 * never adds one, and is never the reason one venue is suggested over another.
 * /pricing/ says there is no paid placement, in as many words.
 */

import { promoOf, fresh, tierAllowsPromo } from './venuepromo.mjs';

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/** How long a collected deal speaks for itself before it must be seen again. */
export const DEAL_MAX_AGE_DAYS = 90;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_deals (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  dest        TEXT,
  source_kind TEXT NOT NULL,
  source_id   TEXT,
  url         TEXT,
  ends_at     TEXT,
  state       TEXT NOT NULL DEFAULT 'live',
  verified_at TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deals_live ON num_deals (state, dest);
`;

const ready = new WeakSet();
async function ensure(env) {
  if (!env?.DB || ready.has(env.DB)) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready.add(env.DB);
}

/**
 * The standing entries — each one gated on a condition checked HERE.
 *
 * This is the part that would rot into marketing if it were a plain list. A
 * sentence about the weekly draw is only true while a draw is actually being
 * run, and "we take nothing off your fare" is only true once the rail that
 * sets the markup is switched on. Each `when` is the difference between an
 * evergreen truth and a slogan nobody re-checked.
 */
export const STANDING = Object.freeze([
  {
    id: 'ev_concierge',
    kind: 'evergreen',
    title: 'The concierge is free, in every destination NUM covers',
    body: 'Ask for anything, in any language, at any hour. No trial, no countdown, no card. It is free on every plan, including the paid one.',
    url: '/plans/',
    // True as long as the free tier still carries the concierge. Read from the
    // tier table rather than asserted, so the day someone gates it this line
    // leaves the page instead of becoming a lie on a public URL.
    when: async (env) => {
      const { tiers } = await import('./membership.mjs');
      return tiers(env)?.free?.entitlements?.concierge === true;
    },
  },
  {
    id: 'ev_draw',
    kind: 'giveaway',
    title: 'The weekly draw — ten winners, every Friday',
    body: 'Free to enter with any NUM account. No purchase, no paid tier, no entry fee.',
    url: '/giveaway/',
    // Only while a draw week actually has entrants. A giveaway advertised in a
    // week nobody is running is the exact shape of an invented deal.
    when: async (env) => {
      const r = await env.DB.prepare(
        "SELECT COUNT(*) n FROM num_giveaway_entrants WHERE week_start >= date('now','-7 day')",
      ).first().catch(() => null);
      return Number(r?.n ?? 0) > 0;
    },
  },
  {
    id: 'ev_no_markup',
    kind: 'markup',
    title: 'NUM takes nothing off the top of your fare',
    body: 'The fare you see is the fare. NUM earns from the businesses it sends guests to, not from the ticket.',
    url: '/plans/',
    // The markup dial is ours, and this sentence is only true while it is set
    // to zero. Both conditions, or the line does not appear.
    when: (env) => !!env?.LGT_PARTNER_ID && String(env?.NUM_FARE_MARKUP ?? '0') === '0',
  },
]);

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

async function put(env, row) {
  await env.DB.prepare(
    `INSERT INTO num_deals (id, kind, title, body, dest, source_kind, source_id, url, ends_at, state, verified_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'live',?10)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, body=excluded.body, dest=excluded.dest, url=excluded.url,
       ends_at=excluded.ends_at, state='live', verified_at=excluded.verified_at`,
  ).bind(
    row.id, row.kind, clip(row.title, 160), clip(row.body, 400), row.dest ?? null,
    row.source_kind, row.source_id ?? null, row.url ?? null, row.ends_at ?? null, row.verified_at,
  ).run();
}

/**
 * Re-read every source and make the table agree with it.
 *
 * Idempotent on purpose: it runs on a cron and the honest thing for a
 * collector to do on a quiet tick is write the same rows again with a newer
 * `verified_at`. What it must never do is leave a row up that its source no
 * longer supports — so anything not seen this pass, and older than the
 * window, is expired rather than left to age quietly.
 */
export async function collect(env, { now = Date.now() } = {}) {
  if (!env?.DB) return { ok: false, reason: 'no database' };
  await ensure(env);
  const seen = new Set();
  const today = dayOf(now);

  for (const s of STANDING) {
    let on = false;
    try { on = await s.when(env); } catch { on = false; }
    if (!on) continue;
    await put(env, { ...s, source_kind: 'num', source_id: s.id, verified_at: today });
    seen.add(s.id);
  }

  // Venue perks. Read through venuepromo's own freshness and entitlement
  // rules rather than a second copy of them — the day that file tightens, so
  // does this, which is the whole reason it is imported instead of inlined.
  try {
    const { results } = await env.DB.prepare(
      `SELECT p.place_id, p.custom_fields, s.tier, s.renews_at,
              pl.name AS place_name, pl.dest AS place_dest
         FROM num_business_profiles p
         LEFT JOIN num_business_subscriptions s ON s.business_id = p.business_id
         LEFT JOIN places pl ON pl.id = p.place_id
        WHERE p.custom_fields LIKE '%promo_text%'
        LIMIT 500`,
    ).all();
    for (const r of results ?? []) {
      if (!tierAllowsPromo(env, r.tier ?? 'free', r.renews_at, now)) continue;
      const promo = promoOf(r.custom_fields);
      if (!promo || !fresh(promo, now)) continue;
      const id = `perk_${r.place_id}`;
      await put(env, {
        id,
        kind: 'perk',
        // THEIR words, attributed. NUM does not check a venue's offer and must
        // not restate it as its own promise — the same rule promoBlock() puts
        // in front of the model, applied to the page.
        title: `${r.place_name || 'A place on NUM'} says:`,
        body: promo.text,
        dest: r.place_dest ?? null,
        source_kind: 'business',
        source_id: r.place_id,
        url: null,
        verified_at: promo.set_at.slice(0, 10),
      });
      seen.add(id);
    }
  } catch (e) {
    console.warn('[deals] venue perks unreadable this pass', e?.message ?? e);
  }

  // Anything live that this pass did not confirm, and that is past the window,
  // stops being served. The row is kept: the venue owns its words and they
  // come back the moment the source does.
  const cutoff = dayOf(now - DEAL_MAX_AGE_DAYS * 86400_000);
  const expired = await env.DB.prepare(
    "UPDATE num_deals SET state='expired' WHERE state='live' AND verified_at < ?1",
  ).bind(cutoff).run().catch(() => null);

  return {
    ok: true,
    seen: seen.size,
    expired: Number(expired?.meta?.changes ?? 0),
    thin: seen.size < 3,
  };
}

/**
 * The standing entries, evaluated NOW rather than read back.
 *
 * `collect()` persists these on the hour, but a feed whose truest rows only
 * exist because a cron fired is a feed that is blank on the first request
 * after a fresh deploy — which is exactly what the preview showed. These
 * three are cheap to check and are checked anyway, so reading them live
 * costs one tier lookup and one count, and the page is right immediately.
 */
async function standingNow(env) {
  const out = [];
  const today = dayOf(Date.now());
  for (const s of STANDING) {
    let on = false;
    try { on = await s.when(env); } catch { on = false; }
    if (on) out.push({ id: s.id, kind: s.kind, title: s.title, body: s.body, dest: null, url: s.url, verified_at: today });
  }
  return out;
}

/** What the page shows. Never padded, and honest when there is little. */
export async function list(env, { dest = null, limit = 50 } = {}) {
  if (!env?.DB) return { deals: [], thin: true };
  await ensure(env);
  const n = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const sql = dest
    ? `SELECT id, kind, title, body, dest, url, verified_at FROM num_deals
        WHERE state='live' AND (dest = ?1 OR dest IS NULL)
        ORDER BY (dest IS NULL), verified_at DESC LIMIT ${n}`
    : `SELECT id, kind, title, body, dest, url, verified_at FROM num_deals
        WHERE state='live' ORDER BY verified_at DESC LIMIT ${n}`;
  const st = dest ? env.DB.prepare(sql).bind(clip(dest, 60)) : env.DB.prepare(sql);
  const { results } = await st.all().catch(() => ({ results: [] }));
  const stored = results ?? [];
  // Live standing entries first, then whatever the collector has stored, with
  // the stored copy of a standing row dropped rather than shown twice.
  const standing = await standingNow(env);
  const ids = new Set(standing.map((d) => d.id));
  const deals = [...standing, ...stored.filter((d) => !ids.has(d.id))];
  return {
    deals,
    // Said out loud, in the payload, so a thin week is visible to whoever is
    // looking rather than dressed up by whatever renders this.
    thin: deals.filter((d) => d.kind === 'perk').length === 0,
    note: deals.filter((d) => d.kind === 'perk').length === 0
      ? 'No venue perks are running right now. These are the things NUM gives everyone anyway.'
      : null,
  };
}

/** GET /api/deals[?dest=]. Public, cached briefly, no account needed. */
export async function handleDeals(request, env, path = '/') {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'GET only' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
  const url = new URL(request.url);
  const out = await list(env, { dest: url.searchParams.get('dest'), limit: url.searchParams.get('limit') });
  return new Response(JSON.stringify({ ...out, path }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
}
