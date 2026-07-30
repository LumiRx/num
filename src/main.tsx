import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/ds.css';
import './styles/app.css';
import './styles/glass.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Installed-app behaviour: instant launch from cache, usable without a
// connection (the scripted demo runs offline; Num's live replies need network).
// Production only — a service worker caching a dev server just confuses HMR.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Registration failures are never fatal — the app works without it.
    });
  });
}
