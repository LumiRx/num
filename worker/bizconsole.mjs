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

/** The dashboard. */
function dashboard(place, insights, bookings, token, saved = '', err = '') {
  const link = `/api/biz/console?s=${encodeURIComponent(token)}`;
  const impressions = insights?.available
    ? `<span class="big">${NUM(insights.impressions)}</span>
       <span class="sub">times NUM showed you to a traveller · last ${H(insights.days)} days</span>`
    // The honest empty state, kept verbatim from the API rather than softened.
    // Inventing this number would be the single most damaging lie available:
    // it is the one figure a merchant makes decisions on.
    : `<span class="sub">${H(insights?.reason ?? 'Not measured yet.')}</span>`;

  const F = (name, label, val, ph = '') => `
    <label for="${name}">${H(label)}</label>
    <input id="${name}" name="${name}" value="${H(val ?? '')}" placeholder="${H(ph)}">`;

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
      <button type="submit">Save</button>
    </form>
    <div class="note">Your category, rating and where you appear in a recommendation are <b>not</b> editable —
      not by you, and not by anyone paying us. They belong to the traveller's trust in NUM, and the day a
      position can be bought the recommendations stop being worth reading.</div>

    <p class="foot">Listing ID <code>${H(place.place_id ?? place.id)}</code> ·
      Questions: <a href="mailto:info@5arz.com">info@5arz.com</a> ·
      <a href="/api/biz">API &amp; MCP docs</a></p>`, `${place.name} — NUM for Business`);
}

/* ─────────────────────────────── router ───────────────────────────────── */

async function loadDashboard(env, placeId, token, origin, saved = '', err = '') {
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

  const insights = await insightsFor(env, placeId, 30);
  const { results: bookings } = await env.DB.prepare(
    `SELECT created_at, guest_name, party, when_text, date, state
       FROM num_booking_requests WHERE place_id=?1 ORDER BY rowid DESC LIMIT 25`,
  ).bind(placeId).all().catch(() => ({ results: [] }));

  return dashboard(place, insights, bookings ?? [], token, saved, err);
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
    return await loadDashboard(env, placeId, s, origin);
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
    if (!sets.length) return await loadDashboard(env, placeId, token, origin, '', 'Nothing to save.');
    await env.DB.prepare(
      `UPDATE places SET ${sets.map(([k], i) => `${k}=?${i + 2}`).join(', ')} WHERE id=?1`,
    ).bind(placeId, ...sets.map(([, v]) => String(v).slice(0, 400))).run();
    return await loadDashboard(env, placeId, token, origin, 'Saved. NUM will use this from the next question a traveller asks.');
  }

  return landing();
}

export const __testables = { mintSession, sessionPlace, sign };
