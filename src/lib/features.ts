// Every feature has a door on TODAY.
//
// 18 Sep 2026: "every feature accessible like a widget, each with their own
// cover and button that leads into their own page." Until now a guest found
// flights, charter or a runner only by knowing to type the words. This is the
// registry the home grid (FeatureGrid) and the pages (FeaturePage) render from.
//
// ── WHAT A PAGE DOES IN THIS VERSION ──────────────────────────────────────
//
// Cover, one-line promise, two or three fields, one button — and then NUM
// takes it in the thread with the details already in the ask. The page does
// not book anything itself. That is deliberate: the concierge already knows
// how to hold a table, order a car, open the right delivery app prefilled and
// say honestly what it cannot do; a second booking flow per feature would be
// slower to build and would drift from it. A page is the fastest honest way
// to start the right conversation.
//
// Covers are Pexels photographs under the free licence (commercial use, no
// attribution required) — app-public/covers/CREDITS.md lists the ids. Rule
// carried over from the videos: no identifiable face, no real brand or
// business name in frame.
import { store } from './store';

export type FeatureId =
  | 'flights' | 'stays' | 'tables' | 'tonight' | 'charter' | 'rides'
  | 'pickup' | 'hire' | 'wellness' | 'events' | 'plans' | 'wallet';

export interface FeatureField {
  id: string;
  label: string;
  placeholder: string;
  type?: 'text' | 'date' | 'time' | 'number';
  optional?: boolean;
  /** Prefill from state at open — e.g. the resolved place. */
  fromPlace?: boolean;
  /** Short answer (an airport code, a number): shares a row with its neighbour. */
  half?: boolean;
}

export interface FeatureLane { id: string; label: string }

export interface Feature {
  id: FeatureId;
  kicker: string;
  title: string;
  promise: string;
  cover: string;
  cta: string;
  lanes?: FeatureLane[];
  fields?: FeatureField[];
  /** The ask NUM receives. Values are trimmed; empty optional fields are ''. */
  compose?: (v: Record<string, string>, lane: string | null) => string;
  /** Opens an existing sheet instead of a page (Plans, Events, Wallet). */
  opens?: () => void;
  /** A second door on the page, for the feature's own board. */
  secondary?: { label: string; open: () => void };
  /** Said under the button. Where NUM hands off to another app, say so first. */
  honest?: string;
}

// "at 8pm" and "at 6:30am tomorrow" read right; "at this afternoon" does not,
// and the audit on 18 Sep 2026 sent exactly that to the model. Only a value
// that STARTS with a clock time takes "at"; everything else is already a
// phrase ("this afternoon", "Saturday 10am", "tonight").
const when = (v: string) => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return /^\d{1,2}(:\d{2})?\s*(am|pm)?\b/i.test(s) ? ` at ${s}` : ` ${s}`;
};
const on = (v: string) => (v ? ` on ${v}` : '');

/**
 * The 640px cut of a cover, for a grid tile.
 *
 * Every cover ships twice — `x.webp` at 1600px for the feature page's
 * full-width header and `x-sm.webp` at 640px for the tile. One file for both
 * meant either soft tiles (the 900px original upscaled on a 3× screen) or two
 * megabytes of photographs on the first screen of the app.
 */
export const tileCover = (cover: string): string => cover.replace(/\.webp$/, '-sm.webp');

