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

const ALLOWED_ORIGINS = ["https://itsnum.com", "https://www.itsnum.com", "https://5arz.com", "https://www.5arz.com"];
function badOrigin(req) {
  const o = req.headers.get("origin");
  if (!o) return false;           // sendBeacon in some browsers, curl, tests
  return !ALLOWED_ORIGINS.includes(o);
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

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });

      if (p === "/api/growth/health") return health(env);
      if (p === "/num-capture.js") return captureAsset();

      if (p === "/api/ev" && req.method === "POST") return ev(req, env);
      if (p === "/api/consent" && req.method === "POST") return consent(req, env);
      if (p === "/api/sms-optin" && req.method === "POST") return smsOptin(req, env);
      if (p === "/api/capture" && req.method === "POST") return capture(req, env);
      if (p === "/api/claims" && req.method === "POST") return claims(req, env, ctx);

      if (p === "/api/host/join" && req.method === "POST") return hostJoin(req, env, ctx);
      if (p === "/api/host/summary" && req.method === "GET") return hostSummary(req, env, url);
      if (p === "/api/host/contacts" && req.method === "POST") return hostContacts(req, env, url, ctx);

      if (p === "/api/admin/earnings" && req.method === "POST") return adminEarnings(req, env);

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
       (visitor_id,event,page,ref_code,invite_token,utm_source,utm_medium,utm_campaign,referrer,country,device,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    vid, name, clean(b.page, 40), clean(b.ref_code, 40), clean(b.invite_token, 64),
    clean(b.utm_source, 60), clean(b.utm_medium, 60), clean(b.utm_campaign, 60),
    String(b.referrer || "").slice(0, 200), country(req), device(req), now()
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
