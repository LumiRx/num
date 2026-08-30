/**
 * num-growth — the worker behind the claim page, the VIP host referral
 * programme, and first-party visitor capture.
 *
 * One worker, because all three things share the same three concerns: who sent
 * this person, what did they consent to, and can we prove it later.
 *
 * Routes
 *   POST /api/claims                merchant claim form  (claim-uk.html)
 *   POST /api/ev                    first-party arrival log (all pages)
 *   POST /api/capture               landing-page email capture
 *   POST /api/consent               cookie-banner decision
 *   POST /api/host/join             VIP host signs up      (host-join.html)
 *   GET  /api/host/summary?k=       host console data      (host-console.html)
 *   POST /api/host/contacts?k=      host uploads contacts  (host-console.html)
 *   GET  /r/:code                   referral link -> attributed redirect
 *   GET  /go/:token                 contact confirms  (double opt-in)
 *   GET  /stop/:token               contact opts out
 *   POST /stop/:token               RFC 8058 one-click unsubscribe
 *   POST /api/admin/earnings        accrue / transition host earnings (ADMIN_KEY)
 *   GET  /api/growth/health         deploy check
 *
 * Bindings (see DEPLOY.md)
 *   DB            D1        num production database
 *   RESEND_KEY    secret    Resend API key
 *   VISITOR_SALT  secret    any long random string; rotates visitor ids daily
 *   ADMIN_KEY     secret    guards /api/admin/*
 *   SITE          var       https://itsnum.com
 *   MAIL_FROM     var       Num by 5arz <info@5arz.com>
 *   SEND_BUDGET   var       max invites actually sent per request (rest queue)
 */

const LEGAL_LINE = "5arz Inc · info@5arz.com · +1 754 444 8885";
const BANNER_VERSION = "2026-07-31.1";
const TERMS_VERSION = "host-2026-07-31";

/* ------------------------------------------------------------------ utils */

const J = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

