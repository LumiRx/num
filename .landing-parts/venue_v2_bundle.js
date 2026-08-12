
/* ══════════════════════════════════════════════════════════════════════════
   Venue backend, part 2 — key issuance, security watch, zone templates,
   visitors. Added 11 Aug 2026.

   PROVE CONTROL → MINT THE KEY → EMAIL THE MANAGER URL
   The claim flow already proves control (a code to the contact published on
   the listing — num_claims, state 'verified'). What was missing is the step
   after proof: nothing turned a verified claim into working access. Both live
   keys were set by hand. issueKey() closes that: it mints a console_key for a
   business and emails the manager URL to the claim-verified address — never
   to an address typed into the request, for exactly the reason the claim
   code is never sent to one.

   THE SECURITY WATCH
   Every use of a console key is logged (num_key_events), every scan already
   is (num_venue_scans), and securitySweep() reads both on a schedule looking
   for the shapes of abuse this surface actually has:
     · one key used from many networks   → the link leaked or was shared
     · many failed key attempts          → someone guessing keys
     · unknown-token scan volume         → someone enumerating venue tokens
     · one network guessing many booking codes at one venue → code brute force
   Findings are deduped per day, stored, and emailed. The sweep only reads
   logs and writes findings — it can never touch bookings, codes or keys, so
   a bug in it cannot damage anything.
   ══════════════════════════════════════════════════════════════════════════ */

/* ── key issuance ────────────────────────────────────────────────────────── */

function mintKey() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function logKeyEvent(env, req, businessId, outcome, detail) {
  try {
    await env.DB.prepare(
      "INSERT INTO num_key_events (business_id,outcome,ip_hash,country,detail,created_at) VALUES (?,?,?,?,?,?)"
    ).bind(businessId || null, outcome, await ipHash(req), country(req),
           clean(detail, 120) || null, now()).run();
  } catch (e) { console.warn("[keys] log failed:", String(e).slice(0, 120)); }
}

/* POST /api/admin/venue/issue  (x-admin-key)
   { business_id }            → mint if absent, email the claim-verified contact
   { business_id, resend: 1 } → email the existing key again
   The recipient is looked up, never supplied: the email goes to the address
   that passed claim verification (num_claims.claimant_email), or to nothing.
   If no verified claim exists, we refuse — control has not been proven. */
async function venueIssueKey(req, env, ctx) {
  const key = req.headers.get("x-admin-key") || "";
  if (!env.ADMIN_KEY || !sameSecret(env.ADMIN_KEY, key)) {
    return J({ ok: false, error: "unauthorised" }, 401);
  }
  let b;
  try { b = await readJSON(req, 4096); } catch (e) { return J({ ok: false }, 400); }
  const bizId = clean(b.business_id, 60);
  if (!bizId) return J({ ok: false, error: "missing_business_id" }, 400);

  const biz = await env.DB.prepare(
    "SELECT id,name,console_key,status FROM businesses WHERE id = ?"
  ).bind(bizId).first();
  if (!biz) return J({ ok: false, error: "unknown_business" }, 404);
  if (biz.status !== "active") return J({ ok: false, error: "business_inactive" }, 409);

  // Control must have been proven. A verified claim is the only accepted proof;
  // `override_email` exists for the two hand-onboarded launch venues and
  // requires the admin key, so it is still Andre making the call.
  const claim = await env.DB.prepare(
    `SELECT claimant_email FROM num_claims
      WHERE business_id = ? AND state = 'verified' AND claimant_email IS NOT NULL
      ORDER BY decided_at DESC LIMIT 1`
  ).bind(bizId).first();
  const to = (claim && claim.claimant_email) || clean(b.override_email, 120);
  if (!to || !to.includes("@")) {
    return J({ ok: false, error: "no_verified_contact",
               hint: "no verified claim holds an email for this business" }, 409);
  }

  let ck = biz.console_key;
  const minted = !ck;
  if (!ck) {
    ck = mintKey();
    await env.DB.prepare("UPDATE businesses SET console_key=? WHERE id=?").bind(ck, bizId).run();
  }
  await logKeyEvent(env, req, bizId, "issued", minted ? "minted" : "resent");

  const site = env.SITE || "https://itsnum.com";
  const managerUrl = `${site}/biz/codes?k=${ck}`;
  ctx.waitUntil(sendBatch(env, [{
    __idem: "venuekey-" + bizId + "-" + (minted ? "mint" : "resend"),
    from: env.MAIL_FROM || "Num by 5arz <info@5arz.com>",
    to: [to],
    replyTo: ["info@5arz.com"],
    subject: `Your table codes for ${biz.name}`,
    headers: { "List-Unsubscribe": "<mailto:info@5arz.com?subject=unsubscribe>" },
    text: `Hi,

You verified control of ${biz.name} on NUM, so here is your codes page:

${managerUrl}

What it does: add a QR code for each table, bar seat or booth, print the whole
set from the page itself, and retire codes when your floor changes. Guests scan
them when they arrive, which is how their booking is marked completed - and how
you get credited for showing up guests.

Treat that link like a password. Anyone who has it can manage your codes. If it
ever leaks, reply "new link" and we will retire it and send a fresh one - your
codes and history are untouched by that.

- Andre
NUM, by 5arz`,
  }]));

  return J({ ok: true, business: biz.name, minted, emailed_to: to.replace(/^(.).*(@.*)$/, "$1***$2") });
}

