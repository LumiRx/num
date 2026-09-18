// Saved flights — so a fare somebody liked does not have to be found twice.
//
// A live fare has a shelf life (offer.validUntil); the SEARCH does not. What
// we keep is the shape of the flight — route, day, times, carrier, the price
// it was seen at and when — and the query that produced it, so "search this
// again" is one tap and NUM re-checks the price rather than the guest
// re-typing the ask. Kept on the phone (persisted state), no account needed.
import { store } from './store';
import type { FlightOffer, FlightQuery } from './flights';
import { legWindow, offerSummary } from './flights';

export interface SavedFlight {
  id: string;
  savedAt: string;
  query: FlightQuery;
  offerId: string;
  route: string;          // "BKK → NRT"
  day: string;            // "2026-10-03"
  window: string | null;  // "07:35 → 15:20 +1"
  carrier: string | null;
  durationMin: number;
  stops: number;
  price: string | null;
  currency: string | null;
  seenAt: string;         // when this price was seen
  summary: string;
}

const keyFor = (o: FlightOffer, q: FlightQuery) => {
  const seg = o.legs[0]?.segments ?? [];
  return `${q.fromCode}|${q.toCode}|${(seg[0]?.departs ?? q.depart).slice(0, 16)}|${o.validatingCarrier ?? ''}|${seg.map((s) => s.marketing).join('/')}`;
};

export const isSaved = (o: FlightOffer, q: FlightQuery): boolean =>
  store.get().savedFlights.some((f) => f.id === keyFor(o, q));

export function saveOffer(o: FlightOffer, q: FlightQuery): void {
  const id = keyFor(o, q);
  const leg = o.legs[0];
  const seg = leg?.segments ?? [];
  const entry: SavedFlight = {
    id,
    savedAt: new Date().toISOString(),
    query: q,
    offerId: o.id,
    route: `${q.fromCode} → ${q.toCode}`,
    day: (seg[0]?.departs ?? q.depart).slice(0, 10),
    window: leg ? legWindow(leg) : null,
    carrier: o.validatingCarrier,
    durationMin: o.totalDurationInMinutes,
    stops: leg?.stops ?? 0,
    price: o.price,
    currency: o.currency,
    seenAt: new Date().toISOString(),
    summary: offerSummary(o, q),
  };
  store.set((s) => ({ savedFlights: [entry, ...s.savedFlights.filter((f) => f.id !== id)].slice(0, 30) }));
}

export function forgetSaved(id: string): void {
  store.set((s) => ({ savedFlights: s.savedFlights.filter((f) => f.id !== id) }));
}

/** The ask that re-runs this search — NUM re-checks the price, the guest types nothing. */
export function researchAsk(f: SavedFlight): string {
  const back = f.query.ret ? `, returning ${f.query.ret}` : '';
  const who = f.query.adults && f.query.adults > 1 ? ` for ${f.query.adults} people` : '';
  return `Check flights ${f.query.fromCode} → ${f.query.toCode} on ${f.query.depart}${back}${who} — I saved ${f.carrier ?? 'one'} at ${f.currency ?? ''} ${f.price ?? ''} leaving ${f.window?.split(' ')[0] ?? ''}. Is that still the one, or is there better now?`;
}