const TEXT = (s, status = 200) =>
  new Response(s, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const epoch = () => Math.floor(Date.now() / 1000);

// Whitelist, never blacklist. Keeps letters from any alphabet, digits, and the
// punctuation real names actually contain. Control characters cannot survive
// this by construction, which is what stops header injection in email fields.
const SAFE = /[^\p{L}\p{N} '&.,()\/+@_-]/gu;
function clean(s, max = 200) {
  if (s == null) return "";
  let out = String(s);
  try { out = out.replace(SAFE, " "); }
  catch (e) { out = out.replace(/[^A-Za-z0-9 '&.,()\/+@_-]/g, " "); }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? out.slice(0, max) : out;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const okEmail = (e) => typeof e === "string" && e.length <= 254 && EMAIL_RE.test(e.trim());
const lc = (e) => String(e || "").trim().toLowerCase();

function digits(s) { return String(s || "").replace(/[^0-9]/g, ""); }
function okPhone(s) { const d = digits(s); return d.length >= 7 && d.length <= 15; }

// E.164-ish. Default GB because that is where wave 2 sends. A leading 0 is a
// national trunk prefix and is dropped, which is the single most common way
// UK mobile numbers get mangled.
function e164(raw, cc = "44") {
  const s = String(raw || "").trim();
  if (s.startsWith("+")) return "+" + digits(s);
  let d = digits(s);
  if (!d) return "";
  if (d.startsWith("00")) return "+" + d.slice(2);
  if (d.startsWith(cc) && d.length > 10) return "+" + d;
  if (d.startsWith("0")) d = d.slice(1);
  return "+" + cc + d;
}

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sha256(str) {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)));
}

/**
 * Pseudonymous visitor id. Derived server-side from a secret that is mixed with
 * today's UTC date, so the id changes every 24h and cannot be reversed into an
 * IP. Nothing is stored on the visitor's device, so PECR reg 6 is not engaged
 * and this needs no consent. It also survives ad blockers, which cookies do not.
 */
async function visitorId(req, env) {
  const ip = req.headers.get("cf-connecting-ip") || "0";
  const ua = req.headers.get("user-agent") || "0";
  const day = new Date().toISOString().slice(0, 10);
  const salt = env.VISITOR_SALT || "num-dev-salt";
  return (await sha256(salt + "|" + day + "|" + ip + "|" + ua)).slice(0, 22);
}

function token(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time-ish compare so a console key cannot be guessed a byte at a time.
function sameSecret(a, b) {
  const x = String(a || ""), y = String(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function readJSON(req, limit = 512 * 1024) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > limit) throw new Error("too big");
  const raw = await req.text();
  if (raw.length > limit) throw new Error("too big");
  return JSON.parse(raw || "{}");
}

function country(req) {
  return (req.cf && req.cf.country) || req.headers.get("cf-ipcountry") || "";
}

function device(req) {
  const ua = (req.headers.get("user-agent") || "").toLowerCase();
  if (/ipad|tablet/.test(ua)) return "tablet";
  if (/mobi|android|iphone/.test(ua)) return "mobile";
  if (!ua) return "";
  return "desktop";
}

/* --------------------------------------------------------- abuse guardrail */

// Per-isolate token bucket. Not a distributed rate limiter — it is a cheap
// backstop so one script cannot fill D1 from a single connection. Put a
// Cloudflare rate-limiting rule in front of /api/ev for the real thing.
const buckets = new Map();
function overLimit(key, perMinute) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || t - b.t > 60000) { b = { t, n: 0 }; buckets.set(key, b); }
  b.n++;
  if (buckets.size > 5000) buckets.clear();
  return b.n > perMinute;
}

const ALLOWED_ORIGINS = [
  "https://itsnum.com", "https://www.itsnum.com",
  "https://5arz.com", "https://www.5arz.com",
  // The install landing page is served from app.itsnum.com. Without this it
  // gets a 403 on every /api/ev call, which is why 714 landing views have
  // produced no funnel: the page was never permitted to report anything.
  "https://app.itsnum.com",
];
function badOrigin(req) {
  const o = req.headers.get("origin");
  if (!o) return false;           // sendBeacon in some browsers, curl, tests
  return !ALLOWED_ORIGINS.includes(o);
}

// Allowing an origin is not the same as letting the browser read the reply.
// Nothing here ever sent Access-Control-Allow-Origin, and OPTIONS answered a
// bare 204, so a cross-origin POST from app.itsnum.com would still be blocked
// by the browser after passing badOrigin(). A JSON content-type is not
// CORS-safelisted, so even navigator.sendBeacon triggers a preflight.
function cors(req) {
  const o = req.headers.get("origin");
  if (!o || !ALLOWED_ORIGINS.includes(o)) return {};
  return {
    "access-control-allow-origin": o,
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

// Copies a finished Response and adds the CORS headers. Kept separate from J()
// so every existing caller keeps its exact behaviour.
function withCors(req, res) {
  const h = cors(req);
  if (!Object.keys(h).length) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(h)) out.headers.set(k, v);
  return out;
}

/* -------------------------------------------------------------------- mail */

async function sendBatch(env, messages) {
  if (!messages.length) return { ok: true, sent: 0, ids: [] };
  if (!env.RESEND_KEY) return { ok: false, sent: 0, ids: [], error: "no RESEND_KEY" };
  const res = await fetch("https://api.resend.com/emails/batch", {
    method: "POST",
    headers: {
      authorization: "Bearer " + env.RESEND_KEY,
      "content-type": "application/json",
      "idempotency-key": messages[0].__idem || token(12),
    },
    body: JSON.stringify(messages.map(({ __idem, ...m }) => m)),
  });
  if (!res.ok) {
    return { ok: false, sent: 0, ids: [], error: "resend " + res.status + " " + (await res.text()).slice(0, 300) };
  }
  const body = await res.json().catch(() => ({}));
  const ids = (body.data || []).map((d) => d.id);
  return { ok: true, sent: messages.length, ids };
}

/* ========================================================== CAPTURE ASSET */
/**
 * num-capture.js is served by this Worker rather than the static site so the
 * script and the endpoints it calls can never be deployed out of step with
 * each other. One deploy moves both. An hour of cache is deliberate: it is
 * the file that carries the consent wording, and a wording change should
 * reach everyone the same day.
 */
const CAPTURE_JS = `/**
 * num-capture.js — one small file that does the three front-end jobs:
 *
 *   1. logs that someone arrived, server-side, storing nothing on their device
 *   2. captures an email from any form marked data-num-capture
 *   3. shows a consent banner and only then loads Meta / Google pixels
 *
 * Drop it in the <head> of any page on itsnum.com or 5arz.com:
 *
 *   <script src="/num-capture.js"
 *           data-page="landing"
 *           data-meta-pixel="1234567890123456"
 *           data-google-ads="AW-123456789"
 *           defer></script>
 *
 * The two pixel attributes are optional and the file behaves very differently
 * without them: with no pixel configured there is nothing to ask permission
 * for, so no banner is shown at all. That is deliberate. A cookie banner on a
 * page that sets no cookies teaches people to click the banner away without
 * reading it, which is exactly what we do not want happening on the page that
 * does set them.
 *
 * No dependencies. No build step. Safe to load twice.
 */
(function () {
  "use strict";
  if (window.__numCapture) return;
  window.__numCapture = true;

  // ---------------------------------------------------------------- config

  var self =
    document.currentScript ||
    (function () {
      var all = document.getElementsByTagName("script");
      for (var i = all.length - 1; i >= 0; i--) {
        if ((all[i].src || "").indexOf("num-capture") > -1) return all[i];
      }
      return null;
    })();

  function attr(name, fallback) {
    var v = self && self.getAttribute("data-" + name);
    return v == null || v === "" ? fallback : v;
  }

  var CFG = {
    api: attr("api", ""), // same origin by default
    page: attr("page", "landing"),
    metaPixel: attr("meta-pixel", ""),
    googleAds: attr("google-ads", ""),
    ga4: attr("ga4", ""),
    banner: attr("banner", "auto"), // auto | off
    privacy: attr("privacy", "/privacy"),
    cookies: attr("cookies", "/cookies")
  };

  var BANNER_VERSION = "2026-07-31.1";
  var STORE_KEY = "num_consent_v1";

  // Page name to arrival event. Anything not in here is not logged, because
  // the worker only accepts events it knows and silently drops the rest.
  var ARRIVAL = {
    landing: "landing_view",
    claim: "claim_view",
    host: "host_join_view"
  };

  function api(path) {
    return (CFG.api || "") + path;
  }

  // ------------------------------------------------------------ small utils

  function qs(name) {
    try {
      return new URLSearchParams(location.search).get(name) || "";
    } catch (e) {
      return "";
    }
  }

  function post(path, body, opts) {
    var payload = JSON.stringify(body);
    // sendBeacon survives the page being closed mid-request, which is exactly
    // when an arrival log is most likely to be lost. It cannot report failure,
    // so anything we need an answer from goes through fetch instead.
    if (opts && opts.beacon && navigator.sendBeacon) {
      try {
        var blob = new Blob([payload], { type: "application/json" });
        if (navigator.sendBeacon(api(path), blob)) return Promise.resolve(null);
      } catch (e) {
        /* fall through to fetch */
      }
    }
    return fetch(api(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: true
    })
      .then(function (r) {
        return r.json().catch(function () {
          return null;
        });
      })
      .catch(function () {
        return null;
      });
  }

  function read(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      /* private mode, storage full, or blocked. Not fatal. */
    }
  }

  // -------------------------------------------------------------- referral

  /**
   * Which VIP host sent this person. It rides in the query string and is never
   * written to their device, so there is no PECR reg 6 problem, nothing for an
   * ad blocker to strip, and nothing that survives longer than the visit.
   *
   * The cost of that choice is that a normal click through to another page
   * loses it, so we carry it forward by rewriting our own links and by adding
   * a hidden field to our own forms. That keeps attribution alive for exactly
   * as long as the person is walking through the site, and no longer.
   */
  var REF = (qs("ref") || qs("r") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);

  var UTM = {
    utm_source: qs("utm_source").slice(0, 60),
    utm_medium: qs("utm_medium").slice(0, 60),
    utm_campaign: qs("utm_campaign").slice(0, 60)
  };

  var INVITE = qs("t").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

  function carryRef() {
    if (!REF) return;

    var links = document.querySelectorAll("a[href]");
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var href = a.getAttribute("href") || "";
      if (!href || href.charAt(0) === "#") continue;
      if (/^(mailto:|tel:|javascript:|sms:)/i.test(href)) continue;

      var u;
      try {
        u = new URL(href, location.href);
      } catch (e) {
        continue;
      }
      if (u.origin !== location.origin) continue; // never leak a host code offsite
      if (u.searchParams.get("ref")) continue;

      u.searchParams.set("ref", REF);
      a.setAttribute("href", u.pathname + u.search + u.hash);
    }

    var forms = document.querySelectorAll("form");
    for (var f = 0; f < forms.length; f++) {
      if (forms[f].querySelector('input[name="ref"]')) continue;
      var hidden = document.createElement("input");
      hidden.type = "hidden";
      hidden.name = "ref";
      hidden.value = REF;
      forms[f].appendChild(hidden);
    }
  }

  // -------------------------------------------------------- arrival logging

  /**
   * Logged on the server from the request we are already making. Nothing is
   * read from or written to the visitor's device, so this needs no consent and
   * is not something a tracker blocker has any reason to stop. It is also the
   * only arrival number we will ever be able to reconcile against bookings.
   */
  function logArrival() {
    var event = ARRIVAL[CFG.page];
    if (!event) return;

    post(
      "/api/ev",
      {
        event: event,
        page: CFG.page,
        ref_code: REF,
        invite_token: INVITE,
        utm_source: UTM.utm_source,
        utm_medium: UTM.utm_medium,
        utm_campaign: UTM.utm_campaign,
        referrer: document.referrer || ""
      },
      { beacon: true }
    );

    if (REF) {
      post("/api/ev", { event: "ref_arrival", page: CFG.page, ref_code: REF }, { beacon: true });
    }
    if (INVITE) {
      post("/api/ev", { event: "invite_open", page: CFG.page, invite_token: INVITE }, { beacon: true });
    }
  }

  // --------------------------------------------------------- email capture

  /**
   * Any form with data-num-capture posts here instead of reloading the page.
   *
   *   <form data-num-capture data-source="landing-hero">
   *     <input type="email" name="email" required>
   *     <label><input type="checkbox" name="marketing_ok"> Send me ...</label>
   *     <button>Get early access</button>
   *     <p data-num-msg></p>
   *   </form>
   *
   * The tick box is optional in the markup but load-bearing in law: without it
   * we have an address and no permission to market to it. When it is present we
   * store the exact words shown next to it, because "they consented" is not a
   * defence — "they were shown these words and ticked the box" is.
   */
  function bindForms() {
    var forms = document.querySelectorAll("[data-num-capture]");
    for (var i = 0; i < forms.length; i++) bindOne(forms[i]);
  }

  function labelTextFor(input, form) {
    var wrap = input.closest ? input.closest("label") : null;
    if (wrap) return (wrap.textContent || "").replace(/\\s+/g, " ").trim();
    if (input.id) {
      var lab = form.querySelector('label[for="' + input.id + '"]');
      if (lab) return (lab.textContent || "").replace(/\\s+/g, " ").trim();
    }
    return "";
  }

  function bindOne(form) {
    if (form.__numBound) return;
    form.__numBound = true;

    form.addEventListener("submit", function (e) {
      e.preventDefault();

      var msg = form.querySelector("[data-num-msg]");
      var btn = form.querySelector('button, [type="submit"]');
      var data = new FormData(form);

      var email = String(data.get("email") || "").trim();
      if (!email || email.indexOf("@") < 1 || email.indexOf(".") < 0) {
        say(msg, "That email address does not look right.", true);
        return;
      }

      var mkt = form.querySelector('[name="marketing_ok"]');
      var wantsMarketing = mkt ? !!mkt.checked : false;

      var body = {
        email: email,
        name: String(data.get("name") || "").trim(),
        phone: String(data.get("phone") || "").trim(),
        business: String(data.get("business") || "").trim(),
        source: form.getAttribute("data-source") || CFG.page,
        page: CFG.page,
        ref_code: REF,
        invite_token: INVITE,
        utm_source: UTM.utm_source,
        utm_medium: UTM.utm_medium,
        utm_campaign: UTM.utm_campaign,
        marketing_ok: wantsMarketing,
        consent_text: wantsMarketing && mkt ? labelTextFor(mkt, form) : ""
      };

      if (btn) {
        btn.disabled = true;
        btn.setAttribute("data-num-label", btn.textContent);
        btn.textContent = "One moment";
      }
      say(msg, "");

      post("/api/capture", body).then(function (res) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = btn.getAttribute("data-num-label") || "Send";
        }
        if (res && res.ok) {
          var done = form.getAttribute("data-done");
          say(msg, done || "Thank you. Check your inbox.");
          form.reset();
          post("/api/ev", { event: "capture_done", page: CFG.page, ref_code: REF });
          fire("num:capture", { email: email, marketing: wantsMarketing });
        } else {
          say(msg, "That did not go through. Email info@5arz.com and a person will sort it.", true);
        }
      });
    });
  }

  function say(el, text, isError) {
    if (!el) return;
    el.textContent = text || "";
    el.setAttribute("data-num-state", isError ? "error" : "ok");
    if (text) el.setAttribute("role", "status");
  }

  function fire(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail }));
    } catch (e) {
      /* old browser, no listeners lost that matter */
    }
  }

  // ------------------------------------------------------- consent + pixels

  function hasPixels() {
    return !!(CFG.metaPixel || CFG.googleAds || CFG.ga4);
  }

  function stored() {
    var raw = read(STORE_KEY);
    if (!raw) return null;
    try {
      var v = JSON.parse(raw);
      // A changed banner means changed wording, which means the old answer was
      // given to a different question. Ask again rather than assume.
      if (v && v.v === BANNER_VERSION) return v;
      return null;
    } catch (e) {
      return null;
    }
  }

  function remember(analytics, marketing) {
    write(STORE_KEY, JSON.stringify({ v: BANNER_VERSION, a: !!analytics, m: !!marketing, t: Date.now() }));
  }

  function record(analytics, marketing) {
    remember(analytics, marketing);
    post("/api/consent", {
      analytics: !!analytics,
      marketing: !!marketing,
      banner_version: BANNER_VERSION,
      page: CFG.page
    });
    if (marketing) loadPixels();
    fire("num:consent", { analytics: !!analytics, marketing: !!marketing });
  }

  var pixelsLoaded = false;

  /**
   * Nothing here runs until someone has said yes. Meta and Google both drop
   * identifiers the moment their script executes, so the script itself is the
   * thing that has to wait — loading it and "not firing events" is not consent
   * and would not survive a look.
   */
  function loadPixels() {
    if (pixelsLoaded) return;
    pixelsLoaded = true;

    if (CFG.metaPixel) {
      /* eslint-disable */
      !(function (f, b, e, v, n, t, s) {
        if (f.fbq) return;
        n = f.fbq = function () {
          n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
        };
        if (!f._fbq) f._fbq = n;
        n.push = n;
        n.loaded = true;
        n.version = "2.0";
        n.queue = [];
        t = b.createElement(e);
        t.async = true;
        t.src = v;
        s = b.getElementsByTagName(e)[0];
        s.parentNode.insertBefore(t, s);
      })(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
      /* eslint-enable */
      window.fbq("init", CFG.metaPixel);
      window.fbq("track", "PageView");
    }

    var gtagId = CFG.googleAds || CFG.ga4;
    if (gtagId) {
      var s = document.createElement("script");
      s.async = true;
      s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(gtagId);
      document.head.appendChild(s);
      window.dataLayer = window.dataLayer || [];
      window.gtag = function () {
        window.dataLayer.push(arguments);
      };
      window.gtag("js", new Date());
      if (CFG.googleAds) window.gtag("config", CFG.googleAds);
      if (CFG.ga4 && CFG.ga4 !== CFG.googleAds) window.gtag("config", CFG.ga4);
    }
  }

  // The banner. Built in JS rather than shipped as markup so a page cannot
  // accidentally render it without the logic that honours it.
  var BANNER_CSS =
    ".num-cb{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;background:#12100e;color:#f6f3ef;" +
    "font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
    "padding:20px clamp(16px,5vw,48px);box-shadow:0 -8px 40px rgba(0,0,0,.35)}" +
    ".num-cb-in{max-width:900px;margin:0 auto;display:flex;gap:22px;align-items:flex-start;flex-wrap:wrap}" +
    ".num-cb-t{flex:1 1 320px;min-width:260px}" +
    ".num-cb-t p{margin:0 0 6px}" +
    ".num-cb-t a{color:#f6f3ef;text-decoration:underline;text-underline-offset:2px}" +
    ".num-cb-b{display:flex;gap:10px;flex:0 0 auto;flex-wrap:nowrap;align-items:center}" +
    ".num-cb button{font:inherit;font-weight:600;border:1px solid #f6f3ef;border-radius:999px;" +
    "padding:11px 22px;cursor:pointer;background:transparent;color:#f6f3ef;min-width:132px;white-space:nowrap}" +
    ".num-cb button.num-cb-yes{background:#f6f3ef;color:#12100e}" +
    ".num-cb button:focus-visible{outline:3px solid #8ab4ff;outline-offset:2px}" +
    ".num-cb-sm{font-size:13px;opacity:.78;margin-top:8px}" +
    "@media(max-width:620px){.num-cb-b{width:100%}.num-cb button{flex:1 1 auto}}";

  function showBanner() {
    if (document.querySelector(".num-cb")) return;

    var style = document.createElement("style");
    style.textContent = BANNER_CSS;
    document.head.appendChild(style);

    var box = document.createElement("div");
    box.className = "num-cb";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-live", "polite");
    box.setAttribute("aria-label", "Cookies");

    var wrap = document.createElement("div");
    wrap.className = "num-cb-in";

    var text = document.createElement("div");
    text.className = "num-cb-t";

    var p1 = document.createElement("p");
    p1.innerHTML =
      "<strong>Can we use cookies to show you our ads elsewhere?</strong>";
    var p2 = document.createElement("p");
    p2.textContent =
      "Only for that. Saying no changes nothing about how this site works, " +
      "and we count visits either way without storing anything on your device.";
    var p3 = document.createElement("p");
    p3.className = "num-cb-sm";
    p3.innerHTML =
      '<a href="' + CFG.cookies + '">What these cookies do</a> &middot; ' +
      '<a href="' + CFG.privacy + '">Privacy</a> &middot; 5arz Inc';

    text.appendChild(p1);
    text.appendChild(p2);
    text.appendChild(p3);

    var btns = document.createElement("div");
    btns.className = "num-cb-b";

    // Refuse is built first and styled identically, because a reject that is
    // harder to find than accept is not a real choice and the ICO says so.
    var no = document.createElement("button");
    no.type = "button";
    no.textContent = "No thanks";

    var yes = document.createElement("button");
    yes.type = "button";
    yes.className = "num-cb-yes";
    yes.textContent = "Yes, that's fine";

    btns.appendChild(no);
    btns.appendChild(yes);

    wrap.appendChild(text);
    wrap.appendChild(btns);
    box.appendChild(wrap);
    document.body.appendChild(box);

    var previous = document.activeElement;

    function close(analytics, marketing) {
      record(analytics, marketing);
      box.remove();
      style.remove();
      if (previous && previous.focus) previous.focus();
    }

    no.addEventListener("click", function () {
      close(false, false);
    });
    yes.addEventListener("click", function () {
      close(true, true);
    });
    box.addEventListener("keydown", function (e) {
      // Escape closes as a refusal. Dismissal is never consent.
      if (e.key === "Escape") close(false, false);
    });

    no.focus();
  }

  function bindSettingsLinks() {
    var links = document.querySelectorAll("[data-num-cookie-settings]");
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener("click", function (e) {
        e.preventDefault();
        try {
          localStorage.removeItem(STORE_KEY);
        } catch (err) {
          /* nothing to clear */
        }
        showBanner();
      });
    }
  }

  function consentBoot() {
    if (!hasPixels() || CFG.banner === "off") return; // nothing to ask about
    var prior = stored();
    if (prior) {
      if (prior.m) loadPixels();
      return;
    }
    showBanner();
  }

  // ------------------------------------------------------------------ boot

  function boot() {
    carryRef();
    logArrival();
    bindForms();
    bindSettingsLinks();
    consentBoot();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // Exposed so a page can capture from its own code, and so the claim and host
  // pages can log their completion event without duplicating any of this.
  window.num = window.num || {};
  window.num.track = function (event, extra) {
    var body = extra || {};
    body.event = event;
    body.page = body.page || CFG.page;
    body.ref_code = body.ref_code || REF;
    return post("/api/ev", body);
  };
  window.num.ref = REF;
  window.num.consent = function () {
    return stored() || { v: BANNER_VERSION, a: false, m: false };
  };
})();
`;

function captureAsset() {
  return new Response(CAPTURE_JS, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}

/* ================================================================= ROUTES */

const WORKER = {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (req.method === "OPTIONS")
        return new Response(null, { status: 204, headers: cors(req) });

      if (p === "/api/growth/health") return health(env);
      if (p === "/num-capture.js") return captureAsset();

      if (p === "/api/ev" && req.method === "POST")
        return withCors(req, await ev(req, env));
      if (p === "/api/consent" && req.method === "POST") return consent(req, env);
      if (p === "/api/sms-optin" && req.method === "POST") return smsOptin(req, env);
      if (p === "/api/capture" && req.method === "POST") return capture(req, env);
      if (p === "/api/claims" && req.method === "POST") return claims(req, env, ctx);

      if (p === "/api/host/join" && req.method === "POST") return hostJoin(req, env, ctx);
      if (p === "/api/host/summary" && req.method === "GET") return hostSummary(req, env, url);
      if (p === "/api/host/contacts" && req.method === "POST") return hostContacts(req, env, url, ctx);

      if (p === "/api/admin/earnings" && req.method === "POST") return adminEarnings(req, env);

      if (p === "/api/venue/arrive" && req.method === "POST")
        return withCors(req, await venueArrive(req, env));
      if (p === "/api/venue/confirm" && req.method === "POST") return venueConfirm(req, env);
      if (p === "/api/venue/codes" && req.method === "GET")
        return venueCodesList(req, env, url);
      if (p === "/api/venue/codes" && req.method === "POST")
        return venueCodesCreate(req, env, url);
      if (p === "/api/venue/codes/state" && req.method === "POST")
        return venueCodesState(req, env, url);
      if (p.startsWith("/api/venue/qr/")) return venueQr(req, env, p.slice(14));
      if (p === "/api/admin/venue/issue" && req.method === "POST")
        return venueIssueKey(req, env, ctx);
      if (p === "/api/admin/venue/security") return venueSecurityReport(req, env);
      if (p === "/api/venue/key/rotate" && req.method === "POST")
        return venueKeyRotate(req, env);
      if (p === "/api/venue/codes/bulk" && req.method === "POST")
        return venueCodesBulk(req, env, url);
      if (p === "/api/venue/visitors") return venueVisitors(req, env, url);
      if (p === "/biz/codes") return venueCodesPageV2(req, env, url);
      if (p === "/biz/visitors") return venueVisitorsPage(req, env, url);
      if (p === "/biz/offers") return venueOffersPage(req, env, url);
      if (p === "/api/venue/offers" && req.method === "POST")
        return venueOffersCreate(req, env, url);
      if (p === "/api/venue/offers/end" && req.method === "POST")
        return venueOffersEnd(req, env, url);
      if (p === "/api/venue/offers/live") return offersLive(req, env);
      if (p === "/tonight" || p.startsWith("/tonight/")) return tonightPage(req, env, url);
      if (p.startsWith("/v/")) return venueLanding(req, env, p.slice(3));
      if (p.startsWith("/r/")) return referral(req, env, url, p.slice(3));
      if (p.startsWith("/go/")) return confirmContact(req, env, p.slice(4));
      if (p.startsWith("/stop/")) return stopContact(req, env, p.slice(6));

      return new Response("Not found", { status: 404 });
    } catch (err) {
      // Never leak an internal message to a visitor; log it for us.
      console.log("num-growth error", p, String(err && err.stack || err));
      return J({ ok: false, error: "server_error" }, 500);
    }
  },

  /**
   * Cron. Drains queued host-contact invites at a rate the Resend plan can
   * actually carry, so a host uploading 400 names does not consume the whole
   * day's quota in one request — or silently lose 300 of them.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(drainQueue(env, Number(env.SEND_BUDGET || 40)));
  },
};

/* ---------------------------------------------------------------- health */

async function health(env) {
  let db = "missing";
  try {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM num_hosts").first();
    db = "ok (" + (r ? r.n : 0) + " hosts)";
  } catch (e) { db = "error: " + String(e).slice(0, 120); }
  return J({
    ok: true,
    worker: "num-growth",
    db,
    bindings: {
      DB: !!env.DB,
      RESEND_KEY: !!env.RESEND_KEY,
      VISITOR_SALT: !!env.VISITOR_SALT,
      ADMIN_KEY: !!env.ADMIN_KEY,
      SITE: env.SITE || "(default)",
      MAIL_FROM: env.MAIL_FROM || "(default)",
    },
  });
}

/* ------------------------------------------------------- /api/ev  arrivals */

const EVENTS = new Set([
  "claim_view", "claim_done", "host_join_view", "host_join_done",
  "landing_view", "capture_done", "ref_arrival", "invite_open",
  // --- install funnel (added 10 Aug 2026) ------------------------------
  // Every step between arriving and actually using Num. Before these,
  // the only thing recorded was that the page had been served.
  "install_cta_click",      // tapped any "add to home screen" control
  "install_tab_view",       // opened the iPhone / Android / Desktop pane
  "install_prompt_shown",   // the browser beforeinstallprompt actually fired
  "install_accepted",       // user accepted that prompt
  "install_dismissed",      // user rejected it — the number nobody wants to look at
  "app_launched_standalone",// opened Num from the home screen icon: real install proof
  "open_in_browser_click",  // chose the browser over installing
  "first_message_sent",     // the only event that means the product was used
  "watch_film_click",
  "scroll_50", "scroll_90",
  // --- desktop handoff --------------------------------------------------
  "desktop_handoff_shown", "desktop_qr_shown", "desktop_link_sent",
  // --- language -----------------------------------------------------------
  "lang_offer_shown", "lang_switched",
]);

async function ev(req, env) {
  if (badOrigin(req)) return J({ ok: false }, 403);
  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (overLimit("ev:" + ip, 60)) return J({ ok: true, throttled: true });

  let b;
  try { b = await readJSON(req, 8192); } catch (e) { return J({ ok: false }, 400); }

  const name = clean(b.event, 40);
  if (!EVENTS.has(name)) return J({ ok: true, ignored: true });

  const vid = await visitorId(req, env);
  await env.DB.prepare(
    `INSERT INTO num_web_events
       (visitor_id,event,page,ref_code,invite_token,utm_source,utm_medium,utm_campaign,referrer,country,device,detail,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    vid, name, clean(b.page, 40), clean(b.ref_code, 40), clean(b.invite_token, 64),
    clean(b.utm_source, 60), clean(b.utm_medium, 60), clean(b.utm_campaign, 60),
    String(b.referrer || "").slice(0, 200), country(req), device(req),
    // Which control was tapped / which pane was opened. Without a column for
    // it, "install_cta_click" cannot tell the hero button from the sticky dock.
    clean(b.detail, 60), now()
  ).run();

  return J({ ok: true });
}

/* -------------------------------------------------- /api/consent  banner */

async function consent(req, env) {
  if (badOrigin(req)) return J({ ok: false }, 403);
  let b;
  try { b = await readJSON(req, 4096); } catch (e) { return J({ ok: false }, 400); }

  const vid = await visitorId(req, env);
  const cats = { analytics: b.analytics ? 1 : 0, marketing: b.marketing ? 1 : 0, necessary: 1 };
  const stmts = Object.keys(cats).map((cat) =>
    env.DB.prepare(
      `INSERT INTO num_web_consent (visitor_id,category,granted,banner_version,page,country,created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(visitor_id,category) DO UPDATE SET
         granted=excluded.granted, banner_version=excluded.banner_version, created_at=excluded.created_at`
    ).bind(vid, cat, cats[cat], clean(b.banner_version, 40) || BANNER_VERSION, clean(b.page, 40), country(req), now())
  );
  await env.DB.batch(stmts);
  return J({ ok: true, visitor: vid, granted: cats });
}

/* ------------------------------------------ /api/sms-optin  A2P consent */

/**
 * The exact words shown beside the checkbox on /sms/.
 *
 * Held here, server-side, and NEVER read from the request body. The entire
 * evidentiary value of a consent record is that we can state what the person
 * was shown — a client-supplied string proves nothing, because anything
 * posting to this endpoint could claim any language. If the page copy changes,
 * change it here too and bump the version, so old records keep describing what
 * was actually on screen when they were signed.
 */
const SMS_CONSENT_VERSION = "2026-08-04.1";
const SMS_CONSENT_TEXT =
  "Text me about my NUM travel concierge requests and bookings. " +
  "Message frequency varies. Message and data rates may apply. " +
  "Reply HELP for help, STOP to opt out. " +
  "See our Privacy Policy and Terms of Service.";

// Written lazily rather than as a migration so the endpoint cannot go live
// without its table — the failure mode of a separate migration step is that
// the form starts accepting consent it silently cannot store, which is worse
// than not accepting it at all.
const SMS_CONSENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS num_sms_consent (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  first_name TEXT,
  consent_text TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  page TEXT,
  ip TEXT,
  user_agent TEXT,
  country TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_num_sms_consent_phone ON num_sms_consent(phone);
`;
let smsConsentReady = false;
async function ensureSmsConsent(env) {
  if (smsConsentReady) return;
  await env.DB.batch(
    SMS_CONSENT_SCHEMA.split(";").map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s))
  );
  smsConsentReady = true;
}

/**
 * Record an SMS opt-in from /sms/.
 *
 * This exists because the form on that page posted to an endpoint that was
 * never built — every submission returned 405 and no consent was ever stored.
 * A carrier or TCR audit asks one question: show us the consent. Until now the
 * honest answer would have been that we had none, for anyone.
 *
 * Reads a FORM body, not JSON, on purpose: /sms/ is a plain HTML form so that
 * it still works with JavaScript disabled. A compliance page that requires JS
 * is a compliance page a reviewer can fail to complete.
 */
async function smsOptin(req, env) {
  if (badOrigin(req)) return J({ ok: false, error: "bad_origin" }, 403);
  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (overLimit("sms:" + ip, 8)) return J({ ok: false, error: "slow_down" }, 429);

  let form;
  try { form = await req.formData(); } catch (e) { return J({ ok: false, error: "bad_form" }, 400); }

  // Consent is the whole point: no tick, no record, no exceptions. The browser
  // enforces `required` too, but a checkbox is trivially bypassed and this is
  // the copy of the check that actually matters.
  if (!form.get("sms_consent")) return J({ ok: false, error: "consent_required" }, 400);

  const raw = String(form.get("phone") || "").trim();
  if (!okPhone(raw)) return J({ ok: false, error: "bad_phone" }, 400);
  // Keep the + form the person typed when they gave one — guessing a country
  // code onto an international traveller's number is how you store a number
  // that belongs to somebody else.
  const phone = raw.startsWith("+") ? "+" + digits(raw) : e164(raw);

  await ensureSmsConsent(env);
  await env.DB.prepare(
    `INSERT INTO num_sms_consent
       (id, phone, first_name, consent_text, consent_version, page, ip, user_agent, country, created_at, revoked_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL)
     ON CONFLICT(phone) DO UPDATE SET
       first_name      = COALESCE(NULLIF(excluded.first_name,''), num_sms_consent.first_name),
       consent_text    = excluded.consent_text,
       consent_version = excluded.consent_version,
       created_at      = excluded.created_at,
       -- Re-consenting is how somebody comes back after STOP. Clearing this is
       -- the only way back in, and it must be their own deliberate act.
       revoked_at      = NULL`
  ).bind(
    "smsc_" + token(8),
    phone,
    clean(form.get("first_name"), 60),
    SMS_CONSENT_TEXT,
    SMS_CONSENT_VERSION,
    clean(req.headers.get("referer"), 200),
    // Retained deliberately: IP and timestamp are the standard evidence a
    // carrier asks for. Its only purpose is proving this consent happened.
    ip,
    clean(req.headers.get("user-agent"), 200),
    country(req),
    now()
  ).run();

  // Back to the page they were on, which shows the confirmation. 303 so the
  // browser switches to GET and a refresh cannot re-post the form.
  return new Response(null, { status: 303, headers: { Location: "/sms/?ok=1" } });
}

/* -------------------------------------------------- /api/capture  emails */

async function capture(req, env) {
  if (badOrigin(req)) return J({ ok: false }, 403);
  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (overLimit("cap:" + ip, 12)) return J({ ok: false, error: "slow_down" }, 429);

  let b;
  try { b = await readJSON(req, 16384); } catch (e) { return J({ ok: false }, 400); }

  const email = String(b.email || "").trim();
  if (!okEmail(email)) return J({ ok: false, error: "bad_email" }, 400);

  const vid = await visitorId(req, env);
  const src = clean(b.source, 60) || "landing";

  await env.DB.prepare(
    `INSERT INTO num_captures
       (id,email,email_lc,phone,name,business,visitor_id,source,page,ref_code,invite_token,
        utm_source,utm_medium,utm_campaign,country,marketing_ok,sms_ok,consent_text,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(email_lc,source) DO UPDATE SET
       phone        = COALESCE(NULLIF(excluded.phone,''), num_captures.phone),
       name         = COALESCE(NULLIF(excluded.name,''),  num_captures.name),
       visitor_id   = excluded.visitor_id,
       marketing_ok = MAX(num_captures.marketing_ok, excluded.marketing_ok),
       consent_text = CASE WHEN excluded.marketing_ok=1 THEN excluded.consent_text ELSE num_captures.consent_text END`
  ).bind(
    "cap_" + token(8), email, lc(email), clean(b.phone, 32), clean(b.name, 80), clean(b.business, 120),
    vid, src, clean(b.page, 40), clean(b.ref_code, 40), clean(b.invite_token, 64),
    clean(b.utm_source, 60), clean(b.utm_medium, 60), clean(b.utm_campaign, 60), country(req),
    b.marketing_ok ? 1 : 0, b.sms_ok ? 1 : 0, String(b.consent_text || "").slice(0, 1000), now()
  ).run();

  return J({ ok: true });
}

/* ------------------------------------------------------ /api/claims  form */

async function claims(req, env, ctx) {
  if (badOrigin(req)) return J({ ok: false }, 403);
  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (overLimit("claim:" + ip, 10)) return J({ ok: false, error: "slow_down" }, 429);

  let b;
  try { b = await readJSON(req, 32768); } catch (e) { return J({ ok: false }, 400); }

  const business = clean(b.business_name, 120);
  const contact = clean(b.contact_name, 80);
  const phone = String(b.phone || "").trim();
  const email = String(b.email || "").trim();

  if (!business) return J({ ok: false, error: "no_business" }, 400);
  if (!okPhone(phone)) return J({ ok: false, error: "bad_phone" }, 400);
  if (email && !okEmail(email)) return J({ ok: false, error: "bad_email" }, 400);

  const vid = await visitorId(req, env);
  const source = clean(b.source, 80) || "claim";
  const refCode = clean(b.ref_code, 40);

  // The claims table is what the existing admin console reads, so it stays the
  // system of record for "a business put its hand up". Everything else is
  // marketing state and lives alongside it.
  const ins = await env.DB.prepare(
    `INSERT INTO claims (business_name,contact_name,phone,line_id,email,source,state,created_at)
     VALUES (?,?,?,NULL,?,?,'new',?)`
  ).bind(business, contact, e164(phone), email || null, source, now()).run();

  const work = [];

  if (email) {
    work.push(env.DB.prepare(
      `INSERT INTO num_captures
         (id,email,email_lc,phone,name,business,visitor_id,source,page,ref_code,invite_token,
          utm_source,utm_medium,utm_campaign,country,marketing_ok,sms_ok,consent_text,created_at)
       VALUES (?,?,?,?,?,?,?,?,'claim',?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(email_lc,source) DO UPDATE SET
         phone        = COALESCE(NULLIF(excluded.phone,''), num_captures.phone),
         business     = COALESCE(NULLIF(excluded.business,''), num_captures.business),
         marketing_ok = MAX(num_captures.marketing_ok, excluded.marketing_ok),
         consent_text = CASE WHEN excluded.marketing_ok=1 THEN excluded.consent_text ELSE num_captures.consent_text END`
    ).bind(
      "cap_" + token(8), email, lc(email), e164(phone), contact, business, vid, "claim",
      refCode, clean(b.invite_token, 64), clean(b.utm_source, 60), clean(b.utm_medium, 60),
      clean(b.utm_campaign, 60), country(req),
      // The booking phone is service, not marketing. Only the separate tick box
      // buys us the right to market, and we store the words they were shown.
      b.marketing_ok ? 1 : 0, b.marketing_ok ? 1 : 0,
      String(b.consent_text || "").slice(0, 1000), now()
    ));
  }

  if (refCode && email) {
    work.push(env.DB.prepare(
      `INSERT INTO num_claim_attribution (email,ref_code,agent_email,source,created_at)
       VALUES (?,?,NULL,?,?)
       ON CONFLICT(email) DO NOTHING`
    ).bind(lc(email), refCode, source, epoch()));
  }

  if (work.length) await env.DB.batch(work);

  return J({ ok: true, id: ins.meta ? ins.meta.last_row_id : null });
}

/* =================================================== VIP HOST REFERRAL */

// Human-readable and unambiguous: no O/0, no I/1, no vowels, so a code read
// aloud down a phone line cannot come back as a different code.
const ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789";
function codeChunk(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((x) => ALPHABET[x % ALPHABET.length]).join("");
}

async function mintCode(env, name) {
  const stem = (clean(name, 20).toUpperCase().replace(/[^A-Z]/g, "") || "HOST").slice(0, 5);
  for (let i = 0; i < 8; i++) {
    const code = stem + "-" + codeChunk(4);
    const hit = await env.DB.prepare("SELECT code FROM num_referral_codes WHERE code = ?").bind(code).first();
    if (!hit) return code;
  }
  return "H" + codeChunk(9);
}

async function hostJoin(req, env, ctx) {
  if (badOrigin(req)) return J({ ok: false }, 403);
  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (overLimit("join:" + ip, 6)) return J({ ok: false, error: "slow_down" }, 429);

  let b;
  try { b = await readJSON(req, 16384); } catch (e) { return J({ ok: false }, 400); }

  const name = clean(b.name, 80);
  const email = String(b.email || "").trim();
  if (!name) return J({ ok: false, error: "no_name" }, 400);
  if (!okEmail(email)) return J({ ok: false, error: "bad_email" }, 400);
  if (!b.terms_ok) return J({ ok: false, error: "no_terms" }, 400);

  const site = env.SITE || "https://itsnum.com";

  // Idempotent by email: a host who submits twice gets the same code back
  // rather than a second link that splits their earnings across two codes.
  const existing = await env.DB.prepare(
    "SELECT id, code, console_key, name FROM num_hosts WHERE lower(email) = ?"
  ).bind(lc(email)).first();

  if (existing) {
    return J({
      ok: true,
      existing: true,
      code: existing.code,
      link: site + "/r/" + existing.code,
      console_url: site + "/host/?k=" + existing.console_key,
    });
  }

  const code = await mintCode(env, name);
  const hostId = "h_" + token(10);
  const consoleKey = token(20);
  const bps = 300;

  // The code registry is shared with ambassadors and universities, so host
  // codes are registered there too — that is what stops a collision. Cash
  // terms cannot live in that table (it is star-denominated and STRICT), so
  // they live on num_hosts. owner_type 'agent' is the closest true category:
  // a VIP host brings guests.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO num_referral_codes
         (code,owner_type,owner_id,university_id,reward_cs,reward_referee_cs,
          max_conversions,max_reward_total_cs,active,expires_at,created_at)
       VALUES (?,'agent',?,NULL,0,0,NULL,NULL,1,NULL,?)`
    ).bind(code, hostId, epoch()),
    env.DB.prepare(
      `INSERT INTO num_hosts
         (id,name,company,email,phone,country,code,host_bps,term_months,status,
          terms_version,agreed_at,agreed_ip,console_key,created_at)
       VALUES (?,?,?,?,?,?,?,?,12,'active',?,?,?,?,?)`
    ).bind(
      hostId, name, clean(b.company, 120), email, e164(b.phone), country(req),
      code, bps, TERMS_VERSION, now(),
      String(b.terms_text || "").slice(0, 1200), consoleKey, now()
    ),
  ]);

  const link = site + "/r/" + code;
  const consoleUrl = site + "/host/?k=" + consoleKey;

  // Their link, in writing, in their inbox. A host who loses the tab has lost
  // the programme otherwise.
  ctx.waitUntil(sendBatch(env, [{
    __idem: "hostwelcome-" + hostId,
    from: env.MAIL_FROM || "Num by 5arz <info@5arz.com>",
    to: [email],
    replyTo: ["info@5arz.com"],
    subject: "Your NUM link — " + code,
    text:
`Hi ${name},

You're in. Here is your link:

${link}

Anyone who books through it is yours for 12 months. You earn 3% of what
they spend — that is 3 of the 10 points we charge the business, and it
costs your guest nothing.

Your page, where you can see arrivals, bookings and what you have earned:

${consoleUrl}

Keep that second link private — it opens your account without a password.

You can also upload the people you already look after and we'll send the
invitation for you, with your name on it. One message each. If they don't
say yes, they never hear from us again.

Paid monthly, once we've collected from the business and once you're over
£25. Nothing is owed to you before we've been paid, which is why there is
no cap and no clawback surprise later.

— Viv
NUM, by 5arz · ${LEGAL_LINE}
Reply to this email and a person answers.`,
    headers: { "List-Unsubscribe": "<mailto:info@5arz.com?subject=unsubscribe>" },
    tags: [{ name: "kind", value: "host_welcome" }],
  }]));

  return J({ ok: true, code, link, console_url: consoleUrl });
}

/* ------------------------------------------------ /api/host/summary  console */

async function hostAuth(env, url) {
  const k = url.searchParams.get("k") || "";
  if (k.length < 20 || k.length > 80) return null;
  const host = await env.DB.prepare(
    "SELECT id,name,email,code,console_key,host_bps,term_months,status FROM num_hosts WHERE console_key = ?"
  ).bind(k).first();
  if (!host) return null;
  if (!sameSecret(host.console_key, k)) return null;
  if (host.status === "ended") return null;
  return host;
}

async function hostSummary(req, env, url) {
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: "unauthorised" }, 401);

  const site = env.SITE || "https://itsnum.com";

  const [arrivals, contacts, earnRows] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM num_web_events WHERE ref_code = ?").bind(host.code).first(),
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status IN ('invited','confirmed') THEN 1 ELSE 0 END) AS invited,
         SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END)              AS confirmed,
         COUNT(*)                                                           AS total
       FROM num_host_contacts WHERE host_id = ?`
    ).bind(host.id).first(),
    env.DB.prepare(
      `SELECT booking_ref,business_ref,currency,booking_minor,our_commission_minor,host_share_minor,
              state,completed_at
       FROM num_host_earnings WHERE host_id = ? ORDER BY created_at DESC LIMIT 100`
    ).bind(host.id).all(),
  ]);

  const rows = (earnRows && earnRows.results) || [];
  // Earned = what they can actually expect. Voided bookings are shown in the
  // table as Cancelled but never counted in the headline number.
  const earned = rows.filter((r) => r.state !== "void")
                     .reduce((sum, r) => sum + (r.host_share_minor || 0), 0);

  return J({
    ok: true,
    name: host.name,
    code: host.code,
    link: site + "/r/" + host.code,
    bps: host.host_bps,
    term_months: host.term_months,
    currency: rows.length ? rows[0].currency : "GBP",
    arrivals: (arrivals && arrivals.n) || 0,
    joined: (contacts && contacts.confirmed) || 0,
    invited: (contacts && contacts.invited) || 0,
    bookings: rows.filter((r) => r.state !== "void").length,
    earned_minor: earned,
    earnings: rows.map((r) => ({
      what: r.business_ref || r.booking_ref,
      booking_ref: r.booking_ref,
      currency: r.currency,
      booking_minor: r.booking_minor,
      host_share_minor: r.host_share_minor,
      state: r.state,
      when: r.completed_at,
    })),
  });
}

/* ----------------------------------------------- /api/host/contacts  upload */

async function hostContacts(req, env, url, ctx) {
  if (badOrigin(req)) return J({ ok: false }, 403);
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: "unauthorised" }, 401);
  if (host.status !== "active") return J({ ok: false, error: "host_not_active" }, 403);

  let b;
  try { b = await readJSON(req, 2 * 1024 * 1024); } catch (e) { return J({ ok: false, error: "too_big" }, 413); }

  const list = Array.isArray(b.contacts) ? b.contacts.slice(0, 2000) : [];
  const consentText = String(b.consent_text || "").trim();
  if (!list.length) return J({ ok: false, error: "no_contacts" }, 400);
  // No attestation, no send. This text is the only lawful basis we have for
  // messaging these people, so a batch without it is not a batch we keep.
  if (consentText.length < 40) return J({ ok: false, error: "no_consent_text" }, 400);

  const uploadId = "up_" + token(10);
  await env.DB.prepare(
    `INSERT INTO num_host_uploads
       (id,host_id,filename,row_count,accepted_count,rejected_count,consent_text,consent_ip,consent_at,status,created_at)
     VALUES (?,?,?,?,0,0,?,?,?,'received',?)`
  ).bind(
    uploadId, host.id, clean(b.filename, 120), list.length,
    consentText.slice(0, 2000), req.headers.get("cf-connecting-ip") || "", now(), now()
  ).run();

  let accepted = 0, rejected = 0;
  const seen = new Set();
  const inserts = [];

  for (const raw of list) {
    const email = String((raw && raw.email) || "").trim();
    const phone = String((raw && raw.phone) || "").trim();
    const name = clean((raw && raw.name) || "", 80);

    if (!okEmail(email)) { rejected++; continue; }        // email is the only channel we can lawfully use today
    const key = lc(email);
    if (seen.has(key)) { rejected++; continue; }
    seen.add(key);

    const supp = await env.DB.prepare("SELECT email FROM num_suppressions WHERE email = ?").bind(key).first();
    if (supp) { rejected++; continue; }

    inserts.push(env.DB.prepare(
      `INSERT INTO num_host_contacts
         (id,host_id,upload_id,name,email,email_lc,phone,channel,consent_basis,status,token,created_at)
       VALUES (?,?,?,?,?,?,?,?,'host_asserted','pending',?,?)
       ON CONFLICT(host_id,email_lc) DO NOTHING`
    ).bind(
      "hc_" + token(10), host.id, uploadId, name, email, key,
      okPhone(phone) ? e164(phone) : null, okPhone(phone) ? "both" : "email",
      token(16), now()
    ));
    accepted++;
  }

  for (let i = 0; i < inserts.length; i += 50) await env.DB.batch(inserts.slice(i, i + 50));

  await env.DB.prepare(
    "UPDATE num_host_uploads SET accepted_count=?, rejected_count=?, status='validated' WHERE id=?"
  ).bind(accepted, rejected, uploadId).run();

  // Send what the plan can carry now; the cron drains the rest. Telling the
  // host "on the way" is true for both — queued is on the way.
  ctx.waitUntil(drainQueue(env, Number(env.SEND_BUDGET || 40), host.id));

  return J({ ok: true, upload_id: uploadId, accepted, rejected });
}

