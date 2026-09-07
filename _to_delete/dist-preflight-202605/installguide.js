/**
 * Which install steps this exact device and browser actually needs.
 *
 * The page used to decide with three tests — iPhone, Android, everything else
 * — and that is wrong in five ways that each cost a real install:
 *
 *   1. AN iPAD SAYS IT IS A MAC. Since iPadOS 13, Safari on iPad reports
 *      "Macintosh; Intel Mac OS X" in its user agent. Every iPad visitor was
 *      being handed desktop instructions. The tell is maxTouchPoints > 1 on a
 *      Mac, and it is the only tell there is.
 *   2. CHROME ON iOS CANNOT INSTALL AT ALL. Neither can Firefox or Edge —
 *      on iOS every browser is Safari's engine in someone else's chrome, and
 *      only Safari itself may add to the home screen. The old page put that in
 *      a sentence of prose in the Chrome instructions; somebody in iOS Chrome
 *      needs it as the FIRST thing they read, not a caveat inside steps they
 *      cannot follow.
 *   3. SAMSUNG INTERNET IS NOT CHROME, and its menu is somewhere else
 *      entirely. This matters more than it looks: 1,033 of the 1,230 people
 *      who landed here last week were on mobile in Thailand, where Samsung
 *      Internet has real share. "Tap the ⋮ menu in Chrome" is an instruction
 *      to open a menu that is not there.
 *   4. DESKTOP IS NOT ONE THING. Chrome and Edge have an install icon in the
 *      address bar; Safari 17+ says "Add to Dock" and not "Add to Home
 *      Screen"; Firefox cannot install a web app at all and never says so.
 *   5. AN ALREADY-INSTALLED APP was still being shown how to install.
 *
 * Pure, and separated from the page, so the matrix can be tested against real
 * user-agent strings instead of checked by holding six devices.
 */
