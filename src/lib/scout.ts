// The scout dashboard, read from the server and never computed here.
//
// The one rule this file exists to hold: the money shown is what the server
// says has been EARNED, not introductions multiplied by a fee. Two signatures
// times $5 is $10 and would be wrong, and it is exactly the sum a scout will
// do in their head if the page invites it.
import { apiUrl } from './apibase';

export type ScoutState = 'introduced' | 'verified' | 'activated' | 'rejected' | 'void';

export type ScoutPlace = {
  id: string;
  place_id: string;
  biz_name: string;
  dest: string | null;
  state: ScoutState;
  revenue_minor: number;
  introduced_at: string;
  verified_at: string | null;
  activated_at: string | null;
};

export type ScoutDashboard = {
  ok: boolean;
  why?: string;
  scout: { id: string; name: string; code: string; status: string; country: string | null };
  terms: {
    version: string; finder_cents: number; finder_gate_minor: number;
    share_bps: number; sub_share_bps: number; term_months: number; note: string;
  };
  businesses: {
    total: number;
    byState: Record<ScoutState, number>;
    meaning: Record<ScoutState, string>;
    list: ScoutPlace[];
  };
  friends: { count: number; note: string | null };
  referrals?: {
    count: number;
    people: { name: string; code: string; joined: string }[];
    earned_minor: number;
    note: string | null;
  };
  /**
   * Null when the milestone tables could not be read. The sheet must render
   * the money either way — an Expert who cannot see their earnings because a
   * badge query failed is the worse outcome by a distance.
   */
  milestones?: {
    counts: { introduced: number; activated: number; experts: number };
    reached: { key: string; label: string; threshold: number; reached_at: string; bonus_cents: number }[];
    next: { key: string; label: string; note: string; have: number; need: number; bonus_cents: number } | null;
    gate: { biz_name: string; dest: string | null; needs_minor: number; releases_minor: number; note: string } | null;
    note: string;
  } | null;
  money: {
    accrued_minor: number; payable_minor: number; paid_minor: number;
    total_minor?: number;
    /** Why nothing can move yet, said beside the number rather than in a FAQ. */
    blocked?: string | null;
    meaning?: Record<string, string>;
    note: string;
  };
  cap: { monthly: number; used: number; left: number };
};

export async function scoutDashboard(memberId: string): Promise<ScoutDashboard | null> {
  try {
    const res = await fetch(apiUrl(`/api/scouts/me?me=${encodeURIComponent(memberId)}`));
    if (!res.ok) return null;
    const body = (await res.json()) as ScoutDashboard;
    return body?.ok ? body : null;
  } catch {
    return null;
  }
}

/** Minor units to a plain string. No rounding up, ever. */
export function money(minor: number): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${(Math.floor(n) / 100).toFixed(2)}`;
}

/** The share rates, said as percentages a person can check against their terms. */
export function pct(bps: number): string {
  const n = Number(bps);
  if (!Number.isFinite(n)) return '0%';
  return `${n / 100}%`;
}
