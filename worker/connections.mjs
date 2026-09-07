/**
 * WHAT NUM IS ACTUALLY CONNECTED TO — one source of truth, published.
 *
 * ── Why this is generated and not written (7 Sep 2026) ────────────────────
 *
 * Dre asked for the website to list the platforms and businesses Num works
 * with, because guests and businesses cannot use what they do not know exists.
 * He is right, and the obvious way to do it is the wrong way.
 *
 * A hand-written partners page is a CLAIM. It is true on the day it is typed
 * and it decays silently from then on: a key expires, a trial ends, a vendor
 * changes its terms, and the page keeps saying we do that. Nobody notices,
 * because a marketing page has no tests and nothing fails when it lies.
 *
 * So this reads the same registry the concierge itself reads — services.mjs
 * ADAPTERS, `connected(env, id)` — and reports what is CONFIGURED RIGHT NOW.
 * If a secret is missing the rail says "not connected" on the website within
 * one request. The page cannot claim a partner we do not have, because there
 * is no field for a claim.
 *
 * ── The three distinctions this file refuses to blur ──────────────────────
 *
 * These matter more than the list itself, because every one of them is a
 * promise a guest or a business could be let down by:
 *
 *   1. WE DO IT  vs  WE LINK YOU TO IT. Twenty-four booking platforms appear
 *      here and Num integrates with none of them — it recognises a venue's
 *      platform and sends the guest to that venue's own page with the details
 *      filled in. That is genuinely useful and it is not an integration, so
 *      `mode: 'deeplink'` says so and the copy is written from it.
 *   2. WE SHOP IT  vs  WE BOOK IT. Sabre and Duffel return real fares. Neither
 *      issues a ticket. `kind: 'flight_shop'` is not a typo — naming it
 *      'flight' is how a prompt ends up promising a ticket nobody holds.
 *   3. LIVE  vs  SANDBOX. DoorDash Drive answers, quotes and dispatches — in
 *      DoorDash's test environment. A courier will not arrive. A page that
 *      says "we deliver" on the strength of a sandbox is the most expensive
 *      kind of wrong, because a guest finds out after they have ordered.
 *
 * ── What it never contains ────────────────────────────────────────────────
 *
 * Booleans, never values. There is no code path here that reads a secret's
 * CONTENTS — `ready(env)` returns true or false and that is all that leaves
 * this file. The endpoint is public, so this is not a preference.
 */
import { ADAPTERS, connected } from './services.mjs';
import { PLATFORMS } from './booking.mjs';

/**
 * The human meaning of each rail: what a person actually gets, and who it is
 * for. Keyed by the same ids as ADAPTERS so a new rail without an entry here
 * is reported honestly as unexplained rather than silently dropped.
 */
export const MEANING = Object.freeze({
  doordash_drive: {
    title: 'DoorDash Drive',
    who: ['guest', 'business'],
    does: 'A courier between any two addresses — so a business with no driver can still deliver, and a guest can have something fetched.',
    caveat: 'Couriers will not carry cannabis or alcohol in most markets, whatever the local law says. Those deliveries go through the business’s own driver.',
  },
  sabre_air: { title: 'Sabre — flights', who: ['guest'], does: 'Live fares from the airline system travel agents use.', caveat: 'Quotes only. Num shows the fare and hands the booking to the airline.' },
  duffel: { title: 'Duffel — flights', who: ['guest'], does: 'A second live fare source, so a search is not one vendor’s opinion.', caveat: 'Search only. Issuing a ticket is a separate decision we have not taken.' },
  sabre_hotel: { title: 'Sabre — hotel rates', who: ['guest'], does: 'Real room rates for real dates.', caveat: 'Quotes only.' },
  viator: { title: 'Viator', who: ['guest'], does: 'Tours, activities and day trips, bookable on their page.' },
  ticketmaster: { title: 'Ticketmaster', who: ['guest'], does: 'What is actually on while you are there — concerts, sport, shows.', caveat: 'Search only, and only in the US, UK and Europe.' },
  bounce: { title: 'Bounce', who: ['guest'], does: 'Somewhere to leave your bags between checkout and your flight.' },
  localrent: { title: 'Localrent', who: ['guest'], does: 'Car hire from local firms rather than the airport desks.' },
  // EVENTBRITE IS NOT HERE, AND THAT IS THE HONEST ANSWER.
  //
  // Eventbrite removed public event search from its API in December 2019 and
  // switched it off on 20 Feb 2020. There is no endpoint, at any price, that
  // lets a third party ask "what is on in Bangkok this weekend" — only
  // organiser-owned and venue-owned reads, which require the organiser's own
  // permission. So "connect Eventbrite" for discovery is not a key we have not
  // bought; it is a door that does not exist.
  //
  // What IS possible is the other direction: a HOST who runs their events on
  // Eventbrite connecting their own organiser account so THEIR events appear
  // in Num. That is a real feature and it belongs with the event-host builder,
  // not on a discovery rail — so it is not listed here as a partner until it
  // is built, because listing it would be the exact kind of claim this file
  // exists to prevent.
  geoapify: { title: 'Geoapify', who: ['business'], does: 'Turns a business’s address into a map pin when they sign up, so guests can be sent to the right door.' },
});

