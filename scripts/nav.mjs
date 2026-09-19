/**
 * THE NAV, ONCE — for the generators that write HTML.
 *
 * worker/nav.test.mjs is the guard that reads public/ and fails when a page
 * has no way out of itself, or still carries the pre-September markup
 * (.nav/.navlinks/.menu-btn/.mobile). It caught scripts/pseo/genclients.mjs
 * emitting the old shape months after the hand-written pages moved, and on
 * 19 Sep 2026 it caught the whole pSEO set the same way: /guides/ and both
 * Rome guides shipped with a five-link header that no longer exists anywhere
 * else on the site.
 *
 * The comment in genclients.mjs said the copy there was "kept byte-identical
 * to the shared nav". There was no shared nav — there were three copies that
 * happened to agree, which is not the same thing and is not a property that
 * survives anybody editing one of them.
 *
 * This is that shared nav. It is lifted verbatim from what the hand-written
 * pages serve, so importing it changes no byte of any page that already
 * passes. scripts/nav.test.mjs checks that the copies still inlined in other
 * generators match it, so the next edit to any of them shows up as a failing
 * test rather than as two navigations on one site.
 *
 * NAV_HEAD goes in <head> — the nav is self-contained and must not depend on
 * assets/site.css, because 41 pages do not load it and unstyled markup is
 * worse than no nav at all.
 *
 * TRANSLATE goes at the end of <body>. worker/translate.test.mjs is its
 * guard, and its rule is the same one: one line per page, never the widget
 * pasted inline.
 */

export const NAV = `<nav class="nv">
  <div class="nv-bar">
    <a class="nv-brand" href="/"><span class="nv-dot"></span>NUM <small>travel concierge</small></a>
    <div class="nv-links">
      <a href="/what-we-do/">What we do</a>
      <a href="/how-it-works/">How it works</a>
      <a href="/destinations/">Destinations</a>
      <span class="nv-sep"></span>
      <a href="/business/">For business</a>
      <a href="/hosts/">For hosts</a>
      <a href="/agents/">For AI agents</a>
    </div>
    <div class="nv-end">
      <a class="nv-signin" id="navAuth" href="/signin/">Sign in</a>
      <a class="nv-cta" href="https://app.itsnum.com/?app=1">Get NUM</a>
    </div>
    <button class="nv-burger" type="button" aria-label="Menu" aria-expanded="false">&#9776;</button>
  </div>
  <div class="nv-menu" hidden>
    <p class="nv-group">Travellers</p>
    <a href="/what-we-do/">What we do</a>
    <a href="/how-it-works/">How it works</a>
    <a href="/destinations/">Destinations</a>
    <a href="/perks/">Perks</a>
    <p class="nv-group">Partners</p>
    <a href="/business/">For business</a>
    <a href="/claim/">List your business</a>
    <a href="/hosts/">For hosts</a>
    <a href="/ambassadors/">For ambassadors</a>
    <a href="/agents/">For AI agents</a>
    <p class="nv-group">Account</p>
    <a href="/signin/">Sign in</a>
    <a href="/contact/">Contact</a>
  </div>
</nav>`;

/**
 * The nav's own stylesheet and script. Must sit above </head>.
 *
 * refcarry.js belongs here and not in some other list, because the reason a
 * page needs it is the nav: the "Get NUM" button is a link to
 * app.itsnum.com, a different origin, and localStorage does not cross one.
 * Measured on production on 19 Sep 2026 — 21 referral arrivals logged, zero
 * members with a referrer. Every code was dropped at that boundary in
 * silence. worker/refcarry.test.mjs is the guard on the output; putting the
 * script in the same constant as the link that needs it is what stops a new
 * generator being the next page to drop them.
 */
export const NAV_HEAD = `<link rel="stylesheet" href="/assets/nav.css">
<script src="/assets/nav.js" defer></script>
<script src="/assets/refcarry.js" defer></script>`;

/** One line, end of <body>. assets/translate.js injects the rest itself. */
export const TRANSLATE = `<script src="/assets/translate.js" defer></script>`;
