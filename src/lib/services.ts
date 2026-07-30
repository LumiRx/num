// Getting the thing actually done — cars, food, tables, treatments — plus the
// share paths that put an invite on someone's phone.
//
// Num holds no commercial accounts with Uber, Grab, DoorDash and the rest yet,
// so for now every fulfilment is a HAND-OFF: one tap into the app the user
// already has, prefilled with the destination. The server picks the providers
// by country (worker/services.mjs) and sends them down with the action, so the
// model can never name a service that doesn't operate where the user is
// standing, or invent a URL.
import { store } from './store';
import type { ServiceHandoff, ServiceOption } from './types';

/** Show the provider tray under the thread. */
export function offerService(h: ServiceHandoff): void {
  store.set({ handoff: h });
}

export const dismissService = (): void => store.set({ handoff: null });

/**
 * Open a provider. Try the app's own scheme first where we have one — it lands
 * inside the installed app rather than a web page asking you to install it —
 * and fall back to the universal link if nothing handles the scheme.
 */
export function openService(o: ServiceOption): void {
  if (o.app) {
    const t = setTimeout(() => window.open(o.url, '_blank', 'noopener'), 700);
    // If the scheme resolves, the page is backgrounded and the timer is moot;
    // clearing on blur stops a stray tab opening behind the app.
    const cancel = () => {
      clearTimeout(t);
      window.removeEventListener('blur', cancel);
    };
    window.addEventListener('blur', cancel);
    window.location.href = o.app;
    return;
  }
  window.open(o.url, '_blank', 'noopener');
}

export const KIND_LABEL: Record<ServiceHandoff['kind'], string> = {
  ride: 'Get the car',
  food: 'Order it',
  table: 'Book the table',
  wellness: 'Book it',
  // Travel is a price comparison, not a purchase — the label has to say so, or
  // a tap feels like it should have booked something.
  flight: 'Compare the fares',
  hotel: 'Compare the rooms',
  rail: 'Compare the trains',
};

// ── sharing ────────────────────────────────────────────────────────────────

export interface Shareable {
  title: string;
  text: string;
  url: string;
}

/** True when the OS share sheet is available — iOS/Android, and Safari/Edge. */
export const canShare = (): boolean => typeof (navigator as Navigator & { share?: unknown }).share === 'function';

/**
 * The native share sheet: AirDrop, Messages, WhatsApp, Signal, Instagram,
 * whatever they actually use. Falls back to the clipboard so the button always
 * does something.
 */
export async function shareNative(s: Shareable): Promise<'shared' | 'copied' | 'none'> {
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (nav.share) {
    try {
      await nav.share({ title: s.title, text: s.text, url: s.url });
      return 'shared';
    } catch {
      /* dismissed — fall through to copy rather than doing nothing */
    }
  }
  try {
    await navigator.clipboard.writeText(`${s.text}${s.text.includes(s.url) ? '' : ' ' + s.url}`);
    return 'copied';
  } catch {
    return 'none';
  }
}

/**
 * A `sms:` link that works on both platforms. iOS wants `&body=`, everything
 * else wants `?body=`, and getting it wrong silently drops the message — which
 * is why this is one function and not sprinkled through the components.
 */
export function smsLink(phone: string | null | undefined, body: string): string {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return `sms:${phone ?? ''}${ios ? '&' : '?'}body=${encodeURIComponent(body)}`;
}

export const whatsappLink = (phone: string | null | undefined, body: string): string =>
  `https://wa.me/${phone ? phone.replace(/\D/g, '') : ''}?text=${encodeURIComponent(body)}`;
