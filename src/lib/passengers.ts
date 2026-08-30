// Passenger details — the seam to /api/passengers (worker/passengers.mjs).
//
// This is the only place in the app that carries a legal name and a date of
// birth. Two rules follow from that and both are load-bearing:
//
//   · Nothing is cached in the store and nothing is persisted to localStorage.
//     Every other seam in src/lib keeps a copy in AppState so a reload is
//     instant; this one refetches, because a passport number sitting in
//     localStorage on a shared iPad is a different kind of mistake from a stale
//     plan. The sheet holds the list in component state and drops it on close.
//   · It never reaches the concierge. `askNum` stringifies trip state into the
//     prompt, so anything in the store is something a model sees eventually —
//     worker/redact.mjs would strip these fields, and the better answer is that
//     they were never there.
import type { Member } from './types';
import { apiUrl } from './apibase';

export const TITLES = ['mr', 'ms', 'mrs', 'miss', 'dr'] as const;
export const GENDERS = ['m', 'f'] as const;

export type PassengerTitle = (typeof TITLES)[number];
export type PassengerGender = (typeof GENDERS)[number];

/** Exactly the fields Duffel's create-order requires, plus what Num needs. */
export interface Passenger {
  id: string;
  is_self: boolean;
  label: string | null;
  title: PassengerTitle;
  given_name: string;
  family_name: string;
  born_on: string;
  gender: PassengerGender;
  email: string;
  phone_number: string;
  travels_with_id: string | null;
  passport: { number: string; country: string; expires_on: string } | null;
  loyalty: { airline: string; account: string } | null;
  created_at: string;
  updated_at: string;
}

export interface PassengerDraft {
  id?: string;
  is_self?: boolean;
  label?: string;
  title?: string;
  given_name?: string;
  family_name?: string;
  born_on?: string;
  gender?: string;
  email?: string;
  phone_number?: string;
  travels_with_id?: string | null;
  passport_number?: string;
  passport_country?: string;
  passport_expires_on?: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl('/api/passengers') + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  // Same reasoning as src/lib/social.ts: a response that is not JSON is a
  // failure, and saying so here beats a minified property access two screens
  // away from the cause.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(
      res.ok
        ? "Couldn't reach Num — the server answered with something unexpected."
        : `passengers ${res.status}`,
    );
  }
  if (!res.ok) throw new Error((body as { error?: string }).error || `passengers ${res.status}`);
  return body as T;
}

export async function listPassengers(me: Member | null): Promise<Passenger[]> {
  if (!me?.id) return [];
  const out = await api<{ passengers: Passenger[] }>(`?me=${encodeURIComponent(me.id)}`);
  return out.passengers ?? [];
}

/** Create, or update when the draft carries an id. One endpoint, like plans. */
export async function savePassenger(me: Member | null, draft: PassengerDraft): Promise<Passenger> {
  if (!me?.id) throw new Error('Sign up first — a passenger record belongs to an account.');
  const out = await api<{ passenger: Passenger }>('', { method: 'POST', body: JSON.stringify({ me: me.id, ...draft }) });
  return out.passenger;
}

/**
 * Remove one. Soft on the server: it disappears here immediately and is
 * destroyed for good 30 days later, so an accidental tap the night before a
 * flight is recoverable by asking.
 */
export async function removePassenger(me: Member | null, id: string): Promise<void> {
  if (!me?.id) return;
  await api<{ deleted: string }>('/delete', { method: 'POST', body: JSON.stringify({ me: me.id, id }) });
}