/** Rails a person would never see and should not be listed as a partner. */
const PLUMBING = new Set(['geoapify']);

/**
 * Is this rail actually usable by a guest today, or is it answering from a
 * vendor's test environment?
 *
 * Stated per rail rather than guessed, because "connected" and "will actually
 * turn up" are different questions and only one of them matters to somebody
 * standing on a pavement.
 */
export function sandboxOf(id, env = {}) {
  if (id === 'doordash_drive') return env.DOORDASH_ENV !== 'production';
  return false;
}

/** Every rail, with what it is and whether it is real right now. */
export function rails(env = {}) {
  return Object.entries(ADAPTERS).map(([id, a]) => {
    const live = connected(env, id);
    const sandbox = live && sandboxOf(id, env);
    const m = MEANING[id] ?? null;
    return {
      id,
      title: m?.title ?? a.label ?? id,
      kind: a.kind,
      who: m?.who ?? ['guest'],
      does: m?.does ?? null,
      caveat: m?.caveat ?? null,
      live,
      sandbox,
      // The one line a page may print about status, written here so the page
      // cannot invent a cheerier one.
      status: !live ? 'Not connected yet' : sandbox ? 'Connected — in test mode, not yet serving guests' : 'Live',
      plumbing: PLUMBING.has(id),
      // Present so the operator view can say what is missing. It names
      // VARIABLES, never values.
      needs: live ? null : (a.needs ?? null),
    };
  });
}

/**
 * The booking platforms Num recognises.
 *
 * Every one is a deeplink, and the wording here exists so that nobody
 * downstream describes them as integrations. Recognising that a restaurant
 * runs on Resy and sending the guest to the right Resy page with the date,
 * time and party filled in is a real, useful thing. It is not "we book through
 * Resy", and the difference is a support ticket at the door.
 */
export function platforms() {
  const entries = Object.entries(PLATFORMS ?? {});
  const byKind = {};
  const seen = new Set();
  for (const [id, p] of entries) {
    // The fourteen hotel systems all carry the label "the hotel's own booking
    // page", deliberately: booking.mjs refuses to name a venue's property
    // manager to a guest, because the guest is booking a HOTEL and does not
    // care which software it runs on. That is right in a chat bubble and
    // useless on a page — fourteen identical rows say nothing.
    //
    // So the page shows each distinct label once and counts the systems
    // behind it. "Twenty-four systems, and here is what you actually see."
    const key = `${p.kind}|${p.label}`;
    if (seen.has(key)) {
      const row = byKind[p.kind].find((r) => r.label === p.label);
      row.systems += 1;
      continue;
    }
    seen.add(key);
    (byKind[p.kind] ??= []).push({ id, label: p.label, mode: p.mode, systems: 1 });
  }
  return {
    total: entries.length,
    by_kind: byKind,
    how: 'Num recognises which system a venue runs on and opens that venue’s own page with your details already filled in. Num does not hold an account with these platforms, and never charges you through one.',
  };
}

/**
 * What a BUSINESS on Num gets. Not a rail list — the things a business owner
 * would actually want to know before signing up.
 *
 * `live` is a fact about the code being deployed, not about their account.
 */
