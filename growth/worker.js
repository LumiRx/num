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
 *   GET/POST /api/host/clients?k=   the host's book        (/host/)
 *   GET/POST /api/host/products?k=  what they sell         (/host/)
 *   GET/POST /api/host/requests?k=  their client work      (/host/)
 *   GET/POST /api/host/network?k=   other hosts            (/host/)
 *   GET/POST /api/host/intros?k=    introductions to accept(/host/)
 *   GET  /api/host/nearby           public: hosts near me
 *   POST /api/host/intro            public: member asks for a host
 *   GET/POST /api/host/link?t=      the MEMBER's own page: who my host is, leave
 *   POST /api/host/close?k=         host closes their account, releases clients
 *   GET  /api/host/integrity        ADMIN_KEY: orphans and contradictions
 *   GET  /api/host/calendar.ics?t= the host's confirmed work, read-only feed
 *   GET/POST /api/host/messages?k= the thread between a host and their client
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
 *   MAIL_FROM     var       NUM <info@itsnum.com>
 *   SEND_BUDGET   var       max invites actually sent per request (rest queue)
 */

/**
 * The postal address is not decoration. CAN-SPAM §7704(a)(5) requires a valid
 * physical address in every commercial message, and it was missing from every
 * email this worker has ever sent. Added 25 Aug 2026, confirmed by Andre.
 */
// Bound once, after the helpers it names are defined. Passing them in keeps
// claimverify.mjs free of a circular import back into this file.
let CLAIM_DEPS;

const LEGAL_LINE =
  "5arz Inc · 16192 Coastal Highway, Lewes, DE 19958 · info@itsnum.com · +1 754 444 8885";
