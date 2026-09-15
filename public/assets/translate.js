/*
 * NUM · one translator, every page.
 *
 * ── WHY THIS IS A FILE AND NOT A SNIPPET ─────────────────────────────────
 *
 * The widget used to be pasted inline into each page: a div, a style rule, an
 * init function and a script tag, four things to remember. Thirty-four pages
 * had all four and forty-seven had none — including Bangkok, Phuket, the FAQ
 * and How it works, while a single Taiwanese mountain village had it.
 *
 * Nobody decided that. It is what a copy-paste snippet does over a year, and
 * the CSS had already drifted into three slightly different versions.
 *
 * So the whole thing lives here, injects its own markup and its own styles,
 * and a page opts in with one line. `translate.test.mjs` fails the build if a
 * page is missing it and is not on the list of deliberate exemptions — the
 * same shape as the nav test, for the same reason.
 *
 * ── WHAT IT ACTUALLY DOES ────────────────────────────────────────────────
 *
 * Google's website translator. Not a replacement for Num itself answering in
 * the traveller's language — that happens in the app and is the real feature.
 * This is for the marketing pages a stranger lands on from a search in Thai or
 * Japanese before they have ever spoken to Num, and its job is to let them
 * read the page rather than bounce.
 *
 * It fails quietly. If Google is blocked — and it is, in some of the countries
 * Num covers — the control never appears and the page stays exactly as it was
 * in English. A broken widget must never leave a dead box sitting over the
 * corner of a page.
 */
(function () {
  if (window.__numTranslate) return;
  window.__numTranslate = true;

  var HOST_ID = 'gtx';

  function styles() {
    if (document.getElementById('gtx-style')) return;
    var css = [
      /* Bottom-right, above everything, out of the way of the page's own
         calls to action. Fixed rather than sticky so it survives a long page. */
      '.gtx{position:fixed;right:14px;bottom:14px;z-index:9999;',
      'background:rgba(255,255,255,.92);border:1.5px solid #DDE0FB;border-radius:999px;',
      'padding:7px 14px;box-shadow:0 10px 30px rgba(76,81,161,.20);',
      '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);font-size:13px;',
      /* Hidden until Google actually answers. An empty pill in the corner of
         every page looks like something failed to load, which is worse than
         no control at all. */
      'display:none}',
      '.gtx.ready{display:block}',
      '@media (prefers-color-scheme:dark){.gtx{background:rgba(26,29,34,.92);border-color:#2B2F36;color:#f2efec}}',
      /* Google injects a banner at the top of the document that shoves the
         whole page down and covers a fixed header. Nobody wants it. */
      '.skiptranslate{display:none!important}',
      'body{top:0!important}',
      /* On a phone the pill sits where a thumb rests, so it is smaller and
         tucked in tighter. */
      '@media (max-width:480px){.gtx{right:8px;bottom:8px;padding:6px 10px;font-size:12px}}',
      '@media print{.gtx{display:none!important}}',
    ].join('');
    var el = document.createElement('style');
    el.id = 'gtx-style';
    el.appendChild(document.createTextNode(css));
    document.head.appendChild(el);
  }

  function host() {
    var el = document.getElementById(HOST_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = HOST_ID;
    el.className = 'gtx';
    // Named for a screen reader, because to anyone not looking at it this is
    // an unlabelled select that changes the whole page.
    el.setAttribute('aria-label', 'Translate this page');
    document.body.appendChild(el);
    return el;
  }

  window.gtInit = function () {
    try {
      /* eslint-disable-next-line no-undef */
      new google.translate.TranslateElement(
        { pageLanguage: 'en', layout: google.translate.TranslateElement.InlineLayout.SIMPLE },
        HOST_ID,
      );
      // Only now is there something to show.
      var el = document.getElementById(HOST_ID);
      if (el) el.className = 'gtx ready';
    } catch (e) {
      // Blocked, offline, or Google changed the shape of it. The page is
      // still a perfectly good page in English.
    }
  };

  function go() {
    styles();
    host();
    var s = document.createElement('script');
    s.src = 'https://translate.google.com/translate_a/element.js?cb=gtInit';
    s.defer = true;
    s.onerror = function () {
      var el = document.getElementById(HOST_ID);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    };
    document.head.appendChild(s);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', go);
  } else {
    go();
  }
})();
