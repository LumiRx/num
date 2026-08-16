/**
 * Where `/api/...` actually lives.
 *
 * ── THE BUG THIS EXISTS TO FIX ───────────────────────────────────────────
 *
 * 15 Aug 2026, first TestFlight build. Signing up with a phone number failed
 * with `undefined is not an object (evaluating 'r.mr.name')` and the app was
 * unusable — you could not get past the first screen.
 *
 * The cause was not in the signup code. `capacitor.config.ts` bundles `dist/`
 * rather than pointing at a remote URL — deliberately, because a thin remote
 * shell is where App Review 4.2 sends you home. Its comment says the bundled
 * app "talks to the same /api/* the web app does". Nothing made that true.
 *
 * On iOS the web view's origin is `capacitor://localhost`. A relative
 * `fetch('/api/social/me')` therefore resolves against the LOCAL BUNDLE, the
 * SPA fallback returns `index.html` with **status 200**, and the caller's
 * `res.json().catch(() => ({}))` turns that HTML into an empty object. The
 * signup handler then reads `out.me.name` on `undefined`, and a network
 * misconfiguration surfaces as a property error two frames away from its
 * cause.
 *
 * All 39 `/api/...` calls in the app had this problem. Signup was simply the
 * first one a user reaches.
 *
 * ── WHY A HELPER AND NOT A BASE TAG OR A CONFIG URL ──────────────────────
 *
 * `server.url` in the Capacitor config would fix it by making the app a
 * remote shell — and would reintroduce exactly the 4.2 risk the bundling
 * decision was taken to avoid. A `<base>` tag would also rewrite asset paths,
 * which must stay local. So the rewrite happens per-request, at the only
 * place that knows the difference: here.
 *
 * On the web this returns the path unchanged, so nothing about the browser
 * build changes — same-origin, same cookies, same relative URLs as before.
 */

// ONE definition of "are we native", not two.
//
// This file had its own copy of the Capacitor check, and on the first
// TestFlight build that check returned false — the bridge was not answering.
// Two independent notions of the same fact means one of them is wrong and
// nobody notices, so this now defers to lib/native.ts, which corroborates the
// bridge with the window origin (`capacitor://localhost`). See the long note
// there for why the origin is the more reliable of the two witnesses.
import { isNativeApp } from './native';

/**
 * The origin the native app talks to.
 *
 * Hard-coded rather than configurable: this is a shipped binary and a wrong
 * value here is a dead app that only a store update can fix, so it should not
 * be reachable by anything at runtime. `VITE_API_ORIGIN` exists for staging
 * builds and is baked in at build time, never read from the network.
 */
export const API_ORIGIN =
  (import.meta.env?.VITE_API_ORIGIN as string | undefined) || 'https://app.itsnum.com';

/**
 * Resolve an app path to something fetchable from wherever we are running.
 *
 *   web    → '/api/social/me'                      (unchanged, same origin)
 *   native → 'https://app.itsnum.com/api/social/me'
 *
 * Anything already absolute is returned untouched, so callers that already
 * know their destination — Stripe, a partner, a signed URL — are unaffected.
 */
export function apiUrl(path: string): string {
  const p = String(path ?? '');
  if (/^https?:\/\//i.test(p)) return p;
  if (!isNativeApp()) return p;
  return API_ORIGIN.replace(/\/+$/, '') + (p.startsWith('/') ? p : `/${p}`);
}
