// THE PAPERWORK PACK, read by the widget that finally opens it.
//
// Everything here was built server-side weeks ago and had no door:
// traveldocs.mjs (40 countries of entry documents, every link an official
// government host), vaccines.mjs, insurancereq.mjs, and travelpack.mjs which
// assembles all three, dates them and puts them in deadline order.
//
// `/api/travel/pack` returns the assembled pack already split into what is
// free and what is not. This module is the type and the one call.
import { apiUrl } from './apibase';

/** The kinds travelpack.mjs emits. `free` is decided there, not here. */
export type PackKind =
  | 'official_link' | 'official_form' | 'requirement' | 'emergency'
  | 'consulate' | 'checklist' | 'timeline' | 'printable';

export interface PackItem {
  kind: PackKind;
  paid: boolean;
  title: string;
  url: string | null;
  detail: string | null;
  /** Deliberately unresolved by the server — whose passport decides. */
  appliesTo?: string | null;
  asOf?: string | null;
  by?: string | null;
}

export interface TravelPack {
  ok: boolean;
  why?: string;
  country: string;
  nationality: string | null;
  tripDate: string | null;
  daysOut: number | null;
  priceUsd: number;
  items: PackItem[];
  free: PackItem[];
  paid: PackItem[];
  /** Rules somebody widely repeats that no government page states. */
  unverified: string[];
  /** The sentence that has to be on the page, straight from the server. */
  promise: string;
}

/** Two letters, upper case, or null. A country code is the whole query. */
export const cc = (raw: string | null | undefined): string | null => {
  const s = String(raw ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
};

/**
 * Countries the traveller has passed through, which is what decides a yellow
 * fever rule. Free text in, country codes out; anything that is not two
 * letters is dropped rather than guessed at.
 */
export const routeCodes = (raw: string | null | undefined): string[] =>
  String(raw ?? '').split(/[,\s]+/).map((x) => cc(x)).filter((x): x is string => !!x);

export async function fetchPack(q: {
  to: string; nationality?: string | null; date?: string | null; from?: string[];
}): Promise<TravelPack | null> {
  const to = cc(q.to);
  if (!to) return null;
  const params = new URLSearchParams({ to });
  const nat = cc(q.nationality);
  if (nat) params.set('nationality', nat);
  if (q.date) params.set('date', q.date);
  if (q.from?.length) params.set('from', q.from.join(','));
  try {
    const res = await fetch(`${apiUrl('/api/travel/pack')}?${params.toString()}`);
    if (!res.ok) return null;
    return (await res.json()) as TravelPack;
  } catch {
    return null;
  }
}
