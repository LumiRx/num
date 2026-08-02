// The inbox: everything waiting on your answer. Connection requests, group
// plans that moved, and event invites — answered in a tap without leaving the
// dash.
import { store } from './store';
import type { InboxRequests } from './types';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api/social' + path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `requests ${res.status}`);
  return body as T;
}

export async function refreshRequests(): Promise<void> {
  const me = store.get().me;
  if (!me) return;
  try {
    const out = await api<InboxRequests>(`/requests?me=${encodeURIComponent(me.id)}`);
    store.set({ inbox: out });
  } catch (err) {
    console.warn('[requests]', err);
  }
}

/**
 * Answer one. `propose` and `message` post into the group's feed, so the other
 * members' Nums tell them — the same channel a booking uses.
 */
export async function respond(
  kind: 'connect' | 'plan' | 'event',
  id: string,
  action: 'accept' | 'decline' | 'propose' | 'message',
  extra: { message?: string; time?: string } = {},
): Promise<string | null> {
  const me = store.get().me;
  if (!me) return null;
  const out = await api<{ friend?: { name: string }; plan?: { title: string }; posted?: string; rsvp?: string; state?: string }>('/respond', {
    method: 'POST',
    body: JSON.stringify({ me: me.id, kind, id, action, ...extra }),
  });
  await refreshRequests();
  if (kind === 'connect' && out.state === 'active') {
    // "They know" was simply false — nothing was ever sent to the person who
    // invited you. The server now notifies them (social.mjs accept/respond),
    // so this can say it and mean it.
    return out.plan
      ? `You're in — ${out.plan.title}. ${out.friend?.name ?? 'They'} just got told.`
      : `Connected with ${out.friend?.name ?? 'them'} — they've been told.`;
  }
  if (out.posted) return out.posted;
  if (out.rsvp) return out.rsvp === 'yes' ? 'You’re on the list.' : out.rsvp === 'no' ? 'Told them you can’t.' : 'Marked as a maybe.';
  return null;
}
