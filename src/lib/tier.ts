/**
 * Which plan this member is on, for the one place the app wants to know
 * cheaply: the line under a fresh booking (UpgradeNudge in ThreadView).
 *
 * The server is the truth (/api/membership/me). This caches it per member
 * for the session and refreshes when the wallet changes hands, so a card in
 * the thread does not fire a request per render.
 */
import { useEffect, useState } from 'react';
import { store, useApp } from './store';
import { apiUrl } from './apibase';

export type Tier = 'free' | 'plus' | 'pro' | string;

let cachedFor: string | null = null;
let cached: Tier | null = null;
let inflight: Promise<Tier> | null = null;

export async function tierOf(meId: string | null | undefined): Promise<Tier> {
  if (!meId) return 'free';
  if (cachedFor === meId && cached) return cached;
  if (cachedFor === meId && inflight) return inflight;
  cachedFor = meId;
  inflight = fetch(apiUrl(`/api/membership/me?me=${encodeURIComponent(meId)}`))
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { tier?: string } | null) => { cached = d?.tier ?? 'free'; return cached; })
    .catch(() => 'free')
    .finally(() => { inflight = null; });
  return inflight;
}

/** Forget what we knew — after a subscribe, so the nudge stops at once. */
export function forgetTier(): void { cached = null; cachedFor = null; }

export function useTier(): Tier | null {
  const me = useApp((s) => s.me);
  const [tier, setTier] = useState<Tier | null>(cachedFor === me?.id ? cached : null);
  useEffect(() => {
    let live = true;
    void tierOf(me?.id).then((t) => { if (live) setTier(t); });
    return () => { live = false; };
  }, [me?.id]);
  return tier;
}

/** The nudge's own words. One line, no travel benefits, no fee claim. */
export const NUDGE = 'Want more room? Plus and Pro lift the ceilings.';
export const NUDGE_CTA = 'See plans';

/** Whether a booking card should carry the nudge: web/Android only, free tier only. */
export const shouldNudge = (tier: Tier | null, canOffer: boolean): boolean => canOffer && tier === 'free';

export const openPlans = (): void => store.set({ walletOpen: true });
