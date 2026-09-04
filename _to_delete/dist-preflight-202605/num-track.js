/**
 * num-track.js — the install funnel, measured.
 *
 * Before this file existed, 714 landing views produced exactly three kinds of
 * record: the page was served, a claim page was served, a claim finished.
 * Nothing between arriving and using Num was observable, so no change to the
 * page could be judged. That is what this fixes.
 *
 * It reports to the same endpoint and the same table as everything else
 * (POST https://itsnum.com/api/ev → num_web_events), so the funnel reads as one
 * dataset rather than a second system that has to be reconciled later.
 *
 * Two things about that endpoint are worth knowing, because both were silent:
 *   1. It enforces an origin allowlist. app.itsnum.com was not on it and got a
 *      403 on every call.
 *   2. An event name it does not recognise returns HTTP 200 {"ignored":true}.
 *      Unrecognised tracking looks exactly like tracking that works and finds
 *      nothing. Both were fixed in growth/worker.js; if you add an event name
 *      here, add it there in the same commit or it will vanish quietly.
 *
 * Sends are fire-and-forget and never block the UI. If reporting breaks, the
 * page keeps working.
 */
(function () {
  'use strict';

  var API = 'https://itsnum.com/api/ev';
  // Which surface is reporting. Hard-coding 'landing' was fine while this file
  // only ran on one page; the moment it ships on itsnum.com AND app.itsnum.com
  // every row would claim to be the landing page and the funnel would read as
  // one step happening twice. Derived, so adding a page needs no edit here.
  var PAGE = (function () {
    var h = location.hostname, p = location.pathname;
    // PATH BEFORE HOST. The host test used to come first, so every visit to
    // app.itsnum.com/install — a completely different, static page — was
    // recorded as 'app' and became indistinguishable from the React app.
    // Two pages sharing one name means neither has a readable funnel: the
    // scrolls and CTA taps of one were being counted against the arrivals of
    // the other. Found 25 Aug 2026 while trying to explain why 101 arrivals
    // produced two events.
    if (p.indexOf('/install') === 0) return 'install';
    if (p.indexOf('/business') === 0) return 'business';
    if (h.indexOf('app.') === 0) return 'app';
    return 'landing';
  })();

  // Event names the worker will accept. Kept here so a typo fails loudly in the
  // console during development instead of dissolving into an "ignored" 200.
  var KNOWN = [
    'page_view', 'primary_cta_click',
    'install_cta_click', 'install_tab_view', 'install_prompt_shown',
    'install_accepted', 'install_dismissed', 'app_launched_standalone',
    'open_in_browser_click', 'first_message_sent', 'watch_film_click',
    // Added 3 Sep 2026, the day the ads moved to /ask/. `first_message_sent`
    // had no partner: we could see that somebody asked and never whether Num
    // answered — and a failure showed the guest a polite line and told us
    // nothing at all, on the one page paid traffic lands on.
    'num_answered', 'ask_failed',
    'scroll_50', 'scroll_90',
    'desktop_handoff_shown', 'desktop_qr_shown', 'desktop_link_sent',
    'lang_offer_shown', 'lang_switched',
    // --- the app's own moments (added 2 Sep 2026) ---
    'consent_prompt_shown', 'consent_prompt_engaged',
    // --- recommendation cards (added 3 Sep 2026) ---
    'pick_link_click', 'pick_map_click', 'pick_call_click'
  ];

  var qs = new URLSearchParams(location.search);
  var sent = {};   // one of each per page view — taps are intent, not volume

  function standalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
           navigator.standalone === true;
  }

  function track(event, extra) {
    if (KNOWN.indexOf(event) === -1) {
      // Loud on purpose. The worker would accept this with a 200 and record
      // nothing, which is the failure mode this whole file exists to prevent.
      if (window.console) console.warn('[num-track] unknown event "' + event +
        '" — add it to EVENTS in growth/worker.js or it will be dropped silently');
      return;
    }
    var body = {
      event: event,
      page: PAGE,
      // device is NOT sent: the worker derives it from the user-agent server
      // side, so it cannot be spoofed and cannot drift from historical rows.
      utm_source: qs.get('utm_source') || '',
      utm_medium: qs.get('utm_medium') || '',
      utm_campaign: qs.get('utm_campaign') || '',
      referrer: document.referrer || ''
    };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) body[k] = extra[k];

    var payload = JSON.stringify(body);
    try {
      // text/plain is CORS-safelisted, so this is a simple request with no
      // preflight — it still arrives as a JSON string and parses server-side.
      // sendBeacon also survives the page being closed mid-tap, which is
      // precisely when an install click is most likely to be lost.
      if (navigator.sendBeacon &&
          navigator.sendBeacon(API, new Blob([payload], { type: 'text/plain' }))) {
        return;
      }
    } catch (e) { /* fall through */ }
    try {
      fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: payload,
        keepalive: true,
        mode: 'cors'
      }).catch(function () {});
    } catch (e) { /* reporting must never break the page */ }

    // Mirror to GA4 when it is present, so the same funnel is visible in both.
    if (typeof window.gtag === 'function') {
      window.gtag('event', event, body);
    }

    // Mirror to the Reddit pixel where it is present. THE conversion is
    // `first_message_sent`: the moment a stranger became a user. Reddit is 87%
    // of every visitor NUM has ever had, and until 3 Sep 2026 the campaign
    // could see none of this — so it optimised for people who load a page,
    // which is the cheapest and least valuable human on the internet to buy.
    //
    // Standard event names, because Reddit's optimiser and its reporting both
    // work far better against its own vocabulary than against custom ones.
    // Everything else stays unreported on purpose: a conversion signal made of
    // scroll depth teaches the auction to buy scrollers.
    if (typeof window.rdt === 'function') {
      var RED = {
        first_message_sent: 'Lead',
        install_accepted: 'SignUp',
        app_launched_standalone: 'SignUp',
      };
      if (RED[event]) {
        try {
          window.rdt('track', RED[event], {
            // Same id shape the marketing site uses (public/js/reddit.js), so
            // the Conversions API can de-duplicate these later without a
            // window of double-counted conversions nobody can untangle.
            conversionId: (window.crypto && crypto.randomUUID)
              ? crypto.randomUUID()
              : 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
          });
        } catch (e) { /* a blocked pixel must never break the page */ }
      }
    }
  }

  function once(event, extra) {
    if (sent[event]) return;
    sent[event] = 1;
    track(event, extra);
  }

  window.numTrack = track;   // for the app shell to call first_message_sent

  // --- arrival --------------------------------------------------------------
  // Fired before anything else, because until 24 Aug 2026 this file had no
  // arrival event at all. The earliest thing it could record was scroll_50, so
  // every funnel built on it started halfway down the page and no rate on this
  // surface had a denominator. `once` because a rate needs people, not scrolls.
  once('page_view');

  // --- install intent -------------------------------------------------------
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a, button');
    if (!a) return;
    var href = (a.getAttribute('href') || '');
    var label = (a.textContent || '').trim().slice(0, 40);

    if (href.indexOf('#install') === 0 || /home screen/i.test(label)) {
      track('install_cta_click', { detail: a.dataset.loc || label });
    } else if (a.classList.contains('tab') && a.dataset.p) {
      track('install_tab_view', { detail: a.dataset.p });
    } else if (/open it in my browser/i.test(label)) {
      // GENUINELY leaving for the system browser. Nothing else belongs here.
      track('open_in_browser_click', { detail: label });
    } else if (/Open Num|Ask Num something/i.test(label)) {
      // The primary call to action — "I want to use this".
      //
      // These used to fire open_in_browser_click, and it cost us a wrong
      // conclusion in a written report: all 25 of those events carried the
      // label "Ask Num something", and they were read as 25 people fleeing an
      // in-app browser. They were the opposite — the most interested people on
      // the page, tapping the button that means yes. An event whose name says
      // the reverse of what happened is worse than no event at all.
      track('primary_cta_click', { detail: label });
    } else if (href.indexOf('/watch') === 0) {
      track('watch_film_click');
    }
  }, true);

  // --- the real install signal ---------------------------------------------
  // beforeinstallprompt only fires where the browser considers the app
  // installable. Capturing the deferred prompt also lets the page trigger it
  // on a tap instead of hoping the user finds the browser menu.
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    window.numDeferredPrompt = e;
    once('install_prompt_shown');
    e.userChoice && e.userChoice.then(function (c) {
      track(c && c.outcome === 'accepted' ? 'install_accepted' : 'install_dismissed');
    });
  });
  window.addEventListener('appinstalled', function () { track('install_accepted'); });

  // Opened from the home screen icon — the only unambiguous proof of install,
  // and the one iOS gives us, since iOS never fires beforeinstallprompt.
  if (standalone()) once('app_launched_standalone');

  // --- attention ------------------------------------------------------------
  var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      var h = document.documentElement;
      var pct = (h.scrollTop + window.innerHeight) / h.scrollHeight * 100;
      if (pct >= 50) once('scroll_50');
      if (pct >= 90) once('scroll_90');
    });
  }, { passive: true });
})();
