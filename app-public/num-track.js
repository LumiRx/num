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
    if (h.indexOf('app.') === 0) return 'app';
    if (p.indexOf('/install') === 0) return 'install';
    if (p.indexOf('/business') === 0) return 'business';
    return 'landing';
  })();

  // Event names the worker will accept. Kept here so a typo fails loudly in the
  // console during development instead of dissolving into an "ignored" 200.
  var KNOWN = [
    'install_cta_click', 'install_tab_view', 'install_prompt_shown',
    'install_accepted', 'install_dismissed', 'app_launched_standalone',
    'open_in_browser_click', 'first_message_sent', 'watch_film_click',
    'scroll_50', 'scroll_90',
    'desktop_handoff_shown', 'desktop_qr_shown', 'desktop_link_sent',
    'lang_offer_shown', 'lang_switched'
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
  }

  function once(event, extra) {
    if (sent[event]) return;
    sent[event] = 1;
    track(event, extra);
  }

  window.numTrack = track;   // for the app shell to call first_message_sent

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
    } else if (/open it in my browser|Open Num|Ask Num something/i.test(label)) {
      track('open_in_browser_click', { detail: label });
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
