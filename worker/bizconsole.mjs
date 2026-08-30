/**
 * The business console — the page a venue owner actually uses.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * Everything a business needs was already built and none of it was reachable
 * by a human. On 24 Aug 2026 the numbers were: 93,288 leads in the pipeline,
 * 2,529,721 listings, a complete claim → verify → key API at /api/biz/v1, a
 * marketing page at /business/ promising a dashboard with analytics and three
 * paid tiers — and **0 business logins, 0 sessions, 1 claim, 0 place owners**.
 *
 * Two things caused that, and only one of them was obvious.
 *
 *   1. THERE WAS NO UI. /api/biz/v1 is a JSON API. A restaurant owner in
 *      Phuket does not POST JSON. The only human entry point on the business
 *      page was "Sign in", pointing at /signin/ — the TRAVELLER app.
 *
 *   2. THE TRAVELLER PATH IS THE WRONG PATH, AND IT IS BROKEN. The other
 *      business surface, /api/business/overview, keys off a NUM member id —
 *      so an owner had to create a traveller account and verify a phone
 *      first. Phone verification has produced zero verified members since
 *      4 July (worker/signinlog.mjs). Every business was queued behind a
 *      consumer outage they had nothing to do with.
 *
 * So this console authenticates with the `numbiz_` key that /v1/verify ALREADY
 * issues, and touches the traveller identity system nowhere. A business can
 * claim and manage a listing while consumer sign-in is still down.
 *
 * ── WHY IT IS A THIN SHELL, NOT A SECOND IMPLEMENTATION ──────────────────
 *
 * Every action here builds a Request and calls handleBizApi() — the same code
 * path an API client hits, already tested. Nothing about claiming, code
 * checking, key issuing or the editable-field allowlist is reimplemented for
 * the browser. A console that drifts from its API is a console that tells a
 * merchant something the API will not honour.
 *
 * ── WHY FORMS AND NOT JAVASCRIPT ─────────────────────────────────────────
 *
 * Same reasoning as the ops console in worker/console.mjs, which was rebuilt
 * five times while it lived in the browser layer. The dashboard arrives IN the
 * response. No fetch, no service worker, no cached shell, nothing to go wrong
 * between a person and their listing.
 */
import { handleBizApi } from './bizapi.mjs';

const enc = new TextEncoder();
const H = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NUM = (v) => Number(v ?? 0).toLocaleString('en-US');

const SESSION_TTL_MIN = 12 * 60;