/* POST /api/venue/key/rotate?k=  — self-serve "my link leaked".
   The old key dies in the same statement the new one is born; codes, scans
   and history are untouched. The new link is returned once, on this response
   only, to the holder of the old key. */
async function venueKeyRotate(req, env) {
  const url = new URL(req.url);
  const biz = await bizAuth(env, url, req);
  if (!biz) return J({ ok: false, error: "unauthorised" }, 401);
  const ck = mintKey();
  await env.DB.prepare("UPDATE businesses SET console_key=? WHERE id=?").bind(ck, biz.id).run();
  await logKeyEvent(env, req, biz.id, "rotated");
  const site = env.SITE || "https://itsnum.com";
  return J({ ok: true, manager_url: `${site}/biz/codes?k=${ck}` });
}

/* ── zone templates ──────────────────────────────────────────────────────
   A business should not start from a blank page. Each business category maps
   to the zones that kind of floor actually has; "set up my floor" creates the
   lot in one tap, named the way staff already talk ("Bar seat 3", "Booth 2").
   A bar seat code in front of every chair is what lets staff attach tabs and
   people to a seat, which is the user's stated goal.                       */
const ZONE_TYPES = ["table", "bar_seat", "booth", "box", "counter", "terrace",
                    "room", "cabana", "desk", "door", "other"];

const ZONE_LABEL = {
  table: "Table", bar_seat: "Bar seat", booth: "Booth", box: "Box",
  counter: "Counter", terrace: "Terrace table", room: "Room",
  cabana: "Cabana", desk: "Front desk", door: "Door", other: "Spot",
};

const FLOOR_TEMPLATES = {
  restaurant: { label: "Restaurant", zones: { table: 10, bar_seat: 6, booth: 4, counter: 1 } },
  bar:        { label: "Bar",        zones: { bar_seat: 12, booth: 4, table: 6, door: 1 } },
  cafe:       { label: "Café",       zones: { table: 8, counter: 1, terrace: 4 } },
  club:       { label: "Club",       zones: { box: 6, booth: 8, bar_seat: 10, door: 1 } },
  hotel:      { label: "Hotel",      zones: { desk: 1, table: 8, cabana: 4, terrace: 6 } },
  spa:        { label: "Spa / wellness", zones: { desk: 1, room: 4 } },
  tour:       { label: "Tours / activities", zones: { desk: 1, counter: 1 } },
  generic:    { label: "Something else", zones: { counter: 1, table: 4 } },
};

// Preset dashboard fields per category — what the /biz/ pages surface first.
const DASH_PRESETS = {
  restaurant: ["check_ins_today", "covers_week", "top_zone", "repeat_guests", "no_shows_week"],
  bar:        ["check_ins_today", "seats_active", "tabs_open_hint", "repeat_guests", "busiest_hour"],
  cafe:       ["check_ins_today", "repeat_guests", "busiest_hour", "top_zone"],
  club:       ["check_ins_tonight", "boxes_active", "door_scans", "repeat_guests"],
  hotel:      ["check_ins_today", "zones_active", "repeat_guests", "top_zone"],
  spa:        ["check_ins_today", "rooms_active", "repeat_guests", "no_shows_week"],
  tour:       ["check_ins_today", "repeat_guests", "no_shows_week"],
  generic:    ["check_ins_today", "repeat_guests", "top_zone"],
};

function categoryOf(biz) {
  const c = (biz.category || "").toLowerCase();
  if (/restaurant|food|seafood|dining/.test(c)) return "restaurant";
  if (/\bbar\b|pub|wine|cocktail/.test(c)) return "bar";
  if (/cafe|coffee|bakery/.test(c)) return "cafe";
  if (/club|night/.test(c)) return "club";
  if (/hotel|resort|hostel|stay/.test(c)) return "hotel";
  if (/spa|massage|wellness|beauty|gym|fitness/.test(c)) return "spa";
  if (/tour|activity|charter|yacht|excursion/.test(c)) return "tour";
  return "generic";
}

/* POST /api/venue/codes/bulk?k=
   { template: "bar" }                              → the whole preset floor
   { zone_type: "bar_seat", count: 12 }             → one zone, N codes
   { zone_type: "bar_seat", count: 4, start: 13 }   → extend: Bar seat 13..16
   Numbering continues from what exists, so adding four bar seats to twelve
   yields 13–16, not a second 1–4.                                          */
