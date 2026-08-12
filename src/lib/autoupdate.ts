/**
 * The app updates itself. Nobody reinstalls Num to get a fix.
 *
 * 11 Aug 2026: replies were fixed on the server and Dre's installed app still
 * showed "we've dropped the line", because the phone was running JavaScript
 * from days earlier. The only update check in the whole product lived inside
 * ProfileView — a screen most guests never open — so the banner that says a
 * new version exists was, in practice, unreachable. A guest's fix arrived
 * whenever they happened to visit their profile, or never.
 *
 * WHAT THIS DOES
 *
 * Three triggers, one outcome: ask the service worker to look for a new
 * worker, and when the server reports a version we are not running, reload
 * once so the new bundle takes over.
 *
 *   · on boot          — the common case, a cold launch after a deploy
 *   · on foreground    — an installed app is rarely killed; it is backgrounded
 *   · every 15 minutes — for the tab somebody leaves open all week
 *
 * WHY A RELOAD IS SAFE HERE, AND WHY IT IS GUARDED
 *
 * The service worker already calls skipWaiting() on install and clients.claim()
 * on activate, so a new worker takes control immediately — but the PAGE keeps
 * running the old JavaScript until it navigates. location.reload() is what
 * turns "new worker installed" into "guest is running the fix".
 *
 * The danger is a reload loop: reload → still stale → reload. Two guards.
 * First, we only reload when the SERVER's version differs from the one baked
 * into this bundle, so a reload that fails to change anything cannot re-arm.
 * Second, a sessionStorage stamp means at most one automatic reload per
 * session, so even a genuinely stuck deploy costs one refresh, not a spin.
 *
 * WHAT IT WILL NOT DO
 *
 * It never reloads while the guest is mid-conversation — `busy()` lets the
 * caller veto. Losing a half-typed question to a background update would be a
 * worse bug than the one this fixes.
 */
import { VERSION } from './version';

const RELOADED = 'num_autoupdate_reloaded';
const EVERY_MS = 15 * 60 * 1000;

/** Ask the browser for a newer service worker. Cheap, silent, safe to repeat. */
async function nudgeWorker(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch {
    /* an update check that fails is not worth a guest's attention */
  }
}

/**
 * @returns the server version when it differs from ours, else null.
 * `cache: 'no-store'` because asking the browser's cache what the server is
 * running defeats the entire point.
 */
async function serverVersion(): Promise<string | null> {
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    if (!res.ok) return null;
    const { version } = (await res.json()) as { version?: string };
    return version && version !== VERSION ? version : null;
  } catch {
    return null;
  }
}

export type AutoUpdateOptions = {
  /** Return true to postpone — mid-conversation, mid-payment, mid-anything. */
  busy?: () => boolean;
  /** Called instead of reloading, when a caller wants to prompt rather than act. */
  onStale?: (serverVersion: string) => void;
};

export function startAutoUpdate({ busy, onStale }: AutoUpdateOptions = {}): () => void {
  let stopped = false;

  const check = async () => {
    if (stopped) return;
    await nudgeWorker();
    const stale = await serverVersion();
    if (!stale || stopped) return;

    if (onStale) { onStale(stale); return; }
    if (busy?.()) return;                       // never interrupt a guest mid-turn
    if (sessionStorage.getItem(RELOADED) === stale) return; // one reload per version, per session
    try { sessionStorage.setItem(RELOADED, stale); } catch { /* private mode */ }
    location.reload();
  };

  // Boot. Deferred a beat so it never competes with first paint.
  const bootTimer = setTimeout(() => void check(), 2500);
  const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
  document.addEventListener('visibilitychange', onVisible);
  const poll = setInterval(() => void check(), EVERY_MS);

  return () => {
    stopped = true;
    clearTimeout(bootTimer);
    clearInterval(poll);
    document.removeEventListener('visibilitychange', onVisible);
    // The interval is cleared, but a check already in flight resolves against
    // `stopped` above rather than reloading a page that is being torn down.
  };
}