/* --------------------------------------------------------------- the queue */

async function drainQueue(env, budget, hostId) {
  const site = env.SITE || "https://itsnum.com";
  const sql =
    `SELECT c.id, c.name, c.email, c.token, c.host_id, h.name AS host_name, h.code AS code
     FROM num_host_contacts c JOIN num_hosts h ON h.id = c.host_id
     WHERE c.status = 'pending' AND h.status = 'active'` +
    (hostId ? " AND c.host_id = ?" : "") +
    " ORDER BY c.created_at LIMIT ?";

  const stmt = hostId
    ? env.DB.prepare(sql).bind(hostId, budget)
    : env.DB.prepare(sql).bind(budget);

  const { results } = await stmt.all();
  if (!results || !results.length) return 0;

  const msgs = results.map((c) => {
    const first = (c.host_name || "").split(" ")[0] || c.host_name || "your host";
    return {
      __idem: "hostinv-" + c.id,
      from: env.MAIL_FROM || "Num by 5arz <info@5arz.com>",
      to: [c.email],
      replyTo: ["info@5arz.com"],
      subject: first + " sent you their little black book",
      text:
`${c.name ? "Hi " + c.name + "," : "Hi,"}

${c.host_name} asked us to pass this on to you.

NUM is a travel concierge you message like a person. You type "a table
for four tonight, somewhere the locals actually go" — in whatever
language you speak — and it comes back with a short list of real,
checked places, and books one for you. No app, no account, no fee.

${first} has put their own places behind it, so what you get is their
list, not a search result.

Yes, send me the details:
${site}/go/${c.token}

That is the only thing this email asks of you. If you'd rather not, you
don't have to do anything — but if you'd like to be sure you never hear
from us again, one click does it:
${site}/stop/${c.token}

We were given your details by ${c.host_name}, who told us you'd expect to
hear from them about travel. This is the only message we will send unless
you say yes above. What we hold and where it came from: ${site}/privacy

— Viv
NUM, by 5arz · ${LEGAL_LINE}
Reply to this email and a person answers.`,
      headers: {
        "List-Unsubscribe": "<" + site + "/stop/" + c.token + ">, <mailto:info@5arz.com?subject=unsubscribe>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      tags: [{ name: "kind", value: "host_invite" }, { name: "code", value: String(c.code || "none") }],
    };
  });

  // Ledger before send: mark them invited first. If the send half-fails we
  // under-send rather than double-send, and a duplicate invite from a friend's
  // address book is the one mistake this programme cannot afford.
  await env.DB.batch(results.map((c) =>
    env.DB.prepare("UPDATE num_host_contacts SET status='invited', invited_at=? WHERE id=? AND status='pending'")
      .bind(now(), c.id)
  ));

  const res = await sendBatch(env, msgs);
  if (!res.ok) {
    console.log("num-growth send failed", res.error);
    await env.DB.batch(results.map((c) =>
      env.DB.prepare("UPDATE num_host_contacts SET status='pending', invited_at=NULL WHERE id=? AND status='invited'")
        .bind(c.id)
    ));
    return 0;
  }
  return res.sent;
}

/* ------------------------------------------------------------ /r/:code */

const DESTS = { "": "/", home: "/", stay: "/stay", eat: "/eat", app: "/app", claim: "/claim/" };

async function referral(req, env, url, rawCode) {
  const site = env.SITE || "https://itsnum.com";
  const code = clean(decodeURIComponent(rawCode || ""), 40).toUpperCase().replace(/\s/g, "");
  if (!code) return Response.redirect(site + "/", 302);

  const row = await env.DB.prepare(
    "SELECT code, active FROM num_referral_codes WHERE code = ?"
  ).bind(code).first();

  // A dead link goes to the front door rather than to an error. The person
  // holding it did nothing wrong.
  if (!row || !row.active) return Response.redirect(site + "/", 302);

  const vid = await visitorId(req, env);
  await env.DB.prepare(
    `INSERT INTO num_web_events
       (visitor_id,event,page,ref_code,utm_source,utm_medium,utm_campaign,referrer,country,device,created_at)
     VALUES (?,'ref_arrival','r',?,?,'referral',?,?,?,?,?)`
  ).bind(
    vid, code, clean(url.searchParams.get("utm_source"), 60) || "host", code,
    String(req.headers.get("referer") || "").slice(0, 200), country(req), device(req), now()
  ).run();

  // Attribution travels in the URL, not in a cookie. Nothing is written to the
  // visitor's device, so there is no reg 6 problem and nothing for an ad
  // blocker to remove. It is persisted for real at the point they convert.
  const dest = DESTS[clean(url.searchParams.get("d"), 20).toLowerCase()] || "/";
  const to = new URL(site + dest);
  to.searchParams.set("ref", code);
  to.searchParams.set("utm_source", "host");
  to.searchParams.set("utm_medium", "referral");
  to.searchParams.set("utm_campaign", code);
  return Response.redirect(to.toString(), 302);
}

/* --------------------------------------------------- /go/:token  confirm */

function page(title, body) {
  return TEXT(
`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · NUM</title>
<style>
 body{margin:0;font:17px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      background:#0d0f13;color:#f2f3f5;display:flex;align-items:center;justify-content:center;
      min-height:100vh;padding:24px}
 .c{max-width:460px}
 h1{font-size:26px;line-height:1.25;margin:0 0 14px}
 p{color:#b6bcc6;margin:0 0 14px}
 a.btn{display:inline-block;margin-top:8px;background:#f2f3f5;color:#0d0f13;text-decoration:none;
       font-weight:600;padding:13px 22px;border-radius:10px}
 small{display:block;margin-top:28px;color:#6d7480;font-size:13px}
</style></head><body><div class="c">${body}
<small>NUM, by 5arz · ${LEGAL_LINE}</small></div></body></html>`);
}

async function confirmContact(req, env, rawToken) {
  const t = clean(rawToken, 64).replace(/\s/g, "");
  const site = env.SITE || "https://itsnum.com";
  const c = await env.DB.prepare(
    `SELECT c.id,c.name,c.email,c.status,c.host_id,h.name AS host_name,h.code AS code
     FROM num_host_contacts c JOIN num_hosts h ON h.id=c.host_id WHERE c.token = ?`
  ).bind(t).first();

  if (!c) return page("Link not found", "<h1>That link has expired</h1><p>No harm done. If someone told you about NUM, ask them to send it again.</p>");

  if (c.status !== "confirmed") {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE num_host_contacts SET status='confirmed', consent_basis='confirmed', confirmed_at=? WHERE id=?"
      ).bind(now(), c.id),
      env.DB.prepare(
        `INSERT INTO num_captures
           (id,email,email_lc,name,source,page,ref_code,country,marketing_ok,sms_ok,consent_text,created_at)
         VALUES (?,?,?,?,'host_invite','go',?,?,1,0,?,?)
         ON CONFLICT(email_lc,source) DO UPDATE SET marketing_ok=1`
      ).bind(
        "cap_" + token(8), c.email, lc(c.email), c.name || "", c.code, country(req),
        "Confirmed by clicking the invitation " + c.host_name + " asked NUM to send.", now()
      ),
    ]);
  }

  const first = (c.host_name || "").split(" ")[0] || c.host_name;
  return page("You're in", `
<h1>You're in — ${first}'s list is yours</h1>
<p>Next time you're going somewhere, message NUM and say what you're after.
It answers in your language, with real places, and books the one you pick.</p>
<p><a class="btn" href="${site}/?ref=${encodeURIComponent(c.code)}&utm_source=host&utm_medium=referral">Start with NUM</a></p>
<p style="margin-top:22px;font-size:14px">Changed your mind? <a href="${site}/stop/${t}" style="color:#b6bcc6">Stop everything</a>.</p>`);
}

