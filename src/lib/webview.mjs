/**
 * Is this an in-app browser — and if so, whose?
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * Measured on 24 Aug 2026, across every person who has ever reached the app
 * surface: 80 of 93 arrived with NO referrer, 25 tapped "open in my browser",
 * and 19 of those did it as their VERY FIRST action — before scrolling
 * anything. Only 8 have ever seen a browser install prompt.
 *
 * That is the signature of an in-app browser. Reddit, which is where our only
 * working channel sends people, opens links in its own WKWebView. In there:
 *
 *   - `beforeinstallprompt` never fires, so the one-tap install never appears;
 *   - there is no Share → "Add to Home Screen", because that is a Safari menu
 *     and this is not Safari;
 *   - storage is often partitioned, so an account made here can vanish.
 *
 * And until today we showed those people "Tap the Share button at the bottom
 * of Safari". Instructions that cannot be followed, to users who are not where
 * we think they are. Nineteen people tried to escape on arrival; the product
 * was telling them to do something impossible.
 *
 * The fix is not cleverness, it is honesty: say which app's browser they are
 * in, and tell them to open Num properly.
 *
 * ── WHY IT IS PURE, AND .mjs ─────────────────────────────────────────────
 *
 * Detection here is a function of a string. Keeping it free of `window` means
 * it can be tested against real user-agent strings rather than asserted
 * against source text, which is what the platform branches in native.ts have
 * to settle for. The DOM-aware wrapper lives in native.ts and stays thin.
 */

/**
 * Apps whose in-app browser we can name.
 *
 * Naming it matters: "You're in Reddit's browser" is a sentence someone can
 * act on. "Your browser is unsupported" is one they argue with.
 *
 * Ordered most-specific first. Facebook's Messenger ships an FBAN token too,
 * so Messenger must be tested before the generic Facebook signature or every
 * Messenger user is told they are in Facebook.
 */
export const IN_APP_SIGNATURES = [
  // \b is load-bearing: WeChat sends "MicroMessenger/8.0.40", which matches a
  // bare /Messenger\// and had every WeChat user reported as Messenger until
  // the test below caught it.
  { name: 'Messenger', re: /\bMessenger(ForiOS|Lite)?[\s/]|FBAN\/Messenger/i },
  { name: 'Facebook', re: /FBAN\/|FB_IAB\/|FBAV\//i },
  { name: 'Instagram', re: /\bInstagram[\s/]/i },
  { name: 'Reddit', re: /\bReddit[\s/]/i },
  { name: 'TikTok', re: /BytedanceWebview|musical_ly|\bBytedance\b/i },
  { name: 'LINE', re: /\bLine\/[\d.]|\bLIFF\b/i },
  { name: 'X', re: /Twitter for (?:iPhone|iPad|Android)|\bTwitterAndroid\b/i },
  { name: 'Snapchat', re: /\bSnapchat\b/i },
  { name: 'WeChat', re: /MicroMessenger/i },
  { name: 'LinkedIn', re: /\bLinkedInApp\b/i },
  { name: 'Pinterest', re: /\bPinterest(?:Bot)?[\s/]/i },
];

/** The app whose browser this is, or null when we cannot name one. */
export function namedInAppBrowser(ua) {
  const s = String(ua || '');
  if (!s) return null;
  for (const { name, re } of IN_APP_SIGNATURES) if (re.test(s)) return name;
  return null;
}

const isIos = (ua) => /iPad|iPhone|iPod/i.test(String(ua || ''));

/**
 * An iOS web view we could not name.
 *
 * Real mobile Safari always carries a `Safari/` token AND a `Version/` token.
 * A WKWebView embedded in someone else's app carries neither. That is a
 * reliable split — with ONE trap, which is why `standalone` is a required
 * consideration at the call site rather than something guessed here:
 *
 *   an installed PWA launched from the iOS home screen ALSO has no Safari and
 *   no Version token.
 *
 * So this signature alone cannot tell "inside Reddit" from "installed, running
 * standalone" — the two states we most need to keep apart, since one needs an
 * install nudge and the other must never see one. The caller passes the
 * display-mode answer in; see `detectInAppBrowser`.
 */
export function looksLikeIosWebView(ua) {
  const s = String(ua || '');
  if (!isIos(s)) return false;
  if (!/AppleWebKit/i.test(s)) return false;
  return !/Safari\//i.test(s) && !/Version\/[\d.]+/i.test(s);
}

/**
 * What environment are we in, for the purposes of offering an install?
 *
 * Returns `{ inApp, name, canInstallHere, reason }`.
 *
 * `standalone` MUST be the real answer from the display-mode media query or
 * navigator.standalone. Passing it wrongly is the one way to get this badly
 * wrong: an installed iOS user would be told to leave the app they installed.
 */
export function detectInAppBrowser(ua, { standalone = false } = {}) {
  const s = String(ua || '');

  // Already installed and running standalone. Nothing to offer, and the iOS
  // heuristic below would misfire, so this answer comes first and unconditionally.
  if (standalone) {
    return { inApp: false, name: null, canInstallHere: false, reason: 'standalone' };
  }

  const named = namedInAppBrowser(s);
  if (named) {
    return { inApp: true, name: named, canInstallHere: false, reason: 'named' };
  }

  if (looksLikeIosWebView(s)) {
    return { inApp: true, name: null, canInstallHere: false, reason: 'ios-webview' };
  }

  return { inApp: false, name: null, canInstallHere: true, reason: 'browser' };
}

/**
 * What to tell them, in their own situation's words.
 *
 * Kept here so the floating prompt and the landing-page section cannot drift
 * apart — LaunchStage already carries a comment warning that two different
 * sets of instructions for the same three taps is a bug, and that warning was
 * written before either of them knew about web views at all.
 */
export function escapeInstruction(ua, opts = {}) {
  const d = detectInAppBrowser(ua, opts);
  if (!d.inApp) return null;
  const where = d.name ? `${d.name}’s built-in browser` : 'an app’s built-in browser';
  return {
    name: d.name,
    eyebrow: 'KEEP NUM HANDY',
    heading: d.name ? `Add Num from ${d.name}? Not quite.` : 'Add Num from here? Not quite.',
    // Says the payoff, not the mechanics. "Add to Home Screen" is not on offer
    // in here at all, so leading with it would be the old bug in new words.
    // ── WHAT CHANGED, 2 SEP 2026 ──────────────────────────────────────
    //
    // This used to say the account might not be kept, because storage in a
    // webview is partitioned and can vanish. That is still true of the
    // STORAGE and no longer true of the ACCOUNT: an account belongs to a
    // verified phone number now, so signing in anywhere brings it back.
    //
    // Which turns this card from a warning into an offer. Keep using Num
    // here — it works — and put it on the home screen when you want it one
    // tap away. Saying "may not be kept" now would be frightening someone
    // about a problem that has been fixed.
    body: `Num works fine in here. To keep it one tap away, open it in your own browser — your account travels with your number either way.`,
    steps: isIos(ua)
      ? ['Tap the ⋯ or Share icon in this bar', 'Choose “Open in Safari”', 'Then add Num to your home screen']
      : ['Tap the ⋮ menu in this bar', 'Choose “Open in Chrome” or “Open in browser”', 'Then add Num to your home screen'],
  };
}
