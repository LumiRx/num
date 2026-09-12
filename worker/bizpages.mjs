/**
 * The console's pages, and what each plan actually opens.
 *
 * ── WHY ONE FILE OWNS BOTH ───────────────────────────────────────────────
 *
 * Until now the console was one long page and the public pricing table was
 * hand-written HTML. They disagreed, and the disagreement was not cosmetic:
 *
 *   · /pricing/ sells "API keys and AI agent access" as the $50 Full tier.
 *     Nothing gates the API. `bizbilling.mjs` says so in its own header —
 *     the numbiz_ key IS the claim mechanism, the free dashboard calls
 *     through it, and gating it would break the free tier outright. A
 *     business paying $50 for that is paying for something it already has.
 *   · /pricing/ puts promotions on Pro at $19.99. `DEFAULT_BIZ_TIERS` grants
 *     `promotions: true` on Small at $9.99.
 *   · /business/ says Pro "adds multi-location". Small already carries 3.
 *
 * Three separate promises the product does not keep, in the two documents a
 * business reads before paying. So this file is the single list, and both the
 * console and the public table are rendered FROM it. A fourth disagreement
 * cannot be written by hand any more; it would have to be written here, where
 * a test reads it.
 *
 * ── THE GATE RULE ────────────────────────────────────────────────────────
 *
 * A page a plan does not open is still LISTED and still opens — it renders
 * what the feature is and what unlocks it. It is never hidden and never 404s.
 * Hiding it means a business cannot discover what it would be buying, and a
 * 404 on a page the nav shows reads as broken software. The gate withholds the
 * DATA, not the explanation.
 */

/**
 * `needs` is a function of the plan's entitlements. `null` means every plan
 * opens it — which is most of them, because almost nothing about running a
 * listing should be behind a card.
 */
export const PAGES = Object.freeze([
  {
    id: 'overview', label: 'Overview', nav: true, needs: null,
    blurb: 'Where you stand: what NUM has done for you, and anything still outstanding.',
  },
  {
    id: 'setup', label: 'Finish setup', nav: true, needs: null,
    blurb: 'The short list of things still missing before a traveller asking about you gets a complete answer.',
  },
  {
    id: 'confirm', label: 'Confirm details', nav: true, needs: null,
    blurb: 'Details we found about you and want you to check before a traveller is told them.',
  },
  {
    id: 'listing', label: 'Your listing', nav: true, needs: null,
    blurb: 'The hours, phone, address and description NUM reads out to travellers. Yours to change, any time.',
  },
  {
    id: 'offerings', label: 'What you offer', nav: true, needs: null,
    blurb: 'Your menu, treatments, rooms or tours, with prices \u2014 so NUM can answer "what do they do" '
      + 'with more than one word.',
  },
  {
    id: 'delivery', label: 'Delivery', nav: true, needs: null,
    blurb: 'Deliver what you list to travellers nearby, inside the NUM app \u2014 your licence, radius, fee, '
      + 'and every order with one button to move it along.',
  },
  {
    id: 'requests', label: 'Booking requests', nav: true, needs: null,
    blurb: 'Every traveller who asked NUM for a table at your place.',
  },
  {
    id: 'insights', label: 'How you are doing', nav: true, needs: null,
    blurb: 'How often NUM put you in front of a traveller. How far back you can look depends on your plan.',
  },
  {
    id: 'demand', label: 'What travellers ask', nav: true, needs: null,
    blurb: 'Real questions asked in your destination — what people arrive wanting. Not searches for you.',
  },
  {
    id: 'promotions', label: 'Promotions', nav: true,
    needs: (e) => !!e?.promotions,
    unlock: 'A promotion NUM can mention to a traveller who is choosing between you and somewhere else.',
    blurb: 'One short line NUM can offer — a happy hour, a set menu, a welcome drink.',
  },
  {
    id: 'locations', label: 'Your locations', nav: true,
    needs: (e) => (e?.multi_location_max == null ? true : Number(e.multi_location_max) > 1),
    unlock: 'More than one place under a single login, billed on one plan.',
    blurb: 'Every listing you own, on one screen.',
  },
  {
    id: 'ownership', label: 'Ownership', nav: true, needs: null,
    blurb: 'The owner-verified badge, and the shortest honest route to earning it.',
  },
  {
    id: 'notifications', label: 'Notifications', nav: true, needs: null,
    blurb: 'Where your copy of a booking request goes. The listing phone is texted either way.',
  },
  {
    // The code a venue actually prints. Separate from 'payments' on purpose:
    // this one exists today and works today, and burying it inside a page
    // about card payments — which are not switched on for anybody — is how a
    // working feature reads as an unavailable one.
    id: 'code', label: 'Your QR code', nav: true, needs: null,
    blurb: 'Print it for the counter. Anyone who scans it is connected to you, and it is your referral link.',
  },
  {
    id: 'payments', label: 'Taking payment', nav: true, needs: null,
    blurb: 'A QR a guest scans to settle the bill.',
  },
  {
    id: 'api', label: 'API & AI agents', nav: true, needs: null,
    // Stated positively and on every plan, because /pricing/ has been selling
    // it as a $50 feature. The correction belongs on the page a business reads,
    // not only in a commit message.
    blurb: 'Your business key works with the REST API and the MCP server on every plan, including free. '
      + 'An assistant can keep your hours current and post promotions for you.',
  },
  {
    id: 'plan', label: 'Your plan', nav: true, needs: null,
    blurb: 'What you are on, what the others give you, and how to change or cancel.',
  },
  {
    id: 'beta', label: 'Early access', nav: true,
    needs: (e) => !!e?.beta_features,
    unlock: 'New NUM for Business features before anyone else, and a direct line to say what is wrong with them.',
    blurb: 'What we are building next, and your seat in it.',
  },
]);