async function venueCodesBulk(req, env, url) {
  const biz = await bizAuth(env, url, req);
  if (!biz) return J({ ok: false, error: "unauthorised" }, 401);
  let b;
  try { b = await readJSON(req, 4096); } catch (e) { return J({ ok: false }, 400); }

  let plan = [];   // [zone_type, label]
  if (b.template) {
    const t = FLOOR_TEMPLATES[clean(b.template, 20)];
    if (!t) return J({ ok: false, error: "unknown_template",
                       templates: Object.keys(FLOOR_TEMPLATES) }, 400);
    for (const [zone, n] of Object.entries(t.zones)) {
      for (let i = 1; i <= n; i++) {
        plan.push([zone, n === 1 ? ZONE_LABEL[zone] : `${ZONE_LABEL[zone]} ${i}`]);
      }
    }
  } else {
    const zone = clean(b.zone_type, 20);
    const count = Math.min(Math.max(1, Math.round(Number(b.count) || 0)), 100);
    if (!ZONE_TYPES.includes(zone) || !count) {
      return J({ ok: false, error: "bad_zone_or_count", zones: ZONE_TYPES }, 400);
    }
    let start = Math.max(1, Math.round(Number(b.start) || 0));
    if (!b.start) {
      const ex = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM num_venue_codes WHERE business_id=? AND zone_type=? AND state='active'"
      ).bind(biz.id, zone).first();
      start = (ex?.n || 0) + 1;
    }
    for (let i = 0; i < count; i++) {
      plan.push([zone, count === 1 && start === 1 ? ZONE_LABEL[zone]
                                                  : `${ZONE_LABEL[zone]} ${start + i}`]);
    }
  }

  const live = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM num_venue_codes WHERE business_id=? AND state='active'"
  ).bind(biz.id).first();
  if ((live?.n || 0) + plan.length > MAX_ACTIVE_CODES) {
    return J({ ok: false, error: "too_many_codes",
               active: live?.n || 0, requested: plan.length, max: MAX_ACTIVE_CODES }, 409);
  }

  // Skip labels that already exist rather than failing the whole batch — a
  // template applied twice should be a no-op, not an error and not doubles.
  const { results: existing } = await env.DB.prepare(
    "SELECT lower(label) AS l FROM num_venue_codes WHERE business_id=? AND state='active'"
  ).bind(biz.id).all();
  const have = new Set((existing || []).map((r) => r.l));

  const made = [], skipped = [];
  const site = env.SITE || "https://itsnum.com";
  for (const [zone, label] of plan) {
    if (have.has(label.toLowerCase())) { skipped.push(label); continue; }
    for (let attempt = 0; attempt < 6; attempt++) {
      const token = newToken();
      try {
        await env.DB.prepare(
          `INSERT INTO num_venue_codes (token,business_id,label,zone_type,state,issued_for,created_at)
           VALUES (?,?,?,?,'active','self_serve',?)`
        ).bind(token, biz.id, label, zone, now()).run();
        made.push({ token, label, zone_type: zone, url: `${site}/v/${token}` });
        break;
      } catch (e) {
        if (!String(e).includes("UNIQUE")) throw e;
      }
    }
  }
  return J({ ok: true, created: made.length, skipped, codes: made });
}

/* ── visitors ────────────────────────────────────────────────────────────
   Every completed check-in already carries member_ref — the 5arz-verified
   person. Grouping scans by that ref IS the visitor book: who came, how
   often, where they sat, when they were last in. No new collection, no new
   consent surface — this is the data the check-in already created, shown to
   the business it belongs to.                                             */
async function venueVisitors(req, env, url) {
  const biz = await bizAuth(env, url, req);
  if (!biz) return J({ ok: false, error: "unauthorised" }, 401);

  const { results } = await env.DB.prepare(
    `SELECT s.member_ref,
            COUNT(*)                       AS visits,
            MIN(s.created_at)              AS first_visit,
            MAX(s.created_at)              AS last_visit,
            (SELECT c2.label FROM num_venue_scans s2
               JOIN num_venue_codes c2 ON c2.token = s2.token
              WHERE s2.business_id = s.business_id AND s2.member_ref = s.member_ref
                AND s2.outcome = 'completed'
              GROUP BY c2.label ORDER BY COUNT(*) DESC LIMIT 1) AS usual_spot
       FROM num_venue_scans s
      WHERE s.business_id = ? AND s.outcome = 'completed' AND s.member_ref IS NOT NULL
      GROUP BY s.member_ref
      ORDER BY MAX(s.created_at) DESC
      LIMIT 200`
  ).bind(biz.id).all();

  const cat = categoryOf(biz);
  return J({
    ok: true, business: biz.name, category: cat,
    dash_preset: DASH_PRESETS[cat],
    visitors: (results || []).map((v) => ({
      // The ref is pseudonymous and shown truncated: the business gets
      // "guest #a3f2, 4th visit, usually Booth 2" — recognition without
      // identity. Names arrive only if the guest gives them theirs.
      guest: "guest-" + String(v.member_ref).slice(-4),
      visits: v.visits, first_visit: v.first_visit,
      last_visit: v.last_visit, usual_spot: v.usual_spot,
    })),
  });
}

