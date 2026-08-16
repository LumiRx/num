import { apiUrl } from '../lib/apibase';
/**
 * One question, answered once: is this the web app, or the app-store app?
 *
 * Everything that must differ between the two funnels through here, so the
 * rules live in one file instead of scattered platform sniffs:
 *
 *  - INSTALL PROMPTS: never inside the native app. Asking someone who is
 *    already in the app to "add Num to your home screen" reads as a bug.
 *
 *  - SUBSCRIPTION OFFERS: hidden on iOS native. This is the Netflix model —
 *    Apple's 3.1.1 requires IAP for digital subscriptions sold in-app on
 *    every storefront except the US. An app that sells nothing digital and
 *    merely lets an existing member sign in is compliant EVERYWHERE, today,
 *    with zero commission. Guests subscribe on itsnum.com; the tier follows
 *    the account. Real-world payments — bookings, tabs, bills — are exempt
 *    (3.1.5) and keep working in-app unchanged on every platform.
 *
 *  - PUSH: native platforms register through APNs/FCM instead of web-push.
 *
 * The Capacitor global is injected by the native runtime; its absence IS the
 * web answer, so this file costs the web bundle nothing.
 */

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => 'ios' | 'android' | 'web';
};

const cap = (): CapacitorGlobal | undefined =>
  (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;

/**
 * The native shell's own origin, independent of the bridge.
 *
 * ── WHY THIS SECOND SIGNAL EXISTS ────────────────────────────────────────
 *
 * 15 Aug 2026, first TestFlight build: the "Tap Share, then Add to Home
 * Screen" card — web-only by definition — rendered INSIDE the iOS app. That
 * card only shows when `canOfferInstall()` is true, so `Capacitor` was not
 * answering. Either the bridge had not injected yet or it was not there at
 * all; from the app's point of view the difference does not matter.
 *
 * What did matter is everything downstream. A false negative here does not
 * just show one wrong card: `apiUrl()` stops rewriting and every API call
 * hits the local bundle, and `canOfferSubscription()` returns true so the
 * Star packs and the pricing ladder render on iOS — the exact App Store 3.1.1
 * problem we had just closed. One undetected platform silently reopened three
 * separate bugs.
 *
 * A bundled Capacitor app serves its own files from `capacitor://localhost`
 * (iOS) or `http://localhost` / `https://localhost` (Android). A real browser
 * on a real phone is never on those origins — nobody reaches app.itsnum.com
 * and lands on `localhost`. So the origin is a second, independent witness
 * that cannot be early, cannot fail to inject, and needs no runtime at all.
 *
 * Either signal is enough. Two independent ways to be right beats one way to
 * be silently wrong.
 */
const nativeOrigin = (): boolean => {
  try {
    const { protocol, hostname } = window.location;
    if (protocol === 'capacitor:' || protocol === 'ionic:') return true;
    // localhost over http(s) means the shell is serving the bundle. A dev
    // server is the one other thing on this origin, which is why the
    // Vite-injected DEV flag excludes it.
    return (hostname === 'localhost' || hostname === '127.0.0.1') && !import.meta.env?.DEV;
  } catch {
    return false;
  }
};

/** True inside the app-store build, false in any browser or PWA. */
export const isNativeApp = (): boolean => Boolean(cap()?.isNativePlatform?.()) || nativeOrigin();

/**
 * 'ios' | 'android' | 'web'
 *
 * Falls back to the user agent when the bridge is silent but the origin says
 * native — otherwise a shell whose bridge has not answered reads as 'web' and
 * the iOS purchase gate opens. Guessing 'ios' from an iPhone UA inside a
 * native origin is safe in the direction that matters: the cost of wrongly
 * saying iOS is one hidden upgrade card; the cost of wrongly saying web is an
 * App Store rejection and a false statement in our review notes.
 */
export const nativePlatform = (): 'ios' | 'android' | 'web' => {
  const fromBridge = cap()?.getPlatform?.();
  if (fromBridge) return fromBridge;
  if (!nativeOrigin()) return 'web';
  try {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    if (/Android/i.test(ua)) return 'android';
  } catch { /* fall through */ }
  // Native origin, unknown device: assume the strictest storefront.
  return 'ios';
};

/** Install-to-home-screen UI: web-only by definition. */
export const canOfferInstall = (): boolean => !isNativeApp();

/**
 * May the UI show subscribe/upgrade offers?
 * Web: always. Android native: yes (Play allows alternative billing flows for
 * this category and the link-out is to our own site). iOS native: no — the
 * Netflix model keeps us clean on every storefront without regional forks.
 */
export const canOfferSubscription = (): boolean => nativePlatform() !== 'ios';

/**
 * Register for native push and hand the token to the worker.
 * Fire-and-forget; never blocks UI. The endpoint stores the token per member
 * — server-side APNs/FCM delivery is the follow-up build (worker push today
 * speaks web-push/VAPID, which native shells do not).
 */
export async function registerNativePush(memberId: string | null): Promise<void> {
  if (!isNativeApp()) return;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return;
    PushNotifications.addListener('registration', (token) => {
      void fetch(apiUrl('/api/push/native'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.value, platform: nativePlatform(), me: memberId }),
      }).catch(() => {});
    });
    await PushNotifications.register();
  } catch {
    /* push is an enhancement — its failure is never a launch blocker */
  }
}
