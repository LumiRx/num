// Stays, from the app's side.
//
// worker/liteapi.mjs holds the rates, the wall and the gates; this is the thin
// half that asks, holds and confirms. Three rules carried over from the server
// so the screens cannot quietly break them:
//
//   1. THE CLIENT NEVER SEES A PUBLIC PRICE OR A MARGIN. publicOption() strips
//      them server-side. `StayOption` below has no field for either, which
//      means a future change that started sending one would not compile here —
//      a type is a cheaper guard than a code review.
//
//   2. HELD IS NOT BOOKED. `prebookStay` returns a hold. Nothing is reserved,
//      nothing is paid, and the copy on the confirm screen says so.
//
//   3. A PRICE GOES STALE IN MINUTES. `heldAt` is stamped on arrival so the
//      confirm screen can tell somebody their price needs checking again
//      rather than letting them commit against a number from ten minutes ago.
import { store } from './store';
import { apiUrl } from '../lib/apibase';
import type { Member } from './types';

/** Exactly the shape publicOption() emits. No public price. No commission. */
export interface StayOption {
  id: string;
  hotel: string | null;
  address: string | null;
  stars: number | null;
  room: string | null;
  board: string | null;
  currency: string | null;
  total: number | null;
  nightly: number | null;
  refundable: boolean | null;
  cancelBy: string | null;
  payAtHotel: number | null;
  payAtHotelFor: string[] | null;
  /** Present only when the operator switched the saving line on. */
  belowPublicBy?: number;
}

export interface StayQuery {
  where: string;
  checkin: string;
  checkout: string;
  adults: number;
  rooms: number;
  childrenAges: number[];
  guestNationality: string;
  currency: string;
}

export interface StayHold {
  prebookId: string | null;
  transactionId: string | null;
  currency: string | null;
  total: number | null;
  /** null means the supplier did not say — NOT "no change". */
  priceChanged: boolean | null;
  priceDifference: number | null;
  stayId: string | null;
  clientReference: string | null;
  heldAt: number;
}

export interface StayGuest {
  occupancyNumber: number;
  firstName: string;
  lastName: string;
  email?: string;
}

export interface StayReceipt {
  id: string;
  hotel: string | null;
  room: string | null;
  checkin: string;
  checkout: string;
  currency: string | null;
  total: number | null;
  payAtHotel: number | null;
  refundable: boolean | null;
  cancelBy: string | null;
  confirmationCode: string | null;
  status: 'held' | 'confirmed' | 'cancelled' | 'failed';
}

/** What the confirm screen is still waiting for, named the way the server names it. */
export interface StayDraft {
  option: StayOption;
  query: StayQuery;
  hold: StayHold | null;
  holder: { firstName: string; lastName: string; email: string };
  guests: StayGuest[];
  step: 'guests' | 'confirm' | 'done';
  receipt: StayReceipt | null;
  error: string | null;
  busy: boolean;
}

// Takes a FULL url, not a path. The rule (worker/nativeapi.test.mjs) is that an
// `/api/…` literal may only ever appear as an argument to apiUrl() — a helper
// that applies apiUrl internally still leaves a bare path at every call site,
// which is exactly the shape that broke inside the native shell in August.
const post = async (url: string, body: unknown) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(out?.error ?? `Stays ${res.status}`) as Error & { missing?: string[] };
    if (out?.missing) err.missing = out.missing;
    throw err;
  }
  return out;
};

/**
 * Ages, not a count — "7, 11" is two children aged seven and eleven.
 *
 * A supplier prices a 2-year-old and a 15-year-old differently, so a count is
 * not a smaller version of this information, it is the wrong information. The
 * server refuses a search that gives a count without ages; this is the parser
 * that stops that refusal ever being reached by accident.
 */
export const parseChildAges = (raw: string): number[] =>
  String(raw ?? '')
    .split(/[,\s]+/)
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 17);

export async function searchStays(me: Member | null, q: StayQuery): Promise<{ options: StayOption[]; nights: number | null; member: boolean }> {
  return post(apiUrl('/api/stays/search'), {
    me: me?.id ?? null,
    checkin: q.checkin,
    checkout: q.checkout,
    currency: q.currency,
    guestNationality: q.guestNationality,
    cityName: q.where,
    occupancies: Array.from({ length: Math.max(1, q.rooms) }, (_, i) => ({
      adults: q.adults,
      ...(i === 0 && q.childrenAges.length
        ? { children: q.childrenAges.length, childrenAges: q.childrenAges }
        : {}),
    })),
  });
}

/** Holds the offer and writes the held row. Nothing is paid and nothing is reserved. */
export async function prebookStay(me: Member | null, option: StayOption, query: StayQuery): Promise<StayHold> {
  const out = await post(apiUrl('/api/stays/prebook'), { me: me?.id ?? null, offerId: option.id, option, query });
  return { ...out, heldAt: Date.now() };
}

export async function bookStay(
  me: Member | null,
  draft: StayDraft,
): Promise<StayReceipt> {
  return post(apiUrl('/api/stays/book'), {
    me: me?.id ?? null,
    stayId: draft.hold?.stayId ?? null,
    prebookId: draft.hold?.prebookId,
    clientReference: draft.hold?.clientReference,
    holder: draft.holder,
    guests: draft.guests,
    // The guest pays through the supplier's SDK on this device. NUM never sees
    // a card, so there is no card field to send — only the session reference
    // that prebook minted.
    payment: { method: 'TRANSACTION_ID', transactionId: draft.hold?.transactionId },
  });
}

export async function cancelStay(me: Member | null, stayId: string) {
  return post(apiUrl(`/api/stays/cancel/${encodeURIComponent(stayId)}`), { me: me?.id ?? null });
}

export async function myStays(me: Member | null): Promise<StayReceipt[]> {
  if (!me?.id) return [];
  const res = await fetch(apiUrl(`/api/stays/mine?me=${encodeURIComponent(me.id)}`));
  if (!res.ok) throw new Error(`Stays ${res.status}`);
  return (await res.json()).stays ?? [];
}

/**
 * A held price is good for minutes, not for as long as somebody takes to type
 * two names. Ten is deliberately conservative: the cost of re-checking is one
 * call, and the cost of NOT re-checking is a guest committing against a number
 * that has moved.
 */
export const HOLD_GOOD_FOR_MS = 10 * 60 * 1000;
export const holdIsStale = (h: StayHold | null, now = Date.now()) =>
  !h || now - h.heldAt > HOLD_GOOD_FOR_MS;

export const openStayBooking = (option: StayOption, query: StayQuery) =>
  store.set({
    stayBookOpen: {
      option,
      query,
      hold: null,
      holder: { firstName: '', lastName: '', email: '' },
      guests: [{ occupancyNumber: 1, firstName: '', lastName: '' }],
      step: 'guests',
      receipt: null,
      error: null,
      busy: false,
    } as StayDraft,
  });

export const closeStayBooking = () => store.set({ stayBookOpen: null });

/** Mirrors worker/liteapi.mjs missingForBook(), so a person is told before they tap. */
export function missingForBook(d: StayDraft): string[] {
  const missing: string[] = [];
  if (!d.holder.firstName) missing.push('holder.firstName');
  if (!d.holder.lastName) missing.push('holder.lastName');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.holder.email)) missing.push('holder.email');
  d.guests.forEach((g, i) => {
    if (!g.firstName) missing.push(`guests[${i}].firstName`);
    if (!g.lastName) missing.push(`guests[${i}].lastName`);
  });
  if (!d.hold?.prebookId) missing.push('hold');
  return missing;
}
