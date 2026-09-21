/**
 * Is this request from the iOS app? And if so, what may it not do?
 *
 * ── WHY THE SERVER ASKS, NOT ONLY THE CLIENT ────────────────────────────
 *
 * App Review rejected 1.0 (12) on 21 Sep 2026 under 3.1.1, twice:
 *
 *   "The stars can be purchased in the app using payment mechanisms other
 *    than In-App Purchase."
 *   "The app uses code to unlock or enable content."
 *
 * Every sales surface in the iOS bundle was already behind
 * canOfferSubscription() in src/lib/native.ts. That is one gate, in one
 * binary, which cannot be changed without another review cycle — and the
 * server behind it was still willing to mint a Stars checkout, sell a plan,
 * list a prize draw and accept its entry code for anyone who asked. A client
 * gate says "we do not show it"; only the server can say "it cannot happen".
 *
 * So this is the second, independent wall. Binaries already in Apple's hands
 * are covered by it the moment the worker ships, with no new build.
 *
 * ── HOW IT KNOWS ──────────────────────────────────────────────────────────
 *
 * The bundled app serves itself from `capacitor://localhost`, and WKWebView
 * sends that as the Origin on every cross-origin fetch to app.itsnum.com. No
 * browser on any device is ever on that origin (see nativeOrigin() in
 * src/lib/native.ts for the same reasoning on the client). `X-Num-Platform:
 * ios` is accepted too, for builds that send it explicitly.
 *
 * Android (`https://localhost`) is deliberately NOT matched: Play permits the
 * link-out, and canOfferSubscription() allows it there.
 *
 * What stays open on iOS, because 3.1.5 exempts it: paying a real venue's
 * bill, a booking, a tab between people, a bounty for a real-world errand.
 * Stars already held keep working for those. What closes: BUYING Stars,
 * buying a plan, spending Stars on a plan, and any code that enters or
 * unlocks anything.
 */

const IOS_ORIGINS = new Set(['capacitor://localhost', 'ionic://localhost']);

/** True when the request came from the iOS App Store build. */
export function isIosApp(request) {
  try {
    const h = request?.headers;
    if (!h?.get) return false;
    if (IOS_ORIGINS.has(String(h.get('Origin') ?? '').toLowerCase())) return true;
    return String(h.get('X-Num-Platform') ?? '').toLowerCase() === 'ios';
  } catch {
    return false;
  }
}

/** Payment refs that are a SALE of digital content — never from iOS. */
export function isDigitalSaleRef(ref) {
  return /^(stars|tier):/i.test(String(ref ?? ''));
}

/** The one refusal, worded the same everywhere so the app can show it as-is. */
export const IOS_NO_SALE = Object.freeze({
  ok: false,
  error: 'ios_no_sale',
  says: 'Stars and plans are not sold in the iOS app. Stars you already have still settle bills, tabs and errands.',
});