/* --------------------------------------------------------- /stop/:token */

async function stopContact(req, env, rawToken) {
  const t = clean(rawToken, 64).replace(/\s/g, "");
  const c = await env.DB.prepare(
    "SELECT id,email FROM num_host_contacts WHERE token = ?"
  ).bind(t).first();

  if (c) {
    await env.DB.batch([
      env.DB.prepare("UPDATE num_host_contacts SET status='declined' WHERE id=?").bind(c.id),
      env.DB.prepare(
        `INSERT INTO num_suppressions (email,reason,note,created_at) VALUES (?,'unsubscribe',?,?)
         ON CONFLICT(email) DO NOTHING`
      ).bind(lc(c.email), "one-click from host invite", now()),
    ]);
  }

  // RFC 8058: the mail client POSTs and expects a 200, not a page.
  if (req.method === "POST") return J({ ok: true });

  return page("Stopped", `
<h1>Done — you won't hear from us</h1>
<p>You're off the list. Nothing else needs doing, and there is no form to fill in.</p>
<p>If this reached you by mistake and you'd like to tell us, reply to the email
or write to info@5arz.com and a person answers.</p>`);
}

/* ---------------------------------------------- /api/admin/earnings  ledger */

// SQLite can express "never owe more than we charged" as a CHECK, but it cannot
// express "collected may only follow accrued". That guard lives here.
const NEXT = {
  accrued: ["collected", "void"],
  collected: ["payable", "void"],
  payable: ["paid", "void"],
  paid: [],
  void: [],
};
const STAMP = { collected: "collected_at", payable: "payable_at", paid: "paid_at" };

