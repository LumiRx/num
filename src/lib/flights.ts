// Real fares, in the thread.
//
// The one guarantee this file exists to keep: **a price shown here came back
// from Sabre, not from the model.** The search runs as its own call after the
// turn, and the result is rendered as data rather than folded into prose the
// model wrote. A language model that has been told the fare is $383.90 will
// happily repeat it, and will just as happily repeat it tomorrow when it is
// not — so the number never travels through the model at all.
import { store } from './store';

export interface FlightOffer {
  id: string;
  price: string | null;
  currency: string | null;
  tax: string | null;
  validatingCarrier: string | null;
  validUntil: string | null;
  totalDurationInMinutes: number;
  legs: Array<{
    stops: number;
    segments: Array<{
      from: string; to: string; departs: string; arrives: string;
      marketing: string; operating: string; codeshare: boolean;
      cabin?: string | null; bookingClass?: string | null; brand?: string | null;
      durationInMinutes?: number | null;
      hiddenStops?: Array<{ airportCode: string; durationInMinutes?: number }>;
    }>;
  }>;
  /** Set by a flight check: true only when the exact fare came back unchanged. */
  isSameFare?: boolean;
  hiddenStops?: Array<{ airportCode: string; durationInMinutes?: number }>;
}

export interface FlightQuery {
  fromCode: string; toCode: string; depart: string; ret?: string | null;
  adults?: number; cabin?: string | null; from?: string | null; to?: string | null;
}

/** "2h 45m" — minutes are how the API talks and not how anybody thinks. */
export const duration = (mins?: number | null): string => {
  if (!mins || mins <= 0) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h${m ? ' ' + m + 'm' : ''}` : `${m}m`;
};

/** An offer has a shelf life; past it, the price is a memory of a price. */
export const stillValid = (o: FlightOffer): boolean =>
  !o.validUntil || Date.parse(o.validUntil) > Date.now();

export async function runFlightSearch(q: FlightQuery): Promise<void> {
  const journeys: Array<Record<string, unknown>> = [
    { departureLocation: { airportCode: q.fromCode }, arrivalLocation: { airportCode: q.toCode }, departureDate: q.depart },
  ];
  // A return is a second journey, not a flag — that is how the API models it
  // and it keeps multi-city working for free later.
  if (q.ret) {
    journeys.push({ departureLocation: { airportCode: q.toCode }, arrivalLocation: { airportCode: q.fromCode }, departureDate: q.ret });
  }

  store.set({ flightSearching: true });
  try {
    const res = await fetch('/api/sabre/flights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        journeys,
        travelers: Array.from({ length: Math.max(1, q.adults ?? 1) }, () => ({ passengerTypeCode: 'ADT' })),
        ...(q.cabin ? { fare: { cabin: { name: q.cabin } } } : {}),
        limit: 5,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { offers?: FlightOffer[]; error?: string };
    store.set({
      flightSearching: false,
      flightOffers: res.ok && body.offers?.length ? { query: q, offers: body.offers } : null,
      // The failure is worth surfacing rather than swallowing: "no flights"
      // and "the fare service is down" are different answers and a traveller
      // deserves to know which one they got.
      flightError: res.ok
        ? body.offers?.length
          ? null
          : `Nothing came back for ${q.fromCode}→${q.toCode} on ${q.depart}.`
        : (body.error ?? 'The fare search didn’t answer.'),
    });
  } catch {
    store.set({ flightSearching: false, flightError: 'The fare search didn’t answer.' });
  }
}

/**
 * Revalidate one offer against the airline before anyone commits.
 *
 * Returns whether the EXACT fare survived. "Same cabin" means the airline
 * substituted something — still real, still bookable, and not what the
 * traveller was looking at, so the caller has to say so.
 */
export async function checkOffer(o: FlightOffer, q: FlightQuery): Promise<{ ok: boolean; same: boolean; message: string }> {
  const journeys = o.legs.map((l) => ({
    flights: l.segments.map((sg) => ({
      departureAirportCode: sg.from,
      departureDate: sg.departs.slice(0, 10),
      departureTime: sg.departs.slice(11, 16),
      arrivalAirportCode: sg.to,
      arrivalDate: sg.arrives.slice(0, 10),
      arrivalTime: sg.arrives.slice(11, 16),
      marketingAirlineCode: sg.marketing.replace(/\d+$/, ''),
      marketingFlightNumber: Number(sg.marketing.replace(/^\D+/, '')) || 1,
      ...(sg.bookingClass ? { segmentDetails: { bookingClassCode: sg.bookingClass } } : {}),
    })),
  }));

  try {
    const res = await fetch('/api/sabre/flight-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        journeys,
        travelers: Array.from({ length: Math.max(1, q.adults ?? 1) }, () => ({ passengerTypeCode: 'ADT' })),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { offers?: FlightOffer[]; error?: string };
    if (!res.ok) return { ok: false, same: false, message: body.error ?? 'Couldn’t re-check that one.' };
    const checked = body.offers?.[0];
    if (!checked) return { ok: false, same: false, message: 'That fare has gone — want me to search again?' };

    // Keep the ORIGINAL id. A flight check comes back with its own fresh
    // offer id, and spreading it over the shopped offer silently renames the
    // row — after which anything keyed by the old id (the verdict text, React's
    // own key) points at a row that no longer exists, and the answer renders
    // to nothing. The price and validation are what we want from the check;
    // the identity stays the one the UI is already holding.
    store.set((st) =>
      st.flightOffers
        ? {
            flightOffers: {
              ...st.flightOffers,
              offers: st.flightOffers.offers.map((x) => (x.id === o.id ? { ...x, ...checked, id: x.id } : x)),
            },
          }
        : {},
    );
    return {
      ok: true,
      same: !!checked.isSameFare,
      message: checked.isSameFare
        ? `Re-checked — still ${checked.currency} ${checked.price}, live right now.`
        : `That exact fare has gone. The airline is offering ${checked.currency} ${checked.price} instead — same cabin, different fare.`,
    };
  } catch {
    return { ok: false, same: false, message: 'Couldn’t re-check that one.' };
  }
}
