// Asking a real restaurant for a real table, from the app's side.
//
// The whole loop lives in worker/bookdesk.mjs: Num texts the venue, the venue
// taps CONFIRM or DECLINE in the text, and the guest's phone buzzes. This
// module does two things and deliberately no more — it sends the request, and
// it reads back what the venue said.
//
// It computes nothing. "Confirmed" is a column in D1 that only a tapped,
// HMAC-signed link can move, and a client that decided on its own that a table
// was held would be telling somebody to turn up somewhere that is not
// expecting them. That is the one failure this product cannot survive, so the
// server is the only thing allowed to say it.
import { store } from './store';
import { apiUrl } from '../lib/apibase';
import { guestMessage } from './saferr';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl('/api/book') + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `book ${res.status}`);
  return body as T;
}

/** One transition, one direction — see the state comment in bookdesk.mjs. */
export type TableState = 'requested' | 'confirmed' | 'declined' | 'expired';

export interface TableRequest {
  id: string;
  venue_name: string;
  party_size: number;
  on_date: string | null;
  at_time: string | null;
  state: TableState;
  created_at: string;
  answered_at: string | null;
}

/** What Num is about to ask for, shown in full before anything is sent. */
export interface TableDraft {
  venue_name: string;
  venue_phone: string | null;
  place_id: string | null;
  party_size: number;
  on_date: string | null;
  at_time: string;
  note: string | null;
}

/** Plain English for where a request has got to. */
export const stateLine = (r: TableRequest): string =>
  ({
    requested: 'Asked — waiting on the venue',
    confirmed: 'Confirmed by the venue',
    declined: 'They couldn’t take it',
    expired: 'No answer — worth trying elsewhere',
  })[r.state] ?? r.state;

/** The line under the heading: venue, party, when. */
export const draftLine = (d: TableDraft): string =>
  `Table for ${d.party_size} · ${d.on_date ?? 'tonight'}${d.at_time ? ` at ${d.at_time}` : ''}`;

export async function loadMyRequests(): Promise<void> {
  const me = store.get().me;
  if (!me) return;
  try {
    const out = await api<{ requests: TableRequest[] }>(`/mine?me=${encodeURIComponent(me.id)}`);
    store.set({ bookRequests: out.requests });
  } catch (err) {
    console.warn('[bookdesk]', err);
  }
}

/**
 * Send the request. Called from the ONE button the guest taps, never from an
 * action handler — the model proposes, the person sends. See BookSheet.
 *
 * `texted` comes back false when there is no number for the venue or the SMS
 * provider refused it (an unregistered A2P 10DLC campaign is the live case).
 * The request still exists and the desk works it by hand, so the message says
 * that rather than claiming a text that never left.
 */
export async function requestTable(d: TableDraft): Promise<{ ok: boolean; message: string; id?: string }> {
  const me = store.get().me;
  if (!me) return { ok: false, message: 'Add your name first — a venue needs to know who the table is for.' };
  try {
    const out = await api<{ id: string; texted: boolean; note: string }>('/request', {
      method: 'POST',
      body: JSON.stringify({
        me: me.id,
        venue_name: d.venue_name,
        venue_phone: d.venue_phone ?? undefined,
        place_id: d.place_id ?? undefined,
        party_size: d.party_size,
        on_date: d.on_date ?? undefined,
        at_time: d.at_time,
        note: d.note ?? undefined,
        plan_id: store.get().planId ?? undefined,
      }),
    });
    await loadMyRequests();
    return { ok: true, message: out.note, id: out.id };
  } catch (err) {
    return { ok: false, message: guestMessage(err, 'That didn’t go through.') };
  }
}

/**
 * Poll while the sheet is open.
 *
 * The answer arrives when a person in a restaurant taps a link, which can be
 * ten seconds or forty minutes. Push tells them anyway (bookdesk notifies on
 * the flip); this is so the screen they are already looking at is not the last
 * to know. Fifteen seconds, matching the errand board.
 */
export function startBookSync(): () => void {
  const tick = () => {
    if (document.visibilityState === 'visible') void loadMyRequests();
  };
  const timer = setInterval(tick, 15_000);
  document.addEventListener('visibilitychange', tick);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', tick);
  };
}
