// The member's own crypto wallet, as the app sees it.
//
// Deliberately thin: the server decides whether a wallet exists, whether one
// may be made, and what is in it. Nothing here caches a balance, because a
// stale balance is the one number a person will act on.
//
// The rule this file exists to keep visible in the UI layer too: this is NOT
// the Stars balance. They are two assets and they are never added together —
// see worker/balances.mjs on why `held` and `owed` are never netted.
import { apiUrl } from './apibase';
import { guestMessage } from './saferr';

export interface MemberWallet {
  wallet: { address: string; chain: string; created_at?: string } | null;
  balance: { units: string; display: string; symbol: string; chain: string } | null;
  available?: boolean;
  why?: string | null;
  note?: string;
}

export async function loadMemberWallet(meId: string): Promise<MemberWallet | null> {
  try {
    const r = await fetch(apiUrl(`/api/wallet?me=${encodeURIComponent(meId)}`));
    if (!r.ok) return null;
    return (await r.json()) as MemberWallet;
  } catch {
    return null;
  }
}

export async function createMemberWallet(meId: string): Promise<{ ok: true; address: string } | { ok: false; error: string }> {
  try {
    const r = await fetch(apiUrl(`/api/wallet/create?me=${encodeURIComponent(meId)}`), { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: guestMessage(new Error(String(body?.error ?? '')), 'Could not make a wallet just now.', 'wallet') };
    }
    return { ok: true, address: String(body?.wallet?.address ?? '') };
  } catch (e) {
    return { ok: false, error: guestMessage(e, 'You seem to be offline.', 'wallet') };
  }
}

/** 0x1234…abcd. A 42-character string is not something anyone reads off a screen. */
export const shortAddress = (a: string) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '');
