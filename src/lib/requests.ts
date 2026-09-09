// The inbox: everything waiting on your answer. Connection requests, group
// plans that moved, and event invites — answered in a tap without leaving the
// dash.
import { store } from './store';
import type { InboxRequests } from './types';
import { apiUrl } from '../lib/apibase';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl('/api/social') + path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `requests ${res.status}`);
  return body as T;
}

/**
 * Three arrays, always — whatever came back.
 *
 * ── THE CRASH THIS FIXES ─────────────────────────────────────────────────
 *
 * 9 Sep 2026, on an iPhone opening the app:
 *
 *   undefined is not an object (evaluating 'e.connects.length')
 *
 * `DashView` reads `inbox.connects.length` on every render. The store starts
 * out correct — data.ts seeds `{ connects: [], plans: [], events: [] }` — and
 * then this function replaced the whole object with whatever the endpoint
 * returned, unread. A response missing one key, an error body that still came
 * back 200, a shape change on the worker side: any of those turn a required
 * array into `undefined`, and the next paint takes the entire app down to the
 * error screen. Not the dashboard. The app.
 *
 * A component reading its own store should not have to defend against the
 * store being malformed, so the guarantee is made here, at the one place the
 * server's answer becomes local state. Anything that is not an array becomes
 * an empty one: an inbox that renders empty is wrong in a way the next poll
 * fixes, and a white screen is wrong in a way only a reinstall fixes.
 */
const asInbox = (raw: unknown): InboxRequests => {
  const o = (raw ?? {}) as Partial<InboxRequests>;
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    connects: arr(o.connects),
    plans: arr(o.plans),
    events: arr(o.events),
  } as InboxRequests;
};

export async function refreshRequests(): Promise<void> {
  const me = store.get().me;
  if (!me) return;
  try {
    const out = await api<InboxRequests>(`/requests?me=${encodeURIComponent(me.id)}`);
    store.set({ inbox: asInbox(out) });
  } catch (err) {
    console.warn('[requests]', err);
  }
}

export const __testables = { asInbox };

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
