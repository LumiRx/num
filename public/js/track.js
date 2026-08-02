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
 */
(function () {
  var PIXEL_ID = ''; // ← Meta Pixel ID goes here; empty keeps everything off

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
