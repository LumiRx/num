// THE LISTING PAGE — a widget that opens into its own results, not a sentence.
//
// ── WHY (20 Sep 2026, Dre's call) ────────────────────────────────────────
//
// "In the widget we should let it open into a custom page with all the
// related listing — if it's flights it'll be flights, if it's hotels it's
// hotels or clubs, etc."
//
// Until today every feature page composed a sentence and posted it to the
// concierge. That is the right destination for "hire someone to collect a
// package"; it is the wrong one for "show me flights BKK→NRT on the 4th",
// which is a SEARCH and has a list for an answer. The concierge was being
// asked to narrate a table.
//
// Two things fell out of that which are worth naming, because both were
// already built and neither had a surface:
//
//   · `searchStays()` in lib/stays.ts had NO CALLER anywhere in the app.
//     A complete hotel search — options, nightly and total, refundability,
//     cancel-by, pay-at-hotel, check-in windows, loyalty warning — written,
//     typed, and unreachable from the product.
//
//   · Flight offers rendered only inside ThreadView, as a panel in the chat.
//     The one place a guest cannot browse them.
//
// ── AND IT COSTS NOTHING TO RUN ──────────────────────────────────────────
//
// A listing calls the search route directly. No lane, no model, no tokens —
// and no send gate, which is the other half of the bug Dre hit earlier:
// a widget search was being refused for want of a verified number, because
// it was travelling as a message. A search is not a message.
//
// The concierge is not removed from any of this. Every row keeps ASK NUM, so
// the thing NUM is actually for — judgement about which one — is one tap from
// the list rather than the only way to see it.
import { store } from './store';
import type { FeatureId } from './features';

/** Where a feature's results come from. */
export type ListingSource = 'flights' | 'stays' | 'places' | 'paperwork';

/**
 * The source each feature reads, or null for the ones that are genuinely a
 * request rather than a search.
 *
 * `hire`, `pickup` and `move` are deliberately absent. "Collect a package
 * from the post office on Sathorn" has no list of results — it is a job for a
 * person, and a page of search results would be a worse answer than a
 * sentence to the concierge. A feature not named here behaves exactly as it
 * did before.
 */
export const SOURCE: Partial<Record<FeatureId, ListingSource>> = {
  flights: 'flights',
  stays: 'stays',
  tables: 'places',
  tonight: 'places',
  nightlife: 'places',
  wellness: 'places',
  errands: 'places',
  lookgood: 'places',
  transit: 'places',
  pets: 'places',
  kids: 'places',
  work: 'places',
  events: 'places',
  /* Its own source: the answer is not a list of places or a list of fares,
   * it is an assembled pack of documents with deadlines. /api/travel/pack
   * already returns exactly that. */
  paperwork: 'paperwork',
};

export const sourceFor = (id: FeatureId | null | undefined): ListingSource | null =>
  (id ? SOURCE[id] ?? null : null);

export interface ListingDraft {
  feature: FeatureId;
  source: ListingSource;
  /** The trimmed field values from the feature page. */
  values: Record<string, string>;
  lane: string | null;
  /** The sentence the feature would have sent. Kept so ASK NUM still works. */
  ask: string;
}

/**
 * What a `places` listing searches for.
 *
 * The lane when there is one ("late bars", "a barber"), because that is the
 * word the guest actually chose. Failing that the feature's own subject. The
 * free-text field is appended when it was filled in, so "quiet, Thai, near
 * the river" narrows rather than being thrown away.
 */
export function placeQuery(d: ListingDraft, fallback: string): string {
  const extra = [d.values.what, d.values.notes].map((v) => String(v ?? '').trim()).filter(Boolean).join(', ');
  const subject = d.lane || fallback;
  return extra ? `${subject} — ${extra}` : subject;
}

export const openListing = (draft: ListingDraft): void => {
  store.set({ featureOpen: null, listingOpen: draft });
};

export const closeListing = (): void => store.set({ listingOpen: null });