const BANNER_VERSION = "2026-07-31.1";
// Bumped 3 Sep 2026 when the host agreement changed from "3% of NUM's
// commission for 12 months" to the monthly-plan model. The old string is NOT
// reused: rows signed under the old wording must stay identifiable as such,
// because what a host agreed to is a fact about a day, not about a product.
const TERMS_VERSION = "host-plan-2026-09-03";

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
//
// \p{M} — combining marks — is load-bearing and was missing until 25 Aug 2026.
// Thai writes its vowels and tones as marks: ร้าน is ร + ้ + า + น, and ้ is a
// mark, not a letter. Without \p{M} every Thai name that passed through here
// came out mangled — "ร้าน พ.บาติก" stored as "ร าน พ.บาต ก" — and the same
// held for Arabic, Hebrew, Devanagari and decomposed Vietnamese. It costs
// nothing in safety: CR and LF are control characters, not marks, so the
// header-injection property above is untouched.
const SAFE = /[^\p{L}\p{M}\p{N} '&.,()\/+@_-]/gu;
function clean(s, max = 200) {
  if (s == null) return "";
  let out = String(s);
  try { out = out.replace(SAFE, " "); }
  catch (e) { out = out.replace(/[^A-Za-z0-9 '&.,()\/+@_-]/g, " "); }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? out.slice(0, max) : out;
}

// A website address, which clean() cannot handle: ':' is not on the whitelist
// above, so "https://x.com" would come back as "https //x.com" — mangled into
// something that is no longer a link. This keeps the characters a URL needs
// and nothing else, and it refuses anything that is not plainly http(s), so a
// javascript: or data: string can never be stored and later rendered as an
// owner's "website".
function cleanUrl(s, max = 200) {
  let u = String(s == null ? "" : s).trim();
  if (!u) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) {
    if (!/^https?:\/\//i.test(u)) return "";   // mailto:, javascript:, data:, …
  } else {
    u = "https://" + u;                        // owners type "myplace.com"
  }
  let parsed;
  try { parsed = new URL(u); } catch (e) { return ""; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  // A hostname with no dot is not a public website; it is a typo or an
  // intranet name, and storing it helps nobody.
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(parsed.hostname)) return "";
  const out = parsed.toString();
  return out.length > max ? "" : out;
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

// Dialling codes for the countries NUM actually operates in. Deliberately not
// exhaustive: an absent country is handled by storing the number exactly as the
// person typed it (see localE164), which a human can still fix. Guessing is
// what we are trying to stop.
const DIAL = Object.freeze({
  TH: "66", GB: "44", US: "1", CA: "1", AE: "971", SG: "65", MY: "60", ID: "62",
  VN: "84", PH: "63", KH: "855", LA: "856", MM: "95", IN: "91", LK: "94",
  JP: "81", KR: "82", CN: "86", HK: "852", TW: "886", AU: "61", NZ: "64",
  FR: "33", ES: "34", IT: "39", DE: "49", PT: "351", GR: "30", NL: "31",
  CH: "41", AT: "43", BE: "32", SE: "46", NO: "47", DK: "45", IE: "353",
  TR: "90", MA: "212", EG: "20", ZA: "27", MX: "52", BR: "55", AR: "54",
  MV: "960", NP: "977", QA: "974", SA: "966", BH: "973", OM: "968", KW: "965",
});

// The ISO country to read a local phone number against: what the page told us,
// else where Cloudflare says the request came from.
function ccOf(req, hint) {
  const h = String(hint || "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(h) && DIAL[h]) return h;
  const g = country(req).toUpperCase();
  return DIAL[g] ? g : "";
}

/**
 * E.164 for a number typed by someone standing in a known country.
 *
 * The plain e164() above defaults to +44, which was right when every claim came
 * from the UK. It is badly wrong anywhere else: a Phuket owner typing
 * "081 234 5678" was being stored as +44812345678 — a real UK number belonging
 * to a stranger, on the field the whole product uses to text them bookings.
 *
 * So: an explicit + or 00 always wins, then the country we actually know. If we
 * know nothing, keep the digits exactly as typed rather than inventing a
 * country — an unprefixed local number is recoverable, a confidently wrong one
 * is not.
 */
function localE164(raw, req, hint) {
  const s = String(raw || "").trim();
  if (s.startsWith("+") || digits(s).startsWith("00")) return e164(s);
  const iso = ccOf(req, hint);
  return iso ? e164(s, DIAL[iso]) : digits(s);
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

/**
 * A CRAWLER IS NOT A VISITOR — the third robot this codebase has had to learn.
 *
 * The uptime probe was one string in 65% of every question ever asked. The MCP
 * integrity monitor wrote its test question into num_asks as a traveller's.
 * And on 3 Sep 2026, within three hours of the ads landing page going live,
 * **302 "visitors"** arrived on it: US desktop, no referrer, no campaign, one
 * page view each, not one scroll and not one question. The real campaign is
 * 87% mobile and carries utm_source=reddit. Those 302 were scanners finding a
 * newly published URL — and they were sitting in the denominator of the only
 * conversion rate this company is currently judged on, making it read as
 * "nobody who arrives is interested" rather than "almost nobody has arrived".
 *
 * A page view that a person did not make is not a small measurement error. It
 * is the number a campaign gets paused over.
 *
 * Deliberately conservative: this matches self-declared crawlers only. A bot
 * that lies about its user-agent still gets through, and that is the right
 * trade — wrongly dropping a real visitor is worse than keeping a stray one,
 * because you cannot see what you deleted.
 */
const BOT_UA = /bot\b|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|facebot|ia_archiver|semrush|ahrefs|mj12|dotbot|petalbot|yandex|baiduspider|duckduckbot|applebot|headlesschrome|phantomjs|puppeteer|playwright|python-requests|curl\/|wget|scrapy|go-http-client|axios\/|node-fetch|okhttp|java\/|httpclient|monitoring|uptime|pingdom|statuscake|gtmetrix|lighthouse|chrome-lighthouse/i;

function isBot(req) {
  const ua = req.headers.get("user-agent") || "";
  // No user-agent at all is not a browser a person is holding.
  if (!ua) return true;
  return BOT_UA.test(ua);
}

function device(req) {
  const ua = (req.headers.get("user-agent") || "").toLowerCase();
  if (/ipad|tablet/.test(ua)) return "tablet";
  if (/mobi|android|iphone/.test(ua)) return "mobile";
  if (!ua) return "";
  return "desktop";
}

// Every helper the verification module borrows now exists, so bind them here
// — after J, clean and readJSON, never before. Passing them in rather than
// letting claimverify.mjs import this file keeps the two out of a cycle.
CLAIM_DEPS = claimDeps({ J, clean, readJSON, sendBatch, legalLine: LEGAL_LINE });

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

import * as QR from './qrsystem.mjs';
import * as MONEY from './money.mjs';
import * as CRYPTO from './crypto.mjs';
import * as RPC from './rpc.mjs';
import * as QRCHECK from './qrcheck.mjs';
// sendBatch lives in its own module now — see resend.mjs — so the invite
// drain (invitecron.mjs) makes the exact same Resend call this worker
// already made for host invites, rather than a second copy that could drift.
import { sendBatch } from './resend.mjs';
import { drainInvites } from './invitecron.mjs';
// Proving a business is yours, behind the door people already walk through.
// The rules it enforces come from claim/verify.mjs — the file that was
// written, tested, and then left with no route for three weeks.
import {
  claimStart, claimSend, claimVerify, claimStatus, claimDeps,
} from './claimverify.mjs';
// The venue's own switches. `num_business_settings` had a reader in
// commission.mjs and a reader in aftertable.mjs and no writer anywhere, so
// every flag it holds had been 0 for the life of every business.
import {
  FIELDS as SET_FIELDS, LOCKED as SET_LOCKED, TIPS_UNDERTAKING,
  readSettings, writeSettings, settingHistory,
} from './venuesettings.mjs';
import { foodAndDrink } from '../worker/commission.mjs';
import { BOOKING_FEE_MINOR } from '../worker/servicefee.mjs';
import { integrityReport } from '../worker/hostintegrity.mjs';
// The screen after the table. worker/aftertable.mjs had rate(), tip() and
// prioritySeating() fully written and fully tested with no call sites at all;
// this is where the scan reaches them.
import { issueAfter, afterState, resolveAfter, tipRail } from './aftervisit.mjs';
import { rate as afterRate, tip as afterTip } from '../worker/aftertable.mjs';

/* -------------------------------------------------------------------- mail */

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

  /* ── how someone got here, carried across our own pages ────────────────
   *
   * Everything below exists because of one measured failure. The paid Reddit
   * campaign sent 577 people to itsnum.com/?utm_source=reddit. They clicked
   * "Get the app" — a static /app/ link — and the campaign died on that first
   * click. It died again on the next hop, where the "Open Num" button pointed
   * at a hardcoded app.itsnum.com/?app. So every paid visitor who actually
   * reached the product arrived looking like direct traffic, which is why the
   * campaign shows zero members and why we could not say whether it worked.
   *
   * The ref half of this was already fixed once, with a comment on /app/
   * describing this exact bug: "the whole chain works and then loses
   * attribution at the final hop". The utm half was left behind.
   *
   * (No backticks in here, ever: this whole file is a template literal inside
   * the worker, and one stray backtick ends the string and the deploy.)
   */
  var CAMPAIGN_KEYS = [
    "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
    "gclid", "fbclid"
  ];
  var CAMPAIGN_STORE = "num_campaign_v1";
  /* Our own hosts, and only ours. app.itsnum.com is a different ORIGIN but the
   * same product; line.me and every partner link is neither. Appending
   * campaign data to a third-party URL would hand them our ad spend for no
   * benefit to anyone.
   *
   * An exact host list rather than a pattern, for two reasons. A regex here
   * needs backslash escapes, and THIS WHOLE FILE IS A TEMPLATE LITERAL — the
   * backslashes are eaten before the browser ever sees them, so /itsnum\.com/
   * ships as /itsnum.com/ and https?:\/\/ ships as https?:// which does not
   * even parse. That mistake took the entire tracker off every page on the
   * site for one deploy. The second reason is that it is simply more correct:
   * an unescaped dot matches any character, so the pattern that survived would
   * have accepted wwwXitsnum.com as ours. */
  var OUR_HOSTS = ["itsnum.com", "www.itsnum.com", "app.itsnum.com"];

  function isOurs(u) {
    var h = String(u && u.hostname ? u.hostname : "").toLowerCase();
    for (var i = 0; i < OUR_HOSTS.length; i++) {
      if (h === OUR_HOSTS[i]) return true;
    }
    return false;
  }

  /** The campaign for this visit — from the URL, or remembered for this tab. */
  function campaign() {
    var out = {};
    var found = false;
    try {
      var p = new URLSearchParams(location.search);
      for (var i = 0; i < CAMPAIGN_KEYS.length; i++) {
        var v = p.get(CAMPAIGN_KEYS[i]);
        if (v) { out[CAMPAIGN_KEYS[i]] = v; found = true; }
      }
    } catch (e) { return {}; }

    if (found) {
      // sessionStorage, not local: this is "how this visit started", and it
      // should not still be claiming credit next week. Remembering it at all
      // means one page in the middle that forgets to pass it on — /app/ had
      // no tracking of any kind until today — no longer breaks the chain.
      try { sessionStorage.setItem(CAMPAIGN_STORE, JSON.stringify(out)); } catch (e) { /* private mode */ }
      return out;
    }
    try {
      var saved = sessionStorage.getItem(CAMPAIGN_STORE);
      return saved ? JSON.parse(saved) : {};
    } catch (e) { return {}; }
  }

  /** Append params to a href without disturbing what is already there. */
  function appendParams(href, pairs) {
    if (!pairs.length) return href;
    var hash = "";
    var h = href.indexOf("#");
    if (h > -1) { hash = href.slice(h); href = href.slice(0, h); }
    // String append rather than URL re-serialisation on purpose: /app/ links
    // to app.itsnum.com/?app — a valueless param that a round trip through
    // URLSearchParams would quietly rewrite to ?app=.
    return href + (href.indexOf("?") > -1 ? "&" : "?") + pairs.join("&") + hash;
  }

  function carryRef() {
    var camp = campaign();
    var campKeys = [];
    for (var key in camp) {
      if (Object.prototype.hasOwnProperty.call(camp, key)) campKeys.push(key);
    }
    if (!REF && !campKeys.length) return;

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
      var same = u.origin === location.origin;
      if (!same && !isOurs(u)) continue; // never leak a host code or a campaign offsite

      var add = [];
      // The host code stays same-origin only, as before — it identifies a
      // person, and the app has its own /r/ route for it.
      if (same && REF && !u.searchParams.get("ref")) {
        add.push("ref=" + encodeURIComponent(REF));
      }
      for (var k = 0; k < campKeys.length; k++) {
        if (!u.searchParams.get(campKeys[k])) {
          add.push(encodeURIComponent(campKeys[k]) + "=" + encodeURIComponent(camp[campKeys[k]]));
        }
      }
      if (add.length) a.setAttribute("href", appendParams(href, add));
    }

    // Guarded on REF. This used to be unreachable without one, because the
    // function returned early when REF was empty; now a campaign alone gets
    // us this far, and an empty hidden ref on every form would post "" as a
    // host code on pages that never had one.
    if (!REF) return;
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
    // Falls back to the generic arrival rather than silently logging nothing.
    // The old behaviour meant tagging a new page did visibly nothing: /app/
    // and /get/ — the two middle steps of the paid funnel — could have carried
    // this script for months and still reported no arrivals, because their
    // names were not in the map. The page name is already a column, so one
    // generic event covers every page we add from here on.
    var event = ARRIVAL[CFG.page] || "page_view";

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
          say(msg, "That did not go through. Email info@itsnum.com and a person will sort it.", true);
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
      // Matches the existing `itsnum.com/api/ev*` route, so no wrangler change
      // is needed to ship it.
      if (p === "/api/ev.gif" && req.method === "GET")
        return evPixel(req, env, url);
      if (p === "/api/consent" && req.method === "POST") return consent(req, env);
      if (p === "/api/sms-optin" && req.method === "POST") return smsOptin(req, env);
      if (p === "/api/capture" && req.method === "POST") return capture(req, env);
      // Matches the existing `itsnum.com/api/claims*` route, so no wrangler
      // change is needed to ship it. Must be tested before "/api/claims".
      if (p === "/api/claims/lookup" && req.method === "GET")
        return claimsLookup(req, env, url);

      // Ownership verification. All four sit under the existing
      // `itsnum.com/api/claims*` route, so wiring them needed no new route,
      // no second worker and no second copy of the Resend key — which is
      // exactly why the fully-built claim worker stayed unrouted for so long.
      if (p === "/api/claims/start" && req.method === "POST")
        return claimStart(req, env, CLAIM_DEPS);
      if (p === "/api/claims/send" && req.method === "POST")
        return claimSend(req, env, CLAIM_DEPS);
      if (p === "/api/claims/verify" && req.method === "POST")
        return claimVerify(req, env, CLAIM_DEPS);
      if (p === "/api/claims/status" && req.method === "GET")
        return claimStatus(req, env, url, CLAIM_DEPS);
      if (p === "/api/claims" && req.method === "POST") return claims(req, env, ctx);

      if (p === "/api/host/join" && req.method === "POST") return hostJoin(req, env, ctx);
      if (p === "/api/host/summary" && req.method === "GET") return hostSummary(req, env, url);
      if (p === "/api/host/profile") return hostProfile(req, env, url, ctx);
      if (p === "/api/host/contacts" && req.method === "POST") return hostContacts(req, env, url, ctx);
      if (p === "/api/host/clients") return hostClients(req, env, url, ctx);
      if (p === "/api/host/products") return hostProducts(req, env, url);
      if (p === "/api/host/requests") return hostRequests(req, env, url, ctx);
      if (p === "/api/host/network") return hostNetwork(req, env, url);
      if (p === "/api/host/intros") return hostIntros(req, env, url, ctx);
      if (p === "/api/host/nearby" && req.method === "GET") return hostNearby(req, env, url);
      if (p === "/api/host/intro" && req.method === "POST") return hostIntro(req, env, ctx);
      if (p === "/api/host/link") return memberLink(req, env, url, ctx);
      if (p === "/api/host/close" && req.method === "POST") return hostClose(req, env, url, ctx);
      if (p === "/api/host/integrity" && req.method === "GET") return hostIntegrity(req, env, url);
      if (p === "/api/host/calendar.ics" && req.method === "GET") return hostCalendar(req, env, url);
      if (p === "/api/host/messages") return hostMessages(req, env, url, ctx);

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
      if (p === "/api/venue/pay" && req.method === "GET") return venuePayList(req, env, url);
      if (p === "/api/venue/pay" && req.method === "POST") return venuePayCreate(req, env, url);
      if (p === "/api/venue/pay/state" && req.method === "POST") return venuePayState(req, env, url);
      if (p === "/api/venue/pay/bulk" && req.method === "POST") return venuePayBulk(req, env, url);
      if (p === "/biz/pay") return venuePayPage(req, env, url);

      /* ── QR system: tables, bill codes, staff, agent ───────────────────── */
      if (p === "/api/venue/login" && req.method === "POST") return qrLoginStart(req, env);
      if (p === "/biz/login") return qrLoginRedeem(req, env, url);
      if (p === "/api/venue/logout" && req.method === "POST") return qrLogout(req, env);
      if (p === "/api/venue/me") return qrMe(req, env, url);
      if (p === "/api/venue/tables" && req.method === "GET") return qrTablesList(req, env, url);
      if (p === "/api/venue/tables" && req.method === "POST") return qrTablesCreate(req, env, url);
      if (p === "/api/venue/tables/state" && req.method === "POST") return qrTableState(req, env, url);
      if (p === "/api/venue/tables/codes" && req.method === "POST") return qrIssueCodes(req, env, url);
      if (p === "/api/venue/bill" && req.method === "POST") return qrBillCreate(req, env, url);
      if (p === "/api/venue/bill/settle" && req.method === "POST") return qrBillSettle(req, env, url);
      if (p === "/api/venue/bills" && req.method === "GET") return qrBillsOpen(req, env, url);
      if (p === "/api/venue/staff" && req.method === "GET") return qrStaffList(req, env, url);
      if (p === "/api/venue/staff" && req.method === "POST") return qrStaffAdd(req, env, url);
      if (p === "/api/venue/staff/state" && req.method === "POST") return qrStaffState(req, env, url);
      if (p === "/api/venue/agent" && req.method === "GET") return qrAgentLog(req, env, url);
      if (p === "/api/venue/identity" && req.method === "GET") return qrIdentityGet(req, env, url);
      if (p === "/api/venue/identity" && req.method === "POST") return qrIdentitySet(req, env, url);
      if (p === "/api/venue/identity/retire" && req.method === "POST") return qrIdentityRetire(req, env, url);
      if (p === "/api/venue/identity/preview.svg") return qrIdentityPreview(req, env, url);
      if (p === "/biz/tables") return qrTablesPage(req, env, url);
      if (p === "/api/venue/settings" && req.method === "GET")
        return venueSettingsGet(req, env, url);
      if (p === "/api/venue/settings" && req.method === "POST")
        return venueSettingsSet(req, env, url);
      if (p === "/biz/settings") return venueSettingsPage(req, env, url);
      if (p === "/api/venue/statement") return venueStatement(req, env, url);
      if (p === "/api/venue/invoice") return venueInvoiceLines(req, env, url);
      if (p === "/api/venue/payee.svg") return payeeQrRoute(req, env, url);
      if (p === "/biz/statement") return venueStatementPage(req, env, url);
      if (p === "/api/admin/money") return adminMoney(req, env, url);
      if (p === "/api/venue/chain") return venueChain(req, env, url);
      if (p === "/api/venue/qrcheck") return venueQrCheck(req, env, url);
      if (p === "/api/admin/chain") return adminChain(req, env, url);
      if (p.startsWith("/api/pay/qr/")) return payQrRoute(req, env, p.slice(12));
      if (p.startsWith("/api/pay/emv/")) return payEmvRoute(req, env, p.slice(13));
      if (p === "/api/admin/pay/meter") return adminPayMeter(req, env);
      if (p.startsWith("/a/")) return afterPage(req, env, p.slice(3));
      if (p.startsWith("/api/after/rate") && req.method === "POST")
        return afterRateRoute(req, env);
      if (p.startsWith("/api/after/tip") && req.method === "POST")
        return afterTipRoute(req, env);
      if (p.startsWith("/api/after/") && req.method === "GET")
        return afterStateRoute(req, env, p.slice(11));
      if (p.startsWith("/p/")) {
        const rest = p.slice(3);
        return rest.endsWith("/go") ? payGo(req, env, rest.slice(0, -3))
                                    : payLanding(req, env, rest);
      }
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
    // The QR agent. Isolated from the mail drain on purpose: a failing agent
    // pass must never stop invites going out, and a Resend outage must never
    // stop tables getting their codes.
    ctx.waitUntil(
      qrRunAgent(env).catch((e) => console.log("qr agent", String(e).slice(0, 300))),
    );
    // The chain watcher. Isolated like everything else on this cron: an RPC
    // outage must not stop tables getting their codes or invoices going out.
    if (env.NUM_RPC_BASE) {
      ctx.waitUntil(
        chainSweep(env)
          .then((r) => console.log("chain sweep", JSON.stringify(r).slice(0, 400)))
          .catch((e) => console.log("chain sweep failed", String(e).slice(0, 300))),
      );
    }
    // Weekly invoicing, Monday morning UTC. invoiceAll only ever picks up
    // lines that are not already on an invoice, so a second firing in the
    // same hour is a no-op rather than a double bill.
    const when = new Date(event.scheduledTime || Date.now());
    if (when.getUTCDay() === 1 && when.getUTCHours() === 2 && when.getUTCMinutes() < 15) {
      ctx.waitUntil(
        MONEY.invoiceAll(env)
          .then((r) => console.log("invoice run", JSON.stringify(r).slice(0, 400)))
          .catch((e) => console.log("invoice run failed", String(e).slice(0, 300))),
      );
    }
    // The automated merchant-invite drain. See invitecron.mjs's own header
    // for why this runs on the cron rather than as an LLM-driven loop, and
    // why Thailand is deliberately excluded until its copy is reviewed.
    // Isolated like everything else on this cron: a bug here must not stop
    // tables getting their codes or host invites going out.
    ctx.waitUntil(
      drainInvites(env, event)
        .then((r) => console.log("invite drain", JSON.stringify(r).slice(0, 400)))
        .catch((e) => console.log("invite drain failed", String(e).slice(0, 300))),
    );
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
  "claim_view", "claim_done", "claim_place_picked",
  // The ownership funnel. Without these four, "how many claims turn into
  // verified businesses" is a question with no denominator — which is how the
  // claim form went three weeks as a dead end without it showing up anywhere.
  "claim_verify_offered", "claim_code_sent", "claim_verified",
  "host_join_view", "host_join_done",
  "landing_view", "capture_done", "ref_arrival", "invite_open",
  // --- install funnel (added 10 Aug 2026) ------------------------------
  // Every step between arriving and actually using Num. Before these,
  // the only thing recorded was that the page had been served.
  // --- arrival (added 24 Aug 2026) --------------------------------------
  // The app surface had NO arrival event. Its earliest signal was scroll_50,
  // which means every rate we could quote for it had no denominator: 58 people
  // scrolled halfway, out of a number nobody could name. That is not a
  // reporting nicety — it is the reason a paid campaign could send 577 clicks
  // and be argued about instead of measured.
  //
  // `page_view` rather than `app_view`: the `page` column already carries
  // which surface it was, so one name covers app, install and business
  // without a new constant every time a surface is added.
  "page_view",
  // The primary CTA — "Ask Num something" / "Open Num". Split out of
  // open_in_browser_click on 25 Aug 2026: every one of that event's 25 rows
  // carried the label "Ask Num something", and the name had them read as
  // people fleeing to another browser when they were the most interested
  // people on the page. The old name stays for genuine browser escapes only.
  "primary_cta_click",
  "install_cta_click",      // tapped any "add to home screen" control
  "install_tab_view",       // opened the iPhone / Android / Desktop pane
  "install_prompt_shown",   // the browser beforeinstallprompt actually fired
  "install_accepted",       // user accepted that prompt
  "install_dismissed",      // user rejected it — the number nobody wants to look at
  "app_launched_standalone",// opened Num from the home screen icon: real install proof
  "open_in_browser_click",  // chose the browser over installing
  "first_message_sent",     // the only event that means the product was used
  // --- did it actually work (added 3 Sep 2026) --------------------------
  // The pair for first_message_sent. `num_answered` carries 'first' or
  // 'repeat' in detail — the second answer is the one that earns the
  // home-screen ask. `ask_failed` carries the reason, and exists because the
  // failure path on the ads landing page was silent: if the API or CORS broke
  // for real visitors, every dashboard we own would have shown a quiet page
  // and no reason for it.
  "num_answered", "ask_failed",
  "watch_film_click",
  "scroll_50", "scroll_90",
  // --- desktop handoff --------------------------------------------------
  "desktop_handoff_shown", "desktop_qr_shown", "desktop_link_sent",
  // --- language -----------------------------------------------------------
  "lang_offer_shown", "lang_switched",
  // --- 5arz consent ask (added 2 Sep 2026) --------------------------------
  // The wall metric is shown → linked. `num_identity_links` has always had the
  // numerator; nothing ever wrote the denominator. Fired by Verify5arz.tsx.
  "consent_prompt_shown", "consent_prompt_engaged",
  // --- recommendation cards (added 3 Sep 2026) ----------------------------
  // Which half of a pick card people actually use: the link, the map, or the
  // phone. This is how we learn whether a website or directions is the thing
  // a traveller wants, rather than assuming.
  "pick_link_click", "pick_map_click", "pick_call_click",
  // --- outbound email (added 25 Aug 2026) ---------------------------------
  // Logged by GET /api/ev.gif, not by the tracker script: an email client has
  // no JavaScript. `email_open` is the weakest signal we record and is treated
  // as such everywhere downstream — see the warning on evPixel().
  "email_open", "email_click",
]);

async function ev(req, env) {
  if (badOrigin(req)) return J({ ok: false }, 403);
  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (overLimit("ev:" + ip, 60)) return J({ ok: true, throttled: true });

  let b;
  try { b = await readJSON(req, 8192); } catch (e) { return J({ ok: false }, 400); }

  const name = clean(b.event, 40);
  if (!EVENTS.has(name)) return J({ ok: true, ignored: true });
  // Answered 200 like everything else, so a crawler that runs JavaScript sees
  // nothing unusual and does not retry — it just does not land in the funnel.
  if (isBot(req)) return J({ ok: true, ignored: "bot" });

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

/* ------------------------------------------- GET /api/ev.gif  email opens */

/**
 * A 1×1 transparent GIF that logs an open, and four rules about it.
 *
 * ── 1. IT MUST NEVER FAIL ────────────────────────────────────────────────
 * Everything below is inside a try/catch that swallows, because the failure
 * mode of an image endpoint is not a 500 the user never sees — it is a broken
 * image icon sitting in the middle of a letter we sent to a stranger. The GIF
 * goes back whatever happens.
 *
 * ── 2. NO ORIGIN CHECK ───────────────────────────────────────────────────
 * `badOrigin` guards /api/ev because that endpoint is called by our own pages.
 * This one is called by Gmail, Outlook and Apple's proxy servers, which send
 * no Origin header at all. Reusing that guard here would reject every real
 * request and pass only the fake ones.
 *
 * ── 3. NO EMAIL ADDRESS IN THE URL ───────────────────────────────────────
 * `t=` is an opaque token minted per recipient at send time, never the
 * address. A tracking URL is copied into forwards, pasted into support
 * tickets, and logged by every hop in between; an address in it is an address
 * leaked. The token maps back to the recipient in our own tables or nowhere.
 *
 * ── 4. THE NUMBER IT PRODUCES IS THE WEAKEST ONE WE HAVE ─────────────────
 * Apple Mail Privacy Protection fetches every image in every message before
 * the person has opened anything, from an Apple proxy IP, and Gmail proxies
 * images through its own cache. So this over-counts, by a margin nobody can
 * state. It is recorded because Andre asked for it and because the TREND is
 * still readable — but `claims.source` is the number that means something,
 * because a claim is a person who did a thing. Never quote an open rate as
 * evidence of anything on its own.
 */
const PIXEL_GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

const pixelResponse = () =>
  new Response(PIXEL_GIF, {
    status: 200,
    headers: {
      "content-type": "image/gif",
      // Without this the proxy caches the first fetch and every later open of
      // the same message is invisible.
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      "content-length": String(PIXEL_GIF.length),
    },
  });

async function evPixel(req, env, url) {
  try {
    const q = url.searchParams;
    const name = q.get("ev") === "click" ? "email_click" : "email_open";
    const ip = req.headers.get("cf-connecting-ip") || "0";
    // Generous: one message legitimately fetches this more than once (proxy,
    // then client, then again when the person re-reads it days later).
    if (!overLimit("px:" + ip, 240)) {
      const vid = await visitorId(req, env);
      await env.DB.prepare(
        `INSERT INTO num_web_events
           (visitor_id,event,page,ref_code,invite_token,utm_source,utm_medium,utm_campaign,referrer,country,device,detail,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        vid, name, "email", "", clean(q.get("t"), 64),
        "email", "outreach", clean(q.get("c"), 60),
        "", country(req), device(req), clean(q.get("d"), 60), now()
      ).run();
    }
  } catch (e) {
    // Deliberately silent. See rule 1.
  }
  return pixelResponse();
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
/**
 * The partner opt-in wording — businesses and hosts.
 *
 * This is a VERBATIM copy of PARTNER_CONSENT_TEXT in worker/partnersms.mjs.
 * The two workers are separate bundles and cannot import from each other, so
 * the string is duplicated and `partnersms.test.mjs` pins the copies
 * byte-for-byte. The day they drift, the consent register stops holding the
 * words the person actually read, and the register is only worth having
 * because it holds exactly that.
 */
const PARTNER_CONSENT_TEXT =
  "Yes — NUM may text this number about my listing: when it goes live, when it needs " +
  "something, and when there are requests waiting. A few messages a month. " +
  "Message and data rates may apply. Reply STOP to stop, HELP for help.";

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

/* ---------------------------------------------- GET /api/claims/lookup
   Type-ahead for the claim form, so a claim lands bound to the place it is
   actually about instead of to a name somebody typed. Without it `place_id`
   is NULL on every claim, which means a claim has no coordinates, and with no
   coordinates there is nothing to draw on a map and nothing to pay a scout
   for.

   Most claims never reach here: an emailed or QR'd link already carries ?p=,
   which is exact and costs no query at all. This is the walk-in path.

   Deliberately narrow, in three ways that are all load-bearing:

   1. One destination at a time, three characters minimum. `places` holds 2.5M
      rows; idx_places_dest_name can serve a prefix inside one dest (~300 rows
      read) and can serve nothing at all without the dest.
   2. Prefix match, never %contains%. A leading wildcard defeats the index and
      reads the whole city on every keystroke.
   3. It returns only what is already painted on the shopfront — name, address,
      category. Never phone, never email, never website. Los Angeles alone
      holds 30,570 business email addresses in this table; a public endpoint
      that turns a name into one of them is a scraper with a search box, not a
      lookup. */
async function claimsLookup(req, env, url) {
  if (badOrigin(req)) return J({ ok: false }, 403);
  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (overLimit("lookup:" + ip, 40)) return J({ ok: false, error: "slow_down" }, 429);

  const dest = String(url.searchParams.get("d") || "")
    .toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
  // Not clean(): this string is never stored, never emailed and never rendered
  // as markup — it is bound into one LIKE. Narrowing it to a punctuation
  // whitelist only loses matches. What must go is control characters and the
  // three LIKE metacharacters; everything a writing system uses stays.
  const q = String(url.searchParams.get("q") || "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, " ")   // control characters
    .replace(/[%_\\]/g, " ")                   // the LIKE metacharacters
    .replace(/\s+/g, " ").trim().slice(0, 60);
  if (!dest || q.length < 3) return J({ ok: true, places: [] });

  // Prefix, never %contains%: a leading wildcard cannot use
  // idx_places_dest_name and reads the whole destination on every keystroke.
  const like = q + "%";

  let rows = [];
  try {
    const r = await env.DB.prepare(
      `SELECT id, name, address, area, category, status
         FROM places
        WHERE dest = ? AND name LIKE ?
        ORDER BY reviews DESC
        LIMIT 8`
    ).bind(dest, like).all();
    rows = r.results || [];
  } catch (e) {
    // A lookup that fails must never block a claim. The form falls back to
    // free text and the claim still lands, just without a place bound to it.
    rows = [];
  }

  return J({
    ok: true,
    places: rows.map((r) => ({
      id: r.id,
      name: r.name,
      where: r.address || r.area || "",
      category: r.category || "",
      taken: r.status === "claimed" ? 1 : 0,
    })),
  });
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

  /* ── A WAY TO REACH THEM, NOT A PARTICULAR WAY ──────────────────────────
   *
   * This used to be `if (!okPhone(phone)) return bad_phone` with email
   * optional, which meant a business holding out its EMAIL ADDRESS was
   * rejected outright — while every one of these businesses reached this form
   * by clicking a link in an email we had already sent them. We had the
   * address. We demanded a mobile number instead.
   *
   * On 7 Sep 2026: 503 invitations, 200 opened, 19 businesses clicked through
   * to a form pre-filled with their own name, and ONE completed it. A required
   * phone field is the most-refused input in B2B signup, and it was gating a
   * thing we give away free.
   *
   * The real requirement is that we can reach them at all. Verification does
   * not depend on which one they give — the code goes to the contact already
   * published on their listing, never to a value typed into this form, so the
   * phone number was never proof of anything either. */
  const hasPhone = okPhone(phone);
  const hasEmail = !!email && okEmail(email);
  if (phone && !hasPhone) return J({ ok: false, error: "bad_phone" }, 400);
  if (email && !okEmail(email)) return J({ ok: false, error: "bad_email" }, 400);
  if (!hasPhone && !hasEmail) return J({ ok: false, error: "need_contact" }, 400);

  const vid = await visitorId(req, env);
  const source = clean(b.source, 80) || "claim";
  const refCode = clean(b.ref_code, 40);

  // Where this claim came from. Previously only num_captures held any of this,
  // and that row is written only when an email is given — so a merchant who
  // signed up off a printed flyer with no email left no country, no campaign
  // and no destination anywhere. On the claims row it is always recorded.
  const iso = ccOf(req, b.country) || country(req).toUpperCase().slice(0, 2);
  const dest = clean(b.dest, 40).toLowerCase();
  const placeId = clean(b.place_id, 64);

  // The claims table is what the existing admin console reads, so it stays the
  // system of record for "a business put its hand up". Everything else is
  // marketing state and lives alongside it.
  const ins = await env.DB.prepare(
    `INSERT INTO claims (business_name,contact_name,phone,line_id,email,source,state,
                         country,dest,place_id,created_at)
     VALUES (?,?,?,?,?,?,'new',?,?,?,?)`
  ).bind(
    business, contact, hasPhone ? localE164(phone, req, b.country) : null,
    // line_id has existed on this table since the beginning and was always
    // written NULL. In Thailand LINE is how a business is actually reached, so
    // the Thai form offers it and it is now stored.
    clean(b.line_id, 80) || null,
    email || null, source,
    iso || null, dest || null, placeId || null, now()
  ).run();

  const work = [];

  // A business we do not already hold, describing itself.
  //
  // `places` covers 2.5M venues and is still not everyone. Until now an owner
  // we had no listing for typed their name into the box and the claim landed
  // bound to nothing: no address, no coordinates, nothing a concierge could
  // ever recommend. Now they can tell us, and we keep what they said.
  //
  // It goes to num_place_submissions, NOT to `places`. places.lat/lng are NOT
  // NULL and a typed address is not coordinates — writing 0,0 to satisfy that
  // would put a pin in the Gulf of Guinea and into the proximity index the
  // concierge searches. It is geocoded and reviewed first. See 0007.
  //
  // Only ever when nothing was picked: if the owner selected their real
  // listing we already have all of this, better.
  const subAddress = clean(b.address, 200);
  const subWebsite = cleanUrl(b.website, 200);
  // The name on the sign, in their own script. clean() keeps every letter and
  // combining mark of every writing system, so this survives as typed —
  // Thai tone marks, Arabic vowels, Balinese, decomposed Vietnamese and all.
  const subLocal = clean(b.name_local, 120);
  const subLang = /^[a-z]{2}$/.test(String(b.lang || "")) ? String(b.lang) : null;
  if (!placeId && (subAddress || subWebsite || subLocal)) {
    work.push(env.DB.prepare(
      `INSERT INTO num_place_submissions
         (id,name,name_local,lang,address,website,category,phone,email,country,dest,claim_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      "sub_" + token(10), business, subLocal || null, subLang,
      subAddress || null, subWebsite || null,
      clean(b.category, 60) || null,
      localE164(phone, req, b.country) || null, email || null,
      iso || null, dest || null, ins?.meta?.last_row_id ?? null, now()
    ));
  }

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
      "cap_" + token(8), email, lc(email), localE164(phone, req, b.country), contact, business, vid, "claim",
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

  // A business that claims its listing now hears back. Until 25 Aug 2026 it
  // got a green screen and silence — no record in its inbox that anything had
  // happened, nothing to forward to the owner, and no address to reply to.
  //
  // TRANSACTIONAL, not marketing. It is the receipt for a form they just
  // submitted, so it does not check marketing_ok and it sells nothing. That
  // distinction is also why it is exempt from the suppression list: someone
  // who unsubscribed from outreach and later claims a listing still needs the
  // confirmation for the thing they just did.
  //
  // waitUntil, so a Resend outage delays nothing and fails nothing. The claim
  // is already committed by this point; the email is a courtesy on top of it.
  if (email && ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(sendClaimWelcome(env, {
      email, business, contact, country: iso, dest,
    }).catch(() => {}));
  }

  return J({ ok: true, id: ins.meta ? ins.meta.last_row_id : null });
}

/**
 * The claim receipt, in the language of the country the claim came from.
 *
 * Thai for TH, English everywhere else — the same rule the outreach uses, and
 * it keys off the country rather than the destination so a Thai business
 * outside Phuket is not sent English by accident.
 *
 * What it deliberately does NOT say, because none of it is true yet:
 * bookings (the desk returns 503), QR pay (num_paylinks has no rows), or any
 * fee figure (the site and commission.mjs disagree). It says what actually
 * happens next, which is that a human checks the claim.
 */
async function sendClaimWelcome(env, c) {
  const th = String(c.country || "").toUpperCase() === "TH";
  const name = c.contact ? c.contact.split(" ")[0] : "";

  const subject = th
    ? "ได้รับข้อมูลของ " + c.business + " แล้ว"
    : "We have your claim for " + c.business;

  const text = th
    ? [
        (name ? "สวัสดีคุณ " + name : "สวัสดีครับ"),
        "",
        "ได้รับการยืนยันร้าน " + c.business + " เรียบร้อยแล้ว ขอบคุณครับ",
        "",
        "ขั้นตอนต่อไป มีคนของเราตรวจสอบข้อมูลด้วยตัวเอง ไม่ใช่ระบบอัตโนมัติ",
        "ถ้ามีอะไรไม่ตรง เราจะติดต่อกลับทางอีเมลนี้หรือทางโทรศัพท์ที่ให้ไว้",
        "",
        "สิ่งที่คุณทำได้ตอนนี้ ตอบอีเมลนี้กลับมาได้เลยถ้าข้อมูลร้านผิด",
        "เวลาเปิดปิด ที่อยู่ หรือชื่อร้าน เราแก้ให้ในวันเดียวกัน",
        "",
        "เราจะไม่ส่งอีเมลการตลาดมาหาคุณเพราะการยืนยันร้านครั้งนี้",
        "",
        "Andre",
        "NUM · 5arz Inc.",
        LEGAL_LINE,
      ].join("\n")
    : [
        (name ? "Hello " + name + "," : "Hello,"),
        "",
        "We have your claim for " + c.business + ". Thank you.",
        "",
        "What happens next: a person checks it, not a script. If anything does",
        "not line up we will write back to this address or call the number you",
        "gave us. If it all lines up you will not hear from us again about it,",
        "which is the good outcome.",
        "",
        "What you can do now: reply to this email if anything we hold about you",
        "is wrong — the hours, the address, the name, how you would like to be",
        "described. We change it the same day.",
        "",
        "You will not be added to a marketing list because of this claim.",
        "",
        "Andre",
        "NUM · 5arz Inc.",
        LEGAL_LINE,
      ].join("\n");

  return sendBatch(env, [{
    // One receipt per claim, even if the form is submitted twice.
    __idem: "claimwelcome-" + lc(c.email) + "-" + (c.dest || "x"),
    from: env.MAIL_FROM || "NUM <info@itsnum.com>",
    to: [c.email],
    reply_to: "info@itsnum.com",
    subject,
    text,
  }]);
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
    // 6 Sep 2026 - THE LINE THAT COST US EVERY FOUNDING HOST.
    //
    // "Who you look after, and where they travel" used to be written by a
    // THIRD statement in this batch: `UPDATE num_hosts SET about = ?`. There
    // is no `about` column on num_hosts - the column is `notes`. Every real
    // signup threw `no such column: about`, and because a D1 batch is ATOMIC
    // the host row and the referral code rolled back with it. The endpoint
    // 500d, the page's `r.json()` threw on the HTML error body, and the
    // person read "Could not reach NUM. Check your connection - nothing was
    // created."
    //
    // Accidentally true and completely misleading: their connection was fine,
    // it was OUR write that failed. `num_hosts` held ZERO rows - this had
    // never once worked, and every founding host who tried was lost in
    // silence. Folded into the INSERT: one statement cannot disagree with
    // itself, and a column that does not exist now fails where a test sees it.
    env.DB.prepare(
      `INSERT INTO num_hosts
         (id,name,company,email,phone,country,code,host_bps,term_months,status,
          terms_version,agreed_at,agreed_ip,console_key,created_at,notes)
       VALUES (?,?,?,?,?,?,?,?,12,'active',?,?,?,?,?,?)`
    ).bind(
      hostId, name, clean(b.company, 120), email, e164(b.phone), country(req),
      code, bps, TERMS_VERSION, now(),
      String(b.terms_text || "").slice(0, 1200), consoleKey, now(),
      clean(b.notes || b.about, 4000)
    ),
  ]);

  const link = site + "/r/" + code;
  const consoleUrl = site + "/host/?k=" + consoleKey;

  // Their link, in writing, in their inbox. A host who loses the tab has lost
  // the programme otherwise.
  ctx.waitUntil(sendBatch(env, [{
    __idem: "hostwelcome-" + hostId,
    from: env.MAIL_FROM || "NUM <info@itsnum.com>",
    to: [email],
    replyTo: ["info@itsnum.com"],
    subject: "Your NUM host account — " + code,
    text:
`Hi ${name},

You're in. Here is your console — your clients, your services, your
prices, and the work coming in:

${consoleUrl}

Keep that link private. It opens your account without a password.

Your clients stay yours. NUM does not become their concierge, does not
charge them anything, and does not take a commission from what they
spend with you. We are the back office, not the front desk.

What you pay: one monthly plan, free to start. That is the whole of it —
no fee per booking, no commission on your work, no cut of anything you
arrange. Confirm one job this month or a hundred and the bill is the
same. Your plan does not limit how many clients you can have either — we
are not going to charge you for the size of a book you spent years
building. Paying more unlocks more of the tool: the calendar feed and
text alerts, then the host network and new clients from us, then
products. Never more room.

This is your invite link, for anyone you want to bring in yourself:

${link}

You can also paste in the people you already look after and we'll send
the invitation for you, with your name on it. One message each. If they
don't say yes, they never hear from us again.

— Viv
NUM, by 5arz · ${LEGAL_LINE}
Reply to this email and a person answers.`,
    headers: { "List-Unsubscribe": "<mailto:info@itsnum.com?subject=unsubscribe>" },
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

/* ------------------------------------------------ /api/host/profile  R/W */

/** The service vocabulary. Shared with num_commissions.category so a host's
 *  services and our commission categories cannot drift into two lists that
 *  mean the same thing and match on nothing. */
const HOST_SERVICES = ["car", "reservation", "stay", "activity", "appointment", "delivery"];
const HOST_UNITS = ["hour", "day", "trip", "person", "item", "quote"];
const HOST_FULFILMENT = ["delivered", "on_site", "either"];
const HOST_TIERS = ["free", "small", "pro", "full"];

/** Normalise one price line. Returns null for a line we will not store.
 *
 * Money is validated HARD here because this is the number a host's own client
 * is quoted. A malformed price that reaches a guest is worse than a missing
 * one: the missing one asks, the malformed one promises. `unit: "quote"` is
 * the honest escape hatch — the price is agreed per request, and price_minor
 * is forced to 0 rather than left as whatever was typed before they switched.
 */
function priceLine(raw) {
  if (!raw || typeof raw !== "object") return null;
  const key = String(raw.key || "").trim().toLowerCase();
  if (HOST_SERVICES.indexOf(key) === -1) return null;
  const unit = HOST_UNITS.indexOf(String(raw.unit || "")) === -1 ? "quote" : String(raw.unit);
  const fulfilment = HOST_FULFILMENT.indexOf(String(raw.fulfilment || "")) === -1
    ? "either" : String(raw.fulfilment);
  var minor = Math.round(Number(raw.price_minor));
  if (!isFinite(minor) || minor < 0 || minor > 100000000) minor = 0;
  if (unit === "quote") minor = 0;
  return {
    key: key,
    label: clean(raw.label, 80) || key,
    price_minor: minor,
    unit: unit,
    fulfilment: fulfilment,
    notes: clean(raw.notes, 240),
  };
}

async function hostProfile(req, env, url, ctx) {
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: "unauthorised" }, 401);

  const row = await env.DB.prepare(
    `SELECT services_json, pricing_json, areas_json, charge_mode, currency, tier,
            notify_phone, sms_opt_in, calendar_token, profile_updated_at,
            accepts_intros, in_network, blurb
       FROM num_hosts WHERE id = ?`
  ).bind(host.id).first();

  const read = () => J({
    ok: true,
    name: host.name,
    status: host.status,
    services: JSON.parse((row && row.services_json) || "[]"),
    pricing: JSON.parse((row && row.pricing_json) || "[]"),
    areas: JSON.parse((row && row.areas_json) || "[]"),
    charge_mode: (row && row.charge_mode) || "own",
    currency: (row && row.currency) || "GBP",
    tier: (row && row.tier) || "free",
    notify_phone: (row && row.notify_phone) || "",
    sms_opt_in: !!(row && row.sms_opt_in),
    // The subscribe URL, not the token. A calendar feed is readable by anyone
    // holding its link, so it is minted on demand and shown once here rather
    // than sprayed through every summary response.
    calendar_url: (row && row.calendar_token)
      ? (env.SITE || "https://itsnum.com") + "/api/host/calendar.ics?t=" + row.calendar_token
      : null,
    profile_updated_at: (row && row.profile_updated_at) || null,
    // Both default OFF in 0014 and are read back as booleans so the console can
    // never render "on" against a column it did not actually set.
    accepts_intros: !!(row && row.accepts_intros),
    in_network: !!(row && row.in_network),
    blurb: (row && row.blurb) || "",
    tiers: HOST_TIERS.map(function (t) {
      return { key: t, price: HOST_TIER_PRICE[t], pence: HOST_TIER_PENCE[t],
               clients: HOST_TIER_CLIENTS, features: HOST_TIER_FEATURES[t] || [] };
    }),
    vocabulary: { services: HOST_SERVICES, units: HOST_UNITS, fulfilment: HOST_FULFILMENT },
  });

  if (req.method === "GET") return read();
  if (req.method !== "POST") return J({ ok: false, error: "method" }, 405);
  if (badOrigin(req)) return J({ ok: false }, 403);
  if (host.status !== "active") return J({ ok: false, error: "host_not_active" }, 403);

  let b;
  try { b = await readJSON(req, 65536); } catch (e) { return J({ ok: false, error: "bad_body" }, 400); }

  const services = (Array.isArray(b.services) ? b.services : [])
    .map(function (x) { return String(x || "").trim().toLowerCase(); })
    .filter(function (x, i, a) { return HOST_SERVICES.indexOf(x) !== -1 && a.indexOf(x) === i; });

  const pricing = (Array.isArray(b.pricing) ? b.pricing : [])
    .slice(0, 40).map(priceLine).filter(Boolean);

  /* WHERE THEY WORK.
   *
   * Until now areas_json was read but never written, so every host's coverage
   * was the empty array it was created with — which meant nearest-host
   * matching had nothing to match on and would have returned nobody, forever,
   * silently. Saved here, and mirrored into num_host_areas so the match is an
   * indexed query rather than a scan. */
  const areas = (Array.isArray(b.areas) ? b.areas : [])
    .slice(0, 20).map(areaLine).filter(Boolean);

  /* THE TWO SWITCHES THAT PUT A STRANGER NEAR THEIR BOOK.
   *
   * Both fail closed, and both are only ever turned on by an explicit `true`.
   * A host's book is the thing they spent years building; it is not something
   * we opt them into because a field was absent. */
  const acceptsIntros = (b.accepts_intros === true || b.accepts_intros === 1) ? 1 : 0;
  const inNetwork = (b.in_network === true || b.in_network === 1) ? 1 : 0;
  const blurb = clean(b.blurb, 240);

  /* WHO TAKES THE MONEY.
   *
   * 'num' is only honoured when it is asked for explicitly. Collecting on a
   * host's behalf makes NUM a payment intermediary for their business and
   * attaches their refunds, chargebacks and tax position to us — that is a
   * decision, never a default, and never the result of an absent field. An
   * unrecognised value falls back to 'own' for the same reason. */
  const chargeMode = b.charge_mode === "num" ? "num" : "own";

  const currency = /^[A-Za-z]{3}$/.test(String(b.currency || ""))
    ? String(b.currency).toUpperCase() : "GBP";

  /* THE PLAN IS NOT A FIELD ON THIS FORM.
   *
   * It used to be. `tier` arrived in the profile body and was written straight
   * to num_hosts.tier — which was harmless while tiers were a note about what
   * a host intended to buy, and became a FREE UPGRADE BUTTON the moment
   * FEATURE_MIN_TIER started gating the network, introductions and products on
   * that same column. Anyone holding a console key could POST {"tier":"full"}
   * and unlock everything.
   *
   * A tier is now only ever set by money changing hands: grantHostTier() on a
   * Stripe webhook, or lapseHostBySub() on cancellation, both in
   * worker/hostmoney.mjs. This endpoint reads the current value and writes it
   * back unchanged, so a host editing their prices cannot move their plan and
   * a stale form cannot silently downgrade them either. */
  const tier = (row && HOST_TIER_PRICE[row.tier] !== undefined) ? row.tier : "free";

  /* SMS consent is a positive act, and the number has to survive it.
   * `sms_opt_in` can only be 1 when there is a valid number to send to —
   * otherwise the dashboard would show "texts on" against nothing, and the
   * first missed request would be blamed on the agent rather than on this. */
  const notifyPhone = okPhone(b.notify_phone) ? e164(b.notify_phone) : null;
  // Text alerts are on the small plan and up. The number is still SAVED on any
  // plan — a host who downgrades should not have to retype it to come back —
  // but the switch that actually sends is what the plan buys.
  const smsOptIn = (b.sms_opt_in === true || b.sms_opt_in === 1)
                   && notifyPhone && hostCan(tier, "sms") ? 1 : 0;

  // Minted once, on the first save that asks for it, and never rotated here —
  // a calendar the host has already subscribed to must not go dead because
  // they edited a price.
  const calendarToken = (row && row.calendar_token) ? row.calendar_token : token(18);

  await env.DB.prepare(
    `UPDATE num_hosts
        SET services_json = ?, pricing_json = ?, areas_json = ?, charge_mode = ?,
            currency = ?, tier = ?, notify_phone = ?, sms_opt_in = ?,
            calendar_token = ?, accepts_intros = ?, in_network = ?, blurb = ?,
            profile_updated_at = ?, updated_at = ?
      WHERE id = ?`
  ).bind(
    JSON.stringify(services), JSON.stringify(pricing), JSON.stringify(areas),
    chargeMode, currency, tier, notifyPhone, smsOptIn, calendarToken,
    acceptsIntros, inNetwork, blurb, now(), now(), host.id
  ).run();

  /* Ticking the box has to reach the consent register, or it is a switch
   * wired to nothing.
   *
   * Since migration 0013 a host could tick "text me", see it saved, and never
   * receive anything — because every sender in this codebase asks
   * num_sms_consent first and fails closed, correctly, when there is no row.
   * The box set a boolean nobody consulted. This is the wire. */
  if (smsOptIn && notifyPhone) {
    await ensureSmsConsent(env);
    await env.DB.prepare(
      `INSERT INTO num_sms_consent
         (id, phone, first_name, consent_text, consent_version, page, ip, user_agent, country, created_at, revoked_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,NULL)
       ON CONFLICT(phone) DO UPDATE SET revoked_at = NULL`
    ).bind(
      "smsc_" + token(8), notifyPhone, clean(host.name, 60),
      "[host/updates] " + PARTNER_CONSENT_TEXT, SMS_CONSENT_VERSION,
      "/host (profile)", req.headers.get("cf-connecting-ip") || "0",
      clean(req.headers.get("user-agent"), 200), country(req), now()
    ).run().catch(function () { /* a failed write must not lose the profile */ });
  } else if (notifyPhone) {
    /* Unticking is a withdrawal, and it has to travel. A host who turns texts
     * off on their dashboard and still gets one has been ignored, whatever the
     * boolean says. */
    await env.DB.prepare(
      "UPDATE num_sms_consent SET revoked_at = ? WHERE phone = ?"
    ).bind(now(), notifyPhone).run().catch(function () {});
  }

  // The shadow table follows the host's own copy, never the other way round.
  await syncHostAreas(env, host.id, areas);

  const after = await env.DB.prepare(
    `SELECT services_json, pricing_json, areas_json, charge_mode, currency, tier,
            notify_phone, sms_opt_in, calendar_token, profile_updated_at,
            accepts_intros, in_network, blurb
       FROM num_hosts WHERE id = ?`
  ).bind(host.id).first();

  return J({
    ok: true,
    saved: true,
    services: JSON.parse(after.services_json || "[]"),
    pricing: JSON.parse(after.pricing_json || "[]"),
    charge_mode: after.charge_mode,
    currency: after.currency,
    tier: after.tier,
    notify_phone: after.notify_phone || "",
    sms_opt_in: !!after.sms_opt_in,
    calendar_url: (env.SITE || "https://itsnum.com") + "/api/host/calendar.ics?t=" + after.calendar_token,
    areas: JSON.parse(after.areas_json || "[]"),
    accepts_intros: !!after.accepts_intros,
    in_network: !!after.in_network,
    blurb: after.blurb || "",
    profile_updated_at: after.profile_updated_at,
    // Said back plainly. A host who asked us to collect and a host who did not
    // are in materially different relationships with NUM, and the UI should
    // never have to infer which one happened.
    note: chargeMode === "num"
      ? "NUM will collect from your clients and settle to you."
      : "Your clients pay you directly. NUM never touches that money.",
  });
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

/* ══════════════════════════════════════════════════════════════════════════
 * THE HOST'S BOOK — clients, work, products, network, introductions
 *
 * Everything below is written from one premise: THE HOST IS OUR CUSTOMER AND
 * THE CLIENT IS THEIRS. NUM is the back office. That is not a slogan, it is a
 * constraint, and it shows up as four rules that are enforced here and not
 * merely described in the copy:
 *
 *   1. NUM never bills a host's client. There is no price field anywhere in
 *      this file that a client is charged by us. The host pays a monthly plan;
 *      the plan is capped by client count; the client pays nothing to NUM.
 *   2. NUM never contacts a host's client first. Client rows are created from
 *      the host's own attestation, and an introduction reaches a host only
 *      after the MEMBER asked for it and the HOST accepted it.
 *   3. NUM never confirms on a host's behalf. `confirmed` is reachable only
 *      through an explicit confirm action taken by the holder of the console
 *      key. There is no auto-confirm branch to find later.
 *   4. NUM never enters a host-to-host job. Host B invoices Host A. We record
 *      the link and take a flat network fee. We do not hold the money.
 * ══════════════════════════════════════════════════════════════════════════ */

/** THE HOST'S SUBSCRIPTION IS NOT PRICED PER CLIENT.
 *
 *  There is no client cap on any tier, and this is a commercial decision, not
 *  an oversight. A concierge's book is the thing they spent years building; a
 *  per-head price charges them for their own success, and — worse — makes
 *  their first instinct to keep clients OUT of NUM, which breaks the product
 *  long before it improves the invoice. The plan buys the tool. What the host
 *  does with it is theirs.
 *
 *  So the tiers differentiate on CAPABILITY. `used` is still counted and shown,
 *  because a host wants to know the size of their own book — but it is never a
 *  ceiling, and no code path anywhere refuses a client because of it. */
const HOST_TIER_CLIENTS = -1;                                        // every tier. no exceptions.

/* THE PRICES A HOST IS SHOWN.
 *
 * The prices a host is CHARGED live in worker/hostmoney.mjs `HOST_PLANS`, in
 * pence, because that is what mints the Stripe session. These two lists sit in
 * different workers on different hostnames and cannot import each other, so
 * one number exists twice — the exact shape of bug where a host reads £9.99
 * and is charged something else.
 *
 * growth/hostbilling.test.mjs reads both files and fails if they disagree. It
 * is the only thing keeping them honest: change a price here, change it there
 * in the same commit. */
const HOST_TIER_PENCE  = { free: 0, small: 999, pro: 1999, full: 5000 };
const HOST_TIER_PRICE  = { free: "Free", small: "£9.99/mo", pro: "£19.99/mo", full: "£50/mo" };
const HOST_TIER_FEATURES = {
  free:  ["Unlimited clients", "Your services and prices", "Requests and drafts"],
  small: ["Everything in Free", "Text alerts", "Calendar feed"],
  pro:   ["Everything in Small", "The host network", "Introductions from NUM"],
  full:  ["Everything in Pro", "Products and Ghost Message", "Your services promoted"],
};

/** WHAT A TIER ACTUALLY BUYS.
 *
 *  If the tiers gate nothing, they are decoration and nobody upgrades. If they
 *  gate the wrong thing, they punish a host for having clients. So the line is
 *  drawn deliberately: EVERY tier, including free, can hold unlimited clients,
 *  set prices, take requests and get drafts — the work itself is never behind
 *  a paywall, because a host whose clients are stuck is a host who leaves.
 *  What money buys is REACH and LEVERAGE: alerts, then other people's books
 *  and new clients from us, then a shelf to sell from. */
const HOST_TIER_RANK = { free: 0, small: 1, pro: 2, full: 3 };
const FEATURE_MIN_TIER = {
  sms: "small",
  calendar: "small",
  network: "pro",
  intros: "pro",
  products: "full",
};
const FEATURE_LABEL = {
  sms: "Text alerts", calendar: "Calendar feed", network: "The host network",
  intros: "Introductions from NUM", products: "Products and Ghost Message",
};

function hostCan(tier, feature) {
  const need = FEATURE_MIN_TIER[feature];
  if (!need) return true;
  return (HOST_TIER_RANK[tier] || 0) >= HOST_TIER_RANK[need];
}

/** The refusal a host can act on. 402 with what it is, what unlocks it, and
 *  what that costs — never a bare "forbidden" they have to go and ask about. */
function needsTier(feature) {
  const need = FEATURE_MIN_TIER[feature];
  return J({
    ok: false,
    error: "needs_tier",
    feature: feature,
    label: FEATURE_LABEL[feature],
    needs_tier: need,
    price: HOST_TIER_PRICE[need],
    note: FEATURE_LABEL[feature] + " is on the " + need + " plan (" + HOST_TIER_PRICE[need] +
          "). Your clients and your prices are not affected, and nothing you already have is taken away.",
  }, 402);
}
const HOST_PRODUCT_KINDS = ["own", "num", "ghost"];
const NUM_PRODUCTS = ["tab", "membership", "concierge"];
const HOST_REQ_STATUS = ["new", "drafted", "awaiting_host", "confirmed", "declined", "done", "cancelled"];
const CLIENT_SOURCES = ["host_added", "num_offer", "self_joined"];

/** NUM's flat fee on a host-to-host job, in the requesting host's currency.
 *  Flat, not a percentage, and deliberately small: we are being paid for the
 *  introduction and the record, not for the work. A percentage would give us
 *  an interest in the size of a job we are not doing. */
const NETWORK_FEE_MINOR = 500;

/** The consent attestation minimum, in characters. Identical to the rule
 *  already enforced on /api/host/contacts, on purpose — a host adding one
 *  client by hand and a host pasting forty are making the same claim about
 *  the same people, and a shorter answer here would be the loophole. */
const CLIENT_CONSENT_MIN = 40;

/** Where a host stands against their plan. Read before every insert that
 *  could grow the book, and returned on every GET so the console can show the
 *  ceiling BEFORE it is hit rather than as an error after. */
async function hostPlan(env, hostId) {
  const row = await env.DB.prepare(
    "SELECT tier, plan_status, plan_renews_at FROM num_hosts WHERE id = ?"
  ).bind(hostId).first();
  const tier = (row && HOST_TIER_PRICE[row.tier] !== undefined) ? row.tier : "free";
  const used = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM num_host_clients WHERE host_id = ? AND status = 'active'"
  ).bind(hostId).first();
  const n = (used && used.n) || 0;
  return {
    tier: tier,
    price: HOST_TIER_PRICE[tier],
    features: HOST_TIER_FEATURES[tier] || [],
    limit: HOST_TIER_CLIENTS,        // -1, on every tier
    used: n,
    // `full` is kept and is ALWAYS false. It stays because callers read it,
    // and because a constant false is a louder statement than a deleted field:
    // there is no state in which NUM refuses a host a client.
    full: false,
    plan_status: (row && row.plan_status) || "none",
    renews_at: (row && row.plan_renews_at) || null,
    booking_fee_minor: BOOKING_FEE_MINOR,
    pence: HOST_TIER_PENCE[tier],
    can: Object.keys(FEATURE_MIN_TIER).reduce(function (acc, f) {
      acc[f] = hostCan(tier, f); return acc;
    }, {}),
    // The whole money story, in one sentence a host can repeat to a client.
    note: n === 1
      ? "1 client. Your plan does not limit how many you can have, and none of them are charged by NUM."
      : n + " clients. Your plan does not limit how many you can have, and none of them are charged by NUM.",
  };
}

/* ------------------------------------------------- /api/host/clients  R/W */

function clientRow(r, site) {
  return {
    id: r.id, name: r.name, email: r.email || "", phone: r.phone || "",
    home_city: r.home_city || "", home_country: r.home_country || "",
    languages: r.languages || "", notes: r.notes || "",
    source: r.source, status: r.status, created_at: r.created_at,
    ended_at: r.ended_at || null, ended_by: r.ended_by || null,
    // Their own way out, for the host to hand over. Shown to the host on
    // purpose: this is not a back door we hide from them, it is a thing they
    // can offer, and a host who offers it looks better than one who does not.
    member_link: r.member_token ? site + "/my-host/?t=" + r.member_token : null,
  };
}

async function hostClients(req, env, url, ctx) {
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: "unauthorised" }, 401);

  const list = async () => {
    const [rows, plan] = await Promise.all([
      env.DB.prepare(
        `SELECT id,name,email,phone,home_city,home_country,languages,notes,source,status,
                member_token,ended_at,ended_by,created_at
           FROM num_host_clients WHERE host_id = ? AND status <> 'removed'
          ORDER BY status ASC, name ASC LIMIT 500`
      ).bind(host.id).all(),
      hostPlan(env, host.id),
    ]);
    const site = env.SITE || "https://itsnum.com";
    return J({
      ok: true,
      clients: ((rows && rows.results) || []).map(function (r) { return clientRow(r, site); }),
      plan: plan,
    });
  };

  if (req.method === "GET") return list();
  if (req.method !== "POST") return J({ ok: false, error: "method" }, 405);
  if (badOrigin(req)) return J({ ok: false }, 403);
  if (host.status !== "active") return J({ ok: false, error: "host_not_active" }, 403);

  let b;
  try { b = await readJSON(req, 65536); } catch (e) { return J({ ok: false, error: "bad_body" }, 400); }
  const action = String(b.action || "add");

  /* REMOVING IS NOT PAUSING, AND IT DOES NOT SHARE THEIR CODE PATH.
   *
   * Pause is bookkeeping: the client stays in the book, greyed out, and the
   * host is not billed for them. Nobody needs telling, because nothing about
   * the relationship ended.
   *
   * Remove ends a relationship with a person who is not in the room, so it
   * goes through endClient — which records who ended it, tells them, and
   * stops billing the host the £5. The fee moves to nobody: NUM does not
   * charge a traveller (worker/servicefee.mjs). Silently flipping a status
   * would leave that person believing they still have a concierge. */
  if (action === "remove") {
    const id = clean(b.id, 40);
    if (!id) return J({ ok: false, error: "no_id" }, 400);
    const row = await env.DB.prepare(
      "SELECT * FROM num_host_clients WHERE id = ? AND host_id = ?"
    ).bind(id, host.id).first();
    if (!row) return J({ ok: false, error: "not_found" }, 404);
    await endClient(env, ctx, {
      host: { id: host.id, name: host.name, email: host.email },
      client: row,
      ended_by: "host",
      reason: b.reason,
    });
    return list();
  }

  if (action === "pause" || action === "resume") {
    const id = clean(b.id, 40);
    if (!id) return J({ ok: false, error: "no_id" }, 400);
    const next = action === "pause" ? "paused" : "active";

    // Nothing to check. There is no cap to breach — resuming a client is the
    // host putting someone back in their own book, and it is not ours to
    // refuse. Removed rows are NOT resumable: coming back is a new consent,
    // not an undo, and the person who left gets to give it.
    await env.DB.prepare(
      "UPDATE num_host_clients SET status = ?, updated_at = ? WHERE id = ? AND host_id = ? AND status <> 'removed'"
    ).bind(next, now(), id, host.id).run();
    return list();
  }

  if (action === "update") {
    const id = clean(b.id, 40);
    if (!id) return J({ ok: false, error: "no_id" }, 400);
    await env.DB.prepare(
      `UPDATE num_host_clients
          SET name = COALESCE(NULLIF(?,''), name), phone = ?, home_city = ?,
              home_country = ?, languages = ?, notes = ?, updated_at = ?
        WHERE id = ? AND host_id = ?`
    ).bind(
      clean(b.name, 120), e164(b.phone) || null, clean(b.home_city, 80),
      clean(b.home_country, 60), clean(b.languages, 120), clean(b.notes, 2000),
      now(), id, host.id
    ).run();
    return list();
  }

  /* ADD.
   *
   * Two gates, and neither is decoration.
   *
   * The attestation is a lawful-basis claim about someone who is not in the
   * room. We keep the exact words the host was shown, not a version string,
   * because in a complaint the question is what THIS host agreed to on THIS
   * day and a pointer to a document we have since edited does not answer it.
   *
   * The attestation is the ONLY gate. There is deliberately no second one:
   * the plan does not cap clients, so there is no version of this endpoint
   * that refuses a host a person because of what they pay us. */
  const consent = String(b.consent_text || "").trim();
  if (consent.length < CLIENT_CONSENT_MIN) {
    return J({ ok: false, error: "consent_required", min: CLIENT_CONSENT_MIN }, 400);
  }

  const name = clean(b.name, 120);
  if (!name) return J({ ok: false, error: "no_name" }, 400);
  const email = String(b.email || "").trim();
  if (email && !okEmail(email)) return J({ ok: false, error: "bad_email" }, 400);

  // A person who has asked NUM never to contact them again is not made
  // contactable by a host asserting otherwise. The suppression list wins.
  //
  // 3 Sep 2026: it did not win. Both suppression checks queried `email_lc`,
  // a column num_suppressions does not have, and both swallowed the error —
  // so every lookup returned "not suppressed" and the guard has never once
  // fired. A silent catch turned a legal obligation into a no-op.
  if (email) {
    const supp = await env.DB.prepare(
      "SELECT 1 AS x FROM num_suppressions WHERE lower(email) = ?"
    ).bind(lc(email)).first().catch(function () { return null; });
    if (supp) return J({ ok: false, error: "suppressed" }, 409);
  }

  const id = "hc_" + token(10);
  try {
    await env.DB.prepare(
      `INSERT INTO num_host_clients
         (id,host_id,name,email,email_lc,phone,home_city,home_country,languages,
          notes,source,consent_basis,consent_text,status,member_token,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'host_added','host_asserted',?,'active',?,?)`
    ).bind(
      id, host.id, name, email || null, email ? lc(email) : null,
      e164(b.phone) || null, clean(b.home_city, 80), clean(b.home_country, 60),
      clean(b.languages, 120), clean(b.notes, 2000), consent.slice(0, 1200),
      // Minted for EVERY client, not only introduced ones, so a host can hand
      // their own client the same way out. A host who says "here is how to
      // remove yourself from this" is making an argument for themselves.
      token(20), now()
    ).run();
  } catch (e) {
    // The unique index on (host_id, email_lc) is doing its job: a host pasting
    // the same list twice must not double their own bill.
    return J({ ok: false, error: "already_in_your_book" }, 409);
  }
  return list();
}

/* ------------------------------------------------ /api/host/products  R/W */

/** One product line, normalised. The three kinds share a table because a host
 *  thinks of them as one shelf, but they do NOT share validation:
 *
 *  'ghost' is the strict one. A Ghost Message code that resolves to nothing is
 *  the single failure that makes the whole primitive untrustworthy — the buyer
 *  texted a code off a card and got silence — so a ghost line cannot go active
 *  without a SKU, a keyword, a photo and a real price. That is the Resolution
 *  Rule from the Ghost spec, enforced here and again by a CHECK in 0014.
 *
 *  'num' is a NUM product the host resells. The price is OURS, so the host
 *  does not get to set it: price_minor is forced to 0 and the live price is
 *  read from our catalogue at display time. A host quoting a NUM price we
 *  later change would be the one who looks wrong to their client. */
function productLine(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = HOST_PRODUCT_KINDS.indexOf(String(raw.kind || "")) === -1 ? null : String(raw.kind);
  if (!kind) return null;
  const name = clean(raw.name, 120);
  if (!name) return null;

  var minor = Math.round(Number(raw.price_minor));
  if (!isFinite(minor) || minor < 0 || minor > 100000000) minor = 0;

  const out = {
    kind: kind,
    name: name,
    description: clean(raw.description, 1200),
    category: clean(raw.category, 60),
    price_minor: minor,
    currency: /^[A-Za-z]{3}$/.test(String(raw.currency || "")) ? String(raw.currency).toUpperCase() : "GBP",
    unit: HOST_UNITS.indexOf(String(raw.unit || "")) === -1 ? "item" : String(raw.unit),
    photo_url: cleanUrl(raw.photo_url, 400),
    sku: null, keyword: null, num_product: null,
    active: raw.active === true || raw.active === 1 ? 1 : 0,
  };

  if (kind === "num") {
    out.num_product = NUM_PRODUCTS.indexOf(String(raw.num_product || "")) === -1 ? "tab" : String(raw.num_product);
    out.price_minor = 0;                                  // our price, not theirs
  }

  if (kind === "ghost") {
    out.sku = String(raw.sku || "").replace(/[^0-9]/g, "").slice(0, 12) || null;
    out.keyword = String(raw.keyword || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24) || null;
    // Fails CLOSED. A ghost line missing any part of what makes a code
    // resolve is stored as a draft, never as something a client can text.
    if (!out.sku || !out.keyword || !out.photo_url || out.price_minor <= 0) out.active = 0;
  }

  return out;
}

async function hostProducts(req, env, url) {
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: "unauthorised" }, 401);

  const list = async () => {
    const rows = await env.DB.prepare(
      `SELECT id,kind,sku,keyword,name,description,category,price_minor,currency,unit,
              photo_url,num_product,moderation,active,created_at
         FROM num_host_products WHERE host_id = ? ORDER BY kind ASC, name ASC LIMIT 300`
    ).bind(host.id).all();
    return J({
      ok: true,
      products: (rows && rows.results) || [],
      vocabulary: { kinds: HOST_PRODUCT_KINDS, units: HOST_UNITS, num_products: NUM_PRODUCTS },
      // Said out loud so a host is never guessing why a code is not live.
      ghost_rule: "A Ghost Message line needs a SKU, a keyword, a photo and a price before it can go live. A code that resolves to nothing is worse than no code.",
    });
  };

  if (req.method === "GET") return list();
  if (req.method !== "POST") return J({ ok: false, error: "method" }, 405);
  if (badOrigin(req)) return J({ ok: false }, 403);
  if (host.status !== "active") return J({ ok: false, error: "host_not_active" }, 403);

  // Reading the shelf is free — a host on any plan can see what this is and
  // what they already saved. Writing to it is what the full plan buys.
  const plan = await hostPlan(env, host.id);
  if (!hostCan(plan.tier, "products")) return needsTier("products");

  let b;
  try { b = await readJSON(req, 65536); } catch (e) { return J({ ok: false, error: "bad_body" }, 400); }

  if (String(b.action || "") === "delete") {
    const id = clean(b.id, 40);
    if (!id) return J({ ok: false, error: "no_id" }, 400);
    await env.DB.prepare("DELETE FROM num_host_products WHERE id = ? AND host_id = ?")
      .bind(id, host.id).run();
    return list();
  }

  const p = productLine(b.product || b);
  if (!p) return J({ ok: false, error: "bad_product" }, 400);

  const id = clean(b.id || (b.product && b.product.id), 40);
  try {
    if (id) {
      await env.DB.prepare(
        `UPDATE num_host_products
            SET kind=?,sku=?,keyword=?,name=?,description=?,category=?,price_minor=?,
                currency=?,unit=?,photo_url=?,num_product=?,active=?,updated_at=?
          WHERE id = ? AND host_id = ?`
      ).bind(
        p.kind, p.sku, p.keyword, p.name, p.description, p.category, p.price_minor,
        p.currency, p.unit, p.photo_url, p.num_product, p.active, now(), id, host.id
      ).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO num_host_products
           (id,host_id,kind,sku,keyword,name,description,category,price_minor,currency,
            unit,photo_url,num_product,moderation,active,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`
      ).bind(
        "hp_" + token(10), host.id, p.kind, p.sku, p.keyword, p.name, p.description,
        p.category, p.price_minor, p.currency, p.unit, p.photo_url, p.num_product,
        p.active, now()
      ).run();
    }
  } catch (e) {
    return J({ ok: false, error: "duplicate_sku_or_keyword" }, 409);
  }
  return list();
}

/* ------------------------------------------------ /api/host/requests  R/W */

async function hostRequests(req, env, url, ctx) {
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: "unauthorised" }, 401);

  const list = async () => {
    const rows = await env.DB.prepare(
      `SELECT r.id,r.client_id,r.service_key,r.title,r.detail,r.city,r.country,
              r.starts_at,r.ends_at,r.party_size,r.price_minor,r.currency,r.unit,
              r.quote_only,r.status,r.draft_text,r.network_host_id,r.network_status,
              r.network_fee_minor,r.booking_fee_minor,r.created_at,r.confirmed_at,
              c.name AS client_name
         FROM num_host_requests r
         LEFT JOIN num_host_clients c ON c.id = r.client_id
        WHERE r.host_id = ? ORDER BY r.created_at DESC LIMIT 300`
    ).bind(host.id).all();
    const list_ = (rows && rows.results) || [];
    return J({
      ok: true,
      requests: list_,
      statuses: HOST_REQ_STATUS,
      booking_fee_minor: BOOKING_FEE_MINOR,          // 0 — see worker/servicefee.mjs
      // Historical only. Anything accrued before 7 Sep 2026 stays visible so a
      // host can see it was never collected, rather than a number quietly
      // disappearing from a page they had already read.
      fees_minor: list_.reduce(function (n, r) { return n + (r.booking_fee_minor || 0); }, 0),
    });
  };

  if (req.method === "GET") return list();
  if (req.method !== "POST") return J({ ok: false, error: "method" }, 405);
  if (badOrigin(req)) return J({ ok: false }, 403);
  if (host.status !== "active") return J({ ok: false, error: "host_not_active" }, 403);

  let b;
  try { b = await readJSON(req, 65536); } catch (e) { return J({ ok: false, error: "bad_body" }, 400); }
  const action = String(b.action || "create");

  /* CONFIRM IS ITS OWN ACTION AND ITS OWN CODE PATH.
   *
   * This is rule 3, and this is where it lives. There is no branch anywhere in
   * this file that sets status='confirmed' as a consequence of something else
   * happening — not a draft being written, not a client replying, not a timer
   * expiring. A commitment to a host's own client is made by the host, and the
   * only way to reach that state is for the holder of the console key to say
   * so. If you are ever asked to add an auto-confirm, this comment is the
   * argument against it: the host is the first point of contact, and an agent
   * that commits on their behalf makes them absent rather than organised. */
  if (action === "confirm" || action === "decline" || action === "done" || action === "cancel") {
    const id = clean(b.id, 40);
    if (!id) return J({ ok: false, error: "no_id" }, 400);
    const next = action === "confirm" ? "confirmed"
               : action === "decline" ? "declined"
               : action === "done" ? "done" : "cancelled";
    /* THE BOOKING FEE LANDS HERE, ON THE HOST, AND ONLY ON CONFIRM.
     *
     * CHANGED 7 SEP 2026 — there is no per-booking fee. BOOKING_FEE_MINOR is
     * 0, so the write below stamps a zero and nothing accrues.
     *
     * The reason is worth keeping, because someone will propose it again: a
     * per-booking fee is a tax on using the product. Every confirm cost the
     * host money, so the rational move was to confirm less in NUM and keep the
     * rest on WhatsApp — starving the system of the data that makes it useful,
     * to collect five pounds. And it could not be collected anyway: most hosts
     * sit on free, a free host has no card, and the sweep skipped them.
     *
     * The column and the write stay rather than being deleted: rows from
     * before today keep their history, worker/hostmoney.mjs's sweep selects
     * `booking_fee_minor > 0` and so finds nothing new, and if a fee ever
     * returns it returns in exactly one place. Revenue is the subscription. */
    await env.DB.prepare(
      `UPDATE num_host_requests
          SET status = ?,
              confirmed_at = CASE WHEN ? = 'confirmed' THEN COALESCE(confirmed_at, ?) ELSE confirmed_at END,
              booking_fee_minor = CASE WHEN ? = 'confirmed' AND booking_fee_minor = 0 THEN ? ELSE booking_fee_minor END,
              updated_at = ?
        WHERE id = ? AND host_id = ?`
    ).bind(next, next, now(), next, BOOKING_FEE_MINOR, now(), id, host.id).run();

    /* AND NOW — only now — the client hears, over their host's name.
     *
     * This is the step that must never fire before the host has acted. It is
     * guarded by being inside the confirm branch and nowhere else. */
    if (next === "confirmed") {
      const row = await env.DB.prepare(
        `SELECT r.*, c.name AS c_name, c.email AS c_email, c.id AS c_id
           FROM num_host_requests r LEFT JOIN num_host_clients c ON c.id = r.client_id
          WHERE r.id = ? AND r.host_id = ?`
      ).bind(id, host.id).first();
      if (row && row.c_email && row.client_notified_at == null) {
        await notifyClientOfConfirm(env, ctx, host, row,
          { id: row.c_id, name: row.c_name, email: row.c_email });
      }
    }
    return list();
  }

  /* HAND A JOB TO ANOTHER HOST.
   *
   * Rule 4. We record who is doing it and what our fee is, and that is the
   * whole of NUM's involvement. Host B invoices Host A. NUM does not collect
   * from the client, does not split anything, and never appears to the client
   * at all — which is the only version of this that keeps "your clients stay
   * yours" true when the work crosses a border. */
  if (action === "handoff") {
    const id = clean(b.id, 40);
    const toHost = clean(b.to_host_id, 40);
    if (!id || !toHost) return J({ ok: false, error: "no_id" }, 400);
    const link = await env.DB.prepare(
      `SELECT status FROM num_host_links
        WHERE status = 'accepted'
          AND ((host_a = ? AND host_b = ?) OR (host_a = ? AND host_b = ?))`
    ).bind(host.id, toHost, toHost, host.id).first();
    if (!link) return J({ ok: false, error: "not_connected" }, 403);
    await env.DB.prepare(
      `UPDATE num_host_requests
          SET network_host_id = ?, network_status = 'offered', network_fee_minor = ?, updated_at = ?
        WHERE id = ? AND host_id = ?`
    ).bind(toHost, NETWORK_FEE_MINOR, now(), id, host.id).run();
    return list();
  }

  // CREATE
  const serviceKey = String(b.service_key || "").trim().toLowerCase();
  if (HOST_SERVICES.indexOf(serviceKey) === -1) return J({ ok: false, error: "bad_service" }, 400);
  const title = clean(b.title, 160);
  if (!title) return J({ ok: false, error: "no_title" }, 400);

  const clientId = clean(b.client_id, 40) || null;
  if (clientId) {
    const owned = await env.DB.prepare(
      "SELECT 1 AS x FROM num_host_clients WHERE id = ? AND host_id = ?"
    ).bind(clientId, host.id).first();
    if (!owned) return J({ ok: false, error: "not_your_client" }, 403);
  }

  const unit = HOST_UNITS.indexOf(String(b.unit || "")) === -1 ? "quote" : String(b.unit);
  var minor = Math.round(Number(b.price_minor));
  if (!isFinite(minor) || minor < 0 || minor > 100000000) minor = 0;
  // Same rule as the price list: a 'quote' line carries no number, because an
  // invented number is one the client will hold the host to.
  if (unit === "quote") minor = 0;

  const reqId = "hr_" + token(10);
  await env.DB.prepare(
    `INSERT INTO num_host_requests
       (id,host_id,client_id,service_key,title,detail,city,country,starts_at,ends_at,
        party_size,price_minor,currency,unit,quote_only,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'new',?)`
  ).bind(
    reqId, host.id, clientId, serviceKey, title, clean(b.detail, 4000),
    clean(b.city, 80), clean(b.country, 60), clean(b.starts_at, 40), clean(b.ends_at, 40),
    Math.max(0, Math.min(999, Math.round(Number(b.party_size)) || 0)) || null,
    minor, /^[A-Za-z]{3}$/.test(String(b.currency || "")) ? String(b.currency).toUpperCase() : "GBP",
    unit, unit === "quote" ? 1 : 0, now()
  ).run();

  /* THE HOST IS TOLD. THE CLIENT IS NOT.
   *
   * At this moment there is nothing to tell a client — nobody has agreed to
   * anything, and a message saying "we have received your request" from a
   * company they have never heard of is exactly the intrusion /hosts/
   * promises will not happen. The client hears once, on confirm, over their
   * host's name.
   *
   * Skipped when the host logged it themselves in the console — they are
   * looking at it, and mailing someone about a thing they just typed is how
   * a useful notification becomes noise they filter. */
  if (b.notify_host !== false && b.source !== "console") {
    const clientRow_ = clientId
      ? await env.DB.prepare("SELECT name FROM num_host_clients WHERE id = ?").bind(clientId).first()
      : null;
    await notifyHostOfRequest(env, ctx, host, {
      id: reqId, title: title, city: clean(b.city, 80),
      starts_at: clean(b.starts_at, 40), detail: clean(b.detail, 4000),
    }, clientRow_ ? clientRow_.name : null);
  }

  return list();
}

/* ------------------------------------------------- /api/host/network  R/W */

async function hostNetwork(req, env, url) {
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: "unauthorised" }, 401);

  const list = async () => {
    const [me, dir, links] = await Promise.all([
      env.DB.prepare("SELECT in_network, blurb FROM num_hosts WHERE id = ?").bind(host.id).first(),
      // The directory shows a host, a city, and what they do. It does not show
      // an email or a phone number. Two hosts who want to talk get connected
      // through an accepted link, not by scraping a list.
      env.DB.prepare(
        `SELECT h.id, h.name, h.company, h.blurb, h.services_json, h.currency,
                (SELECT city FROM num_host_areas a WHERE a.host_id = h.id LIMIT 1) AS city
           FROM num_hosts h
          WHERE h.in_network = 1 AND h.status = 'active' AND h.id <> ?
          ORDER BY h.created_at DESC LIMIT 200`
      ).bind(host.id).all(),
      env.DB.prepare(
        `SELECT l.id, l.host_a, l.host_b, l.asked_by, l.status, l.note, l.created_at,
                ha.name AS a_name, hb.name AS b_name
           FROM num_host_links l
           LEFT JOIN num_hosts ha ON ha.id = l.host_a
           LEFT JOIN num_hosts hb ON hb.id = l.host_b
          WHERE l.host_a = ? OR l.host_b = ? ORDER BY l.created_at DESC LIMIT 200`
      ).bind(host.id, host.id).all(),
    ]);
    return J({
      ok: true,
      in_network: !!(me && me.in_network),
      blurb: (me && me.blurb) || "",
      directory: ((dir && dir.results) || []).map(function (h) {
        return {
          host_id: h.id, name: h.name, company: h.company || "", blurb: h.blurb || "",
          city: h.city || "", currency: h.currency || "GBP",
          services: JSON.parse(h.services_json || "[]"),
        };
      }),
      links: ((links && links.results) || []).map(function (l) {
        const otherIsB = l.host_a === host.id;
        return {
          id: l.id,
          host_id: otherIsB ? l.host_b : l.host_a,
          name: otherIsB ? l.b_name : l.a_name,
          status: l.status,
          mine: l.asked_by === host.id,
          note: l.note || "",
        };
      }),
      network_fee_minor: NETWORK_FEE_MINOR,
      how_money_works: "When you hand a job to another host, they invoice you and you bill your client as normal. NUM takes a flat network fee and never touches your client's money.",
    });
  };

  if (req.method === "GET") return list();
  if (req.method !== "POST") return J({ ok: false, error: "method" }, 405);
  if (badOrigin(req)) return J({ ok: false }, 403);
  if (host.status !== "active") return J({ ok: false, error: "host_not_active" }, 403);

  const plan = await hostPlan(env, host.id);
  if (!hostCan(plan.tier, "network")) return needsTier("network");

  let b;
  try { b = await readJSON(req, 16384); } catch (e) { return J({ ok: false, error: "bad_body" }, 400); }
  const action = String(b.action || "");

  if (action === "visibility") {
    const on = (b.in_network === true || b.in_network === 1) ? 1 : 0;
    await env.DB.prepare("UPDATE num_hosts SET in_network = ?, blurb = ?, updated_at = ? WHERE id = ?")
      .bind(on, clean(b.blurb, 240), now(), host.id).run();
    return list();
  }

  if (action === "connect") {
    const other = clean(b.host_id, 40);
    if (!other || other === host.id) return J({ ok: false, error: "bad_host" }, 400);
    const ok = await env.DB.prepare(
      "SELECT 1 AS x FROM num_hosts WHERE id = ? AND in_network = 1 AND status = 'active'"
    ).bind(other).first();
    if (!ok) return J({ ok: false, error: "not_in_network" }, 404);
    // Pair stored low-id-first so the unique index actually prevents the same
    // two hosts holding two links pointing opposite ways.
    const a = host.id < other ? host.id : other;
    const z = host.id < other ? other : host.id;
    try {
      await env.DB.prepare(
        `INSERT INTO num_host_links (id,host_a,host_b,asked_by,status,note,created_at)
         VALUES (?,?,?,?,'pending',?,?)`
      ).bind("hl_" + token(8), a, z, host.id, clean(b.note, 300), now()).run();
    } catch (e) { return J({ ok: false, error: "already_asked" }, 409); }
    return list();
  }

  if (action === "accept" || action === "decline" || action === "end") {
    const id = clean(b.id, 40);
    if (!id) return J({ ok: false, error: "no_id" }, 400);
    const next = action === "accept" ? "accepted" : action === "decline" ? "declined" : "ended";
    // Only the host who did NOT ask may accept. Otherwise a host could ask and
    // then accept on the other's behalf, which is not a connection, it is a
    // list they added themselves to.
    const guard = (action === "accept" || action === "decline")
      ? " AND asked_by <> ? AND status = 'pending'" : "";
    const stmt = env.DB.prepare(
      "UPDATE num_host_links SET status = ?, decided_at = ? WHERE id = ? AND (host_a = ? OR host_b = ?)" + guard
    );
    await (guard
      ? stmt.bind(next, now(), id, host.id, host.id, host.id)
      : stmt.bind(next, now(), id, host.id, host.id)).run();
    return list();
  }

  return J({ ok: false, error: "bad_action" }, 400);
}




/* ══════════════════════════════════════════════════════════════════════════
 * THE LOOP — a request arrives, the host decides, the client hears back.
 *
 * Everything before this was storage. This is the part that makes it a
 * service, and it turns on one rule that is easy to state and easy to break:
 *
 *   NUM NEVER SPEAKS TO A CLIENT IN ITS OWN VOICE.
 *
 * A client hears from their host. When NUM sends that email it is over the
 * host's name, with the host's words where there are any, and the reply
 * address is a thread the host reads. NUM's name appears once, in small
 * print, saying who sent it on their behalf — because pretending a person
 * typed it would be a lie, and putting NUM in the from-line would be us
 * introducing ourselves to somebody else's client.
 *
 * The order is fixed, and each step has exactly one trigger:
 *
 *   client asks ──▶ HOST is told            (never the client — nothing to say yet)
 *   host confirms ─▶ CLIENT is told         in the host's name
 *   client replies ▶ HOST is told           on the same thread
 *   host replies ──▶ CLIENT is told         in the host's name again
 *
 * The thing that must never happen is step two firing before step one — NUM
 * telling a client something the host has not agreed to.
 * ══════════════════════════════════════════════════════════════════════════ */

/** How a message is signed. The host's name in the subject and the sign-off,
 *  NUM once at the bottom as the sender of record. */
function onBehalf(host, env) {
  const site = env.SITE || "https://itsnum.com";
  return "\n\n— " + (host.name || "Your host") +
         "\n\nSent by NUM on " + (host.name || "your host") + "'s behalf. " +
         "Manage how they look after you: " + site + "/my-host/";
}

/** Tell the host a request needs them. Their own client, their own decision —
 *  we are the thing that noticed, not the thing that decided. */
async function notifyHostOfRequest(env, ctx, host, req, clientName) {
  if (!host.email) return;
  const site = env.SITE || "https://itsnum.com";
  ctx.waitUntil(sendBatch(env, [{
    __idem: "reqnew-" + req.id,
    from: env.MAIL_FROM || "NUM <info@itsnum.com>",
    to: [host.email],
    replyTo: ["info@itsnum.com"],
    subject: (clientName ? clientName + ": " : "New request: ") + req.title,
    text:
`${host.name},

${clientName ? clientName + " needs" : "Someone needs"} something${req.city ? " in " + req.city : ""}.

  ${req.title}
${req.starts_at ? "  When: " + req.starts_at + "\n" : ""}${req.detail ? "  Detail: " + req.detail + "\n" : ""}
Nothing has been said to them yet. NUM does not confirm anything to your
client on your behalf — you are their first point of contact and we are not
going to be.

Open it, price it if you need to, and confirm:
${site}/host/

— Viv
NUM, by 5arz · ${LEGAL_LINE}`,
    tags: [{ name: "kind", value: "host_request_new" }],
  }]));
  await env.DB.prepare("UPDATE num_host_requests SET host_notified_at = ? WHERE id = ?")
    .bind(now(), req.id).run();
}

/** Tell the client their host has confirmed. THIS IS THE ONLY EMAIL NUM SENDS
 *  TO A HOST'S CLIENT ABOUT A BOOKING, and it goes out over the host's name. */
async function notifyClientOfConfirm(env, ctx, host, req, client) {
  if (!client || !client.email) return;
  const money = (!req.quote_only && req.price_minor > 0)
    ? "\n  " + (req.currency || "GBP") + " " + (req.price_minor / 100).toFixed(2) : "";
  ctx.waitUntil(sendBatch(env, [{
    __idem: "reqconf-" + req.id,
    from: env.MAIL_FROM || "NUM <info@itsnum.com>",
    to: [client.email],
    replyTo: [host.email || "info@itsnum.com"],
    subject: "Confirmed — " + req.title,
    text:
`${String(client.name || "").split(/\s+/)[0]},

That's confirmed.

  ${req.title}
${req.starts_at ? "  " + req.starts_at + "\n" : ""}${req.city ? "  " + req.city + "\n" : ""}${money}

If anything about it needs to change, reply to this email and it goes
straight to ${host.name}.${onBehalf(host, env)}`,
    tags: [{ name: "kind", value: "client_request_confirmed" }],
  }]));
  await env.DB.prepare("UPDATE num_host_requests SET client_notified_at = ? WHERE id = ?")
    .bind(now(), req.id).run();
}

/** Post a message on a request's thread, and tell whoever did not write it.
 *  One function for both directions — two would be how one of them silently
 *  stops delivering. */
async function postMessage(env, ctx, opts) {
  const { host, request, client, author } = opts;
  const body = clean(opts.body, 4000);
  if (!body) return { ok: false, error: "empty" };

  const id = "hm_" + token(10);
  await env.DB.prepare(
    `INSERT INTO num_host_messages (id,request_id,host_id,client_id,author,body,created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(id, request.id, host.id, client ? client.id : null, author, body, now()).run();

  const site = env.SITE || "https://itsnum.com";
  const mail = author === "host"
    ? (client && client.email ? {
        __idem: "msg-" + id,
        from: env.MAIL_FROM || "NUM <info@itsnum.com>",
        to: [client.email],
        replyTo: [host.email || "info@itsnum.com"],
        subject: "Re: " + request.title,
        text: String(client.name || "").split(/\s+/)[0] + ",\n\n" + body + onBehalf(host, env),
        tags: [{ name: "kind", value: "client_message" }],
      } : null)
    : (host.email ? {
        __idem: "msg-" + id,
        from: env.MAIL_FROM || "NUM <info@itsnum.com>",
        to: [host.email],
        replyTo: ["info@itsnum.com"],
        subject: (client ? client.name + " replied" : "Reply") + " — " + request.title,
        text:
`${host.name},

${client ? client.name : "Your client"} says:

  ${body.split("\n").join("\n  ")}

Reply on the request in your console:
${site}/host/

— Viv
NUM, by 5arz · ${LEGAL_LINE}`,
        tags: [{ name: "kind", value: "host_client_replied" }],
      } : null);

  if (mail) {
    ctx.waitUntil(sendBatch(env, [mail]));
    await env.DB.prepare("UPDATE num_host_messages SET delivered_at = ? WHERE id = ?")
      .bind(now(), id).run();
  }
  return { ok: true, id: id, delivered: !!mail };
}


/* ------------------------------------------------ /api/host/messages?k=
 * The host's side of a thread. GET reads one request's messages, POST adds
 * one and emails the client over the host's name. */
async function hostMessages(req, env, url, ctx) {
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: "unauthorised" }, 401);

  const requestId = clean(url.searchParams.get("request") || "", 40);
  if (!requestId) return J({ ok: false, error: "no_request" }, 400);

  // Ownership is checked on the REQUEST, not on the message. A console key
  // must never be able to read a thread by guessing a message id.
  const request = await env.DB.prepare(
    `SELECT r.*, c.id AS c_id, c.name AS c_name, c.email AS c_email, c.status AS c_status
       FROM num_host_requests r LEFT JOIN num_host_clients c ON c.id = r.client_id
      WHERE r.id = ? AND r.host_id = ?`
  ).bind(requestId, host.id).first();
  if (!request) return J({ ok: false, error: "not_found" }, 404);

  const list = async () => {
    const rows = await env.DB.prepare(
      "SELECT id,author,body,delivered_at,created_at FROM num_host_messages WHERE request_id = ? ORDER BY created_at ASC LIMIT 200"
    ).bind(requestId).all();
    return J({
      ok: true,
      request: { id: request.id, title: request.title, status: request.status },
      client: request.c_id ? { name: request.c_name, reachable: !!request.c_email } : null,
      messages: (rows && rows.results) || [],
      // Said plainly so a host is never typing into a void without knowing.
      note: request.c_email
        ? "Your client gets this by email, from you. NUM's name appears once at the bottom, as the sender."
        : "This client has no email on file, so nothing can be sent. Add one, or tell them yourself.",
    });
  };

  if (req.method === "GET") return list();
  if (req.method !== "POST") return J({ ok: false, error: "method" }, 405);
  if (badOrigin(req)) return J({ ok: false }, 403);
  if (host.status !== "active") return J({ ok: false, error: "host_not_active" }, 403);

  let b;
  try { b = await readJSON(req, 16384); } catch (e) { return J({ ok: false, error: "bad_body" }, 400); }

  // A client who left is not messageable. Their relationship ended, and the
  // console must not be a way around that.
  if (request.c_status === "removed") return J({ ok: false, error: "client_left" }, 409);

  const out = await postMessage(env, ctx, {
    host: { id: host.id, name: host.name, email: host.email },
    request: request,
    client: request.c_id ? { id: request.c_id, name: request.c_name, email: request.c_email } : null,
    author: "host",
    body: b.body,
  });
  if (!out.ok) return J({ ok: false, error: out.error || "failed" }, 400);
  return list();
}

/* ------------------------------------------ GET /api/host/calendar.ics?t=
 *
 * Promised on 1 Sep — the token has been minted and displayed in the console
 * ever since, pointing at nothing. A feed URL a host has already subscribed
 * to and that returns 404 is worse than no feed: their calendar shows no
 * error, it just quietly holds nothing.
 *
 * READ-ONLY, and that is the whole design. NUM publishes, their calendar
 * subscribes. We never ask for write access to a person's calendar and we
 * never will — it is the single most invasive permission in the product and
 * we do not need it to be useful.
 */
async function hostCalendar(req, env, url) {
  const t = url.searchParams.get("t") || "";
  if (t.length < 16 || t.length > 80) return new Response("Not found", { status: 404 });

  const host = await env.DB.prepare(
    "SELECT id, name, calendar_token FROM num_hosts WHERE calendar_token = ? AND status = 'active'"
  ).bind(t).first();
  if (!host || !sameSecret(host.calendar_token, t)) {
    return new Response("Not found", { status: 404 });
  }

  const rows = await env.DB.prepare(
    `SELECT r.id, r.title, r.detail, r.city, r.country, r.starts_at, r.ends_at,
            r.status, r.price_minor, r.currency, r.quote_only, r.updated_at, r.created_at,
            c.name AS client_name
       FROM num_host_requests r
       LEFT JOIN num_host_clients c ON c.id = r.client_id
      WHERE r.host_id = ? AND r.status IN ('confirmed','done')
        AND r.starts_at IS NOT NULL AND r.starts_at <> ''
      ORDER BY r.starts_at DESC LIMIT 400`
  ).bind(host.id).all();

  // ICS wants UTC basic format. A date we cannot parse is SKIPPED rather than
  // guessed at: a booking in the wrong place in someone's calendar is worse
  // than one that is missing, because they will plan around it.
  const stamp = (s) => {
    if (!s) return null;
    const d = new Date(String(s).replace(" ", "T"));
    if (isNaN(d.getTime())) return null;
    return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  };
  // RFC 5545: escape, then fold at 75 octets. Unfolded long lines are the
  // classic reason a feed parses in one calendar app and not in another.
  const esc = (s) => String(s == null ? "" : s)
    .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const fold = (line) => {
    const out = [];
    let s = line;
    while (s.length > 73) { out.push(s.slice(0, 73)); s = " " + s.slice(73); }
    out.push(s);
    return out.join("\r\n");
  };

  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//NUM//VIP host//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    fold("X-WR-CALNAME:" + esc((host.name || "NUM") + " — confirmed work")),
  ];

  for (const r of ((rows && rows.results) || [])) {
    const start = stamp(r.starts_at);
    if (!start) continue;
    // No end time given: an hour is the honest default for a concierge job and
    // is marked as such in the description rather than presented as fact.
    const end = stamp(r.ends_at) ||
      stamp(new Date(new Date(String(r.starts_at).replace(" ", "T")).getTime() + 36e5).toISOString());
    const price = (!r.quote_only && r.price_minor > 0)
      ? (r.currency || "GBP") + " " + (r.price_minor / 100).toFixed(2) : "agreed per request";
    const desc = [
      r.client_name ? "For: " + r.client_name : null,
      r.detail || null,
      "Price: " + price,
      !r.ends_at ? "(No end time was set — shown as one hour.)" : null,
    ].filter(Boolean).join("\n");

    lines.push("BEGIN:VEVENT");
    lines.push("UID:" + r.id + "@itsnum.com");
    lines.push("DTSTAMP:" + (stamp(r.updated_at) || stamp(r.created_at) || start));
    lines.push("DTSTART:" + start);
    lines.push("DTEND:" + end);
    lines.push(fold("SUMMARY:" + esc(r.title + (r.client_name ? " — " + r.client_name : ""))));
    if (r.city) lines.push(fold("LOCATION:" + esc([r.city, r.country].filter(Boolean).join(", "))));
    lines.push(fold("DESCRIPTION:" + esc(desc)));
    lines.push("STATUS:" + (r.status === "done" ? "CONFIRMED" : "CONFIRMED"));
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");

  return new Response(lines.join("\r\n") + "\r\n", {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      // Calendar clients poll hard. Five minutes is responsive enough for a
      // booking made this morning and cheap enough to survive the polling.
      "cache-control": "private, max-age=300",
      // A feed URL is a bearer token. It must never be indexed, and it must
      // never be sent as a Referer to anywhere the events link out to.
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
    },
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * ENDING IT — from either side, on the record, with both sides told.
 *
 * 0014 gave only the host a way to end the relationship, silently, by setting
 * a status. Everything below is the other half of that, and it rests on one
 * idea: AN ENDING NOBODY IS TOLD ABOUT IS NOT AN ENDING.
 *
 * If a host removes a client and the client is not told, the client goes on
 * believing they have a concierge. If a member leaves and the host is not
 * told, the host goes on holding — and working from — details of somebody who
 * withdrew. And in both cases the host's console keeps showing work for
 * are no longer making, which is the version of this failure that shows up on
 * a card statement.
 *
 * So every path here does the same four things, in the same order, and
 * `endClient` is the only place any of them happens:
 *   1. mark the row ended, with WHO ended it — not just that it ended
 *   2. write an append-only separation record
 *   3. tell the other side
 *   4. release or hold the introduction offer, depending on who ended it
 * ══════════════════════════════════════════════════════════════════════════ */

/** WHO MAY BE OFFERED THIS HOST AGAIN.
 *
 *  The asymmetry is deliberate and it is about consent, not symmetry:
 *
 *  • The HOST ended it → the offer row STAYS, so NUM never offers this member
 *    to this host again. The host said no once; asking again is us overruling
 *    them with a cron job.
 *  • The MEMBER ended it → the offer row is DELETED, so the member is free to
 *    choose again, including this same host later. Their own decision is not
 *    a permanent bar on their own options.
 */
const OFFER_ON_END = { host: "keep", member: "release", host_closed: "keep", num: "keep" };

/**
 * End one client relationship. The single writer.
 *
 * Returns { ok, already } so callers can tell an ending from a no-op — a
 * double-tap on "leave" must not send a second email to a host who has
 * already been told, and must not write a second separation row that makes
 * the audit trail read like two events.
 */
async function endClient(env, ctx, opts) {
  const host = opts.host;                 // { id, name, email }
  const row = opts.client;                // full num_host_clients row
  const endedBy = opts.ended_by;
  const reason = clean(opts.reason, 600);

  if (!row || !host) return { ok: false };
  if (row.status === "removed") return { ok: true, already: true };

  const at = now();
  const sepId = "hs_" + token(10);

  const writes = [
    env.DB.prepare(
      `UPDATE num_host_clients
          SET status = 'removed', ended_at = ?, ended_by = ?, updated_at = ?
        WHERE id = ? AND host_id = ?`
    ).bind(at, endedBy, at, row.id, host.id),
    env.DB.prepare(
      `INSERT INTO num_host_separations
         (id,host_id,client_id,member_id,ended_by,reason,host_notified,member_notified,at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(
      sepId, host.id, row.id, row.member_id || null, endedBy, reason,
      // Recorded as intent here and corrected below only if there was nobody
      // to write to. A 0 against an ended row is a real defect the integrity
      // check reports, not a cosmetic gap.
      endedBy === "member" ? 1 : 0,
      endedBy === "member" ? 0 : (row.email ? 1 : 0),
      at
    ),
  ];

  // The member walking away is the member's own decision about their own
  // options, so it must not become a permanent bar on them.
  if (OFFER_ON_END[endedBy] === "release") {
    writes.push(env.DB.prepare(
      "DELETE FROM num_host_offers WHERE client_id = ? AND host_id = ?"
    ).bind(row.id, host.id));
  }

  await env.DB.batch(writes);

  /* TELL THE OTHER SIDE. Always the other side — the one who acted already
   * knows, and a confirmation to them is a courtesy, while a notice to the
   * other one is the whole point. */
  const site = env.SITE || "https://itsnum.com";
  const mails = [];
  const firstName = String(row.name || "").split(/\s+/)[0] || "Your client";

  if (endedBy === "member" && host.email) {
    mails.push({
      __idem: "sep-host-" + sepId,
      from: env.MAIL_FROM || "NUM <info@itsnum.com>",
      to: [host.email],
      replyTo: ["info@itsnum.com"],
      subject: firstName + " has left your book",
      text:
`${host.name},

${firstName} has asked NUM to remove them from your client list${reason ? ", and said: “" + reason + "”" : "."}

They are no longer in your console, NUM will not act for them in your name,
and you will not be charged for anything of theirs from now on.

Nothing else about your account changes. If you think this is a mistake,
reply to this email and a person will look at it with you — we will not put
them back without hearing from them.

— Viv
NUM, by 5arz · ${LEGAL_LINE}`,
      tags: [{ name: "kind", value: "host_client_left" }],
    });
  }

  if (endedBy !== "member" && row.email) {
    const why = endedBy === "host_closed"
      ? `${host.name} has closed their NUM host account, so they are no longer looking after you through NUM.`
      : `${host.name} has removed you from their NUM client list.`;
    mails.push({
      __idem: "sep-member-" + sepId,
      from: env.MAIL_FROM || "NUM <info@itsnum.com>",
      to: [row.email],
      replyTo: ["info@itsnum.com"],
      subject: "Your VIP host has changed",
      text:
`Hello ${firstName},

${why}

What this means for you: nothing stops working. NUM still books your travel
directly, the same way, with the same answer at whatever hour you ask. A VIP
host was always an added service, never a requirement.

Nothing changes about what you pay, either: NUM does not charge you a booking
fee, with a host or without one.

If you would like another host near you, there may be one:
${site}/find-a-host/

If you would rather NUM held nothing about you at all, reply to this email
and say so, and we will delete it.

— Viv
NUM, by 5arz · ${LEGAL_LINE}`,
      tags: [{ name: "kind", value: "member_host_ended" }],
    });
  }

  if (mails.length) {
    ctx.waitUntil(sendBatch(env, mails));
    await env.DB.prepare(
      "UPDATE num_host_clients SET notified_at = ? WHERE id = ?"
    ).bind(at, row.id).run();
  } else {
    // Honest bookkeeping: there was nobody to write to, so say so rather than
    // leaving a row that claims a notification happened.
    await env.DB.prepare(
      `UPDATE num_host_separations
          SET host_notified = 0, member_notified = 0 WHERE id = ?`
    ).bind(sepId).run();
  }

  return { ok: true, already: false, separation_id: sepId };
}

/* ------------------------------------------- /api/host/integrity  ADMIN_KEY
 *
 * Read-only. Reads every host table and asks whether they still agree with
 * each other. Six tables now describe one relationship between two people,
 * each written by a different endpoint on a different day — which is exactly
 * the shape of system where the disagreement stays invisible until somebody
 * is billed for a client they released.
 *
 * The checks themselves live in worker/hostintegrity.mjs as pure functions
 * over rows, so they are unit-tested against constructed states rather than
 * only against whatever production happens to hold today.
 */
async function hostIntegrity(req, env, url) {
  const key = url.searchParams.get("key") || "";
  if (!env.ADMIN_KEY || !sameSecret(env.ADMIN_KEY, key)) {
    return J({ ok: false, error: "unauthorised" }, 401);
  }

  const q = (sql) => env.DB.prepare(sql).all().then(
    function (r) { return (r && r.results) || []; },
    function () { return []; }
  );

  const [clients, hosts, offers, separations, links, areas, requests] = await Promise.all([
    q(`SELECT id,host_id,member_id,member_token,email,status,ended_at,ended_by,notified_at
         FROM num_host_clients LIMIT 5000`),
    q(`SELECT id,status,tier,accepts_intros,in_network,sms_opt_in,notify_phone
         FROM num_hosts LIMIT 5000`),
    q(`SELECT id,member_id,host_id,client_id,member_said,host_said FROM num_host_offers LIMIT 5000`),
    q(`SELECT id,host_id,client_id,ended_by,at FROM num_host_separations LIMIT 5000`),
    q(`SELECT id,host_a,host_b,status FROM num_host_links LIMIT 5000`),
    q(`SELECT id,host_id,city FROM num_host_areas LIMIT 5000`),
    q(`SELECT id,host_id,status,booking_fee_minor,network_host_id FROM num_host_requests LIMIT 5000`),
  ]);

  const report = integrityReport({ clients, hosts, offers, separations, links, areas, requests });
  return J({
    ok: true,
    checked_at: now(),
    rows: {
      clients: clients.length, hosts: hosts.length, offers: offers.length,
      separations: separations.length, links: links.length, areas: areas.length,
      requests: requests.length,
    },
    ...report,
  });
}

/* ------------------------------------------------- /api/host/link?t=  MEMBER
 *
 * The member's own page. One token, one relationship, two things it can do:
 * show you who holds your details, and end it.
 *
 * Deliberately NOT behind a NUM login. A member introduced to a host may have
 * no account at all, and an exit that requires one is an exit most people
 * never reach — which would make the consent they gave at the introduction
 * worth less than it looked.
 */
async function memberLink(req, env, url, ctx) {
  const t = url.searchParams.get("t") || "";
  if (t.length < 20 || t.length > 80) return J({ ok: false, error: "unauthorised" }, 401);

  const row = await env.DB.prepare(
    `SELECT c.*, h.name AS host_name, h.company AS host_company, h.email AS host_email,
            h.status AS host_status, h.services_json, h.pricing_json, h.currency
       FROM num_host_clients c JOIN num_hosts h ON h.id = c.host_id
      WHERE c.member_token = ?`
  ).bind(t).first();
  if (!row) return J({ ok: false, error: "unauthorised" }, 401);
  if (!sameSecret(row.member_token, t)) return J({ ok: false, error: "unauthorised" }, 401);
  const hostRow = row;

  const bookings = async () => {
    const rows = await env.DB.prepare(
      `SELECT id,title,city,starts_at,status,price_minor,currency,quote_only
         FROM num_host_requests
        WHERE client_id = ? AND status IN ('confirmed','done')
        ORDER BY COALESCE(starts_at, created_at) DESC LIMIT 50`
    ).bind(row.id).all();
    return (rows && rows.results) || [];
  };

  /* THE MENU.
   *
   * A client who can only write "can you sort me a car" is asking a stranger's
   * assistant to guess. A client who is shown what their host actually does,
   * with the host's own words and the host's own prices, is choosing — and the
   * request that comes back is one the host can act on without three messages
   * of clarification.
   *
   * Built from the SAME pricing_json the host edits in their console, so a
   * price can never be shown here that the host did not set. A service the
   * host has un-ticked does not appear. A line they marked "agreed per
   * request" shows no number, because inventing one is how a host ends up
   * held to a figure they never quoted. */
  const menu = () => {
    const on = JSON.parse(hostRow.services_json || "[]");
    const priced = JSON.parse(hostRow.pricing_json || "[]");
    const byKey = {};
    priced.forEach(function (x) { byKey[x.key] = x; });
    return on.map(function (k) {
      const line = byKey[k] || {};
      return {
        key: k,
        label: line.label || k,
        // No price at all rather than a zero: "£0.00" reads as free.
        price_minor: line.unit === "quote" ? null : (line.price_minor || null),
        currency: hostRow.currency || "GBP",
        unit: line.unit || "quote",
        fulfilment: line.fulfilment || "either",
        notes: line.notes || "",
      };
    });
  };

  const read = async () => J({
    ok: true,
    you: row.name,
    // What this host can do for you, in their words and at their prices.
    services: menu(),
    // What their host has actually confirmed for them. Confirmed and done
    // only: a client must never be shown a booking their host has not agreed
    // to, which is the same rule that governs the confirmation email.
    bookings: await bookings(),
    host: {
      // The host's name and company, because that is who holds your details
      // and you are entitled to know. Not their email or number: this page
      // exists so you can leave, not so it can be used to reach them.
      name: row.host_name,
      company: row.host_company || "",
      closed: row.host_status !== "active",
    },
    status: row.status,
    since: row.created_at,
    ended_at: row.ended_at || null,
    ended_by: row.ended_by || null,
    // Said plainly, because a page that lets you leave should tell you what
    // leaving costs you before you do it.
    what_they_see: [
      "Your name" + (row.email ? " and email" : ""),
      row.phone ? "Your phone number" : null,
      row.home_city ? "Where you are based" : null,
      row.notes ? "Notes they have written about how you like to travel" : null,
    ].filter(Boolean),
    if_you_leave: [
      "They are told, and you are removed from their console.",
      "NUM keeps booking your travel directly, exactly as it does now.",
      "Nothing starts costing you money — NUM does not charge you a booking fee.",
      "You can ask a different host, or the same one again, whenever you like.",
    ],
  });

  if (req.method === "GET") return read();
  if (req.method !== "POST") return J({ ok: false, error: "method" }, 405);
  if (badOrigin(req)) return J({ ok: false }, 403);

  let b;
  try { b = await readJSON(req, 16384); } catch (e) { return J({ ok: false, error: "bad_body" }, 400); }
  const action = String(b.action || "");

  /* THE CLIENT REPLYING. The other half of the loop, and the reason this page
   * is not just an exit door: a client who can only leave or do nothing will
   * leave. Their message goes to their host, and only to their host. */
  if (action === "reply") {
    if (row.status === "removed") return J({ ok: false, error: "ended" }, 409);
    const requestId = clean(b.request_id, 40);
    const request = await env.DB.prepare(
      "SELECT * FROM num_host_requests WHERE id = ? AND client_id = ?"
    ).bind(requestId, row.id).first();
    if (!request) return J({ ok: false, error: "not_found" }, 404);

    const out = await postMessage(env, ctx, {
      host: { id: row.host_id, name: row.host_name, email: row.host_email },
      request: request,
      client: { id: row.id, name: row.name, email: row.email },
      author: "client",
      body: b.body,
    });
    if (!out.ok) return J({ ok: false, error: out.error || "failed" }, 400);
    return J({
      ok: true,
      sent: true,
      note: out.delivered
        ? String(row.host_name || "Your host").split(/\s+/)[0] + " has it."
        : "Saved. We could not email them just now, so they will see it in their console.",
    });
  }

  /* ASKING FOR ONE. The client-side intake, and the reason the menu exists.
   *
   * The request lands with source='client' and host_notified_at NULL, which is
   * exactly what worker/hostaware.mjs's sweep looks for — so the host is told
   * by the path that already exists rather than a second one built here.
   *
   * NUM says nothing to the client beyond "they have it". No price is agreed,
   * nothing is confirmed, and the host remains the only person who can commit
   * to anything. */
  if (action === "ask") {
    if (row.status === "removed") return J({ ok: false, error: "ended" }, 409);
    if (hostRow.host_status !== "active") return J({ ok: false, error: "host_unavailable" }, 409);

    const key = String(b.service_key || "").trim().toLowerCase();
    // Only from the menu. A key the host does not offer is not a request they
    // can fulfil, and accepting it would put a job in their console that they
    // never said they do.
    const offered = menu().some(function (m) { return m.key === key; });
    if (!offered) return J({ ok: false, error: "not_offered" }, 400);

    const title = clean(b.title, 160);
    if (!title) return J({ ok: false, error: "no_title" }, 400);

    const line = menu().filter(function (m) { return m.key === key; })[0] || {};
    const reqId = "hr_" + token(10);
    await env.DB.prepare(
      `INSERT INTO num_host_requests
         (id,host_id,client_id,service_key,title,detail,city,starts_at,party_size,
          price_minor,currency,unit,quote_only,status,source,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'new','client',?)`
    ).bind(
      reqId, row.host_id, row.id, key, title, clean(b.detail, 4000),
      clean(b.city, 80) || row.home_city || null, clean(b.starts_at, 40),
      Math.max(0, Math.min(99, Math.round(Number(b.party_size)) || 0)) || null,
      // The host's own price, copied at the moment of asking so a later edit to
      // their list cannot silently change what this client was shown.
      line.price_minor || 0, line.currency || "GBP", line.unit || "quote",
      line.unit === "quote" ? 1 : 0, now()
    ).run().catch(function () { return null; });

    return J({
      ok: true,
      asked: true,
      note: String(hostRow.host_name || "Your host").split(/\s+/)[0] +
            " has it. Nothing is booked until they confirm, and they will come back to you.",
    });
  }

  if (action !== "leave") return J({ ok: false, error: "bad_action" }, 400);
  if (row.status === "removed") return read();

  const out = await endClient(env, ctx, {
    host: { id: row.host_id, name: row.host_name, email: row.host_email },
    client: row,
    ended_by: "member",
    reason: b.reason,
  });
  if (!out.ok) return J({ ok: false, error: "failed" }, 500);

  return J({
    ok: true,
    left: true,
    note: "Done. " + String(row.host_name || "Your host").split(/\s+/)[0] +
          " has been told, you are out of their console, and NUM will keep booking your travel directly.",
  });
}

/* --------------------------------------------------- /api/host/close?k=  HOST
 *
 * A host ending their NUM account. Two-step on purpose: this releases every
 * client they have, and a mis-tap that quietly emailed forty people would be
 * unrecoverable.
 */
async function hostClose(req, env, url, ctx) {
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: "unauthorised" }, 401);
  if (req.method !== "POST") return J({ ok: false, error: "method" }, 405);
  if (badOrigin(req)) return J({ ok: false }, 403);

  let b;
  try { b = await readJSON(req, 8192); } catch (e) { return J({ ok: false, error: "bad_body" }, 400); }

  const active = await env.DB.prepare(
    "SELECT * FROM num_host_clients WHERE host_id = ? AND status <> 'removed'"
  ).bind(host.id).all();
  const clients = (active && active.results) || [];

  /* THE CONFIRMATION STEP. The host has to type their own account name back.
   * Not a checkbox: a checkbox is one tap from a scroll, and this ends
   * relationships belonging to other people. */
  if (String(b.confirm || "").trim().toLowerCase() !== String(host.name || "").trim().toLowerCase()) {
    return J({
      ok: false,
      error: "confirm_required",
      clients: clients.length,
      note: "Closing releases " + clients.length + " client" + (clients.length === 1 ? "" : "s") +
            " and tells each of them. Type your name exactly as it appears on your account to confirm.",
    }, 400);
  }

  for (const row of clients) {
    await endClient(env, ctx, {
      host: { id: host.id, name: host.name, email: host.email },
      client: row,
      ended_by: "host_closed",
      reason: b.reason,
    });
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE num_hosts
          SET status = 'ended', accepts_intros = 0, in_network = 0,
              closed_at = ?, closed_reason = ?, plan_status = 'cancelled', updated_at = ?
        WHERE id = ?`
    ).bind(now(), clean(b.reason, 600), now(), host.id),
    // Coverage goes with them. A closed host left in the areas table is a
    // closed host still being ranked for introductions.
    env.DB.prepare("DELETE FROM num_host_areas WHERE host_id = ?").bind(host.id),
    // Standing connections end rather than dangle: another host must not be
    // able to hand work to somebody who is gone.
    env.DB.prepare(
      "UPDATE num_host_links SET status = 'ended', decided_at = ? WHERE (host_a = ? OR host_b = ?) AND status <> 'ended'"
    ).bind(now(), host.id, host.id),
    // Pending introductions to them are withdrawn, not left waiting.
    env.DB.prepare(
      "UPDATE num_host_offers SET host_said = 'no', decided_at = ? WHERE host_id = ? AND host_said = 'pending'"
    ).bind(now(), host.id),
  ]);

  if (host.email) {
    ctx.waitUntil(sendBatch(env, [{
      __idem: "hostclosed-" + host.id,
      from: env.MAIL_FROM || "NUM <info@itsnum.com>",
      to: [host.email],
      replyTo: ["info@itsnum.com"],
      subject: "Your NUM host account is closed",
      text:
`${host.name},

Your host account is closed. ${clients.length} client${clients.length === 1 ? " has" : "s have"} been released and told
directly — they know it was an account closure, not anything about them.

Your plan is cancelled and you will not be billed again. Your console link no
longer opens anything.

We keep a record of the bookings you confirmed and of each release, because
that is what makes a later question answerable. We do not keep working on
anything for you.

If you want to come back, reply to this email rather than signing up again —
that way your history comes with you.

— Viv
NUM, by 5arz · ${LEGAL_LINE}`,
      tags: [{ name: "kind", value: "host_closed" }],
    }]));
  }

  return J({
    ok: true,
    closed: true,
    released: clients.length,
    note: "Closed. " + clients.length + " client" + (clients.length === 1 ? " was" : "s were") +
          " released and told. Your plan is cancelled and this console key no longer works.",
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * INTRODUCTIONS — a NUM member with no host, and the nearest host who might
 * take them.
 *
 * The chosen shape is OFFER ONLY, AND THE HOST OPTS IN FIRST. Three separate
 * yeses have to exist before one person's details reach another:
 *
 *   1. the host turned `accepts_intros` on            (default 0, in 0014)
 *   2. the member asked to be introduced to that host (member_said = 'yes')
 *   3. the host accepted this particular member       (host_said = 'yes')
 *
 * Until all three, the host row the member sees carries a first name, a city,
 * a blurb and a distance — and nothing that could be used to contact anyone.
 * The auto-assign version of this feature is one line shorter and attaches a
 * stranger to somebody's travel without asking, which is exactly the thing a
 * concierge's client is paying not to have happen to them.
 *
 * If nobody is near, or nobody accepts, NOTHING BREAKS: the member is served
 * by NUM directly, the way they already are. VIP hosting is the added service,
 * never the gate.
 * ══════════════════════════════════════════════════════════════════════════ */

/** Great-circle distance in km. Used to rank, never to route — a host's
 *  "nearest" is about which city they actually work, and the radius on the
 *  area row is what decides whether they are a candidate at all. */
function kmBetween(aLat, aLng, bLat, bLng) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
  const s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(s))) * 10) / 10;
}

/** Rewrite the indexed shadow of a host's areas. Called on every profile save.
 *  areas_json stays the host's editable copy; this table is what nearest-host
 *  matching queries, because a JSON scan across every host is the version that
 *  quietly stops working at a few hundred rows and is never noticed. */
async function syncHostAreas(env, hostId, areas) {
  await env.DB.prepare("DELETE FROM num_host_areas WHERE host_id = ?").bind(hostId).run();
  const rows = areas.slice(0, 20).map(function (a) {
    return env.DB.prepare(
      "INSERT INTO num_host_areas (id,host_id,city,country,lat,lng,radius_km,created_at) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(
      "ha_" + token(8), hostId, a.city || null, a.country || null,
      a.lat, a.lng, a.radius_km, now()
    );
  });
  if (rows.length) await env.DB.batch(rows);
}

/** One area, normalised. A radius is capped at 500km on purpose: a host who
 *  claims the whole of Europe is not a local contact, and the value of this
 *  feature is entirely that the host is actually there. */
function areaLine(raw) {
  if (!raw || typeof raw !== "object") return null;
  const lat = Number(raw.lat), lng = Number(raw.lng);
  const city = clean(raw.city, 80);
  if (!city && !(isFinite(lat) && isFinite(lng))) return null;
  return {
    city: city,
    country: clean(raw.country, 60),
    lat: isFinite(lat) && lat >= -90 && lat <= 90 ? lat : null,
    lng: isFinite(lng) && lng >= -180 && lng <= 180 ? lng : null,
    radius_km: Math.max(1, Math.min(500, Math.round(Number(raw.radius_km)) || 50)),
  };
}

/* --------------------------------------------- GET /api/host/nearby  public
 *
 * Deliberately public and deliberately thin. Everything in the response could
 * be printed on a business card the host chose to hand out. There is no email,
 * no phone, no client count and no host id that unlocks anything on its own.
 */
async function hostNearby(req, env, url) {
  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (overLimit("nearby:" + ip, 30)) return J({ ok: false, error: "slow_down" }, 429);

  const city = clean(url.searchParams.get("city"), 80);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const hasGeo = isFinite(lat) && isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  if (!city && !hasGeo) return J({ ok: false, error: "need_city_or_coords" }, 400);

  // Bounding box first, haversine second. One degree of latitude is ~111km, so
  // a 5-degree box comfortably contains any 500km radius and lets the index do
  // the work before we do arithmetic on anything.
  const rows = hasGeo
    ? await env.DB.prepare(
        `SELECT a.city, a.country, a.lat, a.lng, a.radius_km,
                h.id, h.name, h.company, h.blurb, h.services_json, h.currency
           FROM num_host_areas a JOIN num_hosts h ON h.id = a.host_id
          WHERE h.accepts_intros = 1 AND h.status = 'active'
            AND h.tier IN ('pro','full')
            AND a.lat BETWEEN ? AND ? AND a.lng BETWEEN ? AND ?
          LIMIT 200`
      ).bind(lat - 5, lat + 5, lng - 5, lng + 5).all()
    : await env.DB.prepare(
        `SELECT a.city, a.country, a.lat, a.lng, a.radius_km,
                h.id, h.name, h.company, h.blurb, h.services_json, h.currency
           FROM num_host_areas a JOIN num_hosts h ON h.id = a.host_id
          WHERE h.accepts_intros = 1 AND h.status = 'active'
            AND h.tier IN ('pro','full') AND lower(a.city) = ?
          LIMIT 200`
      ).bind(lc(city)).all();

  const seen = {};
  const out = [];
  for (const r of ((rows && rows.results) || [])) {
    const d = (hasGeo && r.lat != null && r.lng != null) ? kmBetween(lat, lng, r.lat, r.lng) : null;
    // The host's own radius is the filter. They said how far they work; we do
    // not stretch it because there was nobody closer.
    if (d !== null && d > r.radius_km) continue;
    if (seen[r.id]) continue;
    seen[r.id] = 1;
    out.push({
      host_id: r.id,
      // First name and a last initial. Enough to be a person, not enough to be
      // looked up and contacted around us before either side has agreed.
      name: String(r.name || "").split(/\s+/)[0] +
            (String(r.name || "").split(/\s+/)[1] ? " " + String(r.name).split(/\s+/)[1][0] + "." : ""),
      company: r.company || "",
      blurb: r.blurb || "",
      city: r.city || "",
      country: r.country || "",
      distance_km: d,
      services: JSON.parse(r.services_json || "[]"),
    });
  }
  out.sort(function (a, z) {
    if (a.distance_km === null) return 1;
    if (z.distance_km === null) return -1;
    return a.distance_km - z.distance_km;
  });

  return J({
    ok: true,
    hosts: out.slice(0, 10),
    // The honest framing, returned with the data so no surface can quietly
    // reword it into a requirement.
    note: out.length
      ? "These hosts take introductions. Nothing is shared with them until you ask."
      : "No VIP host near you yet. NUM will book this for you directly.",
    optional: true,
  });
}

/* -------------------------------------------- POST /api/host/intro  public
 *
 * The member asking. This creates the offer AND a paused client row holding
 * the member's details, so that the details live in exactly one place — the
 * host's own book, switched off — instead of being copied into an offers
 * table that would then hold personal data belonging to a relationship that
 * may never start. If the host declines, that row is deleted outright.
 */
async function hostIntro(req, env, ctx) {
  if (badOrigin(req)) return J({ ok: false }, 403);
  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (overLimit("intro:" + ip, 5)) return J({ ok: false, error: "slow_down" }, 429);

  let b;
  try { b = await readJSON(req, 16384); } catch (e) { return J({ ok: false }, 400); }

  const hostId = clean(b.host_id, 40);
  const name = clean(b.name, 120);
  const email = String(b.email || "").trim();
  if (!hostId || !name) return J({ ok: false, error: "missing" }, 400);
  if (!okEmail(email)) return J({ ok: false, error: "bad_email" }, 400);
  // The member's own yes. This is the one consent in the whole system that the
  // person themselves gives about themselves, and it is not inferable from the
  // fact that they filled in a form.
  if (b.share_ok !== true) return J({ ok: false, error: "consent_required" }, 400);

  const host = await env.DB.prepare(
    "SELECT id,name,email,accepts_intros,status,tier FROM num_hosts WHERE id = ? AND accepts_intros = 1 AND status = 'active'"
  ).bind(hostId).first();
  if (!host) return J({ ok: false, error: "host_unavailable" }, 404);
  // Checked again here, not only in the listing. A host who downgraded between
  // the member seeing them and the member tapping must not receive someone
  // they can no longer take.
  if (!hostCan(host.tier, "intros")) return J({ ok: false, error: "host_unavailable" }, 404);

  const supp = await env.DB.prepare("SELECT 1 AS x FROM num_suppressions WHERE lower(email) = ?")
    .bind(lc(email)).first().catch(function () { return null; });
  if (supp) return J({ ok: false, error: "suppressed" }, 409);

  // No capacity check: no tier caps clients, so there is no "full" host to
  // protect a member from. A host who does not want more people switches
  // accepts_intros off — a decision they make, not one their invoice makes
  // for them.
  const memberId = "m_" + token(10);
  const clientId = "hc_" + token(10);

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO num_host_clients
           (id,host_id,name,email,email_lc,home_city,source,consent_basis,consent_text,
            status,member_id,member_token,created_at)
         VALUES (?,?,?,?,?,?,'num_offer','member_asked',?,'paused',?,?,?)`
      ).bind(
        clientId, host.id, name, email, lc(email), clean(b.city, 80),
        "Member asked NUM to introduce them to this host and agreed to share their name and email. " +
        "Asked on " + now() + ".",
        // member_id is written HERE, at the only moment we know a NUM member
        // and a host client are the same person. Nothing populated it before,
        // which meant worker/servicefee.mjs answered "no host" for everyone
        // and every hosted client would have been charged the £5 we promised
        // them they would never pay.
        memberId, token(20), now()
      ),
      env.DB.prepare(
        `INSERT INTO num_host_offers
           (id,member_id,host_id,city,distance_km,member_said,host_said,client_id,created_at,expires_at)
         VALUES (?,?,?,?,?, 'yes','pending', ?,?,?)`
      ).bind(
        "ho_" + token(10), memberId, host.id, clean(b.city, 80),
        isFinite(Number(b.distance_km)) ? Number(b.distance_km) : null,
        clientId, now(),
        new Date(Date.now() + 14 * 864e5).toISOString().replace("T", " ").slice(0, 19)
      ),
    ]);
  } catch (e) {
    return J({ ok: false, error: "already_asked" }, 409);
  }

  // The host hears about it. The member's email is NOT in this message — the
  // host sees who and where, and gets the rest only once they accept.
  if (host.email) {
    ctx.waitUntil(sendBatch(env, [{
      __idem: "hostintro-" + clientId,
      from: env.MAIL_FROM || "NUM <info@itsnum.com>",
      to: [host.email],
      replyTo: ["info@itsnum.com"],
      subject: "A NUM member near you is asking for a host",
      text:
`${host.name},

${name.split(/\s+/)[0]}${b.city ? ", in " + clean(b.city, 80) + "," : ""} is a NUM member with no VIP host, and has asked to be introduced to you.

They have agreed to share their name and email with you. We have not sent them anything of yours, and we will not until you say yes.

Open your console and accept or decline:
${(env.SITE || "https://itsnum.com")}/host/

If you decline, their details are deleted and they are never offered to you again. NUM books their travel directly, as it already does.

— Viv
NUM, by 5arz · ${LEGAL_LINE}`,
      tags: [{ name: "kind", value: "host_intro" }],
    }]));
  }

  return J({
    ok: true,
    asked: true,
    note: "We have asked " + String(host.name || "").split(/\s+/)[0] +
          ". Nothing of yours has been sent to them yet, and NUM will book your travel either way.",
  });
}

/* ------------------------------------------------- /api/host/intros  R/W
 * The host's side of the same thing. */
async function hostIntros(req, env, url, ctx) {
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: "unauthorised" }, 401);

  const list = async () => {
    const [rows, plan, me] = await Promise.all([
      env.DB.prepare(
        `SELECT o.id,o.city,o.distance_km,o.host_said,o.created_at,o.expires_at,
                c.name AS client_name, c.home_city
           FROM num_host_offers o LEFT JOIN num_host_clients c ON c.id = o.client_id
          WHERE o.host_id = ? AND o.host_said = 'pending' AND o.member_said = 'yes'
          ORDER BY o.created_at DESC LIMIT 100`
      ).bind(host.id).all(),
      hostPlan(env, host.id),
      env.DB.prepare("SELECT accepts_intros FROM num_hosts WHERE id = ?").bind(host.id).first(),
    ]);
    return J({
      ok: true,
      accepts_intros: !!(me && me.accepts_intros),
      // First name only until they accept. The host is deciding whether to take
      // a person, not being handed one to look up first.
      intros: ((rows && rows.results) || []).map(function (o) {
        return {
          id: o.id,
          who: String(o.client_name || "").split(/\s+/)[0],
          city: o.city || o.home_city || "",
          distance_km: o.distance_km,
          asked_at: o.created_at,
          expires_at: o.expires_at,
        };
      }),
      plan: plan,
    });
  };

  if (req.method === "GET") return list();
  if (req.method !== "POST") return J({ ok: false, error: "method" }, 405);
  if (badOrigin(req)) return J({ ok: false }, 403);
  if (host.status !== "active") return J({ ok: false, error: "host_not_active" }, 403);

  const plan = await hostPlan(env, host.id);
  if (!hostCan(plan.tier, "intros")) return needsTier("intros");

  let b;
  try { b = await readJSON(req, 16384); } catch (e) { return J({ ok: false, error: "bad_body" }, 400); }
  const action = String(b.action || "");

  if (action === "switch") {
    const on = (b.accepts_intros === true || b.accepts_intros === 1) ? 1 : 0;
    await env.DB.prepare("UPDATE num_hosts SET accepts_intros = ?, updated_at = ? WHERE id = ?")
      .bind(on, now(), host.id).run();
    return list();
  }

  const id = clean(b.id, 40);
  if (!id) return J({ ok: false, error: "no_id" }, 400);
  const offer = await env.DB.prepare(
    "SELECT id, client_id, host_said FROM num_host_offers WHERE id = ? AND host_id = ? AND host_said = 'pending'"
  ).bind(id, host.id).first();
  if (!offer) return J({ ok: false, error: "not_found" }, 404);

  if (action === "accept") {
    await env.DB.batch([
      env.DB.prepare("UPDATE num_host_offers SET host_said = 'yes', decided_at = ? WHERE id = ?")
        .bind(now(), offer.id),
      // The paused row created when they asked becomes a real client. The
      // details were never copied anywhere else, so there is nothing to move.
      env.DB.prepare("UPDATE num_host_clients SET status = 'active', updated_at = ? WHERE id = ? AND host_id = ?")
        .bind(now(), offer.client_id, host.id),
    ]);
    return list();
  }

  if (action === "decline") {
    // Declined means gone. The offer keeps its row so we never ask this host
    // about this person again; the personal details do not survive a no.
    await env.DB.batch([
      env.DB.prepare("UPDATE num_host_offers SET host_said = 'no', decided_at = ?, client_id = NULL WHERE id = ?")
        .bind(now(), offer.id),
      env.DB.prepare("DELETE FROM num_host_clients WHERE id = ? AND host_id = ?")
        .bind(offer.client_id, host.id),
    ]);
    return list();
  }

  return J({ ok: false, error: "bad_action" }, 400);
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
      from: env.MAIL_FROM || "NUM <info@itsnum.com>",
      to: [c.email],
      replyTo: ["info@itsnum.com"],
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
        "List-Unsubscribe": "<" + site + "/stop/" + c.token + ">, <mailto:info@itsnum.com?subject=unsubscribe>",
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
or write to info@itsnum.com and a person answers.</p>`);
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

  // The guest is standing here with an unlocked phone and a NUM page open.
  // That is the only moment asking "how was it" costs them nothing, so the
  // link is minted now rather than emailed tomorrow. num_bookings has no
  // place_id, so it is read from the ownership table the claim flow writes.
  const owned = await env.DB.prepare(
    "SELECT place_id FROM num_place_owners WHERE business_id = ? LIMIT 1"
  ).bind(venue.business_id).first().catch(() => null);
  const afterTok = await issueAfter(env, {
    bookingId: bk.id, businessId: venue.business_id,
    placeId: owned?.place_id || null, memberRef: bk.member_ref,
  });

  return J({
    ok: true, matched: true, completed: true,
    venue: venue.business_name, perk: venue.perk_text || null,
    after: afterTok ? "/a/" + afterTok : null,
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
or <a href="mailto:info@itsnum.com?subject=Codes%20link">ask us to resend it</a>.</p>`, 401);
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
    from: env.MAIL_FROM || "NUM <info@itsnum.com>",
    to: [to],
    replyTo: ["info@itsnum.com"],
    subject: `Your table codes for ${biz.name}`,
    headers: { "List-Unsubscribe": "<mailto:info@itsnum.com?subject=unsubscribe>" },
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

  // 6-8 : the paylink checks live beside the paylink code (venue_pay section)
  findings.push(...(await payFindings(env)));

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
      from: env.MAIL_FROM || "NUM <info@itsnum.com>",
      to: ["info@5arz.com"],
      replyTo: ["info@itsnum.com"],
      subject: `[NUM security] ${fresh.length} new finding(s) — ${fresh.map(f => f.kind).join(", ")}`,
      headers: { "List-Unsubscribe": "<mailto:info@itsnum.com?subject=unsubscribe>" },
      text: "New findings from the venue security sweep:\n\n" +
        fresh.map(f => `· [${f.severity}] ${f.kind} — ${f.subject}\n  ${f.evidence}`).join("\n\n") +
        "\n\nFull history: SELECT * FROM num_security_findings ORDER BY id DESC;\n" +
        "This sweep only reads logs and writes findings. It cannot change keys, codes or bookings.",
    }]);
  }
  return { checked: 8, found: findings.length, new: fresh.length };
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
or <a href="mailto:info@itsnum.com?subject=Codes%20link">ask us to resend it</a>.</p>`, 401);
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
  <a href="/biz/pay?k=${encodeURIComponent(url.searchParams.get("k") || "")}">Pay</a>
  <a href="/biz/settings?k=${encodeURIComponent(url.searchParams.get("k") || "")}">Settings</a>
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
That link isn't valid. Use the link we sent you, or ask us to resend it: info@itsnum.com</p>`, 401);

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
  <a href="/biz/pay?k=${k}">Pay</a>
  <a href="/biz/settings?k=${k}">Settings</a>
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
That link isn't valid. Use the link we sent you, or ask us to resend it: info@itsnum.com</p>`, 401);

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
  <a href="/biz/pay?k=${k}">Pay</a>
  <a href="/biz/settings?k=${k}">Settings</a>
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
/* ═══════════════════════════════════════════════════════════════════════════
   venue_pay.js — paylink QR codes: scan at the table, pay the venue directly.

   What this is NOT, by design: a payment processor. NUM never holds, routes,
   or touches money. A paylink QR resolves to /p/<token>, a page that shows
   who you are paying and hands you to the venue's OWN rails — either a
   payment URL they already have (Stripe / PayPal / Square / SumUp link) or
   their own Thai PromptPay identity rendered as a standard EMV QR their
   guest's banking app understands. The venue's money goes to the venue.

   What NUM adds is the part processors don't do: per-table identity
   ("Table 4", "Bar seat 9"), print-ready cards, scan tracking a business can
   read, retirement the moment a card walks off, and the same security sweep
   that watches the check-in system. Scans are METERED (num_pay_events, one
   billable per guest per link per 30 minutes) — but no rate exists and no
   invoice is generated anywhere in this file. Metering is not billing.

   Fraud model this is built against, because it is the attack that actually
   happens to table QR payments: someone re-points a table's code at their own
   account. Three answers here:
     1 · targets are immutable — there is NO edit endpoint. Changing where a
         paylink pays means retiring it and creating a new one, both of which
         are key-gated and logged in num_key_events.
     2 · the pay page names the venue in large type before any pay control:
         a guest sitting in Morrisons Lounge looking at "Pay The Longtail
         Bar" is a guest who stops.
     3 · the sweep watches for scan bursts, unknown-token enumeration, and
         traffic still arriving on retired links.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── QR encoder, version 6 / ECC level M ─────────────────────────────────────
   A second fixed-shape encoder, deliberately SEPARATE from the proven v4-H
   closure that draws /v/ check-in codes — sharing nothing means a change here
   can never bend a symbol that is already printed on a thousand table cards.

   Why a second shape at all: an EMV PromptPay payload runs 70–90 characters,
   and v4-H tops out at 34. Version 6 at level M holds 106 — headroom for
   e-wallet ids plus a fixed amount — and M (~15% recovery) is the level the
   EMV merchant-presented spec itself recommends for payment QRs.

   Correctness is demonstrated, not asserted: qr6.verify.mjs diffs this
   encoder's module matrix cell-for-cell against the python `qrcode` reference
   for hundreds of random EMV-shaped payloads, then decodes the rendered
   artwork with OpenCV, then round-trips real PromptPay payloads generated by
   the python `promptpay` package. All three must pass before deploy.        */
const qr6m = (function () {
  const SIZE = 41;                 // version 6: 17 + 6·4
  const DATA_CW = 108;             // 4 blocks × 27
  const BLOCKS = 4, BLOCK_DATA = 27, BLOCK_EC = 16;   // RS(43,27) × 4 = 172
  const EC_LEVEL_BITS = 0b00;      // M, as it appears in the format string

  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  function genPoly(n) {
    let p = [1];
    for (let i = 0; i < n; i++) {
      const q = [1, EXP[i]], r = new Array(p.length + 1).fill(0);
      for (let a = 0; a < p.length; a++) for (let b = 0; b < 2; b++) r[a + b] ^= mul(p[a], q[b]);
      p = r;
    }
    return p;
  }
  function ecFor(data, n) {
    const g = genPoly(n), res = new Array(data.length + n).fill(0);
    data.forEach((v, i) => (res[i] = v));
    for (let i = 0; i < data.length; i++) {
      const f = res[i];
      if (f === 0) continue;
      for (let j = 0; j < g.length; j++) res[i + j] ^= mul(g[j], f);
    }
    return res.slice(data.length);
  }

  function encodeData(text) {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > DATA_CW - 2) throw new Error(`payload too long for v6-M: ${bytes.length} bytes`);
    const bits = [];
    const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
    push(0b0100, 4);               // byte mode
    push(bytes.length, 8);         // v1–9: 8-bit length
    bytes.forEach((b) => push(b, 8));
    const cap = DATA_CW * 8;
    push(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    const cw = [];
    for (let i = 0; i < bits.length; i += 8) cw.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    const PAD = [0xec, 0x11];
    for (let i = 0; cw.length < DATA_CW; i++) cw.push(PAD[i % 2]);
    return cw;
  }

  function finalCodewords(text) {
    const cw = encodeData(text);
    const dB = [], eB = [];
    for (let i = 0; i < BLOCKS; i++) {
      const d = cw.slice(i * BLOCK_DATA, (i + 1) * BLOCK_DATA);
      dB.push(d); eB.push(ecFor(d, BLOCK_EC));
    }
    const out = [];
    for (let i = 0; i < BLOCK_DATA; i++) for (const b of dB) out.push(b[i]);
    for (let i = 0; i < BLOCK_EC; i++) for (const b of eB) out.push(b[i]);
    return out;
  }

  const newMatrix = () => Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));

  function placeFunctionPatterns(m) {
    const finder = (r, c) => {
      for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
        const rr = r + i, cc = c + j;
        if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) continue;
        const on = (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
                   (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
                   (i >= 2 && i <= 4 && j >= 2 && j <= 4);
        m[rr][cc] = on ? 1 : 0;
      }
    };
    finder(0, 0); finder(0, SIZE - 7); finder(SIZE - 7, 0);
    for (let i = 8; i < SIZE - 8; i++) {
      const v = i % 2 === 0 ? 1 : 0;
      if (m[6][i] === null) m[6][i] = v;
      if (m[i][6] === null) m[i][6] = v;
    }
    // version 6 has one alignment pattern clear of the finders, centred (34,34)
    const ac = 34;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      m[ac + i][ac + j] = (Math.max(Math.abs(i), Math.abs(j)) !== 1) ? 1 : 0;
    }
    m[SIZE - 8][8] = 1;            // always-dark module (4·V+9, 8)
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
    const bit = (i) => (f >> (14 - i)) & 1;     // MSB-first, as the spec walks it
    for (let i = 0; i <= 5; i++) m[8][i] = bit(i);
    m[8][7] = bit(6); m[8][8] = bit(7); m[7][8] = bit(8);
    for (let i = 9; i <= 14; i++) m[14 - i][8] = bit(i);
    for (let i = 0; i <= 6; i++) m[SIZE - 1 - i][8] = bit(i);          // 7 vertical
    for (let i = 7; i <= 14; i++) m[8][SIZE - 15 + i] = bit(i);        // 8 horizontal
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
      if (right === 6) right--;
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

  /* Mask scoring — a faithful port of python-qrcode's `lost_point`, INCLUDING
     its skip-optimizations in levels 2 and 3 (which make its scores deviate
     slightly from a literal reading of the ISO rules). That is deliberate:
     matching the reference's scorer means our chosen mask — and therefore the
     entire symbol — is bit-identical to what the world's most widely deployed
     generator would print, a population of symbols that has been decoded by
     real phone cameras at enormous scale. qr6.verify.mjs asserts the
     identity; a "better" scorer that ships an untested symbol is worse. */
  function penalty(m) {
    let p = 0;
    // level 1 — runs of 5+ in rows and columns: (len - 2) each
    const runs = (get) => {
      for (let a = 0; a < SIZE; a++) {
        let prev = get(a, 0), len = 0;
        for (let b = 0; b < SIZE; b++) {
          if (get(a, b) === prev) len++;
          else { if (len >= 5) p += len - 2; len = 1; prev = get(a, b); }
        }
        if (len >= 5) p += len - 2;
      }
    };
    runs((a, b) => m[a][b]); runs((a, b) => m[b][a]);
    // level 2 — 2×2 blocks, with the reference's next()-skip semantics
    for (let row = 0; row < SIZE - 1; row++) {
      for (let col = 0; col < SIZE - 1; col++) {
        const tr = m[row][col + 1];
        if (tr !== m[row + 1][col + 1]) { col++; continue; }
        if (tr !== m[row][col]) continue;
        if (tr !== m[row + 1][col]) continue;
        p += 3;
      }
    }
    // level 3 — 1:1:3:1:1 finder-like pattern with 4-light flank, with the
    // reference's horspool skip (advance an extra cell when cell+10 is dark)
    const l3 = (get) => {
      for (let a = 0; a < SIZE; a++) {
        for (let b = 0; b < SIZE - 10; b++) {
          if (!get(a, b + 1) && get(a, b + 4) && !get(a, b + 5) && get(a, b + 6) && !get(a, b + 9) &&
              ((get(a, b) && get(a, b + 2) && get(a, b + 3) &&
                !get(a, b + 7) && !get(a, b + 8) && !get(a, b + 10)) ||
               (!get(a, b) && !get(a, b + 2) && !get(a, b + 3) &&
                get(a, b + 7) && get(a, b + 8) && get(a, b + 10)))) p += 40;
          if (get(a, b + 10)) b++;
        }
      }
    };
    l3((a, b) => m[a][b]); l3((a, b) => m[b][a]);
    // level 4 — dark-proportion departure from 50%, float division as reference
    let dark = 0;
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) dark += m[r][c];
    p += Math.trunc(Math.abs((dark / (SIZE * SIZE)) * 100 - 50) / 5) * 10;
    return p;
  }

  function matrixWithMask(text, mask) {
    const m = newMatrix();
    placeFunctionPatterns(m);
    placeFormat(m, mask);
    placeData(m, finalCodewords(text), mask);
    return m;
  }

  /* The reference scores each candidate mask on a TEST-MODE matrix: format
     info and the always-dark module blanked to light (makeImpl(test=True)).
     Scoring the real matrix instead picks a different mask often enough to
     ship symbols the reference would never print — so we blank the same 31
     cells before scoring, and only the winning mask gets real format bits. */
  function blankFormatCells(m) {
    for (let i = 0; i <= 8; i++) { if (i !== 6) { m[8][i] = 0; m[i][8] = 0; } }
    for (let i = 0; i <= 6; i++) m[SIZE - 1 - i][8] = 0;
    for (let i = 7; i <= 14; i++) m[8][SIZE - 15 + i] = 0;
    m[SIZE - 8][8] = 0;
    return m;
  }

  function matrix(text) {
    let bestMask = 0, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const s = penalty(blankFormatCells(matrixWithMask(text, mask)));
      if (s < bestScore) { bestScore = s; bestMask = mask; }
    }
    return matrixWithMask(text, bestMask);
  }

  function svg(text, { border = 3, dark = "#131a16", light = "#ffffff" } = {}) {
    const m = matrix(text);
    const n = SIZE + border * 2, d = [];
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
      `shape-rendering="crispEdges" role="img" aria-label="PromptPay QR code">` +
      `<rect width="${n}" height="${n}" fill="${light}"/>` +
      `<path fill="${dark}" d="${d.join("")}"/></svg>`;
  }

  return { matrix, matrixWithMask, svg, SIZE };
})();

/* ── PromptPay EMV payload ───────────────────────────────────────────────────
   EMVCo merchant-presented TLV, byte-for-byte the format the python
   `promptpay` reference produces (verified in qr6.verify.mjs):
     000201 · 010211(static)/010212(has amount) · 29xx merchant-account
     [0016 A000000677010111 + proxy] · 5802TH · 5303764 · [54xx amount] ·
     6304 + CRC-16/CCITT-FALSE, uppercase.
   Proxy forms: phone 0812345678 → 0066812345678 (13) · tax id: 13 digits
   as given · e-wallet: 15 digits as given.                                  */
function promptPayProxy(idRaw) {
  const id = String(idRaw || "").replace(/[^0-9]/g, "");
  if (/^0\d{9}$/.test(id)) return { kind: "phone",   proxy: "0066" + id.slice(1), sub: "01" };
  if (/^\d{13}$/.test(id)) return { kind: "tax_id",  proxy: id,                   sub: "02" };
  if (/^\d{15}$/.test(id)) return { kind: "ewallet", proxy: id,                   sub: "03" };
  return null;
}

function crc16ccitt(s) {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

const tlv = (tag, value) => tag + String(value.length).padStart(2, "0") + value;

function promptPayPayload(idRaw, amount) {
  const p = promptPayProxy(idRaw);
  if (!p) return null;
  const merchant = tlv("29", tlv("00", "A000000677010111") + tlv(p.sub, p.proxy));
  let s = tlv("00", "01") + tlv("01", amount ? "12" : "11") + merchant +
          tlv("58", "TH") + tlv("53", "764");
  if (amount) s += tlv("54", Number(amount).toFixed(2));
  s += "6304";
  return s + crc16ccitt(s);
}

/* ── validation ──────────────────────────────────────────────────────────────
   A paylink target is the one field where bad input becomes someone else's
   lost money, so the rules are strict and the refusals are specific.        */
function validPayTarget(kind, raw) {
  if (kind === "promptpay") {
    const p = promptPayProxy(raw);
    if (!p) return { ok: false, error: "bad_promptpay_id",
      hint: "a Thai mobile (0812345678), 13-digit tax ID, or 15-digit e-wallet ID" };
    return { ok: true, target: String(raw).replace(/[^0-9]/g, ""), promptpay_kind: p.kind };
  }
  if (kind === "crypto") {
    // The asset is ours to choose from a verified list; the address is theirs.
    // A wrong token contract cannot come from a merchant typing.
    const asset = String(raw && raw.asset || "usdc-base");
    if (!CRYPTO.ASSETS[asset]) {
      return { ok: false, error: "unknown_asset", assets: CRYPTO.assetKeys() };
    }
    const addr = CRYPTO.validAddress(raw && raw.address != null ? raw.address : raw);
    if (!addr.ok) return { ok: false, error: "bad_address", hint: addr.reason };
    return { ok: true, target: addr.address, crypto_asset: asset };
  }
  if (kind === "url") {
    const s = String(raw || "").trim();
    if (s.length > 300) return { ok: false, error: "url_too_long" };
    let u;
    try { u = new URL(s); } catch (e) { return { ok: false, error: "bad_url" }; }
    if (u.protocol !== "https:") return { ok: false, error: "https_only" };
    if (u.username || u.password) return { ok: false, error: "no_credentials_in_url" };
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(u.hostname) || u.hostname.includes("["))
      return { ok: false, error: "no_ip_hosts" };
    const h = u.hostname.toLowerCase();
    if (h === "itsnum.com" || h.endsWith(".itsnum.com"))
      return { ok: false, error: "target_cannot_be_num" };
    return { ok: true, target: u.href };
  }
  return { ok: false, error: "bad_kind", kinds: ["url", "promptpay", "crypto"] };
}

function validPayAmount(raw) {
  if (raw == null || raw === "") return { ok: true, amount: null };
  const n = Number(raw);
  if (!isFinite(n) || n <= 0 || n > 1000000) return { ok: false, error: "bad_amount" };
  return { ok: true, amount: n.toFixed(2) };
}

const PAY_CURRENCIES = ["THB", "GBP", "USD", "EUR"];

/* ── event log — the meter ───────────────────────────────────────────────────
   Every event is written; `billable` marks the ones a future invoice could
   count. One billable per guest per link per 30 minutes: a refresh, a
   double-scan, a flaky connection must never become two billed scans.
   Nothing in this codebase turns the meter into a charge — that requires a
   rate, and rates are set by a person, not by code.                         */
async function logPayEvent(env, req, o) {
  try {
    let billable = 0;
    if (o.kind === "scan" && o.active) {
      const vid = await visitorId(req, env);
      const dup = await env.DB.prepare(
        `SELECT 1 FROM num_pay_events
          WHERE token=? AND visitor_id=? AND billable=1
            AND created_at > datetime('now','-30 minutes') LIMIT 1`
      ).bind(o.token, vid).first();
      billable = dup ? 0 : 1;
      o.visitor_id = vid;
    }
    await env.DB.prepare(
      `INSERT INTO num_pay_events (token,business_id,kind,billable,visitor_id,ip_hash,day,created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(o.token, o.business_id || "", o.kind, billable, o.visitor_id || null,
           await ipHash(req), now().slice(0, 10), now()).run();
    return billable;
  } catch (e) { console.warn("[pay] log failed:", String(e).slice(0, 120)); return 0; }
}

/* ── GET /p/<token> — what the guest's camera opens ─────────────────────── */
async function payLanding(req, env, tok) {
  const ptok = clean(tok, 40).toUpperCase();
  const link = await env.DB.prepare(
    `SELECT l.token, l.business_id, l.label, l.kind, l.target, l.amount, l.currency,
            l.state, l.crypto_asset, l.crypto_base_units, l.crypto_quote,
            b.name AS business_name
       FROM num_paylinks l JOIN businesses b ON b.id = l.business_id
      WHERE l.token = ?`
  ).bind(ptok).first();

  if (!link) {
    await logPayEvent(env, req, { token: ptok, business_id: "", kind: "unknown_token" });
    return HTML(payPage({ state: "unknown" }), 404);
  }
  if (link.state === "revoked") {
    await logPayEvent(env, req, { token: ptok, business_id: link.business_id, kind: "retired_view" });
    return HTML(payPage({ state: "retired", venue: link.business_name }), 410);
  }
  await logPayEvent(env, req, { token: ptok, business_id: link.business_id, kind: "scan", active: true });
  let cryptoInfo = null;
  let walletUri = null;
  if (link.kind === "crypto") {
    // The quote was stamped when the code was minted. An open sticker has no
    // quote at all — it names the asset and the guest sends what the bill says.
    try { cryptoInfo = link.crypto_quote ? JSON.parse(link.crypto_quote) : null; } catch (e) { cryptoInfo = null; }
    const a = CRYPTO.ASSETS[link.crypto_asset || "usdc-base"];
    cryptoInfo = Object.assign({ asset: a?.asset || "USDC", chain: a?.label || "Base" }, cryptoInfo || {});
    // The deep link carries what the QR cannot: the exact amount, so the
    // guest never types a figure. Only for a bill — an open sticker has no
    // amount to fill in.
    walletUri = link.crypto_base_units
      ? CRYPTO.paymentUri(link.crypto_asset || "usdc-base", link.target, BigInt(link.crypto_base_units))
      : null;
  }
  return HTML(payPage({
    state: "pay", token: ptok, venue: link.business_name, label: link.label,
    kind: link.kind, amount: link.amount, currency: link.currency,
    promptpayId: link.kind === "promptpay" ? link.target : null,
    target: link.target, crypto: cryptoInfo, walletUri,
  }));
}

/* ── GET /p/<token>/go — the tracked hop to the venue's own rails ────────── */
async function payGo(req, env, tok) {
  const ptok = clean(tok, 40).toUpperCase();
  const link = await env.DB.prepare(
    "SELECT token,business_id,kind,target,state FROM num_paylinks WHERE token=?"
  ).bind(ptok).first();
  if (!link || link.kind !== "url") return TEXT("not found", 404);
  if (link.state === "revoked") return TEXT("retired", 410);
  await logPayEvent(env, req, { token: ptok, business_id: link.business_id, kind: "tap_through" });
  return new Response(null, { status: 302, headers: { location: link.target, "cache-control": "no-store" } });
}

/* ── QR artwork ──────────────────────────────────────────────────────────────
   /api/pay/qr/<TOKEN>.svg  — the NUM link QR (camera → /p/ page), any kind.
   /api/pay/emv/<TOKEN>.svg — the PromptPay EMV QR (banking app), promptpay
   links only: refusing to draw it for a url-kind link means a print sheet
   can never carry a bank-scannable code that pays nobody.
   Both public by design — they encode what is printed on a card anyone can
   photograph, and nothing else.                                             */
async function payQrRoute(req, env, rest) {
  const t = clean(String(rest || "").replace(/\.svg$/i, ""), 40).toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(t)) return TEXT("bad token", 400);
  const row = await env.DB.prepare(
    "SELECT token, kind, target, crypto_asset, crypto_base_units FROM num_paylinks WHERE token=?"
  ).bind(t).first();
  if (!row) return TEXT("unknown token", 404);
  // Crypto codes point at the /p/ page too, not at an EIP-681 URI.
  //
  // Two reasons, and the second is the important one. The encoders in this
  // worker are fixed-version — qrSvg is 4-H (~34 bytes) and qr6m is 6-M
  // (~106) — and an ERC-20 payment request is 133 bytes, so neither can hold
  // one; encoding it threw, which is how this was found. But routing through
  // the page is also what we would want anyway: a guest scanning a sticker
  // with their phone camera gets the venue name, the exact amount, the
  // network, and the warning that this cannot be undone, and taps through to
  // their wallet from there. A bare payment URI shows them a hex address and
  // nothing to check it against.
  return new Response(qrSvg((env.SITE || "https://itsnum.com") + "/p/" + t), {
    headers: { "content-type": "image/svg+xml; charset=utf-8",
               "cache-control": "public, max-age=31536000, immutable" } });
}

async function payEmvRoute(req, env, rest) {
  const t = clean(String(rest || "").replace(/\.svg$/i, ""), 40).toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(t)) return TEXT("bad token", 400);
  const row = await env.DB.prepare(
    "SELECT token,kind,target,amount,state FROM num_paylinks WHERE token=?"
  ).bind(t).first();
  if (!row || row.kind !== "promptpay") return TEXT("unknown token", 404);
  if (row.state === "revoked") return TEXT("retired", 410);
  const payload = promptPayPayload(row.target, row.amount);
  if (!payload) return TEXT("bad id", 500);
  return new Response(qr6m.svg(payload), {
    headers: { "content-type": "image/svg+xml; charset=utf-8",
               "cache-control": "public, max-age=86400" } });
}

/* ── manager API (all bizAuth-gated, all logged) ─────────────────────────── */
async function venuePayList(req, env, url) {
  const biz = await bizAuth(env, url, req);
  if (!biz) return J({ ok: false, error: "unauthorised" }, 401);
  const { results } = await env.DB.prepare(
    `SELECT l.token, l.label, l.kind, l.target, l.amount, l.currency, l.zone_type,
            l.state, l.created_at, l.revoked_at,
            (SELECT COUNT(*) FROM num_pay_events e
              WHERE e.token = l.token AND e.kind='scan')        AS scans,
            (SELECT COUNT(*) FROM num_pay_events e
              WHERE e.token = l.token AND e.kind='tap_through') AS taps,
            (SELECT MAX(created_at) FROM num_pay_events e WHERE e.token = l.token) AS last_scan
       FROM num_paylinks l
      WHERE l.business_id = ?
      ORDER BY l.state = 'revoked', l.created_at`
  ).bind(biz.id).all();
  const month = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM num_pay_events
      WHERE business_id=? AND kind='scan' AND day >= ?`
  ).bind(biz.id, now().slice(0, 8) + "01").first();
  return J({ ok: true, business: biz.name, month_scans: month?.n || 0, paylinks: results || [] });
}

async function venuePayCreate(req, env, url) {
  const biz = await bizAuth(env, url, req);
  if (!biz) return J({ ok: false, error: "unauthorised" }, 401);
  let b;
  try { b = await readJSON(req, 4096); } catch (e) { return J({ ok: false }, 400); }

  const label = clean(b.label, 40);
  if (!label) return J({ ok: false, error: "label_required" }, 400);
  const kind = clean(b.kind, 12);
  const vt = validPayTarget(kind, b.target);
  if (!vt.ok) return J(vt, 400);
  const va = validPayAmount(b.amount);
  if (!va.ok) return J(va, 400);
  const currency = PAY_CURRENCIES.includes(clean(b.currency, 3).toUpperCase())
    ? clean(b.currency, 3).toUpperCase() : "THB";

  const live = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM num_paylinks WHERE business_id=? AND state='active'"
  ).bind(biz.id).first();
  if ((live?.n || 0) >= MAX_ACTIVE_CODES)
    return J({ ok: false, error: "too_many_paylinks", max: MAX_ACTIVE_CODES }, 409);

  const dup = await env.DB.prepare(
    "SELECT token FROM num_paylinks WHERE business_id=? AND state='active' AND lower(label)=lower(?)"
  ).bind(biz.id, label).first();
  if (dup) return J({ ok: false, error: "label_exists", token: dup.token }, 409);

  for (let attempt = 0; attempt < 6; attempt++) {
    const t = newToken();
    try {
      await env.DB.prepare(
        `INSERT INTO num_paylinks
           (token,business_id,label,kind,target,promptpay_kind,amount_mode,amount,currency,zone_type,state,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'active', ?)`
      ).bind(t, biz.id, label, kind, vt.target, vt.promptpay_kind || null,
             va.amount ? "fixed" : "open", va.amount, currency,
             clean(b.zone_type, 20) || null, now()).run();
      await logKeyEvent(env, req, biz.id, "ok", "paylink_create:" + label);
      return J({ ok: true, token: t, label, kind,
                 url: (env.SITE || "https://itsnum.com") + "/p/" + t });
    } catch (e) { if (!String(e).includes("UNIQUE")) throw e; }
  }
  return J({ ok: false, error: "could_not_allocate" }, 503);
}

/* Retire / reinstate. There is deliberately no way to CHANGE a target —
   where money goes is immutable per token. Retire it, make a new one. */
async function venuePayState(req, env, url) {
  const biz = await bizAuth(env, url, req);
  if (!biz) return J({ ok: false, error: "unauthorised" }, 401);
  let b;
  try { b = await readJSON(req, 2048); } catch (e) { return J({ ok: false }, 400); }
  const t = clean(b.token, 40).toUpperCase();
  const to = clean(b.state, 12);
  if (!t || !["revoked", "active"].includes(to))
    return J({ ok: false, error: "missing_fields" }, 400);
  const row = await env.DB.prepare(
    "SELECT token,state,label FROM num_paylinks WHERE token=? AND business_id=?"
  ).bind(t, biz.id).first();
  if (!row) return J({ ok: false, error: "unknown_token" }, 404);
  if (row.state === to) return J({ ok: true, unchanged: true, state: to });
  await env.DB.prepare(
    to === "revoked"
      ? "UPDATE num_paylinks SET state='revoked', revoked_at=?, revoked_by=? WHERE token=?"
      : "UPDATE num_paylinks SET state='active', revoked_at=NULL, revoked_by=NULL WHERE token=?"
  ).bind(...(to === "revoked" ? [now(), "biz:" + biz.id, t] : [t])).run();
  await logKeyEvent(env, req, biz.id, "ok", "paylink_" + to + ":" + row.label);
  return J({ ok: true, token: t, state: to, label: row.label });
}

/* Bulk: one payment identity, a whole floor of labelled QRs.
   { template:"bar", kind, target } or { zone_type, count, kind, target }.  */
async function venuePayBulk(req, env, url) {
  const biz = await bizAuth(env, url, req);
  if (!biz) return J({ ok: false, error: "unauthorised" }, 401);
  let b;
  try { b = await readJSON(req, 4096); } catch (e) { return J({ ok: false }, 400); }

  const kind = clean(b.kind, 12);
  const vt = validPayTarget(kind, b.target);
  if (!vt.ok) return J(vt, 400);
  const va = validPayAmount(b.amount);
  if (!va.ok) return J(va, 400);
  const currency = PAY_CURRENCIES.includes(clean(b.currency, 3).toUpperCase())
    ? clean(b.currency, 3).toUpperCase() : "THB";

  let plan = [];
  if (b.template) {
    const tp = FLOOR_TEMPLATES[clean(b.template, 20)];
    if (!tp) return J({ ok: false, error: "unknown_template",
                        templates: Object.keys(FLOOR_TEMPLATES) }, 400);
    for (const [zone, n] of Object.entries(tp.zones))
      for (let i = 1; i <= n; i++)
        plan.push([zone, n === 1 ? ZONE_LABEL[zone] : `${ZONE_LABEL[zone]} ${i}`]);
  } else {
    const zone = clean(b.zone_type, 20);
    const count = Math.min(Math.max(1, Math.round(Number(b.count) || 0)), 100);
    if (!ZONE_TYPES.includes(zone) || !count)
      return J({ ok: false, error: "bad_zone_or_count", zones: ZONE_TYPES }, 400);
    let start = Math.max(1, Math.round(Number(b.start) || 0));
    if (!b.start) {
      const ex = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM num_paylinks WHERE business_id=? AND zone_type=? AND state='active'"
      ).bind(biz.id, zone).first();
      start = (ex?.n || 0) + 1;
    }
    for (let i = 0; i < count; i++)
      plan.push([zone, count === 1 && start === 1 ? ZONE_LABEL[zone]
                                                  : `${ZONE_LABEL[zone]} ${start + i}`]);
  }

  const live = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM num_paylinks WHERE business_id=? AND state='active'"
  ).bind(biz.id).first();
  if ((live?.n || 0) + plan.length > MAX_ACTIVE_CODES)
    return J({ ok: false, error: "too_many_paylinks",
               active: live?.n || 0, requested: plan.length, max: MAX_ACTIVE_CODES }, 409);

  const { results: existing } = await env.DB.prepare(
    "SELECT lower(label) AS l FROM num_paylinks WHERE business_id=? AND state='active'"
  ).bind(biz.id).all();
  const have = new Set((existing || []).map((r) => r.l));

  const made = [], skipped = [];
  const site = env.SITE || "https://itsnum.com";
  for (const [zone, label] of plan) {
    if (have.has(label.toLowerCase())) { skipped.push(label); continue; }
    for (let attempt = 0; attempt < 6; attempt++) {
      const t = newToken();
      try {
        await env.DB.prepare(
          `INSERT INTO num_paylinks
             (token,business_id,label,kind,target,promptpay_kind,amount_mode,amount,currency,zone_type,state,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?, 'active', ?)`
        ).bind(t, biz.id, label, kind, vt.target, vt.promptpay_kind || null,
               va.amount ? "fixed" : "open", va.amount, currency, zone, now()).run();
        made.push({ token: t, label, zone_type: zone, url: `${site}/p/${t}` });
        break;
      } catch (e) { if (!String(e).includes("UNIQUE")) throw e; }
    }
  }
  await logKeyEvent(env, req, biz.id, "ok", "paylink_bulk:" + made.length);
  return J({ ok: true, created: made.length, skipped, paylinks: made });
}

/* ── GET /api/admin/pay/meter (x-admin-key) — the future invoice's source ──
   Read-only rollup of billable scans per business per month. This is the
   ONLY consumer of the `billable` flag, and it charges nobody: it exists so
   that when a rate is finally set, the first invoice is computed from data
   that was being collected honestly all along.                              */
async function adminPayMeter(req, env) {
  const key = req.headers.get("x-admin-key") || "";
  if (!env.ADMIN_KEY || !sameSecret(env.ADMIN_KEY, key))
    return J({ ok: false, error: "unauthorised" }, 401);
  const { results } = await env.DB.prepare(
    `SELECT e.business_id, b.name, substr(e.day,1,7) AS month,
            SUM(e.billable) AS billable_scans,
            SUM(CASE WHEN e.kind='scan' THEN 1 ELSE 0 END) AS raw_scans,
            SUM(CASE WHEN e.kind='tap_through' THEN 1 ELSE 0 END) AS tap_throughs
       FROM num_pay_events e LEFT JOIN businesses b ON b.id = e.business_id
      WHERE e.business_id != ''
      GROUP BY e.business_id, month
      ORDER BY month DESC, billable_scans DESC LIMIT 200`
  ).all();
  return J({ ok: true, note: "meter only — no rate is set and nothing is invoiced",
             months: results || [] });
}

/* ── security sweep additions ────────────────────────────────────────────────
   Returns findings in the same shape securitySweep() stores; called from it.*/
async function payFindings(env) {
  const findings = [];
  const q = async (sql, ...args) =>
    (await env.DB.prepare(sql).bind(...args).all()).results || [];

  // 6 · unknown pay tokens from one network — someone enumerating /p/
  for (const r of await q(
    `SELECT COALESCE(ip_hash,'?') AS net, COUNT(*) AS n
       FROM num_pay_events
      WHERE kind='unknown_token' AND created_at > datetime('now','-1 day')
      GROUP BY ip_hash HAVING n > 30`)) {
    findings.push({ kind: "pay_token_scanning", subject: r.net, severity: "warn",
      evidence: `${r.n} scans of nonexistent paylinks from one network in 24h` });
  }

  // 7 · scan burst on one link — a misprint gone viral, or abuse
  for (const r of await q(
    `SELECT token, business_id, COUNT(*) AS n
       FROM num_pay_events
      WHERE kind='scan' AND created_at > datetime('now','-1 day')
      GROUP BY token HAVING n > 300`)) {
    findings.push({ kind: "pay_scan_burst", subject: r.business_id + "/" + r.token,
      severity: "warn", evidence: `${r.n} scans of one paylink in 24h` });
  }

  // 8 · retired links still being scanned — old cards are still on tables,
  //     which after a fraud-driven retirement is exactly the wrong state
  for (const r of await q(
    `SELECT business_id, COUNT(*) AS n
       FROM num_pay_events
      WHERE kind='retired_view' AND created_at > datetime('now','-1 day')
      GROUP BY business_id HAVING n > 20`)) {
    findings.push({ kind: "pay_retired_traffic", subject: r.business_id, severity: "warn",
      evidence: `${r.n} scans in 24h hit retired paylinks — printed cards likely still out` });
  }
  return findings;
}

/* ── pages ─────────────────────────────────────────────────────────────── */
function payShell(inner, title) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title || "Pay — NUM")}</title>
<style>
body{font:17px/1.6 -apple-system,'Segoe UI',sans-serif;background:#faf8f4;color:#131a16;
  margin:0;display:flex;justify-content:center}
