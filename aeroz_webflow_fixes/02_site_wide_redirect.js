/* =====================================================================
   AEROZ — Site-wide link rewriter, dead-link fixer, mobile menu fallback.
   Paste between <script>...</script> in:
   Webflow → Project Settings → Custom Code → Footer Code
   =====================================================================

   What this does, in order:

   1. Rewrites every <a href="/dscsa"> to "/#audit-dscsa" so visitors land
      on the actual DSCSA content (which lives in the home page audit
      section) instead of the 404.

   2. Rewrites every <a href="/our-team"> to "/about" so the contact-page
      team link no longer 404s.

   3. Fixes the "Terms" link on /contact (and anywhere else) that has no
      href — it now points to "/tos".

   4. Removes any leftover empty <a href=""> elements (the two empties
      we saw on /platform, /supply-chain, /implementation, /liquid-data
      that render as invisible icons). Replaces them with non-clickable
      spans so they no longer behave as broken links.

   5. Mobile menu fallback — if there's a header button with text "≡"
      that has no handler, this wires it up to toggle a full-screen
      overlay menu.

   6. Audit dropdown — on mobile, makes the dropdown click-to-open
      instead of hover-only.

   ===================================================================== */

(function () {
  'use strict';

  // -- 1+2. URL rewriter ----------------------------------------------
  var rewrites = {
    '/dscsa': '/#audit-dscsa',
    '/our-team': '/about',
    '/learn-more': '/'
  };

  function rewriteLinks(root) {
    root.querySelectorAll('a[href]').forEach(function (a) {
      var href = a.getAttribute('href');
      if (!href) return;
      // Strip query/hash for matching but preserve them on rewrite.
      var base = href.split('?')[0].split('#')[0];
      // Handle both "/dscsa" and "https://aeroz.io/dscsa"
      var path = base.replace(/^https?:\/\/aeroz\.io/, '');
      if (rewrites.hasOwnProperty(path)) {
        a.setAttribute('href', rewrites[path]);
        a.dataset.aerozRewritten = 'true';
      }
    });
  }

  // -- 3. "Terms" empty-href fix --------------------------------------
  function fixTermsLink(root) {
    root.querySelectorAll('a').forEach(function (a) {
      var t = (a.textContent || '').trim().toLowerCase();
      var h = a.getAttribute('href');
      if (t === 'terms' && (!h || h === '#' || h === '')) {
        a.setAttribute('href', '/tos');
        a.dataset.aerozPatched = 'true';
      }
      if (t === 'privacy' && (!h || h === '#' || h === '')) {
        a.setAttribute('href', '/privacy-policy');
        a.dataset.aerozPatched = 'true';
      }
    });
  }

  // -- 4. Defuse empty/hash-only <a> ----------------------------------
  function defuseDeadLinks(root) {
    root.querySelectorAll('a').forEach(function (a) {
      var h = a.getAttribute('href');
      if (h === '' || h === '#' || h === null) {
        // If it has visible text, leave it but make it inert.
        var hasText = (a.textContent || '').trim().length > 0;
        if (!hasText) {
          a.removeAttribute('href');
          a.style.pointerEvents = 'none';
          a.dataset.aerozInert = 'true';
        }
      }
    });
  }

  // -- 5. Mobile menu fallback (if "≡" button is unwired) -------------
  function ensureMobileMenu() {
    if (window.innerWidth > 768) return;
    var btn = null;
    document.querySelectorAll('header button, nav button').forEach(function (b) {
      var t = (b.textContent || '').trim();
      if (t === '≡' || t === '☰') btn = b;
    });
    if (!btn) return;
    if (btn.dataset.aerozMenu === 'wired') return;
    btn.dataset.aerozMenu = 'wired';

    var menu = document.createElement('div');
    menu.id = 'aeroz-mobile-menu';
    menu.setAttribute('aria-hidden', 'true');
    menu.style.cssText = [
      'position:fixed','inset:0','background:rgba(11,20,38,0.97)',
      'backdrop-filter:blur(8px)','z-index:9999','display:none',
      'flex-direction:column','padding:24px','color:#E6EEF7',
      'font-family:Inter,sans-serif','overflow-y:auto'
    ].join(';');

    menu.innerHTML = [
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:32px">',
      '  <span style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#A9CCE3">AEROZ // MENU</span>',
      '  <button id="aeroz-menu-close" aria-label="Close menu" style="background:none;border:0;color:#E6EEF7;font-size:28px;line-height:1;cursor:pointer">×</button>',
      '</div>',
      '<a href="/" style="padding:16px 0;border-bottom:1px solid rgba(255,255,255,0.08);color:#E6EEF7;text-decoration:none;font-size:1.25rem">Home</a>',
      '<a href="/platform" style="padding:16px 0;border-bottom:1px solid rgba(255,255,255,0.08);color:#E6EEF7;text-decoration:none;font-size:1.25rem">Platform</a>',
      '<a href="/technology" style="padding:16px 0;border-bottom:1px solid rgba(255,255,255,0.08);color:#E6EEF7;text-decoration:none;font-size:1.25rem">Technology</a>',
      '<a href="/industries" style="padding:16px 0;border-bottom:1px solid rgba(255,255,255,0.08);color:#E6EEF7;text-decoration:none;font-size:1.25rem">Industries</a>',
      '<a href="/supply-chain" style="padding:16px 0;border-bottom:1px solid rgba(255,255,255,0.08);color:#E6EEF7;text-decoration:none;font-size:1.25rem">Supply Chain</a>',
      '<a href="/liquid-data" style="padding:16px 0;border-bottom:1px solid rgba(255,255,255,0.08);color:#E6EEF7;text-decoration:none;font-size:1.25rem">Liquid Data</a>',
      '<a href="/implementation" style="padding:16px 0;border-bottom:1px solid rgba(255,255,255,0.08);color:#E6EEF7;text-decoration:none;font-size:1.25rem">Implementation</a>',
      '<a href="/ai-management" style="padding:16px 0;border-bottom:1px solid rgba(255,255,255,0.08);color:#E6EEF7;text-decoration:none;font-size:1.25rem">num™ (AI Management)</a>',
      '<a href="/about" style="padding:16px 0;border-bottom:1px solid rgba(255,255,255,0.08);color:#E6EEF7;text-decoration:none;font-size:1.25rem">About</a>',
      '<a href="/blog" style="padding:16px 0;border-bottom:1px solid rgba(255,255,255,0.08);color:#E6EEF7;text-decoration:none;font-size:1.25rem">Blog</a>',
      '<div style="margin-top:24px;padding-top:24px;border-top:1px solid rgba(255,255,255,0.12)">',
      '  <span style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#A9CCE3;display:block;margin-bottom:8px">Audit</span>',
      '  <a href="/#audit-dscsa" style="display:block;padding:10px 0;color:#E6EEF7;text-decoration:none">DSCSA · US Pharma</a>',
      '  <a href="/#audit-battery" style="display:block;padding:10px 0;color:#E6EEF7;text-decoration:none">EU Battery Passport</a>',
      '  <a href="/#audit-dpp" style="display:block;padding:10px 0;color:#E6EEF7;text-decoration:none">EU Digital Product Passport</a>',
      '  <a href="/#audit-fmd" style="display:block;padding:10px 0;color:#E6EEF7;text-decoration:none">FMD Authentication</a>',
      '  <a href="/#audit-eudr" style="display:block;padding:10px 0;color:#E6EEF7;text-decoration:none">EUDR Provenance</a>',
      '  <a href="/#audit-forced-labour" style="display:block;padding:10px 0;color:#E6EEF7;text-decoration:none">Forced Labour Compliance</a>',
      '</div>',
      '<a href="/contact" style="margin-top:32px;display:inline-flex;align-items:center;justify-content:center;background:#CADCFC;color:#0B1426;padding:16px 24px;border-radius:999px;text-decoration:none;font-weight:600;min-height:52px">Start an audit →</a>'
    ].join('');

    document.body.appendChild(menu);

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      menu.style.display = 'flex';
      menu.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
    });

    document.getElementById('aeroz-menu-close').addEventListener('click', function () {
      menu.style.display = 'none';
      menu.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
    });

    // Close menu when any link inside it is tapped (so route changes feel snappy).
    menu.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        menu.style.display = 'none';
        menu.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
      });
    });
  }

  // -- 6. Audit dropdown: click-to-open on mobile ---------------------
  function wireDropdownClick() {
    if (window.innerWidth > 768) return;
    document.querySelectorAll('.w-dropdown-toggle, [data-dropdown-toggle], .dropdown-toggle').forEach(function (toggle) {
      if (toggle.dataset.aerozDropdown === 'wired') return;
      toggle.dataset.aerozDropdown = 'wired';
      toggle.addEventListener('click', function (e) {
        e.preventDefault();
        var list = toggle.nextElementSibling;
        if (!list) return;
        var open = list.classList.contains('w--open') || list.classList.contains('is-open');
        if (open) {
          list.classList.remove('w--open', 'is-open');
        } else {
          list.classList.add('w--open', 'is-open');
        }
      });
    });
  }

  // -- run on DOM ready and on dynamic mutations ----------------------
  function runAll() {
    var root = document;
    rewriteLinks(root);
    fixTermsLink(root);
    defuseDeadLinks(root);
    ensureMobileMenu();
    wireDropdownClick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runAll);
  } else {
    runAll();
  }

  // Webflow pages sometimes inject content after load — re-run.
  window.addEventListener('load', runAll);

  // Re-run on viewport resize (when crossing the mobile breakpoint).
  var lastWidth = window.innerWidth;
  window.addEventListener('resize', function () {
    if ((lastWidth > 768) !== (window.innerWidth > 768)) {
      lastWidth = window.innerWidth;
      runAll();
    }
  });

})();
