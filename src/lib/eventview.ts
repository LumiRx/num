// An event, opened.
//
// Until 18 Sep 2026 tapping an event did one of two things: it threw you out
// of NUM into a Ticketmaster tab (the same complaint as the flights tab — you
// could not get back), or it dumped a question into the thread and you read
// the answer instead of the event. Neither is "looking at it".
//
// So: tapping opens a sheet inside NUM, built from the listing already in
// memory — no fetch, no spinner, it is simply there. Leaving for tickets is
// then a deliberate second tap, and it is labelled with whose page it is.
//
// WHAT THIS MODULE MAY AND MAY NOT SAY. Every line the sheet prints comes off
// the listing. Where the listing has no price, the sheet says where the price
// lives; it never prints a number, and it never says "booked" for a ticket
// NUM cannot sell (the 18 Aug bug, in a new coat). These rules live here as
// functions, next to each other, so they are one thing to read and one thing
// to test.
import { store } from './store';
import { near } from './near';
import type { SharePayload } from './sharecard';

export interface EventCard {
  source: 'num' | 'ticketmaster' | 'viator' | 'crew';
  id: string;
  title: string;
  /** The venue, or the line the feed put under the title. */
  sub: string | null;
  image: string | null;
  /** Where it came from, in words a guest reads: "Checked by NUM". */
  label: string;
  /** The one timing fact, already in words: "Doors in 1h 42m", "Tomorrow". */
  when: string | null;
  /** The calendar day, for the plan and for the share card. */
  starts_on?: string | null;
  venue?: string | null;
  distance_km?: number | null;
  /** Formatted by whoever had the currency, or null. Never built here. */
  cost?: string | null;
  /** NUM's reason for putting it forward, when it has one. */
  why?: string | null;
  /** The poster's page. Absent means there is nothing to leave NUM for. */
  url?: string | null;
}

export const openEventCard = (e: EventCard) => store.set({ eventView: e });
export const closeEventCard = () => store.set({ eventView: null });

/** The facts line: only the ones the listing actually carries. */
export function factsOf(e: EventCard): string[] {
  return [e.when, e.venue ?? e.sub, near(e.distance_km)].filter((v): v is string => !!v && v.trim() !== '');
}

/**
 * What it costs — or, honestly, where the cost is written.
 *
 * A ticket whose price sits on someone else's page is not free, and printing
 * nothing invites the reader to assume it is. Saying where to look is the
 * true sentence, and it is short.
 */
export function costOf(e: EventCard): string | null {
  if (e.cost && e.cost.trim()) return e.cost.trim();
  return e.url ? 'Price is on the ticket page' : null;
}

/** The button that leaves NUM, named after whose page it opens. */
export function ticketLabel(e: EventCard): string | null {
  if (!e.url) return null;
  return e.source === 'ticketmaster' ? 'GET TICKETS ON TICKETMASTER' : 'OPEN THE EVENT PAGE';
}

/**
 * Who is selling, said once, at the bottom.
 *
 * Ticketmaster asks for attribution on every listing and this is it in a
 * sentence; it also stops the sheet from reading like NUM took the money.
 */
export function sellerNote(e: EventCard): string | null {
  if (e.source === 'ticketmaster') return 'Tickets are sold by Ticketmaster. NUM holds nothing and charges nothing for them.';
  if (e.url) return 'Tickets are sold on the event’s own page.';
  return null;
}

/** "Plan the evening around it" — the ask, with only what is known. */
export function planAsk(e: EventCard): string {
  const at = e.venue ?? e.sub;
  const day = e.when ? ` (${e.when})` : '';
  return `Tell me about ${e.title}${at ? ` at ${at}` : ''}${day} and plan the evening around it — something to eat before, and a way home.`;
}

/** "Can you get me in" — for an event with no ticket page of its own. */
export function getInAsk(e: EventCard): string {
  const at = e.venue ?? e.sub;
  return `How do I get in to ${e.title}${at ? ` at ${at}` : ''}? Tell me what it costs and what you need from me.`;
}

/** The share card for an event: facts, no promises. */
export function shareOf(e: EventCard): SharePayload {
  return {
    kind: 'idea',
    title: e.title,
    summary: [e.title, ...factsOf(e)].join(' · '),
    place: e.venue ?? e.sub,
    day: e.starts_on ?? null,
    cost: e.cost ?? null,
    link: e.url ?? null,
  };
}

/**
 * Into the open plan as an idea, so the crew votes on it the way they vote on
 * everything else. An idea, not a booking: nobody has a ticket yet.
 *
 * Returns false when there is no plan open — the sheet then says so rather
 * than showing a button that quietly does nothing.
 */
export async function keepEvent(e: EventCard): Promise<boolean> {
  if (!store.get().planId) return false;
  const { addPlanItem } = await import('./social');
  const item = await addPlanItem({
    kind: 'idea',
    title: e.title,
    place: e.venue ?? e.sub,
    day: e.starts_on ?? null,
    cost: e.cost ?? null,
    note: [e.why, e.label].filter(Boolean).join(' · ') || null,
    photo: e.image,
  });
  return !!item;
}
