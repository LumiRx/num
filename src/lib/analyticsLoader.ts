/**
 * Load the analytics script and the web tracker from the right origin.
 *
 * These used to be two bare tags in index.html:
 *
 *     <script defer src="/api/analytics.js"></script>
 *     <script defer src="/num-track.js"></script>
 *
 * On the web that is correct. In the bundled iOS/Android app it is not: the
 * web view origin is `capacitor://localhost`, so both paths resolve against
 * the LOCAL BUNDLE. `/api/analytics.js` 404s, and `/num-track.js` loads a
 * stale copy from whenever the binary was cut rather than the current one.
 * That is the same failure `src/lib/apibase.ts` exists to prevent — it just
 * could not reach these two, because static HTML never passes through
 * `apiUrl()`.
 *
 * It also silenced a real Vite warning: a non-module script with an absolute
 * path cannot be bundled, so the build told us about this every time and
 * nobody read it.
 *
 * Injected rather than imported so a blocked or failing analytics endpoint can
 * never delay or break first paint — this is measurement, and measurement does
 * not get to take the product down with it.
 */
import { apiUrl } from './apibase';

const inject = (src: string): void => {
  const s = document.createElement('script');
  s.src = src;
  s.defer = true;
  // A tracker that fails is a gap in a chart. A tracker that throws is a bug
  // report from a guest. Swallow it and carry on.
  s.onerror = () => console.warn('[analytics] could not load', src);
  document.head.appendChild(s);
};

export function loadAnalytics(): void {
  try {
    inject(apiUrl('/api/analytics.js'));
    inject(apiUrl('/num-track.js'));
  } catch (err) {
    console.warn('[analytics] loader failed', err);
  }
}