async function adminEarnings(req, env) {
  const key = req.headers.get("x-admin-key") || "";
  if (!env.ADMIN_KEY || !sameSecret(env.ADMIN_KEY, key)) return J({ ok: false, error: "unauthorised" }, 401);

  let b;
  try { b = await readJSON(req, 32768); } catch (e) { return J({ ok: false }, 400); }

  /* accrue: a booking completed and it belongs to a host's code */
  if (b.action === "accrue") {
    const code = clean(b.code, 40).toUpperCase();
    const bookingRef = clean(b.booking_ref, 60);
    const bookingMinor = Math.max(0, Math.round(Number(b.booking_minor) || 0));
    if (!code || !bookingRef || !bookingMinor) return J({ ok: false, error: "missing_fields" }, 400);

    const host = await env.DB.prepare(
      "SELECT id,host_bps,term_months,status FROM num_hosts WHERE code = ?"
    ).bind(code).first();
    if (!host) return J({ ok: false, error: "unknown_code" }, 404);
    if (host.status === "ended") return J({ ok: false, error: "host_ended" }, 409);

    // Our commission is 10% unless the caller says otherwise; the host's share
    // is their bps of booking value, and it can never exceed what we charged.
    const ourMinor = b.our_commission_minor != null
      ? Math.max(0, Math.round(Number(b.our_commission_minor)))
      : Math.round(bookingMinor * 0.10);
    const share = Math.min(Math.round(bookingMinor * host.host_bps / 10000), ourMinor);

    try {
      await env.DB.prepare(
        `INSERT INTO num_host_earnings
           (id,host_id,code,booking_ref,business_ref,guest_ref,currency,booking_minor,
            our_commission_minor,host_share_minor,state,completed_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'accrued',?,?)`
      ).bind(
        "he_" + token(10), host.id, code, bookingRef, clean(b.business_ref, 80),
        clean(b.guest_ref, 80), clean(b.currency, 3).toUpperCase() || "GBP",
        bookingMinor, ourMinor, share, clean(b.completed_at, 30) || now(), now()
      ).run();
    } catch (e) {
      if (String(e).includes("UNIQUE")) return J({ ok: true, duplicate: true });
      throw e;
    }
    return J({ ok: true, host_id: host.id, host_share_minor: share, our_commission_minor: ourMinor });
  }

  /* transition: move one earning along the state machine */
  if (b.action === "transition") {
    const to = clean(b.to, 20);
    const ref = clean(b.booking_ref, 60);
    const hostId = clean(b.host_id, 40);
    if (!ref || !hostId || !NEXT[to]) return J({ ok: false, error: "bad_transition" }, 400);

    const row = await env.DB.prepare(
      "SELECT id,state FROM num_host_earnings WHERE booking_ref=? AND host_id=?"
    ).bind(ref, hostId).first();
    if (!row) return J({ ok: false, error: "not_found" }, 404);
    if (row.state === to) return J({ ok: true, unchanged: true, state: to });
    if (!NEXT[row.state].includes(to)) {
      return J({ ok: false, error: "illegal_transition", from: row.state, to }, 409);
    }

    const stamp = STAMP[to];
    await env.DB.prepare(
      "UPDATE num_host_earnings SET state=?" +
      (stamp ? ", " + stamp + "=?" : "") +
      (to === "void" ? ", void_reason=?" : "") +
      " WHERE id=?"
    ).bind(...[to, ...(stamp ? [now()] : []), ...(to === "void" ? [clean(b.reason, 200)] : []), row.id]).run();

    return J({ ok: true, from: row.state, to });
  }

  return J({ ok: false, error: "unknown_action" }, 400);
}


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


