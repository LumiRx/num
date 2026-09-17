// Search and Suggest, from the app's side.
//
// The server (worker/discover.mjs) does the finding, the ranking and the
// "have any of us done this?" arithmetic. This module asks, and turns a
// result into the three things a person can do with it: send it to someone,
// put it in the plan, or tell NUM never to suggest it again. None of those is
// a booking — a Suggest card that says "booked" would be the 18 Aug bug in a
// new coat. Booking happens where it always has: in the thread, by asking.
import { store } from './store';
import { apiUrl } from '../lib/apibase';
import { addPlanItem } from './social';
import { openShareCard } from './sharecard';

export type DiscoverSource = 'num' | 'ticketmaster' | 'viator' | 'crew';
export type Mood = 'water' | 'food' | 'night' | 'sweat' | 'culture';

export interface DiscoverItem {
  source: DiscoverSource;
  id: string;
  title: string;
  sub: string;
  image: string | null;
  rating: number | null;
  reviews?: number | null;
  price: number | null;
  currency: string | null;
  url: string | null;
  distance_km: number | null;
  /** What the source is, in words a guest reads: "Checked by NUM". */
  label: string;
  novelty: { never_tried: boolean; you: boolean; done_by: string[] };
  reason: string;
}

export interface DiscoverResult {
  ok: boolean;
  mode: 'search' | 'surprise';
  sources: Record<DiscoverSource, number>;
  items: DiscoverItem[];
  note: string | null;
  error?: string;
}

export const MOODS: Array<{ id: Mood; emoji: string; label: string }> = [
  { id: 'water', emoji: '🛶', label: 'Water' },
  { id: 'food', emoji: '🍜', label: 'Food' },
  { id: 'night', emoji: '🌙', label: 'Night' },
  { id: 'sweat', emoji: '🥊', label: 'Sweat' },
  { id: 'culture', emoji: '🏛', label: 'Culture' },
];

/** Everything the server needs to know about where and who, from state. */
function whereAndWho(): Record<string, string> {
  const s = store.get();
  const q: Record<string, string> = {};
  if (s.place) q.place = s.place;
  if (s.here) { q.lat = String(s.here.lat); q.lng = String(s.here.lng); }
  if (s.me) q.me = s.me.id;
  if (s.planId) q.plan_id = s.planId;
  return q;
}

export async function discover(
  params: { mode: 'search'; q: string } | { mode: 'surprise'; mood?: Mood | null },
): Promise<DiscoverResult> {
  const qs = new URLSearchParams({ ...whereAndWho(), mode: params.mode });
  if (params.mode === 'search') qs.set('q', params.q);
  else if (params.mood) qs.set('mood', params.mood);
  try {
    const res = await fetch(`${apiUrl('/api/discover')}?${qs.toString()}`);
    const body = (await res.json().catch(() => ({}))) as Partial<DiscoverResult>;
    if (!res.ok) return { ok: false, mode: params.mode, sources: { num: 0, ticketmaster: 0, viator: 0, crew: 0 }, items: [], note: null, error: body.error === 'no_place' ? 'no_place' : (body.error ?? `discover ${res.status}`) };
    return { ok: true, mode: params.mode, sources: body.sources ?? { num: 0, ticketmaster: 0, viator: 0, crew: 0 }, items: body.items ?? [], note: body.note ?? null };
  } catch {
    return { ok: false, mode: params.mode, sources: { num: 0, ticketmaster: 0, viator: 0, crew: 0 }, items: [], note: null, error: 'offline' };
  }
}

/** 👎 — the server-side twin of the reaction in prefs.ts. Never suggested again. */
export async function dislike(item: DiscoverItem): Promise<void> {
  const me = store.get().me;
  if (!me) return;
  try {
    await fetch(apiUrl('/api/discover/dislike'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ me: me.id, title: item.title }),
    });
  } catch { /* a lost dislike costs one repeat suggestion, nothing more */ }
}

/** One line for a message or a plan note. Reads cold, days later. */
export function summaryFor(i: DiscoverItem): string {
  const bits = [i.title];
  if (i.sub) bits.push(i.sub);
  if (i.rating != null) bits.push(i.reviews ? `${i.rating} from ${i.reviews.toLocaleString()} reviews` : `rated ${i.rating}`);
  if (i.price != null && i.currency) bits.push(`from ${i.currency} ${i.price}`);
  bits.push(i.label);
  return bits.join(' · ');
}

export function priceLine(i: DiscoverItem): string | null {
  if (i.price == null || !i.currency) return null;
  const n = Number(i.price);
  return `${i.currency} ${n % 1 ? n.toFixed(2) : n}`;
}

/** "Send this to…" — a friend's chat, or a plan. The picker does the rest. */
export function sendItem(i: DiscoverItem): void {
  openShareCard({
    kind: 'idea',
    title: i.title,
    summary: summaryFor(i),
    place: i.source === 'num' ? i.title : null,
    cost: priceLine(i),
    link: i.url,
  });
}

/**
 * Straight into the open plan as an idea, with the reason it was dealt as
 * the note, so the crew sees "none of you has done this" next to it and the
 * existing plan vote decides. Returns false when there is no plan to add to.
 */
export async function addToPlan(i: DiscoverItem): Promise<boolean> {
  if (!store.get().planId) return false;
  const item = await addPlanItem({
    kind: 'idea',
    title: i.title,
    place: i.source === 'num' ? i.title : null,
    cost: priceLine(i),
    note: `${i.reason} ${i.label}.`,
    photo: i.image,
  });
  return !!item;
}

export function openDiscover(tab: 'search' | 'suggest' = 'suggest'): void {
  store.set({ discoverOpen: tab });
}
export function closeDiscover(): void {
  store.set({ discoverOpen: null });
}