export const PAGE_IDS = Object.freeze(PAGES.map((p) => p.id));
const BY_ID = new Map(PAGES.map((p) => [p.id, p]));

/** The requested page, or the overview. Never throws, never 404s. */
export const pageFor = (id) => BY_ID.get(String(id ?? '').toLowerCase()) ?? BY_ID.get('overview');

/** Does this plan open this page? A page with no `needs` is open to everyone. */
export const opens = (page, entitlements) => (typeof page?.needs === 'function'
  ? !!page.needs(entitlements ?? {})
  : true);

/**
 * The cheapest tier that opens a given page.
 *
 * Used by the locked panel ("this is on Small Business, $9.99") and by the
 * public table. Derived rather than written down, so changing an entitlement
 * moves every sentence that describes it.
 */
export function cheapestTierFor(pageId, tiers) {
  const page = BY_ID.get(pageId);
  if (!page || !page.needs) return null;
  const ranked = Object.entries(tiers ?? {})
    .sort((a, b) => (a[1]?.price_cents ?? 0) - (b[1]?.price_cents ?? 0));
  const hit = ranked.find(([, t]) => opens(page, t?.entitlements ?? {}));
  return hit ? { id: hit[0], ...hit[1] } : null;
}

/**
 * Every tier, and exactly what it opens — the shape both the console's plan
 * page and the public pricing table render from.
 *
 * `included` lists the pages that plan opens; `locked` the ones it does not,
 * each naming the tier that would. Nothing here is a sentence a human typed
 * twice.
 */
export function tierMatrix(tiers) {
  return Object.entries(tiers ?? {})
    .sort((a, b) => (a[1]?.price_cents ?? 0) - (b[1]?.price_cents ?? 0))
    .map(([id, t]) => {
      const e = t?.entitlements ?? {};
      const gated = PAGES.filter((p) => p.needs);
      return {
        id,
        name: t?.name ?? id,
        price_cents: t?.price_cents ?? 0,
        blurb: t?.blurb ?? '',
        // The four measured entitlements, in the words a business uses.
        gets: [
          `${e.analytics_days ?? 7} days of performance history`,
          e.promotions ? 'A promotion NUM can offer travellers' : null,
          e.multi_location_max == null
            ? 'Unlimited locations on one plan'
            : (Number(e.multi_location_max) > 1
              ? `Up to ${e.multi_location_max} locations on one plan`
              : 'One location'),
          e.beta_features ? 'New features before anyone else' : null,
        ].filter(Boolean),
        // True on every tier, and said on every tier, because it is true.
        always: [
          'Your listing, free forever — hours, phone, address, description',
          'Booking requests from travellers',
          'REST API and MCP server access with your business key',
          'The owner-verified badge, earned by proof and never sold',
        ],
        included: gated.filter((p) => opens(p, e)).map((p) => p.id),
        locked: gated.filter((p) => !opens(p, e)).map((p) => ({
          id: p.id,
          label: p.label,
          on: cheapestTierFor(p.id, tiers)?.name ?? null,
        })),
      };
    });
}

export { BY_ID as PAGES_BY_ID };
