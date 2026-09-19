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
import { fmtDate } from './i18n';
import type { SharePayload } from './sharecard';
import { t } from './i18n';

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
  return e.url ? t('Price is on the ticket page') : null;
}

/** The button that leaves NUM, named after whose page it opens. */
/** A NUM-hosted event: a business's or host's own listing, RSVP'd on its /e/ page. */
export const hostedOnNum = (e: EventCard): boolean => e.source === 'num' && /\/e\/[A-Za-z0-9_-]+$/.test(e.url ?? '');

export function ticketLabel(e: EventCard): string | null {
  if (!e.url) return null;
  if (e.source === 'ticketmaster') return t('GET TICKETS ON TICKETMASTER');
  if (hostedOnNum(e)) return t('SAY YOU’RE COMING');
  return t('OPEN THE EVENT PAGE');
}

/**
 * Who is selling, said once, at the bottom.
 *
 * Ticketmaster asks for attribution on every listing and this is it in a
 * sentence; it also stops the sheet from reading like NUM took the money.
 */
export function sellerNote(e: EventCard): string | null {
  if (e.source === 'ticketmaster') return t('Tickets are sold by Ticketmaster. NUM holds nothing and charges nothing for them.');
  if (hostedOnNum(e)) return t('Hosted on NUM by a business or host. Your RSVP goes to them; any price is theirs.');
  if (e.url) return t('Tickets are sold on the event’s own page.');
  return null;
}

/**
 * The day, said the way a person says it: "Friday 18 September".
 *
 * The feeds carry an ISO day, and "Date: 2026-09-18" is a database talking.
 * Through fmtDate so it is the reader's own language and month order, and
 * null rather than "Invalid Date" when the feed sends something unparseable.
 */
export function dayLine(e: EventCard): string | null {
  if (!e.starts_on) return null;
  // Midday, so a timezone behind UTC cannot roll the date back a day.
  const d = new Date(`${e.starts_on}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' });
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
export async function keepEvent(e: EventCard, planId: string | null = store.get().planId): Promise<boolean> {
  if (!planId) return false;
  const { addPlanItem } = await import('./social');
  const item = await addPlanItem({
    plan_id: planId,
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

/**
 * KEEP IT ALWAYS LANDS SOMEWHERE (18 Sep 2026). "Open a plan first" was a
 * button that refused. With no plan open: one plan → that one; none → a new
 * plan named after the event, so the crew has somewhere to be invited to.
 * Several → the caller shows the picker (planChoices) and calls keepEvent
 * with the choice. Returns the plan the event went into, or null.
 */
export async function keepEventSomewhere(e: EventCard): Promise<{ planId: string; created: boolean } | null> {
  const s = store.get();
  if (s.planId) return (await keepEvent(e, s.planId)) ? { planId: s.planId, created: false } : null;
  if (s.plans.length === 1) return (await keepEvent(e, s.plans[0].id)) ? { planId: s.plans[0].id, created: false } : null;
  if (s.plans.length === 0) {
    const { createPlan } = await import('./social');
    const plan = await createPlan(e.title.slice(0, 60), s.place ?? null, e.starts_on ?? null);
    if (!plan) return null;
    return (await keepEvent(e, plan.id)) ? { planId: plan.id, created: true } : null;
  }
  return null; // several plans: the sheet asks which
}

/** The plans a kept event could go into, for the picker. */
export const planChoices = (): Array<{ id: string; title: string }> => store.get().plans.map((p) => ({ id: p.id, title: p.title }));
