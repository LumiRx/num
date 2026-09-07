/* The shared nav's behaviour: open/close on mobile, and mark where you are.
 *
 * Both were broken before. site.js's active-link check compared an href like
 * "/how-it-works/" against `location.pathname.split('/').pop()` — "how-it-works"
 * without the slashes — so it never matched anything and no page has ever shown
 * as current. This compares whole paths.
 *
 * No dependency on site.js, because 41 of the pages that now carry a nav do not
 * load it.
 */
(function () {
  'use strict';
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }
  ready(function () {
    var nav = document.querySelector('.nv');
    if (!nav) return;
    var btn = nav.querySelector('.nv-burger');
    var menu = nav.querySelector('.nv-menu');
    if (btn && menu) {
      menu.hidden = true;
      btn.addEventListener('click', function () {
        var open = menu.hidden;
        menu.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      // Escape closes it, because a menu you cannot dismiss with the keyboard
      // is a trap for anyone not using a thumb.
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !menu.hidden) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
      });
    }
    // Where am I. Trailing slashes normalised so "/perks" and "/perks/" are
    // the same page, which they are.
    var here = location.pathname.replace(/\/+$/, '') || '/';
    var links = nav.querySelectorAll('.nv-links a, .nv-menu a');
    for (var i = 0; i < links.length; i++) {
      var href = (links[i].getAttribute('href') || '').replace(/\/+$/, '') || '/';
      if (href === here) links[i].setAttribute('aria-current', 'page');
    }
  });
})();