export const FEATURES: readonly Feature[] = [
  {
    id: 'flights', kicker: 'FLIGHTS', title: 'Find a flight', cover: '/covers/flights.webp', cta: 'Search fares',
    promise: 'Live fares, the hidden stops said out loud, and the one to book. Save any fare to check it again later.',
    fields: [
      { id: 'from', label: 'From', placeholder: 'BKK', type: 'text', half: true },
      { id: 'to', label: 'To', placeholder: 'NRT', type: 'text', half: true },
      { id: 'date', label: 'Leaving', placeholder: '', type: 'date', half: true },
      { id: 'ret', label: 'Back (optional)', placeholder: '', type: 'date', optional: true, half: true },
    ],
    compose: (v) => `Find me flights from ${v.from} to ${v.to}${on(v.date)}${v.ret ? `, returning ${v.ret}` : ''}. Live fares, and tell me which one you'd take.`,
  },
  {
    id: 'stays', kicker: 'STAYS', title: 'Somewhere to sleep', cover: '/covers/stays.webp', cta: 'Find a place',
    promise: 'Three real places with the trade-offs said plainly, and the one NUM would pick for you.',
    fields: [
      { id: 'where', label: 'Where', placeholder: 'Sukhumvit, Bangkok', fromPlace: true },
      { id: 'checkin', label: 'Check-in', placeholder: '', type: 'date' },
      { id: 'nights', label: 'Nights', placeholder: '3', type: 'number' },
    ],
    compose: (v) => `Find me somewhere to stay in ${v.where}${v.checkin ? ` from ${v.checkin}` : ''}${v.nights ? ` for ${v.nights} night${v.nights === '1' ? '' : 's'}` : ''}. Three options with the trade-offs, and the one you'd pick.`,
  },
  {
    id: 'tables', kicker: 'TABLES', title: 'Book a table', cover: '/covers/tables.webp', cta: 'Get a table',
    promise: 'Say the mood, the time and how many. NUM finds the room and holds it.',
    fields: [
      { id: 'what', label: 'What are you in the mood for', placeholder: 'quiet, Thai, near the river' },
      { id: 'when', label: 'When', placeholder: 'tonight 8pm' },
      { id: 'people', label: 'How many', placeholder: '2', type: 'number' },
    ],
    compose: (v) => `Book me a table${v.people ? ` for ${v.people}` : ''}${v.when ? ` ${v.when}` : ''}: ${v.what || 'something good nearby'}. Hold it if you can.`,
  },
  {
    id: 'tonight', kicker: 'TONIGHT', title: 'What’s on tonight', cover: '/covers/tonight.webp', cta: 'Show me',
    promise: 'Events, restaurants and bars near you right now — ranked, not listed.',
    compose: () => 'What’s on tonight near me? Events, food and bars — rank them and tell me where you’d start.',
  },
  {
    id: 'charter', kicker: 'PRIVATE', title: 'Plane, car or boat', cover: '/covers/charter.webp', cta: 'Ask a host',
    promise: 'Tell NUM what you need and it goes to the host network. Nothing is priced or held until a host comes back.',
    lanes: [{ id: 'plane', label: 'Plane' }, { id: 'car', label: 'Car' }, { id: 'boat', label: 'Boat' }],
    fields: [
      { id: 'route', label: 'Where to', placeholder: 'Phuket → Bangkok, or a day out of Phuket' },
      { id: 'when', label: 'When', placeholder: 'Saturday 10am' },
      { id: 'people', label: 'How many', placeholder: '4', type: 'number' },
    ],
    compose: (v, lane) => `I’d like to charter a private ${lane ?? 'plane, car or boat'}${v.people ? ` for ${v.people}` : ''}: ${v.route}${when(v.when)}. Can a host do this, and what would you need from me?`,
    honest: 'No host has listed a plane, car or boat yet. NUM takes the request, puts it to the network, and comes back — it will not quote a price it cannot stand behind.',
  },
  {
    id: 'rides', kicker: 'RIDES', title: 'Get a car', cover: '/covers/rides.webp', cta: 'Get a car',
    promise: 'Airport, hotel, across town. NUM picks the right app for this country and opens it filled in.',
    fields: [
      { id: 'to', label: 'Where to', placeholder: 'Suvarnabhumi Airport' },
      { id: 'when', label: 'When', placeholder: 'now, or 6:30am' },
    ],
    compose: (v) => `Get me a car to ${v.to}${when(v.when)}.`,
    honest: 'NUM has no account with Uber or Grab yet — it opens the right one prefilled, and says so.',
  },
  {
    id: 'pickup', kicker: 'PICK UP', title: 'Order for pickup', cover: '/covers/pickup.webp', cta: 'Order it',
    promise: 'Food, coffee, a pharmacy run. NUM finds the place, orders where it can, and tells you when to walk over.',
    fields: [
      { id: 'what', label: 'What', placeholder: 'two iced lattes and a croissant' },
      { id: 'from', label: 'From (optional)', placeholder: 'the café on Soi 11, or leave blank', optional: true },
      { id: 'when', label: 'Ready by', placeholder: '20 minutes' },
    ],
    compose: (v) => `Order ${v.what} for pickup${v.from ? ` from ${v.from}` : ' from somewhere good nearby'}${v.when ? `, ready in ${v.when}` : ''}. Tell me where to walk to and when.`,
    honest: 'Where a partner delivers to you, NUM orders it directly. Otherwise it opens the delivery app prefilled.',
  },
  {
    id: 'hire', kicker: 'HIRE SOMEONE', title: 'Someone to run this', cover: '/covers/hire.webp', cta: 'Hire someone',
    promise: 'An errand, a queue, a pickup across town, a pair of hands for an afternoon. Say what, where and by when.',
    fields: [
      { id: 'what', label: 'What needs doing', placeholder: 'collect a package from the post office on Sathorn' },
      { id: 'where', label: 'Where', placeholder: 'Sathorn, Bangkok', fromPlace: true },
      { id: 'when', label: 'By when', placeholder: 'before 5pm today' },
    ],
    compose: (v) => `I need someone to ${v.what}${v.where ? ` in ${v.where}` : ''}${v.when ? `, ${v.when}` : ''}. Who can do it, and what does it cost?`,
    secondary: { label: 'See the errand board', open: () => store.set({ featureOpen: null, errandsOpen: true }) },
    honest: 'Stars are held until the job is done, and the runner sees exactly what you see.',
  },
  {
    id: 'wellness', kicker: 'WELLNESS', title: 'Massage, spa, an assistant', cover: '/covers/wellness.webp', cta: 'Find one',
    promise: 'Real places with real ratings, or a PA for the day. NUM matches the register you write in.',
    lanes: [{ id: 'massage', label: 'Massage' }, { id: 'spa', label: 'Spa' }, { id: 'personal assistant', label: 'PA' }],
    fields: [
      { id: 'where', label: 'Where', placeholder: 'near my hotel', fromPlace: true },
      { id: 'when', label: 'When', placeholder: 'this afternoon' },
      { id: 'notes', label: 'Anything else (optional)', placeholder: 'deep tissue, 90 minutes', optional: true },
    ],
    compose: (v, lane) => `Find me a ${lane ?? 'massage'}${v.where ? ` near ${v.where}` : ' nearby'}${when(v.when)}.${v.notes ? ` ${v.notes}.` : ''} Real places only.`,
  },
  {
    // 18 Sep 2026: this tile used to open EventSheet, which is the HOST's side
    // — "host one, invite by text, watch the RSVPs land". A guest who tapped a
    // tile promising concerts and matches got a form asking what they were
    // hosting. Tickets live in the thread (Ticketmaster, worker/events.tm.mjs),
    // so the ask goes there and hosting keeps its own door below.
    id: 'events', kicker: 'EVENTS', title: 'Tickets & events', cover: '/covers/events.webp', cta: 'See what’s on',
    promise: 'Concerts, matches, club nights — what’s on while you’re here, with a real way to get in.',
    fields: [
      { id: 'when', label: 'When', placeholder: 'this weekend', half: true },
      { id: 'what', label: 'What sort (optional)', placeholder: 'live music, football, a club night', optional: true, half: true },
    ],
    compose: (v) => `What’s on ${v.when || 'while I’m here'}${v.what ? ` — ${v.what}` : ''}? Real events with a way to get tickets, and which one you’d go to.`,
    secondary: { label: 'Host your own event', open: () => store.set({ featureOpen: null, eventOpen: true }) },
  },
  {
    id: 'plans', kicker: 'PLANS', title: 'Plan with friends', cover: '/covers/plans.webp', cta: 'Open plans',
    promise: 'One plan the whole group can see; everyone’s NUM hears about what gets booked.',
    opens: () => store.set({ featureOpen: null, partyOpen: true }),
  },
  {
    id: 'wallet', kicker: 'WALLET', title: 'Stars & tabs', cover: '/covers/wallet.webp', cta: 'Open wallet',
    promise: 'What you’ve paid, what’s held, what’s open — in your currency.',
    opens: () => store.set({ featureOpen: null, walletOpen: true }),
  },
];

export const featureById = (id: FeatureId | null | undefined): Feature | undefined =>
  id ? FEATURES.find((f) => f.id === id) : undefined;

/** Open a feature: its own page, or the sheet it already has. */
export function openFeature(id: FeatureId): void {
  const f = featureById(id);
  if (!f) return;
  if (f.opens) { f.opens(); return; }
  store.set({ featureOpen: id });
}
