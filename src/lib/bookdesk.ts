// Asking a real restaurant for a real table, from the app's side.
//
// The whole loop lives in worker/bookdesk.mjs: NUM texts the venue, the venue
// taps CONFIRM or DECLINE in the text, and the guest's phone buzzes. This
// module does three things and deliberately no more — it sends the request,
// it reads back what the venue said, and it carries that answer to the places
// the guest looks (the diary, the thread) exactly once (landAnswers).
//
// It decides nothing. "Confirmed" is a column in D1 that only a tapped,
// HMAC-signed link can move, and a client that decided on its own that a table
// was held would be telling somebody to turn up somewhere that is not
// expecting them. That is the one failure this product cannot survive, so the
// server is the only thing allowed to say it.
import { store } from './store';
import { apiUrl } from '../lib/apibase';
import { guestMessage } from './saferr';
import type { Booking, Msg } from './types';
import { t } from './i18n';

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
  venue_phone?: string | null;
  party_size: number;
  on_date: string | null;
  at_time: string | null;
  note?: string | null;
  /** The group plan the table was asked for from, if any. */
  plan_id?: string | null;
  place_id?: string | null;
  state: TableState;
  created_at: string;
  answered_at: string | null;
}

/** What NUM is about to ask for, shown in full before anything is sent. */
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
    requested: t('Asked — waiting on the venue'),
    confirmed: t('Confirmed by the venue'),
    declined: t('They couldn’t take it'),
    expired: t('No answer — worth trying elsewhere'),
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
    landAnswers(out.requests);
  } catch (err) {
    console.warn('[bookdesk]', err);
  }
}

/** A real table on the diary carries this prefix — the request id is the rest. */
export const TABLE_BOOKING_PREFIX = 'tbl_';

/**
 * The diary entry for a confirmed table. Pure, so the shape is testable:
 * the venue is the place, the party size is the title's subject, the hour is
 * the venue's hour, and `dur` is the two hours a table is usually held for.
 */
export function tableBooking(r: TableRequest, today = new Date()): Booking {
  const [y, m, d] = (r.on_date ?? '').split('-').map(Number);
  const mo = m || today.getMonth() + 1;
  const day = d || today.getDate();
  void y;
  return {
    id: TABLE_BOOKING_PREFIX + r.id,
    mo, day,
    time: r.at_time ?? '19:00',
    dur: 120,
    place: r.venue_name,
    title: `Table for ${r.party_size} · ${r.venue_name}`,
    grp: 'BKK',
    status: 'confirmed',
    note: [r.note, t('Confirmed by the venue through NUM.')].filter(Boolean).join(' '),
    cost: '',
  };
}

/**
 * THE ANSWER LANDS (19 Sep 2026). Until today a venue's CONFIRM lived in one
 * place — the request list inside the booking sheet, polled only while that
 * sheet was open. It never became a booking on MY DIARY, never a card in the
 * thread, and the push that said "It's in your plan" was wrong. Now every
 * state change the server reports is carried into the app once:
 *
 *   confirmed → a booking on the diary (tbl_<id>) + a BOOKED card in the
 *               thread (which is also where the one-line plan nudge sits)
 *   declined  → one line in the thread offering to find another
 *   expired   → one line, same offer
 *
 * `bookSeen` remembers which state has been carried for which request, so
 * a reopen never re-announces yesterday's table. On the very first run (an
 * app that has never carried anything) confirmed tables still become
 * bookings — that is the diary being truthful — but nothing older than three
 * days is announced in the thread.
 */
export function landAnswers(requests: TableRequest[], now = Date.now()): void {
  const patch = landing(store.get(), requests, now);
  if (!patch) return;
  store.set((st) => ({
    bookings: patch.bookings,
    bookSeen: patch.bookSeen,
    msgs: patch.msgs.length ? [...st.msgs, ...patch.msgs] : st.msgs,
    unread: st.threadOpen ? st.unread : st.unread + patch.unread,
  }));
}

/** What landAnswers would change, computed without touching the store (tested directly). */
export function landing(
  s: { bookings: Booking[]; bookSeen?: Record<string, TableState> },
  requests: TableRequest[],
  now = Date.now(),
): { bookings: Booking[]; bookSeen: Record<string, TableState>; msgs: Msg[]; unread: number } | null {
  const seen = { ...(s.bookSeen ?? {}) };
  const first = Object.keys(seen).length === 0;
  const bookings = [...s.bookings];
  const msgs: Msg[] = [];
  let unread = 0;
  let dirty = false;
  for (const r of requests) {
    const prev = seen[r.id];
    if (prev === r.state) continue;
    seen[r.id] = r.state;
    dirty = true;
    if (r.state === 'requested') continue;
    const answered = r.answered_at ? Date.parse(r.answered_at.replace(' ', 'T') + (r.answered_at.endsWith('Z') ? '' : 'Z')) : now;
    const stale = first && now - answered > 3 * 86400e3;
    if (r.state === 'confirmed') {
      const b = tableBooking(r);
      const at = bookings.findIndex((x) => x.id === b.id);
      if (at >= 0) bookings[at] = { ...bookings[at], ...b }; else bookings.push(b);
      if (!stale) {
        msgs.push({
          who: 'c',
          text: `${r.venue_name} confirmed your table for ${r.party_size}${r.on_date ? ` on ${r.on_date}` : ''}${r.at_time ? ` at ${r.at_time}` : ''}. It’s on your PLAN tab${r.plan_id ? ' and the group’s board' : ''}.`,
          card: { title: r.venue_name, meta: `Table for ${r.party_size}${r.on_date ? ` · ${r.on_date}` : ''}${r.at_time ? ` · ${r.at_time}` : ''}`, tag: 'confirmed' },
        });
        unread++;
      }
    } else if (!stale) {
      msgs.push({
        who: 'c',
        text: r.state === 'declined'
          ? `${r.venue_name} couldn’t take your table for ${r.party_size}${r.at_time ? ` at ${r.at_time}` : ''}. Want me to find you somewhere just as good?`
          : `${r.venue_name} never answered about your table for ${r.party_size}. Want me to try somewhere else?`,
      });
      unread++;
    }
  }
  return dirty ? { bookings, bookSeen: seen, msgs, unread } : null;
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
  if (!me) return { ok: false, message: t('Add your name first — a venue needs to know who the table is for.') };
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
    return { ok: false, message: guestMessage(err, t('That didn’t go through.')) };
  }
}

/**
 * Poll for the venue's answer.
 *
 * The answer arrives when a person in a restaurant taps a link, which can be
 * ten seconds or forty minutes. Push tells them anyway (bookdesk notifies on
 * the flip); this is so the screen they are already looking at is not the last
 * to know. Fifteen seconds while the booking sheet is open, matching the
 * errand board; the app itself runs a slower one (ConciergeApp, 45 s) so an
 * answer that arrives while the guest is looking at TODAY still lands on the
 * diary and in the thread without the sheet ever being opened again.
 */
export function startBookSync(everyMs = 15_000): () => void {
  const tick = () => {
    if (document.visibilityState === 'visible') void loadMyRequests();
  };
  tick();
  const timer = setInterval(tick, everyMs);
  document.addEventListener('visibilitychange', tick);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', tick);
  };
}
