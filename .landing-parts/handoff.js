
/* ── Desktop handoff ──────────────────────────────────────────────────────
   Only runs on a real pointer + wide viewport. A phone must never be shown a
   QR code it physically cannot scan, and a tablet in landscape is a genuine
   edge case, so we gate on the same 760px the CSS uses rather than sniffing
   the user agent a second time. */
(function () {
  var box = document.getElementById('handoff');
  if (!box) return;
  var wide = window.matchMedia('(min-width:760px)').matches;
  var touch = window.matchMedia('(pointer:coarse)').matches;
  if (!wide || touch) return;

  box.hidden = false;
  if (window.numTrack) { window.numTrack('desktop_handoff_shown'); window.numTrack('desktop_qr_shown'); }

  var LINK = 'https://app.itsnum.com/install/?utm_source=desktop&utm_medium=handoff&utm_campaign=copy';
  var btn = document.getElementById('copyLink');
  var msg = document.getElementById('copiedMsg');
  btn && btn.addEventListener('click', function () {
    function done() {
      if (msg) { msg.hidden = false; setTimeout(function () { msg.hidden = true; }, 4000); }
      if (window.numTrack) window.numTrack('desktop_link_sent', { detail: 'copy' });
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(LINK).then(done, fallback);
    } else { fallback(); }
    function fallback() {
      /* execCommand is deprecated but still the only path on older Safari and
         on any page served without a secure context. Failing silently here
         would leave the button looking broken. */
      var t = document.createElement('textarea');
      t.value = LINK; t.setAttribute('readonly',''); t.style.position='fixed'; t.style.opacity='0';
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { window.prompt('Copy this link:', LINK); }
      document.body.removeChild(t);
    }
  });
})();