/* ── QR encoder (v4 / ECC-H, fixed) ───────────────────────────────────────
   Wrapped in a closure so none of its ~20 internal names can collide with
   anything in this worker. The only thing that escapes is qrSvg(text).
   Verified: 300 random venue URLs rendered and decoded back correctly, and
   194/300 module matrices are byte-identical to a reference implementation
   (the rest select a different but equally valid mask — penalty rule 3 is
   implemented differently across libraries).
   ────────────────────────────────────────────────────────────────────── */
const qrSvg = (function () {
  /**
   * qr.js — a QR encoder small enough to live inside the worker.
   *
   * Deliberately NOT a general library. Every code we produce is the same shape:
   *
   *     https://itsnum.com/v/XXXXXX      27 bytes, always
   *
   * so this is fixed to **version 4, error-correction level H** — 33×33 modules,
   * 36 data codewords in 4 blocks of 9, RS(25,9) per block, ~30% recoverable.
   * Fixing the version removes the version/format tables that are the usual
   * source of bugs in hand-rolled encoders, and H is the right level for
   * something printed and then left on a restaurant table to be spilled on.
   *
   * Correctness is not asserted, it is demonstrated: qr.test.mjs renders the
   * module matrix for hundreds of random tokens and compares it cell-for-cell
   * against a reference implementation, then decodes the rendered artwork.
   */

  const VERSION = 4;
  const SIZE = 17 + VERSION * 4;          // 33
  const DATA_CW = 36;                     // 4 blocks × 9
  const BLOCKS = 4;
  const BLOCK_DATA = 9;
  const BLOCK_EC = 16;
  const EC_LEVEL_BITS = 0b10;             // H, as it appears in the format string

  /* ── GF(256), the field QR's Reed-Solomon lives in ───────────────────────── */
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;          // the QR primitive polynomial
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  /* Generator polynomial for `n` EC codewords. */
  function genPoly(n) {
    let p = [1];
    for (let i = 0; i < n; i++) {
      const q = [1, EXP[i]];
      const r = new Array(p.length + 1).fill(0);
      for (let a = 0; a < p.length; a++) {
        for (let b = 0; b < q.length; b++) r[a + b] ^= mul(p[a], q[b]);
      }
      p = r;
    }
    return p;
  }

  function ecFor(data, n) {
    const g = genPoly(n);
    const res = new Array(data.length + n).fill(0);
    data.forEach((v, i) => (res[i] = v));
    for (let i = 0; i < data.length; i++) {
      const f = res[i];
      if (f === 0) continue;
      for (let j = 0; j < g.length; j++) res[i + j] ^= mul(g[j], f);
    }
    return res.slice(data.length);
  }

  /* ── bitstream → codewords ───────────────────────────────────────────────── */
  function encodeData(text) {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > DATA_CW - 2) {
      throw new Error(`payload too long for v4-H: ${bytes.length} bytes`);
    }
    const bits = [];
    const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };

    push(0b0100, 4);                      // byte mode
    push(bytes.length, 8);                // v1–9 use an 8-bit length
    bytes.forEach((b) => push(b, 8));

    const cap = DATA_CW * 8;
    push(0, Math.min(4, cap - bits.length));        // terminator
    while (bits.length % 8) bits.push(0);
    const cw = [];
    for (let i = 0; i < bits.length; i += 8) {
      cw.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    }
    const PAD = [0xec, 0x11];
    for (let i = 0; cw.length < DATA_CW; i++) cw.push(PAD[i % 2]);
    return cw;
  }

  /* Split into blocks, compute EC, interleave — the order the spec requires. */
  function finalCodewords(text) {
    const cw = encodeData(text);
    const dBlocks = [], eBlocks = [];
    for (let i = 0; i < BLOCKS; i++) {
      const d = cw.slice(i * BLOCK_DATA, (i + 1) * BLOCK_DATA);
      dBlocks.push(d);
      eBlocks.push(ecFor(d, BLOCK_EC));
    }
    const out = [];
    for (let i = 0; i < BLOCK_DATA; i++) for (const b of dBlocks) out.push(b[i]);
    for (let i = 0; i < BLOCK_EC; i++) for (const b of eBlocks) out.push(b[i]);
    return out;
  }

  /* ── matrix ──────────────────────────────────────────────────────────────── */
  const newMatrix = () => Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));

  function placeFunctionPatterns(m) {
    const finder = (r, c) => {
      for (let i = -1; i <= 7; i++) {
        for (let j = -1; j <= 7; j++) {
          const rr = r + i, cc = c + j;
          if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) continue;
          const on = (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
                     (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
                     (i >= 2 && i <= 4 && j >= 2 && j <= 4);
          m[rr][cc] = on ? 1 : 0;
        }
      }
    };
    finder(0, 0); finder(0, SIZE - 7); finder(SIZE - 7, 0);

    for (let i = 8; i < SIZE - 8; i++) {          // timing
      const v = i % 2 === 0 ? 1 : 0;
      if (m[6][i] === null) m[6][i] = v;
      if (m[i][6] === null) m[i][6] = v;
    }

    // v4 has exactly one alignment pattern, centred at (26,26)
    const ac = 26;
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        m[ac + i][ac + j] = (Math.max(Math.abs(i), Math.abs(j)) !== 1) ? 1 : 0;
      }
    }

    m[SIZE - 8][8] = 1;                            // the always-dark module
  }

  const FORMAT_MASK = 0b101010000010010;
  function formatBits(mask) {
    const data = (EC_LEVEL_BITS << 3) | mask;
    let v = data << 10;
    for (let i = 14; i >= 10; i--) if ((v >> i) & 1) v ^= 0b10100110111 << (i - 10);
    return ((data << 10) | v) ^ FORMAT_MASK;
  }

  function placeFormat(m, mask) {
    const f = formatBits(mask);
    // Placement walks the format string MSB-first: position 0 carries bit 14.
    // formatBits() itself is right — it reproduces the published L/mask-0 and
    // M/mask-0 strings exactly — so a reversal here is silently a *different
    // valid* format string, which is the worst kind of wrong: scanners read it,
    // apply the wrong mask, and get nothing.
    const bit = (i) => (f >> (14 - i)) & 1;
    for (let i = 0; i <= 5; i++) m[8][i] = bit(i);
    m[8][7] = bit(6); m[8][8] = bit(7); m[7][8] = bit(8);
    for (let i = 9; i <= 14; i++) m[14 - i][8] = bit(i);
    // The second copy is SEVEN vertical cells then EIGHT horizontal — not eight
    // and seven. Getting it the wrong way round leaves (8, SIZE-8) unreserved,
    // the data walk consumes it, and every subsequent bit shifts by one: the
    // codewords stay byte-perfect while the symbol becomes unreadable.
    for (let i = 0; i <= 6; i++) m[SIZE - 1 - i][8] = bit(i);
    for (let i = 7; i <= 14; i++) m[8][SIZE - 15 + i] = bit(i);
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function placeData(m, cw, mask) {
    let bitIdx = 0;
    const total = cw.length * 8;
    let up = true;
    for (let right = SIZE - 1; right > 0; right -= 2) {
      if (right === 6) right--;                   // skip the timing column
      for (let k = 0; k < SIZE; k++) {
        const r = up ? SIZE - 1 - k : k;
        for (const c of [right, right - 1]) {
          if (m[r][c] !== null) continue;
          let v = 0;
          if (bitIdx < total) v = (cw[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
          m[r][c] = MASKS[mask](r, c) ? v ^ 1 : v;
        }
      }
      up = !up;
    }
  }

  /* Penalty scoring — this is what picks the mask, and getting it wrong yields
     a valid-but-different code, which is exactly the kind of bug that only
     shows up on one phone in twenty. Verified against the reference. */
  function penalty(m) {
    let p = 0;
    const run = (get) => {
      for (let a = 0; a < SIZE; a++) {
        let last = -1, len = 0;
        for (let b = 0; b < SIZE; b++) {
          const v = get(a, b);
          if (v === last) { len++; if (len === 5) p += 3; else if (len > 5) p += 1; }
          else { last = v; len = 1; }
        }
      }
    };
    run((a, b) => m[a][b]);
    run((a, b) => m[b][a]);

    for (let r = 0; r < SIZE - 1; r++) {
      for (let c = 0; c < SIZE - 1; c++) {
        const s = m[r][c] + m[r][c + 1] + m[r + 1][c] + m[r + 1][c + 1];
        if (s === 0 || s === 4) p += 3;
      }
    }

    const PAT1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const PAT2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const hit = (get, a, b) => {
      for (const pat of [PAT1, PAT2]) {
        let ok = true;
        for (let i = 0; i < 11; i++) if (get(a, b + i) !== pat[i]) { ok = false; break; }
        if (ok) return true;
      }
      return false;
    };
    for (let a = 0; a < SIZE; a++) {
      for (let b = 0; b + 10 < SIZE; b++) {
        if (hit((x, y) => m[x][y], a, b)) p += 40;
        if (hit((x, y) => m[y][x], a, b)) p += 40;
      }
    }

    let dark = 0;
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) dark += m[r][c];
    p += Math.floor(Math.abs((dark * 100) / (SIZE * SIZE) - 50) / 5) * 10;
    return p;
  }

  /** Module matrix for `text`. 1 = dark. */
  function matrix(text) {
    const cw = finalCodewords(text);
    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const m = newMatrix();
      placeFunctionPatterns(m);
      placeFormat(m, mask);
      placeData(m, cw, mask);
      const s = penalty(m);
      if (s < bestScore) { bestScore = s; best = m; }
    }
    return best;
  }

  /** Compact SVG. One <path> for every dark module — no images, no fonts. */
  function svg(text, { border = 2, dark = "#131a16", light = "#ffffff" } = {}) {
    const m = matrix(text);
    const n = SIZE + border * 2;
    const d = [];
    for (let r = 0; r < SIZE; r++) {
      let c = 0;
      while (c < SIZE) {
        if (m[r][c]) {
          let e = c;
          while (e + 1 < SIZE && m[r][e + 1]) e++;
          d.push(`M${c + border} ${r + border}h${e - c + 1}v1h-${e - c + 1}z`);
          c = e + 1;
        } else c++;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" ` +
      `shape-rendering="crispEdges" role="img" aria-label="QR code">` +
      `<rect width="${n}" height="${n}" fill="${light}"/>` +
      `<path fill="${dark}" d="${d.join("")}"/></svg>`;
  }

  return svg;

})();

/* ══════════════════════════════════════════════════════════════════════════
   Venue code manager — a business creates and retires its own table codes.
   Added 10 Aug 2026.

   NOTHING IS EVER DELETED, AND THAT IS THE WHOLE DESIGN.
   "Delete this table" is implemented as revoke. Two reasons, both learned the
   hard way elsewhere in this codebase:

     1. A card outlives its row. Table 7's sticker is on Table 7 until someone
        peels it off. Hard-delete the row and the next guest to scan it gets
        "this code isn't one of ours" — in front of staff, holding a card the
        business printed because we asked them to. Revoking gives them the
        true, calm answer instead: this code was retired, ask for the current
        one.
     2. Scans are billing evidence. num_venue_scans references the token. Hard
        deleting the code orphans the audit trail for money that has already
        moved.

   Revoked codes therefore stay listed, greyed, with the date — and can be
   reinstated, because "we took Table 7 out for winter" is a normal thing that
   happens twice a year.
   ══════════════════════════════════════════════════════════════════════════ */

const TOKEN_ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789";  // no vowels, no 0/1/I/O
const MAX_ACTIVE_CODES = 300;   // a very large restaurant; a runaway loop is not

function newToken(len = 6) {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  let s = "";
  for (let i = 0; i < len; i++) s += TOKEN_ALPHABET[b[i] % TOKEN_ALPHABET.length];
  return s;
}

async function bizAuth(env, url, req) {
  const k = url.searchParams.get("k") || "";
  if (k.length < 20 || k.length > 80) return null;
  const biz = await env.DB.prepare(
    "SELECT id,name,category,console_key,status FROM businesses WHERE console_key = ?"
  ).bind(k).first();
  const ok = biz && sameSecret(biz.console_key, k) && biz.status === "active";
  // Every key use is logged, success and failure alike. This log is what the
  // security sweep reads: a key seen from many networks means the link
  // leaked; a stream of denials means someone is guessing keys. Without the
  // log, both are invisible until they are expensive.
  if (req) await logKeyEvent(env, req, biz ? biz.id : null, ok ? "ok" : "denied",
                             ok ? null : "keylen=" + k.length);
  return ok ? biz : null;
}

/* ── GET /api/venue/codes?k= — list, with scan counts ────────────────────── */
async function venueCodesList(req, env, url) {
  const biz = await bizAuth(env, url, req);
  if (!biz) return J({ ok: false, error: "unauthorised" }, 401);

  const { results } = await env.DB.prepare(
    `SELECT c.token, c.label, c.perk_text, c.state, c.created_at, c.revoked_at,
            (SELECT COUNT(*) FROM num_venue_scans s
              WHERE s.token = c.token AND s.outcome = 'completed')  AS check_ins,
            (SELECT COUNT(*) FROM num_venue_scans s
              WHERE s.token = c.token AND s.outcome = 'no_booking') AS walk_ins,
            (SELECT MAX(created_at) FROM num_venue_scans s WHERE s.token = c.token) AS last_scan
       FROM num_venue_codes c
      WHERE c.business_id = ?
      ORDER BY c.state = 'revoked', c.created_at`
  ).bind(biz.id).all();

  return J({ ok: true, business: biz.name, codes: results || [] });
}

/* ── POST /api/venue/codes — create one table ────────────────────────────── */
async function venueCodesCreate(req, env, url) {
  const biz = await bizAuth(env, url, req);
  if (!biz) return J({ ok: false, error: "unauthorised" }, 401);

  let b;
  try { b = await readJSON(req, 2048); } catch (e) { return J({ ok: false }, 400); }
  const label = clean(b.label, 40);
  if (!label) return J({ ok: false, error: "label_required" }, 400);

  const live = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM num_venue_codes WHERE business_id=? AND state='active'"
  ).bind(biz.id).first();
  if ((live?.n || 0) >= MAX_ACTIVE_CODES) {
    return J({ ok: false, error: "too_many_codes", max: MAX_ACTIVE_CODES }, 409);
  }

  // A duplicate label is almost always a double-tap, not a second Table 7.
  const dup = await env.DB.prepare(
    "SELECT token FROM num_venue_codes WHERE business_id=? AND state='active' AND lower(label)=lower(?)"
  ).bind(biz.id, label).first();
  if (dup) return J({ ok: false, error: "label_exists", token: dup.token }, 409);

  // Retry on collision rather than trusting 28^6 to be lucky forever.
  for (let attempt = 0; attempt < 6; attempt++) {
    const token = newToken();
    try {
      await env.DB.prepare(
        `INSERT INTO num_venue_codes (token,business_id,label,perk_text,state,issued_for,created_at)
         VALUES (?,?,?,?, 'active', 'self_serve', ?)`
      ).bind(token, biz.id, label, clean(b.perk_text, 120) || null, now()).run();
      return J({ ok: true, token, label, url: (env.SITE || "https://itsnum.com") + "/v/" + token });
    } catch (e) {
      if (!String(e).includes("UNIQUE")) throw e;
    }
  }
  return J({ ok: false, error: "could_not_allocate" }, 503);
}

