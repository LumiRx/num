// Handing a trip to a travel agency, from the app's side.
//
// The whole loop lives in worker/travelreferral.mjs: Num sends the agency a
// structured request with a NUM- reference, the agency attaches a quote through
// a signed link, the member accepts, and the AGENCY takes the payment and
// issues the confirmation. This module does three things and deliberately no
// more — it sends the request, it reads back what the agency said, and it
// passes on a yes.
//
// ── THE LANGUAGE RULE, ENFORCED HERE AND NOT ONLY IN THE PROMPT ──────────
//
// Num PRESENTS, the partner ISSUES. Nothing in this file says booked, reserved,
// held or ticketed, and nothing here formats a price. `quote_amount_cs` and
// `quote_currency` arrive as two separate fields and are rendered as the
// agency's own number in the agency's own currency — a converted figure would
// be a price Num computed, and Num computing a travel price is the thing this
// entire structure exists to avoid. The one sentence that matters most, the one
// on acceptance, comes from the SERVER (`note`), so the app cannot soften it.
import { store } from './store';
import { apiUrl } from '../lib/apibase';
import { guestMessage } from './saferr';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl('/api/travel') + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `travel ${res.status}`);
  return body as T;
}

/** draft → sent → quoted → accepted → confirmed, plus the three terminals. */
export type TravelState =
  | 'draft' | 'sent' | 'quoted' | 'accepted' | 'confirmed' | 'declined' | 'cancelled' | 'expired';

export interface TravelReferral {
  id: string;
  ref: string;
  product: string;
  partner_name: string | null;
  origin: string | null;
  destination: string | null;
  depart_on: string | null;
  return_on: string | null;
  adults: number;
  children: number;
  cabin: string | null;
  state: TravelState;
  /** The server's own plain-English line. Never re-worded on this side. */
  state_line: string;
  quote_amount_cs: number | null;
  quote_currency: string | null;
  quote_note: string | null;
  quote_url: string | null;
  partner_ref: string | null;
  created_at: string;
  sent_at: string | null;
  quoted_at: string | null;
  accepted_at: string | null;
  confirmed_at: string | null;
}

/** What Num is about to hand over, shown in full before anything is sent. */
export interface TravelDraft {
  product: string;
  origin: string | null;
  destination: string | null;
  depart_on: string | null;
  return_on: string | null;
  adults: number;
  children: number;
  cabin: string | null;
  budget_cs: number | null;
  budget_currency: string | null;
  notes: string | null;
  contact_email: string | null;
  contact_phone: string | null;
}

export const itineraryLine = (d: TravelDraft | TravelReferral): string =>
  [d.origin && d.destination ? `${d.origin} → ${d.destination}` : d.destination || d.origin || 'Destination to confirm',
    d.depart_on ? `out ${d.depart_on}` : null,
    d.return_on ? `back ${d.return_on}` : null].filter(Boolean).join(' · ');

export const paxLine = (d: TravelDraft | TravelReferral): string =>
  `${d.adults} adult${d.adults === 1 ? '' : 's'}${d.children ? ` + ${d.children} child${d.children === 1 ? '' : 'ren'}` : ''}`;

/**
 * The agency's quote, exactly as the agency sent it.
 *
 * Two fields in, one string out, and no arithmetic in between: no conversion,
 * no per-person split, no "from". Returns null when there is no quote yet,
 * because an empty price line is better than a placeholder somebody reads as a
 * number.
 */
export const quoteLine = (r: TravelReferral): string | null =>
  r.quote_amount_cs && r.quote_currency
    ? `${(r.quote_amount_cs / 100).toFixed(2)} ${r.quote_currency}`
    : null;

export async function loadMyReferrals(): Promise<void> {
  const me = store.get().me;
  if (!me) return;
  try {
    const out = await api<{ referrals: TravelReferral[] }>(`/mine?me=${encodeURIComponent(me.id)}`);
    store.set({ travelReferrals: out.referrals });
  } catch (err) {
    console.warn('[travel]', err);
  }
}

/**
 * Send the request to the agency. Called from the ONE button the member taps,
 * never from an action handler — the model proposes, the person sends.
 *
 * Same rule as BookSheet, for the same reason and then one more: this hands a
 * named traveller's contact details to a third-party company. That is a
 * decision a person makes, not a sentence a model produces.
 */
export async function referTravel(d: TravelDraft): Promise<{ ok: boolean; message: string; ref?: string }> {
  const me = store.get().me;
  if (!me) return { ok: false, message: 'Tell me your name first — the agency needs to know who is travelling.' };
  try {
    const out = await api<{ ref: string; partner: string; note: string }>('/refer', {
      method: 'POST',
      body: JSON.stringify({ me: me.id, ...d }),
    });
    await loadMyReferrals();
    return { ok: true, message: out.note, ref: out.ref };
  } catch (err) {
    return { ok: false, message: guestMessage(err, 'That didn’t go through.') };
  }
}

/**
 * Pass a yes to the agency.
 *
 * The returned message is the server's, verbatim: "they'll contact you directly
 * to take payment and issue the confirmation". It is the single most important
 * sentence in this flow and the app must not paraphrase it into something that
 * sounds like Num did the booking.
 */
export async function acceptQuote(ref: string): Promise<{ ok: boolean; message: string }> {
  const me = store.get().me;
  if (!me) return { ok: false, message: 'Sign in first.' };
  try {
    const out = await api<{ note: string }>('/accept', {
      method: 'POST',
      body: JSON.stringify({ me: me.id, ref }),
    });
    await loadMyReferrals();
    return { ok: true, message: out.note };
  } catch (err) {
    return { ok: false, message: guestMessage(err, 'That didn’t go through.') };
  }
}

/**
 * Poll while the sheet is open.
 *
 * An agency answers in minutes or in hours — their own SLA is 24h and the
 * quote arrives when a human at a desk gets to it. Sixty seconds, not fifteen:
 * this is a slower loop than a restaurant taking a table, and hammering an
 * endpoint for a reply that takes half a day is just battery.
 */
export function startTravelSync(): () => void {
  const tick = () => {
    if (document.visibilityState === 'visible') void loadMyReferrals();
  };
  const timer = setInterval(tick, 60_000);
  document.addEventListener('visibilitychange', tick);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', tick);
  };
}