main{max-width:430px;width:100%;padding:28px 22px 40px}
.venue{font-size:24px;font-weight:800;letter-spacing:-.3px;margin:10px 0 2px}
.lbl{display:inline-block;font-size:14px;font-weight:600;background:#fff;
  border:1px solid #e0ddd4;border-radius:8px;padding:2px 10px;margin-left:6px;vertical-align:3px}
h1{font-size:20px;margin:14px 0 6px}
.lede{color:#4a5450;margin:0 0 18px}
.amount{font-size:34px;font-weight:800;margin:8px 0 16px}
.btn{display:block;width:100%;text-align:center;background:#1f3a34;color:#fff;border:0;
  border-radius:12px;padding:16px;font-size:18px;font-weight:700;text-decoration:none;box-sizing:border-box}
.btn.ghost{background:transparent;color:#1f3a34;border:1.5px solid #1f3a34;margin-top:10px}
.ppbox{background:#fff;border:1px solid #e0ddd4;border-radius:14px;padding:18px;margin:14px 0}
.ppid{font-size:22px;font-weight:700;letter-spacing:1px;font-variant-numeric:tabular-nums}
.note{font-size:14px;color:#4a5450;margin-top:18px}
.warn{font-size:14px;background:#fff;border:1px solid #e0ddd4;border-left:4px solid #b4552d;
  border-radius:8px;padding:10px 12px;margin-top:16px;color:#4a5450}
.foot{font-size:13px;color:#7a827e;margin-top:26px}
</style></head><body><main>${inner}</main></body></html>`;
}

function payPage(o) {
  if (o.state === "unknown") return payShell(`
    <h1>This payment code isn't one of ours</h1>
    <p class="lede">Nothing was charged. If this QR was on a table or a bill,
    it did not come from NUM — please pay the venue directly and let staff know.</p>
    <a class="btn ghost" href="https://itsnum.com/">Go to NUM</a>`, "Unknown code — NUM");

  if (o.state === "retired") return payShell(`
    <h1>This payment code has been retired</h1>
    <p class="lede">${esc(o.venue)} replaced it. Ask staff for the current one —
    old codes stop working the moment they're replaced, which is the point.</p>
    <a class="btn ghost" href="https://itsnum.com/">Go to NUM</a>`, "Retired code — NUM");

  const amt = o.amount ? `${esc(o.currency)} ${esc(o.amount)}` : null;

  if (o.kind === "crypto") {
    const a = o.crypto || {};
    return payShell(`
    <div class="venue">${esc(o.venue)}${o.label ? `<span class="lbl">${esc(o.label)}</span>` : ""}</div>
    <h1>Pay in ${esc(a.asset || "USDC")}</h1>
    ${a.display ? `<div class="amount">${esc(a.display)} ${esc(a.asset || "USDC")}</div>` : ""}
    ${amt ? `<p class="lede">Your bill is <b>${amt}</b>${a.rate ? ` — converted at ${esc(String(a.rate))} ${esc(o.currency)} to the dollar` : ""}.</p>` : ""}
    <p class="lede">Scan with your wallet and send
    <b>${esc(a.asset || "USDC")} on ${esc(a.chain || "Base")}</b>. The money goes
    straight to ${esc(o.venue)}. NUM never holds it.</p>
    <div class="ppbox">Send to<br><span class="ppid" style="font-size:13px;word-break:break-all">${esc(o.target)}</span><br>
    <span class="note">${a.display ? `Exactly ${esc(a.display)} ${esc(a.asset)}.` : "Send the amount on your bill."}
    Only ${esc(a.asset || "USDC")} on ${esc(a.chain || "Base")} — another network or another
    coin may not arrive.</span></div>
    ${o.walletUri ? `<a class="btn" href="${esc(o.walletUri)}">Open in my wallet</a>
    <p class="note">This fills in the address and the exact amount for you, so
    there is no figure to type.</p>` : ""}
    <div class="warn">Crypto payments cannot be reversed. Check the address and
    the network before you send, and if anything looks wrong — don't pay, and
    tell staff.</div>
    <p class="foot">Powered by NUM · <a href="https://itsnum.com/">itsnum.com</a></p>`,
      "Pay " + o.venue + " — NUM");
  }

  const inner = o.kind === "url" ? `
    <div class="venue">${esc(o.venue)}${o.label ? `<span class="lbl">${esc(o.label)}</span>` : ""}</div>
    <h1>Pay ${esc(o.venue)}</h1>
    ${amt ? `<div class="amount">${amt}</div>`
          : `<p class="lede">The amount is on your bill — you'll confirm it on the venue's payment page.</p>`}
    <a class="btn" href="/p/${esc(o.token)}/go" rel="noopener">Continue to payment</a>
    <p class="note">You'll pay on ${esc(o.venue)}'s own payment page. NUM never
    holds your money and never sees your card.</p>
    <div class="warn">Not at ${esc(o.venue)} right now? Then this code isn't for
    your table — don't pay, and tell staff.</div>
    <p class="foot">Powered by NUM · <a href="https://itsnum.com/">itsnum.com</a></p>` : `
    <div class="venue">${esc(o.venue)}${o.label ? `<span class="lbl">${esc(o.label)}</span>` : ""}</div>
    <h1>Pay by PromptPay</h1>
    ${amt ? `<div class="amount">${amt}</div>` : ""}
    <p class="lede">Open your Thai banking app and scan the <b>printed PromptPay
    QR</b> on this card — the bank pays ${esc(o.venue)} directly.</p>
    <div class="ppbox">PromptPay ID<br><span class="ppid">${esc(o.promptpayId)}</span><br>
    <span class="note">You can also enter this ID in your banking app's PromptPay
    transfer screen${amt ? ` — the amount is ${amt}` : ""}.</span></div>
    <p class="note">Payment goes straight from your bank to ${esc(o.venue)}.
    NUM never holds your money.</p>
    <div class="warn">The name your banking app shows before you confirm should
    match ${esc(o.venue)}. If it doesn't — don't pay, and tell staff.</div>
    <p class="foot">Powered by NUM · <a href="https://itsnum.com/">itsnum.com</a></p>`;
  return payShell(inner, "Pay " + o.venue + " — NUM");
}

/* ── GET /biz/pay?k= — the manager, and the print surface ────────────────── */
async function venuePayPage(req, env, url) {
  const biz = await bizAuth(env, url, req);
  if (!biz) return HTML(payShell(`<h1>That link isn't valid</h1>
    <p class="lede">Manager links rotate when a business asks for a new one.
    Check the most recent email from NUM, or reply to it and we'll reissue.</p>`, "NUM"), 401);

  const k = encodeURIComponent(url.searchParams.get("k") || "");
  const { results: links } = await env.DB.prepare(
    `SELECT l.token,l.label,l.kind,l.target,l.amount,l.currency,l.zone_type,l.state,
            (SELECT COUNT(*) FROM num_pay_events e WHERE e.token=l.token AND e.kind='scan') AS scans
       FROM num_paylinks l WHERE l.business_id=? ORDER BY l.state='revoked', l.created_at`
  ).bind(biz.id).all();
  const month = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM num_pay_events WHERE business_id=? AND kind='scan' AND day >= ?`
  ).bind(biz.id, now().slice(0, 8) + "01").first();

  const active = (links || []).filter((l) => l.state === "active");
  const retired = (links || []).filter((l) => l.state !== "active");
  const card = (l) => `
    <div class="card" data-tok="${esc(l.token)}">
      ${l.kind === "promptpay"
        ? `<img class="emv" src="/api/pay/emv/${esc(l.token)}.svg" alt="PromptPay QR ${esc(l.label)}">
           <div class="scanhint">Scan with your <b>banking app</b> to pay</div>
           <img class="numqr" src="/api/pay/qr/${esc(l.token)}.svg" alt="NUM QR ${esc(l.label)}">
           <div class="scanhint small">or camera-scan for details</div>`
        : `<img class="emv" src="/api/pay/qr/${esc(l.token)}.svg" alt="Pay QR ${esc(l.label)}">
           <div class="scanhint">Scan with your <b>camera</b> to pay</div>`}
      <div class="cardlabel">${esc(biz.name)} · ${esc(l.label)}</div>
      ${l.amount ? `<div class="cardamt">${esc(l.currency)} ${esc(l.amount)}</div>` : ""}
    </div>`;

  const row = (l) => `
    <tr class="${l.state === 'active' ? '' : 'dead'}">
      <td><b>${esc(l.label)}</b><br><span class="mut">${esc(l.kind === 'promptpay' ? 'PromptPay · ' + l.target : l.target)}</span></td>
      <td>${l.amount ? esc(l.currency + " " + l.amount) : "open"}</td>
      <td>${l.scans}</td>
      <td>${l.state === "active"
        ? `<button class="mini" onclick="setState('${esc(l.token)}','revoked')">Retire</button>`
        : `<button class="mini" onclick="setState('${esc(l.token)}','active')">Reinstate</button>`}</td>
    </tr>`;

  return HTML(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Payment QRs — ${esc(biz.name)}</title>
<style>
:root{--paper:#faf8f4;--ink:#131a16;--pine:#1f3a34;--green:#1e7a4d;--line:#e0ddd4;--warn:#b4552d}
body{font:16px/1.6 -apple-system,'Segoe UI',Inter,sans-serif;background:var(--paper);color:var(--ink);
  margin:0;padding:22px 18px 60px;max-width:920px;margin-inline:auto}
h1{font-size:22px;margin:0 0 2px}
.sub{color:#4a5450;margin:0 0 18px;font-size:14px}
.nav{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 20px}
.nav a{font-size:14px;font-weight:600;text-decoration:none;padding:7px 14px;
  border-radius:10px;border:1.5px solid var(--pine);color:var(--pine)}
.nav .on{background:var(--pine);color:#fff}
.tile{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:18px}
.count{font-weight:700}
label{display:block;font-size:13px;font-weight:600;margin:10px 0 3px}
input,select{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid var(--line);border-radius:9px;background:#fff}
.btn{background:var(--pine);color:#fff;border:0;border-radius:10px;padding:12px 18px;font-size:15px;font-weight:700;margin-top:12px;cursor:pointer}
.mini{font:600 13px/1 inherit;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:#fff;cursor:pointer}
table{width:100%;border-collapse:collapse;font-size:14px}
td{padding:9px 8px;border-top:1px solid var(--line);vertical-align:top}
.mut{color:#7a827e;font-size:12px;word-break:break-all}
.dead{opacity:.45}
#out{font-size:14px;margin-top:10px;color:var(--warn);white-space:pre-wrap}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.card{background:#fff;border:1.5px solid var(--ink);border-radius:12px;padding:16px;text-align:center;page-break-inside:avoid}
.card img.emv{width:180px;height:180px}
.card img.numqr{width:74px;height:74px;margin-top:8px}
.scanhint{font-size:13px;color:#4a5450}.scanhint.small{font-size:11px}
.cardlabel{font-weight:800;margin-top:8px}
.cardamt{font-weight:700;font-size:15px}
.meter{font-size:14px;color:#4a5450}
@media print{body{padding:0;background:#fff}
  .tile,.nav,h1,.sub,#out,table,.noprint{display:none!important}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10mm;padding:8mm}}
@media (max-width:520px){.grid{grid-template-columns:1fr 1fr}}
</style></head><body>
<h1>Payment QRs</h1>
<p class="sub">${esc(biz.name)} · <span class="meter">${month?.n || 0} scans this month</span></p>
<div class="nav">
  <a href="/biz/codes?k=${k}">Codes</a>
  <a href="/biz/visitors?k=${k}">Visitors</a>
  <a href="/biz/offers?k=${k}">Offers</a>
  <a class="on" href="/biz/pay?k=${k}">Pay</a>
  <a href="/biz/settings?k=${k}">Settings</a>
</div>

<div class="tile noprint">
  <b>Add a payment QR</b>
  <p class="sub" style="margin-top:4px">Guests scan it, see <i>${esc(biz.name)} · the table's name</i>,
  and pay you directly — by your own payment link, or by PromptPay from their Thai banking app.
  NUM never touches the money. Where a code pays can never be edited: retire it and make a new
  one, so a changed target is always a visible, logged act.</p>
  <label>Label</label><input id="f_label" placeholder="Table 4">
  <label>How guests pay</label>
  <select id="f_kind">
    <option value="promptpay">PromptPay (Thai banking apps)</option>
    <option value="url">My payment link (Stripe, PayPal, Square…)</option>
  </select>
  <label id="l_target">PromptPay ID — mobile, tax ID, or e-wallet</label>
  <input id="f_target" placeholder="0812345678">
  <label>Fixed amount — leave empty to let the guest enter it</label>
  <input id="f_amount" inputmode="decimal" placeholder="">
  <button class="btn" onclick="createLink()">Create</button>
  <div style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
    <b style="font-size:14px">Whole floor at once</b>
    <p class="sub" style="margin:2px 0 8px">Uses the same payment details for every spot,
    labelled to match your table codes.</p>
    <select id="f_tpl">${Object.entries(FLOOR_TEMPLATES).map(([kk, v]) =>
      `<option value="${esc(kk)}">${esc(v.label)}</option>`).join("")}</select>
    <button class="btn" onclick="bulk()">Create floor</button>
  </div>
  <div id="out"></div>
</div>

<div class="tile noprint">
  <b>Your payment QRs</b> · <span class="count">${active.length} active</span>
  <table><tbody>${active.map(row).join("")}${retired.map(row).join("")}</tbody></table>
</div>

<div class="tile noprint"><b>Print</b>
  <p class="sub" style="margin:4px 0 0">Cmd/Ctrl-P prints just the cards below — one per spot,
  ready to cut. PromptPay cards carry the bank-app QR big and the camera QR small.</p>
</div>
<div class="grid">${active.map(card).join("")}</div>

<script>
var K=${JSON.stringify(url.searchParams.get("k") || "")};
document.getElementById('f_kind').onchange=function(){
  var pp=this.value==='promptpay';
  document.getElementById('l_target').textContent=pp?'PromptPay ID — mobile, tax ID, or e-wallet':'Payment link (https)';
  document.getElementById('f_target').placeholder=pp?'0812345678':'https://pay.example.com/yourvenue';
};
function post(p,b){return fetch(p+'?k='+encodeURIComponent(K),{method:'POST',
  headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json()})}
function say(m){document.getElementById('out').textContent=m}
function createLink(){
  post('/api/venue/pay',{label:document.getElementById('f_label').value,
    kind:document.getElementById('f_kind').value,
    target:document.getElementById('f_target').value,
    amount:document.getElementById('f_amount').value||null})
  .then(function(r){ if(r.ok) location.reload(); else say('Could not create: '+(r.hint||r.error)) })
}
function bulk(){
  post('/api/venue/pay/bulk',{template:document.getElementById('f_tpl').value,
    kind:document.getElementById('f_kind').value,
    target:document.getElementById('f_target').value,
    amount:document.getElementById('f_amount').value||null})
  .then(function(r){ if(r.ok) location.reload(); else say('Could not create: '+(r.hint||r.error)) })
}
function setState(t,s){ post('/api/venue/pay/state',{token:t,state:s})
  .then(function(r){ if(r.ok) location.reload(); else say(r.error||'failed') }) }
</script>
</body></html>`);
}


/* ══════════════════════════════════════════════════════════════════════════
   VENUE SETTINGS — the three switches that were never writable.

   Everything about which switches exist, what they may be set to, and what a
   venue may not touch lives in growth/venuesettings.mjs. This file is the
   door: authenticate, ask that module what the submission means, and say so
   in a sentence.
   ══════════════════════════════════════════════════════════════════════════ */

/** Owner, or the console key acting as one. Anyone else gets a 403. */
async function settingsWho(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return { deny: J({ ok: false, error: "unauthorised" }, 401) };
  if (!QR.can(who.role, "settings")) return { deny: qrDeny("settings") };
  return { who };
}

/* ── GET /api/venue/settings ─────────────────────────────────────────────── */
async function venueSettingsGet(req, env, url) {
  const { who, deny } = await settingsWho(req, env, url);
  if (deny) return deny;
  const s = await readSettings(env, who.business.id);
  return J({
    ok: true,
    business: who.business.name,
    food_and_drink: foodAndDrink(who.business),
    settings: s,
    history: await settingHistory(env, who.business.id, 20),
  });
}

/* ── POST /api/venue/settings ────────────────────────────────────────────── */
async function venueSettingsSet(req, env, url) {
  const { who, deny } = await settingsWho(req, env, url);
  if (deny) return deny;

  let b;
  try { b = await readJSON(req, 2048); } catch (e) { return J({ ok: false }, 400); }

  const out = await writeSettings(env, {
    businessId: who.business.id,
    patch: b || {},
    by: who.via === "key" ? "key" : (who.name || who.userId || "staff"),
    via: who.via,
    ip: req.headers.get("cf-connecting-ip") || null,
    foodAndDrink: foodAndDrink(who.business),
  });
  return J(out, out.ok ? 200 : 400);
}

/* ── GET /biz/settings?k= ────────────────────────────────────────────────── */
async function venueSettingsPage(req, env, url) {
  const { who, deny } = await settingsWho(req, env, url);
  if (deny) {
    return HTML(payShell(`<h1>That link isn't valid</h1>
      <p class="lede">Settings are the owner's. If you manage this venue and
      need a link of your own, reply to any NUM email and we'll send one.</p>`,
      "NUM"), 401);
  }

  const k = encodeURIComponent(url.searchParams.get("k") || "");
  const s = await readSettings(env, who.business.id);
  const fnb = foodAndDrink(who.business);
  const log = await settingHistory(env, who.business.id, 12);

  const on = (v) => (v === 1 ? " checked" : "");
  const money = (cs) => "$" + ((cs || 0) / 100).toFixed(2);

  // A switch that would do nothing here is shown as a sentence, not as a
  // disabled control. A greyed-out toggle invites "how do I get that", and
  // the answer — you are not a restaurant — is better said than implied.
  const fnbOnly = (field, body) => (fnb ? body : "");

  return HTML(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Settings — ${esc(who.business.name)}</title>
<style>
:root{--paper:#faf8f4;--ink:#131a16;--pine:#1f3a34;--green:#1e7a4d;--line:#e0ddd4;--warn:#b4552d}
body{font:16px/1.6 -apple-system,'Segoe UI',Inter,sans-serif;background:var(--paper);color:var(--ink);
  margin:0;padding:22px 18px 60px;max-width:720px;margin-inline:auto}
h1{font-size:22px;margin:0 0 2px}
.sub{color:#4a5450;margin:0 0 18px;font-size:14px}
.nav{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 20px}
.nav a{font-size:14px;font-weight:600;text-decoration:none;padding:7px 14px;
  border-radius:10px;border:1.5px solid var(--pine);color:var(--pine)}
.nav .on{background:var(--pine);color:#fff}
.tile{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}
.row{display:flex;gap:12px;align-items:flex-start}
.row input[type=checkbox]{width:22px;height:22px;margin-top:3px;flex:0 0 auto;accent-color:var(--pine)}
.name{font-weight:700}
.why{color:#4a5450;font-size:14px;margin:3px 0 0}
label.amt{display:block;font-size:13px;font-weight:600;margin:12px 0 3px}
input[type=number]{width:140px;box-sizing:border-box;font:inherit;padding:9px;
  border:1px solid var(--line);border-radius:9px;background:#fff}
.btn{background:var(--pine);color:#fff;border:0;border-radius:10px;padding:12px 20px;
  font-size:15px;font-weight:700;cursor:pointer}
.locked{background:#f4f2ec;border:1px dashed var(--line)}
.locked dt{font-weight:700;font-size:14px;margin-top:8px}
.locked dd{margin:0;color:#4a5450;font-size:14px}
#out{font-size:14px;margin-top:12px;white-space:pre-wrap}
#out.bad{color:var(--warn)}#out.good{color:var(--green)}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:7px 6px;border-top:1px solid var(--line);vertical-align:top}
.mut{color:#7a827e}
</style></head><body>
<h1>Settings</h1>
<p class="sub">${esc(who.business.name)}${who.via === "key" ? "" : " · signed in as " + esc(who.name || "")}</p>
<div class="nav">
  <a href="/biz/codes?k=${k}">Codes</a>
  <a href="/biz/visitors?k=${k}">Visitors</a>
  <a href="/biz/offers?k=${k}">Offers</a>
  <a href="/biz/pay?k=${k}">Pay</a>
  <a class="on" href="/biz/settings?k=${k}">Settings</a>
</div>

<div class="tile">
  <div class="row">
    <input type="checkbox" id="f_bill_value"${on(s.f_bill_value)}>
    <div><div class="name">${esc(SET_FIELDS.f_bill_value.label)}</div>
      <p class="why">${esc(SET_FIELDS.f_bill_value.why)}</p></div>
  </div>
</div>

${fnbOnly("priority", `<div class="tile">
  <div class="row">
    <input type="checkbox" id="f_priority_seating"${on(s.f_priority_seating)}>
    <div><div class="name">${esc(SET_FIELDS.f_priority_seating.label)}</div>
      <p class="why">${esc(SET_FIELDS.f_priority_seating.why)}</p></div>
  </div>
  <label class="amt">Most a guest may be asked for — up to $20.00</label>
  <input type="number" id="priority_max_cs_dollars" min="0" max="20" step="0.5"
         value="${((s.priority_max_cs || 0) / 100).toFixed(2)}">
  <p class="why">You keep ${(s.priority_share_bps ?? 4000) / 100}% of it.</p>
</div>

<div class="tile">
  <div class="row">
    <input type="checkbox" id="f_tips"${on(s.f_tips)}>
    <div><div class="name">${esc(SET_FIELDS.f_tips.label)}</div>
      <p class="why">${esc(TIPS_UNDERTAKING)}</p>
      <p class="why">NUM takes nothing from a tip and never holds one — it moves
      on your rail, not ours.${s.tips_terms_at
        ? " You accepted this on " + esc(new Date(s.tips_terms_at * 1000).toISOString().slice(0, 10)) + "."
        : ""}</p></div>
  </div>
</div>`)}

${fnb ? "" : `<div class="tile"><p class="why">Priority seating and tipping are for
  places that seat people at tables — bars and restaurants. They are not shown
  here because they would not do anything.</p></div>`}

<button class="btn" onclick="save()">Save</button>
<div id="out"></div>

<div class="tile locked" style="margin-top:22px">
  <b>Your agreement with NUM</b>
  <p class="why" style="margin-top:2px">These are not settings. They are the terms
  you were quoted, and only NUM can move them — reply to any NUM email to talk
  about it.</p>
  <dl>
    <dt>Commission</dt><dd>${((s.commission_bp ?? 1000) / 100)}% of a reported bill</dd>
    <dt>Per confirmed table</dt><dd>${money(s.booking_fee_cs)} when the bill isn't reported</dd>
    <dt>Your share of a priority fee</dt><dd>${(s.priority_share_bps ?? 4000) / 100}%</dd>
  </dl>
</div>

${log.length ? `<div class="tile"><b>What has changed</b>
  <table><tbody>${log.map((r) => `<tr>
    <td>${esc(r.field)}</td><td>${esc(String(r.was ?? "—"))} → <b>${esc(String(r.now))}</b></td>
    <td class="mut">${esc(r.changed_by || "")}<br>${esc(String(r.created_at || "").slice(0, 16))}</td>
  </tr>`).join("")}</tbody></table></div>` : ""}

<script>
var K=${JSON.stringify(url.searchParams.get("k") || "")};
var FNB=${fnb ? "true" : "false"};
function el(id){return document.getElementById(id)}
function say(m,good){var o=el('out');o.textContent=m;o.className=good?'good':'bad'}
function save(){
  var body={f_bill_value:el('f_bill_value').checked?1:0};
  if(FNB){
    var d=parseFloat(el('priority_max_cs_dollars').value||'0');
    if(!isFinite(d)||d<0)d=0;
    body.priority_max_cs=Math.round(d*100);
    body.f_priority_seating=el('f_priority_seating').checked?1:0;
    body.f_tips=el('f_tips').checked?1:0;
    // The checkbox IS the acceptance: it sits directly under the undertaking,
    // so ticking it is the act of agreeing to it.
    if(body.f_tips===1)body.tips_terms=1;
  }
  fetch('/api/venue/settings?k='+encodeURIComponent(K),{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  .then(function(r){return r.json()}).then(function(r){
    if(!r.ok)return say(r.error||'Could not save',false);
    if(r.refused&&r.refused.length)
      return say(r.refused.map(function(x){return x.reason}).join('\\n\\n'),false);
    say(r.changed.length?'Saved. '+r.changed.length+' change'+(r.changed.length>1?'s':'')+'.':'Nothing to change.',true);
    if(r.changed.length)setTimeout(function(){location.reload()},900);
  }).catch(function(){say('Could not reach NUM. Try again.',false)});
}
</script>
</body></html>`);
}


/* ══════════════════════════════════════════════════════════════════════════
   AFTER THE VISIT — how was it, and would you like to leave something.

   Reached from the completing scan (venueArrive) at /a/<token>. The rules
   live in worker/aftertable.mjs and growth/aftervisit.mjs; this is the door
   and the page.

   Two things are load-bearing and neither is obvious from the markup:

     · NUM records a tip and does not carry one. The button that says "leave
       something" writes a row and then sends the guest to the VENUE'S OWN
       payment link. Money in transit for someone else is money transmission.
     · The tip prompt appears only where the venue switched tipping on and
       accepted the undertaking that it reaches the staff. A venue that has
       not is never mentioned to the guest as one that takes tips.
   ══════════════════════════════════════════════════════════════════════════ */

const AFTER_CHIPS_CS = Object.freeze([200, 500, 1000, 2000]);

/* ── GET /api/after/<token> ──────────────────────────────────────────────── */
async function afterStateRoute(req, env, token) {
  if (badOrigin(req)) return J({ ok: false }, 403);
  const st = await afterState(env, token);
  return J(st, st.ok ? 200 : 404);
}

/* ── POST /api/after/rate ────────────────────────────────────────────────── */
async function afterRateRoute(req, env) {
  if (badOrigin(req)) return J({ ok: false }, 403);
  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (overLimit("after:" + ip, 30)) return J({ ok: false, error: "slow_down" }, 429);

  let b;
  try { b = await readJSON(req, 4096); } catch (e) { return J({ ok: false }, 400); }

  const row = await resolveAfter(env, b.token);
  if (!row || row.expired) return J({ ok: false, error: row ? "expired" : "unknown" }, 404);

  const r = await afterRate(env, {
    bookingId: row.booking_id,
    businessId: row.business_id,
    placeId: row.place_id,
    memberRef: row.member_ref,
    stars: b.stars,
    // Not run through clean(): a guest's sentence about their evening is prose,
    // and clean() would strip the punctuation out of it. aftertable.rate()
    // caps the length, and nothing renders it as markup.
    comment: b.comment == null ? null : String(b.comment).slice(0, 2000),
    lang: clean(b.lang, 8) || null,
  });
  return r ? J({ ok: true, rated: r.stars }) : J({ ok: false, error: "nothing_said" }, 400);
}

/* ── POST /api/after/tip ─────────────────────────────────────────────────── */
async function afterTipRoute(req, env) {
  if (badOrigin(req)) return J({ ok: false }, 403);
  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (overLimit("after:" + ip, 30)) return J({ ok: false, error: "slow_down" }, 429);

  let b;
  try { b = await readJSON(req, 2048); } catch (e) { return J({ ok: false }, 400); }

  const row = await resolveAfter(env, b.token);
  if (!row || row.expired) return J({ ok: false, error: row ? "expired" : "unknown" }, 404);

  // The venue's switch, checked server-side. The page hides the prompt when
  // tipping is off, but a hidden control is a suggestion, not a rule.
  const st = await afterState(env, b.token);
  if (!st.ok || !st.tips) return J({ ok: false, error: "tips_not_offered" }, 409);

  const rail = st.rail || { rail: "venue", url: null };
  const t = await afterTip(env, {
    bookingId: row.booking_id,
    businessId: row.business_id,
    placeId: row.place_id,
    amountCs: b.amount_cs,
    forWhom: b.for_whom == null ? null : String(b.for_whom).slice(0, 120),
    rail: rail.rail,
    railRef: rail.token || null,
  });
  if (!t) return J({ ok: false, error: "bad_amount" }, 400);

  // NUM has recorded it. Where it is actually PAID is the venue's own link,
  // or the server's hand.
  return J({ ok: true, amount_cs: t.amount_cs, rail: t.rail, pay: rail.url || null });
}

/* ── GET /a/<token> — the page ───────────────────────────────────────────── */
async function afterPage(req, env, token) {
  const st = await afterState(env, token);

  if (!st.ok) {
    return HTML(payShell(st.error === "expired"
      ? `<h1>This link has expired</h1>
         <p class="lede">Feedback links last three days. If something needs
         saying, the venue would still like to hear it — and so would we, at
         <a href="mailto:info@itsnum.com">info@itsnum.com</a>.</p>
         <a class="btn ghost" href="https://itsnum.com/">Go to NUM</a>`
      : `<h1>We don't recognise this link</h1>
         <p class="lede">Nothing was charged and nothing was recorded. If it
         came from a table at a venue, tell staff — it did not come from us.</p>
         <a class="btn ghost" href="https://itsnum.com/">Go to NUM</a>`,
      "NUM"), st.error === "expired" ? 410 : 404);
  }

  const chips = AFTER_CHIPS_CS.map((cs) =>
    `<button type="button" class="chip" data-cs="${cs}">$${(cs / 100).toFixed(0)}</button>`).join("");

  const tipBlock = st.tips ? `
  <div class="sect" id="tipsect">
    <h2>Leave something for the server?</h2>
    <p class="lede small">It is theirs. NUM takes nothing from it and never
    holds it — ${st.rail.url
      ? "the next screen is " + esc(st.venue) + "'s own payment page."
      : "tell your server, or add it to the bill."}</p>
    <div class="chips">${chips}<button type="button" class="chip" data-cs="other">Other</button></div>
    <input id="tipamt" type="number" min="0" step="0.5" inputmode="decimal"
           placeholder="Amount" style="display:none">
    <input id="forwhom" maxlength="60" placeholder="Who served you? (optional)">
    <button class="btn" id="tipbtn">Leave it</button>
  </div>` : "";

  return HTML(payShell(`
  <div class="venue">${esc(st.venue)}</div>
  <h1>How was it?</h1>
  <p class="lede">Only NUM sees this until there are enough ratings to show an
  average, and a rating can never be bought.</p>

  <div class="stars" id="stars">
    ${[1, 2, 3, 4, 5].map((n) =>
      `<button type="button" class="star" data-n="${n}" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`).join("")}
  </div>
  <textarea id="comment" rows="3" placeholder="Anything you'd tell a friend? (optional)"></textarea>
  <button class="btn" id="ratebtn">Send</button>
  ${tipBlock}
  <div id="out" class="note"></div>
  <p class="foot">Powered by NUM · <a href="https://itsnum.com/">itsnum.com</a></p>

<style>
.stars{display:flex;gap:6px;margin:6px 0 14px}
.star{font-size:38px;line-height:1;background:none;border:0;padding:0 2px;cursor:pointer;
  color:#d8d3c8}
.star.on{color:#e0a83a}
textarea,input{width:100%;box-sizing:border-box;font:inherit;padding:11px;
  border:1px solid #e0ddd4;border-radius:10px;background:#fff;margin-bottom:10px}
.sect{margin-top:30px;border-top:1px solid #e0ddd4;padding-top:20px}
h2{font-size:18px;margin:0 0 4px}
.small{font-size:14px}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 10px}
.chip{font:600 16px/1 inherit;padding:12px 16px;border-radius:10px;
  border:1.5px solid #1f3a34;background:#fff;color:#1f3a34;cursor:pointer}
.chip.on{background:#1f3a34;color:#fff}
.done{color:#1e7a4d}
</style>
<script>
var T=${JSON.stringify(st.token)};
var stars=0, cs=0;
function el(i){return document.getElementById(i)}
function say(m,good){var o=el('out');o.textContent=m;o.className='note'+(good?' done':'')}
Array.prototype.forEach.call(document.querySelectorAll('.star'),function(b){
  b.onclick=function(){
    stars=+b.dataset.n;
    Array.prototype.forEach.call(document.querySelectorAll('.star'),function(x){
      x.className='star'+(+x.dataset.n<=stars?' on':'');
    });
  };
});
el('ratebtn').onclick=function(){
  var c=el('comment').value.trim();
  if(!stars&&!c)return say('Tap a star, or write a line — either is enough.',false);
  fetch('/api/after/rate',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({token:T,stars:stars||null,comment:c||null,
      lang:(navigator.language||'').slice(0,5)})})
   .then(function(r){return r.json()}).then(function(r){
     say(r.ok?'Thank you — that reached them.':'Could not send that. Try again.',r.ok);
   }).catch(function(){say('Could not reach NUM. Try again.',false)});
};
var tipbtn=el('tipbtn');
if(tipbtn){
  Array.prototype.forEach.call(document.querySelectorAll('.chip'),function(b){
    b.onclick=function(){
      Array.prototype.forEach.call(document.querySelectorAll('.chip'),function(x){x.className='chip'});
      b.className='chip on';
      if(b.dataset.cs==='other'){el('tipamt').style.display='block';el('tipamt').focus();cs=0}
      else{el('tipamt').style.display='none';cs=+b.dataset.cs}
    };
  });
  tipbtn.onclick=function(){
    var amt=cs||Math.round(parseFloat(el('tipamt').value||'0')*100);
    if(!(amt>0))return say('Pick an amount first.',false);
    fetch('/api/after/tip',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({token:T,amount_cs:amt,for_whom:el('forwhom').value||null})})
     .then(function(r){return r.json()}).then(function(r){
       if(!r.ok)return say('Could not record that. Try again.',false);
       if(r.pay){say('Recorded. Taking you to the payment page…',true);
                 setTimeout(function(){location.href=r.pay},700);}
       else say('Recorded. Hand it to your server or add it to the bill — it is theirs.',true);
     }).catch(function(){say('Could not reach NUM. Try again.',false)});
  };
}
</script>`, "How was it? — " + st.venue));
}

const _origScheduled = WORKER.scheduled;
WORKER.scheduled = async (event, env, ctx) => {
  await _origScheduled.call(WORKER, event, env, ctx);
  const min = new Date(event.scheduledTime || Date.now()).getUTCMinutes();
  const hr  = new Date(event.scheduledTime || Date.now()).getUTCHours();
  if (min < 15 && hr % 6 === 0) ctx.waitUntil(securitySweep(env));
};
export default WORKER;

/* ══════════════════════════════════════════════════════════════════════════
   QR SYSTEM — tables, the codes on them, who may issue them, and the agent.

   Two ways in, deliberately:

     • a STAFF SESSION, from an emailed magic link. Carries a person and a
       role, so every bill code says who made it. This is the normal path.
     • the venue's CONSOLE KEY (?k=), which already exists and already works.
       Kept as the owner's break-glass: it needs no email, no inbox and no
       session, which is what day one in Phuket actually looks like.

   The key path is treated as `owner` with no user id — actions taken that way
   are attributed to "key", not to a person, and the log says so.
   ══════════════════════════════════════════════════════════════════════════ */

const QR_COOKIE = "num_biz";

function qrCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

/**
 * Resolve who is asking. Returns null when nobody legitimate is.
 * `{ business, role, userId, via }` — userId is null on the key path.
 */
async function qrWho(req, env, url) {
  const sid = qrCookie(req, QR_COOKIE);
  if (sid) {
    const s = await QR.sessionUser(env, sid);
    if (s) {
      return {
        business: { id: s.business_id, name: s.business_name },
        role: s.role, userId: s.user_id, via: "session", name: s.name || s.email,
      };
    }
  }
  const biz = await bizAuth(env, url, req);
  if (biz) return { business: biz, role: "owner", userId: null, via: "key", name: "console key" };
  return null;
}

function qrDeny(action) {
  return J({ ok: false, error: "not_allowed", need: action }, 403);
}

/* ── sign in ─────────────────────────────────────────────────────────────── */

async function qrLoginStart(req, env) {
  if (badOrigin(req)) return J({ ok: false }, 403);
  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (overLimit("bizlogin:" + ip, 6)) return J({ ok: false, error: "slow_down" }, 429);

  let b;
  try { b = await readJSON(req, 2048); } catch (e) { return J({ ok: false }, 400); }

  const out = await QR.startLogin(env, b.email, { ip });
  // The reply is identical whether or not the address is real. Anything else
  // turns this endpoint into a directory of which venues are on NUM.
  if (!out.ok) return J({ ok: false, error: "bad_email" }, 400);
  if (!out.sent) return J({ ok: true, sent: true });

  const link = (env.SITE || "https://itsnum.com") + "/biz/login?t=" + out.token;
  const who = out.user;
  await sendBatch(env, [{
    from: env.MAIL_FROM || 'NUM <info@itsnum.com>',
    to: b.email,
    subject: "Sign in to " + (who.business_name || "your NUM console"),
    html:
      '<p style="font:16px/1.5 -apple-system,Helvetica,Arial,sans-serif">' +
      "Tap to sign in to <b>" + esc(who.business_name || "your venue") + "</b> on NUM.</p>" +
      '<p><a href="' + esc(link) + '" style="display:inline-block;background:#0f5c4a;color:#fff;' +
      'padding:13px 20px;border-radius:9px;font:600 16px -apple-system,Helvetica,Arial,sans-serif;' +
      'text-decoration:none">Open my console</a></p>' +
      '<p style="font:13px/1.5 -apple-system,Helvetica,Arial,sans-serif;color:#5b6673">' +
      "This link works once and expires in 20 minutes. If you did not ask for it, ignore it — " +
      "nothing happens until it is opened.</p>",
  }]).catch(() => {});

  return J({ ok: true, sent: true });
}

async function qrLoginRedeem(req, env, url) {
  const out = await QR.redeemLogin(env, url.searchParams.get("t") || "");
  if (!out.ok) {
    return new Response(
      qrShell("<h1>That link did not work</h1><p>" + esc(out.reason) +
        '</p><p><a href="/biz/tables">Ask for a new one</a></p>', "Sign in"),
      { status: 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
    );
  }
  // Host-only cookie, not readable by script, not sent cross-site.
  return new Response(null, {
    status: 302,
    headers: {
      location: "/biz/tables",
      "cache-control": "no-store",
      "set-cookie": QR_COOKIE + "=" + encodeURIComponent(out.sid) +
        "; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax",
    },
  });
}

async function qrLogout(req, env) {
  if (badOrigin(req)) return J({ ok: false }, 403);
  const sid = qrCookie(req, QR_COOKIE);
  if (sid) await QR.endSession(env, sid);
  return J({ ok: true }, 200, {
    "set-cookie": QR_COOKIE + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
  });
}

async function qrMe(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);
  return J({
    ok: true, business: who.business.name, business_id: who.business.id,
    role: who.role, via: who.via, name: who.name, can: QR.CAN[who.role] || [],
  });
}

/* ── tables ──────────────────────────────────────────────────────────────── */

async function qrTablesList(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);
  return J({ ok: true, business: who.business.name, role: who.role,
             tables: await QR.listTables(env, who.business.id) });
}

async function qrTablesCreate(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);
  if (!QR.can(who.role, "tables")) return qrDeny("tables");
  let b;
  try { b = await readJSON(req, 8192); } catch (e) { return J({ ok: false }, 400); }

  const made = await QR.createTables(env, who.business.id, b);
  if (!made.ok) return J(made, 400);
  // Give them their codes now rather than waiting for the next agent pass —
  // a manager who just defined a floor wants to print today.
  const codes = await QR.ensureTableCodes(env, who.business.id, { issuedBy: who.userId || "key" });
  await logKeyEvent(env, req, who.business.id, "ok", "tables_create:" + made.created.length);
  return J({ ok: true, ...made, codes });
}

async function qrTableState(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);
  if (!QR.can(who.role, "tables")) return qrDeny("tables");
  let b;
  try { b = await readJSON(req, 2048); } catch (e) { return J({ ok: false }, 400); }
  const out = await QR.setTableActive(env, who.business.id, String(b.id || ""), !!b.active);
  return J(out.ok ? { ok: true } : { ok: false, error: "unknown_table" }, out.ok ? 200 : 404);
}

async function qrIssueCodes(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);
  if (!QR.can(who.role, "stickers")) return qrDeny("stickers");
  const out = await QR.ensureTableCodes(env, who.business.id, { issuedBy: who.userId || "key" });
  return J({ ok: true, ...out });
}

/* ── bills ───────────────────────────────────────────────────────────────── */

async function qrBillCreate(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);
  if (!QR.can(who.role, "bill")) return qrDeny("bill");
  let b;
  try { b = await readJSON(req, 2048); } catch (e) { return J({ ok: false }, 400); }

  const out = await QR.billForTable(env, {
    businessId: who.business.id,
    resourceId: b.resource_id ? String(b.resource_id) : null,
    amount: b.amount,
    bookingId: b.booking_id ? String(b.booking_id).slice(0, 64) : null,
    issuedBy: who.userId || "key",
  });
  if (!out.ok) return J(out, 400);
  await logKeyEvent(env, req, who.business.id, "ok", "bill_create:" + out.token);
  return J(out);
}

async function qrBillSettle(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);
  if (!QR.can(who.role, "settle")) return qrDeny("settle");
  let b;
  try { b = await readJSON(req, 2048); } catch (e) { return J({ ok: false }, 400); }
  const out = await QR.settleBill(env, who.business.id, b.token, { settledBy: who.userId || "key" });
  return J(out, out.ok ? 200 : 404);
}

async function qrBillsOpen(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);
  return J({ ok: true, bills: await QR.openBills(env, who.business.id) });
}

/* ── staff ───────────────────────────────────────────────────────────────── */

async function qrStaffList(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);
  if (!QR.can(who.role, "staff")) return qrDeny("staff");
  return J({ ok: true, staff: await QR.listStaff(env, who.business.id) });
}

async function qrStaffAdd(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);
  if (!QR.can(who.role, "staff")) return qrDeny("staff");
  let b;
  try { b = await readJSON(req, 2048); } catch (e) { return J({ ok: false }, 400); }
  const out = await QR.addStaff(env, who.business.id, b);
  if (out.ok) await logKeyEvent(env, req, who.business.id, "ok", "staff_add:" + out.role);
  return J(out, out.ok ? 200 : 400);
}

async function qrStaffState(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);
  if (!QR.can(who.role, "staff")) return qrDeny("staff");
  let b;
  try { b = await readJSON(req, 2048); } catch (e) { return J({ ok: false }, 400); }
  // An owner locking themselves out by disabling their own row is a support
  // ticket we do not need. The console key remains as a way back in, but say no.
  if (who.userId && String(b.id) === who.userId && b.status === "disabled") {
    return J({ ok: false, error: "cannot_disable_yourself" }, 400);
  }
  const out = await QR.setStaffStatus(env, who.business.id, String(b.id || ""), String(b.status || ""));
  return J(out, out.ok ? 200 : 400);
}

/* ── the agent's own log ─────────────────────────────────────────────────── */

async function qrAgentLog(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);
  return J({ ok: true, runs: await QR.agentLog(env, { businessId: who.business.id, limit: 60 }) });
}

async function qrRunAgent(env) {
  const out = await QR.runAgent(env);
  console.log("qr agent", JSON.stringify(out));
  return out;
}

/* ── the console page ────────────────────────────────────────────────────── */

function qrShell(inner, title) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} — NUM</title><style>
:root{--ink:#12161c;--muted:#5b6673;--line:#e3e7ec;--bg:#fbfcfd;--accent:#0f5c4a;--accent-ink:#0b3f33}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:0 0 60px}
.wrap{max-width:760px;margin:0 auto;padding:0 18px}
header{display:flex;align-items:center;gap:10px;padding:22px 0 10px}
.brand{font-weight:700;font-size:19px;letter-spacing:-.02em}
.brand span{font-weight:400;color:var(--muted);font-size:14px;margin-left:6px}
.who{margin-left:auto;font-size:13px;color:var(--muted);text-align:right}
h1{font-size:24px;letter-spacing:-.02em;margin:14px 0 4px}
h2{font-size:12px;font-weight:800;letter-spacing:.15em;text-transform:uppercase;color:var(--accent);margin:26px 0 8px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 16px 18px;margin:0 0 14px}
.muted{color:var(--muted);font-size:14px}
label{display:block;font-weight:600;font-size:13px;margin:12px 0 5px}
input,select{width:100%;padding:11px 12px;font-size:16px;border:1px solid #c9d0d8;border-radius:9px;font-family:inherit;background:#fff}
.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1;min-width:120px}
button{margin-top:14px;padding:12px 16px;font:600 15px inherit;background:var(--accent);color:#fff;border:0;border-radius:9px;cursor:pointer;font-family:inherit}
button.ghost{background:#fff;color:var(--accent-ink);border:1px solid var(--line)}
button:disabled{opacity:.5;cursor:default}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);padding:8px 6px;border-bottom:1px solid var(--line)}
td{padding:9px 6px;border-bottom:1px solid #f0f2f4;vertical-align:middle}
td.r{text-align:right;white-space:nowrap}
a{color:var(--accent-ink)}
.qr{width:74px;height:74px;display:block}
.pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;background:#eef3f1;color:var(--accent-ink)}
.pill.off{background:#f4f0ee;color:#8c5a2f}
.out{font-size:13px;color:var(--muted);margin-top:10px;white-space:pre-wrap;word-break:break-word}
.big{font-size:26px;font-weight:800;letter-spacing:-.02em;color:var(--accent-ink)}
</style></head><body><div class="wrap">${inner}</div></body></html>`;
}

/**
 * One page for the whole floor: define tables, print their stickers, put an
 * amount on a table, close a bill, add staff, and read what the agent did.
 *
 * Everything is fetched by the page rather than rendered server-side, because
 * this screen sits open on a phone behind a bar all evening and re-rendering
 * the floor plan on every tap is the wrong shape for that.
 */
async function qrTablesPage(req, env, url) {
  const who = await qrWho(req, env, url);

  if (!who) {
    return new Response(qrShell(`
<header><div class="brand">NUM<span>by 5arz</span></div></header>
<h1>Sign in</h1>
<p class="muted">We email you a link. No password.</p>
<div class="card">
  <label for="e">Your email</label>
  <input id="e" type="email" inputmode="email" autocomplete="email" placeholder="you@yourplace.com">
  <button id="go">Email me a link</button>
  <div class="out" id="out"></div>
</div>
<script>
var b=document.getElementById('go');
b.onclick=function(){
  b.disabled=true;b.textContent='Sending…';
  fetch('/api/venue/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({email:document.getElementById('e').value.trim()})})
   .then(function(r){return r.json()})
   .then(function(j){
     document.getElementById('out').textContent = j.ok
       ? 'If that address is on a venue here, the link is on its way. It works once and lasts 20 minutes.'
       : 'That email address does not look right.';
     b.disabled=false;b.textContent='Email me a link';
   })
   .catch(function(){document.getElementById('out').textContent='Could not send. Try again.';
     b.disabled=false;b.textContent='Email me a link';});
};
</script>`, "Sign in"), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  const k = url.searchParams.get("k") || "";
  const isOwner = QR.can(who.role, "staff");
  const canTables = QR.can(who.role, "tables");

  return new Response(qrShell(`
<header>
  <div class="brand">NUM<span>by 5arz</span></div>
  <div class="who">${esc(who.business.name)}<br>${esc(who.name)} · ${esc(who.role)}</div>
</header>

<h1>Tables &amp; codes</h1>
<p class="muted">Each table carries one sticker to pay and one code to check in. Both are printed once and never change.</p>

<div id="idcard"></div>

<p class="muted"><a href="/biz/statement" id="stmt">What you owe NUM &rarr;</a></p>

<h2>Put an amount on a table</h2>
<div class="card">
  <div class="row">
    <div><label for="bt">Table</label><select id="bt"></select></div>
    <div><label for="ba">Amount</label><input id="ba" inputmode="decimal" placeholder="2400"></div>
  </div>
  <button id="bill">Make the paying QR</button>
  <div id="billout" class="out"></div>
</div>

<h2>Open bills</h2>
<div class="card"><table><thead><tr><th>Table</th><th>Amount</th><th>Code</th><th></th></tr></thead>
<tbody id="bills"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody></table></div>

${canTables ? `
<h2>Your floor</h2>
<div class="card">
  <div class="row">
    <div><label for="pfx">Name them</label><input id="pfx" value="Table"></div>
    <div><label for="from">From</label><input id="from" inputmode="numeric" value="1"></div>
    <div><label for="to">To</label><input id="to" inputmode="numeric" value="12"></div>
  </div>
  <button id="mk">Create tables and their codes</button>
  <div id="mkout" class="out"></div>
</div>` : ""}

<div class="card"><table><thead><tr><th>Table</th><th>Pay sticker</th><th>Check-in</th><th></th></tr></thead>
<tbody id="tables"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody></table></div>

${isOwner ? `
<h2>Staff</h2>
<div class="card">
  <div class="row">
    <div><label for="se">Email</label><input id="se" type="email" placeholder="waiter@yourplace.com"></div>
    <div><label for="sr">Can</label><select id="sr">
      <option value="staff">Put amounts on tables</option>
      <option value="manager">That, plus the floor plan</option>
      <option value="owner">Everything, including staff</option>
      <option value="readonly">Look only</option>
    </select></div>
  </div>
  <button id="sadd">Add them</button>
  <div id="sout" class="out"></div>
</div>
<div class="card"><table><thead><tr><th>Who</th><th>Can</th><th></th></tr></thead>
<tbody id="staff"></tbody></table></div>` : ""}

<h2>What the agent did</h2>
<div class="card"><table><thead><tr><th>When</th><th>Task</th><th>What</th></tr></thead>
<tbody id="agent"><tr><td colspan="3" class="muted">Loading…</td></tr></tbody></table></div>

<p class="muted" style="margin-top:22px">
  <button class="ghost" id="out-btn" style="margin:0">Sign out</button>
</p>

<script>
var K=${JSON.stringify(k)};
function q(p){return p+(K?(p.indexOf('?')<0?'?':'&')+'k='+encodeURIComponent(K):'')}
function get(p){return fetch(q(p),{credentials:'same-origin'}).then(function(r){return r.json()})}
function post(p,b){return fetch(q(p),{method:'POST',credentials:'same-origin',
  headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}).then(function(r){return r.json()})}
function el(t,txt){var e=document.createElement(t);if(txt!=null)e.textContent=txt;return e}
function td(txt,cls){var e=el('td',txt);if(cls)e.className=cls;return e}

function drawTables(rows){
  var tb=document.getElementById('tables');tb.textContent='';
  var sel=document.getElementById('bt');sel.textContent='';
  if(!rows.length){tb.appendChild(el('tr')).appendChild(td('No tables yet.','muted')).colSpan=4;return}
  rows.forEach(function(r){
    var tr=el('tr');
    var n=td('');n.appendChild(el('b',r.name));
    if(!r.active)n.appendChild(el('span',' off')).className='pill off';
    tr.appendChild(n);
    ['sticker','checkin'].forEach(function(kind){
      var c=el('td');
      if(r[kind]){
        var img=el('img');img.className='qr';img.loading='lazy';
        img.src=(kind==='sticker'?'/api/pay/qr/':'/api/venue/qr/')+encodeURIComponent(r[kind])+'.svg';
        img.alt=kind+' code for '+r.name;
        c.appendChild(img);
        c.appendChild(el('div',r[kind])).className='muted';
      } else { c.appendChild(el('span','—')).className='muted' }
      tr.appendChild(c);
    });
    tr.appendChild(td(r.open_bills?r.open_bills+' open':'','r muted'));
    tb.appendChild(tr);
    if(r.active){var o=el('option',r.name);o.value=r.id;sel.appendChild(o)}
  });
}

function drawBills(rows){
  var tb=document.getElementById('bills');tb.textContent='';
  if(!rows.length){var tr=el('tr');var c=td('Nothing open.','muted');c.colSpan=4;tr.appendChild(c);tb.appendChild(tr);return}
  rows.forEach(function(r){
    var tr=el('tr');
    tr.appendChild(td(r.table_name||r.label||'—'));
    tr.appendChild(td(r.amount+' '+r.currency));
    tr.appendChild(td(r.token));
    var c=el('td');c.className='r';
    var b=el('button','Paid');b.className='ghost';b.style.margin='0';
    b.onclick=function(){b.disabled=true;post('/api/venue/bill/settle',{token:r.token}).then(refresh)};
    c.appendChild(b);tr.appendChild(c);
    tb.appendChild(tr);
  });
}

function drawAgent(rows){
  var tb=document.getElementById('agent');tb.textContent='';
  if(!rows.length){var tr=el('tr');var c=td('Nothing yet — it runs every 15 minutes.','muted');c.colSpan=3;tr.appendChild(c);tb.appendChild(tr);return}
  rows.slice(0,25).forEach(function(r){
    var tr=el('tr');
    tr.appendChild(td(new Date(r.ran_at*1000).toLocaleString()));
    tr.appendChild(td(r.task+' · '+r.action));
    tr.appendChild(td((r.detail||'')+(r.ref?' ('+r.ref+')':'')));
    tb.appendChild(tr);
  });
}

function drawStaff(rows){
  var tb=document.getElementById('staff');if(!tb)return;tb.textContent='';
  rows.forEach(function(r){
    var tr=el('tr');
    tr.appendChild(td((r.name?r.name+' · ':'')+r.email));
    tr.appendChild(td(r.role+(r.status==='active'?'':' · disabled')));
    var c=el('td');c.className='r';
    var b=el('button',r.status==='active'?'Disable':'Enable');b.className='ghost';b.style.margin='0';
    b.onclick=function(){b.disabled=true;
      post('/api/venue/staff/state',{id:r.id,status:r.status==='active'?'disabled':'active'}).then(refresh)};
    c.appendChild(b);tr.appendChild(c);tb.appendChild(tr);
  });
}


function drawIdentity(j){
  var box=document.getElementById('idcard'); if(!box) return; box.textContent='';
  if(j.has_identity){
    var d=el('div');d.className='card';
    d.appendChild(el('h2','Where your money goes')).style.margin='0 0 6px';
    var t=el('div',(j.kind==='promptpay'?'PromptPay ':(j.kind==='crypto'?(j.asset_label||'Crypto')+' · ':''))+j.target);
    if(j.kind==='crypto')t.style.wordBreak='break-all';
    t.style.fontWeight='700';d.appendChild(t);
    d.appendChild(el('div','Paid bank to bank, straight into this account. NUM never holds it.')).className='muted';
    d.appendChild(el('div','This cannot be edited. To change bank account, retire the codes and set a new one — every sticker must be reprinted.')).className='muted';
    box.appendChild(d);
    return;
  }
  var c=el('div');c.className='card';
  c.appendChild(el('h1','Where should your money go?')).style.margin='0 0 4px';
  var lead='Add this once and every table can be printed.';
  if(j.tables_waiting) lead=j.tables_waiting+' table'+(j.tables_waiting===1?'':'s')+' are waiting on this. Nothing can be paid until it is set.';
  c.appendChild(el('p',lead)).className='muted';
  if(!j.can_set){ c.appendChild(el('p','Ask the owner to set this.')).className='muted'; box.appendChild(c); return }

  var lk=el('label','How do you want to be paid');lk.htmlFor='kind';c.appendChild(lk);
  var sel=el('select');sel.id='kind';
  [['promptpay','PromptPay — Thai bank'],['crypto','USDC on Base — crypto wallet']].forEach(function(o){
    var op=el('option',o[1]);op.value=o[0];sel.appendChild(op)});
  c.appendChild(sel);

  var l=el('label','Your PromptPay ID');l.htmlFor='pp';c.appendChild(l);
  var i=el('input');i.id='pp';i.inputMode='numeric';
  i.placeholder='Thai mobile, 13-digit tax ID, or 15-digit e-wallet';
  c.appendChild(i);
  sel.onchange=function(){
    var crypto = sel.value === 'crypto';
    l.textContent = crypto ? 'Your wallet address' : 'Your PromptPay ID';
    i.placeholder = crypto ? '0x…  — the address USDC should arrive at' :
      'Thai mobile, 13-digit tax ID, or 15-digit e-wallet';
    i.inputMode = crypto ? 'text' : 'numeric';
    i.value='';o.textContent='';
  };
  var b=el('button','Check it');c.appendChild(b);
  var o=el('div');o.className='out';o.id='idout';c.appendChild(o);
  box.appendChild(c);

  b.onclick=function(){
    o.textContent='';
    post('/api/venue/identity',{kind:sel.value,target:i.value.trim()}).then(function(r){
      if(!r.ok){o.textContent=r.hint||r.error||'That does not look right.';return}
      o.textContent='';
      var img=el('img');
      img.src=q('/api/venue/identity/preview.svg')+(K?'&':'?')+'kind='+encodeURIComponent(sel.value)+
              '&target='+encodeURIComponent(r.target);
      img.style.width='200px';img.style.height='200px';img.style.display='block';img.style.margin='8px 0';
      var warn=el('p',r.check);warn.style.fontWeight='700';
      o.appendChild(warn);o.appendChild(img);
      var yes=el('button','Yes — that is my account');
      var no=el('button','No, let me retype it');no.className='ghost';no.style.marginLeft='8px';
      o.appendChild(yes);o.appendChild(no);
      no.onclick=function(){o.textContent=''};
      yes.onclick=function(){
        yes.disabled=true;no.disabled=true;yes.textContent='Saving…';
        post('/api/venue/identity',{kind:sel.value,target:r.target,confirm:true}).then(function(f){
          if(!f.ok){o.textContent=f.reason||'Could not save that.';return}
          o.textContent='Saved. '+(f.codes&&f.codes.stickers.length||0)+' table sticker(s) printed.';
          refresh();
        });
      };
    });
  };
}

function refresh(){
  get('/api/venue/identity').then(function(j){if(j.ok)drawIdentity(j)});
  get('/api/venue/tables').then(function(j){if(j.ok)drawTables(j.tables||[])});
  get('/api/venue/bills').then(function(j){if(j.ok)drawBills(j.bills||[])});
  get('/api/venue/agent').then(function(j){if(j.ok)drawAgent(j.runs||[])});
  ${isOwner ? "get('/api/venue/staff').then(function(j){if(j.ok)drawStaff(j.staff||[])});" : ""}
}
refresh();
if(K)document.getElementById('stmt').href='/biz/statement?k='+encodeURIComponent(K);

document.getElementById('bill').onclick=function(){
  var o=document.getElementById('billout');o.textContent='';
  post('/api/venue/bill',{resource_id:document.getElementById('bt').value,
                          amount:document.getElementById('ba').value}).then(function(j){
    if(!j.ok){o.textContent=j.reason||j.error||'Could not make that code.';return}
    o.textContent='';
    var img=el('img');img.src='/api/pay/qr/'+encodeURIComponent(j.token)+'.svg';
    img.style.width='190px';img.style.height='190px';img.style.display='block';
    o.appendChild(el('div',j.amount+' '+j.currency)).className='big';
    o.appendChild(el('div', j.booking ? ('Booking '+j.booking.short_code+' · '+j.booking.party_size+' guests — NUM earns its 10% on this one') : 'No booking on this table — walk-in, nothing charged')).className='muted';
    o.appendChild(img);
    o.appendChild(el('div',j.url));
    document.getElementById('ba').value='';
    refresh();
  });
};

${canTables ? `
document.getElementById('mk').onclick=function(){
  var o=document.getElementById('mkout');o.textContent='Working…';
  post('/api/venue/tables',{prefix:document.getElementById('pfx').value,
                            from:document.getElementById('from').value,
                            to:document.getElementById('to').value}).then(function(j){
    if(!j.ok){o.textContent=j.reason||'Could not create those.';return}
    var blocked=(j.codes&&j.codes.blocked||[]).length;
    o.textContent='Added '+j.created.length+', already there '+j.skipped.length+
      (blocked?' — '+blocked+' have no pay sticker yet because this venue has no payment code to copy.':'');
    refresh();
  });
};` : ""}

${isOwner ? `
document.getElementById('sadd').onclick=function(){
  var o=document.getElementById('sout');o.textContent='';
  post('/api/venue/staff',{email:document.getElementById('se').value.trim(),
                           role:document.getElementById('sr').value}).then(function(j){
    o.textContent=j.ok?'Added. They sign in at /biz/tables with their email.':(j.reason||'Could not add them.');
    if(j.ok)document.getElementById('se').value='';
    refresh();
  });
};` : ""}

document.getElementById('out-btn').onclick=function(){
  post('/api/venue/logout').then(function(){location.href='/biz/tables'});
};
</script>`, "Tables & codes"), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/* ── the payment identity: where this venue's money goes ─────────────────── */

async function qrIdentityGet(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);
  const id = await QR.identityOf(env, who.business.id);
  return J({
    ok: true,
    has_identity: !!id,
    // The owner set this and has to be able to check it. Masking the very
    // thing they are verifying is how a wrong account number survives.
    kind: id?.kind || null,
    target: id?.target || null,
    promptpay_kind: id?.promptpay_kind || null,
    crypto_asset: id?.crypto_asset || null,
    asset_label: id?.crypto_asset ? CRYPTO.ASSETS[id.crypto_asset]?.label || null : null,
    currency: id?.currency || null,
    token: id?.token || null,
    tables_waiting: await QR.tablesWaiting(env, who.business.id),
    can_set: QR.can(who.role, "stickers"),
  });
}

/**
 * Two steps on purpose.
 *
 * Without `confirm`, this validates and hands back what the money would do —
 * nothing is written. The console shows the resulting PromptPay QR and asks
 * the owner to scan it with their own banking app and check the name their
 * bank displays. A mistyped digit is a valid PromptPay id belonging to a
 * stranger, and once it is on a printed sticker the venue's takings go to
 * that stranger until somebody notices.
 *
 * With `confirm: true`, it is written, and it cannot be edited afterwards.
 */
async function qrIdentitySet(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);
  if (!QR.can(who.role, "stickers")) return qrDeny("stickers");

  let b;
  try { b = await readJSON(req, 4096); } catch (e) { return J({ ok: false }, 400); }

  const kind = clean(b.kind, 12) || "promptpay";
  // A crypto target is an address plus one of our verified assets, so it
  // arrives as an object rather than a bare string.
  const raw = kind === "crypto" ? { address: b.target, asset: b.asset } : b.target;
  const vt = validPayTarget(kind, raw);
  if (!vt.ok) return J(vt, 400);

  const currency = PAY_CURRENCIES.includes(clean(b.currency, 3).toUpperCase())
    ? clean(b.currency, 3).toUpperCase() : "THB";

  if (!b.confirm) {
    const checks = {
      promptpay: "Scan this with your own banking app. It must show YOUR account name. If it shows anyone else, the number is wrong.",
      crypto: "Send yourself a small test amount first and confirm it arrives. Crypto payments cannot be reversed — there is nobody to call.",
      url: "Open this link yourself and check it is your own payment page.",
    };
    return J({
      ok: true, preview: true, kind, target: vt.target,
      promptpay_kind: vt.promptpay_kind || null,
      crypto_asset: vt.crypto_asset || null,
      asset_label: vt.crypto_asset ? CRYPTO.ASSETS[vt.crypto_asset].label : null,
      currency,
      check: checks[kind] || checks.url,
    });
  }

  const out = await QR.setIdentity(env, who.business.id, {
    kind, target: vt.target, promptpayKind: vt.promptpay_kind || null,
    cryptoAsset: vt.crypto_asset || null,
    currency, issuedBy: who.userId || "key",
  });
  if (!out.ok) return J(out, 409);
  await logKeyEvent(env, req, who.business.id, "ok", "identity_set:" + kind);
  return J(out);
}

async function qrIdentityRetire(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);
  // Retiring pulls every sticker in the venue. That is an owner's decision.
  if (!QR.can(who.role, "staff")) return qrDeny("staff");
  let b;
  try { b = await readJSON(req, 2048); } catch (e) { return J({ ok: false }, 400); }
  if (!b.confirm) return J({ ok: false, error: "confirm_required" }, 400);

  const out = await QR.retireIdentity(env, who.business.id, { by: who.userId || "key" });
  await logKeyEvent(env, req, who.business.id, "ok", "identity_retire:" + out.retired + "+" + out.cancelled_bills);
  return J(out);
}

/**
 * The PromptPay QR for a target that has NOT been saved yet, so an owner can
 * check it against their own bank before it is committed to a sticker.
 *
 * Authenticated, because an open EMV generator is a gift to anyone building a
 * convincing fake payment page. It renders only what the caller typed and
 * stores nothing.
 */
async function qrIdentityPreview(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return TEXT("unauthorised", 401);
  const kind = clean(url.searchParams.get("kind"), 12) || "promptpay";
  const target = url.searchParams.get("target") || "";

  // A wallet cannot read a PromptPay payload and a bank cannot read an
  // address, so the preview has to render whichever rail is being set up.
  if (kind === "crypto") {
    const addr = CRYPTO.addressQrText(target);
    if (!addr) return TEXT("bad address", 400);
    return new Response(qrSvg(addr), {
      headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const vt = validPayTarget("promptpay", target);
  if (!vt.ok) return TEXT("bad id", 400);
  const payload = promptPayPayload(vt.target, null);
  if (!payload) return TEXT("bad id", 400);
  return new Response(qr6m.svg(payload), {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" },
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   MONEY — what a venue owes, how it pays, and who gets paid afterwards.

   The guest's money never comes near this code. It went bank to bank at the
   table. What lives here is the 10% NUM invoices afterwards, and the host's
   share of what NUM actually collected.
   ══════════════════════════════════════════════════════════════════════════ */

function adminOk(env, url, req) {
  const key = url.searchParams.get("key") || req.headers.get("x-admin-key") || "";
  return !!env.ADMIN_KEY && sameSecret(env.ADMIN_KEY, key);
}

/** The QR a venue scans to pay NUM. Rendered only for a real, configured payee. */
async function payeeQrRoute(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return TEXT("unauthorised", 401);
  const p = MONEY.payee(env);
  if (!p.ok) return TEXT("no payee configured", 503);
  const want = clean(url.searchParams.get("m"), 12) || p.methods[0].kind;
  const m = p.methods.find((x) => x.kind === want) || p.methods[0];
  const amt = url.searchParams.get("amount") || null;

  if (m.kind === "crypto") {
    // The invoice is in the venue's currency; NUM is paid the same figure in
    // the stablecoin, quoted here at the configured rate.
    const ccy = clean(url.searchParams.get("currency"), 3).toUpperCase() || "THB";
    const minor = Math.round(Number(amt) * 100);
    const qte = Number.isFinite(minor) && minor > 0
      ? CRYPTO.quote(env, m.asset_key, minor, ccy) : { ok: false };
    const text = qte.ok
      ? CRYPTO.paymentUri(m.asset_key, m.address, BigInt(qte.base_units))
      : CRYPTO.addressQrText(m.address);
    if (!text) return TEXT("bad payee", 500);
    return new Response(qrSvg(text), {
      headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const payload = promptPayPayload(m.promptpay, amt);
  if (!payload) return TEXT("bad payee", 500);
  return new Response(qr6m.svg(payload), {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" },
  });
}

async function venueStatement(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);

  const [open, invoices] = await Promise.all([
    MONEY.owed(env, who.business.id),
    MONEY.invoicesFor(env, who.business.id),
  ]);
  const p = MONEY.payee(env);
  return J({
    ok: true,
    business: who.business.name,
    // Not yet invoiced — this week so far.
    running: { total_cs: open.total_cs, currency: open.currency, lines: open.billable.length,
               awaiting: open.awaiting },
    invoices,
    pay_to: p.ok ? { name: p.name, promptpay: p.promptpay, methods: p.methods } : null,
    pay_to_error: p.ok ? null : p.reason,
  });
}

async function venueInvoiceLines(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);
  const id = clean(url.searchParams.get("id"), 40);
  // Scope the lookup to the venue: an invoice id is guessable enough that
  // "SELECT by id" alone would hand one venue another's takings.
  const inv = await env.DB.prepare(
    "SELECT id, amount_cs, currency, state, period_start, period_end, due_at, paid_at" +
    " FROM num_invoices WHERE id = ?1 AND business_id = ?2"
  ).bind(id, who.business.id).first();
  if (!inv) return J({ ok: false, error: "unknown_invoice" }, 404);
  return J({ ok: true, invoice: inv, lines: await MONEY.invoiceLines(env, inv.id) });
}

/* ── admin: cut the invoices, record the money, pay the hosts ────────────── */

async function adminMoney(req, env, url) {
  if (!adminOk(env, url, req)) return J({ ok: false, error: "unauthorised" }, 401);
  const action = clean(url.searchParams.get("do"), 24);

  if (req.method === "GET" && (!action || action === "open")) {
    const { results } = await env.DB.prepare(
      `SELECT i.id, i.business_id, b.name AS business, i.period_start, i.period_end,
              i.currency, i.amount_cs, i.line_count, i.state, i.issued_at, i.due_at
         FROM num_invoices i LEFT JOIN businesses b ON b.id = i.business_id
        WHERE i.state = 'open' ORDER BY i.issued_at LIMIT 200`
    ).all();
    return J({ ok: true, open: results || [] });
  }

  let b = {};
  if (req.method === "POST") { try { b = await readJSON(req, 4096); } catch (e) { b = {}; } }

  if (action === "run") return J(await MONEY.invoiceAll(env));

  if (action === "pay") {
    const out = await MONEY.payInvoice(env, clean(b.id, 40), {
      ref: clean(b.ref, 80) || null,
      amountCs: Number.isFinite(Number(b.amount_cs)) ? Number(b.amount_cs) : null,
    });
    return J(out, out.ok ? 200 : 400);
  }

  if (action === "payouts") {
    return J(await MONEY.buildPayoutRun(env, {
      currency: clean(b.currency, 3).toUpperCase() || null,
      minMinor: Math.max(0, Math.round(Number(b.min_minor) || 0)),
    }));
  }

  if (action === "payouts_sent") {
    const out = await MONEY.markPayoutSent(env, clean(b.id, 40), { ref: clean(b.ref, 80) || null });
    return J(out, out.ok ? 200 : 400);
  }

  return J({ ok: false, error: "unknown_action",
             actions: ["open", "run", "pay", "payouts", "payouts_sent"] }, 400);
}

/* ── the venue's statement page ──────────────────────────────────────────── */

async function venueStatementPage(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) {
    return new Response(qrShell(
      '<h1>Sign in</h1><p><a href="/biz/tables">Open your console</a></p>', "Statement"),
      { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  const k = url.searchParams.get("k") || "";
  return new Response(qrShell(`
<header>
  <div class="brand">NUM<span>by 5arz</span></div>
  <div class="who">${esc(who.business.name)}<br>${esc(who.name)} · ${esc(who.role)}</div>
</header>
<h1>What you owe NUM</h1>
<p class="muted">10% of bills from guests NUM sent you. Your own customers, walk-ins and
no-shows are never on this page. The food money already went straight to your account.</p>

<div class="card" id="running"><span class="muted">Loading…</span></div>

<h2>Invoices</h2>
<div class="card"><table><thead><tr><th>Week</th><th>Amount</th><th>State</th><th></th></tr></thead>
<tbody id="inv"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody></table></div>
<div id="detail"></div>
<p class="muted"><a href="/biz/tables${k ? "?k=" + encodeURIComponent(k) : ""}">&larr; Back to tables</a></p>

<script>
var K=${JSON.stringify(k)};
function q(p){return p+(K?(p.indexOf('?')<0?'?':'&')+'k='+encodeURIComponent(K):'')}
function get(p){return fetch(q(p),{credentials:'same-origin'}).then(function(r){return r.json()})}
function el(t,x){var e=document.createElement(t);if(x!=null)e.textContent=x;return e}
function td(x,c){var e=el('td',x);if(c)e.className=c;return e}
function m(cs,cur){return (cs/100).toFixed(2)+' '+(cur||'THB')}

var PAY=null;
get('/api/venue/statement').then(function(j){
  if(!j.ok) return;
  PAY=j.pay_to;
  var r=document.getElementById('running');r.textContent='';
  r.appendChild(el('div','This week so far')).className='muted';
  r.appendChild(el('div',m(j.running.total_cs,j.running.currency))).className='big';
  if(j.running.awaiting)
    r.appendChild(el('div',j.running.awaiting+' booking(s) we have no bill amount for — not counted.')).className='muted';
  r.appendChild(el('div','Invoiced every Monday for the week just finished.')).className='muted';
  if(j.pay_to_error) r.appendChild(el('div',j.pay_to_error)).className='muted';

  var tb=document.getElementById('inv');tb.textContent='';
  if(!j.invoices.length){var tr=el('tr');var c=td('Nothing invoiced yet.','muted');c.colSpan=4;tr.appendChild(c);tb.appendChild(tr);return}
  j.invoices.forEach(function(v){
    var tr=el('tr');
    tr.appendChild(td(v.period_start.slice(0,10)+' → '+v.period_end.slice(0,10)));
    tr.appendChild(td(m(v.amount_cs,v.currency)));
    tr.appendChild(td(v.state==='paid'?'Paid':(v.state==='void'?'Cancelled':'Due')));
    var c=el('td');c.className='r';
    var b=el('button',v.state==='open'?'Pay':'View');b.className='ghost';b.style.margin='0';
    b.onclick=function(){show(v)};
    c.appendChild(b);tr.appendChild(c);tb.appendChild(tr);
  });
});

function show(v){
  var d=document.getElementById('detail');d.textContent='';
  var card=el('div');card.className='card';
  card.appendChild(el('h2','Invoice '+v.id)).style.margin='0 0 8px';
  card.appendChild(el('div',m(v.amount_cs,v.currency))).className='big';
  if(v.state==='open'&&PAY){
    card.appendChild(el('p','Scan to pay NUM · '+PAY.name)).className='muted';
    (PAY.methods||[]).forEach(function(mth){
      var img=el('img');
      img.src=q('/api/venue/payee.svg')+(K?'&':'?')+'m='+mth.kind+
              '&currency='+encodeURIComponent(v.currency||'THB')+
              '&amount='+encodeURIComponent((v.amount_cs/100).toFixed(2));
      img.style.width='190px';img.style.height='190px';img.style.display='block';img.style.marginTop='8px';
      card.appendChild(img);
      var lbl=el('div', mth.kind==='promptpay' ? ('PromptPay '+mth.promptpay)
                                               : (mth.label+' — '+mth.address));
      lbl.className='muted';lbl.style.wordBreak='break-all';card.appendChild(lbl);
    });
  } else if(v.state==='open'){
    card.appendChild(el('p','Payment details are not set up yet — we will send them.')).className='muted';
  }
  var tbl=el('table');var tb=el('tbody');
  tbl.appendChild(tb);card.appendChild(tbl);
  d.appendChild(card);
  get('/api/venue/invoice?id='+encodeURIComponent(v.id)).then(function(j){
    if(!j.ok)return;
    j.lines.forEach(function(l){
      var tr=el('tr');
      tr.appendChild(td((l.created_at||'').slice(0,10)));
      tr.appendChild(td('Bill '+((l.basis_cs||0)/100).toFixed(2)));
      tr.appendChild(td(m(l.amount_cs,l.currency),'r'));
      tb.appendChild(tr);
    });
  });
  d.scrollIntoView({behavior:'smooth',block:'start'});
}
</script>`, "Statement"), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   CHAIN WATCHER + QR INTEGRITY

   The watcher reads and never signs. There is no key in this worker and no
   transaction is ever sent from it; the worst a hostile RPC endpoint can do
   is claim a payment arrived, and every such claim is stored with its
   transaction hash so a human can check it on a block explorer.
   ══════════════════════════════════════════════════════════════════════════ */

async function chainSweep(env) {
  if (!env.NUM_RPC_BASE) return { ok: false, reason: "no RPC endpoint configured" };
  // The settle function is passed in rather than imported by rpc.mjs, so the
  // watcher can never reach into the money path on its own.
  return RPC.sweep(env, (e, businessId, token, opts) => QR.settleBill(e, businessId, token, opts));
}

/** GET /api/venue/chain — is the watcher on, and what has it seen for me? */
async function venueChain(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);

  const status = await RPC.watcherStatus(env);
  const { results } = await env.DB.prepare(
    `SELECT s.tx_hash, s.block_number, s.value_base, s.outcome, s.detail, s.created_at,
            s.token_matched
       FROM num_chain_sightings s
       JOIN num_paylinks p ON p.token = s.token_matched
      WHERE p.business_id = ?1
      ORDER BY s.id DESC LIMIT 50`
  ).bind(who.business.id).all().catch(() => ({ results: [] }));

  return J({ ok: true, watcher: status, sightings: results || [] });
}

/** GET /api/venue/qrcheck — every code this venue has, and what is wrong. */
async function venueQrCheck(req, env, url) {
  const who = await qrWho(req, env, url);
  if (!who) return J({ ok: false, error: "unauthorised" }, 401);
  return J(await QRCHECK.checkQrs(env, { businessId: who.business.id }));
}

/** Operator-wide versions. */
async function adminChain(req, env, url) {
  if (!adminOk(env, url, req)) return J({ ok: false, error: "unauthorised" }, 401);
  const action = clean(url.searchParams.get("do"), 24);
  if (action === "sweep") return J(await chainSweep(env));
  if (action === "qrcheck") return J(await QRCHECK.checkQrs(env));
  return J({ ok: true, watcher: await RPC.watcherStatus(env) });
}