/* ── the security sweep ──────────────────────────────────────────────────── */
async function securitySweep(env) {
  const findings = [];
  const q = async (sql, ...args) =>
    (await env.DB.prepare(sql).bind(...args).all()).results || [];

  // 1 · one console key, many networks — the link leaked or got shared
  for (const r of await q(
    `SELECT business_id, COUNT(DISTINCT ip_hash) AS nets, COUNT(*) AS uses
       FROM num_key_events
      WHERE outcome='ok' AND created_at > datetime('now','-1 day')
      GROUP BY business_id HAVING nets > 6`)) {
    findings.push({ kind: "key_shared", subject: r.business_id, severity: "high",
      evidence: `${r.nets} distinct networks used this key in 24h (${r.uses} uses)` });
  }

  // 2 · failed key attempts — someone guessing manager links
  for (const r of await q(
    `SELECT COALESCE(ip_hash,'?') AS net, COUNT(*) AS tries
       FROM num_key_events
      WHERE outcome='denied' AND created_at > datetime('now','-1 day')
      GROUP BY ip_hash HAVING tries > 20`)) {
    findings.push({ kind: "key_bruteforce", subject: r.net, severity: "high",
      evidence: `${r.tries} failed key attempts from one network in 24h` });
  }

  // 3 · unknown-token volume — someone enumerating venue tokens
  for (const r of await q(
    `SELECT COALESCE(ip_hash,'?') AS net, COUNT(*) AS n
       FROM num_venue_scans
      WHERE outcome='unknown_token' AND created_at > datetime('now','-1 day')
      GROUP BY ip_hash HAVING n > 30`)) {
    findings.push({ kind: "token_scanning", subject: r.net, severity: "warn",
      evidence: `${r.n} scans of nonexistent tokens from one network in 24h` });
  }

  // 4 · one network trying many booking codes at one venue
  for (const r of await q(
    `SELECT business_id, COALESCE(ip_hash,'?') AS net, COUNT(DISTINCT detail) AS codes
       FROM num_venue_scans
      WHERE outcome='no_booking' AND created_at > datetime('now','-1 day')
      GROUP BY business_id, ip_hash HAVING codes > 8`)) {
    findings.push({ kind: "code_bruteforce", subject: r.business_id + "/" + r.net,
      severity: "high",
      evidence: `${r.codes} different booking codes tried at one venue from one network in 24h` });
  }

  // 5 · a venue completing far more scans than it has bookings — inflation
  for (const r of await q(
    `SELECT s.business_id,
            (SELECT COUNT(*) FROM num_venue_scans x
              WHERE x.business_id=s.business_id AND x.outcome='completed'
                AND x.created_at > datetime('now','-1 day')) AS completions,
            (SELECT COUNT(*) FROM num_bookings k
              WHERE k.business_id=s.business_id
                AND k.created_at > strftime('%s','now','-7 day')) AS bookings_week
       FROM num_venue_scans s
      WHERE s.created_at > datetime('now','-1 day')
      GROUP BY s.business_id`)) {
    if (r.completions > 3 && r.completions > r.bookings_week * 2) {
      findings.push({ kind: "completion_inflation", subject: r.business_id, severity: "warn",
        evidence: `${r.completions} completions in 24h against ${r.bookings_week} bookings this week` });
    }
  }

  // store — the UNIQUE(day,kind,subject) constraint is the dedupe; a finding
  // that fired this morning does not re-alert this evening.
  const day = now().slice(0, 10);
  const fresh = [];
  for (const f of findings) {
    try {
      await env.DB.prepare(
        "INSERT INTO num_security_findings (day,kind,subject,severity,evidence,created_at) VALUES (?,?,?,?,?,?)"
      ).bind(day, f.kind, f.subject, f.severity, f.evidence, now()).run();
      fresh.push(f);
    } catch (e) {
      if (!String(e).includes("UNIQUE")) throw e;
    }
  }

  if (fresh.length) {
    await sendBatch(env, [{
      __idem: "secsweep-" + day + "-" + fresh.length,
      from: env.MAIL_FROM || "Num by 5arz <info@5arz.com>",
      to: ["info@5arz.com"],
      replyTo: ["info@5arz.com"],
      subject: `[NUM security] ${fresh.length} new finding(s) — ${fresh.map(f => f.kind).join(", ")}`,
      headers: { "List-Unsubscribe": "<mailto:info@5arz.com?subject=unsubscribe>" },
      text: "New findings from the venue security sweep:\n\n" +
        fresh.map(f => `· [${f.severity}] ${f.kind} — ${f.subject}\n  ${f.evidence}`).join("\n\n") +
        "\n\nFull history: SELECT * FROM num_security_findings ORDER BY id DESC;\n" +
        "This sweep only reads logs and writes findings. It cannot change keys, codes or bookings.",
    }]);
  }
  return { checked: 5, found: findings.length, new: fresh.length };
}

