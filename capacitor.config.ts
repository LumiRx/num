import type { CapacitorConfig } from '@capacitor/cli';

/**
 * One repo, three surfaces: the web app, iOS, Android — same dist/ bundle.
 *
 * The BUNDLED strategy on purpose, not a remote-URL shell: Apple's 4.2
 * "minimum functionality" bar is where thin web wrappers die in review, and
 * a shell that loads app.itsnum.com remotely is the thinnest wrapper there
 * is. Bundling dist/ means the app opens instantly with no network, talks to
 * the same /api/* the web app does, and review sees a real application.
 *
 * appId is the permanent identity of the app in both stores — it can NEVER
 * change after first release. com.itsnum.app, owned by 5arz (Lumi stays out
 * of anything public, per §8).
 */
const config: CapacitorConfig = {
  appId: 'com.itsnum.app',
  appName: 'Num',
  webDir: 'dist',
  backgroundColor: '#faf7f2',
  server: {
    // API calls from the bundled app go to production. The bundle carries the
    // UI; the truth stays server-side, same as the web.
    androidScheme: 'https',
  },
  ios: {
    // 'never', NOT 'automatic'.
    //
    // 'automatic' hands the safe area to WKWebView's scroll view, which then
    // insets and auto-scrolls the whole document to clear the notch. We ALSO
    // pay for the safe area ourselves — the header pads by
    // max(env(safe-area-inset-top), 16px) and the sheets pad by
    // env(safe-area-inset-bottom), because index.html asks for
    // viewport-fit=cover. Both compensations land at once: the top of the app
    // is pushed under the status bar and the first line of any open sheet is
    // clipped. That is the "spacing" bug, and it only appears on device,
    // which is why it survived every browser check.
    //
    // 'never' makes the web view the single source of truth for layout: the
    // content starts at the true top edge, env(safe-area-inset-*) reports the
    // real insets, and our CSS is the only thing moving anything.
    contentInset: 'never',
    // The document never scrolls — the shell is exactly one viewport tall and
    // every scrolling region inside it is its own overflow container. Leaving
    // native scroll on lets iOS scroll the WHOLE page up to reveal a focused
    // input, which drags the header off the top of the screen and cannot be
    // scrolled back because the page has no extra height to give.
    scrollEnabled: false,
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
