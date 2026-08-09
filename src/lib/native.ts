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

/** True inside the app-store build, false in any browser or PWA. */
export const isNativeApp = (): boolean => Boolean(cap()?.isNativePlatform?.());

/** 'ios' | 'android' | 'web' */
export const nativePlatform = (): 'ios' | 'android' | 'web' =>
  cap()?.getPlatform?.() ?? 'web';

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
      void fetch('/api/push/native', {
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
