// The wallet's data, from the server.
//
// Every number here is the server's. The app used to hold its own copy of the
// Star pack prices and its own seeded list of "transactions" — so the screen
// people open to ask "what happened to my money?" answered with fiction, and
// the price shown wasn't necessarily the price charged.
import { store } from './store';

/** One line in the money story — a Star move or a card payment. */
export interface Activity {
  id: string;
  at: string;
  /** 'stars', or a currency code for money. */
  unit: string;
  /** Stars: signed count. Money: negative cents, because money leaves you. */
  delta: number;
  title: string;
  detail: string | null;
  kind: string;
  /** done | pending | failed | refunded | disputed */
  state: string;
}

export interface Pack { stars: number; cents: number; price: string }

export interface PayStatus {
  mode: string;
  stars_sale?: boolean;
  packs?: Pack[];
}

/**
 * Format one row's amount the way a person reads it.
 *
 * Stars and money share a list, so the SIGN has to mean the same thing in
 * both halves: minus is "left me". A mixed feed where the sign flips meaning
 * halfway down is worse than two separate lists.
 */
export function amountOf(a: Activity): string {
  if (a.unit === 'stars') {
    return `${a.delta > 0 ? '+' : '−'}★${Math.abs(a.delta).toLocaleString()}`;
  }
  const n = Math.abs(a.delta) / 100;
  const money = n.toLocaleString('en-US', {
    minimumFractionDigits: Math.abs(a.delta) % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `−$${money}`;
}

/** A short, human "when". Exact timestamps are noise on a wallet row. */
export function whenOf(at: string): string {
  const t = Date.parse(at.includes('T') ? at : `${at.replace(' ', 'T')}Z`);
  if (Number.isNaN(t)) return '';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * Anything that isn't settled gets said out loud. A payment stuck in flight,
 * or one that was refunded, is precisely what someone opened the wallet to
 * find — hiding it behind a clean-looking row is how support tickets start.
 */
export function stateNote(a: Activity): string | null {
  switch (a.state) {
    case 'pending': return 'Still going through';
    case 'failed': return 'Didn’t go through';
    case 'refunded': return 'Refunded';
    case 'disputed': return 'Disputed — we’re on it';
    default: return null;
  }
}

export async function refreshActivity(): Promise<void> {
  const me = store.get().me;
  if (!me) return;
  try {
    const out = await fetch(`/api/pay/activity?me=${encodeURIComponent(me.id)}`)
      .then((r) => r.json()) as { activity?: Activity[] };
    store.set({ activity: out.activity ?? [] });
  } catch {
    // A wallet that can't reach the server should show what it last knew
    // rather than blanking — the previous list is still true, just older.
  }
}
