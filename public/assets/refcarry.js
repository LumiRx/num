/**
 * Carry a referral code across the domain boundary.
 *
 * ── THE BREAK THIS FIXES ─────────────────────────────────────────────────
 *
 * Measured on production, 19 Sep 2026: **21 referral arrivals logged at
 * /r/CODE, and 0 members with a referrer.** Not a low number — none, still,
 * after the 13 Sep fix that made signup send the code. That fix was real and
 * it was downstream of this one.
 *
 * The chain was:
 *
 *   /r/CODE            → itsnum.com/?ref=CODE        (this site)
 *   "Get NUM"          → app.itsnum.com              (the app, no code)
 *   signup             → ref: null                   (localStorage was empty)
 *   linkReferral       → never called
 *
 * The code that stores a referral lives in the APP (src/lib/social.ts), and
 * the app is on a different origin. localStorage is per-origin, so the code
 * written on itsnum.com is invisible at app.itsnum.com — the attribution was
 * dying at the domain boundary, in silence, on every single link.
 *
 * 64 pages on this site link to the app. None of them forwarded the code, and
 * fixing them by hand would mean 64 places to forget next time. This runs on
 * every page instead.
 *
 * ── WHAT IT DOES ─────────────────────────────────────────────────────────
 *
 *   1. Remembers a ?ref= seen anywhere on this site, so the code survives
 *      someone reading three pages before they tap install.
 *   2. Puts it on every outbound app link, so it crosses the boundary in the
 *      URL — the one channel that works between two origins.
 *
 * FIRST TOUCH ON THIS SIDE, LAST TOUCH DECIDED BY THE APP. This deliberately
 * does NOT overwrite a stored code with a different one: the app already owns
 * that rule and has a documented reason for it, and two files racing to decide
 * who gets paid is how somebody gets paid twice or not at all. Here the job is
 * only to not LOSE the code.
 *
 * Failing quietly is correct. Private mode throws on localStorage, and a
 * referral that cannot be carried must never break a page that was loading
 * fine — the person still gets to the app, they just arrive unattributed,
 * which is exactly what happened before this file existed.
 */
(function () {
  'use strict';
  var KEY = 'num-ref';

  function read() {
    try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  }

  var code = '';
  try {
    code = (new URLSearchParams(location.search).get('ref') || '').slice(0, 40);
  } catch (e) { code = ''; }

  if (code) {
    try { if (localStorage.getItem(KEY) !== code) localStorage.setItem(KEY, code); }
    catch (e) { /* private mode — carrying it in this page's links still works */ }
  } else {
    code = read();
  }
  if (!code) return;

  /* Rewritten at DOMContentLoaded rather than on click, because a long-press
     "copy link" or a middle-click never fires a click handler, and a link
     somebody shares from this page should carry the code too. */
  function carry() {
    var links = document.querySelectorAll('a[href^="https://app.itsnum.com"]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      // Never overwrite a code already written into a specific link by hand.
      if (/[?&]ref=/.test(href)) continue;
      links[i].setAttribute('href', href + (href.indexOf('?') === -1 ? '?' : '&')
        + 'ref=' + encodeURIComponent(code));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', carry);
  } else {
    carry();
  }
  /* site.js rewrites app links to /app/ inside social webviews AFTER this
     runs, and /app/ is on this origin where the code is already stored — so
     that path keeps working and this one does not fight it. Re-run late so a
     link added by any other script still gets the code. */
  setTimeout(carry, 1200);
})();