(function (root) {
  'use strict';

  /* iOS 13+ dropped "iPad" from Safari's user agent, so a touch Mac is an
     iPad. A real Mac reports maxTouchPoints 0 even with a trackpad. */
  function isIPad(ua, touch) {
    return /iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1);
  }

  function detect(o) {
    o = o || {};
    var ua = o.ua || '';
    var touch = o.maxTouchPoints || 0;

    var ipad = isIPad(ua, touch);
    var iphone = /iPhone|iPod/.test(ua);
    var ios = ipad || iphone;
    var android = /Android/.test(ua);

    var browser =
      ios && /CriOS/.test(ua) ? 'chrome-ios' :
      ios && /FxiOS/.test(ua) ? 'firefox-ios' :
      ios && /EdgiOS/.test(ua) ? 'edge-ios' :
      ios && /OPT\//.test(ua) ? 'opera-ios' :
      ios ? 'safari-ios' :
      android && /SamsungBrowser/.test(ua) ? 'samsung' :
      android && /Firefox/.test(ua) ? 'firefox-android' :
      android && /OPR|Opera/.test(ua) ? 'opera-android' :
      android && /EdgA/.test(ua) ? 'edge-android' :
      android ? 'chrome-android' :
      /Firefox/.test(ua) ? 'firefox-desktop' :
      /Edg\//.test(ua) ? 'edge-desktop' :
      /Chrome|Chromium/.test(ua) ? 'chrome-desktop' :
      /Safari/.test(ua) ? 'safari-mac' : 'other';

    return {
      platform: ios ? (ipad ? 'ipad' : 'iphone') : android ? 'android' : 'desktop',
      browser: browser,
      standalone: !!o.standalone,
    };
  }

  /**
   * @returns {{platform, browser, standalone, canInstall, headline, steps, note}}
   *   `canInstall` false means this browser cannot add to the home screen at
   *   all, whatever the person does — and when that is true the steps say how
   *   to get somewhere that can, rather than describing a menu item that does
   *   not exist.
   */
  function guide(o) {
    var d = detect(o);
    var b = d.browser;
    var out = { platform: d.platform, browser: b, standalone: d.standalone,
                canInstall: true, headline: '', steps: [], note: '' };

    if (d.standalone) {
      out.canInstall = false;
      out.headline = 'Num is already installed';
      out.steps = ['You are using the installed app right now. Nothing else to do.'];
      return out;
    }

    /* ── iOS ──────────────────────────────────────────────────────────── */
    if (d.platform === 'iphone' || d.platform === 'ipad') {
      var where = d.platform === 'ipad' ? 'top right' : 'bottom of the screen';

      if (b === 'safari-ios') {
        out.headline = 'Add Num to your Home Screen';
        out.steps = [
          'Tap the <b>Share</b> button at the ' + where + ' — the square with an arrow coming out of it.',
          'Scroll down the list and choose <b>Add to Home Screen</b>.',
          'Tap <b>Add</b>. Num appears with your other apps.',
        ];
        return out;
      }

      // Every other iOS browser is Safari's engine wearing a different coat,
      // and only Safari itself is allowed to install. This is Apple's rule,
      // not a missing feature we could ship around.
      var named = b === 'chrome-ios' ? 'Chrome' : b === 'firefox-ios' ? 'Firefox'
        : b === 'edge-ios' ? 'Edge' : b === 'opera-ios' ? 'Opera' : 'this browser';
      out.canInstall = false;
      out.headline = 'On iPhone, only Safari can install';
      if (d.platform === 'ipad') out.headline = 'On iPad, only Safari can install';
      out.steps = [
        'In ' + named + ', tap the <b>Share</b> or <b>⋯</b> button, then <b>Open in Safari</b>.',
        'In Safari, tap <b>Share</b> at the ' + where + '.',
        'Choose <b>Add to Home Screen</b>, then <b>Add</b>.',
      ];
      out.note = 'This is Apple’s rule rather than something missing from ' + named +
        ' — no browser on iPhone except Safari is permitted to add an app to the Home Screen.';
      return out;
    }

    /* ── Android ──────────────────────────────────────────────────────── */
    if (d.platform === 'android') {
      if (b === 'samsung') {
        out.headline = 'Add Num to your Home screen';
        out.steps = [
          'Tap the <b>≡ menu</b> at the bottom right.',
          'Choose <b>Add page to</b>, then <b>Home screen</b>.',
          'Tap <b>Add</b>.',
        ];
        return out;
      }
      if (b === 'firefox-android') {
        out.headline = 'Add Num to your Home screen';
        out.steps = [
          'Tap the <b>⋮ menu</b> at the top right.',
          'Choose <b>Install</b> — or <b>Add to Home screen</b> on older versions.',
          'Confirm. Num appears with your other apps.',
        ];
        return out;
      }
      if (b === 'opera-android') {
        out.headline = 'Add Num to your Home screen';
        out.steps = [
          'Tap the <b>⋮ menu</b>.',
          'Choose <b>Home screen</b>.',
          'Confirm. Num appears with your other apps.',
        ];
        return out;
      }
      // Chrome and Edge behave the same here, and both usually offer the
      // native prompt before anyone reads this.
      out.headline = 'Add Num to your Home screen';
      out.steps = [
        'Tap the <b>⋮ menu</b> at the top right.',
        'Choose <b>Install app</b> — or <b>Add to Home screen</b> if you do not see it.',
        'Confirm. Num opens like any other app.',
      ];
      return out;
    }

    /* ── desktop ──────────────────────────────────────────────────────── */
    if (b === 'chrome-desktop' || b === 'edge-desktop') {
      out.headline = 'Install Num on this computer';
      out.steps = [
        'Look for the <b>install icon</b> at the right-hand end of the address bar — a small screen with an arrow.',
        'If it is not there, open the <b>⋮ menu</b> and choose <b>Install Num</b> — under <b>Apps</b> or <b>Cast, save and share</b>.',
        'Confirm. Num opens in its own window, like any other app.',
      ];
      return out;
    }
    if (b === 'safari-mac') {
      out.headline = 'Add Num to your Dock';
      out.steps = [
        'In the menu bar choose <b>File</b>, then <b>Add to Dock</b>.',
        'Or use the <b>Share</b> button in the toolbar and choose <b>Add to Dock</b>.',
        'Safari calls it the Dock rather than the Home Screen; it is the same thing.',
      ];
      out.note = 'Add to Dock needs Safari 17 or newer, which means macOS Sonoma or later.';
      return out;
    }

    out.canInstall = false;
    out.headline = 'This browser cannot install web apps';
    out.steps = [
      'Firefox on the desktop has no install option — that is a Firefox limitation, not a Num one.',
      'Open <b>itsnum.com</b> in Chrome, Edge or Safari to install it here.',
      'Or just use Num in this tab. Everything works; it simply will not have its own icon.',
    ];
    return out;
  }

  guide.detect = detect;
  guide.isIPad = isIPad;

  root.numInstallGuide = guide;
}(typeof self !== 'undefined' ? self : globalThis));
