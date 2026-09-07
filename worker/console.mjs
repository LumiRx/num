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
import { DESTINATIONS } from '../scripts/destinations.mjs';
import { NOT_PROBE } from './asks.mjs';

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
  // What did THIS question cost, on which brain? Without a link to the ask,
  // cost is only ever knowable per day and per lane — enough to see a bill
  // rise, never enough to see which kind of question raised it, which is the
  // only fact that lets the router be tuned. Migration, not a schema bump:
  // older rows keep their null and stay countable.
  await env.DB.prepare('ALTER TABLE num_usage ADD COLUMN ask_id INTEGER').run().catch(() => {});
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_num_usage_ask ON num_usage(ask_id)').run().catch(() => {});
  usageReady = true;
}

// Published prices, per MILLION tokens, per model.
//
// Until 11 Aug this table held one entry — Claude Opus — and every other lane
// was logged with zero tokens and zero cost. The effect was not a rounding
// error: the two days DeepSeek carried all the traffic showed up in the ledger
// as FREE, so a report on the outage would have concluded the cheapest days of
// the month were the ones where the product was degraded. An unmetered lane
// does not read as unknown, it reads as zero, and zero is a lie that flatters.
//
// `resolve()` falls back to the Opus row on an unrecognised model. Over-stating
// a cost is a bad estimate; under-stating it is how a budget disappears.
const PRICES = {
  'claude-opus-5':   { in: 5,    out: 25,   cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5': { in: 3,    out: 15,   cacheWrite: 3.75, cacheRead: 0.3 },
  // THE BULK LANE HAD NO PRICE, so every Haiku turn was charged at Opus's
  // rate by the fallback below — 13 calls averaging $0.056 each, within a
  // rounding error of Opus's $0.061. The router's whole case is that the
  // everyday question costs a fifth of the expensive one, and the ledger was
  // quietly reporting that it costs the same. Both the dated id the API
  // returns and the bare name are keyed, because the resolver matches on
  // exactly what the vendor echoed back.
  'claude-haiku-4-5':            { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-haiku-4-5-20251001':   { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  // Bionic-hosted open models. Cached input is priced where the vendor
  // publishes it; where it is not, cacheRead falls back to the input price so
  // we never under-count.
  'deepseek-v4-flash': { in: 0.13, out: 0.26, cacheWrite: 0.13, cacheRead: 0.028 },
  'deepseek-v4-pro':   { in: 1.74, out: 3.48, cacheWrite: 1.74, cacheRead: 0.15 },
  'kimi-k2.6':         { in: 0.95, out: 4.00, cacheWrite: 0.95, cacheRead: 0.16 },
  'kimi-k3':           { in: 3.00, out: 15.0, cacheWrite: 3.00, cacheRead: 0.30 },
  'glm-5.2':           { in: 1.50, out: 4.50, cacheWrite: 1.50, cacheRead: 0.30 },
  // Workers AI is billed in neurons against the Cloudflare plan, not per
  // token. Zero here is TRUE, not missing — and it is the only model where
  // that is so.
  'workers-ai': { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 },
};
const PRICE = PRICES['claude-opus-5'];
const priceFor = (model) => {
  if (!model) return PRICE;
  if (PRICES[model]) return PRICES[model];
  // Workers AI models arrive as '@cf/meta/llama-…' — all neuron-billed.
  if (String(model).startsWith('@cf/')) return PRICES['workers-ai'];
  // VENDOR-PREFIXED NAMES. Bionic echoes the model back as
  // 'deepseek/deepseek-v4-flash' — namespace first — while the price table is
  // keyed on the bare name. Exact-match alone therefore missed it and fell
  // through to the Opus default, which priced the first live DeepSeek turn at
  // $0.026 instead of $0.0007: a 37× overstatement, on the one number the
  // router is judged by. The router looked like it had saved nothing.
  //
  // Falling back to the most expensive price is still the right default for a
  // genuinely unknown model — an under-count hides real spend. But a name we
  // DO know, wearing a namespace, is not unknown.
  const bare = String(model).split('/').pop();
  if (PRICES[bare]) return PRICES[bare];
  console.warn(`[usage] no price for model "${model}" — charging at the default rate`);
  return PRICE;
};

/**
 * Record what a turn actually cost. Fire-and-forget via ctx.waitUntil: a
 * logging failure must never cost a user their reply.
 */
export async function logUsage(env, { lane, model, specialist, place, usage, ms, memberId, askId = null }) {
  if (!env.DB) return;
  try {
    await ensureUsage(env);
    // Two vendor shapes, one ledger. Anthropic reports input_tokens /
    // output_tokens / cache_*; every OpenAI-compatible vendor (Bionic,
    // DeepSeek, Groq) reports prompt_tokens / completion_tokens. Reading only
    // the first shape is exactly why the fallback lanes logged zero.
    const i = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
    const o = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
    const cw = usage?.cache_creation_input_tokens ?? 0;
    const cr = usage?.cache_read_input_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const p = priceFor(model);
    const microUsd = Math.round(
      ((i * p.in + o * p.out + cw * p.cacheWrite + cr * p.cacheRead) / 1_000_000) * 1_000_000,
    );
    await env.DB.prepare(
      `INSERT INTO num_usage (day, lane, model, specialist, place, in_tokens, out_tokens, cache_write, cache_read, ms, micro_usd, member_id, ask_id)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
    ).bind(new Date().toISOString().slice(0, 10), lane, model ?? null, specialist ?? null, place ?? null, i, o, cw, cr, ms ?? null, microUsd, memberId ?? null, askId).run();
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

/**
 * The login that cannot fail silently.
 *
 * A real <form> posts here. The browser carries the submission itself —
 * there is no script to race the page load, no fetch for an updating
 * service worker to abort, no listener to miss, no autofill overlay to
 * confuse. Wrong key → redirect back with ?err=wrong and the gate says so
 * in words. Right key → signed HttpOnly cookie, redirect to the dashboard.
 *
 * Built 8 Aug 2026 after the JS gate produced five distinct flavours of
 * silence, each diagnosed and fixed, each replaced by the next. The lesson
 * is not "fix the sixth" — it is that a login's transport should be the
 * one thing in the page that cannot have a sixth.
 */
/**
 * NUM Ops, rendered by the Worker — the console that cannot not work.
 *
 * Every failure the static gate produced lived in the browser layer: a
 * service worker serving a stale shell, a cookie a profile refused to keep,
 * page JavaScript racing its own load. This route has none of those parts.
 * /api/* bypasses the service worker and the asset cache by construction;
 * the response IS the dashboard, HTML with the numbers already in it, built
 * from the same adminOverview every other view reads.
 *
 * Auth: POST the key (native form), or GET with ?s=<session token>. The
 * token appears in links so Refresh and the range switches keep working —
 * it expires in 12 hours and grants nothing beyond this console. No cookie
 * is required for anything.
 */
const H = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NUM = (v) => Number(v ?? 0).toLocaleString('en-US');

function liteShell(inner) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>NUM Ops</title><style>
body{font:15px/1.5 -apple-system,system-ui,sans-serif;background:#f4f3f0;color:#141414;margin:0;padding:32px 20px;max-width:1080px;margin-inline:auto}
h1{font-size:22px;margin:0 0 4px} .sub{color:#777;font-size:13px;margin:0 0 24px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin:0 0 22px}
.card{background:#fff;border:1px solid #e5e2dc;border-radius:12px;padding:14px 16px}
.card b{display:block;font-size:22px;letter-spacing:-.02em} .card span{color:#777;font-size:12.5px}
.card.warn{border-color:#c0392b} .card.warn b{color:#c0392b}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e2dc;border-radius:12px;overflow:hidden;font-size:13.5px;margin:0 0 22px}
th{ text-align:left;padding:9px 12px;background:#faf9f7;color:#777;font-weight:600;font-size:12px}
td{padding:9px 12px;border-top:1px solid #f0eee9} .ok{color:#1a7f37} .bad{color:#c0392b}
h2{font-size:15px;margin:26px 0 10px}
/* Day-by-day bars. A number tells you today; a shape tells you the direction,
   which is the only thing a morning check is actually for. Pure CSS — a chart
   library on an ops page is a dependency that can break the page it explains. */
.spark{display:flex;align-items:flex-end;gap:3px;height:44px;margin:2px 0 6px}
.spark i{flex:1;background:#141414;border-radius:2px 2px 0 0;min-height:2px;opacity:.85}
.spark i.zero{background:#ddd9d2;opacity:1}
.spark i.hi{background:#1a7f37}
.daytbl td.n{text-align:right;font-variant-numeric:tabular-nums}
.daytbl td.dim{color:#aaa}
.stale{background:#fff;border:1px solid #c0392b;border-left-width:4px;border-radius:12px;padding:14px 16px;margin:0 0 22px}
.stale b{display:block;font-size:20px;color:#c0392b;letter-spacing:-.02em}
.stale span{color:#777;font-size:12.5px}
form{max-width:340px;margin:16vh auto 0;text-align:center}
input{width:100%;padding:12px 14px;border:1px solid #ddd;border-radius:10px;font-size:15px;box-sizing:border-box}
button{width:100%;padding:12px;margin-top:10px;border:0;border-radius:10px;background:#141414;color:#fff;font-size:15px;cursor:pointer}
.err{color:#c0392b;font-weight:700;margin-top:12px} a{color:inherit} .tools{margin:0 0 20px;font-size:13px;color:#777}
</style></head><body>${inner}</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function liteLogin(err = '') {
  return liteShell(`<form method="post" action="/api/admin/console">
    <h1>NUM Ops</h1><p class="sub">Server-rendered console. One key, one page.</p>
    <input type="password" name="key" placeholder="Admin key" autofocus required autocomplete="new-password">
    <button type="submit">Open the console</button>
    ${err ? `<div class="err">${H(err)}</div>` : ''}
  </form>`);
}

/** Rows or empty — a missing table renders as an honest empty state. */
/**
 * A panel's query, returning [] rather than taking the whole console down.
 *
 * The empty array is deliberate — one broken panel must not blank the page —
 * but until 26 Aug 2026 the catch was SILENT, and that silence is why four
 * panels sat empty for weeks with nobody able to tell "no data" from "wrong
 * column name". Three of them were querying created_at on tables whose column
 * is `at`, `ts` and `requested_at`; the fourth asked num_biz_referrals for
 * business_name, which is called biz_name.
 *
 * The worst of them was not even blank. The money tab counts pending cashouts
 * by filtering the rows this returns, so a failed query rendered "0 pending" —
 * not "unknown", but an affirmative statement that nobody was waiting to be
 * paid.
 */
async function rows(env, sql, ...binds) {
  try { return (await env.DB.prepare(sql).bind(...binds).all()).results ?? []; }
  catch (e) {
    console.warn('[console.rows] query failed:', e?.message ?? e, '::', sql.slice(0, 200));
    return [];
  }
}

const TABS = ['overview', 'growth', 'asks', 'guests', 'business', 'onboarding', 'money', 'places', 'infra'];

async function liteConsole(env, req, url) {
  // WHO: a posted key, or a still-valid token in ?s=.
  let token = null;
  if (req.method === 'POST') {
    let key = '';
    try { key = String((await req.formData()).get('key') ?? '').trim(); } catch { /* renders as wrong below */ }
    if (!key || !safeEq(key, env.ADMIN_KEY)) {
      await logAdmin(env, req, { who: null, ok: false });
      return liteLogin('Wrong password.');
    }
    await logAdmin(env, req, { who: env.ADMIN_EMAIL ?? null, ok: true });
    token = await mintSession(env, env.ADMIN_EMAIL ?? null);
  } else {
    const t = url.searchParams.get('s');
    if (!(await sessionValid(env, t))) return liteLogin(t ? 'That session expired — sign in again.' : '');
    token = t;
  }

  const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 30));
  const tab = TABS.includes(url.searchParams.get('tab')) ? url.searchParams.get('tab') : 'overview';
  const since = `datetime('now','-${days} days')`;
  const ovUrl = new URL(req.url); ovUrl.searchParams.set('days', String(days));
  // The same truth every other view reads — parsed back out of the existing
  // endpoint rather than re-implemented, so the numbers cannot drift.
  const d = await (await adminOverview(env, ovUrl, req)).json();
  const app = d.app ?? {}, rev = d.revenue ?? {}, chain = d.chain ?? {}, ai = d.ai ?? {}, m = d.money ?? {};

  const link = (q) => `/api/admin/console?s=${encodeURIComponent(token)}${q}`;

  const nav = TABS.map((t) =>
    t === tab ? `<b>${H(t)}</b>` : `<a href="${link(`&tab=${t}&days=${days}`)}">${H(t)}</a>`).join(' · ');
  const head = `<h1>NUM Ops</h1><p class="sub">${nav}</p>
    <p class="sub">rendered ${H(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC · last ${days} days ·
      <a href="${link(`&tab=${tab}&days=${days}`)}">refresh</a> ·
      window: <a href="${link(`&tab=${tab}&days=7`)}">7d</a> / <a href="${link(`&tab=${tab}&days=30`)}">30d</a> / <a href="${link(`&tab=${tab}&days=90`)}">90d</a></p>`;
  const card = (label, value, sub, warn = false) =>
    `<div class="card${warn ? ' warn' : ''}"><b>${H(value)}</b>${H(label)}<br><span>${H(sub)}</span></div>`;
  const tbl2 = (heads, rws, empty) =>
    `<table><tr>${heads.map((h) => `<th>${H(h)}</th>`).join('')}</tr>${rws.length ? rws.join('') : `<tr><td colspan="${heads.length}">${H(empty)}</td></tr>`}</table>`;

  let body = '';

  if (tab === 'overview') {
    body = `<div class="cards">
      ${card('members', NUM(app.members), `${NUM(app.verified)} verified · ${NUM(app.active24)} active 24h`)}
      ${card('revenue USD', '$' + NUM(rev.usd), `${NUM(rev.paid_total)} paid · ${NUM(rev.paid_24h)} in 24h`)}
      ${card('revenue THB', '฿' + NUM(rev.thb), 'baht bills and tabs')}
      ${card('paying members', NUM(rev.members_paid), `${NUM(rev.recurring)} auto-renew`, (rev.members_paid ?? 0) > (rev.recurring ?? 0))}
      ${card('payment trouble 7d', NUM(rev.trouble_7d), 'failed / refunded / disputed', (rev.trouble_7d ?? 0) > 0)}
      ${card('AI spend', '$' + (ai.spend_usd ?? 0).toFixed(2), `${NUM(ai.turns)} turns · $${(ai.per_turn_usd ?? 0).toFixed(4)}/turn`)}
      ${card('cache', NUM(chain.cache_hits) + ' hits', `${NUM(chain.cache_entries)} answers stored`)}
      ${card('brain failures 24h', NUM(chain.brain_fails_24h), (chain.brain_fails_24h ?? 0) === 0 ? 'every brain healthy' : 'check num_brain_state', (chain.brain_fails_24h ?? 0) > 5)}
      ${card('Stars circulating', NUM(m.circulating), m.escrow_balanced ? 'escrow balanced' : 'ESCROW DRIFT', !m.escrow_balanced)}
    </div>`;
  }

  if (tab === 'growth') {
    // Everything here comes from adminOverview so the console and the JSON API
    // cannot disagree — the drift between "what the dashboard says" and "what
    // the endpoint returns" is how a number stops being trusted.
    const g = d.growth ?? { series: [], verification: {}, funnel: [] };
    const rowsAsc = [...(g.series ?? [])].reverse();
    const v = g.verification ?? {};
    const { signinFunnel, signinReasons } = await import('./signinlog.mjs');
    const [signin, reasons] = await Promise.all([signinFunnel(env, days), signinReasons(env, days)]);

    const bars = (key, hiKey) => {
      const max = Math.max(1, ...rowsAsc.map((r) => r[key] ?? 0));
      return `<div class="spark">${rowsAsc.map((r) => {
        const n = r[key] ?? 0;
        const cls = n === 0 ? 'zero' : (hiKey && r[hiKey] > 0 ? 'hi' : '');
        return `<i class="${cls}" style="height:${Math.round((n / max) * 100)}%" title="${H(r.day)}: ${NUM(n)}"></i>`;
      }).join('')}</div>`;
    };
    const sum = (key) => rowsAsc.reduce((a, r) => a + (r[key] ?? 0), 0);

    // The first thing on the page, and red, because it is the number that
    // decides whether any of the rest matters. A funnel can look healthy all
    // the way down and still convert nobody into a person we can reach.
    const stale = v.days_since_verified == null
      ? ''
      : `<div class="stale">
           <b>${NUM(v.days_since_verified)} days since anyone completed sign-in</b>
           last verified ${H(v.last_verified ?? '—')}<br>
           <span>${NUM(v.stuck_with_phone)} gave a number and never verified ·
             ${NUM(v.anon_no_phone)} never gave one ·
             ${NUM(v.total)} rows total</span>
         </div>`;

    body = `${v.days_since_verified > 2 ? stale : ''}
      <div class="cards">
        ${card('visitors', NUM(sum('visitors')), `${NUM(rowsAsc.at(-1)?.visitors ?? 0)} today · last ${days} days`)}
        ${card('signups', NUM(sum('signups')), `${NUM(sum('verified'))} verified · ${NUM(sum('anon'))} never gave a number`, sum('verified') === 0)}
        ${card('asks', NUM(sum('asks')), `${NUM(sum('unattributed'))} unattributed`)}
        ${card('people asking', NUM(Math.max(...rowsAsc.map((r) => r.askers ?? 0), 0)), 'busiest single day')}
      </div>

      <h2>Visitors — unique per day</h2>${bars('visitors')}
      <h2>Signups — green where at least one verified</h2>${bars('signups', 'verified')}
      <h2>Asks — attributed and not</h2>${bars('asks')}

      <h2>Day by day</h2>
      <table class="daytbl"><tr>
        <th>Day</th><th>Visitors</th><th>Web events</th><th>Signups</th>
        <th>Verified</th><th>No phone</th><th>Asks</th><th>Askers</th><th>Unattributed</th></tr>
        ${[...rowsAsc].reverse().map((r) => `<tr>
          <td>${H(r.day)}</td>
          <td class="n">${NUM(r.visitors)}</td>
          <td class="n dim">${NUM(r.events)}</td>
          <td class="n">${NUM(r.signups)}</td>
          <td class="n ${r.verified > 0 ? 'ok' : (r.signups > 0 ? 'bad' : 'dim')}">${NUM(r.verified)}</td>
          <td class="n dim">${NUM(r.anon)}</td>
          <td class="n">${NUM(r.asks)}</td>
          <td class="n">${NUM(r.askers)}</td>
          <td class="n dim">${NUM(r.unattributed)}</td>
        </tr>`).join('')}
      </table>

      <h2>Sign-in — the step everything else feeds</h2>
      <p class="tools">sent vs entered is the diagnostic. Sent high and entered zero is a product
        problem; sent zero is a provider problem. They need different people.</p>
      ${tbl2(['Day', 'Send attempts', 'Codes sent', 'Codes entered', 'Verified'], signin.map((r) =>
        `<tr><td>${H(r.day)}</td><td>${NUM(r.send_attempts)}</td>
             <td class="${r.sent > 0 ? '' : 'bad'}">${NUM(r.sent)}</td>
             <td>${NUM(r.entered)}</td>
             <td class="${r.verified > 0 ? 'ok' : 'bad'}">${NUM(r.verified)}</td></tr>`),
        'No sign-in attempts recorded — instrumentation shipped 23 Aug, rows appear as people try.')}
      ${reasons.length ? `<h2>Why they failed</h2>${tbl2(['Stage', 'Outcome', 'Reason', 'Via', 'Count'], reasons.map((r) =>
        `<tr><td>${H(r.stage)}</td><td class="bad">${H(r.outcome)}</td><td>${H(r.reason)}</td><td>${H(r.via)}</td><td>${NUM(r.n)}</td></tr>`), '')}` : ''}

      <h2>Website funnel — people, not page views</h2>
      ${tbl2(['Step', 'People', 'Events'], (g.funnel ?? []).map((r) =>
        `<tr><td>${H(r.event)}</td><td>${NUM(r.v)}</td><td>${NUM(r.n)}</td></tr>`),
        'No web events in this window.')}

      <h2>Where signups came from</h2>
      ${tbl2(['Source', 'Campaign', 'Signups', 'Verified'], (app.by_source ?? []).map((r) =>
        `<tr><td>${H(r.source)}</td><td>${H(r.campaign || '—')}</td><td>${NUM(r.signups)}</td><td class="${r.verified > 0 ? 'ok' : 'bad'}">${NUM(r.verified)}</td></tr>`),
        'No signups in this window.')}`;
  }

  if (tab === 'asks') {
    // Our own probes ask a real question every few minutes; without this
    // predicate they were 61% of the feed and 46% of "pain".
    const feed = await rows(env, `SELECT text, category, dest, lane, brain, degraded, cached, ts FROM num_asks WHERE ts > ${since} AND ${NOT_PROBE} ORDER BY id DESC LIMIT 50`);
    const cats = await rows(env, `SELECT COALESCE(category,'(uncategorised)') c, COALESCE(dest,'?') dest, COUNT(*) n FROM num_asks WHERE ts > ${since} AND ${NOT_PROBE} GROUP BY 1,2 ORDER BY n DESC LIMIT 15`);
    const pain = await rows(env, `SELECT text, dest, ts FROM num_asks WHERE degraded=1 AND ts > ${since} AND ${NOT_PROBE} ORDER BY id DESC LIMIT 15`);
    const gaps = await rows(env, `SELECT summary, place, status, ts FROM feature_requests ORDER BY id DESC LIMIT 12`);
    body = `<h2>What guests are asking (scrubbed at write — emails and numbers never stored)</h2>
      ${tbl2(['Question', 'Cat', 'Dest', 'Answered by', 'When'], feed.map((r) =>
        `<tr><td>${H(r.text)}</td><td>${H(r.category ?? '—')}</td><td>${H(r.dest ?? '—')}</td><td class="${r.degraded ? 'bad' : ''}">${r.cached ? 'cache' : H(r.brain ?? r.lane ?? '—')}${r.degraded ? ' (degraded)' : ''}</td><td>${H(r.ts)}</td></tr>`),
        'No asks recorded yet — capture shipped 8 Aug, rows appear as guests talk.')}
      <h2>Top categories by destination</h2>
      ${tbl2(['Category', 'Dest', 'Asks'], cats.map((r) => `<tr><td>${H(r.c)}</td><td>${H(r.dest)}</td><td>${NUM(r.n)}</td></tr>`), 'Nothing yet.')}
      <h2>Asks we failed — the roadmap</h2>
      ${tbl2(['Question', 'Dest', 'When'], pain.map((r) => `<tr><td>${H(r.text)}</td><td>${H(r.dest ?? '—')}</td><td>${H(r.ts)}</td></tr>`), 'No degraded answers in this window.')}
      <h2>Capability gaps the model flagged itself</h2>
      ${tbl2(['Summary', 'Place', 'Status', 'When'], gaps.map((r) => `<tr><td>${H(r.summary)}</td><td>${H(r.place ?? '—')}</td><td>${H(r.status)}</td><td>${H(r.ts)}</td></tr>`), 'None flagged.')}`;
  }

  if (tab === 'guests') {
    const bySource = app.by_source ?? [];
    const hosts = await rows(env, `SELECT m.name, m.dest, COUNT(e.id) events FROM num_members m JOIN num_events e ON e.host_id = m.id GROUP BY m.id ORDER BY events DESC LIMIT 12`);
    const tiers = await rows(env, `SELECT tier, COUNT(*) n, SUM(CASE WHEN stripe_sub IS NOT NULL THEN 1 ELSE 0 END) recurring FROM num_memberships GROUP BY tier`);
    body = `<div class="cards">
      ${card('members', NUM(app.members), `${NUM(app.verified)} verified`)}
      ${card('people (deduped)', NUM(d.app?.people ?? app.members), `${NUM(d.app?.redownloads ?? 0)} reinstalls`)}
      ${card('active 24h', NUM(app.active24), `${NUM(app.plans)} plans · ${NUM(app.events)} events`)}
      ${card('friendships', NUM(d.app?.friendships ?? 0), 'active links')}
    </div>
    <h2>Signups by source (verified is the honest column)</h2>
    ${tbl2(['Source', 'Campaign', 'Signups', 'Verified'], bySource.map((r) =>
      `<tr><td>${H(r.source)}</td><td>${H(r.campaign || '—')}</td><td>${NUM(r.signups)}</td><td class="${(r.verified ?? 0) > 0 ? 'ok' : ''}">${NUM(r.verified ?? 0)}</td></tr>`), 'No signups in window.')}
    <h2>Hosts — members who bring other people</h2>
    ${tbl2(['Name', 'Dest', 'Events hosted'], hosts.map((r) => `<tr><td>${H(r.name ?? '—')}</td><td>${H(r.dest ?? '—')}</td><td>${NUM(r.events)}</td></tr>`), 'Nobody has hosted an event yet.')}
    <h2>Membership tiers</h2>
    ${tbl2(['Tier', 'Members', 'Auto-renewing'], tiers.map((r) => `<tr><td>${H(r.tier)}</td><td>${NUM(r.n)}</td><td>${NUM(r.recurring)}</td></tr>`), 'Free only so far.')}
    <h2>Recent members</h2>
    ${tbl2(['Name', 'Phone', 'Status', 'Dest', 'Joined'], (app.recent ?? []).map((r) =>
      `<tr><td>${H(r.name || '—')}</td><td>${H(r.phone || '—')}</td><td class="${r.phone_verified ? 'ok' : ''}">${r.phone_verified ? 'verified' : 'unverified'}</td><td>${H(r.dest || '—')}</td><td>${H(r.created_at ?? '')}</td></tr>`), 'Nobody yet.')}`;
  }

  if (tab === 'business') {
    const biz = d.business ?? {};
    const leadRows = await rows(env, `SELECT name, email, dest, status, created_at FROM leads ORDER BY id DESC LIMIT 15`);
    const refs = await rows(env, `SELECT biz_name AS business_name, state, created_at FROM num_biz_referrals ORDER BY created_at DESC LIMIT 12`);
    const imp = await rows(env, `SELECT p.name, COUNT(*) n FROM num_place_impressions i JOIN places p ON p.id = i.place_id WHERE i.ts > strftime('%s','now') - ${days}*86400 GROUP BY p.id ORDER BY n DESC LIMIT 15`);
    body = `<div class="cards">
      ${card('businesses', NUM(biz.businesses), `${NUM(biz.claims)} claims · ${NUM(biz.owners)} owners`)}
      ${card('site leads', NUM(d.site?.leads ?? 0), `${NUM(d.site?.leadsNew ?? 0)} uncontacted`, (d.site?.leadsNew ?? 0) > 0)}
      ${card('referrals', NUM(d.app?.conversions ?? 0), 'guest-referred businesses')}
    </div>
    <h2>Most-recommended businesses (impressions — the number they pay for)</h2>
    ${tbl2(['Business', 'Times put in front of a guest'], imp.map((r) => `<tr><td>${H(r.name)}</td><td>${NUM(r.n)}</td></tr>`), 'No impressions in window.')}
    <h2>Leads</h2>
    ${tbl2(['Name', 'Email', 'Dest', 'Status', 'When'], leadRows.map((r) =>
      `<tr><td>${H(r.name ?? '—')}</td><td>${H(r.email ?? '—')}</td><td>${H(r.dest ?? '—')}</td><td>${H(r.status ?? 'new')}</td><td>${H(r.created_at ?? '')}</td></tr>`), 'No leads yet.')}
    <h2>Guest referrals of businesses</h2>
    ${tbl2(['Business', 'State', 'When'], refs.map((r) => `<tr><td>${H(r.business_name ?? '—')}</td><td>${H(r.state)}</td><td>${H(r.created_at ?? '')}</td></tr>`), 'None yet.')}`;
  }

  // WHERE IS EVERY BUSINESS, AND WHOSE MOVE IS IT?
  //
  // The `business` tab above counts businesses, claims and owners. Counting
  // them was never the problem: on 30 Aug eight businesses were approved and
  // the honest answer to "are any of them able to operate" was that nobody
  // knew, because no table held it. This tab is that answer.
  //
  // The two lists are deliberately separate and never summed. What NUM owes a
  // business is a debt with a name on it; what a business has not filled in is
  // a nudge. Adding them produces one number that argues for the wrong action.
  //
  // Built from bizagent.rollup — the SAME function the admin API and the
  // per-business agents read. A console that assembled its own version of
  // "ready" would be a second definition, and the second definition is always
  // the one that quietly goes stale.
  if (tab === 'onboarding') {
    let ro = null;
    try { ro = await (await import('./bizagent.mjs')).rollup(env, { limit: 200 }); }
    catch (e) { console.warn('[console.onboarding]', e?.message ?? e); }

    if (!ro) {
      body = '<h2>Business onboarding</h2><p class="tools">Onboarding state could not be read just now.</p>';
    } else {
      const c = ro.counts ?? {};
      const stageLabel = Object.fromEntries((ro.stages ?? []).map((x) => [x.id, x.label]));
      const itemLabel = Object.fromEntries((ro.items ?? []).map((x) => [x.id, x.label]));
      const names = (list) => list.slice(0, 6).map((b) => b.name).join(', ')
        + (list.length > 6 ? ` +${list.length - 6} more` : '');

      body = `<div class="cards">
      ${card('operating', NUM(c.operating), 'set up, reachable, nothing outstanding')}
      ${card('waiting on us', NUM(c.blocked_on_us), 'our move — a debt, not a nudge', (c.blocked_on_us ?? 0) > 0)}
      ${card('waiting on them', NUM(c.blocked_on_them), 'their move — worth a nudge')}
      ${card('agents', NUM(c.agents), `${NUM(c.agents_missing)} business(es) without one`, (c.agents_missing ?? 0) > 0)}
      ${card('never became an account', NUM(c.prospects), 'signed up, no business row', (c.prospects ?? 0) > 0)}
    </div>
    <h2>Our move — grouped by the switch that fixes it</h2>
    <p class="tools">Eleven businesses missing the same thing is one job, not eleven errands.</p>
    ${tbl2(['What we owe', 'Businesses', 'Who'], (ro.our_move ?? []).map((g) =>
        `<tr><td>${H(g.label)}</td><td>${NUM(g.businesses.length)}</td><td>${H(names(g.businesses))}</td></tr>`),
      'Nothing outstanding on our side.')}
    <h2>Every business</h2>
    ${tbl2(['Business', 'Where', 'Stage', 'We owe', 'They owe', 'Cannot see'], (ro.reports ?? []).map((r) =>
        `<tr><td>${H(r.name)}</td><td>${H(r.where ?? '—')}</td>`
        + `<td class="${r.stage === 'operating' ? 'ok' : ''}">${H(stageLabel[r.stage] ?? r.stage)}</td>`
        + `<td class="${r.we_owe.length ? 'bad' : ''}">${H(r.we_owe.map((i) => itemLabel[i] ?? i).join(', ') || '—')}</td>`
        + `<td>${H(r.they_owe.map((i) => itemLabel[i] ?? i).join(', ') || '—')}</td>`
        + `<td>${H(r.cannot_see.join(', ') || '—')}</td></tr>`),
      'No businesses yet.')}
    <h2>Signed up but never became an account</h2>
    <p class="tools">Not a failing of the business. This is the clearest signal a signup door is broken.</p>
    ${tbl2(['Business', 'Contact', 'Email', 'State', 'When'], (ro.prospects ?? []).map((r) =>
        `<tr><td>${H(r.business_name ?? '—')}</td><td>${H(r.contact_name ?? '—')}</td>`
        + `<td>${H(r.email ?? '—')}</td><td>${H(r.state ?? 'new')}</td><td>${H(r.created_at ?? '')}</td></tr>`),
      'None — every signup became an account.')}
    <p class="sub">Onboarding state generated ${H(String(ro.generated_at ?? '').slice(0, 16).replace('T', ' '))} UTC.
      "Cannot see" means the evidence table does not exist yet — not that the business failed to do it.</p>`;
    }
  }

  if (tab === 'money') {
    const cashouts = await rows(env, `SELECT member_id, stars, state, requested_at AS created_at FROM num_cashouts ORDER BY rowid DESC LIMIT 10`);
    const byDayPay = await rows(env, `SELECT date(paid_at) d, currency, COUNT(*) n, SUM(amount_cents)/100.0 amt FROM num_payments WHERE state='paid' AND paid_at > ${since} GROUP BY 1,2 ORDER BY d DESC LIMIT 20`);
    body = `<div class="cards">
      ${card('revenue USD', '$' + NUM(rev.usd), `${NUM(rev.paid_total)} paid`)}
      ${card('revenue THB', '฿' + NUM(rev.thb), 'bills and tabs')}
      ${card('subscriptions', NUM(rev.recurring), `${NUM((rev.members_paid ?? 0) - (rev.recurring ?? 0))} legacy one-off`, (rev.members_paid ?? 0) > (rev.recurring ?? 0))}
      ${card('trouble 7d', NUM(rev.trouble_7d), 'failed / refunded / disputed', (rev.trouble_7d ?? 0) > 0)}
      ${card('Stars circulating', NUM(m.circulating), m.escrow_balanced ? 'escrow balanced' : 'ESCROW DRIFT', !m.escrow_balanced)}
      ${card('cashouts pending', NUM(cashouts.filter((c) => c.state === 'requested').length), 'human approval required, always')}
    </div>
    <h2>Paid by day</h2>
    ${tbl2(['Day', 'Currency', 'Payments', 'Amount'], byDayPay.map((r) =>
      `<tr><td>${H(r.d)}</td><td>${H(r.currency)}</td><td>${NUM(r.n)}</td><td>${r.currency === 'thb' ? '฿' : '$'}${NUM(r.amt)}</td></tr>`), 'Nothing paid in window.')}
    <h2>Recent payments</h2>
    ${tbl2(['Ref', 'Amount', 'State', 'When'], (rev.recent ?? []).map((r) =>
      `<tr><td>${H(r.ref || r.id || '—')}</td><td>${r.currency === 'thb' ? '฿' : '$'}${NUM((r.amount_cents ?? 0) / 100)}${r.mode === 'stripe-sub' ? ' /mo' : ''}</td><td class="${r.state === 'paid' ? 'ok' : r.state === 'created' ? '' : 'bad'}">${H(r.state)}</td><td>${H(r.created_at ?? '')}</td></tr>`), 'No payments yet.')}
    <h2>Cash-out requests (payout desk)</h2>
    ${tbl2(['Member', 'Stars', 'State', 'When'], cashouts.map((r) =>
      `<tr><td>${H(r.member_id)}</td><td>${NUM(r.stars)}</td><td>${H(r.state)}</td><td>${H(r.created_at ?? '')}</td></tr>`), 'No cash-out requests.')}`;
  }

  if (tab === 'places') {
    const dests = await rows(env, `SELECT slug, name, country, live, place_count, last_ingest_at FROM destinations ORDER BY live DESC, place_count DESC LIMIT 40`);
    const wantThere = await rows(env, `SELECT m.dest, COUNT(*) n FROM num_members m LEFT JOIN destinations d ON d.slug = m.dest AND d.live=1 WHERE m.dest IS NOT NULL AND d.slug IS NULL GROUP BY m.dest ORDER BY n DESC LIMIT 10`);
    const nature = await rows(env, `SELECT dest, COUNT(*) n FROM places WHERE category IN ('Beach','Temple','Viewpoint','Waterfall','Park') GROUP BY dest ORDER BY n DESC LIMIT 10`);
    body = `<h2>Destinations (live = approved and serving)</h2>
    ${tbl2(['Destination', 'Country', 'Status', 'Places', 'Last ingest'], dests.map((r) =>
      `<tr><td>${H(r.name)}</td><td>${H(r.country)}</td><td class="${r.live ? 'ok' : ''}">${r.live ? 'LIVE' : 'pending'}</td><td>${NUM(r.place_count)}</td><td>${H(r.last_ingest_at ?? '—')}</td></tr>`), 'No destinations.')}
    <h2>Signups where we have no live coverage — the launch queue</h2>
    ${tbl2(['Requested dest', 'Members waiting'], wantThere.map((r) => `<tr><td>${H(r.dest)}</td><td>${NUM(r.n)}</td></tr>`), 'Every member is somewhere we cover.')}
    <h2>Nature coverage (beaches, temples, viewpoints…)</h2>
    ${tbl2(['Destination', 'Nature places'], nature.map((r) => `<tr><td>${H(r.dest)}</td><td>${NUM(r.n)}</td></tr>`), 'Run the nature ingest for more cities.')}`;
  }

  if (tab === 'infra') {
    const brains = await rows(env, `SELECT brain, fails, class, last_error, cooldown_until FROM num_brain_state ORDER BY fails DESC`);
    const health = await rows(env, `SELECT verdict, detail, at AS created_at FROM num_health ORDER BY id DESC LIMIT 8`);
    const smsD = await rows(env, `SELECT status, COUNT(*) n FROM num_sms_delivery GROUP BY status ORDER BY n DESC LIMIT 8`);
    // The only closed loop NUM has, shown as numbers rather than asserted as a
    // capability. A learning system nobody can inspect is a learning system
    // nobody can catch being wrong — and until 26 Aug 2026 the honest number
    // here was zero, because nothing NUM recorded changed anything NUM did.
    const learn = await import('./learn.mjs')
      .then((m) => m.learningState(env)).catch(() => null);
    const now = Math.floor(Date.now() / 1000);
    body = `<div class="cards">
      ${card('brain failures 24h', NUM(chain.brain_fails_24h), (chain.brain_fails_24h ?? 0) === 0 ? 'all healthy' : 'see table below', (chain.brain_fails_24h ?? 0) > 5)}
      ${card('cache', NUM(chain.cache_hits) + ' hits', `${NUM(chain.cache_entries)} stored — every hit is a free answer`)}
      ${card('push subs', NUM(d.reach?.push_subs ?? 0), `${NUM(d.reach?.push_dead ?? 0)} dead endpoints`)}
    </div>
    <h2>Brains (a cooldown in the future = currently benched)</h2>
    ${tbl2(['Brain', 'Fails', 'Class', 'Last error', 'Benched until'], brains.map((r) =>
      `<tr><td>${H(r.brain)}</td><td>${NUM(r.fails)}</td><td>${H(r.class ?? '—')}</td><td>${H((r.last_error ?? '').slice(0, 60))}</td><td class="${Number(r.cooldown_until) > now ? 'bad' : ''}">${Number(r.cooldown_until) > now ? H(new Date(r.cooldown_until * 1000).toISOString().slice(11, 16)) + ' UTC' : '—'}</td></tr>`), 'No brain has ever failed. Suspicious, but pleasant.')}
    <h2>Health cron verdicts</h2>
    ${tbl2(['Verdict', 'Detail', 'When'], health.map((r) =>
      `<tr><td class="${r.verdict === 'down' ? 'bad' : 'ok'}">${H(r.verdict)}</td><td>${H((r.detail ?? '').slice(0, 80))}</td><td>${H(r.created_at ?? '')}</td></tr>`), 'No cron rows — check the health worker.')}
    <h2>SMS delivery</h2>
    ${tbl2(['Status', 'Count'], smsD.map((r) => `<tr><td>${H(r.status)}</td><td>${NUM(r.n)}</td></tr>`), 'No SMS sent yet.')}
    <h2>What NUM has learned (worker/learn.mjs)</h2>
    ${learn ? tbl2(['Measure', 'Value'], [
      ['Ratings collected from guests', NUM(learn.ratings_collected)],
      ['Places carrying at least one', NUM(learn.places_with_a_rating)],
      [`Places actually moving the ranking (needs ${learn.min_ratings_to_count})`, NUM(learn.places_changing_the_ranking)],
      ['Last rollup', H(learn.last_rollup ?? 'never')],
    ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`), '')
      : '<p class="tools">Learning state unavailable.</p>'}
    <p class="tools">The only part of the ranking NUM learned rather than crawled.
    A place moves up here because people who went said it was good, and for no
    other reason — worker/learn.test.mjs fails the build if money can reach it.</p>
    <p class="tools">External checks: the GitHub uptime probe asks a real question every 5 minutes and fails the workflow on degraded answers.</p>`;
  }

  return liteShell(head + body + `<p class="tools">Session expires in ${SESSION_HOURS}h.</p>`);
}

async function adminLogin(env, req) {
  const to = (q) => new Response(null, { status: 303, headers: { Location: `/ops/${q}` } });
  if (!env.ADMIN_KEY) return to('?err=nokey');
  let key = '';
  try { key = String((await req.formData()).get('key') ?? '').trim(); } catch { /* fall through to wrong */ }
  if (!key || !safeEq(key, env.ADMIN_KEY)) {
    await logAdmin(env, req, { who: null, ok: false });
    return to('?err=wrong');
  }
  const who = env.ADMIN_EMAIL ?? null;
  await logAdmin(env, req, { who, ok: true });
  const token = await mintSession(env, who);
  // Verify the token we are about to hand out, against the same code that will
  // check it on the next request. If this ever fails, the password was right
  // and the session is dead on arrival — which is indistinguishable, from the
  // browser, from a wrong password. Say so instead of redirecting into a
  // login form that will silently reject the user forever.
  if (!(await sessionClaims(env, token))) return to('?err=mint');
  return new Response(null, {
    status: 303,
    headers: {
      // The token rides in BOTH the cookie and the fragment. The fragment
      // (#t=…) never leaves the browser — not sent to any server, not logged
      // anywhere — and the page stores it exactly the way the dashboard has
      // always authenticated. Verified 8 Aug: a browser that accepted the
      // password then silently refused the cookie; with two carriers, either
      // one surviving signs you in.
      Location: `/ops/?in=1#t=${encodeURIComponent(token)}`,
      // HttpOnly: no script can read or leak it. SameSite=Lax: still sent on
      // the redirect and every same-site request, never cross-site.
      'Set-Cookie': `num_ops_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
    },
  });
}

/** Grade a session token WITHOUT revealing anything about the key.
 *
 * Everything here is about a credential the caller already possesses, so it
 * leaks nothing: it only turns a silent 401 into a word. `graded` never
 * returns the token, its payload, or any part of ADMIN_KEY.
 */
export async function gradeSession(env, token) {
  const t = String(token ?? '');
  if (!t) return 'absent';
  const [payload, sig] = t.split('.');
  if (!payload || !sig) return 'malformed';
  if (!safeEq(sig, await hmac(env, payload))) return 'bad-signature';
  let c;
  try { c = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))); }
  catch { return 'unreadable-payload'; }
  if (typeof c.exp !== 'number') return 'no-expiry';
  return c.exp > Date.now() ? 'ok' : 'expired';
}

/** Why was I not signed in? Unauthenticated on purpose — a 401 that will not
 *  say what failed costs more than this endpoint could ever leak. */
async function adminWhy(env, req) {
  return json({
    admin_key: !!env.ADMIN_KEY,
    header: await gradeSession(env, req.headers.get('X-Admin-Session')),
    cookie: await gradeSession(env, sessionCookie(req.headers.get('Cookie'))),
    server_time: new Date().toISOString(),
    session_hours: SESSION_HOURS,
  });
}

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

/** The session token from a Cookie header, or null. */
export function sessionCookie(cookieHeader) {
  const m = /(?:^|;\s*)num_ops_session=([^;]+)/.exec(String(cookieHeader ?? ''));
  return m ? decodeURIComponent(m[1]) : null;
}

export const isAdmin = async (env, req) =>
  !!env.ADMIN_KEY && (
    (await sessionValid(env, req.headers.get('X-Admin-Session')))
    || (await sessionValid(env, sessionCookie(req.headers.get('Cookie'))))
  );

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
    ['questions24h', "SELECT COUNT(*) n FROM num_usage WHERE ts > datetime('now','-1 day')"],
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
    // ── real money (Stripe), distinct from the Stars economy below ─────
    ['payPaid', "SELECT COUNT(*) n FROM num_payments WHERE state='paid'"],
    ['payPaid24', "SELECT COUNT(*) n FROM num_payments WHERE state='paid' AND paid_at > datetime('now','-1 day')"],
    ['payTrouble7d', "SELECT COUNT(*) n FROM num_payments WHERE state IN ('failed','refunded','disputed') AND created_at > datetime('now','-7 days')"],
    ['revenueUsdCents', "SELECT COALESCE(SUM(amount_cents),0) n FROM num_payments WHERE state='paid' AND currency='usd'"],
    ['revenueThbSatang', "SELECT COALESCE(SUM(amount_cents),0) n FROM num_payments WHERE state='paid' AND currency='thb'"],
    ['membersPaidTier', "SELECT COUNT(*) n FROM num_memberships WHERE tier<>'free'"],
    ['subsRecurring', "SELECT COUNT(*) n FROM num_memberships WHERE tier<>'free' AND stripe_sub IS NOT NULL"],
    ['renewsIn7d', "SELECT COUNT(*) n FROM num_memberships WHERE tier<>'free' AND renews_at < datetime('now','+7 days')"],
    // ── is the brain healthy, and is the cache earning its keep ────────
    ['cacheEntries', 'SELECT COUNT(*) n FROM num_answer_cache'],
    ['cacheHits', 'SELECT COALESCE(SUM(hits),0) n FROM num_answer_cache'],
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
  // num_brain_events.ts is epoch SECONDS (see brainstate.mjs) — the cutoff is
  // computed here rather than with datetime(), which compares text.
  COUNTS.push(['brainFails24', `SELECT COUNT(*) n FROM num_brain_events WHERE ts > ${Math.floor(Date.now() / 1000) - 86400}`]);
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
    // ── GROWTH, DAY BY DAY ────────────────────────────────────────────
    //
    // Every other number on this page is a TOTAL. A total cannot answer the
    // only question worth asking in the morning — "is it going up?" — and
    // answering that from the totals means asking someone to remember
    // yesterday's, which nobody does. So: one row per day, four series, and a
    // verification-health block that says out loud how long it has been since
    // anybody completed sign-in.
    //
    // Each series is its own statement. D1 caps the terms in a compound
    // SELECT, and a correlated subquery per day per metric hit that ceiling
    // immediately — which is also why these are stitched in JS below rather
    // than joined in SQL.
    growth: await (async () => {
      const days = Math.max(1, Math.min(90, Number(since) || 14));
      const win = `-${days} days`;
      const [signups, visitors, asks, health] = await Promise.all([
        settle(q(`SELECT substr(created_at,1,10) day, COUNT(*) signups,
                         SUM(phone_verified) verified,
                         SUM(CASE WHEN phone IS NULL THEN 1 ELSE 0 END) anon
                    FROM num_members WHERE created_at > datetime('now','${win}')
                   GROUP BY day`).all(), { results: [] }),
        settle(q(`SELECT substr(created_at,1,10) day, COUNT(DISTINCT visitor_id) visitors, COUNT(*) events
                    FROM num_web_events WHERE created_at > datetime('now','${win}')
                   GROUP BY day`).all(), { results: [] }),
        // Attributed asks only. Before anon_id shipped, unattributed rows
        // were counted as usage and flattered the number badly — 20 to 48 a
        // day of monitors and probes reading as people. A metric that counts
        // our own health checks as demand is worse than no metric.
        settle(q(`SELECT substr(ts,1,10) day, COUNT(*) asks,
                         COUNT(DISTINCT COALESCE(member_id, anon_id)) askers,
                         SUM(CASE WHEN member_id IS NULL AND anon_id IS NULL THEN 1 ELSE 0 END) unattributed
                    FROM num_asks WHERE ts > datetime('now','${win}') AND ${NOT_PROBE}
                   GROUP BY day`).all(), { results: [] }),
        settle(q(`SELECT (SELECT MAX(created_at) FROM num_members WHERE phone_verified=1) last_verified,
                         (SELECT COUNT(*) FROM num_members WHERE phone IS NOT NULL AND phone_verified=0) stuck,
                         (SELECT COUNT(*) FROM num_members WHERE phone IS NULL) anon,
                         (SELECT COUNT(*) FROM num_members) total`).first(), null),
      ]);

      const by = (rows, key) => Object.fromEntries((rows.results ?? []).map((r) => [r[key ?? 'day'], r]));
      const S = by(signups), V = by(visitors), A = by(asks);
      const series = [];
      for (let i = 0; i < days; i++) {
        const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
        series.push({
          day,
          signups: S[day]?.signups ?? 0,
          verified: S[day]?.verified ?? 0,
          anon: S[day]?.anon ?? 0,
          visitors: V[day]?.visitors ?? 0,
          events: V[day]?.events ?? 0,
          asks: A[day]?.asks ?? 0,
          askers: A[day]?.askers ?? 0,
          unattributed: A[day]?.unattributed ?? 0,
        });
      }

      // Days since anyone completed sign-in. THE number to look at first: the
      // whole funnel above it can be healthy and none of it converts to a
      // person we can reach.
      const lastVerified = health?.last_verified ?? null;
      const daysSince = lastVerified
        ? Math.floor((Date.now() - Date.parse(lastVerified.replace(' ', 'T') + 'Z')) / 86400_000)
        : null;

      return {
        series,
        verification: {
          last_verified: lastVerified,
          days_since_verified: daysSince,
          stuck_with_phone: health?.stuck ?? 0,
          anon_no_phone: health?.anon ?? 0,
          total: health?.total ?? 0,
        },
        funnel: (await settle(
          q(`SELECT event, COUNT(*) n, COUNT(DISTINCT visitor_id) v
               FROM num_web_events WHERE created_at > datetime('now','${win}')
              GROUP BY event ORDER BY v DESC LIMIT 20`).all(), { results: [] },
        )).results ?? [],
      };
    })(),
    app: {
      members: c.members, verified: c.verified, active24: c.active24,
      plans: c.plans, planItems: c.planItems, events: c.events, guests: c.guests, rsvpYes: c.rsvpYes,
      invites: c.invites, joined: c.joined, conversions: c.conversions,
      recent: (recent.results ?? []).map((r) => ({ ...r, phone: maskPhone(r.phone) })),
      referrals: leaders.results ?? [],
      // Where the ad money is actually working: signups and VERIFIED signups
      // by first-touch source. Verified is the honest column — an ad channel
      // that produces unverified signups produces bots and typos.
      by_source: await env.DB.prepare(
        `SELECT COALESCE(utm_source, 'organic') source,
                COALESCE(utm_campaign, '') campaign,
                COUNT(*) signups,
                SUM(phone_verified) verified
           FROM num_members
          WHERE created_at > datetime('now', ?1)
          GROUP BY 1, 2 ORDER BY signups DESC LIMIT 20`,
      ).bind(`-${since} day`).all().then((r) => r.results ?? []).catch(() => []),
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
    // ── real money: Stripe, the rails guests and subscribers pay on ─────
    // Separate from `money` (the Stars economy) on purpose: one is revenue,
    // the other is a closed loop, and averaging them tells you nothing.
    revenue: {
      paid_total: c.payPaid,
      paid_24h: c.payPaid24,
      trouble_7d: c.payTrouble7d,
      usd: Number((c.revenueUsdCents / 100).toFixed(2)),
      thb: Number((c.revenueThbSatang / 100).toFixed(2)),
      members_paid: c.membersPaidTier,
      recurring: c.subsRecurring,
      // Paid members with NO subscription lapse silently — this is the count
      // of one-off legacy members whose access ends within a week. When
      // recurring === members_paid this reads zero and the leak is closed.
      renewing_or_lapsing_7d: c.renewsIn7d,
      recent: await env.DB.prepare(
        "SELECT id, ref, amount_cents, currency, state, mode, created_at FROM num_payments ORDER BY created_at DESC LIMIT 15",
      ).all().then((r) => r.results ?? []).catch(() => []),
    },
    // ── the answer chain's own health ───────────────────────────────────
    chain: {
      cache_entries: c.cacheEntries,
      cache_hits: c.cacheHits,
      // Every row is one brain failing once in 24h. Zero is normal. A burst
      // matches the num_brain_state cooldowns; a flood while answers look fine
      // means the fallback is carrying the product again.
      brain_fails_24h: c.brainFails24,
    },
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

    // ── Daily series: the only honest way to draw a line ──────────────────
    //
    // The console used to render hand-typed arrays of ascending numbers as
    // "trends". Every chart sloped up because someone typed it that way. A
    // chart is a claim about reality; these come from GROUP BY date(), so a
    // flat week looks flat and a dead week looks dead.
    //
    // Days with no rows are absent from SQL, not zero — the UI zero-fills so
    // a gap reads as "nothing happened", never as "no data, skip the point".
    series: {
      days: since,
      signups: await dayseries(env, 'num_members', 'created_at', since),
      verified: await dayseries(env, 'num_members', 'created_at', since, 'phone_verified=1'),
      messages: await dayseries(env, 'num_messages', 'created_at', since),
      bookings: await dayseries(env, 'num_bookings', 'created_at', since),
    },

    // ── The queue: rows a human has to do something about ─────────────────
    //
    // A dashboard that only reports is a scoreboard. These are the items
    // where nothing happens until someone acts, which is the difference
    // between a number to admire and a number to fix.
    todo: {
      // Signed up, gave a phone, never verified. At n>0 with verified=0 this
      // is not a conversion problem, it is the A2P gate — the whole funnel
      // stops here and every downstream metric is capped at zero.
      unverified: (await settle(
        q(`SELECT id, name, phone, created_at FROM num_members
            WHERE phone IS NOT NULL AND phone <> '' AND COALESCE(phone_verified,0)=0
            ORDER BY created_at DESC LIMIT 25`).all(), { results: [] })).results ?? [],
      // Businesses that raised a hand on the web form and are still waiting.
      claims_new: (await settle(
        q(`SELECT id, business_name, contact_name, phone, source, created_at
             FROM claims WHERE state='new' ORDER BY created_at DESC LIMIT 25`).all(), { results: [] })).results ?? [],
      // A guest is waiting on a venue to answer. Every hour here is a booking
      // cooling off.
      bookings_pending: (await settle(
        q(`SELECT id, state, created_at FROM num_booking_requests
            WHERE state='requested' ORDER BY created_at ASC LIMIT 25`).all(), { results: [] })).results ?? [],
    },
  });
}

/**
 * One metric, one row per day, zero-filled — the shape a chart can trust.
 *
 * Table and column names are interpolated because D1 cannot bind an
 * identifier; they are never caller-supplied — every call site below passes a
 * literal. The `where` argument is likewise a literal from this file. If that
 * ever stops being true this becomes an injection, so keep the call sites
 * honest rather than adding a sanitiser that suggests user input is welcome.
 */
async function dayseries(env, table, col, days, where = null) {
  // Self-contained: a missing table must yield a flat line, never a 500 that
  // takes the whole dashboard down with it.
  let rows = [];
  try {
    rows = (await env.DB.prepare(
      `SELECT date(${col}) d, COUNT(*) n FROM ${table}
        WHERE ${col} > datetime('now', ?1)${where ? ` AND ${where}` : ''}
        GROUP BY 1 ORDER BY 1`,
    ).bind(`-${days} day`).all()).results ?? [];
  } catch { rows = []; }
  const byDay = new Map(rows.map((r) => [r.d, r.n]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    out.push({ d, n: byDay.get(d) ?? 0 }); // absent day = 0, not a hole
  }
  return out;
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
  // The people the morning alert names and this page could not show.
  const stalled = await stalledClaims(env);

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
    // Claims that never got past 'pending'. The morning alert has been naming
    // these people for two weeks; this page could not show a single one of
    // them, because it only ever read state='verified'.
    stalled,
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

/**
 * The review queue for num_place_submissions — businesses the /claim/ form
 * heard from that `places` never held (worker/migrations/0007_place_submissions.sql).
 * Until this queue existed, nothing else in the codebase ever read this
 * table: a submission landed in 'new' and stayed there forever, with no one
 * able to see it, let alone finish it. Confirmed live 29 Aug 2026 — Fingal
 * Hotel's own submission had been sitting untouched since the moment it was
 * filed.
 *
 * Every row gets a free, cheap dedup hint: an EXACT phone match against
 * `places`. That alone catches the case that surfaced this — a submission
 * for a business already on Num, filed as if it were new, because whoever
 * filled in the form did not pick the existing listing — with no geocoding
 * required to see it.
 */
async function adminSubmissions(env, url) {
  const statusParam = clip(url.searchParams.get('status'), 20);
  const statuses = statusParam ? [statusParam] : ['new', 'geocoded'];
  const placeholders = statuses.map((_, i) => `?${i + 1}`).join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, name, name_local, address, website, category, phone, email,
            country, dest, claim_id, status, place_id, review_note, created_at
       FROM num_place_submissions
      WHERE status IN (${placeholders})
      ORDER BY created_at ASC LIMIT 200`,
  ).bind(...statuses).all();

  const withHints = await Promise.all((results ?? []).map(async (r) => {
    let match = null;
    if (r.phone) {
      match = await env.DB.prepare(
        `SELECT id, name, dest, area, country, phone, email, website, status
           FROM places WHERE phone = ?1 LIMIT 1`,
      ).bind(r.phone).first().catch(() => null);
    }
    if (!match && r.name) {
      match = await env.DB.prepare(
        `SELECT id, name, dest, area, country, phone, email, website, status
           FROM places WHERE lower(name) = lower(?1) AND (?2 = '' OR country = ?2) LIMIT 1`,
      ).bind(r.name, r.country || '').first().catch(() => null);
    }
    return { ...r, possible_match: match || null };
  }));

  return json({ submissions: withHints, count: withHints.length });
}

/**
 * Resolve a submission onto a `places` row that already exists — the Fingal
 * Hotel case. Never writes a new places row; only ever points the submission
 * (and, if it arrived on one, the claim that produced it) at a listing that
 * is already there, so the business can claim that listing the normal way —
 * a code sent to the contact already published on it.
 */
async function adminSubmissionLink(env, req) {
  const b = await readBody(req);
  const id = clip(b.submission_id ?? b.id, 64);
  const placeId = clip(b.place_id, 64);
  if (!id || !placeId) return json({ error: 'submission_id and place_id are both required' }, 400);

  const sub = await env.DB.prepare(
    'SELECT id, claim_id, status FROM num_place_submissions WHERE id=?1',
  ).bind(id).first();
  if (!sub) return json({ error: 'no such submission' }, 404);
  if (sub.status === 'promoted' || sub.status === 'duplicate') {
    return json({ error: `already resolved as ${sub.status}` }, 409);
  }
  const place = await env.DB.prepare('SELECT id FROM places WHERE id=?1').bind(placeId).first();
  if (!place) return json({ error: 'no such place' }, 404);

  const who = clip(b.by, 60) || 'admin';
  const work = [
    env.DB.prepare(
      `UPDATE num_place_submissions SET status='duplicate', place_id=?2, reviewed_at=datetime('now'),
              review_note=?3 WHERE id=?1`,
    ).bind(id, placeId, `linked by ${who}`),
  ];
  if (sub.claim_id) {
    work.push(
      env.DB.prepare('UPDATE claims SET place_id=?2 WHERE id=?1 AND place_id IS NULL').bind(sub.claim_id, placeId),
    );
  }
  await env.DB.batch(work);

  return json({ ok: true, submission_id: id, place_id: placeId, status: 'duplicate' });
}

/**
 * Promote a submission into a real, findable `places` row — for the business
 * this table exists for: one nothing had crawled. Coordinates are required
 * and never invented here; places.lat/lng are NOT NULL and a wrong pin is a
 * wrong "what's near me" answer for as long as the row exists (see 0007's
 * own Gulf-of-Guinea warning). `dest` must be one of Num's own destination
 * slugs (scripts/destinations.mjs), not free text — it is how the concierge,
 * the map and every ingester key a place.
 */
/**
 * The statements that turn a listing into somebody's account.
 *
 * Extracted because there are now two doors a human can vouch through — a
 * self-submitted business being promoted, and an existing listing whose
 * claimant is stuck — and the day those two drift is the day one of them
 * forgets `onboardStatements` and quietly creates a business that cannot
 * transact.
 *
 * `method` is always 'admin_promote'. Never 'sms', never 'email': those mean a
 * one-time code reached a contact ALREADY PUBLISHED on the listing, which is
 * the whole anti-hijack property of claiming. A person vouching is a weaker
 * and different fact, and the register has to keep saying which one it was.
 */
async function ownershipWork(env, { placeId, place, businessId, claimId, who, note }) {
  const { onboardStatements } = await import('../claim/onboard.mjs');
  return [
    env.DB.prepare(
      `INSERT INTO businesses (id, name, kind, category, territory, status, onboarded_by, notes)
       VALUES (?1,?2,'merchant',?3,?4,'active','admin-promote',?5)`,
      // The note says which door this came through as well as who opened it.
      // "granted by dre" and "promoted by dre" are different events and a year
      // from now the difference is the only thing anyone will want.
    ).bind(businessId, place.name, place.category ?? null, place.dest ?? null,
      note || `granted by ${who}${claimId ? ` on claim ${claimId}` : ''}`),
    env.DB.prepare(
      `INSERT INTO num_place_owners (place_id, business_id, claim_id, method, phone)
       VALUES (?1,?2,?3,'admin_promote',?4)
       ON CONFLICT(place_id) DO UPDATE SET business_id=excluded.business_id,
             claim_id=excluded.claim_id, method=excluded.method, phone=excluded.phone,
             verified_at=datetime('now'), revoked_at=NULL`,
    ).bind(placeId, businessId, claimId ?? null, place.phone ?? null),
    env.DB.prepare("UPDATE places SET status='claimed', business_id=?2 WHERE id=?1")
      .bind(placeId, businessId),
    ...(await onboardStatements(env, businessId, place, `admin-promote:${who}`)),
  ];
}

/**
 * A claimant who started, was sent a code, and was never heard from again.
 *
 * ── WHY THESE PEOPLE WAITED FOURTEEN DAYS ────────────────────────────────
 *
 * `nudge.mjs` texts every morning: "[biz] 3 claim(s) waiting on us". It reads
 * every non-final state. This console read `state = 'verified'` and nothing
 * else — so the alert named Adam at the Holiday Inn Express for two weeks
 * running, and the page a human opens to do something about it had no row for
 * him. The tally even counted him, under `pending`, with nothing to click.
 *
 * A claim goes 'pending' the moment a code is sent, and the code is sent to
 * the contact ALREADY PUBLISHED on the listing — a reception inbox, usually,
 * not the person who filled in the form. When nobody in that inbox forwards
 * it, the code expires and the row stays 'pending' for ever: no sweep moves it
 * on, and the claimant has no way to ask again.
 *
 * So this exists to be acted on, not admired. Every row carries how long they
 * have waited and where the code actually went, because those two facts
 * together are the whole explanation.
 */
async function stalledClaims(env, limit = 100) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.place_id, c.state, c.channel, c.channel_value, c.created_at,
            c.claimant_name, c.claimant_email, c.claimant_phone,
            ROUND((julianday('now') - julianday(c.created_at)) * 24, 1) AS age_h,
            p.name AS place_name, p.area, p.dest, p.email AS place_email, p.phone AS place_phone,
            p.status AS place_status
       FROM num_claims c JOIN places p ON p.id = c.place_id
      WHERE c.state NOT IN ('verified','approved','rejected','expired')
        AND c.created_at < datetime('now', '-2 hours')
      ORDER BY c.created_at ASC LIMIT ?1`,
  ).bind(limit).all().catch(() => ({ results: [] }));
  return (results ?? []).map((r) => ({
    ...r,
    days_waiting: Math.floor((r.age_h ?? 0) / 24),
    // The sentence that explains the silence, written once here rather than
    // re-derived by whoever reads this next.
    why_stuck: `The code went to ${r.channel_value || 'the listing\'s published contact'}`
      + `${r.claimant_email ? `, not to ${r.claimant_email} who filled in the form` : ''}.`,
    already_claimed: r.place_status === 'claimed',
  }));
}

/**
 * Vouch for a stuck claimant and hand them their account.
 *
 * The same act as `owner: true` on a submission, for a listing that already
 * exists. Requires `by`, for the same reason: an assertion with nobody's name
 * on it is not an assertion.
 */
async function adminClaimGrant(env, req) {
  const b = await readBody(req);
  const placeId = clip(b.place_id, 64);
  const who = clip(b.by, 60);
  const claimId = b.claim_id != null ? clip(b.claim_id, 64) : null;
  if (!placeId) return json({ error: 'place_id is required' }, 400);
  if (!who) return json({ error: 'granting ownership records that a person vouched — "by" must name them' }, 400);

  const place = await env.DB.prepare(
    `SELECT id, name, category, dest, country, area, address, lat, lng, phone, email, website, status
       FROM places WHERE id=?1`,
  ).bind(placeId).first();
  if (!place) return json({ error: 'no such listing' }, 404);
  if (place.status === 'claimed') {
    return json({ error: 'that listing already has an owner', place_id: placeId }, 409);
  }

  const businessId = `biz_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const work = await ownershipWork(env, { placeId, place, businessId, claimId, who });
  if (claimId) {
    work.push(env.DB.prepare(
      `UPDATE num_claims SET state='verified', business_id=?2, code_hash=NULL, code_salt=NULL,
              decided_at=datetime('now'), decided_by=?3 WHERE id=?1`,
    ).bind(claimId, businessId, `admin:${who}`));
  }
  await env.DB.batch(work);

  // After the batch, never inside it: a sign-in link to a business whose
  // creation then rolled back is a link to nothing, handed to a real person.
  let signinUrlOut = null;
  try {
    const { mintSigninLink, signinUrl } = await import('./bizsignin.mjs');
    const token = await mintSigninLink(env, { placeId, businessId, purpose: 'welcome' });
    if (token) signinUrlOut = signinUrl(new URL(req.url).origin, token);
  } catch (e) { console.warn('[grant] sign-in link', e?.message ?? e); }

  return json({
    ok: true, place_id: placeId, business_id: businessId, claim_id: claimId,
    owner: 'admin_promote', signin_url: signinUrlOut,
  });
}

async function adminSubmissionPromote(env, req) {
  const b = await readBody(req);
  const id = clip(b.submission_id ?? b.id, 64);
  const lat = Number(b.lat);
  const lng = Number(b.lng);
  const dest = clip(b.dest, 40);
  if (!id) return json({ error: 'submission_id is required' }, 400);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return json({ error: 'lat and lng are required and must be real coordinates' }, 400);
  }
  const destRow = DESTINATIONS.find((d) => d.slug === dest);
  if (!destRow) {
    return json({ error: `dest must be one of Num's destination slugs, e.g. "${DESTINATIONS[0].slug}"` }, 400);
  }

  const sub = await env.DB.prepare('SELECT * FROM num_place_submissions WHERE id=?1').bind(id).first();
  if (!sub) return json({ error: 'no such submission' }, 404);
  if (sub.status === 'promoted' || sub.status === 'duplicate') {
    return json({ error: `already resolved as ${sub.status}` }, 409);
  }

  const placeId = `p_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const who = clip(b.by, 60) || 'admin';

  /**
   * ── PROMOTING SOMEBODY WHO ALREADY SIGNED UP ───────────────────────────
   *
   * Dre, 7 Sep 2026: "he's already signed up so he shouldn't have to sign up
   * again. we just need him to sign in again."
   *
   * He is right, and until now he was not served. Promotion built the listing
   * and stopped: `places.status` stayed 'unclaimed', no `businesses` row, no
   * `num_place_owners`. The person who filled in the form weeks earlier had to
   * come back, find their own name in a search, and claim the listing from
   * scratch — retyping what they had already told us, to prove they were the
   * person who had told us.
   *
   * `owner: true` says the reviewer has read this submission and is satisfied
   * the submitter is the business. That IS the check migration 0007 was
   * waiting for. bizsubmit.mjs states it plainly: a self-submitted listing has
   * no already-published contact to send a code to, because the submitter
   * supplied every contact on it — "that is not a reason to turn them away; it
   * is a reason their row is treated differently until something else confirms
   * it." A human promoting it by hand is that something else.
   *
   * ── WHAT IS DELIBERATELY NOT CLAIMED BY DOING THIS ─────────────────────
   *
   * `method` is recorded as 'admin_promote', never 'sms' or 'email'. Those two
   * mean a one-time code reached a contact that was already published on the
   * listing, which is the entire anti-hijack property of claiming. This is a
   * weaker, different fact — a named person vouched — and the register has to
   * say which one it was, forever, or the strong claim quietly becomes
   * unfalsifiable.
   *
   * `by` is required for the same reason. An assertion with nobody's name on
   * it is not an assertion.
   */
  const asOwner = b.owner === true || b.owner === 'true' || b.owner === 1;
  if (asOwner && !clip(b.by, 60)) {
    return json({ error: 'owner: true records that a person vouched — "by" must name them' }, 400);
  }

  const work = [
    env.DB.prepare(
      `INSERT INTO places (id,name,name_local,category,lat,lng,cell_lat,cell_lng,dest,country,
                            phone,website,email,address,source,status)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'self_submitted','unclaimed')`,
    ).bind(
      placeId, sub.name, sub.name_local, sub.category, lat, lng,
      Math.floor(lat * 10), Math.floor(lng * 10), dest, sub.country,
      sub.phone, sub.website, sub.email, sub.address,
    ),
    env.DB.prepare(
      `UPDATE num_place_submissions SET status='promoted', place_id=?2, reviewed_at=datetime('now'),
              review_note=?3 WHERE id=?1`,
    ).bind(id, placeId, `promoted by ${who}`),
  ];
  if (sub.claim_id) {
    work.push(
      env.DB.prepare('UPDATE claims SET place_id=?2 WHERE id=?1 AND place_id IS NULL').bind(sub.claim_id, placeId),
    );
  }

  let businessId = null;
  if (asOwner) {
    businessId = `biz_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    // The place row is written in this same batch and cannot be SELECTed yet,
    // so the shape onboardStatements needs is built from the submission — the
    // same values the INSERT above is using.
    const place = {
      id: placeId,
      name: sub.name,
      category: sub.category,
      dest,
      country: sub.country,
      area: null,
      address: sub.address,
      lat,
      lng,
      phone: sub.phone,
      email: sub.email,
      website: sub.website,
    };
    work.push(...await ownershipWork(env, {
      placeId, place, businessId, claimId: sub.claim_id ?? null, who,
      note: `submission ${id} promoted by ${who}`,
    }));
  }

  await env.DB.batch(work);

  /**
   * The link that makes "sign in" true rather than aspirational.
   *
   * Minted after the batch, never inside it: a sign-in link to a listing whose
   * creation then rolled back is a link to nothing, handed to a real person.
   * One use, fourteen days (worker/bizsignin.mjs). Best-effort — a business
   * that exists and cannot be linked to is recoverable; one that was never
   * created is not.
   */
  let signinUrlOut = null;
  if (asOwner) {
    try {
      const { mintSigninLink, signinUrl } = await import('./bizsignin.mjs');
      const token = await mintSigninLink(env, { placeId, businessId, purpose: 'welcome' });
      if (token) signinUrlOut = signinUrl(new URL(req.url).origin, token);
    } catch (e) {
      console.warn('[promote] sign-in link', e?.message ?? e);
    }
  }

  return json({
    ok: true,
    submission_id: id,
    place_id: placeId,
    status: 'promoted',
    ...(asOwner ? { business_id: businessId, owner: 'admin_promote', signin_url: signinUrlOut } : {}),
  });
}

// Exported so the behavioral test can call these directly, the same way
// bizconsole.mjs's __testables does, instead of re-deriving an admin
// session token just to exercise the logic.
export const __testables = {
  adminSubmissions, adminSubmissionLink, adminSubmissionPromote, adminClaims, adminClaimGrant,
};

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
      if (path === '/admin/login' && post) return await adminLogin(env, request);
      // Deliberately ahead of the isAdmin guard: the whole point is to explain
      // a failed guard, so it cannot sit behind one.
      if (path === '/admin/why') return await adminWhy(env, request);
      if (path === '/admin/console') {
        if (!env.ADMIN_KEY) return liteLogin('No admin key is configured on this Worker.');
        return await liteConsole(env, request, url);
      }
      if (!(await isAdmin(env, request))) return json({ error: 'unauthorized' }, 401);
      if (path === '/admin/overview') return await adminOverview(env, url, request);
      if (path === '/admin/claims' && !post) return await adminClaims(env, url);
      if (path === '/admin/claims/grant' && post) return await adminClaimGrant(env, request);
      if (path === '/admin/claims/contacted' && post) return await adminClaimContacted(env, request);
      if (path === '/admin/resolve' && post) return await adminResolve(env, request);
      if (path === '/admin/submissions' && !post) return await adminSubmissions(env, url);
      if (path === '/admin/submissions/link' && post) return await adminSubmissionLink(env, request);
      if (path === '/admin/submissions/promote' && post) return await adminSubmissionPromote(env, request);
      return json({ error: 'not found' }, 404);
    }
    return json({ error: 'not found' }, 404);
  } catch (err) {
    console.error('[console]', path, err?.message ?? err);
    return json({ error: 'that didn’t go through — try again in a moment' }, 500);
  }
}
