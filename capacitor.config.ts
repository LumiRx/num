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
    contentInset: 'automatic',
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
