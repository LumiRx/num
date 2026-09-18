// A venue bill opened in the app.
//
// The QR on the table is itsnum.com/p/<token>. Its last card — "Pay in the
// NUM app" — lands on app.itsnum.com/pay/<token>. This module reads that
// path, asks the server which rails THIS bill may be paid by, and hands each
// tap to the URL the server gave it. Nothing here decides what a guest may
// pay with: worker/payrails.mjs does, once, for every surface.
import { store } from './store';
import { apiUrl } from './apibase';
import { guestMessage } from './saferr';

export interface BillRail {
  id: string;
  label: string;
  family: 'wallet' | 'card' | 'bank' | 'crypto' | 'venue' | 'app';
  source: 'stripe' | 'venue' | 'app';
  how: string;
  action: string;
  ready: boolean;
  disputes?: boolean;
}

export interface BillView {
  bill: {
    token: string; venue: string; label: string | null; amount: string | null; currency: string;
    state: 'open' | 'paid' | 'revoked' | string; fixed: boolean; settled_at: string | null;
  };
  venue: { id: string; name: string; country: string | null };
  rails: BillRail[];
}

/** app.itsnum.com/pay/<TOKEN> → open the sheet; the path is then tidied away. */
export function bootBill(): void {
  const m = window.location.pathname.match(/^\/pay\/([A-Za-z0-9]{4,40})\/?$/);
  const q = new URLSearchParams(window.location.search).get('bill');
  const token = (m?.[1] ?? q ?? '').toUpperCase();
  if (!token) return;
  history.replaceState(null, '', '/');
  store.set({ billOpen: token });
}

/** Signed in or not, the same list — `in=1` only hides the "open the app" card, which is where we are. */
export async function loadBill(token: string): Promise<{ ok: true; view: BillView } | { ok: false; error: string; status: number }> {
  try {
    const r = await fetch(apiUrl(`/api/bill/${encodeURIComponent(token)}?in=1`), { headers: { accept: 'application/json' } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, status: r.status, error: guestMessage(new Error(String(body?.error ?? '')), 'Could not read this bill just now — try again, or ask staff.', 'bill') };
    }
    return { ok: true, view: body as BillView };
  } catch (e) {
    return { ok: false, status: 0, error: guestMessage(e, 'You seem to be offline — the venue can take payment their usual way.', 'bill') };
  }
}

/**
 * Start a rail. A Stripe rail is a hop to Stripe's hosted page on the venue's
 * account (the browser goes there and comes back to /p/<token>?paid=1); a venue
 * rail is the pay page's own single-rail view. Either way it is a navigation,
 * not a fetch — the card never touches this app.
 */
export function startRail(rail: BillRail): void {
  window.location.assign(rail.action);
}