/**
 * ⚠️ THE MISTAKE THIS BLOCK ALMOST SHIPPED WITH — 7 Sep 2026, same day.
 *
 * The first version of this function hand-wrote `live: true` on all seven
 * lines. Within an hour of deploying, production told on it:
 *
 *   · `/api/version` reported `booking: false` — BOOKDESK_ENABLED is not set,
 *     so table requests are switched OFF — while this page told businesses
 *     they could take them.
 *   · `pickup` was listed as a feature. `createOrder` writes the literal
 *     string 'delivery' into `fulfilment`; there is no code path that produces
 *     a collection order. It is not switched off, it is NOT BUILT.
 *
 * Two false claims, on the page whose entire premise is that it cannot make
 * one. The lesson is not "be more careful" — it is that a hand-written boolean
 * is a claim wherever it appears, including inside a generator. So every line
 * below now derives its `live` from something checkable, and the two that
 * cannot be derived are marked `built: false` and say so to the reader.
 *
 * The rule for adding a line here: if you cannot point at the thing that makes
 * it true, it is not `live`.
 */
export function forBusiness(env = {}) {
  const courier = connected(env, 'doordash_drive');
  // The same flag /api/version reads. One switch, one truth, no deploy needed
  // to change it — and this page follows it within one request.
  const bookings = env?.BOOKDESK_ENABLED === 'true';
  return [
    { id: 'listing', title: 'Be suggested by name', live: true, does: 'When a guest nearby asks for what you sell, Num offers you — with your link, your address, a tappable phone number and your opening hours.' },
    { id: 'offerings', title: 'Your products and prices', live: true, does: 'Add what you sell, with prices, from a template built for your trade. Only priced items can be ordered.' },
    { id: 'delivery', title: 'Take delivery orders', live: true, does: 'A guest’s Num places the order, you accept it in your console, and the guest is told at every step.' },
    { id: 'courier', title: 'Deliver without a driver', live: courier, sandbox: courier && sandboxOf('doordash_drive', env), does: 'Dispatch a DoorDash courier for an order you accepted. Num quotes the fee, adds it to the guest’s total and settles it — you need no DoorDash account of your own.' },
    {
      id: 'pickup', title: 'Let guests collect', live: false, built: false,
      does: 'Accept an order for collection instead of delivery, with a code the guest shows at the counter.',
      caveat: 'Not built yet — every order today is a delivery. Listed here because it is next, not because it works.',
    },
    {
      // ⚠️ TWO THINGS ARE CALLED "BOOKING" AND THEY ARE NOT THE SAME SWITCH.
      //
      //   BOOKDESK_ENABLED       — this one. A guest asks Num for a table or an
      //                            appointment at a VENUE; the venue confirms.
      //   SABRE_BOOKING_ENABLED  — issuing an airline ticket. That is what
      //                            /api/version reports as `booking`, and it is
      //                            deliberately off behind a two-key rule.
      //
      // So /api/version can say `booking: false` while this line says live, and
      // both are correct. Found 7 Sep 2026 by reading the two side by side and
      // briefly concluding one was broken — which is exactly what the next
      // person will do, so the distinction is written into the label itself.
      id: 'bookings', title: 'Take table and appointment requests', live: bookings,
      does: 'A guest asks Num for a table or an appointment with you, you get the request, you confirm. Num never confirms on your behalf. (Separate from airline ticketing, which is a different switch and is off.)',
      caveat: bookings ? null : 'Switched off across Num right now. Guests are pointed at your own booking page instead.',
    },
    { id: 'agent', title: 'An agent that knows your business', live: true, does: 'Answers guest questions about you from what you told us, not from what a model guessed.' },
  ];
}

/**
 * The whole public answer. Safe to serve to anybody: every field is a label, a
 * sentence or a boolean.
 */
export function connectionsPayload(env = {}) {
  const all = rails(env);
  const shown = all.filter((r) => !r.plumbing);
  return {
    updated: new Date().toISOString().slice(0, 10),
    // Counted from what is CONNECTED, so the headline number on the website
    // can never be higher than the truth.
    live_count: shown.filter((r) => r.live && !r.sandbox).length,
    rails: shown,
    platforms: platforms(),
    business: forBusiness(env),
    note: 'This page is generated from what Num actually has connected. Anything shown as not connected is not connected.',
  };
}
