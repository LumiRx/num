/* Visitor capture + retargeting for itsnum.com — built 2026-08-01 when NL
 * traffic surfaced and we discovered the landing pages carried no analytics
 * at all.
 *
 * Two layers, deliberately different:
 *
 * 1. Cloudflare Web Analytics — cookieless, no personal data, no consent
 *    needed anywhere including the EU. NOT loaded here: enable it in the
 *    Cloudflare dashboard (Analytics → Web Analytics → add itsnum.com) and
 *    it auto-injects on every page. That's the traffic-truth layer.
 *
 * 2. Meta Pixel — this file. Powers retargeting + IG ads via Custom
 *    Audiences, which IS tracking, so in the EU (our current traffic is
 *    Dutch) it may only fire AFTER consent. The banner below asks once,
 *    remembers the answer either way, and never nags. No consent → no
 *    pixel → the visitor is still counted by layer 1.
 *
 * To activate: paste the Pixel ID from Meta Events Manager
 * (business.facebook.com/events_manager2) into PIXEL_ID below. Empty string
 * keeps the whole file inert, banner and all.
 *
 * ── WHAT META NEEDS FROM US, AND WHY PageView IS NOT IT ──────────────────
 * Meta's delivery is only as good as the conversion you report. With nothing
 * but PageView it optimises for people who LOAD A PAGE, which is the cheapest
 * and least valuable human on the internet to buy — and it can build no
 * lookalike worth having. So this file also exposes `window.numMetaEvent`,
 * and the homepage calls it at the two moments that actually mean something:
 *
 *   Lead              the visitor sent Num their FIRST message. This is the
 *                     event to optimise the campaign for. It is the moment a
 *                     stranger became a user, and on 1 Sep 2026 it had never
 *                     happened once in the product's history.
 *   ViewContent       Num answered twice — they are in a conversation, not a
 *                     bounce. Good for a warm retargeting audience.
 *   CompleteRegistration  they added Num to their home screen.
 *
 * Standard event names on purpose: Meta optimises and reports far better
 * against its own vocabulary than against custom events, and `Lead` is the
 * one every campaign objective knows how to bid for.
 *
 * Consent still gates everything. No consent → no pixel → no events, and the
 * page keeps working exactly as it does now.
 */
(function () {
  // The pixel is now loaded by the base code in each page's <head>, the way
  // Meta's installer requires — Meta's own detector only looks there, and it
  // will not verify a pixel that loads later from a script file.
  //
  // So this stays EMPTY on purpose. It does not mean the pixel is off. It
  // means this file must not init a SECOND one: a double fbq('init') double
  // counts every PageView, and the consent bar below would be a control that
  // no longer controls anything, which is worse than no bar at all.
  //
  // What this file still does, and why it must stay loaded: numMetaEvent()
  // above sees the head pixel on window.fbq and reports Lead, ViewContent and
  // CompleteRegistration through it. Those are the events a campaign actually
  // bids for. PageView alone optimises for people who load a page.
  //
  // To go back to consent-gated loading: put the ID here AND remove the base
  // code from the page heads. Never both.
  var PIXEL_ID = ''; // pixel 1091773503496521 loads from <head> — see above

  /* Queue events even before (or without) a pixel, so a page can call
   * numMetaEvent() unconditionally and never has to know whether the visitor
   * consented. A page that has to ask "is the pixel on?" before every call is
   * a page where somebody eventually forgets to ask. */
  var queue = [];
  window.numMetaEvent = function (name, params) {
    if (window.fbq) { try { window.fbq('track', name, params || {}); } catch (e) {} return; }
    if (queue.length < 20) queue.push([name, params || {}]);
  };
  function flush() {
    while (queue.length) {
      var e = queue.shift();
      try { window.fbq('track', e[0], e[1]); } catch (err) {}
    }
  }

  if (!PIXEL_ID) return;
  var KEY = 'num_ads_consent'; // 'yes' | 'no'

  function loadPixel() {
    if (window.fbq) return;
    !(function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', PIXEL_ID);
    window.fbq('track', 'PageView');
    // Anything the page reported before consent landed. Without this, the
    // visitor who asks Num a question and THEN accepts the banner is the one
    // conversion Meta never hears about — and they are the best one.
    flush();
  }

  var choice = null;
  try { choice = localStorage.getItem(KEY); } catch (e) {}
  if (choice === 'yes') return loadPixel();
  if (choice === 'no') return;

  // First visit: one small bar, plain words, equal buttons. A consent UI that
  // shames the No button poisons the brand of a company selling trust.
  var bar = document.createElement('div');
  bar.setAttribute('role', 'dialog');
  bar.setAttribute('aria-label', 'Cookie consent');
  bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;background:#201e1d;color:#fff;' +
    'font:14px/1.5 -apple-system,system-ui,sans-serif;padding:14px 16px;display:flex;gap:12px;' +
    'align-items:center;flex-wrap:wrap;justify-content:center;text-align:center';
  bar.innerHTML =
    '<span>We’d like to use a Meta cookie to show you relevant ads later. ' +
    '<a href="/privacy/" style="color:#ffb3a3">Privacy policy</a></span>' +
    '<span style="display:flex;gap:8px">' +
    '<button id="num-c-no" style="cursor:pointer;border:1px solid #666;background:none;color:#fff;border-radius:999px;padding:8px 18px;font-weight:600">No thanks</button>' +
    '<button id="num-c-yes" style="cursor:pointer;border:0;background:#ec3013;color:#fff;border-radius:999px;padding:8px 18px;font-weight:700">Allow</button>' +
    '</span>';
  function done(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
    bar.remove();
    if (v === 'yes') loadPixel();
  }
  bar.addEventListener('click', function (e) {
    if (e.target.id === 'num-c-yes') done('yes');
    if (e.target.id === 'num-c-no') done('no');
  });
  if (document.body) document.body.appendChild(bar);
  else document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(bar); });
})();
