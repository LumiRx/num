
/* ══════════════════════════════════════════════════════════════════════════
   Offers — the traffic lever a business pulls itself. Added 11 Aug 2026.

   WHY THIS EXISTS
   A business joins a marketplace that visibly moves people. Today NUM has
   nothing a traveller can look at that changes tonight — so there is nothing
   for marketing to point demand at, and nothing for a quiet Tuesday. An offer
   is a time-boxed promise the business authors itself ("free dessert with any
   main until 10pm"), posted in two taps, live immediately on /tonight/ and in
   the concierge's data, gone automatically when it ends.

   WHOSE PROMISE IT IS — AND WHOSE IT IS NOT
   The offer is the business's own commitment in its own words. NUM repeats
   it verbatim (escaped) and never embellishes. Critically, NUM promises no
   audience for it: "your offer goes live where travellers look" is true;
   "travellers will come" is a claim about volume nobody can make and is
   banned. Every surface built here says the former and never the latter.

   Offers expire by clock (`ends_at`), not by cleanup job: every read filters
   on time, so a stale offer can never be displayed even if nothing ever runs.
   Cap of 3 live offers per business — a page of 40 offers from one venue is
   spam, and spam kills the surface for everyone else.
   ══════════════════════════════════════════════════════════════════════════ */

const MAX_LIVE_OFFERS = 3;
const MAX_OFFER_HOURS = 24 * 7;   // a week; longer-lived things are listings, not offers

const OFFER_KINDS = ["perk", "happy_hour", "quiet_night", "last_minute", "event"];

// Tap-to-fill suggestions per category — the business edits or replaces them.
// These are suggestions in THEIR voice, not commitments in ours.
const OFFER_PRESETS = {
  restaurant: [
    ["quiet_night", "Quiet night — free dessert with any main"],
    ["happy_hour", "Happy hour — 2-for-1 drinks until 7pm"],
    ["last_minute", "Tables free tonight — walk-ins welcome"],
  ],
  bar: [
    ["happy_hour", "Happy hour — 2-for-1 until 8pm"],
    ["quiet_night", "First drink on us tonight"],
    ["event", "Live music tonight from 9"],
  ],
  cafe: [
    ["perk", "Free pastry with any coffee this afternoon"],
    ["quiet_night", "Quiet afternoon — best seats free"],
  ],
  club: [
    ["event", "Guest DJ tonight — no cover before 11"],
    ["last_minute", "Boxes available tonight"],
  ],
  hotel: [
    ["last_minute", "Rooms tonight — best direct rate"],
    ["perk", "Free late checkout this week"],
  ],
  spa: [
    ["last_minute", "Openings this afternoon"],
    ["quiet_night", "Off-peak price until 4pm"],
  ],
  tour: [
    ["last_minute", "Seats left on tomorrow's trip"],
  ],
  generic: [
    ["perk", "Something extra for NUM guests this week"],
  ],
};

const offerId = () => "of_" + token(8);
const isoIn = (hours) =>
  new Date(Date.now() + hours * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);

/* ── POST /api/venue/offers?k= — post one ────────────────────────────────── */
async function venueOffersCreate(req, env, url) {
  const biz = await bizAuth(env, url, req);
  if (!biz) return J({ ok: false, error: "unauthorised" }, 401);
  let b;
  try { b = await readJSON(req, 4096); } catch (e) { return J({ ok: false }, 400); }

  const title = clean(b.title, 90);
  const kind = OFFER_KINDS.includes(clean(b.kind, 20)) ? clean(b.kind, 20) : "perk";
  const hours = Math.min(Math.max(1, Math.round(Number(b.hours) || 6)), MAX_OFFER_HOURS);
  if (!title || title.length < 8) {
    return J({ ok: false, error: "title_too_short",
               hint: "say what the guest actually gets" }, 400);
  }

  const live = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM num_offers WHERE business_id=? AND state='live' AND ends_at > ?"
  ).bind(biz.id, now()).first();
  if ((live?.n || 0) >= MAX_LIVE_OFFERS) {
    return J({ ok: false, error: "too_many_live", max: MAX_LIVE_OFFERS,
               hint: "end one first — a wall of offers from one venue reads as spam" }, 409);
  }

  const id = offerId();
  await env.DB.prepare(
    `INSERT INTO num_offers (id,business_id,title,details,kind,starts_at,ends_at,capacity_hint,state,created_at)
     VALUES (?,?,?,?,?,?,?,?,'live',?)`
  ).bind(id, biz.id, title, clean(b.details, 200) || null, kind,
         now(), isoIn(hours), clean(b.capacity_hint, 60) || null, now()).run();

  return J({ ok: true, id, title, ends_at: isoIn(hours),
             live_url: (env.SITE || "https://itsnum.com") + "/tonight/" });
}