/* GET /api/admin/venue/security (x-admin-key) — run it on demand */
async function venueSecurityReport(req, env) {
  const key = req.headers.get("x-admin-key") || "";
  if (!env.ADMIN_KEY || !sameSecret(env.ADMIN_KEY, key)) {
    return J({ ok: false, error: "unauthorised" }, 401);
  }
  const r = await securitySweep(env);
  const { results } = await env.DB.prepare(
    "SELECT day,kind,subject,severity,evidence FROM num_security_findings ORDER BY id DESC LIMIT 50"
  ).all();
  return J({ ok: true, sweep: r, recent: results || [] });
}

/* ── /biz/codes v2 — floor setup, zones, bulk add, visitors ───────────────
   Supersedes venueCodesPage. Same principles: one self-contained document,
   no framework, no third-party request, and the page is its own print sheet.
   New here:
     · first run offers the business's floor template — one tap creates the
       whole set, named the way staff talk ("Bar seat 3", "Booth 2")
     · bulk add by zone: "add 4 more bar seats" continues numbering at 13
     · zones group the list, so a 30-code bar stays readable
     · a Visitors view built from completed check-ins                       */

function zoneTitle(z) { return (ZONE_LABEL[z] || "Other") + "s"; }

async function venueCodesPageV2(req, env, url) {
  const biz = await bizAuth(env, url, req);
  if (!biz) {
    return HTML(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — NUM</title>
<style>body{font:17px/1.6 -apple-system,'Segoe UI',sans-serif;background:#faf8f4;color:#131a16;
max-width:460px;margin:0 auto;padding:60px 24px}h1{color:#1f3a34;font-size:26px;margin:0 0 12px}
p{color:#39423b}a{color:#1e7a4d}</style>
<h1>That link isn't valid</h1>
<p>Your codes page has a private key in the address. Use the link we sent you,
or <a href="mailto:info@5arz.com?subject=Codes%20link">ask us to resend it</a>.</p>`, 401);
  }

  const site = env.SITE || "https://itsnum.com";
  const cat = categoryOf(biz);
  const tpl = FLOOR_TEMPLATES[cat] || FLOOR_TEMPLATES.generic;
  const { results } = await env.DB.prepare(
    `SELECT c.token, c.label, c.zone_type, c.state, c.revoked_at,
            (SELECT COUNT(*) FROM num_venue_scans s
              WHERE s.token=c.token AND s.outcome='completed') AS check_ins
       FROM num_venue_codes c WHERE c.business_id=?
      ORDER BY c.state='revoked', c.zone_type, c.created_at`
  ).bind(biz.id).all();
  const codes = results || [];

  // group active codes by zone; revoked go in one tail section
  const groups = {};
  for (const c of codes) {
    const g = c.state === "revoked" ? "_revoked" : (c.zone_type || "other");
    (groups[g] = groups[g] || []).push(c);
  }

  const card = (r) => `
    <li class="code ${r.state}" data-token="${esc(r.token)}">
      <div class="qr"><img src="/api/venue/qr/${esc(r.token)}.svg" alt="QR code for ${esc(r.label)}" width="132" height="132" loading="lazy"></div>
      <div class="meta">
        <b>${esc(r.label)}</b>
        <code>${site.replace(/^https?:\/\//, "")}/v/${esc(r.token)}</code>
        <span class="stat">${r.check_ins} check-in${r.check_ins === 1 ? "" : "s"}${
          r.state === "revoked" ? ` · retired ${esc((r.revoked_at || "").slice(0, 10))}` : ""}</span>
        <div class="acts">${r.state === "active"
          ? `<button class="lnk warn" data-act="revoked">Retire</button>`
          : `<button class="lnk" data-act="active">Put it back</button>`}</div>
      </div>
    </li>`;

  const sections = Object.keys(groups).filter((g) => g !== "_revoked").map((g) => `
    <section>
      <h2>${esc(zoneTitle(g))} <span class="count">${groups[g].length}</span>
        <button class="lnk more" data-zone="${esc(g)}">+ add more</button></h2>
      <ul>${groups[g].map(card).join("")}</ul>
    </section>`).join("");

  const revoked = groups._revoked ? `
    <section class="retired">
      <h2>Retired <span class="count">${groups._revoked.length}</span></h2>
      <ul>${groups._revoked.map(card).join("")}</ul>
    </section>` : "";

  const tplRows = Object.entries(tpl.zones)
    .map(([z, n]) => `${n} × ${esc(ZONE_LABEL[z] || z)}`).join(" · ");

  const firstRun = codes.filter((c) => c.state === "active").length === 0 ? `
    <div class="setup">
      <h2>Set up your floor in one tap</h2>
      <p>You look like a <b>${esc(tpl.label.toLowerCase())}</b>, so we'd start you with
         ${tplRows}. Rename, add or retire any of it afterwards — nothing here is permanent.</p>
      <button class="btn" id="applyTpl" data-tpl="${esc(cat)}">Create these codes</button>
      <p class="hint">Or add codes one by one below.</p>
    </div>` : "";

  const zoneOpts = ZONE_TYPES.map((z) =>
    `<option value="${z}">${esc(ZONE_LABEL[z] || z)}</option>`).join("");

  return HTML(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Your codes — ${esc(biz.name)} · NUM</title>
<style>
:root{--paper:#faf8f4;--ink:#131a16;--pine:#1f3a34;--green:#1e7a4d;--line:#e0ddd4;--warn:#b4552d}
*{margin:0;box-sizing:border-box}
body{font:16px/1.6 -apple-system,'Segoe UI',Inter,sans-serif;background:var(--paper);color:var(--ink);
  max-width:880px;margin:0 auto;padding:36px 20px 80px}
h1{font-size:clamp(26px,5vw,34px);color:var(--pine);letter-spacing:-.02em;margin-bottom:4px}
h2{font-size:19px;color:var(--pine);margin:28px 0 10px;display:flex;align-items:center;gap:10px}
.count{font-size:13px;font-weight:600;background:#fff;border:1px solid var(--line);
  border-radius:20px;padding:2px 10px;color:#68705f}
.sub{color:#68705f;margin-bottom:22px}
.nav{display:flex;gap:10px;margin-bottom:22px;flex-wrap:wrap}
.nav a,.nav button{min-height:44px;display:inline-flex;align-items:center;padding:10px 18px;
  border-radius:10px;border:1.5px solid var(--pine);color:var(--pine);background:transparent;
  font:600 15px inherit;text-decoration:none;cursor:pointer}
.nav .on{background:var(--pine);color:#fff}
.setup{background:#fff;border:2px solid var(--green);border-radius:16px;padding:22px;margin-bottom:26px}
.setup h2{margin:0 0 8px}
.setup p{color:#39423b;margin-bottom:14px;max-width:60ch}
.hint{font-size:14px;color:#68705f;margin-top:10px}
.add{display:flex;gap:10px;flex-wrap:wrap;background:#fff;border:1px solid var(--line);
  border-radius:14px;padding:16px;margin-bottom:6px}
.add input,.add select{min-height:48px;font:16px inherit;padding:12px 14px;
  border:1.5px solid var(--line);border-radius:10px;background:var(--paper)}
.add input#label{flex:1 1 180px}
.add input#count{width:86px}
.add select{flex:0 1 160px}
.add input:focus,.add select:focus{outline:0;border-color:var(--green)}
.btn{min-height:48px;background:var(--green);color:#fff;font:650 16px inherit;border:0;
  border-radius:10px;padding:12px 22px;cursor:pointer}
.btn.sec{background:transparent;color:var(--pine);border:1.5px solid var(--pine)}
.btn[disabled]{opacity:.55}
ul{list-style:none}
.code{display:grid;grid-template-columns:132px 1fr;gap:16px;align-items:center;background:#fff;
  border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:10px}
.code.revoked{opacity:.5}
.code.revoked .qr{filter:grayscale(1)}
.meta b{display:block;font-size:18px;color:var(--pine)}
.meta code{display:block;font:13px ui-monospace,Menlo,monospace;color:#68705f;margin:3px 0}
.stat{font-size:13.5px;color:#68705f}
.acts{margin-top:8px}
.lnk{background:none;border:0;padding:8px 0;font:600 15px inherit;color:var(--green);
  cursor:pointer;text-decoration:underline;text-underline-offset:3px;min-height:44px}
.lnk.warn{color:var(--warn)}
.lnk.more{font-size:14px;margin-left:auto}
.retired{opacity:.85}
.note{background:#fff;border:1px solid var(--line);border-left:4px solid var(--green);
  border-radius:10px;padding:14px 18px;font-size:14.5px;color:#39423b;margin:26px 0}
.msg{margin:14px 0;padding:12px 16px;border-radius:10px;font-size:15px}
.msg.bad{background:#fdf0e9;border:1px solid #f0cbb4;color:#6b3113}
.msg.good{background:#e8f4ec;border:1px solid #b9dcc6;color:#14432c}
@media(max-width:520px){
  .code{grid-template-columns:1fr;justify-items:center;text-align:center}
  .meta{min-width:0;max-width:100%}
  .meta code{word-break:break-all;white-space:normal}
}
@media print{
  body{max-width:none;padding:0}
  h1,.sub,.nav,.add,.note,.setup,.acts,.stat,.msg,.lnk,.count{display:none!important}
  h2{page-break-after:avoid}
  ul{display:grid;grid-template-columns:1fr 1fr;gap:0}
  .code{display:block;text-align:center;page-break-inside:avoid;border:1px dashed #bbb;
    border-radius:0;margin:0;padding:26px 10px;opacity:1}
  .retired,.code.revoked{display:none}
  .qr img{width:190px;height:190px}
  .meta b{font-size:17px;margin-top:10px}
  .meta code{font-size:12px}
}
</style></head>
<body>

<h1>${esc(biz.name)}</h1>
<p class="sub">Codes for every table, seat and booth. Guests scan them when they arrive.</p>

<div class="nav">
  <a class="on" href="#">Codes</a>
  <a href="/biz/visitors?k=${encodeURIComponent(url.searchParams.get("k") || "")}">Visitors</a>
  <button class="sec btn" onclick="window.print()" style="border-color:var(--pine)">Print all</button>
  <button id="rotate" class="btn sec" title="Get a fresh private link">New private link</button>
</div>

${firstRun}

<form class="add" id="add">
  <select id="zone" aria-label="Zone type">${zoneOpts}</select>
  <input id="count" type="number" min="1" max="100" value="1" aria-label="How many">
  <input id="label" maxlength="40" placeholder="Name (optional — we'll number them)" aria-label="Name">
  <button class="btn" type="submit" id="go">Add</button>
</form>
<p class="hint">Adding 4 bar seats when you already have 12 continues at Bar seat 13.</p>

<div id="msg"></div>

${sections || (firstRun ? "" : '<p class="sub">No active codes.</p>')}
${revoked}

<div class="note"><b>Retiring is not deleting.</b> A card stays on a table long after you stop
using it, so a retired code answers guests with "this was retired, ask for the current one"
instead of an error — and your check-in history stays intact, which matters because it is what
your billing is based on. Put any retired code back at any time.</div>

<script>
(function(){
  var K = new URLSearchParams(location.search).get('k');
  var msg = document.getElementById('msg');
  function say(kind, text){ msg.innerHTML = '<div class="msg '+kind+'">'+text+'</div>';
    window.scrollTo({top: msg.offsetTop - 80, behavior: 'smooth'});
    if(kind==='good') setTimeout(function(){ msg.innerHTML=''; }, 5000); }
  function api(path, body){
    return fetch(path + '?k=' + encodeURIComponent(K), {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)
    }).then(function(r){ return r.json(); });
  }

  var tplBtn = document.getElementById('applyTpl');
  if (tplBtn) tplBtn.addEventListener('click', function(){
    tplBtn.disabled = true; tplBtn.textContent = 'Creating…';
    api('/api/venue/codes/bulk', { template: tplBtn.dataset.tpl })
      .then(function(j){ j.ok ? location.reload() : (tplBtn.disabled=false,
        tplBtn.textContent='Create these codes', say('bad','Could not set that up just now.')); })
      .catch(function(){ tplBtn.disabled=false; tplBtn.textContent='Create these codes';
        say('bad','No connection. Nothing was changed.'); });
  });

  document.getElementById('add').addEventListener('submit', function(e){
    e.preventDefault();
    var zone = document.getElementById('zone').value;
    var count = parseInt(document.getElementById('count').value, 10) || 1;
    var label = document.getElementById('label').value.trim();
    var go = document.getElementById('go');
    go.disabled = true; go.textContent = 'Adding…';
    var done = function(j){
      go.disabled = false; go.textContent = 'Add';
      if (j.ok) location.reload();
      else if (j.error === 'label_exists') say('bad','You already have an active code called that.');
      else if (j.error === 'too_many_codes') say('bad','That would pass the maximum. Retire some first.');
      else say('bad','Could not add that just now.');
    };
    var fail = function(){ go.disabled=false; go.textContent='Add';
      say('bad','No connection. Nothing was changed.'); };
    // A custom name creates exactly one, named that. Otherwise bulk by zone.
    if (label && count === 1) api('/api/venue/codes', { label: label }).then(done).catch(fail);
    else api('/api/venue/codes/bulk', { zone_type: zone, count: count }).then(done).catch(fail);
  });

  document.body.addEventListener('click', function(e){
    var more = e.target.closest && e.target.closest('button.more');
    if (more) {
      document.getElementById('zone').value = more.dataset.zone;
      document.getElementById('count').focus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    var btn = e.target.closest && e.target.closest('button[data-act]');
    if (!btn) return;
    var li = btn.closest('.code'), to = btn.dataset.act;
    if (to === 'revoked' && !confirm('Retire "' + li.querySelector('b').textContent +
        '"?\\n\\nAnyone scanning that card is told it was retired. History is kept; you can put it back later.')) return;
    btn.disabled = true;
    api('/api/venue/codes/state', { token: li.dataset.token, state: to })
      .then(function(j){ j.ok ? location.reload() : (btn.disabled=false, say('bad','That did not go through.')); })
      .catch(function(){ btn.disabled=false; say('bad','No connection. Nothing was changed.'); });
  });

  document.getElementById('rotate').addEventListener('click', function(){
    if (!confirm('Get a new private link?\\n\\nYour current link stops working immediately. ' +
        'Codes, cards and history are untouched. Save the new link somewhere safe — it is shown once.')) return;
    api('/api/venue/key/rotate', {}).then(function(j){
      if (j.ok) { prompt('Your new private link — copy it now:', j.manager_url);
                  location.href = j.manager_url; }
      else say('bad','Could not rotate just now.');
    }).catch(function(){ say('bad','No connection. Nothing was changed.'); });
  });
})();
</script>
</body></html>`);
}

/* ── /biz/visitors — the visitor book ────────────────────────────────────── */
async function venueVisitorsPage(req, env, url) {
  const biz = await bizAuth(env, url, req);
  if (!biz) return HTML(`<!doctype html><meta charset="utf-8"><title>Sign in — NUM</title>
<p style="font:17px -apple-system,sans-serif;max-width:420px;margin:80px auto;color:#131a16">
That link isn't valid. Use the link we sent you, or ask us to resend it: info@5arz.com</p>`, 401);

  const cat = categoryOf(biz);
  const k = encodeURIComponent(url.searchParams.get("k") || "");

  const [{ results: visitors }, today, week] = await Promise.all([
    env.DB.prepare(
      `SELECT s.member_ref, COUNT(*) AS visits, MAX(s.created_at) AS last_visit,
              (SELECT c2.label FROM num_venue_scans s2
                 JOIN num_venue_codes c2 ON c2.token = s2.token
                WHERE s2.business_id = s.business_id AND s2.member_ref = s.member_ref
                  AND s2.outcome='completed'
                GROUP BY c2.label ORDER BY COUNT(*) DESC LIMIT 1) AS usual_spot
         FROM num_venue_scans s
        WHERE s.business_id=? AND s.outcome='completed' AND s.member_ref IS NOT NULL
        GROUP BY s.member_ref ORDER BY MAX(s.created_at) DESC LIMIT 100`
    ).bind(biz.id).all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM num_venue_scans
        WHERE business_id=? AND outcome='completed' AND created_at > datetime('now','start of day')`
    ).bind(biz.id).first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM num_venue_scans
        WHERE business_id=? AND outcome='completed' AND created_at > datetime('now','-7 day')`
    ).bind(biz.id).first(),
  ]);

  const repeat = (visitors || []).filter((v) => v.visits > 1).length;

  const rows = (visitors || []).map((v) => `
    <tr><td><b>guest-${esc(String(v.member_ref).slice(-4))}</b></td>
        <td>${v.visits}</td>
        <td>${esc(v.usual_spot || "—")}</td>
        <td>${esc((v.last_visit || "").slice(0, 16))}</td></tr>`).join("");

  return HTML(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Visitors — ${esc(biz.name)} · NUM</title>
<style>
:root{--paper:#faf8f4;--ink:#131a16;--pine:#1f3a34;--green:#1e7a4d;--line:#e0ddd4}
*{margin:0;box-sizing:border-box}
body{font:16px/1.6 -apple-system,'Segoe UI',Inter,sans-serif;background:var(--paper);color:var(--ink);
  max-width:880px;margin:0 auto;padding:36px 20px 80px}
h1{font-size:clamp(26px,5vw,34px);color:var(--pine);letter-spacing:-.02em;margin-bottom:4px}
.sub{color:#68705f;margin-bottom:22px}
.nav{display:flex;gap:10px;margin-bottom:22px}
.nav a{min-height:44px;display:inline-flex;align-items:center;padding:10px 18px;border-radius:10px;
  border:1.5px solid var(--pine);color:var(--pine);font:600 15px inherit;text-decoration:none}
.nav .on{background:var(--pine);color:#fff}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:26px}
.tile{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px}
.tile b{display:block;font-size:30px;color:var(--pine);line-height:1.1}
.tile span{font-size:13.5px;color:#68705f}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);
  border-radius:14px;overflow:hidden;font-size:15px}
th{background:var(--pine);color:#fff;text-align:left;padding:10px 14px;font-weight:650}
td{padding:10px 14px;border-top:1px solid var(--line);color:#39423b}
.note{background:#fff;border:1px solid var(--line);border-left:4px solid var(--green);
  border-radius:10px;padding:14px 18px;font-size:14.5px;color:#39423b;margin:26px 0}
@media(max-width:600px){table{font-size:13.5px}th,td{padding:8px 8px}}
</style></head>
<body>
<h1>${esc(biz.name)}</h1>
<p class="sub">Your visitor book — built from check-ins, one row per verified guest.</p>

<div class="nav">
  <a href="/biz/codes?k=${k}">Codes</a>
  <a class="on" href="#">Visitors</a>
</div>

<div class="tiles">
  <div class="tile"><b>${today?.n || 0}</b><span>check-ins today</span></div>
  <div class="tile"><b>${week?.n || 0}</b><span>this week</span></div>
  <div class="tile"><b>${(visitors || []).length}</b><span>guests seen</span></div>
  <div class="tile"><b>${repeat}</b><span>came back</span></div>
</div>

${rows ? `<table>
  <tr><th>Guest</th><th>Visits</th><th>Usual spot</th><th>Last seen</th></tr>
  ${rows}
</table>` : `<p class="sub">No check-ins yet. Once guests start scanning your codes,
each verified guest appears here — how often they come and where they usually sit.</p>`}

<div class="note"><b>Who these guests are.</b> Every row is a real, identity-verified person —
that is what NUM checks before anyone can book. We show them to you pseudonymously
("guest-a3f2") rather than by name: you get recognition — fourth visit, usually the terrace —
and the guest keeps their name until they choose to give it to you, which regulars do. That
balance is what makes guests comfortable scanning at all, and it is why this data exists.</div>

</body></html>`);
}
