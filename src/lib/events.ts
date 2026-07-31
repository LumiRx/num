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

/**
 * What came back from asking. `asked` already went — those people's Nums have
 * the question. `invites` is the opposite: links the host still has to send.
 * `blocked` and `ambiguous` are the two things only a human can resolve.
 */
export interface InviteDispatch {
  invites: GuestInvite[];
  asked: Array<{ token: string; member_id: string; name: string | null; delivered: boolean; already?: boolean; line?: string }>;
  blocked: Array<{ member_id: string; name: string | null; reason: string; message: string; remedy: string | null }>;
  ambiguous: Array<{ name: string; candidates: Array<{ id: string; name: string; avatar: string | null }> }>;
  summary: { sent: number; to_send: number; blocked: number; needs_confirming: number };
}

export async function createEvent(
  e: Partial<NumEvent> & { ask?: string[] },
): Promise<(NumEvent & { dispatch?: InviteDispatch }) | null> {
  const me = store.get().me;
  if (!me) return null;
  const out = await api<{ event: NumEvent; url: string } & Partial<InviteDispatch>>('/create', {
    method: 'POST',
    body: JSON.stringify({ host_id: me.id, plan_id: store.get().planId, ...e }),
  });
  const event = { ...out.event, url: out.url };
  store.set((s) => ({ events: [event, ...s.events], eventId: event.id, eventOpen: true }));
  return { ...event, dispatch: out.summary ? (out as unknown as InviteDispatch) : undefined };
}

/** Everything this member's Num has been asked to join, already phrased. */
export interface AgentInvite {
  token: string;
  event_id: string;
  via: 'agent' | 'link';
  title: string;
  day: string | null;
  time: string | null;
  place: string | null;
  address: string | null;
  plan_id: string | null;
  host: { id: string; name: string | null; avatar: string | null };
  ask: string;
}

export async function pendingInvites(): Promise<AgentInvite[]> {
  const me = store.get().me;
  if (!me) return [];
  try {
    const out = await api<{ invites: AgentInvite[] }>(`/invites?me=${encodeURIComponent(me.id)}`);
    return out.invites;
  } catch (err) {
    console.warn('[events] invites failed', err);
    return [];
  }
}

/** The member's own answer, from inside their Num. */
export async function replyToInvite(
  token: string,
  rsvp: 'yes' | 'no' | 'maybe',
  extra: { plus_ones?: number; message?: string } = {},
): Promise<string | null> {
  const me = store.get().me;
  if (!me) return null;
  const out = await api<{ line?: string }>('/reply', {
    method: 'POST',
    body: JSON.stringify({ me: me.id, token, rsvp, ...extra }),
  });
  return out.line ?? null;
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
  summary: {
    invited: number; yes: number; no: number; maybe: number; pending: number; opened: number;
    heads: number; capacity: number | null; silent: number;
    /** Reached agent-to-agent — nothing for the host to send. */
    asked: number;
    /** Links still sitting unsent in the host's share sheet. */
    to_send: number;
  };
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
