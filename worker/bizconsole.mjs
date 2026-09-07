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
// The Delivery page: settings + orders for a partner that delivers what it
// lists (worker/delivery.mjs). Rendered from a separate file so this one
// stays about the console's frame.
import { deliveryPage } from './bizdelivery.mjs';
// What this trade is actually asked for. A dispensary prices by the eighth, a
// spa by the hour, a hotel by the night — same table underneath, different
// words on the form. worker/biztemplates.mjs.
import { templateFor } from './biztemplates.mjs';
import { consentCheckbox } from './partnersms.mjs';

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
.pnav{display:flex;flex-wrap:wrap;gap:6px 14px;margin:0 0 18px;padding:0 0 14px;border-bottom:1px solid var(--line);font-size:13.5px}
.pnav a{color:var(--muted);text-decoration:none}
.pnav a:hover{color:var(--ink);text-decoration:underline}
.pnav a.pnav-locked{color:#a3a3a3}
.pnav .pnav-on{color:var(--ink);font-weight:600}
.pblurb{margin:-6px 0 16px}
.card.soon{border-style:dashed;background:#fbfaf8}

/* ── PHONE ────────────────────────────────────────────────────────────────
   This console had a viewport tag, a 760px max-width and NOT ONE media query.
   It therefore *scaled* on a phone rather than fitting one, and the people who
   use it are restaurant and hotel owners standing behind a counter — a
   business console read on a desk is the exception, not the rule.
   The tables were the worst of it: a four-column table at 390px either
   overflows the page sideways or squeezes every column to unreadable. Here it
   scrolls inside its own box and the page never moves. */
@media (max-width:560px){
  body{padding:18px 14px 90px}
  h1{font-size:20px}
  h2{margin:22px 0 8px}
  /* Wide content scrolls in its own container; the BODY never scrolls sideways. */
  table{display:block;overflow-x:auto;white-space:nowrap;-webkit-overflow-scrolling:touch}
  .row>*{flex:1 1 100%}
  .plangrid{grid-template-columns:1fr}
  .pnav{gap:4px 12px;font-size:13px}
  /* 16px on inputs is not a style choice: anything smaller makes iOS Safari
     zoom the whole page on focus, and it never zooms back out. */
  input,select{font-size:16px}
  .key{font-size:12.5px}
}
/* The home-screen invitation. Shown only where it can work, and only once the
   owner is actually signed in — see the script at the bottom of the shell. */
.addhome{display:none;background:#fff;border:1px solid var(--line);border-left:4px solid var(--ink);
  border-radius:10px;padding:13px 15px;margin:0 0 16px;font-size:14px}
.addhome.on{display:block}
.addhome b{display:block;margin-bottom:3px;font-size:14.5px}
.addhome p{margin:0;color:var(--muted);line-height:1.5}
.addhome button{width:auto;margin-top:10px;padding:9px 15px;font-size:14px}
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

/**
 * "We do not have you" is not the end of the conversation.
 *
 * `places` holds ~2.5M venues and is still not everyone. Until now an owner we
 * had no listing for searched their own name, got "no listing found", and that
 * was the whole answer — from the door new businesses are actively pointed at.
 * A business we have never heard of is exactly the business we most want.
 *
 * It does NOT create a listing. See worker/bizsubmit.mjs and migration 0007
 * for why a typed address cannot go straight into `places`.
 */
function addYourBusiness(q = '', err = '', values = {}) {
  const F = (name, label, ph = '', required = false) => `
    <label for="add_${name}">${H(label)}</label>
    <input id="add_${name}" name="${name}" value="${H(values[name] ?? '')}"
      placeholder="${H(ph)}"${required ? ' required' : ''}>`;
  return `
    <form method="post" class="card">
      <input type="hidden" name="action" value="submit">
      <h3>Add your business</h3>
      <p class="sub" style="margin:0 0 6px">If NUM has never heard of you, tell us and a person will
        add you by hand. It takes a couple of days and it costs nothing.</p>
      ${err ? `<div class="err">${H(err)}</div>` : ''}
      ${F('name', 'Business name', 'As it appears on your door', true)}
      ${F('name_local', 'Name in your own language', 'If different — we keep it exactly as you write it')}
      ${F('address', 'Street address', 'Where a traveller would walk to', true)}
      <div class="row">
        <div>${F('email', 'Email', 'you@yourbusiness.com')}</div>
        <div>${F('phone', 'Phone', '+66…')}</div>
      </div>
      <div class="row">
        <div>${F('website', 'Website', 'optional')}</div>
        <div>${F('category', 'What kind of place', 'restaurant, hotel, spa…')}</div>
      </div>
      <!-- Asked of everyone, plainly, at the door.
           Num carries licensed cannabis retailers on the same terms as any
           other business. The one thing that cannot wait until later is the
           licence: a regulated trade with no licence number on file is never
           offered to a guest, so asking here saves the applicant a round trip
           and saves us listing something we cannot lawfully carry. -->
      <label for="add_regulated" style="margin-top:14px">
        <input type="checkbox" id="add_regulated" name="regulated" value="1"${values.regulated ? ' checked' : ''}>
        This is a licensed cannabis business
      </label>
      ${F('licence', 'Licence number', 'Your state or city retail / delivery licence — required for cannabis')}
      <p class="sub" style="margin:2px 0 0">We check it against the regulator before anything of yours is
        shown, and we only ever offer delivery to guests in the same place your licence covers.</p>
      <!-- Asked at the door, unticked, in the words that get recorded.
           Until now nothing ever asked a business whether we could text them,
           so the only message any of them could lawfully receive was the code
           they had just requested. -->
      ${consentCheckbox({ checked: false })}
      <button type="submit">Add my business</button>
      <p class="sub" style="margin:10px 0 0">We need an email or a phone number — without one we have no way
        to come back to you when your listing is live.</p>
    </form>`;
}

/** Their submission, and what happens next. Never just "thanks". */
function submitted(out) {
  return shell(`
    <h1>${H(out.already ? 'We already had that one' : 'Got it')}</h1>
    <p class="sub">${H(out.message)}</p>
    <div class="note">Nothing is charged for a listing, now or later. NUM earns only on a booking it
      actually completes for you.</div>
    <p class="foot"><a href="/api/biz/console">Back to sign in</a> ·
      Questions: <a href="mailto:info@itsnum.com">info@itsnum.com</a></p>`);
}

/** Step 1 — pick the listing that is actually yours. */
function results(places, q) {
  if (!places.length) {
    return shell(`
      <h1>We do not have a listing for "${H(q)}"</h1>
      <p class="sub">Try the name as it appears on your door — or add your business below and a person
        will put it in.</p>
      <form method="post" class="card">
        <input type="hidden" name="action" value="find">
        <label for="q">Search again</label>
        <input id="q" name="q" value="${H(q)}">
        <button type="submit" class="ghost">Search</button>
      </form>
      ${addYourBusiness(q)}`);
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
    <p class="sub" style="margin-top:22px">None of these is you?</p>
    ${addYourBusiness(q)}
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
/* ──────────────────────────── the pages ──────────────────────────────────
 *
 * The console was one long scroll: numbers, listing form, ownership, demand,
 * payment, notifications and the plan ladder, in that order, for everyone.
 *
 * That shape had two costs. A business looking for one thing read all of it.
 * And a paid feature could only ever appear as a greyed-out input halfway down
 * somebody else's page, so what a plan actually buys was invisible until you
 * bought it.
 *
 * Now each feature is its own page, the nav lists every one of them, and a
 * page a plan does not open still OPENS — showing what the feature is and what
 * unlocks it. Withholding the explanation as well as the data means a business
 * cannot find out what it would be paying for. See worker/bizpages.mjs.
 */

/** The nav. Every page, always — a lock is a state, not a disappearance. */
function pageNav(pages, current, token, entitlements, opens, pending = 0) {
  const link = (p) => `/api/biz/console?s=${encodeURIComponent(token)}&p=${encodeURIComponent(p.id)}`;
  return `<nav class="pnav">${pages.filter((p) => p.nav).map((p) => {
    const locked = !opens(p, entitlements);
    // A pending count rides the nav entry. A question we asked that sits on a
    // page nobody opens is a question we did not ask.
    const badge = p.id === 'confirm' && pending > 0 ? ` (${pending})` : '';
    if (p.id === current) return `<b class="pnav-on">${H(p.label)}${badge}${locked ? ' &#128274;' : ''}</b>`;
    return `<a href="${link(p)}"${locked ? ' class="pnav-locked"' : ''}>${H(p.label)}${badge}${locked ? ' &#128274;' : ''}</a>`;
  }).join('')}</nav>`;
}

/**
 * A page this plan does not open.
 *
 * Says what the feature is, which plan carries it, and what it costs — then
 * offers the upgrade inline. A business should never have to guess what it is
 * being sold, and "upgrade to find out" is the shape of that mistake.
 */
function lockedPanel(page, tierName, priceCents, token) {
  return `<h2>${H(page.label)}</h2>
    <div class="card">
      <span class="big" style="font-size:18px">&#128274; On ${H(tierName ?? 'a paid plan')}</span>
      <span class="sub">${H(page.unlock ?? page.blurb ?? '')}</span>
      ${priceCents != null ? `<p class="sub" style="margin:10px 0 0">${H(tierName)} is
        <b>${H(USD(priceCents))}</b> a month, cancel any time, and your listing stays free either way.</p>` : ''}
      <p style="margin:12px 0 0"><a href="/api/biz/console?s=${encodeURIComponent(token)}&p=plan">
        <button type="button">See the plans</button></a></p>
    </div>`;
}

/**
 * "Coming soon" for a feature that exists but has produced nothing yet.
 *
 * Deliberately distinct from bizdash's "we cannot measure this" states, which
 * stay verbatim. This one is for a switch NUM has not thrown yet, and it says
 * which — a business reading "coming soon" with no reason cannot tell whether
 * it is waiting on us or on itself.
 */
const soon = (what, why) => `<div class="card soon">
    <span class="big" style="font-size:17px">${H(what)}</span>
    <span class="sub">${H(why)}</span>
  </div>`;

/** Overview — where you stand, in the fewest words that are still true. */
function overviewPage(place, insights, bookings, ready, token, appCard = '') {
  const impressions = insights?.available
    ? `<span class="big">${NUM(insights.impressions)}</span>
       <span class="sub">times NUM showed you to a traveller &middot; last ${H(insights.days)} days</span>`
    : `<span class="sub">${H(insights?.reason ?? 'Not measured yet.')}</span>`;

  const theirs = (ready?.outstanding?.theirs ?? []);
  const nextUp = theirs.length
    ? `<h2>Finish setting up</h2>
       <div class="card">
         <span class="sub">${theirs.length === 1 ? 'One thing is' : `${theirs.length} things are`} still missing
           before a traveller asking about you gets a complete answer.</span>
         <ul class="entlist" style="margin-top:8px">${theirs.map((c) =>
    `<li><b>${H(c.label)}</b> &mdash; ${H(c.why)}</li>`).join('')}</ul>
         <p style="margin:12px 0 0"><a href="/api/biz/console?s=${encodeURIComponent(token)}&p=setup">
           <button type="button">Finish setup</button></a></p>
       </div>`
    : `<h2>Setup</h2><div class="card"><span class="big" style="font-size:18px">&#10003; Everything is set</span>
         <span class="sub">Nothing is missing from your listing. Keeping your hours right is the one thing
           worth checking back on &mdash; it is the detail people act on.</span></div>`;

  return `<div class="card">${impressions}</div>
    ${appCard}
    ${nextUp}
    <h2>Latest booking requests</h2>
    ${bookings.length
    ? `<table><tr><th>When</th><th>Guest</th><th>Party</th><th>For</th></tr>
        ${bookings.slice(0, 5).map((b) => `<tr><td>${H(b.created_at ?? '—')}</td><td>${H(b.guest_name ?? '—')}</td>
          <td>${H(b.party ?? '—')}</td><td>${H(b.when_text ?? b.date ?? '—')}</td></tr>`).join('')}</table>
       <p class="sub" style="margin-top:8px"><a href="/api/biz/console?s=${encodeURIComponent(token)}&p=requests">All requests</a></p>`
    : soon('No booking requests yet',
      'They appear here the moment a traveller asks NUM for a table at your place. Nothing is needed from you.')}`;
}

/**
 * Finish setup — the business's OWN side of the readiness checklist.
 *
 * Filtered to `owner === 'business'` on purpose. What NUM still owes this
 * business is real and tracked, and it belongs on Dre's ops console, not on a
 * merchant's screen: a to-do list that mixes their homework with our apology
 * teaches them to ignore both halves.
 */
function setupPage(ready, token) {
  if (!ready) {
    return `<h2>Finish setup</h2>${soon('Setup state is not available just now',
      'Your listing is unaffected. Try the page again in a minute.')}`;
  }
  const mine = (ready.checklist ?? []).filter((c) => c.owner === 'business');
  const open = mine.filter((c) => c.required && !c.done && !c.unknown);
  const done = mine.filter((c) => c.done);
  const optional = mine.filter((c) => !c.required && !c.done);

  const row = (c, state) => `<li><b>${state} ${H(c.label)}</b><br><span class="sub">${H(c.why)}</span></li>`;
  return `<h2>Finish setup</h2>
    <div class="card">
      <span class="sub">${open.length
    ? `${open.length} of ${mine.filter((c) => c.required).length} required items still to do.`
    : 'Everything required is done.'} Each one is something only you can answer.</span>
      <ul class="entlist" style="margin-top:10px">
        ${open.map((c) => row(c, '&#9633;')).join('')}
        ${optional.map((c) => `<li><b>&#9633; ${H(c.label)}</b> <span class="tag">optional</span><br>
          <span class="sub">${H(c.why)}</span></li>`).join('')}
        ${done.map((c) => row(c, '&#10003;')).join('')}
      </ul>
      <p style="margin:12px 0 0"><a href="/api/biz/console?s=${encodeURIComponent(token)}&p=listing">
        <button type="button">Edit my listing</button></a></p>
    </div>
    <div class="note">Anything we still owe you is tracked on our side and does not appear here &mdash;
      you should not have to chase us through your own dashboard.</div>`;
}

/**
 * What the agent found, waiting on a yes or a no.
 *
 * The two columns are the point. "We took this from your own website" and
 * "a search engine says this" are different claims and a business should be
 * able to tell them apart before agreeing — the first is their own words
 * coming back to them, the second is a stranger's. See bizenrich.mjs.
 */
function confirmPage(pending, applied, token, saved, err) {
  if (!pending.length) {
    return `<h2>Confirm details</h2>
      ${saved ? `<div class="note ok">${H(saved)}</div>` : ''}
      ${errBox(err)}
      ${soon('Nothing to check right now',
    'When we find a detail about your business that is missing from your listing, it appears here for you '
      + 'to confirm before any traveller is told it. We never guess at your opening hours.')}
      ${applied.length ? `<h2>Taken from your own website</h2>
        <div class="card"><span class="sub">These were read from the structured details published on your own
          site, into fields that were empty. Nothing you had already written was changed.</span>
          <ul class="entlist" style="margin-top:8px">${applied.map((a2) =>
    `<li><b>${H(a2.label)}</b> — ${H(a2.value)}</li>`).join('')}</ul>
          <p class="sub" style="margin:10px 0 0">Wrong? Change any of it on
            <a href="/api/biz/console?s=${encodeURIComponent(token)}&p=listing">your listing</a>.</p>
        </div>` : ''}`;
  }
  const rows = pending.map((x) => `
    <form method="post" class="card">
      <input type="hidden" name="action" value="confirm">
      <input type="hidden" name="s" value="${H(token)}">
      <input type="hidden" name="p" value="confirm">
      <input type="hidden" name="proposal" value="${H(x.id)}">
      <h3 style="margin-bottom:2px">${H(x.label)}</h3>
      <p class="sub" style="margin:0 0 8px">${H(x.source === 'own_site'
    ? `From your own website${x.evidence ? ` (${x.evidence})` : ''}`
    : 'From a search engine. We have not checked it, which is why we are asking.')}</p>
      <div class="key" style="border-style:solid">${H(x.value)}</div>
      <div class="row">
        <div><button type="submit" name="accept" value="1">Yes, that is right</button></div>
        <div><button type="submit" name="accept" value="0" class="ghost">No</button></div>
      </div>
    </form>`).join('');

  return `<h2>Confirm details</h2>
    ${errBox(err)}
    ${saved ? `<div class="note ok">${H(saved)}</div>` : ''}
    <div class="note">Your agent went looking for what your listing was missing. Nothing below is on your
      listing yet &mdash; a traveller is told none of it until you say it is right. Saying no keeps it off and
      stops us asking again.</div>
    ${rows}`;
}

/** The listing form. Promotions live on their own page now. */
function listingPage(place, token, saved, err) {
  const F = (name, label, val, ph = '') => `
    <label for="${name}">${H(label)}</label>
    <input id="${name}" name="${name}" value="${H(val ?? '')}" placeholder="${H(ph)}">`;
  return `<h2>What NUM tells travellers</h2>
    ${errBox(err)}
    ${saved ? `<div class="note ok">${H(saved)}</div>` : ''}
    <form method="post" class="card">
      <input type="hidden" name="action" value="save">
      <input type="hidden" name="s" value="${H(token)}">
      <input type="hidden" name="p" value="listing">
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
    <div class="note">Your category, rating and where you appear in a recommendation are <b>not</b> editable &mdash;
      not by you, and not by anyone paying us. They belong to the traveller's trust in NUM, and the day a
      position can be bought the recommendations stop being worth reading.</div>`;
}

/** Promotions — its own page, because it is the first thing a plan buys. */
function promotionsPage(promoText, token, saved, err) {
  return `<h2>Promotions</h2>
    ${errBox(err)}
    ${saved ? `<div class="note ok">${H(saved)}</div>` : ''}
    <form method="post" class="card">
      <input type="hidden" name="action" value="save">
      <input type="hidden" name="s" value="${H(token)}">
      <input type="hidden" name="p" value="promotions">
      <label for="promo_text">A line NUM can mention</label>
      <input id="promo_text" name="promo_text" value="${H(promoText ?? '')}"
        placeholder="e.g. Happy hour 5-7pm, 20% off cocktails">
      <button type="submit">Save</button>
    </form>
    <div class="note">NUM mentions this when it is genuinely relevant to what a traveller asked &mdash; it does not
      move you up a list. Placement is not for sale on any plan, which is the only reason a recommendation is
      worth anything to you.</div>`;
}

/**
 * What this business offers, with prices.
 *
 * Free on every plan, deliberately: this is not an upsell, it is the material
 * NUM answers travellers with. Gating it would mean the concierge knows less
 * about the businesses that pay least, which is backwards.
 */
function offeringsPage(items, currency, token, saved, err, tpl) {
  const rows = items.length
    ? `<table><tr><th>Item</th><th>Section</th><th>Price</th><th>When</th><th></th></tr>
        ${items.map((o) => `<tr${o.active ? '' : ' style="opacity:.5"'}>
          <td><b>${H(o.name)}</b>${o.description ? `<br><span class="sub">${H(o.description)}</span>` : ''}</td>
          <td>${H(o.section ?? '\u2014')}</td>
          <td>${H(o.price_label ?? '\u2014')}</td>
          <td>${H(o.available ?? 'Always')}</td>
          <td><form method="post" style="margin:0">
            <input type="hidden" name="action" value="offer_toggle">
            <input type="hidden" name="s" value="${H(token)}">
            <input type="hidden" name="p" value="offerings">
            <input type="hidden" name="offer" value="${H(o.id)}">
            <input type="hidden" name="to" value="${o.active ? '0' : '1'}">
            <button type="submit" class="ghost" style="width:auto;padding:5px 10px;font-size:12.5px;margin:0">
              ${o.active ? 'Hide' : 'Show'}</button>
          </form></td></tr>`).join('')}</table>`
    : soon('Nothing listed yet',
      'Add your first few items below. NUM only ever says what you have put here \u2014 it does not guess a menu.');

  return `<h2>${H(tpl.label)}</h2>
    ${errBox(err)}
    ${saved ? `<div class="note ok">${H(saved)}</div>` : ''}
    ${rows}
    <h2>Add ${/^[aeiou]/i.test(tpl.noun) ? 'an' : 'a'} ${H(tpl.noun)}</h2>
    ${tpl.note ? `<p class="sub" style="margin:0 0 8px">${H(tpl.note)}</p>` : ''}
    <form method="post" class="card">
      <input type="hidden" name="action" value="offer_save">
      <input type="hidden" name="s" value="${H(token)}">
      <input type="hidden" name="p" value="offerings">
      <label for="o_name">Name</label>
      <input id="o_name" name="name" placeholder="${H(tpl.example)}" required>
      <label for="o_desc">Description</label>
      <input id="o_desc" name="description" placeholder="Optional \u2014 one line a guest would find useful">
      <div class="row">
        <div>
          <label for="o_section">Section</label>
          <input id="o_section" name="section" list="o_sections" placeholder="${H(tpl.sections.slice(0, 3).join(', '))}">
          <datalist id="o_sections">${tpl.sections.map((x) => `<option value="${H(x)}">`).join('')}</datalist>
        </div>
        <div>
          <label for="o_price">Price${currency ? ` (${H(currency)})` : ''}</label>
          <input id="o_price" name="price" inputmode="decimal" placeholder="${H(tpl.price_hint)}">
        </div>
      </div>
      <div class="row">
        <div>
          <label for="o_note">Or say how it is priced</label>
          <input id="o_note" name="price_note" placeholder="Market price, From, Per head">
        </div>
        <div>
          <label for="o_unit">Priced by</label>
          <select id="o_unit" name="unit">
            ${['item', 'person', 'night', 'hour', 'day', 'session', 'group']
    .map((u) => `<option value="${u}"${u === tpl.unit ? ' selected' : ''}>${u}</option>`).join('')}
          </select>
        </div>
      </div>
      <label for="o_avail">Only available</label>
      <input id="o_avail" name="available" placeholder="Lunch only, 12\u20133 \u2014 leave empty if always">
      <button type="submit">Add</button>
    </form>
    <div class="note">${currency
    ? `Prices are in <b>${H(currency)}</b>, taken from where your business is. `
    : 'We could not work out your currency from your listing, so prices show as plain numbers. '
      + 'Set your address on your listing page and they will show correctly. '}
      A price can be left empty \u2014 &ldquo;market price&rdquo; is a real answer and better than a made-up
      number. NUM tells a traveller what you have listed here as <b>what you say you charge</b>, never as a
      quote or a bill.</div>`;
}

/** Booking requests, in full. */
function requestsPage(bookings, events = []) {
  // Parties coming: members hosting an event AT this business. Headcount is
  // confirmed guests plus their plus-ones plus the host — never the invited
  // count, which is a hope, not a number a kitchen can plan for.
  const parties = events.length
    ? `<h2>Parties coming</h2><table><tr><th>When</th><th>What</th><th>Host</th><th>Expected</th><th>Said yes</th></tr>
        ${events.map((e) => `<tr><td>${H([e.day, e.time].filter(Boolean).join(' ') || 'date TBC')}</td><td>${H(e.title)}</td>
          <td>${H(e.host ?? '—')}</td><td>${H(e.expected)}${e.capacity ? ` of ${H(e.capacity)}` : ''}</td><td>${H(e.yes)} of ${H(e.invited)} invited</td></tr>`).join('')}</table>
        <div class="note">A member of NUM is hosting this at your place. Guest names stay with the host; the headcount is theirs to confirm with you.</div>`
    : '';
  return `${parties}<h2>Booking requests</h2>
    ${bookings.length
    ? `<table><tr><th>When</th><th>Guest</th><th>Party</th><th>For</th><th>State</th></tr>
        ${bookings.map((b) => `<tr><td>${H(b.created_at ?? '—')}</td><td>${H(b.guest_name ?? '—')}</td>
          <td>${H(b.party ?? '—')}</td><td>${H(b.when_text ?? b.date ?? '—')}</td>
          <td>${H(b.state ?? '—')}</td></tr>`).join('')}</table>`
    : soon('No booking requests yet',
      'They appear here the moment a traveller asks NUM for a table at your place. '
        + 'Nothing is needed from you, and the phone number on your listing is texted at the same time.')}`;
}

/** Impressions, with the plan's own window stated rather than implied. */
function insightsPage(insights, plan, token) {
  const body = insights?.available
    ? `<div class="card"><span class="big">${NUM(insights.impressions)}</span>
        <span class="sub">times NUM showed you to a traveller &middot; last ${H(insights.days)} days</span></div>`
    : soon('Not measured yet', insights?.reason ?? 'NUM does not record this yet, and we will not estimate it.');
  const window = plan?.analytics_days ?? 7;
  return `<h2>How you are doing</h2>
    ${body}
    <div class="note">Your plan looks back <b>${H(window)} days</b>.
      ${window < 365 ? `<a href="/api/biz/console?s=${encodeURIComponent(token)}&p=plan">A longer window is on a paid plan.</a>` : ''}
      This counts times NUM put you in front of a traveller &mdash; not searches for you by name, which we
      mostly cannot know and will not imply.</div>`;
}

/** Every listing under this business. */
function locationsPage(locations, plan, token) {
  const max = plan?.multi_location_max;
  return `<h2>Your locations</h2>
    ${locations.length
    ? `<table><tr><th>Name</th><th>Where</th></tr>
        ${locations.map((l) => `<tr><td>${H(l.name)}</td>
          <td>${H([l.category, l.dest].filter(Boolean).join(' · ') || '—')}</td></tr>`).join('')}</table>`
    : soon('One location on this account',
      'Claim another listing from the sign-in page and it joins this plan automatically.')}
    <div class="note">Your plan covers <b>${max == null ? 'unlimited' : H(max)}</b> location${max === 1 ? '' : 's'}.
      Claiming another listing with the same business adds it here.</div>`;
}

/**
 * API and agent access — free, on every plan, and said plainly.
 *
 * /pricing/ has been selling this as the $50 tier. It is not gated and cannot
 * be: the business key IS the claim mechanism and the free dashboard calls
 * through it. A business on the free plan reading this page finds out it
 * already has what the website told it to pay for.
 */
function apiPage(place) {
  return `<h2>API &amp; AI agents</h2>
    <div class="card">
      <span class="big" style="font-size:18px">Included on every plan</span>
      <span class="sub">Your business key works with the REST API and with NUM's MCP server, on the free plan
        as well as the paid ones. An assistant can keep your hours current, answer with your real details and
        post a promotion for you.</span>
    </div>
    <div class="card">
      <h3>Where to point it</h3>
      <ul class="entlist">
        <li><b>REST</b> &mdash; <code>https://app.itsnum.com/api/biz/v1/</code>, your key as a Bearer token</li>
        <li><b>MCP</b> &mdash; <code>https://app.itsnum.com/api/biz/mcp</code></li>
        <li><b>Listing ID</b> &mdash; <code>${H(place?.place_id ?? place?.id ?? '')}</code></li>
      </ul>
      <p class="sub" style="margin:10px 0 0"><a href="/api/biz">Full API and MCP documentation</a></p>
    </div>
    <div class="note">Lost your key? It is stored only as a hash, so it cannot be shown again &mdash;
      email <a href="mailto:info@itsnum.com">info@itsnum.com</a> and we will issue a new one.</div>`;
}

/** Early access — what the top plan is actually for. */
function betaPage() {
  return `<h2>Early access</h2>
    ${soon('Nothing in early access this month',
    'When a NUM for Business feature is ready to try, it appears here first and we ask you what is wrong with '
      + 'it before anyone else sees it. We would rather show an empty page than invent a roadmap.')}`;
}

/**
 * The owner-verified badge, or the shortest honest route to earning it.
 *
 * Approval is automatic — every business gets this dashboard the moment it
 * claims. This page is the OTHER question: should a traveller be told the
 * listing is confirmed by its owner. It is the only status in the console the
 * owner can change by doing something, which is why it has a page rather than
 * a paragraph.
 */
function verifiedSection(v, token, place) {
  if (v?.verified) {
    return `<h2>Ownership</h2>
      <div class="card"><span class="big" style="font-size:20px">&#10003; Verified owner</span>
        <span class="sub">Confirmed by ${H(v.method)}${v.since ? ` on ${H(String(v.since).slice(0, 10))}` : ''}.
          Travellers see this listing as confirmed.</span></div>`;
  }
  const host = place?.website ? String(place.website).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] : null;
  return `<h2>Ownership</h2>
    <div class="card">
      <span class="sub">Your listing is live and yours to edit. It is <b>not yet marked as owner-verified</b> —
        that badge needs one piece of proof, and it takes a minute.</span>
      <ul style="margin:10px 0 0 18px;padding:0;font-size:13px;line-height:1.7">
        <li><b>Your website</b>${host ? ` — put a file containing <code>${H(token ?? '')}</code> at
          <code>https://${H(host)}/.well-known/num-verify.txt</code>, then reload this page.`
    : ` — add your website on the listing page and save, then this option appears.`}</li>
        <li><b>Your business email</b> — sign in with the email on your Google Business listing, or the one
          published on this listing. A personal Gmail only works if it is the address already on the listing.</li>
      </ul>
    </div>`;
}

/**
 * What travellers near this business actually asked Num.
 *
 * NOT "people searched for you" — we mostly cannot know that, and implying it
 * would be the most flattering lie on the page. It is real demand in their
 * destination, which is the honest version and still the useful one: it tells
 * an owner what people arrive wanting.
 */
function demandSection(demand) {
  if (!demand?.available) {
    return `<h2>What travellers are asking</h2>
      ${soon('Nothing asked here yet', demand?.reason ?? 'Not measured yet.')}`;
  }
  return `<h2>What travellers are asking</h2>
    <div class="card"><span class="sub">Real questions asked in ${H(demand.dest)} in the last
      ${H(demand.days)} days. Not searches for you — what people arrive wanting.</span></div>
    <table><tr><th>They asked</th><th>Times</th></tr>
      ${demand.asks.map((a) => `<tr><td>${H(a.text)}</td><td>${H(a.n)}</td></tr>`).join('')}
    </table>`;
}

/** The QR a guest scans to pay. State, never a promise — see bizdash.payQr. */
function payQrSection(qr) {
  if (qr?.ready) {
    return `<h2>Taking payment</h2>
      <div class="card"><span class="big" style="font-size:18px">Pay code active</span>
        <span class="sub">${H(qr.label ?? 'Your QR is live')}${qr.created_at ? ` · since ${H(String(qr.created_at).slice(0, 10))}` : ''}.
          Print it for the counter and guests can settle by scanning.</span></div>`;
  }
  return `<h2>Taking payment</h2>
    <div class="card"><span class="sub">${H(qr?.reason ?? 'Not set up yet.')}</span>
      <p style="margin:9px 0 0"><a href="mailto:info@itsnum.com?subject=Pay%20code%20for%20my%20listing">Ask us to switch it on</a></p>
    </div>`;
}

/**
 * Where a booking request and the weekly note go.
 *
 * The venue's PUBLISHED phone still gets the booking text either way — that is
 * the message that holds a table, and it is not switchable here. This page
 * only controls the owner's own copy, which is why turning everything off is a
 * safe thing to offer.
 */
function notifySection(n, token) {
  if (!n) {
    return `<h2>Notifications</h2>
      ${soon('Notification settings are not available yet',
    'They appear once your listing is linked to a business account. Booking texts to your listed phone '
      + 'number are unaffected.')}`;
  }
  const ck = (on) => (on ? ' checked' : '');
  return `<h2>Notifications</h2>
    <form method="post" class="card">
      <input type="hidden" name="action" value="notify">
      <input type="hidden" name="s" value="${H(token)}">
      <input type="hidden" name="p" value="notifications">
      <label for="notify_email">Send my copies to</label>
      <input id="notify_email" name="notify_email" value="${H(n.email ?? '')}" placeholder="you@yourbusiness.com">
      ${n.inherited && n.email ? `<div class="sub">Using the address you signed up with. Change it here and it is yours.</div>` : ''}
      <p style="margin:10px 0 0"><label><input type="checkbox" name="on_booking" value="1"${ck(n.on_booking)}>
        Email me when a traveller asks for a table</label></p>
      <p style="margin:6px 0 0"><label><input type="checkbox" name="on_weekly" value="1"${ck(n.on_weekly)}>
        A short weekly note — only in weeks something actually happened</label></p>
      <button type="submit">Save</button>
    </form>
    <div class="note">The phone number on your listing is texted about a booking either way, with confirm and
      decline links — that text is what holds the table, and these settings do not switch it off.</div>`;
}

/**
 * The dashboard: nav, then exactly one page.
 *
 * The gate is checked HERE, once, for the page being rendered — not inside
 * each section. One check is one place to be wrong, and it is the same check
 * the nav's lock icon and the public pricing table read.
 */
/** The one place a business owner is ever asked to put NUM on their phone.
 *
 * NOT on the sign-in page, and not before they are in. A stranger asked to
 * install something has been asked for a favour; an owner looking at their own
 * dashboard has a reason. The consumer install page taught this the expensive
 * way — it asked 1,805 people on arrival and reached three of them.
 *
 * Three worlds, and only one of them has a button that works:
 *   · Chrome/Android, prompt deferred  → a real one-tap install
 *   · iOS Safari                       → no API exists; words are the only
 *                                        honest option
 *   · an in-app webview (a link opened from an email inside Gmail, Outlook,
 *     LINE) → CANNOT install at all, so we say so rather than showing a
 *     button that does nothing. This is exactly how a merchant arrives:
 *     tapping the link in our own invitation.
 *
 * The URL matters. A console session lives in the query string, so the icon
 * must NOT capture the current URL — a saved link containing a session is a
 * credential on a home screen that stops working when the session expires.
 * It points at the sign-in page instead.
 */
function addToHomeScreen() {
  return `<div class="addhome" id="addhome">
    <b>Keep this on your phone</b>
    <p id="addhow">One tap to your bookings, your promo and what NUM is telling travellers about you.</p>
    <button type="button" id="addbtn" hidden>Add to home screen</button>
  </div>
<script>
(function(){
  var box=document.getElementById('addhome'),btn=document.getElementById('addbtn'),how=document.getElementById('addhow');
  if(!box) return;
  var ua=navigator.userAgent||'';
  var inApp=/FBAN|FBAV|Instagram|Line\\/|Twitter|Snapchat|GSA|Outlook-|OutlookMobile/i.test(ua);
  var iOS=/iPad|iPhone|iPod/.test(ua)&&!window.MSStream;
  var standalone=(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||window.navigator.standalone===true;
  if(standalone) return;                      // already there — never nag
  var deferred=null;
  window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();deferred=e;btn.hidden=false;box.className='addhome on';});
  if(inApp){
    how.textContent='You are reading this inside an app\\u2019s own browser, which cannot add to a home screen. Open this page in Safari or Chrome and it takes ten seconds.';
    box.className='addhome on';
  } else if(iOS){
    how.textContent='On iPhone: tap Share at the bottom of Safari, then \\u201cAdd to Home Screen\\u201d.';
    box.className='addhome on';
  }
  btn.onclick=function(){ if(!deferred) return; btn.disabled=true; var d=deferred; deferred=null; d.prompt(); };
})();
<\/script>`;
}

function dashboard(place, insights, bookings, token, saved = '', err = '', extra = {}) {
  const {
    plan = { tier: 'free' }, allTiers = {}, locations = [], promoText = '',
    planErr = '', planSaved = '', pages, pageFor, opens, cheapestTierFor, readiness = null,
  } = extra;
  const page = pageFor(extra.page);
  const link = `/api/biz/console?s=${encodeURIComponent(token)}&p=${encodeURIComponent(page.id)}`;

  let body;
  if (!opens(page, plan)) {
    const tier = cheapestTierFor(page.id, allTiers);
    body = lockedPanel(page, tier?.name, tier?.price_cents, token);
  } else {
    switch (page.id) {
      case 'setup':         body = setupPage(readiness, token); break;
      case 'confirm':       body = confirmPage(extra.pending ?? [], extra.autofilled ?? [], token, saved, err); break;
      case 'listing':       body = listingPage(place, token, saved, err); break;
      case 'promotions':    body = promotionsPage(promoText, token, saved, err); break;
      case 'offerings':     body = offeringsPage(extra.offerings ?? [], extra.offerCurrency, token, saved, err, extra.tpl ?? templateFor(null)); break;
      case 'delivery':      body = deliveryPage({ settings: extra.delivery?.settings ?? null, orders: extra.delivery?.orders ?? [], priced: extra.delivery?.priced ?? 0, next: extra.delivery?.next, token, saved, err }); break;
      case 'requests':      body = requestsPage(bookings, extra.events ?? []); break;
      case 'insights':      body = insightsPage(insights, plan, token); break;
      case 'demand':        body = demandSection(extra.demand); break;
      case 'locations':     body = locationsPage(locations, plan, token); break;
      case 'ownership':     body = verifiedSection(extra.verification, extra.verifyToken, place); break;
      case 'notifications': body = notifySection(extra.notify, token); break;
      case 'payments':      body = payQrSection(extra.payQr); break;
      case 'api':           body = apiPage(place); break;
      case 'beta':          body = betaPage(); break;
      case 'plan':          body = planSection(plan, allTiers, token, planSaved, planErr); break;
      default:              body = overviewPage(place, insights, bookings, readiness, token, extra.appCard ?? '');
    }
  }

  return shell(`
    <h1>${H(place.name)}</h1>
    <p class="sub">${H([place.category, place.area, place.dest].filter(Boolean).join(' · ') || '—')} ·
      ${H(allTiers[plan?.tier ?? 'free']?.name ?? 'Listed')} plan ·
      <a href="${link}">refresh</a></p>
    ${addToHomeScreen()}
    ${pageNav(pages, page.id, token, plan, opens, (extra.pending ?? []).length)}
    ${page.id !== 'overview' ? `<p class="sub pblurb">${H(page.blurb)}</p>` : ''}
    ${body}
    <p class="foot">Listing ID <code>${H(place.place_id ?? place.id)}</code> ·
      Dashboard v${H(extra.version ?? '?')} (${H(extra.released ?? '')}) ·
      Questions: <a href="mailto:info@itsnum.com">info@itsnum.com</a> ·
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

async function loadDashboard(env, placeId, token, origin, saved = '', err = '', planSaved = '', planErr = '', page = 'overview') {
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

  // The owner's view and the admin's see-what-they-see view are assembled by
  // ONE function (bizdash.dashboardData), so a preview can never show numbers
  // the owner's own screen does not have.
  const { dashboardData } = await import('./bizdash.mjs');
  const { siteToken } = await import('./bizverify.mjs');
  const data = await dashboardData(env, { place, plan: { ...plan, business_id: businessId }, insights, bookings: bookings ?? [] });
  // Minted per listing and stable, so an owner who comes back tomorrow to
  // finish the job is given the same token — see bizverify.siteToken.
  const verifyToken = await siteToken(env, placeId).catch(() => null);
  const { prefs: notifyPrefs } = await import('./biznotify.mjs');
  const notify = businessId ? await notifyPrefs(env, businessId).catch(() => null) : null;

  // The business's OWN outstanding items, from the same readiness model the
  // ops console and this listing's agent read. Filtered to their side inside
  // setupPage — a merchant's to-do list must never carry our apologies.
  let readiness = null;
  if (businessId) {
    const { readinessFor } = await import('./bizreadiness.mjs');
    readiness = await readinessFor(env, businessId).catch(() => null);
  }
  // What this business offers. Loaded on every page because the count rides
  // the nav, the same way the confirm badge does.
  let offerings = [];
  let offerCurrency = null;
  if (businessId) {
    const { listFor, currencyFor } = await import('./bizoffer.mjs');
    offerings = await listFor(env, businessId).catch(() => []);
    const prof = await env.DB.prepare('SELECT country FROM num_business_profiles WHERE business_id=?1')
      .bind(businessId).first().catch(() => null);
    offerCurrency = currencyFor(prof?.country);
  }

  // Delivery: settings, orders, and how many listed items can actually be
  // ordered (active + priced). Only read for the page that shows it; a broken
  // read leaves the page saying "off" rather than taking the console down.
  let delivery = null;
  if (businessId && String(page ?? '') === 'delivery') {
    try {
      const d = await import('./delivery.mjs');
      const [settings, orders, priced] = await Promise.all([
        d.deliverySettings(env, businessId).catch(() => null),
        d.ordersFor(env, businessId).catch(() => []),
        d.orderable(env, businessId, { limit: 100 }).then((r) => r.length).catch(() => 0),
      ]);
      delivery = { settings, orders, priced, next: d.ORDER_NEXT };
    } catch (e) { console.warn('[bizconsole] delivery', e?.message ?? e); }
  }

  // Their own words for their trade, from the listing. No new question asked.
  const tpl = templateFor(place?.category);

  const { PAGES, pageFor, opens, cheapestTierFor } = await import('./bizpages.mjs');

  // What the agent found: still-open questions, and what it already wrote in
  // from the business's own site (shown so nothing lands silently).
  let pending = [];
  let autofilled = [];
  if (businessId) {
    const { pendingFor, FIELD_LABEL } = await import('./bizenrich.mjs');
    pending = await pendingFor(env, businessId).catch(() => []);
    const { results } = await env.DB.prepare(
      `SELECT field, value FROM num_business_field_proposals
        WHERE business_id = ?1 AND state = 'applied' AND source = 'own_site'
        ORDER BY created_at DESC LIMIT 8`,
    ).bind(businessId).all().catch(() => ({ results: [] }));
    autofilled = (results ?? []).map((r) => ({ ...r, label: FIELD_LABEL[r.field] ?? r.field }));
  }

  // "Put NUM on your phone." Only on the overview, only until they tell us it
  // is done or that they do not want to be asked — and only for a business
  // that actually has an account, because there is nothing to sign into
  // otherwise.
  let appCard = '';
  if (businessId && String(page ?? 'overview') === 'overview') {
    try {
      const { appState, shouldShow, installCard } = await import('./bizinstall.mjs');
      if (shouldShow(await appState(env, businessId))) {
        appCard = installCard({ token, page: 'overview' });
      }
    } catch (e) { console.warn('[bizconsole] install card', e?.message ?? e); }
  }

  return dashboard(place, insights, bookings ?? [], token, saved, err, {
    appCard,
    plan, allTiers, locations, promoText, planSaved, planErr,
    version: data.version, released: data.released, notify,
    demand: data.demand, payQr: data.pay_qr, verification: data.verification, events: data.events ?? [],
    verifyToken, readiness, page, pending, autofilled, offerings, offerCurrency, delivery, tpl,
    pages: PAGES, pageFor, opens, cheapestTierFor,
  });
}

/**
 * Read-only impressions, same honesty contract as GET /v1/insights.
 *
 * Exported as `insightsForAdmin` so the see-what-they-see view computes the
 * number the SAME way rather than approximating it — a preview that differs
 * from the owner's page is worse than no preview.
 */
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
    // ?q= prefills the finder. The onboarding email links an owner straight to
    // their own name rather than a blank box — a business that has waited
    // three weeks should not arrive and have to type its own name to find
    // itself. It is only a prefill: nothing is authorised by a query string.
    const prefill = (url.searchParams.get('q') ?? '').slice(0, 80);

    // ?t= — the single-use link in the welcome email.
    //
    // Spent here and then REMOVED FROM THE ADDRESS BAR by redirecting to the
    // ordinary ?s= session URL. That redirect is not cosmetic: it is what
    // keeps the one-time token out of the page's own address, out of any
    // referrer it sends, and out of a bookmark. See worker/bizsignin.mjs for
    // why a link that signs in is defensible where a link carrying the
    // permanent key is not.
    const t = url.searchParams.get('t');
    if (t) {
      const { spendSigninLink, SIGNIN_MESSAGE } = await import('./bizsignin.mjs');
      const out = await spendSigninLink(env, t).catch(() => ({ ok: false, reason: 'missing' }));
      if (!out.ok) return landing(SIGNIN_MESSAGE[out.reason] ?? SIGNIN_MESSAGE.missing, prefill);
      const fresh = await mintSession(env, out.place_id);
      return new Response(null, {
        status: 302,
        headers: {
          Location: `/api/biz/console?s=${encodeURIComponent(fresh)}&p=overview`,
          'Cache-Control': 'no-store',
          // A one-time token must not travel to anything this page links to.
          'Referrer-Policy': 'no-referrer',
        },
      });
    }

    const s = url.searchParams.get('s');
    if (!s) return landing('', prefill);
    const placeId = await sessionPlace(env, s);
    if (!placeId) return landing('That session expired — sign in with your key again.');
    // Stripe redirects here straight from its own hosted checkout page —
    // grantBizTier() runs from the webhook, which is asynchronous and usually
    // fast but is never guaranteed to have landed before this GET does. Said
    // plainly rather than silently showing the OLD plan and looking broken.
    const upgraded = url.searchParams.get('upgraded');
    const planSaved = upgraded ? `Payment received — your plan updates within a few seconds. Refresh if ${H(upgraded)} doesn't show yet.` : '';
    const page = (url.searchParams.get('p') ?? (upgraded ? 'plan' : 'overview')).slice(0, 24);
    return await loadDashboard(env, placeId, s, origin, '', '', planSaved, '', page);
  }
  if (request.method !== 'POST') return landing();

  let form;
  try { form = await request.formData(); } catch { return landing('That did not go through — try again.'); }
  const action = String(form.get('action') ?? '');
  const val = (k) => String(form.get(k) ?? '').trim();
  // Every form carries the page it was submitted from, so saving on the
  // notifications page returns to the notifications page. Without it, each
  // save bounced the owner back to the overview and the change they just made
  // was two clicks away — which reads as "it did not save".
  const backTo = val('p') || 'overview';

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
    return await loadDashboard(env, placeId, token, origin, '', '', '', '', backTo);
  }

  // Adding or changing something on the list of what they offer.
  if (action === 'offer_save' || action === 'offer_toggle') {
    const token = val('s');
    const placeId = await sessionPlace(env, token);
    if (!placeId) return landing('That session expired \u2014 sign in again.');
    const businessId = await ownerOf(env, placeId);
    if (!businessId) {
      return loadDashboard(env, placeId, token, origin, '', 'Claim this listing first.', '', '', 'offerings');
    }
    const bizoffer = await import('./bizoffer.mjs');

    if (action === 'offer_toggle') {
      const on = val('to') === '1';
      const out = on
        ? await bizoffer.show(env, businessId, val('offer'))
        : await bizoffer.hide(env, businessId, val('offer'));
      return loadDashboard(env, placeId, token, origin,
        out.ok ? (on ? 'Back on your list.' : 'Hidden \u2014 NUM will stop mentioning it.') : '',
        out.ok ? '' : 'That item is no longer on your list.', '', '', 'offerings');
    }

    const out = await bizoffer.upsert(env, businessId, {
      name: val('name'), description: val('description'), section: val('section'),
      price: val('price'), price_note: val('price_note'), unit: val('unit'), available: val('available'),
    });
    return loadDashboard(env, placeId, token, origin,
      out.ok ? 'Added. NUM can mention it from the next question a traveller asks.' : '',
      out.ok ? '' : (out.error ?? 'Could not save that.'), '', '', 'offerings');
  }

  // Delivery settings and the order buttons. worker/delivery.mjs owns the
  // rules (licence before on, legal moves only); this only carries the form.
  if (action === 'delivery_save' || action === 'order_move') {
    const token = val('s');
    const placeId = await sessionPlace(env, token);
    if (!placeId) return landing('That session expired \u2014 sign in again.');
    const businessId = await ownerOf(env, placeId);
    if (!businessId) {
      return loadDashboard(env, placeId, token, origin, '', 'Claim this listing first.', '', '', 'delivery');
    }
    const d = await import('./delivery.mjs');
    if (action === 'order_move') {
      const to = val('to');
      const out = await d.decideOrder(env, { businessId, orderId: val('order'), status: to, actor: 'business', reason: val('reason') || null });
      const said = { accepted: 'Accepted \u2014 the guest has been told.', preparing: 'Marked as preparing.', out_for_delivery: 'On its way \u2014 the guest has been told.', delivered: 'Delivered. Thank you.', declined: 'Declined \u2014 the guest has been told.', cancelled: 'Cancelled.' }[to] ?? 'Updated.';
      return loadDashboard(env, placeId, token, origin, out.ok ? said : '', out.ok ? '' : (out.error ?? 'Could not update that order.'), '', '', 'delivery');
    }
    const out = await d.saveDelivery(env, businessId, {
      on: val('on') === '1',
      fee_cs: Math.round(Number(val('fee').replace(/[^0-9.]/g, '')) * 100),
      radius_m: Math.round(Number(val('radius_km').replace(/[^0-9.]/g, '')) * 1000),
      licence: val('licence'), age_min: Number(val('age_min')), hours: val('hours'),
    }, 'console');
    return loadDashboard(env, placeId, token, origin,
      out.ok ? (val('on') === '1' ? 'Saved. Delivery is on \u2014 a traveller nearby can order from your priced items now.' : 'Saved. Delivery is off.') : '',
      out.ok ? '' : (out.error ?? 'Could not save that.'), '', '', 'delivery');
  }

  // A business NUM has never heard of, telling us it exists.
  if (action === 'submit') {
    const { submit, SUBMISSION_STATE } = await import('./bizsubmit.mjs');
    const input = {
      name: val('name'), name_local: val('name_local'), address: val('address'),
      email: val('email'), phone: val('phone'), website: val('website'), category: val('category'),
      regulated: val('regulated') === '1', licence: val('licence'),
      // Where they are, from Cloudflare's own geo rather than from a dropdown:
      // one fewer field between a busy owner and finishing.
      country: request.headers.get('CF-IPCountry') ?? null,
    };
    const out = await submit(env, input, { source: 'console' });
    if (!out.ok) {
      return shell(`<h1>Add your business</h1>${addYourBusiness('', out.error, input)}`);
    }
    // The opt-in is recorded against the submission, which is the only id this
    // business has until a human promotes it. A failure here must not lose the
    // submission — they told us they exist, and that is the part that matters.
    if (val('sms_opt_in') === '1') {
      const { optIn, KIND } = await import('./partnersms.mjs');
      await optIn(env, {
        kind: KIND.BUSINESS,
        partnerId: out.id,
        phone: input.phone,
        ticked: true,
        page: '/business (add)',
        ip: request.headers.get('CF-Connecting-IP') ?? null,
        userAgent: request.headers.get('User-Agent') ?? null,
        country: input.country,
        name: input.name,
      }).catch(() => null);
    }
    return submitted({ ...out, message: SUBMISSION_STATE[out.status] ?? SUBMISSION_STATE.new });
  }

  // "Done — it is on my phone", or "Not now".
  //
  // Taken as told. This page is rendered on a server and cannot see somebody's
  // home screen; and the owner reading the console on a laptop is not on the
  // device the question is about, so detecting anything here would answer a
  // question about the wrong machine.
  if (action === 'app_installed') {
    const token = val('s');
    const placeId = await sessionPlace(env, token);
    if (!placeId) return landing('That session expired — sign in again.');
    const businessId = await ownerOf(env, placeId);
    if (businessId) {
      const { markInstalled, dismiss } = await import('./bizinstall.mjs');
      if (val('later') === '1') await dismiss(env, businessId);
      else await markInstalled(env, businessId);
    }
    return loadDashboard(env, placeId, token, origin,
      val('later') === '1' ? '' : 'Good — orders will reach you on your phone from now on.',
      '', '', '', 'overview');
  }

  // The owner answering one of the agent's questions.
  if (action === 'confirm') {
    const token = val('s');
    const placeId = await sessionPlace(env, token);
    if (!placeId) return landing('That session expired — sign in again.');
    const businessId = await ownerOf(env, placeId);
    if (!businessId) {
      return loadDashboard(env, placeId, token, origin, '', 'Claim this listing first.', '', '', 'confirm');
    }
    const { decide } = await import('./bizenrich.mjs');
    const accept = val('accept') === '1';
    // The proposal id carries the business it belongs to; decide() re-reads the
    // row and writes to ITS place_id, never to the session's — so a forged id
    // cannot edit somebody else's listing through this form.
    const prop = await env.DB.prepare(
      "SELECT business_id FROM num_business_field_proposals WHERE id = ?1 AND state = 'proposed'",
    ).bind(val('proposal')).first().catch(() => null);
    if (!prop || String(prop.business_id) !== String(businessId)) {
      return loadDashboard(env, placeId, token, origin, '', 'That suggestion is no longer open.', '', '', 'confirm');
    }
    const out = await decide(env, { id: val('proposal'), accept, by: 'owner' });
    return loadDashboard(env, placeId, token, origin,
      out.ok ? (accept ? 'Saved — travellers see that from the next question asked.' : 'Noted. We will not suggest that again.') : '',
      out.ok ? '' : (out.error ?? 'Could not record that.'), '', '', 'confirm');
  }

  if (action === 'notify') {
    const token = val('s');
    const placeId = await sessionPlace(env, token);
    if (!placeId) return landing('That session expired — sign in with your key again.');
    const businessId = await ownerOf(env, placeId);
    // A listing nobody has claimed has no owner to notify. Say so rather than
    // silently accepting settings that can never fire.
    if (!businessId) {
      return loadDashboard(env, placeId, token, origin, '', 'Claim this listing first and notifications become yours to set.', '', '', backTo);
    }
    const { setPrefs } = await import('./biznotify.mjs');
    const email = val('notify_email');
    // An address that is not an address would silently swallow every future
    // notification, which looks exactly like "Num never told me".
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
      return loadDashboard(env, placeId, token, origin, '', 'That email address does not look complete.', '', '', backTo);
    }
    await setPrefs(env, businessId, {
      email: email || null,
      onBooking: !!val('on_booking'),
      onWeekly: !!val('on_weekly'),
    });
    return loadDashboard(env, placeId, token, origin, 'Notification settings saved.', '', '', '', backTo);
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
        return await loadDashboard(env, placeId, token, origin, '', 'Promotions are part of a paid plan.', '', '', backTo);
      }
    }

    if (!sets.length && !promoNote) return await loadDashboard(env, placeId, token, origin, '', 'Nothing to save.', '', '', backTo);
    if (sets.length) {
      await env.DB.prepare(
        `UPDATE places SET ${sets.map(([k], i) => `${k}=?${i + 2}`).join(', ')} WHERE id=?1`,
      ).bind(placeId, ...sets.map(([, v]) => String(v).slice(0, 400))).run();
    }
    return await loadDashboard(env, placeId, token, origin, 'Saved. NUM will use this from the next question a traveller asks.', '', '', '', backTo);
  }

  if (action === 'upgrade') {
    const token = val('s');
    const placeId = await sessionPlace(env, token);
    if (!placeId) return landing('That session expired — sign in with your key again.');
    const businessId = await ownerOf(env, placeId);
    if (!businessId) return await loadDashboard(env, placeId, token, origin, '', '', '', 'No business is attached to this listing yet — email info@5arz.com.', 'plan');
    const { bizTiers } = await import('./bizbilling.mjs');
    const tier = val('tier');
    const t = bizTiers(env)[tier];
    if (!tier || !t || !(t.price_cents > 0)) {
      return await loadDashboard(env, placeId, token, origin, '', '', '', 'Pick a plan to upgrade to.', 'plan');
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
      return await loadDashboard(env, placeId, token, origin, '', '', '', out.error || 'Could not start checkout — try again in a minute.', 'plan');
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
    if (!businessId) return await loadDashboard(env, placeId, token, origin, '', '', '', '', backTo);
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
        : "You're on the free plan — nothing to cancel.", '', 'plan');
    }
    const { cancelSubscription } = await import('./pay.mjs');
    const out = await cancelSubscription(env, row.stripe_sub);
    return await loadDashboard(env, placeId, token, origin, '', '',
      out.ok ? `Done — ${row.tier} stays active until ${row.renews_at}, then won't charge again.` : '',
      out.ok ? '' : (out.error || 'Could not cancel — try again in a minute.'), 'plan');
  }

  return landing();
}

export const __testables = { mintSession, sessionPlace, sign };

/** See-what-they-see (index.mjs /api/admin/biz-view) — the owner's own calculation. */
export const insightsForAdmin = (env, placeId, days) => insightsFor(env, placeId, days);
