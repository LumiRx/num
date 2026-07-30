// Events: the host makes one, guests get one text with one link, and the RSVP
// page needs no app on their side. The dashboard is the part an event site
// would charge for — who's coming, who opened it and went quiet, and a one-tap
// chase for the silent ones.
import { store } from './store';
import type { EventGuest, NumEvent } from './types';
import { smsLink, whatsappLink } from './services';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api/events' + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `events ${res.status}`);
  return body as T;
}

export async function createEvent(e: Partial<NumEvent>): Promise<NumEvent | null> {
  const me = store.get().me;
  if (!me) return null;
  const out = await api<{ event: NumEvent; url: string }>('/create', {
    method: 'POST',
    body: JSON.stringify({ host_id: me.id, plan_id: store.get().planId, ...e }),
  });
  const event = { ...out.event, url: out.url };
  store.set((s) => ({ events: [event, ...s.events], eventId: event.id, eventOpen: true }));
  return event;
}

export async function listEvents(): Promise<void> {
  const me = store.get().me;
  if (!me) return;
  try {
    const out = await api<{ events: NumEvent[] }>(`/list?me=${encodeURIComponent(me.id)}`);
    store.set({ events: out.events });
  } catch (err) {
    console.warn('[events] list failed', err);
  }
}

export interface EventDashboard {
  event: NumEvent;
  url: string;
  guests: EventGuest[];
  summary: { invited: number; yes: number; no: number; maybe: number; pending: number; opened: number; heads: number; capacity: number | null; silent: number };
}

export async function eventDashboard(id: string): Promise<EventDashboard | null> {
  const me = store.get().me;
  if (!me) return null;
  try {
    return await api<EventDashboard>(`/dashboard?id=${encodeURIComponent(id)}&me=${encodeURIComponent(me.id)}`);
  } catch (err) {
    console.warn('[events] dashboard failed', err);
    return null;
  }
}

export interface GuestInvite {
  token: string;
  name: string | null;
  url: string;
  message: string;
  sms_url: string;
  whatsapp_url: string;
  share: { title: string; text: string; url: string };
}

/** Mint invite links. Nothing is sent from our side — the host sends them. */
export async function inviteGuests(eventId: string, guests: Array<{ name?: string; phone?: string }>): Promise<GuestInvite[]> {
  const me = store.get().me;
  if (!me) return [];
  const out = await api<{ invites: GuestInvite[] }>('/invite', {
    method: 'POST',
    body: JSON.stringify({ me: me.id, event_id: eventId, guests }),
  });
  return out.invites;
}

/**
 * Chase the people who never answered — the single most useful thing a host
 * dashboard does. Built here rather than server-side because it has to go out
 * from the host's own number.
 */
export function chaseText(event: NumEvent, guests: EventGuest[], url: string): { sms: string; whatsapp: string; body: string; count: number } {
  const silent = guests.filter((g) => g.rsvp === 'pending');
  const names = silent.map((g) => g.name).filter(Boolean).slice(0, 5).join(', ');
  const body =
    `Quick nudge about ${event.title}${event.day ? ` on ${event.day}` : ''} — still need a yes or no from you` +
    `${names ? ` (${names})` : ''}. One tap: ${url}`;
  return { sms: smsLink(null, body), whatsapp: whatsappLink(null, body), body, count: silent.length };
}
