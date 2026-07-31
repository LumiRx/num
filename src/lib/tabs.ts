// A live tab — one bill, several people, settled while everyone is still at
// the table.
//
// The whole point is that nobody does arithmetic. Each round is logged as it
// is bought, with who it was for, and the split falls out of that. An item
// three people shared costs three people; the round one person skipped costs
// them nothing. Splitting a bill evenly at the end is the thing everyone
// quietly resents, and it is only done because the alternative is bookkeeping.
//
// The server owns every number here. This module asks and displays — the
// moment a balance is computed on the client it can disagree with the ledger,
// and a disagreement about money is the one bug nobody forgives.
import { store } from './store';
import { refreshStars } from './stars';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api/social' + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `tab ${res.status}`);
  return body as T;
}

export interface TabItem {
  id: string;
  label: string;
  stars: number;
  paid_by: string;
  paid_by_name?: string | null;
  shared_with: string | null;
  created_at: string;
}

export interface TabSplit {
  member_id: string;
  name: string | null;
  owes: number;
  paid: number;
  net: number;
  settled_at: string | null;
}

export interface TabState {
  tab: { id: string; code: string; title: string; venue: string | null; state: string; owner_id: string };
  members: Array<{ member_id: string; name: string | null; settled_at: string | null }>;
  items: TabItem[];
  total: number;
  /** Stars already moved between members on this tab. */
  settled: number;
  split: TabSplit[];
}

/** Open a tab. Whoever opens it is the first member — no separate join step. */
export async function openTab(title: string, venue?: string): Promise<TabState | null> {
  const me = store.get().me;
  if (!me) return null;
  const st = await api<TabState>('/tab', { method: 'POST', body: JSON.stringify({ me: me.id, title, venue }) });
  store.set({ tabOpen: st, tabId: st.tab.id });
  return st;
}

/**
 * Join by the six-character code.
 *
 * A code rather than an invite because the person joining is standing next to
 * you — reading six characters off a screen beats waiting for a notification
 * that needs signal the bar does not have.
 */
export async function joinTab(code: string): Promise<TabState | null> {
  const me = store.get().me;
  if (!me) return null;
  const st = await api<TabState>('/tab/join', {
    method: 'POST',
    body: JSON.stringify({ me: me.id, code: code.trim().toUpperCase() }),
  });
  store.set({ tabOpen: st, tabId: st.tab.id });
  return st;
}

export async function loadTab(id: string): Promise<TabState | null> {
  try {
    const st = await api<TabState>(`/tab?id=${encodeURIComponent(id)}`);
    store.set({ tabOpen: st, tabId: st.tab.id });
    return st;
  } catch {
    return null;
  }
}

/**
 * Log a round. `sharedWith` empty means everyone on the tab, which is the
 * common case and so is the one that takes no taps.
 */
export async function addItem(label: string, stars: number, sharedWith?: string[]): Promise<TabState | null> {
  const me = store.get().me;
  const tab = store.get().tabOpen;
  if (!me || !tab) return null;
  const st = await api<TabState>('/tab/item', {
    method: 'POST',
    body: JSON.stringify({
      me: me.id,
      tab_id: tab.tab.id,
      label,
      stars,
      ...(sharedWith?.length ? { shared_with: sharedWith } : {}),
    }),
  });
  store.set({ tabOpen: st, tabId: st.tab.id });
  return st;
}

/** Pay what you owe, to whoever is up. Refuses rather than going negative. */
export async function settleTab(): Promise<{ ok: boolean; message: string }> {
  const me = store.get().me;
  const tab = store.get().tabOpen;
  if (!me || !tab) return { ok: false, message: 'No tab open.' };
  try {
    const out = await api<{ paid?: Array<{ to: string; stars: number }>; nothing_owed?: boolean }>('/tab/settle', {
      method: 'POST',
      body: JSON.stringify({ me: me.id, tab_id: tab.tab.id }),
    });
    await loadTab(tab.tab.id);
    void refreshStars();
    if (out.nothing_owed) return { ok: true, message: 'You’re square — nothing to pay.' };
    const paid = out.paid ?? [];
    return {
      ok: true,
      message: paid.length
        ? `Settled — ${paid.map((p) => `★${p.stars} to ${p.to}`).join(', ')}.`
        : 'Settled.',
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'That didn’t go through.' };
  }
}

/**
 * Reopen the tab from last launch, if there still is one.
 *
 * A night out survives a phone reboot; a tab that vanishes because the browser
 * reloaded is a tab nobody trusts with their money.
 */
export async function restoreTab(): Promise<void> {
  const id = store.get().tabId;
  if (!id) return;
  const st = await loadTab(id);
  // Closed and settled — stop dragging it forward.
  if (!st || (st.tab.state !== 'open' && st.split.every((s) => s.net === 0))) store.set({ tabOpen: null, tabId: null });
  else store.set({ tabOpen: null });
}

export async function closeTab(): Promise<void> {
  const me = store.get().me;
  const tab = store.get().tabOpen;
  if (!me || !tab) return;
  await api('/tab/close', { method: 'POST', body: JSON.stringify({ me: me.id, tab_id: tab.tab.id }) }).catch(() => null);
  await loadTab(tab.tab.id);
}

/**
 * Poll while a tab is open and on screen.
 *
 * Rounds are bought by other people at the bar, so the screen has to move on
 * its own or the split is stale exactly when someone is looking at it. Ten
 * seconds is fast enough to feel live and slow enough to cost nothing.
 */
export function startTabSync(): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = () => {
    const t = store.get().tabOpen;
    if (t && t.tab.state === 'open' && document.visibilityState === 'visible') void loadTab(t.tab.id);
  };
  timer = setInterval(tick, 10_000);
  document.addEventListener('visibilitychange', tick);
  return () => {
    if (timer) clearInterval(timer);
    document.removeEventListener('visibilitychange', tick);
  };
}