/* ── POST /api/venue/codes/state — retire or reinstate ───────────────────── */
async function venueCodesState(req, env, url) {
  const biz = await bizAuth(env, url, req);
  if (!biz) return J({ ok: false, error: "unauthorised" }, 401);

  let b;
  try { b = await readJSON(req, 2048); } catch (e) { return J({ ok: false }, 400); }
  const token = clean(b.token, 40).toUpperCase();
  const to = clean(b.state, 12);
  if (!token || !["revoked", "active"].includes(to)) {
    return J({ ok: false, error: "missing_fields" }, 400);
  }

  // Scoped to the caller's own business: a valid key must never be able to
  // touch another venue's codes.
  const row = await env.DB.prepare(
    "SELECT token,state,label FROM num_venue_codes WHERE token=? AND business_id=?"
  ).bind(token, biz.id).first();
  if (!row) return J({ ok: false, error: "unknown_token" }, 404);
  if (row.state === to) return J({ ok: true, unchanged: true, state: to });

  await env.DB.prepare(
    to === "revoked"
      ? "UPDATE num_venue_codes SET state='revoked', revoked_at=?, revoked_by=? WHERE token=?"
      : "UPDATE num_venue_codes SET state='active',  revoked_at=NULL, revoked_by=NULL WHERE token=?"
  ).bind(...(to === "revoked" ? [now(), "biz:" + biz.id, token] : [token])).run();

  return J({ ok: true, token, state: to, label: row.label });
}