/** HMAC over (place_id, expiry), namespaced so no other signed token replays here. */
async function sign(env, placeId, exp) {
  const k = await crypto.subtle.importKey(
    'raw', enc.encode(env?.ADMIN_KEY ?? 'dev'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', k, enc.encode(`bizc:${placeId}:${exp}`));
  return [...new Uint8Array(mac)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const mintSession = async (env, placeId) => {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_MIN * 60;
  return `${placeId}.${exp}.${await sign(env, placeId, exp)}`;
};

/** Returns the place id, or null. Never throws on a malformed token. */
async function sessionPlace(env, token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  const [placeId, exp, mac] = parts;
  if (!/^\d+$/.test(exp) || Number(exp) < Math.floor(Date.now() / 1000)) return null;
  const want = await sign(env, placeId, exp);
  if (want.length !== mac.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ mac.charCodeAt(i);
  return diff === 0 ? placeId : null;
}

/** Call the real API in-process. One implementation, no drift. */
async function api(env, method, path, { body, key, origin } = {}) {
  const req = new Request(`${origin ?? 'https://app.itsnum.com'}/api/biz${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  // The router matches on the PATH ONLY and reads the query off request.url —
  // exactly as index.mjs calls it (url.pathname.slice(...)). Passing
  // '/v1/places?q=Suay' as the route silently matches nothing and returns an
  // empty list, which reads on screen as "your business isn't in NUM".
  const res = await handleBizApi(req, env, path.split('?')[0]);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* an HTML error page is still an error */ }
  return { status: res.status, body: json ?? {} };
}

/* ─────────────────────────────── the page ─────────────────────────────── */

function shell(inner, title = 'NUM for Business') {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${H(title)}</title><style>
:root{--ink:#141414;--muted:#6b6b6b;--line:#e5e2dc;--bg:#f4f3f0;--card:#fff;--ok:#1a7f37;--bad:#c0392b}
*{box-sizing:border-box}
body{font:16px/1.55 -apple-system,system-ui,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink);
  margin:0;padding:28px 18px 64px;max-width:760px;margin-inline:auto}
h1{font-size:23px;margin:0 0 4px;letter-spacing:-.02em}
h2{font-size:15px;margin:28px 0 10px;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:13.5px;margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:0 0 14px}
.card h3{margin:0 0 6px;font-size:16px}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 4px}
input,select{width:100%;padding:11px 13px;border:1px solid #ddd;border-radius:9px;font-size:16px;background:#fff}
button{width:100%;padding:12px;margin-top:12px;border:0;border-radius:9px;background:var(--ink);color:#fff;
  font-size:16px;cursor:pointer}
button.ghost{background:#fff;color:var(--ink);border:1px solid var(--line)}
.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1 1 200px}
.err{background:#fff;border:1px solid var(--bad);border-left-width:4px;border-radius:10px;padding:12px 14px;
  color:var(--bad);margin:0 0 16px;font-size:14.5px}
.note{background:#fff;border:1px solid var(--line);border-left:4px solid var(--ink);border-radius:10px;
  padding:12px 14px;margin:0 0 16px;font-size:14px;color:var(--muted)}
.key{font-family:ui-monospace,Menlo,monospace;font-size:14px;word-break:break-all;background:#f7f6f3;
  border:1px dashed var(--ink);border-radius:9px;padding:14px;margin:10px 0}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:12px;
  overflow:hidden;font-size:14px}
th{text-align:left;padding:9px 12px;background:#faf9f7;color:var(--muted);font-size:12px;font-weight:600}
td{padding:9px 12px;border-top:1px solid #f0eee9}
.big{font-size:30px;font-weight:700;letter-spacing:-.02em;display:block;line-height:1.1}
.ok{color:var(--ok)}.bad{color:var(--bad)}
a{color:inherit}.foot{margin-top:32px;font-size:13px;color:var(--muted)}
.plangrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:0 0 14px}
.plancard{border:1px solid var(--line);border-radius:10px;padding:14px;text-align:center;background:#fff}
.plancard.current{border-color:var(--ink);background:#faf9f7}
.plancard .pname{font-weight:700;font-size:14px;margin:0 0 2px}
.plancard .pprice{font-size:20px;font-weight:700;letter-spacing:-.02em;display:block;margin:2px 0 8px}
.plancard .pprice span{font-size:12px;font-weight:400;color:var(--muted)}
.plancard button{margin-top:4px;padding:9px;font-size:13.5px}
.tag{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;background:#eee;color:var(--muted);margin-left:6px;vertical-align:1px}
.entlist{list-style:none;padding:0;margin:10px 0 0;font-size:13.5px;color:var(--muted)}
.entlist li{padding:3px 0}
.entlist li b{color:var(--ink);font-weight:600}
</style></head><body>${inner}</body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

const errBox = (m) => (m ? `<div class="err">${H(m)}</div>` : '');

/** Step 0 — find your listing, or sign in with a key you already hold. */
function landing(err = '', q = '') {
  return shell(`
    <h1>NUM for Business</h1>
    <p class="sub">Claim your listing and manage what NUM tells travellers about you.</p>
    ${errBox(err)}
    <form method="post" class="card">
      <input type="hidden" name="action" value="find">
      <h3>Find your listing</h3>
      <label for="q">Business name</label>
      <input id="q" name="q" value="${H(q)}" placeholder="e.g. Suay Restaurant" autofocus required>
      <label for="dest">Town or city (optional)</label>
      <input id="dest" name="dest" placeholder="e.g. phuket">
      <button type="submit">Search</button>
    </form>
    <form method="post" class="card">
      <input type="hidden" name="action" value="signin">
      <h3>Already claimed it?</h3>
      <label for="key">Your business key</label>
      <input id="key" name="key" type="password" placeholder="numbiz_…" autocomplete="off" required>
      <button type="submit" class="ghost">Open my dashboard</button>
    </form>
    <p class="foot">No listing found, or no published email or phone on it?
      Email <a href="mailto:info@5arz.com">info@5arz.com</a> and a person will verify you.</p>`);
}

/** Step 1 — pick the listing that is actually yours. */
function results(places, q) {
  if (!places.length) {
    return landing(`No listing found for "${q}". Try the name as it appears on your door, or email info@5arz.com.`, q);
  }
  return shell(`
    <h1>Is this you?</h1>
    <p class="sub">We send a one-time code to the email or phone already published on the listing — that is what proves you control the business.</p>
    ${places.map((p) => `
      <form method="post" class="card">
        <input type="hidden" name="action" value="claim">
        <input type="hidden" name="place_id" value="${H(p.place_id ?? p.id)}">
        <h3>${H(p.name)}</h3>
        <p class="sub" style="margin:0 0 8px">${H([p.category, p.area, p.dest].filter(Boolean).join(' · ') || '—')}</p>
        <button type="submit">Claim this listing</button>
      </form>`).join('')}
    <p class="foot"><a href="/api/biz/console">Search again</a></p>`);
}

/** Step 2 — the code went to the listing's own contact. */
function codeForm(claim, err = '') {
  return shell(`
    <h1>Check your ${H(claim.channel === 'email' ? 'email' : 'messages')}</h1>
    <p class="sub">We sent a code to <b>${H(claim.sent_to)}</b> — the contact published on your listing.
      It expires in ${H(claim.expires_in_minutes)} minutes.</p>
    ${errBox(err)}
    <form method="post" class="card">
      <input type="hidden" name="action" value="verify">
      <input type="hidden" name="claim_id" value="${H(claim.claim_id)}">
      <label for="code">Six-digit code</label>
      <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus>
      <button type="submit">Verify</button>
    </form>
    <p class="foot">Wrong contact on the listing? Email <a href="mailto:info@5arz.com">info@5arz.com</a> — do not
      guess, we will fix the listing first.</p>`);
}

/** Step 3 — the key, shown exactly once because we store only its hash. */
function keyIssued(key, token) {
  return shell(`
    <h1>You're verified</h1>
    <p class="sub">This is your business key. <b>Save it now</b> — NUM stores only a hash of it, so this is
      genuinely the only time it can be shown.</p>
    <div class="key">${H(key)}</div>
    <div class="note">Keep it like a password. Anyone holding it can edit what NUM says about your business.
      Lost it? Email <a href="mailto:info@5arz.com">info@5arz.com</a>.</div>
    <a href="/api/biz/console?s=${encodeURIComponent(token)}"><button type="button">Open my dashboard</button></a>`);
}

/** Money formatter for the plan cards — cents, US-style, drops the .00. */
const USD = (cents) => `$${cents % 100 ? (cents / 100).toFixed(2) : cents / 100}`;

/** The "Your plan" card: what you're on, and the ladder above it. */
function planSection(plan, allTiers, token, saved, err) {
  const tierId = plan?.tier ?? 'free';
  const isFree = tierId === 'free';
  const cards = Object.entries(allTiers).map(([id, t]) => {
    const current = id === tierId;
    const priceLine = t.price_cents > 0
      ? `${USD(t.price_cents)}<span>/mo</span>` : 'Free';
    const action = current
      ? '<button type="button" class="ghost" disabled>Current plan</button>'
      : t.price_cents > 0
        ? `<form method="post"><input type="hidden" name="action" value="upgrade">
             <input type="hidden" name="s" value="${H(token)}">
             <input type="hidden" name="tier" value="${H(id)}">
             <button type="submit">${isFree ? 'Upgrade' : 'Switch'}</button></form>`
        : '';
    return `<div class="plancard${current ? ' current' : ''}">
        <p class="pname">${H(t.name)}${current ? '<span class="tag">you</span>' : ''}</p>
        <span class="pprice">${priceLine}</span>
        <p class="sub" style="margin:0 0 6px;min-height:32px">${H(t.blurb)}</p>
        ${action}
      </div>`;
  }).join('');

  const ent = plan ?? {};
  const entRows = [
    `<li><b>${ent.analytics_days ?? 7}-day</b> analytics window</li>`,
    `<li>Promotions: <b>${ent.promotions ? 'on' : 'not on this plan'}</b></li>`,
    `<li>Locations on this plan: <b>${ent.multi_location_max == null ? 'unlimited' : ent.multi_location_max}</b></li>`,
    `<li>Beta features: <b>${ent.beta_features ? 'yes, first' : 'not yet'}</b></li>`,
  ].join('');

  return `
    <h2>Your plan</h2>
    ${errBox(err)}
    ${saved ? `<div class="note ok">${H(saved)}</div>` : ''}
    <div class="plangrid">${cards}</div>
    <div class="card">
      <h3 style="margin-bottom:2px">${H(allTiers[tierId]?.name ?? 'Listed')} — what you get</h3>
      <ul class="entlist">${entRows}</ul>
      ${!isFree ? `<form method="post" style="margin-top:12px">
          <input type="hidden" name="action" value="cancel_plan">
          <input type="hidden" name="s" value="${H(token)}">
          <button type="submit" class="ghost">Cancel plan</button>
        </form>
        <p class="sub" style="margin:8px 0 0">Cancelling stops the next charge — you keep this plan until the
          period you already paid for ends.</p>` : ''}
    </div>`;
}

/** The dashboard. */
function dashboard(place, insights, bookings, token, saved = '', err = '', extra = {}) {
  const { plan = { tier: 'free' }, allTiers = {}, locations = [], promoText = '', planErr = '', planSaved = '' } = extra;
  const link = `/api/biz/console?s=${encodeURIComponent(token)}`;
  const impressions = insights?.available
    ? `<span class="big">${NUM(insights.impressions)}</span>
       <span class="sub">times NUM showed you to a traveller · last ${H(insights.days)} days${
         insights.upgrade_for_more ? ` · <a href="#plan">a longer window is on a paid plan</a>` : ''}</span>`
    // The honest empty state, kept verbatim from the API rather than softened.
    // Inventing this number would be the single most damaging lie available:
    // it is the one figure a merchant makes decisions on.
    : `<span class="sub">${H(insights?.reason ?? 'Not measured yet.')}</span>`;

  const F = (name, label, val, ph = '') => `
    <label for="${name}">${H(label)}</label>
    <input id="${name}" name="${name}" value="${H(val ?? '')}" placeholder="${H(ph)}">`;

  const canPromote = !!plan?.promotions;
  const promoField = canPromote
    ? `${F('promo_text', 'Promotion NUM can mention', promoText, 'e.g. Happy hour 5-7pm, 20% off cocktails')}`
    : `<label for="promo_text">Promotion NUM can mention</label>
       <input id="promo_text" disabled placeholder="Part of a paid plan — see below" style="color:var(--muted);background:#faf9f7">`;

  return shell(`
    <h1>${H(place.name)}</h1>
    <p class="sub">${H([place.category, place.area, place.dest].filter(Boolean).join(' · ') || '—')} ·
      <a href="${link}">refresh</a></p>
    ${errBox(err)}
    ${saved ? `<div class="note ok">${H(saved)}</div>` : ''}

    <div class="card">${impressions}</div>

    <h2>Booking requests</h2>
    ${bookings.length
      ? `<table><tr><th>When</th><th>Guest</th><th>Party</th><th>For</th><th>State</th></tr>
         ${bookings.map((b) => `<tr><td>${H(b.created_at ?? '—')}</td><td>${H(b.guest_name ?? '—')}</td>
           <td>${H(b.party ?? '—')}</td><td>${H(b.when_text ?? b.date ?? '—')}</td>
           <td>${H(b.state ?? '—')}</td></tr>`).join('')}</table>`
      : `<div class="card"><span class="sub">No booking requests yet. They appear here the moment a traveller
           asks NUM for a table at your place.</span></div>`}

    <h2>What NUM tells travellers</h2>
    <form method="post" class="card">
      <input type="hidden" name="action" value="save">
      <input type="hidden" name="s" value="${H(token)}">
      ${F('name', 'Business name', place.name)}
      <div class="row">
        <div>${F('phone', 'Phone', place.phone, '+66…')}</div>
        <div>${F('website', 'Website', place.website, 'https://…')}</div>
      </div>
      ${F('address', 'Address', place.address)}
      ${F('hours', 'Opening hours', place.hours, 'Mon-Sat 11:00-22:00')}
      ${F('cuisine', 'Cuisine or speciality', place.cuisine)}
      ${promoField}
      <button type="submit">Save</button>
    </form>
    <div class="note">Your category, rating and where you appear in a recommendation are <b>not</b> editable —
      not by you, and not by anyone paying us. They belong to the traveller's trust in NUM, and the day a
      position can be bought the recommendations stop being worth reading.</div>

    ${locations.length > 1 ? `<h2>Your locations</h2>
      <table><tr><th>Name</th><th>Where</th></tr>
        ${locations.map((l) => `<tr><td>${H(l.name)}</td><td>${H([l.category, l.dest].filter(Boolean).join(' · ') || '—')}</td></tr>`).join('')}
      </table>` : ''}

    <a name="plan"></a>
    ${planSection(plan, allTiers, token, planSaved, planErr)}

    <p class="foot">Listing ID <code>${H(place.place_id ?? place.id)}</code> ·
      Questions: <a href="mailto:info@5arz.com">info@5arz.com</a> ·
      <a href="/api/biz">API &amp; MCP docs</a></p>`, `${place.name} — NUM for Business`);
}

/* ─────────────────────────────── router ───────────────────────────────── */

/** The business_id this listing is currently owned by, or null. */
async function ownerOf(env, placeId) {
  const row = await env.DB.prepare(
    'SELECT business_id FROM num_place_owners WHERE place_id=?1 AND revoked_at IS NULL',
  ).bind(placeId).first().catch(() => null);
  return row?.business_id ?? null;
}

async function loadDashboard(env, placeId, token, origin, saved = '', err = '', planSaved = '', planErr = '') {
  // READS go to the database directly; WRITES go through the API path.
  //
  // That split is deliberate. /v1/profile authenticates by key, and the session
  // token does NOT carry the key — a token that carried one would be a
  // credential sitting in a URL, in browser history, and in any referrer the
  // page leaks. So the session proves only "this browser verified control of
  // this listing", which is exactly enough to READ it back.
  const place = await env.DB.prepare(
    `SELECT id AS place_id, name, category, dest, area, address, phone, website, hours, cuisine
       FROM places WHERE id=?1`,
  ).bind(placeId).first();
  if (!place) return landing('That listing no longer exists. Email info@5arz.com.');

  const businessId = await ownerOf(env, placeId);

  // The plan gates how far back insights are allowed to look — same rule as
  // GET /v1/insights, kept in step deliberately rather than the console
  // showing more than the API would hand an integration reading the same
  // number.
  const { bizEntitlements, bizTiers } = await import('./bizbilling.mjs');
  const plan = businessId ? await bizEntitlements(env, businessId) : { tier: 'free', analytics_days: 7, promotions: false, multi_location_max: 1, beta_features: false, name: 'Listed' };
  const allTiers = bizTiers(env);
  const insights = await insightsFor(env, placeId, Math.min(30, plan.analytics_days ?? 7));

  const { results: bookings } = await env.DB.prepare(
    `SELECT created_at, guest_name, party, when_text, date, state
       FROM num_booking_requests WHERE place_id=?1 ORDER BY rowid DESC LIMIT 25`,
  ).bind(placeId).all().catch(() => ({ results: [] }));

  let locations = [];
  let promoText = '';
  if (businessId) {
    const { results: locs } = await env.DB.prepare(
      `SELECT po.place_id, p.name, p.category, p.dest
         FROM num_place_owners po JOIN places p ON p.id = po.place_id
        WHERE po.business_id=?1 AND po.revoked_at IS NULL ORDER BY po.verified_at DESC`,
    ).bind(businessId).all().catch(() => ({ results: [] }));
    locations = locs ?? [];
    const row = await env.DB.prepare('SELECT custom_fields FROM num_business_profiles WHERE business_id=?1')
      .bind(businessId).first().catch(() => null);
    try { promoText = JSON.parse(row?.custom_fields || '{}')?.promo_text ?? ''; } catch { promoText = ''; }
  }

  return dashboard(place, insights, bookings ?? [], token, saved, err, {
    plan, allTiers, locations, promoText, planSaved, planErr,
  });
}

/** Read-only impressions, same honesty contract as GET /v1/insights. */
async function insightsFor(env, placeId, days) {
  const has = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='num_place_impressions'",
  ).first().catch(() => null);
  if (!has) {
    return {
      available: false,
      reason: 'NUM does not yet record which listings it shows to travellers, so we cannot tell you. We will not estimate it.',
    };
  }
  const row = await env.DB.prepare(
    `SELECT COUNT(*) n FROM num_place_impressions WHERE place_id=?1 AND ts > unixepoch('now', ?2)`,
  ).bind(placeId, `-${days} day`).first().catch(() => null);
  return { available: true, impressions: row?.n ?? 0, days };
}

export async function handleBizConsole(request, env, url) {
  if (!env?.DB) return shell('<h1>Momentarily unavailable</h1><p class="sub">Try again in a minute.</p>');
  const origin = url.origin;

  if (request.method === 'GET') {
    const s = url.searchParams.get('s');
    if (!s) return landing();
    const placeId = await sessionPlace(env, s);
    if (!placeId) return landing('That session expired — sign in with your key again.');
    // Stripe redirects here straight from its own hosted checkout page —
    // grantBizTier() runs from the webhook, which is asynchronous and usually
    // fast but is never guaranteed to have landed before this GET does. Said
    // plainly rather than silently showing the OLD plan and looking broken.
    const upgraded = url.searchParams.get('upgraded');
    const planSaved = upgraded ? `Payment received — your plan updates within a few seconds. Refresh if ${H(upgraded)} doesn't show yet.` : '';
    return await loadDashboard(env, placeId, s, origin, '', '', planSaved);
  }
  if (request.method !== 'POST') return landing();

  let form;
  try { form = await request.formData(); } catch { return landing('That did not go through — try again.'); }
  const action = String(form.get('action') ?? '');
  const val = (k) => String(form.get(k) ?? '').trim();

  if (action === 'find') {
    const q = val('q');
    const dest = val('dest');
    const r = await api(env, 'GET',
      `/v1/places?q=${encodeURIComponent(q)}${dest ? `&dest=${encodeURIComponent(dest)}` : ''}`, { origin });
    return results(r.body?.places ?? [], q);
  }

  if (action === 'claim') {
    const r = await api(env, 'POST', '/v1/claim', { body: { place_id: val('place_id') }, origin });
    // Every failure here is one a business can act on — already claimed, no
    // published contact, delivery refused — so the API's own message is shown
    // rather than replaced with something reassuring and useless.
    if (r.status >= 400) return landing(r.body?.message ?? r.body?.error ?? 'Could not start that claim.');
    return codeForm(r.body);
  }

  if (action === 'verify') {
    const claimId = val('claim_id');
    const r = await api(env, 'POST', '/v1/verify', { body: { claim_id: claimId, code: val('code') }, origin });
    if (r.status >= 400 || !r.body?.api_key) {
      const left = r.body?.attempts_left;
      return codeForm(
        { claim_id: claimId, channel: 'email', sent_to: 'your published contact', expires_in_minutes: 15 },
        r.body?.message ?? (left != null ? `Wrong code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Wrong code.'),
      );
    }
    // num_biz_claims was retired when bizapi.mjs was rewritten onto the
    // canonical num_claims/businesses tables (2026-08-29) — verifyClaim's
    // success response always carries place_id (num_claims.place_id is
    // NOT NULL), so there is no longer a table to fall back to here.
    return keyIssued(r.body.api_key, await mintSession(env, r.body.place_id));
  }

  if (action === 'signin') {
    const key = val('key');
    const r = await api(env, 'GET', '/v1/profile', { key, origin });
    if (r.status >= 400) return landing('That key was not recognised. Keys look like numbiz_… and are shown once.');
    const placeId = r.body?.profile?.place_id ?? r.body?.profile?.id;
    if (!placeId) return landing('That key is valid but is not attached to a listing. Email info@5arz.com.');
    const token = await mintSession(env, placeId);
    return await loadDashboard(env, placeId, token, origin);
  }

  if (action === 'save') {
    const token = val('s');
    const placeId = await sessionPlace(env, token);
    if (!placeId) return landing('That session expired — sign in with your key again.');
    // The editable allowlist lives in bizapi.mjs and is NOT repeated here. A
    // second copy is a second thing to forget when the contract changes.
    const patch = {};
    for (const k of ['name', 'phone', 'website', 'hours', 'cuisine', 'address']) {
      const v = val(k);
      if (v) patch[k] = v;
    }
    const sets = Object.entries(patch);

    // promo_text is entitlement-gated (worker/bizbilling.mjs), never in the
    // plain allowlist above — a free listing can still POST the field (the
    // input is disabled but a form can be hand-submitted), so this checks the
    // plan itself rather than trusting the client left it blank.
    let promoNote = '';
    const promoRaw = form.get('promo_text');
    if (promoRaw != null) {
      const businessId = await ownerOf(env, placeId);
      const { bizEntitlements } = await import('./bizbilling.mjs');
      const plan = businessId ? await bizEntitlements(env, businessId) : null;
      if (plan?.promotions && businessId) {
        const row = await env.DB.prepare('SELECT custom_fields FROM num_business_profiles WHERE business_id=?1')
          .bind(businessId).first().catch(() => null);
        let cf = {};
        try { cf = JSON.parse(row?.custom_fields || '{}') ?? {}; } catch { cf = {}; }
        cf.promo_text = String(promoRaw).trim().slice(0, 140);
        await env.DB.prepare('UPDATE num_business_profiles SET custom_fields=?2 WHERE business_id=?1')
          .bind(businessId, JSON.stringify(cf)).run().catch(() => {});
        promoNote = 'promo';
      } else if (String(promoRaw).trim()) {
        return await loadDashboard(env, placeId, token, origin, '', 'Promotions are part of a paid plan — see below.');
      }
    }

    if (!sets.length && !promoNote) return await loadDashboard(env, placeId, token, origin, '', 'Nothing to save.');
    if (sets.length) {
      await env.DB.prepare(
        `UPDATE places SET ${sets.map(([k], i) => `${k}=?${i + 2}`).join(', ')} WHERE id=?1`,
      ).bind(placeId, ...sets.map(([, v]) => String(v).slice(0, 400))).run();
    }
    return await loadDashboard(env, placeId, token, origin, 'Saved. NUM will use this from the next question a traveller asks.');
  }

  if (action === 'upgrade') {
    const token = val('s');
    const placeId = await sessionPlace(env, token);
    if (!placeId) return landing('That session expired — sign in with your key again.');
    const businessId = await ownerOf(env, placeId);
    if (!businessId) return await loadDashboard(env, placeId, token, origin, '', '', '', 'No business is attached to this listing yet — email info@5arz.com.');
    const { bizTiers } = await import('./bizbilling.mjs');
    const tier = val('tier');
    const t = bizTiers(env)[tier];
    if (!tier || !t || !(t.price_cents > 0)) {
      return await loadDashboard(env, placeId, token, origin, '', '', '', 'Pick a plan to upgrade to.');
    }
    const { requestSubscription } = await import('./pay.mjs');
    const out = await requestSubscription(env, {
      businessId,
      amountCents: t.price_cents,
      name: `NUM for Business — ${t.name}`,
      ref: `biztier:${tier}`,
      successUrl: `${origin}/api/biz/console?s=${encodeURIComponent(token)}&upgraded=${encodeURIComponent(tier)}`,
      cancelUrl: `${origin}/api/biz/console?s=${encodeURIComponent(token)}`,
    });
    if (!out.ok || !out.url) {
      return await loadDashboard(env, placeId, token, origin, '', '', '', out.error || 'Could not start checkout — try again in a minute.');
    }
    // A plain redirect, not a fetch — this console renders as arriving HTML
    // with no client JS, same rule as everything else in this file, so
    // handing the browser to Stripe's own hosted page is a 303, not a link
    // the owner has to notice and click.
    return Response.redirect(out.url, 303);
  }

  if (action === 'cancel_plan') {
    const token = val('s');
    const placeId = await sessionPlace(env, token);
    if (!placeId) return landing('That session expired — sign in with your key again.');
    const businessId = await ownerOf(env, placeId);
    if (!businessId) return await loadDashboard(env, placeId, token, origin);
    // bizEntitlements() lazily creates num_business_subscriptions the same way
    // authed() must for num_biz_keys (see the 2026-08-30 production incident
    // note on that function) — called here FIRST, before the raw SELECT below
    // touches a table that may not exist yet for a business that has never
    // held a paid plan.
    const { bizEntitlements } = await import('./bizbilling.mjs');
    await bizEntitlements(env, businessId);
    const row = await env.DB.prepare('SELECT stripe_sub, tier, renews_at FROM num_business_subscriptions WHERE business_id=?1')
      .bind(businessId).first().catch(() => null);
    if (!row?.stripe_sub) {
      return await loadDashboard(env, placeId, token, origin, '', '', row?.renews_at
        ? `Nothing renews automatically — your ${row.tier} access simply ends ${row.renews_at}.`
        : "You're on the free plan — nothing to cancel.");
    }
    const { cancelSubscription } = await import('./pay.mjs');
    const out = await cancelSubscription(env, row.stripe_sub);
    return await loadDashboard(env, placeId, token, origin, '', '',
      out.ok ? `Done — ${row.tier} stays active until ${row.renews_at}, then won't charge again.` : '',
      out.ok ? '' : (out.error || 'Could not cancel — try again in a minute.'));
  }

  return landing();
}

export const __testables = { mintSession, sessionPlace, sign };