/* ── POST /api/venue/offers/end?k= — pull one early ──────────────────────── */
async function venueOffersEnd(req, env, url) {
  const biz = await bizAuth(env, url, req);
  if (!biz) return J({ ok: false, error: "unauthorised" }, 401);
  let b;
  try { b = await readJSON(req, 2048); } catch (e) { return J({ ok: false }, 400); }
  const id = clean(b.id, 40);
  const row = await env.DB.prepare(
    "SELECT id,state FROM num_offers WHERE id=? AND business_id=?"
  ).bind(id, biz.id).first();
  if (!row) return J({ ok: false, error: "unknown_offer" }, 404);
  if (row.state === "ended") return J({ ok: true, unchanged: true });
  await env.DB.prepare(
    "UPDATE num_offers SET state='ended', ended_at=? WHERE id=?"
  ).bind(now(), id).run();
  return J({ ok: true, id, state: "ended" });
}

/* ── GET /api/venue/offers/live — public, for the concierge and anyone ────
   The concierge quotes from this. Public and unauthenticated: an offer is a
   thing the business wants seen.                                          */
async function offersLive(req, env) {
  const { results } = await env.DB.prepare(
    `SELECT o.id, o.title, o.details, o.kind, o.ends_at, o.capacity_hint,
            b.name AS business, b.territory, b.category
       FROM num_offers o JOIN businesses b ON b.id = o.business_id
      WHERE o.state='live' AND o.ends_at > ? AND b.status='active'
      ORDER BY o.ends_at ASC LIMIT 100`
  ).bind(now()).all();
  return J({ ok: true, count: (results || []).length, offers: results || [] },
           200, { "cache-control": "public, max-age=60" });
}

/* ── GET /tonight/ — the page marketing points demand at ─────────────────
   Server-rendered, self-contained, honest: it shows exactly the live offers
   that exist, and when none exist it says so and routes the visitor to the
   concierge rather than dressing an empty room. Every view is logged
   server-side into num_web_events, so the funnel reads in the same table as
   everything else.                                                        */
