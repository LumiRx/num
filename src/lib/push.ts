// Turning on notifications, from the app's side.
//
// The rule that decides whether this works at all: **iOS only allows push for
// an app that has been added to the home screen**, and only asks once. Ask at
// the wrong moment and the answer is no, permanently. So Num never asks on
// launch — it asks when there is something worth being told about.
import { store } from './store';

// Not a secret: the browser needs it to encrypt the subscription to us.
const VAPID_PUBLIC = 'BGfIJ2Yj82iiRSVBUi97G8nmxi9WT6uWxgqApr0EqEzrhiu0FSnD7hnnONE0qHgO72cvIwb3JaqDfSAOJs3St1U';

const toBytes = (b64: string) => {
  const pad = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
};

export const pushSupported = (): boolean => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** iOS gives an installed PWA push; a Safari tab gets nothing, silently. */
export const installedOnHomeScreen = (): boolean =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

export const pushState = (): 'unsupported' | 'needs-install' | 'default' | 'granted' | 'denied' => {
  if (!pushSupported()) return 'unsupported';
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (ios && !installedOnHomeScreen()) return 'needs-install';
  return Notification.permission as 'default' | 'granted' | 'denied';
};

/**
 * Ask, then register. Only call this from a real tap — browsers reject a
 * permission prompt that did not come from a gesture, and iOS remembers a
 * refusal forever.
 */
export async function enablePush(): Promise<{ ok: boolean; message: string }> {
  const me = store.get().me;
  if (!me) return { ok: false, message: 'Add your name first — a notification has to know who it is for.' };
  if (!pushSupported()) return { ok: false, message: 'This browser can’t do notifications.' };
  if (pushState() === 'needs-install') {
    return { ok: false, message: 'Add Num to your home screen first — iPhone only allows notifications for installed apps.' };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, message: 'No notifications then — you can turn them on any time.' };

  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(VAPID_PUBLIC) }));

  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ me: me.id, subscription: sub.toJSON() }),
  });
  if (!res.ok) return { ok: false, message: 'Couldn’t register that — try again in a moment.' };

  store.set({ pushOn: true });
  return { ok: true, message: 'Done — I’ll only interrupt you when it’s worth it.' };
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  store.set({ pushOn: false });
}

/**
 * The service worker has no localStorage, so when a push wakes it, it asks the
 * page who is signed in. This answers.
 */
export function serveIdentityToWorker(): void {
  navigator.serviceWorker?.addEventListener('message', (event) => {
    const data = event.data as { type?: string; url?: string };
    if (data?.type === 'num-who') {
      event.ports?.[0]?.postMessage({ me: store.get().me?.id ?? null });
    }
    if (data?.type === 'num-open') {
      // A tapped notification should land on the thing it was about.
      store.set({ threadOpen: true });
    }
  });
}
