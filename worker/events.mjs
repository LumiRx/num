// Events, RSVP-by-text, and the host dashboard.
//
// The design constraint that shapes everything: **the guest must not need the
// app.** They get one text with one link; that link is a real page that says
// where, when, what to wear, and has two big buttons. No download, no account,
// no login. That is why RSVP lives on a server-rendered page rather than in
// the SPA, and why the RSVP token is the identity — it arrived on their phone,
// which is the same proof an invite link gives us everywhere else in Num.
//
// The host side is the dashboard an event site would give you: who's coming,
// who hasn't answered, plus-ones, and a one-tap chase for the silent ones —
// again sent from the host's own phone rather than from an unknown shortcode.
import { uid, normalisePhone, maskPhone } from '../claim/verify.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const html = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

const readBody = async (req) => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
function token(n = 10) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_events (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, business_id TEXT, title TEXT NOT NULL, day TEXT, time TEXT, place TEXT, address TEXT, dress TEXT, note TEXT, capacity INTEGER, plan_id TEXT, slug TEXT UNIQUE, state TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_num_events_host ON num_events(host_id);
CREATE TABLE IF NOT EXISTS num_event_guests (token TEXT PRIMARY KEY, event_id TEXT NOT NULL, name TEXT, phone TEXT, member_id TEXT, rsvp TEXT NOT NULL DEFAULT 'pending', plus_ones INTEGER NOT NULL DEFAULT 0, message TEXT, invited_at TEXT NOT NULL DEFAULT (datetime('now')), opened_at TEXT, replied_at TEXT);
CREATE INDEX IF NOT EXISTS idx_num_event_guests_event ON num_event_guests(event_id, rsvp);
`;

let ensured = false;
async function ensure(env) {
  if (ensured) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ensured = true;
}

const when = (e) =>
  [e.day ? new Date(e.day + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) : null, e.time]
    .filter(Boolean)
    .join(' · ');

// ── host side ─────────────────────────────────────────────────────────────

async function createEvent(env, req, origin) {
  const b = await readBody(req);
  const hostId = clip(b.host_id ?? b.me, 40);
  if (!hostId) return json({ error: 'host_id required' }, 400);
  const host = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(hostId).first();
  if (!host) return json({ error: 'sign up first' }, 404);

  const id = uid('evt');
  const slug = token(8);
  await env.DB.prepare(
    `INSERT INTO num_events (id, host_id, business_id, title, day, time, place, address, dress, note, capacity, plan_id, slug)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
  ).bind(
    id, hostId, clip(b.business_id, 40), clip(b.title, 120) || 'Our event', clip(b.day, 20), clip(b.time, 10),
    clip(b.place, 120), clip(b.address, 200), clip(b.dress, 80), clip(b.note, 600),
    b.capacity == null ? null : Number(b.capacity) || null, clip(b.plan_id, 40), slug,
  ).run();

  const event = await env.DB.prepare('SELECT * FROM num_events WHERE id=?1').bind(id).first();
  return json({ event, url: `${origin}/e/${slug}` });
}

async function updateEvent(env, req) {
  const b = await readBody(req);
  const e = await env.DB.prepare('SELECT * FROM num_events WHERE id=?1').bind(clip(b.id, 40) ?? '').first();
  if (!e) return json({ error: 'unknown event' }, 404);
  if (e.host_id !== clip(b.me, 40)) return json({ error: 'not your event' }, 403);
  await env.DB.prepare(
    `UPDATE num_events SET title=COALESCE(?2,title), day=COALESCE(?3,day), time=COALESCE(?4,time), place=COALESCE(?5,place),
            address=COALESCE(?6,address), dress=COALESCE(?7,dress), note=COALESCE(?8,note), state=COALESCE(?9,state),
            updated_at=datetime('now') WHERE id=?1`,
  ).bind(e.id, clip(b.title, 120), clip(b.day, 20), clip(b.time, 10), clip(b.place, 120), clip(b.address, 200),
    clip(b.dress, 80), clip(b.note, 600), clip(b.state, 20)).run();
  return json({ event: await env.DB.prepare('SELECT * FROM num_events WHERE id=?1').bind(e.id).first() });
}

