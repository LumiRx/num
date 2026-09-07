/**
 * One place that knows how to send an analytics event.
 *
 * This exists because of a failure worth not repeating. `verifyCode()` used to
 * call `window.gtag?.('event', 'verified_signup')` inline. Optional chaining
 * made it crash-proof and, on a page where gtag had never been installed, also
 * completely invisible — the conversion Google Ads was meant to optimize
 * toward simply did not exist, and the only symptom was an empty dropdown in
 * the Ads UI days later. Nobody notices an event that silently does nothing.
 *
 * Centralising the guard means there is exactly one line to check when asking
 * "are we actually measuring this?", and `worker/analytics.test.mjs` can hold
 * the whole app to the bargain: if the app fires an event, a page must load the
 * library that receives it.
 */

type Params = Record<string, string | number | boolean | undefined>;

/**
 * Send an event. Never throws — analytics failing must never break the thing
 * the person was actually doing.
 */
export function track(event: string, params: Params = {}): void {
  try {
    const g = (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag;
    if (!g) return; // no tag on this page — see the note above
    g('event', event, params);
  } catch {
    /* measurement is never worth an exception in a user's face */
  }
}

/**
 * Send an event at most once per device, ever.
 *
 * Activation events ("they actually used it") are only meaningful the first
 * time. Firing `first_ask` on every message would turn a quality signal into a
 * usage counter, and Google Ads would optimise toward whoever chats most rather
 * than whoever arrives and finds the product useful.
 *
 * localStorage rather than session state on purpose: "first" has to survive a
 * reload, or a refresh mid-onboarding re-fires it and inflates the number the
 * budget is judged by.
 */
export function trackOnce(key: string, event: string, params: Params = {}): void {
  try {
    const k = `num-fired-${key}`;
    if (localStorage.getItem(k)) return;
    localStorage.setItem(k, String(Date.now()));
    track(event, params);
  } catch {
    // Private-mode Safari throws on localStorage. Losing the dedupe is far
    // better than losing the event, so fall through and send it.
    track(event, params);
  }
}

/**
 * The OTHER analytics pipe: `num-track.js` → `POST /api/ev` → `num_web_events`
 * in D1. gtag is what Google Ads optimises toward; this is what the nightly
 * analytics can actually read. Until 2 Sep 2026 the React app called neither
 * `window.numTrack` nor anything like it, so `first_message_sent` — the one
 * event the worker's own comment calls "the only event that means the product
 * was used" — had ZERO call sites, and the 5arz consent ask had no "shown"
 * row, which left the wall metric with a numerator (0 linked) and no
 * denominator for nine consecutive nightly editions.
 *
 * Any name passed here must ALSO be in `KNOWN` (app-public/num-track.js) and
 * `EVENTS` (growth/worker.js), or it dissolves into a 200 {"ignored":true}.
 * `worker/analytics.test.mjs` pins the three lists together.
 */
export function webEvent(event: string, detail?: string): void {
  try {
    const w = window as unknown as { numTrack?: (e: string, extra?: Record<string, string>) => void };
    w.numTrack?.(event, detail ? { detail } : undefined);
  } catch {
    /* never in a user's face */
  }
}

/** `webEvent`, at most once per device — for "shown" and "first" events. */
export function webEventOnce(key: string, event: string, detail?: string): void {
  try {
    const k = `num-webfired-${key}`;
    if (localStorage.getItem(k)) return;
    localStorage.setItem(k, String(Date.now()));
  } catch {
    /* private mode: lose the dedupe, keep the event */
  }
  webEvent(event, detail);
}
