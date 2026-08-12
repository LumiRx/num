
const HTML = (s, status = 200) =>
  new Response(s, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/* The page a camera opens at a counter.
   Assumptions it is built on, all of which are the hostile case:
   one hand, bad light, a queue behind them, a foreign SIM on 3G, and a
   member of staff watching. So: no framework, no webfont, no image, no
   network round-trip before something readable is on screen. It is one
   self-contained document that renders from the first packet.
   The code input is the only interactive element on the page.            */
function scanPage(o) {
  const T = {
    unknown: {
      h: "This code isn't one of ours",
      p: "Nothing was charged and nothing was recorded against you. If someone gave you this to scan, it did not come from NUM.",
    },
    revoked: {
      h: "This code has been retired",
      p: "The venue replaced it. Ask them for the current one — the old code stops working the moment a new one is issued, which is the point of it.",
    },
  }[o.state];

  if (T) return shell(`
    <h1>${esc(T.h)}</h1>
    <p class="lede">${esc(T.p)}</p>
    <a class="btn ghost" href="https://itsnum.com/">Go to NUM</a>`);

  return shell(`
    <div class="venue">${esc(o.venue)}${o.label ? ` <span class="lbl">${esc(o.label)}</span>` : ""}</div>
    <h1>You're here.</h1>
    <p class="lede">Enter the code from your booking and we'll tell them you've arrived.${
      o.perk ? " Your perk is below." : ""}</p>

    <form id="f" autocomplete="off" novalidate>
      <label for="code">Your booking code</label>
      <input id="code" name="code" inputmode="latin" autocapitalize="characters"
             spellcheck="false" maxlength="8" placeholder="T882"
             value="${esc(o.prefill || "")}" aria-describedby="hint">
      <p class="hint" id="hint">Four characters, in your NUM thread and on your confirmation.</p>
      <button class="btn" type="submit" id="go">I've arrived</button>
    </form>

    <div id="out" class="out" hidden role="status" aria-live="polite"></div>

    ${o.perk ? `<div class="perk" id="perk" hidden><b>Your perk</b><span>${esc(o.perk)}</span></div>` : ""}

    <p class="foot">No booking? <a href="https://itsnum.com/">Open NUM</a> — it works out what's
      good near you and books it, free.</p>

    <script>
    (function(){
      var TOKEN=${JSON.stringify(o.token)};
      var f=document.getElementById('f'), inp=document.getElementById('code'),
          go=document.getElementById('go'), out=document.getElementById('out'),
          perk=document.getElementById('perk');

      function say(kind,html){ out.hidden=false; out.className='out '+kind; out.innerHTML=html; }

      f.addEventListener('submit',function(e){
        e.preventDefault();
        var code=(inp.value||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
        if(code.length<3){ say('bad','That code looks too short. It is four characters, like <b>T882</b>.'); inp.focus(); return; }
        go.disabled=true; go.textContent='Checking…';
        fetch('https://itsnum.com/api/venue/arrive',{
          method:'POST', headers:{'content-type':'application/json'},
          body:JSON.stringify({token:TOKEN, code:code})
        }).then(function(r){ return r.json().then(function(j){ return {s:r.status,j:j}; }); })
        .then(function(res){
          var j=res.j;
          go.disabled=false; go.textContent="I've arrived";
          if(j.ok && j.completed){
            f.hidden=true;
            say('good','<b>Done — they know you\\'re here.</b><br>Enjoy it. Nothing else to do.');
            if(perk) perk.hidden=false;
          } else if(j.ok && j.already){
            f.hidden=true;
            say('good','<b>Already checked in.</b><br>You\\'re all set — no need to do it twice.');
            if(perk) perk.hidden=false;
          } else if(j.ok && j.matched===false){
            // A walk-in. Not a failure — the best moment we will ever get.
            f.hidden=true;
            say('info','<b>No booking under that code here.</b><br>If you booked somewhere else, check the code. '+
              'If you just walked in, NUM can hold your table next time — and tell you what is actually good nearby.'+
              '<br><br><a class="btn" href="https://itsnum.com/">Open NUM</a>');
          } else if(j.error==='out_of_window'){
            say('bad','<b>That booking is not for now.</b><br>Check-in opens 90 minutes before your time. '+
              'If you think this is wrong, show this screen to the staff — they can confirm you from their end.');
          } else if(j.error==='slow_down'){
            say('bad','Too many tries. Wait a moment, then try once more.');
          } else if(j.error==='not_active'){
            say('bad','<b>That booking is not active.</b><br>It may have been cancelled. Staff can sort it from their end.');
          } else {
            say('bad','We could not check that code just now. Show this screen to the staff — '+
              'they can confirm you from their end, and you will not be charged for our trouble.');
          }
        })
        .catch(function(){
          go.disabled=false; go.textContent="I've arrived";
          // Offline at a counter is common. Never leave them stuck.
          say('bad','No connection right now. Show this screen to the staff — they can confirm you from their end.');
        });
      });

      inp.addEventListener('input',function(){
        inp.value=inp.value.toUpperCase().replace(/[^A-Z0-9]/g,'');
      });
      if(inp.value.length>=3) f.dispatchEvent(new Event('submit'));
    })();
    </script>`);
}

function shell(body) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>Check in — NUM</title>
<style>
:root{--paper:#faf8f4;--ink:#131a16;--pine:#1f3a34;--green:#1e7a4d;--line:#e0ddd4}
*{margin:0;box-sizing:border-box}
body{font:17px/1.6 -apple-system,'Segoe UI',Inter,system-ui,sans-serif;background:var(--paper);
  color:var(--ink);padding:28px 20px calc(28px + env(safe-area-inset-bottom));
  max-width:520px;margin:0 auto}
.venue{font-size:14px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--green);margin-bottom:10px}
.lbl{color:#68705f;font-weight:600;letter-spacing:.04em;text-transform:none}
h1{font-size:clamp(28px,8vw,38px);line-height:1.1;letter-spacing:-.02em;color:var(--pine);margin-bottom:12px}
.lede{color:#39423b;margin-bottom:24px}
label{display:block;font-weight:650;margin-bottom:8px}
input{width:100%;font:700 30px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.22em;
  text-align:center;text-transform:uppercase;padding:18px 12px;border:2px solid var(--line);
  border-radius:14px;background:#fff;color:var(--ink);min-height:64px}
input:focus{outline:0;border-color:var(--green)}
.hint{font-size:14px;color:#68705f;margin:8px 0 18px}
.btn{display:block;width:100%;min-height:56px;background:var(--green);color:#fff;font:650 17px/1 inherit;
  border:0;border-radius:14px;cursor:pointer;text-align:center;text-decoration:none;padding:19px 20px}
.btn[disabled]{opacity:.6}
.btn.ghost{background:transparent;color:var(--pine);border:2px solid var(--pine)}
.out{margin-top:20px;padding:18px 20px;border-radius:14px;font-size:16px;line-height:1.55}
.out.good{background:#e8f4ec;border:1px solid #b9dcc6;color:#14432c}
.out.bad{background:#fdf0e9;border:1px solid #f0cbb4;color:#6b3113}
.out.info{background:#fff;border:1px solid var(--line);color:#39423b}
.out .btn{margin-top:14px}
.perk{margin-top:18px;padding:18px 20px;background:#fff;border:1px solid var(--line);
  border-left:4px solid var(--green);border-radius:12px}
.perk b{display:block;font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:var(--green);margin-bottom:6px}
.foot{margin-top:30px;font-size:14.5px;color:#68705f}
.foot a{color:var(--green)}
</style></head>
<body>${body}</body></html>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   Venue check-in — the thing that decides a booking completed.
   Added 10 Aug 2026.

   Until now nothing could write status 'completed' or 'no_show'. Six bookings
   existed and the furthest any had travelled was 'confirmed'. So "you pay 10%
   only when a booking completes" had no mechanism behind it at all. This is
   that mechanism.

   WHO SCANS, AND WHY IT IS THE GUEST
   The business is the party billed on completion. Asking staff to confirm
   completion is asking them to self-report a bill, and the incentive points
   at under-reporting. The guest has no such incentive — and if scanning is
   how they claim their perk, they actively want to. So the venue displays one
   static code and the guest scans it.

   WHAT A SCAN ACTUALLY PROVES
   The code is printed, therefore public. On its own it proves nothing. Paired
   with the guest's own short_code (T882, already in num_bookings and shown
   only to them) and a time window around the reservation, it proves: this
   guest, holding this booking, at this venue, around the time they said. That
   is the standard of proof we bill on, and it is written down here so a
   dispute is settled against a rule rather than a memory.

   EVERY SCAN IS RECORDED, INCLUDING THE ONES THAT DO NOT BILL.
   A venue whose scans never match its bookings should be visible, not
   inferred. num_venue_scans keeps the misses too.
   ══════════════════════════════════════════════════════════════════════════ */

const EPOCH = () => Math.floor(Date.now() / 1000);

// How far either side of a reservation a scan still counts. Generous on the
// back end because people linger, and a guest who ate is a guest who ate.
const WINDOW_BEFORE_S = 90 * 60;        // 90 minutes early
const WINDOW_AFTER_S = 6 * 60 * 60;     // 6 hours after the slot ends

// Codes the guest sees. Excludes I, L, O, U, 0, 1 — read aloud across a
// counter, in a second language, over noise.
const CODE_OK = /^[A-HJ-NP-TV-Z2-9]{3,8}$/;

async function ipHash(req) {
  const ip = req.headers.get("cf-connecting-ip") || "";
  if (!ip) return "";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("num-venue:" + ip));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function logScan(env, req, row) {
  try {
    await env.DB.prepare(
      `INSERT INTO num_venue_scans
         (token,business_id,booking_id,outcome,member_ref,country,device,ip_hash,detail,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      row.token || "", row.business_id || "", row.booking_id || null, row.outcome,
      row.member_ref || null, country(req), device(req), await ipHash(req),
      clean(row.detail, 200) || null, now()
    ).run();
  } catch (e) {
    // A logging failure must never cost the guest their perk or the business
    // its booking. Record and carry on.
    console.warn("[venue] scan log failed:", String(e).slice(0, 160));
  }
}

/* ── GET /v/<token> — what the camera opens ──────────────────────────────── */
async function venueLanding(req, env, tok) {
  const vtok = clean(tok, 40).toUpperCase();
  const code = await env.DB.prepare(
    `SELECT c.token, c.business_id, c.label, c.perk_text, c.state, b.name AS business_name
       FROM num_venue_codes c JOIN businesses b ON b.id = c.business_id
      WHERE c.token = ?`
  ).bind(vtok).first();

  if (!code) {
    await logScan(env, req, { token: vtok, business_id: "", outcome: "unknown_token" });
    return HTML(scanPage({ state: "unknown" }), 404);
  }
  if (code.state === "revoked") {
    await logScan(env, req, { token: vtok, business_id: code.business_id, outcome: "revoked" });
    return HTML(scanPage({ state: "revoked", venue: code.business_name }), 410);
  }

  const url = new URL(req.url);
  return HTML(scanPage({
    state: "ask",
    token: vtok,
    venue: code.business_name,
    label: code.label,
    perk: code.perk_text,
    prefill: clean(url.searchParams.get("c"), 8).toUpperCase(),
  }));
}

/* ── POST /api/venue/arrive — the guest presents their code ──────────────── */
async function venueArrive(req, env) {
  if (badOrigin(req)) return J({ ok: false }, 403);
  const ip = req.headers.get("cf-connecting-ip") || "0";
  // Brute-forcing a 4-character code against a known venue is the one real
  // attack here, and it is cheap to shut down.
  if (overLimit("varr:" + ip, 12)) return J({ ok: false, error: "slow_down" }, 429);

  let b;
  try { b = await readJSON(req, 4096); } catch (e) { return J({ ok: false }, 400); }

  const vtok = clean(b.token, 40).toUpperCase();
  const code = clean(b.code, 8).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!vtok || !CODE_OK.test(code)) return J({ ok: false, error: "bad_code" }, 400);

  const venue = await env.DB.prepare(
    `SELECT c.business_id, c.perk_text, c.state, b.name AS business_name
       FROM num_venue_codes c JOIN businesses b ON b.id = c.business_id
      WHERE c.token = ?`
  ).bind(vtok).first();
  if (!venue) {
    await logScan(env, req, { token: vtok, business_id: "", outcome: "unknown_token", detail: code });
    return J({ ok: false, error: "unknown_venue" }, 404);
  }
  if (venue.state === "revoked") {
    await logScan(env, req, { token: vtok, business_id: venue.business_id, outcome: "revoked" });
    return J({ ok: false, error: "revoked" }, 410);
  }

  const bk = await env.DB.prepare(
    `SELECT id, status, starts_at, ends_at, value_cs, commission_cs, member_ref, business_id
       FROM num_bookings
      WHERE business_id = ? AND UPPER(short_code) = ?
      ORDER BY starts_at DESC LIMIT 1`
  ).bind(venue.business_id, code).first();

  // No booking with that code at this venue. Deliberately NOT an error page:
  // this is a walk-in standing at the counter with their phone already out,
  // which is the best acquisition moment we will ever get. Nothing is billed,
  // because nothing was booked.
  if (!bk) {
    await logScan(env, req, {
      token: vtok, business_id: venue.business_id, outcome: "no_booking", detail: code,
    });
    return J({
      ok: true, matched: false, venue: venue.business_name,
      business_id: venue.business_id, perk: venue.perk_text || null,
    });
  }

  if (bk.status === "completed") {
    // Idempotent on purpose. Two taps, a refresh, or a second scan by the same
    // party must never bill twice.
    await logScan(env, req, {
      token: vtok, business_id: venue.business_id, booking_id: bk.id,
      outcome: "already_completed", member_ref: bk.member_ref,
    });
    return J({
      ok: true, matched: true, already: true, venue: venue.business_name,
      perk: venue.perk_text || null,
    });
  }

  if (!["confirmed", "pending_business", "held"].includes(bk.status)) {
    await logScan(env, req, {
      token: vtok, business_id: venue.business_id, booking_id: bk.id,
      outcome: "wrong_venue", member_ref: bk.member_ref, detail: "status=" + bk.status,
    });
    return J({ ok: false, error: "not_active", status: bk.status }, 409);
  }

  const t = EPOCH();
  if (t < bk.starts_at - WINDOW_BEFORE_S || t > bk.ends_at + WINDOW_AFTER_S) {
    await logScan(env, req, {
      token: vtok, business_id: venue.business_id, booking_id: bk.id,
      outcome: "out_of_window", member_ref: bk.member_ref,
      detail: "t=" + t + " slot=" + bk.starts_at + "-" + bk.ends_at,
    });
    return J({
      ok: false, error: "out_of_window",
      starts_at: bk.starts_at, ends_at: bk.ends_at,
    }, 409);
  }

  // 10% of realised value, unless a commission was already agreed on this
  // booking. Rounded down: we would rather under-charge by a cent than over.
  const commission = bk.commission_cs > 0
    ? bk.commission_cs
    : Math.floor((bk.value_cs || 0) * 0.10);

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE num_bookings
          SET status='completed', completed_at=?, commission_cs=?
        WHERE id=? AND status<>'completed'`
    ).bind(t, commission, bk.id),
    env.DB.prepare(
      `INSERT INTO num_booking_events (id,booking_id,from_status,to_status,actor,reason,metadata,created_at)
       VALUES (?,?,?,'completed','guest','venue_qr',?,?)`
    ).bind(
      "bev_" + token(10), bk.id, bk.status,
      JSON.stringify({ venue_token: vtok, commission_cs: commission }), t
    ),
  ]);

  await logScan(env, req, {
    token: vtok, business_id: venue.business_id, booking_id: bk.id,
    outcome: "completed", member_ref: bk.member_ref, detail: "commission_cs=" + commission,
  });

  return J({
    ok: true, matched: true, completed: true,
    venue: venue.business_name, perk: venue.perk_text || null,
  });
}

/* ── POST /api/venue/confirm — the fallback, and its dispute window ───────
   Phone dead, staff busy, guest forgot. The business marks it from their
   dashboard. This is the weakest evidence we accept, so it is the loudest in
   the record: actor is the business, reason says it was not scanned, and the
   guest is notified. Under-reporting stays possible — but a venue whose
   confirmations never match its scans is now a visible pattern.        */
async function venueConfirm(req, env) {
  const key = req.headers.get("x-admin-key") || "";
  if (!env.ADMIN_KEY || !sameSecret(env.ADMIN_KEY, key)) {
    return J({ ok: false, error: "unauthorised" }, 401);
  }
  let b;
  try { b = await readJSON(req, 4096); } catch (e) { return J({ ok: false }, 400); }

  const id = clean(b.booking_id, 60);
  const outcome = clean(b.outcome, 20);
  if (!id || !["arrived", "no_show"].includes(outcome)) {
    return J({ ok: false, error: "missing_fields" }, 400);
  }

  const bk = await env.DB.prepare(
    "SELECT id,status,ends_at,value_cs,commission_cs FROM num_bookings WHERE id=?"
  ).bind(id).first();
  if (!bk) return J({ ok: false, error: "unknown_booking" }, 404);
  if (bk.status === "completed" || bk.status === "no_show") {
    return J({ ok: true, unchanged: true, status: bk.status });
  }

  const t = EPOCH();
  // A booking cannot be confirmed as arrived before it has happened.
  if (outcome === "arrived" && t < bk.ends_at) {
    return J({ ok: false, error: "too_early", ends_at: bk.ends_at }, 409);
  }

  const to = outcome === "arrived" ? "completed" : "no_show";
  const commission = to === "completed"
    ? (bk.commission_cs > 0 ? bk.commission_cs : Math.floor((bk.value_cs || 0) * 0.10))
    : 0;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE num_bookings SET status=?, completed_at=?, commission_cs=? WHERE id=? AND status=?`
    ).bind(to, to === "completed" ? t : null, commission, id, bk.status),
    env.DB.prepare(
      `INSERT INTO num_booking_events (id,booking_id,from_status,to_status,actor,reason,metadata,created_at)
       VALUES (?,?,?,?,'business','unscanned_business_confirm',?,?)`
    ).bind(
      "bev_" + token(10), id, bk.status, to,
      JSON.stringify({ disputable_until: t + 7 * 86400, commission_cs: commission }), t
    ),
  ]);

  return J({ ok: true, status: to, commission_cs: commission, disputable_until: t + 7 * 86400 });
}
