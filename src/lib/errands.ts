// Errands, from the app's side.
//
// The server owns every number and every state transition. This module asks
// and displays — the moment the client decides an errand is "settled" or works
// out what someone is owed, it can disagree with the ledger, and a
// disagreement about money is the one bug nobody forgives.
import { store } from './store';
import { refreshStars } from './stars';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api/errands' + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `errand ${res.status}`);
  return body as T;
}

export type ErrandState = 'open' | 'claimed' | 'collected' | 'delivered' | 'settled' | 'cancelled' | 'disputed';

export interface Errand {
  id: string;
  title: string;
  detail: string | null;
  where_from: string | null;
  /** Coarsened to a street for anyone who isn't the poster or the runner. */
  deliver_to: string | null;
  bounty: number;
  spend_cap: number;
  state: ErrandState;
  place: string | null;
  poster_name: string | null;
  runner_name: string | null;
  created_at: string;
  is_mine: boolean;
  is_running: boolean;
  /** Only present for the poster and the assigned runner. */
  handoff_code?: string;
}

/** What the person looking at this errand can do to it next. */
export function nextActions(e: Errand): Array<{ action: string; label: string; primary?: boolean }> {
  if (e.is_mine) {
    if (e.state === 'open') return [{ action: 'cancel', label: 'Cancel & refund' }];
    if (e.state === 'delivered')
      return [
        { action: 'confirm', label: 'Confirm & pay', primary: true },
        { action: 'dispute', label: 'Something’s wrong' },
      ];
    return [];
  }
  if (e.is_running) {
    if (e.state === 'claimed')
      return [
        { action: 'pickup', label: 'I’ve got it', primary: true },
        { action: 'giveup', label: 'Can’t do it' },
      ];
    if (e.state === 'collected') return [{ action: 'deliver', label: 'Delivered', primary: true }];
    return [];
  }
  if (e.state === 'open') return [{ action: 'claim', label: 'I’ll go', primary: true }];
  return [];
}

/** Plain English for where an errand has got to. */
export const stateLine = (e: Errand): string =>
  ({
    open: 'Waiting for someone to go',
    claimed: `${e.runner_name ?? 'Someone'} is on the way`,
    collected: `${e.runner_name ?? 'Someone'} has it`,
    delivered: e.is_mine ? 'Delivered — confirm to release the Stars' : 'Delivered, waiting on confirmation',
    settled: 'Done and paid',
    cancelled: 'Cancelled',
    disputed: 'Being sorted out',
  })[e.state] ?? e.state;

export async function loadBoard(place?: string | null): Promise<void> {
  const me = store.get().me;
  const q = new URLSearchParams();
  if (me) q.set('me', me.id);
  if (place) q.set('place', place);
  try {
    const [open, mine] = await Promise.all([
      api<{ errands: Errand[] }>(`?${q.toString()}`),
      me ? api<{ errands: Errand[] }>(`?me=${encodeURIComponent(me.id)}&mine=1`) : Promise.resolve({ errands: [] }),
    ]);
    store.set({ errands: open.errands, myErrands: mine.errands });
  } catch (err) {
    console.warn('[errands]', err);
  }
}

/**
 * Post an errand. The Stars leave your balance immediately — that is the point,
 * not a side effect, so the UI says so before the tap rather than after.
 */
export async function postErrand(e: {
  title: string;
  detail?: string;
  where_from?: string;
  deliver_to: string;
  bounty: number;
  spend_cap?: number;
}): Promise<{ ok: boolean; message: string }> {
  const me = store.get().me;
  if (!me) return { ok: false, message: 'Add your name and number first.' };
  try {
    const out = await api<{ held: number }>('/post', {
      method: 'POST',
      body: JSON.stringify({ ...e, me: me.id, place: store.get().place }),
    });
    void refreshStars();
    await loadBoard(store.get().place);
    return { ok: true, message: `Posted — ★${out.held.toLocaleString()} is held until it's done.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'That didn’t post.' };
  }
}

/** Every state change goes through here, so nothing is computed client-side. */
export async function act(
  id: string,
  action: string,
  extra?: { handoff_code?: string; spent?: number; note?: string },
): Promise<{ ok: boolean; message: string }> {
  const me = store.get().me;
  if (!me) return { ok: false, message: 'Add your name and number first.' };
  try {
    await api(`/${action}`, { method: 'POST', body: JSON.stringify({ me: me.id, id, ...extra }) });
    void refreshStars();
    await loadBoard(store.get().place);
    return { ok: true, message: '' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'That didn’t go through.' };
  }
}

/**
 * Poll while the board is open.
 *
 * Errands move because OTHER people act on them — somebody claims yours, your
 * runner marks it collected — so a static screen is a wrong screen. Fifteen
 * seconds is fast enough to feel live without being a drain.
 */
export function startErrandSync(): () => void {
  const tick = () => {
    if (document.visibilityState === 'visible') void loadBoard(store.get().place);
  };
  const timer = setInterval(tick, 15_000);
  document.addEventListener('visibilitychange', tick);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', tick);
  };
}
