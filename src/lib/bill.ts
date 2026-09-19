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
import { t } from './i18n';

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

export interface BillItem {
  name: string;
  qty: number;
  unit_minor: number;
  line_minor: number;
}

export interface BillView {
  bill: {
    token: string; venue: string; label: string | null; amount: string | null; currency: string;
    /** 'split' means this bill was divided — its shares are the bills now. */
    state: 'open' | 'paid' | 'split' | 'revoked' | string; fixed: boolean; settled_at: string | null;
    /** What was on it. Empty is the normal case: most bills are a total. */
    items?: BillItem[];
    split_parent?: string | null;
  };
  venue: { id: string; name: string; country: string | null };
  rails: BillRail[];
}

export interface BillShare {
  token: string;
  member_id: string | null;
  name: string | null;
  amount: string;
  amount_minor: number;
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
      return { ok: false, status: r.status, error: guestMessage(new Error(String(body?.error ?? '')), t('Could not read this bill just now — try again, or ask staff.'), 'bill') };
    }
    return { ok: true, view: body as BillView };
  } catch (e) {
    return { ok: false, status: 0, error: guestMessage(e, t('You seem to be offline — the venue can take payment their usual way.'), 'bill') };
  }
}

/**
 * Start a rail. A Stripe rail is a hop to Stripe's hosted page on the venue's
 * account (the browser goes there and comes back to /p/<token>?paid=1); a venue
 * rail is the pay page's own single-rail view. Either way it is a navigation,
 * not a fetch — the card never touches this app.
 */
export function startRail(rail: BillRail, meId?: string | null): void {
  // Who is paying, carried to the server so the bill can end up in this
  // member's history. Only on a NUM rail — a venue's own payment page is
  // theirs and gets nothing of ours appended to it.
  if (meId && rail.source === 'stripe') {
    const sep = rail.action.includes('?') ? '&' : '?';
    window.location.assign(`${rail.action}${sep}me=${encodeURIComponent(meId)}`);
    return;
  }
  window.location.assign(rail.action);
}

/**
 * Split this bill between the people on the tab.
 *
 * Each person gets a REAL bill code of their own, for their own share, paid
 * straight to the venue. NUM does not move a penny between anybody — it never
 * can, and this is the only shape of splitting that keeps that true.
 */
export async function splitShares(
  token: string,
  people: Array<{ member_id: string; name?: string | null }>,
  by?: string | null,
): Promise<{ ok: true; shares: BillShare[] } | { ok: false; error: string }> {
  try {
    const r = await fetch(apiUrl(`/api/bill/${encodeURIComponent(token)}/split`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ people, by }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: String((body as { error?: string })?.error ?? 'Could not split that bill.') };
    return { ok: true, shares: (body as { shares: BillShare[] }).shares };
  } catch (e) {
    return { ok: false, error: guestMessage(e, t('Could not split that bill just now.'), 'bill') };
  }
}

export interface PaidBill {
  token: string; venue: string; label: string | null; amount: string; currency: string;
  paid_at: string; via: string | null; share_of: string | null; items: number;
}
export interface PastTab {
  id: string; code: string; title: string; venue: string | null; state: string;
  people: number; stars: number; opened_at: string; closed_at: string | null;
}

/** Everything this member has paid through NUM, and the tabs they were on. */
export async function loadHistory(meId: string): Promise<{ bills: PaidBill[]; tabs: PastTab[] }> {
  try {
    const r = await fetch(apiUrl(`/api/bills?me=${encodeURIComponent(meId)}`), { headers: { accept: 'application/json' } });
    if (!r.ok) return { bills: [], tabs: [] };
    const body = await r.json();
    return { bills: body.bills ?? [], tabs: body.tabs ?? [] };
  } catch {
    // An empty history and a history we could not read look the same to this
    // function on purpose; the screen says "nothing yet" either way rather
    // than showing somebody an error about their own spending.
    return { bills: [], tabs: [] };
  }
}

/**
 * Ask the server to pay this bill without a tap.
 *
 * The app only ASKS. Every guard — opted in, under the member's own cap, same
 * currency, under the daily ceiling, venue connected — lives in
 * worker/autopay.mjs, because a limit the client enforces is not a limit.
 *
 * A refusal is not an error: `tap` means "show them the buttons", which is
 * where a guest already was before any of this existed.
 */
export interface AutoPayResult {
  ok: boolean;
  tap?: boolean;
  why?: 'off' | 'no_card' | 'no_amount' | 'other_currency' | 'over_cap' | 'too_many_today'
    | 'venue_not_connected' | 'needs_authentication' | 'declined' | 'card_unavailable'
    | 'not_completed' | 'not_open' | 'venue_unreadable';
  cap_minor?: number;
}

export async function tryAutoPay(token: string, meId: string): Promise<AutoPayResult> {
  try {
    const r = await fetch(apiUrl(`/api/bill/${encodeURIComponent(token)}/autopay?me=${encodeURIComponent(meId)}`), { method: 'POST' });
    if (!r.ok) return { ok: false, tap: true };
    return (await r.json()) as AutoPayResult;
  } catch {
    return { ok: false, tap: true };
  }
}

/** Why it did not pay, in a sentence rather than a code. */
export function autoPayNote(r: AutoPayResult): string | null {
  switch (r.why) {
    case 'over_cap': return t('Over your auto-pay limit — pay it below.');
    case 'needs_authentication': return t('Your bank wants to check this one.');
    case 'declined': case 'card_unavailable': return t('Your saved card did not go through.');
    case 'other_currency': return t('This bill is in another currency, so it needs a tap.');
    case 'too_many_today': return t('That is your auto-pay limit for today.');
    case 'venue_not_connected': case 'venue_unreadable': return null;
    default: return null;
  }
}
