// THE TWO ENDS OF A SUBSCRIPTION: LANDING BACK, AND LEAVING.
//
// ── WHAT WAS MISSING ─────────────────────────────────────────────────────
//
// 16 Sep 2026, traced end to end against production:
//
//   tiers list            ✅ live
//   subscribe             ✅ mints a real cs_live_ Stripe session
//   webhook → grantTier   ✅ code exists and is tested
//   COMING BACK           ❌ Stripe returns to `/?paid=cs_live_…` and NOTHING
//                            read that parameter. A member paid, landed on the
//                            normal app screen, and had to guess.
//   CANCELLING            ❌ /api/membership/cancel exists, with a comment
//                            saying "cancelling has to be as easy as joining".
//                            Nothing in the app ever called it.
//
// Both ends of the relationship were missing. This file is both.
//
// ── WHY CONFIRMATION POLLS ───────────────────────────────────────────────
//
// The tier is granted by Stripe's WEBHOOK, not by the redirect. Those race:
// the browser often gets back before the webhook lands. So confirming by
// reading the tier once would tell a paying member "you're on free" a second
// after they paid, which is the worst possible moment to be wrong.
//
// So it polls — briefly, with a ceiling — and when the ceiling is reached it
// says the honest thing: the payment went through, the account is catching up.
// It never claims the upgrade failed, because it almost certainly did not, and
// it never claims it succeeded before the server says so.
import { apiUrl } from './apibase';

/** How long to wait for the webhook before saying "catching up". */
const TRIES = 6;
const GAP_MS = 1200;

export type Mine = {
  tier: string;
  name?: string;
  renews_at?: string | null;
  since?: string | null;
  entitlements?: Record<string, boolean | number | null>;
};

export const fetchMine = async (meId: string): Promise<Mine | null> => {
  try {
    const r = await fetch(apiUrl(`/api/membership/me?me=${encodeURIComponent(meId)}`));
    return r.ok ? (await r.json()) as Mine : null;
  } catch { return null; }
};

/** The `?paid=` Stripe sends us back with, or null. */
export function paidParam(search = window.location.search): string | null {
  try {
    const v = new URLSearchParams(search).get('paid');
    return v && /^cs_[A-Za-z0-9_]+$/.test(v) ? v : null;
  } catch { return null; }
}

/**
 * Take `?paid=` off the address bar without reloading or adding history.
 *
 * replaceState, not pushState: a member who hits Back should go where they were
 * going, not re-trigger a confirmation for a payment they already made.
 */
export function clearPaidParam(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('paid')) return;
    url.searchParams.delete('paid');
    window.history.replaceState({}, '', url.toString());
  } catch { /* old browser, cosmetic only */ }
}

export type Landed =
  | { state: 'upgraded'; tier: string; name: string; renews_at?: string | null }
  | { state: 'pending' }
  | { state: 'unknown' };

/**
 * Did the payment actually land on the account?
 *
 * `was` is the tier BEFORE checkout. Comparing against it — rather than
 * checking for "not free" — is what makes a Plus→Pro upgrade confirm correctly
 * instead of reporting success the moment it sees any paid tier.
 */
export async function confirmPaid(
  meId: string,
  was: string,
  { tries = TRIES, gap = GAP_MS, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) } = {},
): Promise<Landed> {
  if (!meId) return { state: 'unknown' };
  for (let i = 0; i < tries; i += 1) {
    const mine = await fetchMine(meId);
    if (mine && mine.tier && mine.tier !== was) {
      return { state: 'upgraded', tier: mine.tier, name: mine.name ?? mine.tier, renews_at: mine.renews_at ?? null };
    }
    if (i < tries - 1) await sleep(gap);
  }
  // Money moved; the account has not caught up yet. NOT a failure, and it must
  // never be shown as one — Stripe has the payment either way.
  return { state: 'pending' };
}

export type Cancelled = { ok: boolean; note?: string; error?: string };

/**
 * Cancel. The server decides what happens and says it in its own words.
 *
 * The note is passed straight through rather than rewritten here, because the
 * server knows things this file does not: whether the plan runs to a period
 * end, whether it was a legacy one-off that simply expires, or whether they
 * were on free all along.
 */
export async function cancelSubscription(meId: string): Promise<Cancelled> {
  if (!meId) return { ok: false, error: 'Not signed in.' };
  try {
    const r = await fetch(apiUrl('/api/membership/cancel'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ me: meId }),
    });
    const out = await r.json() as Cancelled;
    if (out?.ok) return out;
    return { ok: false, error: out?.error ?? 'Could not cancel just now.' };
  } catch {
    return { ok: false, error: 'Could not reach the server — nothing was changed.' };
  }
}