/** Mint a guest link. The token IS the guest — it arrives on their phone. */
async function inviteGuest(env, req, origin) {
  const b = await readBody(req);
  const e = await env.DB.prepare('SELECT * FROM num_events WHERE id=?1').bind(clip(b.event_id, 40) ?? '').first();
  if (!e) return json({ error: 'unknown event' }, 404);
  if (e.host_id !== clip(b.me, 40)) return json({ error: 'not your event' }, 403);

  const host = await env.DB.prepare('SELECT name FROM num_members WHERE id=?1').bind(e.host_id).first();
  const guests = Array.isArray(b.guests) ? b.guests.slice(0, 50) : [{ name: b.name, phone: b.phone }];
  const out = [];
  for (const g of guests) {
    const t = token();
    const name = clip(g.name, 60);
    const phone = normalisePhone(g.phone);
    await env.DB.prepare('INSERT INTO num_event_guests (token, event_id, name, phone) VALUES (?1,?2,?3,?4)')
      .bind(t, e.id, name, phone).run();
    const url = `${origin}/e/${e.slug}?g=${t}`;
    const message =
      `${name ? name + ' — ' : ''}${host?.name ?? 'A friend'} is having ${e.title}` +
      `${when(e) ? `, ${when(e)}` : ''}${e.place ? ` at ${e.place}` : ''}. RSVP here (one tap, no app): ${url}`;
    out.push({
      token: t,
      name,
      url,
      message,
      sms_url: `sms:${phone ?? ''}${/iphone|ipad|mac/i.test(req.headers.get('User-Agent') ?? '') ? '&' : '?'}body=${encodeURIComponent(message)}`,
      whatsapp_url: `https://wa.me/${phone ? phone.replace(/\D/g, '') : ''}?text=${encodeURIComponent(message)}`,
      share: { title: e.title, text: message, url },
    });
  }
  return json({ invites: out });
}

/** The host dashboard payload: counts, the list, and who to chase. */
async function eventDashboard(env, url, origin) {
  const id = url.searchParams.get('id');
  const me = url.searchParams.get('me');
  const e = await env.DB.prepare('SELECT * FROM num_events WHERE id=?1 OR slug=?1').bind(id ?? '').first();
  if (!e) return json({ error: 'unknown event' }, 404);
  if (e.host_id !== me) return json({ error: 'not your event' }, 403);

  const { results: guests } = await env.DB.prepare(
    'SELECT token, name, phone, rsvp, plus_ones, message, opened_at, replied_at FROM num_event_guests WHERE event_id=?1 ORDER BY replied_at IS NULL, replied_at DESC',
  ).bind(e.id).all();

  const list = (guests ?? []).map((g) => ({ ...g, phone: maskPhone(g.phone) }));
  const count = (s) => list.filter((g) => g.rsvp === s).length;
  const heads = list.filter((g) => g.rsvp === 'yes').reduce((n, g) => n + 1 + (g.plus_ones || 0), 0);

  return json({
    event: e,
    url: `${origin}/e/${e.slug}`,
    guests: list,
    summary: {
      invited: list.length,
      yes: count('yes'),
      no: count('no'),
      maybe: count('maybe'),
      pending: count('pending'),
      opened: list.filter((g) => g.opened_at).length,
      heads,
      capacity: e.capacity,
      // The number a host actually wants: who got the text and never answered.
      silent: list.filter((g) => g.rsvp === 'pending' && g.opened_at).length,
    },
  });
}

async function listEvents(env, url, origin) {
  const me = url.searchParams.get('me');
  if (!me) return json({ error: 'me required' }, 400);
  const { results } = await env.DB.prepare(
    `SELECT e.*, (SELECT COUNT(*) FROM num_event_guests g WHERE g.event_id=e.id) invited,
            (SELECT COUNT(*) FROM num_event_guests g WHERE g.event_id=e.id AND g.rsvp='yes') yes
       FROM num_events e WHERE e.host_id=?1 ORDER BY e.created_at DESC LIMIT 25`,
  ).bind(me).all();
  return json({ events: (results ?? []).map((e) => ({ ...e, url: `${origin}/e/${e.slug}` })) });
}

// ── guest side: no app, no account ────────────────────────────────────────

