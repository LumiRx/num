/* reddit.js — the Reddit conversion layer for itsnum.com.  Built 3 Sep 2026.
 *
 * Reddit is 87% of every visitor NUM has ever had (2,457 + 577 of 3,479 in the
 * five weeks to 3 Sep). Until now it could see none of what those people did:
 * the campaign optimised against clicks, which is the cheapest and least
 * valuable human on the internet to buy.
 *
 * ── WHY THIS FILE DOES NOT INIT THE PIXEL ────────────────────────────────
 *
 * The base code sits in each page's <head>, verbatim, the way Reddit's
 * installer requires — their verifier only looks there and will not confirm a
 * pixel that loads later from a script file. So this file must NEVER call
 * rdt('init'): a second init double-counts every PageVisit, and a doubled
 * conversion count is worse than none, because you act on it.
 *
 * We learned that on the Meta side (see js/track.js, which is empty for the
 * same reason and says so). Same shape here, on purpose.
 *
 * ── WHAT IT DOES DO ───────────────────────────────────────────────────────
 *
 * PageVisit alone tells Reddit to find more people who load a page. The events
 * below tell it to find more people who USE Num, which is a different and much
 * smaller audience — and the only one worth bidding for:
 *
 *   Lead        the visitor sent Num their FIRST message. On 3 Sep 2026 this
 *               had happened exactly ONCE in the product's history, from 3,479
 *               visitors. It is the event the campaign should optimise for and
 *               the number every other number here is downstream of.
 *   ViewContent Num answered twice — a conversation, not a bounce. The warm
 *               retargeting audience.
 *   SignUp      they added Num to their home screen.
 *
 * Reddit's own vocabulary on purpose: its optimiser and its reporting both
 * work better against standard events than against custom ones.
 *
 * ── HOW THE PAGE REPORTS THEM ─────────────────────────────────────────────
 *
 * It doesn't have to know this file exists. The page already calls
 * numMetaEvent() at exactly the three moments that matter, so rather than add
 * a second call beside every one of them — three call sites today, and one of
 * them forgotten the day a fourth is added — this file wraps that function and
 * fans the same moment out to both networks. One moment, one call, two
 * reports, and a page that keeps working if either network is blocked.
 *
 * ── CONVERSION IDS ────────────────────────────────────────────────────────
 *
 * Every event carries a conversionId, and the SAME id goes to Meta as
 * eventID. Neither network needs it while the browser pixel is the only
 * sender — it matters the moment the Conversions API starts sending the same
 * conversion server-side, which is the next step in Reddit's own setup flow.
 * Adding it now costs one line; adding it later means a window of
 * double-counted conversions that nobody can retroactively de-duplicate.
 */
(function () {
  'use strict';

  // Present for reference and for the parity test in worker/pixels.test.mjs.
  // NOT used to init anything here — see the note above.
  var PIXEL_ID = 'a2_jgfeykixrdo7';

  // Meta's vocabulary → Reddit's. Anything unmapped goes as a Custom event
  // rather than being dropped: a moment we forgot to map is still a moment.
  var MAP = {
    Lead: 'Lead',
    ViewContent: 'ViewContent',
    CompleteRegistration: 'SignUp',
    Search: 'Search',
    Purchase: 'Purchase',
    AddToCart: 'AddToCart',
  };

  function newId() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* fall through */ }
    return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // Queue anything reported before rdt has finished loading. The visitor who
  // asks Num a question two seconds after arriving is the best conversion the
  // campaign will see all day, and it is also the one most likely to happen
  // before an async script from a third-party CDN has landed.
  var queue = [];
  function send(name, params) {
    var ev = MAP[name] || 'Custom';
    var payload = {};
    for (var k in params) if (params.hasOwnProperty(k)) payload[k] = params[k];
    if (ev === 'Custom') payload.customEventName = name;
    try {
      if (typeof window.rdt === 'function') { window.rdt('track', ev, payload); return; }
    } catch (e) { /* a blocked pixel must never break the page */ }
    if (queue.length < 20) queue.push([ev, payload]);
  }
  function flush() {
    if (typeof window.rdt !== 'function') return;
    while (queue.length) {
      var e = queue.shift();
      try { window.rdt('track', e[0], e[1]); } catch (err) { /* ignore */ }
    }
  }
  // rdt() itself queues once its stub is defined, so this only covers the gap
  // before the stub exists at all (a blocked or slow <head>).
  var tries = 0;
  var poll = setInterval(function () {
    if (typeof window.rdt === 'function') { flush(); clearInterval(poll); }
    else if (++tries > 40) clearInterval(poll);   // ~10s, then give up quietly
  }, 250);

  window.numRedditEvent = function (name, params) { send(name, params || {}); };

  // ── the bridge ───────────────────────────────────────────────────────────
  //
  // Defined as an accessor rather than a plain assignment so LOAD ORDER cannot
  // break it. js/track.js also assigns window.numMetaEvent; whichever of the
  // two files runs second would otherwise silently win, and the loser's
  // network would report nothing at all — the exact class of failure that is
  // invisible until you look at a month of empty conversion data.
  //
  // With a setter, track.js's assignment lands in `inner` and the wrapper
  // stays the thing the page calls, whichever order they load in.
  var inner = typeof window.numMetaEvent === 'function' ? window.numMetaEvent : null;
  var pending = [];

  function wrapper(name, params) {
    var p = params || {};
    var cid = p.conversionId || p.eventID || newId();

    // Meta first: it is the older integration and the page's existing
    // behaviour. If Meta's function is not defined yet, hold the moment rather
    // than dropping it — before this file existed, a call made before
    // track.js loaded was simply lost.
    var meta = {};
    for (var k in p) if (p.hasOwnProperty(k)) meta[k] = p[k];
    meta.eventID = cid;
    if (inner) { try { inner(name, meta); } catch (e) { /* ignore */ } }
    else if (pending.length < 20) pending.push([name, meta]);

    var red = {};
    for (var k2 in p) if (p.hasOwnProperty(k2)) red[k2] = p[k2];
    red.conversionId = cid;
    send(name, red);
  }

  try {
    Object.defineProperty(window, 'numMetaEvent', {
      configurable: true,
      get: function () { return wrapper; },
      set: function (fn) {
        inner = typeof fn === 'function' ? fn : null;
        if (!inner) return;
        while (pending.length) {
          var e = pending.shift();
          try { inner(e[0], e[1]); } catch (err) { /* ignore */ }
        }
      },
    });
  } catch (e) {
    // Very old browser, or something else already sealed the property. Fall
    // back to a plain wrap: Reddit still reports, Meta still reports, only the
    // load-order guarantee is lost.
    var prev = window.numMetaEvent;
    window.numMetaEvent = function (n, p) {
      if (typeof prev === 'function') { try { prev(n, p); } catch (err) {} }
      send(n, p || {});
    };
  }

  window.numPixelId = PIXEL_ID;
})();
