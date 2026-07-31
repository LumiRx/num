// Talking to a friend, from inside the app.
//
// The lock screen is the fast path and it already works (worker/dm.mjs, and
// the inline reply in app-public/sw.js). This is the other half: the thread you
// open when the reply needs more than one line, and the badge that tells you
// there is one waiting.
//
// Two things here are deliberate and worth not undoing:
//
//   · SENDING IS OPTIMISTIC AND IDEMPOTENT. The message appears the instant you
//     tap, carrying the same id we send as `idem`. If the network eats the
//     request and you tap again, the server recognises the id and returns the
//     original rather than delivering "on my way" twice.
//
//   · THE OPEN THREAD POLLS FAST, THE INBOX POLLS SLOW. A conversation at 45s
//     is not a conversation. Only the thread you are actually looking at pays
//     the 5s cost, and it stops the moment the tab is hidden.
import { store } from './store';

const IDLE_MS = 5_000;

export interface DmMessage {
  id: string;
  from_id: string;
  to_id: string;
  body: string;
  /** 'text', or 'event' for an invite card the other Num sent across. */
  kind: string;
  created_at: string;
  read_at: string | null;
  /** The invite token, present only on an event card addressed to YOU. */
  ref?: string | null;
  /** Local-only: in flight, or failed and re-sendable. Never comes back. */
  pending?: boolean;
  failed?: boolean;
}

/** One person with something unread — the shape the badges are built from. */
export interface DmPeer {
  from_id: string;
  name: string | null;
  unread: number;
  last_at: string;
  last_body: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api/dm' + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `dm ${res.status}`);
  return body as T;
}

const localId = () => 'dm_' + (crypto.randomUUID?.() ?? String(Date.now())).replace(/-/g, '').slice(0, 20);

// ── reading ────────────────────────────────────────────────────────────────

/** Who has something waiting. Rides the app's existing slow poll. */
export async function refreshDmInbox(): Promise<void> {
  const me = store.get().me;
  if (!me) return;
  try {
    const out = await api<{ from: DmPeer[] }>(`/inbox?me=${encodeURIComponent(me.id)}`);
    store.set({ dmInbox: out.from ?? [] });
  } catch (err) {
    console.warn('[dm] inbox failed', err);
  }
}

/**
 * Load the conversation with one person.
 *
 * Fetching IS the read receipt on the server, so this also clears that
 * person's badge locally rather than waiting for the next inbox poll to notice
 * — a badge that survives reading the message is the thing that makes an app
 * feel broken.
 */
export async function loadDmThread(withId: string): Promise<void> {
  const me = store.get().me;
  if (!me) return;
  try {
    const out = await api<{ messages: DmMessage[] }>(
      `/thread?me=${encodeURIComponent(me.id)}&with=${encodeURIComponent(withId)}`,
    );
    store.set((s) => ({
      // Only if they are still looking at this person: a slow response for the
      // previous thread must not overwrite the one they just opened.
      dmThread: s.dmWith?.id === withId ? merge(out.messages ?? [], s.dmThread) : s.dmThread,
      dmInbox: s.dmInbox.filter((p) => p.from_id !== withId),
      dmError: null,
    }));
  } catch (err) {
    console.warn('[dm] thread failed', err);
    store.set({ dmError: 'Couldn’t load that conversation.' });
  }
}

/**
 * Server truth, plus anything of ours still in flight.
 *
 * A pending message is dropped as soon as the server's copy carries the same
 * id — which it will, because the local id IS the idempotency key.
 */
function merge(server: DmMessage[], local: DmMessage[]): DmMessage[] {
  const landed = new Set(server.map((m) => m.id));
  return [...server, ...local.filter((m) => (m.pending || m.failed) && !landed.has(m.id))];
}

// ── sending ────────────────────────────────────────────────────────────────

/**
 * Send one message. Appears immediately; reconciled when the server answers.
 *
 * `id` is passed as `idem`, so a retry of a message that actually landed is a
 * no-op rather than a duplicate.
 */