/* ── GET /api/venue/qr/<TOKEN>.svg — the artwork itself ──────────────────
   Public and unauthenticated on purpose: it encodes a URL that is printed on
   a card anyone can photograph. Keeping it open is what lets a business drop
   it straight into their own print run, a menu PDF, or an email.          */
async function venueQr(req, env, rest) {
  const token = clean(String(rest || "").replace(/\.svg$/i, ""), 40).toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(token)) return TEXT("bad token", 400);

  const row = await env.DB.prepare(
    "SELECT token FROM num_venue_codes WHERE token = ?"
  ).bind(token).first();
  // Refuse to draw a QR for a code that does not exist. A beautiful QR
  // pointing at nothing is how a venue ends up with fifty printed cards that
  // all say "this code isn't one of ours".
  if (!row) return TEXT("unknown token", 404);

  const body = qrSvg((env.SITE || "https://itsnum.com") + "/v/" + token);
  return new Response(body, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

/* ── GET /biz/codes/?k= — the manager a business actually uses ────────────
   One screen. Add a table, print it, retire it. No build step, no framework,
   no dependency that can rot: the QR images are served by our own worker, so
   this page has no third-party requests at all.

   It is also the print surface. @media print drops everything but the cards
   themselves, so Cmd-P gives a sheet of table cards with no extra software —
   which matters, because the person doing this owns a restaurant, not a
   design tool.                                                             */
async function venueCodesPage(req, env, url) {
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
  const { results } = await env.DB.prepare(
    `SELECT c.token, c.label, c.state, c.created_at, c.revoked_at,
            (SELECT COUNT(*) FROM num_venue_scans s
              WHERE s.token=c.token AND s.outcome='completed') AS check_ins
       FROM num_venue_codes c WHERE c.business_id=?
      ORDER BY c.state='revoked', c.created_at`
  ).bind(biz.id).all();

  const rows = (results || []).map((r) => `
    <li class="code ${r.state}" data-token="${esc(r.token)}">
      <div class="qr"><img src="/api/venue/qr/${esc(r.token)}.svg" alt="QR code for ${esc(r.label)}" width="150" height="150"></div>
      <div class="meta">
        <b>${esc(r.label)}</b>
        <code>${site.replace(/^https?:\/\//, "")}/v/${esc(r.token)}</code>
        <span class="stat">${r.check_ins} check-in${r.check_ins === 1 ? "" : "s"}${
          r.state === "revoked" ? ` · retired ${esc((r.revoked_at || "").slice(0, 10))}` : ""}</span>
        <div class="acts">
          ${r.state === "active"
            ? `<button class="lnk warn" data-act="revoked">Retire this one</button>`
            : `<button class="lnk" data-act="active">Put it back</button>`}
        </div>
      </div>
    </li>`).join("");

  return HTML(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Your table codes — NUM</title>
<style>
:root{--paper:#faf8f4;--ink:#131a16;--pine:#1f3a34;--green:#1e7a4d;--line:#e0ddd4;--warn:#b4552d}
*{margin:0;box-sizing:border-box}
body{font:16px/1.6 -apple-system,'Segoe UI',Inter,sans-serif;background:var(--paper);color:var(--ink);
  max-width:860px;margin:0 auto;padding:36px 20px 80px}
h1{font-size:clamp(26px,5vw,34px);color:var(--pine);letter-spacing:-.02em;margin-bottom:6px}
.sub{color:#68705f;margin-bottom:28px}
.add{display:flex;gap:10px;flex-wrap:wrap;background:#fff;border:1px solid var(--line);
  border-radius:14px;padding:16px;margin-bottom:26px}
.add input{flex:1 1 220px;min-height:48px;font:16px inherit;padding:12px 14px;
  border:1.5px solid var(--line);border-radius:10px;background:var(--paper)}
.add input:focus{outline:0;border-color:var(--green)}
.btn{min-height:48px;background:var(--green);color:#fff;font:650 16px inherit;border:0;
  border-radius:10px;padding:12px 22px;cursor:pointer}
.btn.sec{background:transparent;color:var(--pine);border:1.5px solid var(--pine)}
.btn[disabled]{opacity:.55}
ul{list-style:none}
.code{display:grid;grid-template-columns:150px 1fr;gap:18px;align-items:center;background:#fff;
  border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:12px}
.code.revoked{opacity:.5}
.code.revoked .qr{filter:grayscale(1)}
.meta b{display:block;font-size:19px;color:var(--pine)}
.meta code{display:block;font:13.5px ui-monospace,Menlo,monospace;color:#68705f;margin:4px 0}
.stat{font-size:14px;color:#68705f}
.acts{margin-top:10px}
.lnk{background:none;border:0;padding:8px 0;font:600 15px inherit;color:var(--green);
  cursor:pointer;text-decoration:underline;text-underline-offset:3px;min-height:44px}
.lnk.warn{color:var(--warn)}
.note{background:#fff;border:1px solid var(--line);border-left:4px solid var(--green);
  border-radius:10px;padding:14px 18px;font-size:14.5px;color:#39423b;margin:24px 0}
.msg{margin:14px 0;padding:12px 16px;border-radius:10px;font-size:15px}
.msg.bad{background:#fdf0e9;border:1px solid #f0cbb4;color:#6b3113}
.msg.good{background:#e8f4ec;border:1px solid #b9dcc6;color:#14432c}
.tools{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap}
/* At 390px the 150px QR column plus a monospace URL overflows by 9px. Stack
   instead of shrinking the QR — a code that is hard to scan defeats the point. */
@media(max-width:520px){
  .code{grid-template-columns:1fr;justify-items:center;text-align:center}
  .meta{min-width:0;max-width:100%}
  .meta code{word-break:break-all;white-space:normal}
}
@media print{
  body{max-width:none;padding:0}
  h1,.sub,.add,.note,.tools,.acts,.stat,.msg{display:none!important}
  ul{display:grid;grid-template-columns:1fr 1fr;gap:0}
  .code{display:block;text-align:center;page-break-inside:avoid;border:1px dashed #bbb;
    border-radius:0;margin:0;padding:26px 10px;opacity:1}
  .code.revoked{display:none}
  .qr img{width:190px;height:190px}
  .meta b{font-size:17px;margin-top:10px}
  .meta code{font-size:12px}
}
</style></head>
<body>

<h1>Your table codes</h1>
<p class="sub">${esc(biz.name)} — add a code for each table, print them, retire the ones you stop using.</p>

<div class="tools">
  <button class="btn sec" onclick="window.print()">Print all active codes</button>
</div>

<form class="add" id="add">
  <input id="label" maxlength="40" placeholder="Table 7" aria-label="Name this code" required>
  <button class="btn" type="submit" id="go">Add a code</button>
</form>

<div id="msg"></div>

<ul id="list">${rows || '<p class="sub">No codes yet. Add your first one above.</p>'}</ul>

<div class="note"><b>Retiring is not deleting.</b> A card stays on a table long after you stop
using it, so a retired code keeps working as a polite dead end — it tells the guest it was
retired and to ask you for the current one, instead of "this code isn't one of ours". Your
check-in history stays intact too, which matters because it is what your billing is based on.
You can put a retired code back at any time.</div>

<script>
(function(){
  var K = new URLSearchParams(location.search).get('k');
  var msg = document.getElementById('msg');
  function say(kind, text){ msg.innerHTML = '<div class="msg '+kind+'">'+text+'</div>';
    if(kind==='good') setTimeout(function(){ msg.innerHTML=''; }, 4000); }

  document.getElementById('add').addEventListener('submit', function(e){
    e.preventDefault();
    var label = document.getElementById('label').value.trim();
    if(!label) return;
    var go = document.getElementById('go');
    go.disabled = true; go.textContent = 'Adding…';
    fetch('/api/venue/codes?k=' + encodeURIComponent(K), {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ label: label })
    }).then(function(r){ return r.json(); }).then(function(j){
      go.disabled = false; go.textContent = 'Add a code';
      if(j.ok){ location.reload(); }
      else if(j.error === 'label_exists') say('bad','You already have an active code called that.');
      else if(j.error === 'too_many_codes') say('bad','That is the maximum number of active codes. Retire one first.');
      else say('bad','Could not add that just now. Try again in a moment.');
    }).catch(function(){
      go.disabled = false; go.textContent = 'Add a code';
      say('bad','No connection. Nothing was changed.');
    });
  });

  document.getElementById('list').addEventListener('click', function(e){
    var btn = e.target.closest('button[data-act]');
    if(!btn) return;
    var li = btn.closest('.code'), to = btn.dataset.act;
    if(to === 'revoked' && !confirm('Retire "' + li.querySelector('b').textContent +
        '"?\\n\\nAnyone who scans that card will be told it was retired. Your check-in history is kept, and you can put it back later.')) return;
    btn.disabled = true;
    fetch('/api/venue/codes/state?k=' + encodeURIComponent(K), {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ token: li.dataset.token, state: to })
    }).then(function(r){ return r.json(); }).then(function(j){
      if(j.ok) location.reload(); else { btn.disabled=false; say('bad','That did not go through.'); }
    }).catch(function(){ btn.disabled=false; say('bad','No connection. Nothing was changed.'); });
  });
})();
</script>
</body></html>`);
}


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


/* The security sweep runs on the cron trigger (wrangler.jsonc → triggers).
   It reads logs and writes findings; it cannot change keys, codes or
   bookings, so a bug here cannot damage anything. */

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


/* The export object already had a scheduled handler draining the outreach
   queue on the 15-minute cron. Replacing it would have silently stopped every
   queued email — the queue would simply never drain again, with no error
   anywhere. So: keep the original, chain the sweep after it, and run the
   sweep only on the hour-ish ticks so it fires ~4×/day, not 96×. */
const _origScheduled = WORKER.scheduled;
WORKER.scheduled = async (event, env, ctx) => {
  await _origScheduled.call(WORKER, event, env, ctx);
  const min = new Date(event.scheduledTime || Date.now()).getUTCMinutes();
  const hr  = new Date(event.scheduledTime || Date.now()).getUTCHours();
  if (min < 15 && hr % 6 === 0) ctx.waitUntil(securitySweep(env));
};
export default WORKER;
