import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { loadAnalytics } from './lib/analyticsLoader';
import './styles/ds.css';
import './styles/app.css';
import './styles/glass.css';
// Loaded last: a theme is nothing but token overrides on top of everything else.
import './styles/themes.css';

// Measurement is injected, never blocking — see lib/analyticsLoader.ts.
loadAnalytics();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Installed-app behaviour: instant launch from cache, usable without a
// connection (the scripted demo runs offline; Num's live replies need network).
// Production only — a service worker caching a dev server just confuses HMR.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
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
if (import.meta.env.PROD) {
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