async function rsvp(env, req) {
  const b = await readBody(req);
  const g = await env.DB.prepare('SELECT * FROM num_event_guests WHERE token=?1').bind(clip(b.token, 40) ?? '').first();
  if (!g) return json({ error: 'unknown invite' }, 404);
  const answer = ['yes', 'no', 'maybe'].includes(b.rsvp) ? b.rsvp : null;
  if (!answer) return json({ error: 'rsvp must be yes, no or maybe' }, 400);

  await env.DB.prepare(
    "UPDATE num_event_guests SET rsvp=?2, plus_ones=?3, name=COALESCE(?4,name), message=COALESCE(?5,message), replied_at=datetime('now') WHERE token=?1",
  ).bind(g.token, answer, Math.max(0, Math.min(10, Number(b.plus_ones) || 0)), clip(b.name, 60), clip(b.message, 300)).run();
  return json({ ok: true, rsvp: answer });
}

/**
 * The page the guest actually sees. Server-rendered and self-contained: it has
 * to work on a five-year-old phone, over hotel wifi, from a text message.
 */
async function eventPage(env, slug, url, origin) {
  const e = await env.DB.prepare('SELECT * FROM num_events WHERE slug=?1').bind(slug).first();
  if (!e) return html('<p style="font:16px system-ui;padding:40px">That invite link isn’t valid any more.</p>', 404);

  const gt = url.searchParams.get('g');
  let guest = null;
  if (gt) {
    guest = await env.DB.prepare('SELECT * FROM num_event_guests WHERE token=?1 AND event_id=?2').bind(gt, e.id).first();
    if (guest) {
      await env.DB.prepare("UPDATE num_event_guests SET opened_at=COALESCE(opened_at, datetime('now')) WHERE token=?1").bind(gt).run();
    }
  }
  const host = await env.DB.prepare('SELECT name FROM num_members WHERE id=?1').bind(e.host_id).first();
  const going = await env.DB.prepare("SELECT COUNT(*) n FROM num_event_guests WHERE event_id=?1 AND rsvp='yes'").bind(e.id).first();

  const row = (k, v) => (v ? `<div class="row"><span>${esc(k)}</span><b>${esc(v)}</b></div>` : '');
  const mapQ = encodeURIComponent([e.place, e.address].filter(Boolean).join(', '));

  return html(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(e.title)}</title>
<style>
:root{--ink:#201e1d;--accent:#ec3013;--paper:#faf7f4}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background-image:radial-gradient(60% 40% at 20% 0%,#ffe9e2 0%,transparent 60%),radial-gradient(50% 40% at 90% 10%,#ffe2d3 0%,transparent 55%)}
.wrap{max-width:520px;margin:0 auto;padding:28px 20px 60px}
.kicker{font-size:11px;letter-spacing:.16em;font-weight:800;color:var(--accent)}
h1{font-size:30px;line-height:1.12;margin:10px 0 4px;letter-spacing:-.02em}
.sub{color:#6b625d;font-size:14px}
.card{margin-top:22px;background:rgba(255,255,255,.72);border:1px solid rgba(32,30,29,.08);border-radius:20px;padding:18px;
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 10px 30px rgba(32,30,29,.07)}
.row{display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid rgba(32,30,29,.07);font-size:14px}
.row:last-child{border-bottom:0}.row span{color:#6b625d}.row b{text-align:right;font-weight:600}
.btns{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:16px}
button{font:inherit;font-weight:700;font-size:13px;letter-spacing:.04em;padding:14px 8px;border-radius:999px;border:1px solid rgba(32,30,29,.12);
  background:rgba(255,255,255,.8);color:var(--ink);cursor:pointer;-webkit-tap-highlight-color:transparent}
button.yes{background:linear-gradient(135deg,#ff6a3d,#ec3013);color:#fff;border-color:transparent;box-shadow:0 6px 18px rgba(236,48,19,.28)}
button[aria-pressed="true"]{outline:2px solid var(--accent);outline-offset:2px}
input,textarea{font:inherit;width:100%;margin-top:10px;padding:12px 14px;border-radius:14px;border:1px solid rgba(32,30,29,.12);background:rgba(255,255,255,.8)}
a.map{display:block;margin-top:12px;text-align:center;text-decoration:none;color:var(--accent);font-weight:700;font-size:13px}
.ok{margin-top:16px;padding:14px;border-radius:14px;background:rgba(22,140,90,.12);color:#0e6b45;font-size:14px;font-weight:600;display:none}
.foot{margin-top:26px;text-align:center;font-size:12px;color:#8b817b}
.foot a{color:#8b817b}
</style></head><body><div class="wrap">
<div class="kicker">${esc(host?.name ? host.name.toUpperCase() + ' INVITES YOU' : 'YOU’RE INVITED')}</div>
<h1>${esc(e.title)}</h1>
<div class="sub">${esc(when(e) || 'Date to come')}${going?.n ? ` · ${going.n} going` : ''}</div>
<div class="card">
  ${row('When', when(e))}
  ${row('Where', e.place)}
  ${row('Address', e.address)}
  ${row('Dress', e.dress)}
  ${e.note ? `<div style="padding-top:12px;font-size:14px">${esc(e.note)}</div>` : ''}
  ${mapQ ? `<a class="map" href="https://maps.google.com/?q=${mapQ}" target="_blank" rel="noreferrer">Open in Maps →</a>` : ''}
</div>
${
  guest
    ? `<div class="card">
  <div class="kicker" style="color:#6b625d">${esc(guest.name ? guest.name + ' — can you make it?' : 'Can you make it?')}</div>
  <div class="btns">
    <button class="yes" data-r="yes" aria-pressed="${guest.rsvp === 'yes'}">YES</button>
    <button data-r="maybe" aria-pressed="${guest.rsvp === 'maybe'}">MAYBE</button>
    <button data-r="no" aria-pressed="${guest.rsvp === 'no'}">CAN’T</button>
  </div>
  <input id="plus" type="number" min="0" max="10" placeholder="Bringing anyone? (number)" value="${guest.plus_ones || ''}">
  <textarea id="msg" rows="2" placeholder="Anything to pass on (optional)">${esc(guest.message ?? '')}</textarea>
  <div class="ok" id="ok"></div>
</div>
<script>
const t=${JSON.stringify(gt)};
document.querySelectorAll('button[data-r]').forEach(b=>b.addEventListener('click',async()=>{
  document.querySelectorAll('button[data-r]').forEach(x=>x.setAttribute('aria-pressed','false'));
  b.setAttribute('aria-pressed','true');
  const r=await fetch('/api/events/rsvp',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token:t,rsvp:b.dataset.r,plus_ones:document.getElementById('plus').value,message:document.getElementById('msg').value})});
  const ok=document.getElementById('ok');
  ok.style.display='block';
  ok.textContent=r.ok?({yes:'You’re on the list. See you there.',maybe:'Noted — we’ll keep a spot warm.',no:'Thanks for letting us know.'})[b.dataset.r]:'That didn’t save — try once more.';
}));
</script>`
    : `<div class="card"><div style="font-size:14px;color:#6b625d">This is the public page for the event. Ask ${esc(host?.name ?? 'the host')} for your own invite link to RSVP.</div></div>`
}
<div class="foot">Handled by <a href="${origin}">Num</a> — your concierge.</div>
</div></body></html>`);
}

// ── router ────────────────────────────────────────────────────────────────

export async function handleEvents(request, env, path, origin) {
  if (!env.DB) return json({ error: 'events need the database binding' }, 503);
  await ensure(env);
  const url = new URL(request.url);
  const post = request.method === 'POST';
  try {
    if (path === '/create' && post) return await createEvent(env, request, origin);
    if (path === '/update' && post) return await updateEvent(env, request);
    if (path === '/invite' && post) return await inviteGuest(env, request, origin);
    if (path === '/rsvp' && post) return await rsvp(env, request);
    if (path === '/dashboard') return await eventDashboard(env, url, origin);
    if (path === '/list') return await listEvents(env, url, origin);
    return json({ error: 'not found' }, 404);
  } catch (err) {
    console.error('[events]', path, err?.message ?? err);
    return json({ error: 'that didn’t go through — try again in a moment' }, 500);
  }
}

/** GET /e/:slug — the guest page. Public by design. */
export async function handleEventPage(request, env, slug, origin) {
  if (!env.DB) return html('<p>Unavailable.</p>', 503);
  await ensure(env);
  try {
    return await eventPage(env, slug, new URL(request.url), origin);
  } catch (err) {
    console.error('[event-page]', err?.message ?? err);
    return html('<p style="font:16px system-ui;padding:40px">Something went wrong loading this invite.</p>', 500);
  }
}
