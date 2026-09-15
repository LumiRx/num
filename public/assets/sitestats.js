/*
 * NUM · live site numbers.
 *
 * Every figure on the marketing pages is written in the HTML as a fallback
 * and then replaced with a counted one. The fallback is not decoration: if
 * this script is blocked, fails, or the API is down, the page still reads
 * correctly — it just reads yesterday's number instead of today's.
 *
 * Usage in the HTML:
 *     <span data-stat="places">2.7M+</span>
 *     <span data-stat="destinations">104</span>
 *
 * Numbers only ever go UP from a stale fallback here, because the fallback
 * is written from the last known count and the directory only grows. If a
 * counted number ever comes back SMALLER than the fallback, that is a
 * database problem, not a marketing one — the script leaves the page alone
 * and says so in the console rather than quietly shrinking a claim.
 */
(function () {
  var API = 'https://app.itsnum.com/api/site/stats';

  function parseFallback(text) {
    var t = String(text || '').trim().replace(/[+,]/g, '');
    var m = /^([0-9.]+)([MmKk])?$/.exec(t);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    if (m[2] === 'M' || m[2] === 'm') n *= 1e6;
    if (m[2] === 'K' || m[2] === 'k') n *= 1e3;
    return n;
  }

  function apply(stats) {
    var nodes = document.querySelectorAll('[data-stat]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute('data-stat');
      var stat = stats[key];
      if (!stat || typeof stat.n !== 'number') continue;

      // A stat the server says is too small to be a proof point is not shown.
      // The tile is removed rather than left displaying the fallback, because
      // a stale big number is worse than no number.
      if (stat.show === false) {
        var tile = el.closest('[data-stat-tile]');
        if (tile && tile.parentNode) tile.parentNode.removeChild(tile);
        continue;
      }

      var was = parseFallback(el.textContent);
      if (was !== null && stat.n < was) {
        if (window.console && console.warn) {
          console.warn('[num-stats] ' + key + ' came back smaller than the page says ('
            + stat.n + ' < ' + was + '). Leaving the page alone.');
        }
        continue;
      }
      el.textContent = stat.friendly;
      if (stat.label) el.setAttribute('title', stat.label);
    }
  }

  function go() {
    try {
      fetch(API, { mode: 'cors', credentials: 'omit' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (b) { if (b && b.ok && b.stats) apply(b.stats); })
        .catch(function () { /* the fallback in the HTML stands */ });
    } catch (e) { /* same */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', go);
  } else {
    go();
  }
})();