async function tonightPage(req, env, url) {
  const { results } = await env.DB.prepare(
    `SELECT o.title, o.details, o.kind, o.ends_at, o.capacity_hint,
            b.name AS business, b.territory
       FROM num_offers o JOIN businesses b ON b.id = o.business_id
      WHERE o.state='live' AND o.ends_at > ? AND b.status='active'
      ORDER BY o.ends_at ASC LIMIT 60`
  ).bind(now()).all();
  const offers = results || [];

  // Log the view server-side — no client script needed, same table as the
  // landing funnel. The event name is server-inserted so it does not need
  // the /api/ev allowlist.
  try {
    const vid = await visitorId(req, env);
    await env.DB.prepare(
      `INSERT INTO num_web_events (visitor_id,event,page,utm_source,utm_medium,utm_campaign,referrer,country,device,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(vid, "tonight_view", "tonight",
           clean(url.searchParams.get("utm_source"), 60), clean(url.searchParams.get("utm_medium"), 60),
           clean(url.searchParams.get("utm_campaign"), 60),
           String(req.headers.get("referer") || "").slice(0, 200),
           country(req), device(req), now()).run();
  } catch (e) { /* the page must render regardless */ }

  const KIND_TAG = { happy_hour: "Happy hour", quiet_night: "Tonight",
                     last_minute: "Last minute", event: "On tonight", perk: "For NUM guests" };
  const fmtEnds = (s) => {
    const hhmm = String(s || "").slice(11, 16);
    return hhmm ? "until " + hhmm + " UTC" : "";
  };

  const cards = offers.map((o) => `
    <div class="offer">
      <span class="tag">${esc(KIND_TAG[o.kind] || "Offer")}</span>
      <h2>${esc(o.title)}</h2>
      ${o.details ? `<p>${esc(o.details)}</p>` : ""}
      <div class="who">${esc(o.business)}${o.territory ? " · " + esc(o.territory) : ""}
        <span class="ends">${esc(fmtEnds(o.ends_at))}</span></div>
    </div>`).join("");

  return HTML(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Tonight on NUM — real offers from real places</title>
<meta name="description" content="Live offers from claimed businesses on NUM — posted by the places themselves, gone when they end.">
<style>
:root{--paper:#faf8f4;--ink:#131a16;--pine:#1f3a34;--green:#1e7a4d;--line:#e0ddd4}
*{margin:0;box-sizing:border-box}
body{font:17px/1.6 -apple-system,'Segoe UI',Inter,sans-serif;background:var(--paper);color:var(--ink);
  max-width:640px;margin:0 auto;padding:40px 20px 80px}
.kicker{font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--green)}
h1{font-size:clamp(28px,7vw,40px);line-height:1.1;letter-spacing:-.02em;color:var(--pine);margin:10px 0 12px}
.lede{color:#39423b;margin-bottom:28px;max-width:52ch}
.offer{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:14px}
.tag{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
  color:var(--green);background:#e8f4ec;border-radius:20px;padding:4px 12px;margin-bottom:8px}
.offer h2{font-size:20px;color:var(--pine);line-height:1.3}
.offer p{color:#39423b;font-size:15px;margin-top:6px}
.who{margin-top:12px;font-size:14px;color:#68705f;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
.ends{font-weight:600}
.empty{background:#fff;border:1px solid var(--line);border-radius:16px;padding:26px;color:#39423b}
.cta{display:block;text-align:center;background:var(--green);color:#fff;font:650 17px/1 inherit;
  border-radius:14px;padding:19px 20px;text-decoration:none;margin-top:26px;min-height:56px}
.foot{margin-top:34px;font-size:13.5px;color:#68705f}
.foot a{color:var(--green)}
</style></head>
<body>
<div class="kicker">Tonight on NUM</div>
<h1>Real offers, from the places themselves.</h1>
<p class="lede">Posted by claimed businesses, in their own words, gone when they end.
Ask Num to book any of them — every guest it sends is a verified real person.</p>

${cards || `<div class="empty"><b>Nothing posted right now.</b><br>
Offers appear here the moment a business posts one — and disappear when they end,
so this page is never stale. Meanwhile, Num still knows what's good nearby.</div>`}

<a class="cta" href="https://app.itsnum.com/go/rd?utm_source=tonight&utm_medium=web&utm_campaign=offers">
  Ask Num to book tonight</a>

<p class="foot">Run a place? <a href="https://itsnum.com/business/">Claim your listing</a> and
post offers on the nights you want filled — free, and you write them yourself.</p>
</body></html>`);
}

/* ── GET /biz/offers?k= — the business side ──────────────────────────────── */
async function venueOffersPage(req, env, url) {
  const biz = await bizAuth(env, url, req);
  if (!biz) return HTML(`<!doctype html><meta charset="utf-8"><title>Sign in — NUM</title>
<p style="font:17px -apple-system,sans-serif;max-width:420px;margin:80px auto;color:#131a16">
That link isn't valid. Use the link we sent you, or ask us to resend it: info@5arz.com</p>`, 401);

  const k = encodeURIComponent(url.searchParams.get("k") || "");
  const cat = categoryOf(biz);
  const presets = OFFER_PRESETS[cat] || OFFER_PRESETS.generic;
  const { results } = await env.DB.prepare(
    `SELECT id,title,kind,ends_at,state,created_at FROM num_offers
      WHERE business_id=? ORDER BY created_at DESC LIMIT 30`
  ).bind(biz.id).all();
  const offers = results || [];
  const liveNow = offers.filter((o) => o.state === "live" && o.ends_at > now());

  const rows = offers.map((o) => {
    const live = o.state === "live" && o.ends_at > now();
    return `<li class="off ${live ? "live" : "done"}" data-id="${esc(o.id)}">
      <div><b>${esc(o.title)}</b>
        <span class="stat">${live ? "live · ends " + esc(o.ends_at.slice(5, 16)) + " UTC"
                                  : "ended"}</span></div>
      ${live ? `<button class="lnk warn" data-end="${esc(o.id)}">End now</button>` : ""}
    </li>`;
  }).join("");

  const chips = presets.map(([kind, text]) =>
    `<button type="button" class="chip" data-kind="${esc(kind)}">${esc(text)}</button>`).join("");

  return HTML(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Offers — ${esc(biz.name)} · NUM</title>
<style>
:root{--paper:#faf8f4;--ink:#131a16;--pine:#1f3a34;--green:#1e7a4d;--line:#e0ddd4;--warn:#b4552d}
*{margin:0;box-sizing:border-box}
body{font:16px/1.6 -apple-system,'Segoe UI',Inter,sans-serif;background:var(--paper);color:var(--ink);
  max-width:720px;margin:0 auto;padding:36px 20px 80px}
h1{font-size:clamp(26px,5vw,34px);color:var(--pine);letter-spacing:-.02em;margin-bottom:4px}
.sub{color:#68705f;margin-bottom:22px}
.nav{display:flex;gap:10px;margin-bottom:22px;flex-wrap:wrap}
.nav a{min-height:44px;display:inline-flex;align-items:center;padding:10px 18px;border-radius:10px;
  border:1.5px solid var(--pine);color:var(--pine);font:600 15px inherit;text-decoration:none}
.nav .on{background:var(--pine);color:#fff}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.chip{background:#fff;border:1.5px solid var(--line);border-radius:20px;padding:10px 16px;
  font:500 14.5px inherit;cursor:pointer;min-height:44px;color:#39423b}
.chip:hover{border-color:var(--green)}
.post{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:8px}
.post input,.post select{width:100%;min-height:48px;font:16px inherit;padding:12px 14px;
  border:1.5px solid var(--line);border-radius:10px;background:var(--paper);margin-bottom:10px}
.post .row{display:flex;gap:10px}
.post .row select{flex:1}
.post input:focus,.post select:focus{outline:0;border-color:var(--green)}
.btn{width:100%;min-height:52px;background:var(--green);color:#fff;font:650 16px inherit;border:0;
  border-radius:10px;padding:14px 22px;cursor:pointer}
.btn[disabled]{opacity:.55}
.hint{font-size:14px;color:#68705f;margin:8px 0 20px}
ul{list-style:none}
.off{display:flex;justify-content:space-between;align-items:center;gap:12px;background:#fff;
  border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:10px}
.off.done{opacity:.55}
.off b{color:var(--pine)}
.stat{display:block;font-size:13.5px;color:#68705f}
.lnk{background:none;border:0;padding:8px 0;font:600 15px inherit;color:var(--warn);
  cursor:pointer;text-decoration:underline;text-underline-offset:3px;min-height:44px;flex-shrink:0}
.msg{margin:12px 0;padding:12px 16px;border-radius:10px;font-size:15px}
.msg.bad{background:#fdf0e9;border:1px solid #f0cbb4;color:#6b3113}
.note{background:#fff;border:1px solid var(--line);border-left:4px solid var(--green);
  border-radius:10px;padding:14px 18px;font-size:14.5px;color:#39423b;margin:24px 0}
</style></head>
<body>
<h1>${esc(biz.name)}</h1>
<p class="sub">Post an offer on the nights you want filled. It goes live immediately and
disappears when it ends.</p>

<div class="nav">
  <a href="/biz/codes?k=${k}">Codes</a>
  <a href="/biz/visitors?k=${k}">Visitors</a>
  <a class="on" href="#">Offers</a>
</div>

<div class="chips">${chips}</div>

<form class="post" id="post">
  <input id="title" maxlength="90" placeholder="What does the guest get? e.g. Free dessert with any main"
         aria-label="Offer" required>
  <div class="row">
    <select id="kind" aria-label="Kind">
      <option value="quiet_night">Quiet night</option>
      <option value="happy_hour">Happy hour</option>
      <option value="last_minute">Last minute</option>
      <option value="perk">Perk</option>
      <option value="event">Event</option>
    </select>
    <select id="hours" aria-label="How long">
      <option value="3">3 hours</option>
      <option value="6" selected>6 hours</option>
      <option value="12">12 hours</option>
      <option value="24">24 hours</option>
      <option value="72">3 days</option>
      <option value="168">1 week</option>
    </select>
  </div>
  <button class="btn" type="submit" id="go">Post it — live immediately</button>
</form>
<p class="hint">${liveNow.length}/3 live now. It appears on
<a href="/tonight/" target="_blank" rel="noopener">itsnum.com/tonight</a> and in what Num can
offer travellers. It is your promise, in your words — honour it like one.</p>

<div id="msg"></div>

<ul>${rows || ""}</ul>

<div class="note"><b>What we will never tell you:</b> that posting an offer guarantees guests.
Nobody can promise that, and we won't. What is true: your offer is live where travellers look,
the moment you post it, at no cost — and you can see exactly what came of it in your check-ins.</div>

<script>
(function(){
  var K = new URLSearchParams(location.search).get('k');
  var msg = document.getElementById('msg');
  function say(t){ msg.innerHTML = '<div class="msg bad">'+t+'</div>'; }
  function api(path, body){
    return fetch(path + '?k=' + encodeURIComponent(K), { method:'POST',
      headers:{'content-type':'application/json'}, body: JSON.stringify(body)
    }).then(function(r){ return r.json(); });
  }
  document.querySelectorAll('.chip').forEach(function(c){
    c.addEventListener('click', function(){
      document.getElementById('title').value = c.textContent;
      document.getElementById('kind').value = c.dataset.kind;
      document.getElementById('title').focus();
    });
  });
  document.getElementById('post').addEventListener('submit', function(e){
    e.preventDefault();
    var go = document.getElementById('go');
    go.disabled = true; go.textContent = 'Posting…';
    api('/api/venue/offers', {
      title: document.getElementById('title').value.trim(),
      kind: document.getElementById('kind').value,
      hours: document.getElementById('hours').value
    }).then(function(j){
      if (j.ok) location.reload();
      else { go.disabled=false; go.textContent='Post it — live immediately';
        say(j.error==='too_many_live' ? 'You have 3 live offers — end one first.'
          : j.error==='title_too_short' ? 'Say what the guest actually gets — a few more words.'
          : 'Could not post that just now.'); }
    }).catch(function(){ go.disabled=false; go.textContent='Post it — live immediately';
      say('No connection. Nothing was changed.'); });
  });
  document.body.addEventListener('click', function(e){
    var b = e.target.closest && e.target.closest('button[data-end]');
    if (!b) return;
    if (!confirm('End this offer now? It disappears from /tonight/ immediately.')) return;
    b.disabled = true;
    api('/api/venue/offers/end', { id: b.dataset.end })
      .then(function(j){ j.ok ? location.reload() : (b.disabled=false, say('That did not go through.')); })
      .catch(function(){ b.disabled=false; say('No connection. Nothing was changed.'); });
  });
})();
</script>
</body></html>`);
}
