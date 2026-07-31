import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/ds.css';
import './styles/app.css';
import './styles/glass.css';
// Loaded last: a theme is nothing but token overrides on top of everything else.
import './styles/themes.css';

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
