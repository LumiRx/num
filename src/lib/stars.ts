// Stars, from the app's side. The server owns the balance — this module only
// asks and displays. Anything that looks like arithmetic on a balance here
// would be a bug waiting to happen.
import { store } from './store';


async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api/social' + path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `stars ${res.status}`);
  return body as T;
}

export interface StarMove {
  id: string; delta: number; kind: string; note: string | null;
  counterparty: string | null; other_name: string | null; created_at: string;
}

export async function refreshStars(): Promise<void> {
  const me = store.get().me;
  if (!me) return;
  try {
    const out = await api<{ balance: number; moves: StarMove[] }>(`/stars?me=${encodeURIComponent(me.id)}`);
    store.set({ stars: out.balance, starMoves: out.moves });
  } catch (err) {
    console.warn('[stars]', err);
  }
}

/**
 * Pay someone. `idem` is minted per attempt and reused on retry, so a flaky
 * connection or a double-tap can never take the money twice.
 */
export async function payStars(to: string, amount: number, note?: string, idem?: string): Promise<{ ok: boolean; message: string }> {
  const me = store.get().me;
  if (!me) return { ok: false, message: 'Add your name and number first.' };
  try {
    const out = await api<{ ok?: boolean; already?: boolean; balance: number; to: string; amount?: number }>('/pay', {
      method: 'POST',
      body: JSON.stringify({ me: me.id, to, amount, note, idem: idem ?? crypto.randomUUID() }),
    });
    store.set({ stars: out.balance });
    void refreshStars();
    return { ok: true, message: out.already ? `Already sent to ${out.to}.` : `Sent ★${amount} to ${out.to}.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'That didn’t go through.' };
  }
}

export { payLink, connectLink } from './links';
