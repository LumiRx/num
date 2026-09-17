import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import Boundary from './components/app/Boundary';
import { loadAnalytics } from './lib/analyticsLoader';
import { isNativeApp, nativePlatform } from './lib/native';
import { apiUrl } from './lib/apibase';
import { VERSION } from './lib/version';
import './styles/ds.css';
import './styles/app.css';
import './styles/glass.css';
// Loaded last: a theme is nothing but token overrides on top of everything else.
import './styles/themes.css';

// Measurement is injected, never blocking — see lib/analyticsLoader.ts.
// NUM's own tracker everywhere; the third-party pair (Cloudflare Insights,
// Google Analytics) on the web only. Inside the App Store build they would
// need an App Tracking Transparency prompt in front of them — guideline
// 5.1.2 — and a page-view counter is not worth asking a guest for that.
loadAnalytics({ thirdParty: !isNativeApp() });

// ── A CRASH THAT NOBODY HEARS ────────────────────────────────────────────
//
// Boundary catches errors thrown while RENDERING. It cannot see a failed
// promise, a broken event handler, or a script that died before React
// mounted — and those blank a page just as effectively in an unfamiliar
// webview. On 2 Sep 2026 the app went black inside Instagram and there was
// no record anywhere of what threw, which is the part that made it a guess
// rather than a fix.
//
// Reporting only. Never swallows, never changes behaviour, never throws:
// an error handler that can itself fail is worse than none.
for (const [type, read] of [
  ['error', (e: unknown) => (e as ErrorEvent)?.message],
  ['unhandledrejection', (e: unknown) => String((e as PromiseRejectionEvent)?.reason ?? '')],
] as const) {
  window.addEventListener(type, (e: Event) => {
    const message = String(read(e) ?? '').slice(0, 200);
    try {
      const g = (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag;
      g?.('event', 'app_error', {
        kind: type,
        message,
        ua: String(navigator.userAgent || '').slice(0, 200),
      });
    } catch { /* never a second failure */ }
    // ── AND TO OUR OWN ENDPOINT, WHICH IS THE ONLY ONE THE APP HAS ────────
    //
    // gtag is the third-party analytics global, and as of 13 Sep 2026 it is
    // not loaded in the App Store build at all — so on the one platform where
    // a launch failure costs a review cycle, the line above reports nothing.
    //
    // /api/crash is NUM's own: open, always answers 200, hashes the device,
    // and folds a crash loop onto one row with a count. It is exactly what
    // was missing when Apple said "the app crashed after the initial launch"
    // and there was no record on our side of what threw.
    try {
      if (!message) return;
      void fetch(apiUrl('/api/crash'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          message,
          kind: type,
          path: location.pathname,
          build: VERSION,
          surface: isNativeApp() ? nativePlatform() : 'web',
        }),
      }).catch(() => { /* an error report that fails is not a second error */ });
    } catch { /* never a second failure */ }
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Outside App on purpose: a boundary inside the tree it is protecting
        cannot catch an error thrown while that tree is being created. */}
    <Boundary>
      <App />
    </Boundary>
  </React.StrictMode>,
);

/* ── 13 SEP 2026: NEITHER OF THE TWO BLOCKS BELOW MAY RUN IN THE APP ──────
   App Review rejected iOS 1.0 build 6 under 2.1.0: "The app crashed after the
   initial launch."

   Both of these were written for the WEB app, where they are right, and both
   were gated on `import.meta.env.PROD` alone — which is true in the App Store
   build too. Read what they do to a binary whose bundle came from the App
   Store:

   THE AUTO-UPDATER. 2.5 seconds after launch it asks the server what version
   it is running and reloads the page if the answer differs from the version
   baked into this bundle. In the App Store build those two numbers can never
   agree again: the bundle is frozen at archive time and the Worker is
   redeployed several times a day. The server said 0.8.291 while I was
   looking. So the app launches, waits two and a half seconds, and reloads
   itself — every single time, on a bundle that a reload cannot possibly
   change. One reload is a flash of blank screen. If sessionStorage is
   unavailable in the web view — and the guard silently catches that case —
   the reload has nothing stopping it and repeats on every foreground.

   That is what "crashed after the initial launch" looks like from the
   outside.

   THE SERVICE WORKER. The bundle ships inside the IPA; there is nothing to
   cache it for. What it can do is serve a stale index.html from a previous
   build over the real one, whose hashed asset filenames no longer exist —
   a white screen with no error.

   `isNativeApp()` is the same one answer the rest of the app uses, and it has
   two independent witnesses (the Capacitor bridge, and the capacitor://
   origin) precisely so an early-boot check like this one cannot be wrong
   because the bridge had not injected yet.
   ──────────────────────────────────────────────────────────────────────── */
const web = !isNativeApp();

// Installed-app behaviour: instant launch from cache, usable without a
// connection (the scripted demo runs offline; NUM's live replies need network).
// Production only — a service worker caching a dev server just confuses HMR.
if (web && 'serviceWorker' in navigator && import.meta.env.PROD) {
  // A tab that has been open across a deploy gets the new worker on its next
  // foreground, not on its next cold start.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void navigator.serviceWorker.getRegistration().then((r) => r?.update());
  });
  window.addEventListener('load', () => {
    // updateViaCache:'none' — never let the browser serve a cached copy of the
    // worker script itself, or a fix to the worker can never ship.
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {
      // Registration failures are never fatal — the app works without it.
    });
  });
}

// Ship a fix and every phone has it. Registering a worker only means the NEXT
// worker installs; the page keeps running the old bundle until it navigates,
// which is why a server-side fix on 11 Aug did not reach an installed app at
// all. startAutoUpdate closes that gap — and refuses to interrupt a guest who
// is mid-question, because losing a half-typed ask is worse than being a
// version behind for another minute.
if (web && import.meta.env.PROD) {
  void import('./lib/autoupdate').then(({ startAutoUpdate }) => {
    startAutoUpdate({
      busy: () => {
        const el = document.activeElement as HTMLElement | null;
        const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
        // `data-num-busy` is set by the concierge while a reply is in flight.
        return typing || document.body.dataset.numBusy === '1';
      },
    });
  });
}