export async function sendDm(to: string, text: string, opts: { id?: string } = {}): Promise<boolean> {
  const me = store.get().me;
  const body = text.trim();
  if (!me || !body) return false;

  const id = opts.id ?? localId();
  const optimistic: DmMessage = {
    id,
    from_id: me.id,
    to_id: to,
    body,
    kind: 'text',
    created_at: new Date().toISOString(),
    read_at: null,
    pending: true,
  };
  store.set((s) => ({
    dmThread: s.dmWith?.id === to ? [...s.dmThread.filter((m) => m.id !== id), optimistic] : s.dmThread,
    dmError: null,
  }));

  try {
    await api('/send', { method: 'POST', body: JSON.stringify({ me: me.id, to, body, idem: id }) });
    store.set((s) => ({ dmThread: s.dmThread.map((m) => (m.id === id ? { ...m, pending: false } : m)) }));
    // Pull the server's copy so the timestamp is theirs, not this device's
    // clock — two phones disagreeing about when a message was sent is a bug
    // people notice and cannot explain.
    void loadDmThread(to);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'That didn’t send.';
    store.set((s) => ({
      dmThread: s.dmThread.map((m) => (m.id === id ? { ...m, pending: false, failed: true } : m)),
      dmError: message,
    }));
    return false;
  }
}

/** Try a failed message again, reusing its id so it cannot double-deliver. */
export async function retryDm(id: string): Promise<void> {
  const msg = store.get().dmThread.find((m) => m.id === id);
  if (!msg?.failed) return;
  store.set((s) => ({ dmThread: s.dmThread.map((m) => (m.id === id ? { ...m, failed: false, pending: true } : m)) }));
  await sendDm(msg.to_id, msg.body, { id });
}

// ── opening ────────────────────────────────────────────────────────────────

/** Open the conversation with one person, by id. */
export function openDm(id: string, name?: string | null): void {
  const known = store.get().friends.find((f) => f.id === id);
  store.set({
    dmOpen: true,
    dmWith: { id, name: name ?? known?.name ?? null },
    dmThread: [],
    dmError: null,
  });
  void loadDmThread(id);
}

/** Back to the list of people, without closing the surface. */
export function closeDmThread(): void {
  store.set({ dmWith: null, dmThread: [], dmError: null });
  void refreshDmInbox();
}

/**
 * A tapped notification, or a launch URL carrying `?dm=<id>`.
 *
 * Called before bootSocial, which strips the query string once it has read its
 * own params — running second would mean the deep link only worked when no
 * referral was attached to the same URL.
 */
export function bootDm(): void {
  const id = new URLSearchParams(window.location.search).get('dm');
  if (!id) return;
  history.replaceState(null, '', window.location.pathname);
  // Sign-up has to happen first for a brand-new device; the id is kept so the
  // thread opens the moment there is an account to open it as.
  if (store.get().me) openDm(id);
  else store.set({ dmPending: id });
}

/** Act on a deep link that arrived before the account existed. */
export function resumeDm(): void {
  const id = store.get().dmPending;
  if (!id || !store.get().me) return;
  store.set({ dmPending: null });
  openDm(id);
}

// ── polling ────────────────────────────────────────────────────────────────

/**
 * Keep the open thread live. Fast, foreground-only, and running only while a
 * conversation is actually on screen.
 */
export function startDmSync(): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = () => {
    const { dmWith, dmOpen } = store.get();
    if (dmOpen && dmWith) void loadDmThread(dmWith.id);
    else void refreshDmInbox();
  };

  const start = () => {
    stop();
    timer = setInterval(tick, IDLE_MS);
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  const onVis = () => {
    if (document.visibilityState === 'visible') {
      tick();
      start();
    } else stop();
  };

  document.addEventListener('visibilitychange', onVis);
  start();
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVis);
  };
}
