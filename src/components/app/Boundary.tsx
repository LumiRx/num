/**
 * The last thing standing between a render error and a black screen.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * There was no error boundary anywhere in Num. React's behaviour without one
 * is not "the broken bit disappears" — it is `unmountComponentAtNode` on the
 * WHOLE tree. One thrown render, anywhere, and `#root` is empty. The body
 * keeps whatever background it had, or none, and the person is looking at a
 * blank rectangle with no button, no message and no way back. Reported from
 * Instagram's in-app browser on 2 Sep 2026, which is exactly where it would
 * happen first: an unfamiliar webview, older Safari, storage partitioned or
 * throwing, and a service worker that may be serving a bundle from before the
 * fix that would have helped.
 *
 * ── THE RULES THIS FILE FOLLOWS ──────────────────────────────────────────
 *
 * 1. **No design tokens.** Every colour here is a literal. This card renders
 *    when the app is broken, and the app's stylesheet may be part of what is
 *    broken. `var(--color-bg)` resolving to nothing is how a recovery screen
 *    becomes a second black screen.
 * 2. **No app imports.** Not the store, not the theme, not a shared button.
 *    Anything imported here is code that can throw here.
 * 3. **Every side effect is wrapped.** Reporting, clipboard, cache clearing —
 *    an exception inside an error handler is an error nobody ever sees.
 *
 * ── WHY "RELOAD" IS NOT ENOUGH ───────────────────────────────────────────
 *
 * Num installs a service worker, so a plain reload can be served the exact
 * bundle that just crashed, forever. The recovery button unregisters the
 * worker and clears its caches first. That is the difference between a reload
 * that helps and one that reproduces the bug at speed.
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { err: Error | null; copied: boolean };

/**
 * Where the crash report goes.
 *
 * A literal, not an import. Rule 2 says no app imports and `apiUrl()` reaches
 * for the Capacitor bridge, which is one more thing that can throw inside an
 * error handler. Same value as API_ORIGIN in src/lib/apibase.ts — boundary.
 * test.mjs holds the two to each other so they cannot drift.
 *
 * Sent absolute rather than same-origin because the App Store build runs on
 * `capacitor://localhost`, where a relative '/api/crash' goes nowhere. On the
 * web the browser resolves it to the same host it is already on.
 */
const CRASH_ENDPOINT = 'https://app.itsnum.com/api/crash';

/**
 * Fire-and-forget, and never throws — see rule 3.
 *
 * ── WHY IT POSTS SOMEWHERE WE CAN READ ───────────────────────────────────
 * This used to call gtag and stop. gtag is analytics: we cannot query it from
 * a terminal, which meant the entire evidence for a real crash on Dre's phone
 * on 12 Sep 2026 was the sentence "it said num stopped working" — the heading
 * below, read back by a person. Fixing that meant guessing which component
 * threw, shipping the guess, and asking him to try again.
 *
 * So the report also goes to our own Worker, which stores the message, the
 * component stack and the phone. What it deliberately does NOT send is the
 * query string: a connect code and a payment amount both live there and
 * neither helps fix a render bug. See worker/crashlog.mjs.
 */
function report(err: Error, info?: ErrorInfo) {
  try {
    const g = (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag;
    if (g) {
      g('event', 'app_crash', {
        message: String(err?.message ?? err).slice(0, 200),
        // Which surface it died on matters more than the stack: the same
        // build works in Safari and blanks in a webview.
        ua: String(navigator.userAgent || '').slice(0, 200),
      });
    }
  } catch { /* measurement is never worth a second exception */ }

  try {
    const body = JSON.stringify({
      message: String(err?.message ?? err).slice(0, 300),
      stack: String(err?.stack ?? '').slice(0, 1200),
      component: String(info?.componentStack ?? '').slice(0, 900),
      // Path only. The query is dropped here as well as on the server, so a
      // connect code never leaves the device even if the route changes.
      path: String(location.pathname || '/').slice(0, 120),
      surface:
        (window as unknown as { Capacitor?: unknown }).Capacitor ? 'native'
          : window.matchMedia?.('(display-mode: standalone)').matches ? 'installed'
            : 'browser',
    });
    // keepalive so the report survives the reload the person is about to do;
    // `.catch` because an offline phone must not throw inside a catch block.
    void fetch(CRASH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
      mode: 'cors',
    }).catch(() => {});
  } catch { /* a report that cannot be built is not worth a second crash */ }

  try {
    console.error('[num] render crashed', err, info?.componentStack);
  } catch { /* no console in some webviews */ }
}

export default class Boundary extends Component<Props, State> {
  state: State = { err: null, copied: false };

  static getDerivedStateFromError(err: Error): Partial<State> {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    report(err, info);
  }

  /** Unregister the worker and drop its caches, THEN reload. */
  private recover = async () => {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
      }
    } catch { /* nothing to unregister */ }
    try {
      if (typeof caches !== 'undefined') {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
      }
    } catch { /* no cache API in this webview */ }
    try {
      // Cache-busted so no layer between here and the origin can hand back
      // the bundle that just crashed.
      location.replace(location.pathname + '?fresh=' + Date.now());
    } catch {
      location.reload();
    }
  };

  private copy = () => {
    const text = `Num crashed\n${String(this.state.err?.message ?? this.state.err)}\n${navigator.userAgent}`;
    const done = () => this.setState({ copied: true });
    try {
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(text).then(done, done);
      } else {
        done();
      }
    } catch { done(); }
  };

  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          position: 'fixed', inset: 0, zIndex: 2147483647,
          // Literal, not a token. See rule 1.
          background: '#faf7f4', color: '#201e1d',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '24px', boxSizing: 'border-box',
          font: '16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          WebkitFontSmoothing: 'antialiased',
        }}
      >
        <div style={{ maxWidth: 380, width: '100%', textAlign: 'left' }}>
          <div style={{ fontSize: 11, letterSpacing: '.14em', fontWeight: 800, color: '#ec3013' }}>
            NUM
          </div>
          <h1 style={{ fontSize: 22, lineHeight: 1.25, margin: '10px 0 8px', fontWeight: 700 }}>
            Num stopped short.
          </h1>
          <p style={{ margin: '0 0 20px', fontSize: 15, color: '#5b5754' }}>
            Something in the app broke while drawing this screen. Nothing you
            did caused it and nothing you saved is lost.
          </p>
          <button
            type="button"
            onClick={this.recover}
            style={{
              width: '100%', border: 'none', cursor: 'pointer',
              background: '#ec3013', color: '#fff', fontWeight: 700, fontSize: 16,
              padding: '15px 20px', borderRadius: 999, fontFamily: 'inherit',
            }}
          >
            Reload Num
          </button>
          <button
            type="button"
            onClick={this.copy}
            style={{
              width: '100%', marginTop: 10, cursor: 'pointer',
              background: '#fff', color: '#201e1d', border: '1px solid #e3ddd7',
              fontWeight: 600, fontSize: 15, padding: '13px 20px', borderRadius: 999,
              fontFamily: 'inherit',
            }}
          >
            {this.state.copied ? 'Copied — send it to info@itsnum.com' : 'Copy what went wrong'}
          </button>
          <p style={{ margin: '18px 0 0', fontSize: 13, color: '#8a827c' }}>
            Still stuck? Num also answers on{' '}
            <a href="https://line.me/R/ti/p/@799pyrus" style={{ color: '#ec3013' }}>LINE</a>.
          </p>
        </div>
      </div>
    );
  }
}
