/**
 * Booking: which platform a venue uses, and a link that arrives filled in.
 *
 * ── THE HONEST POSITION ──────────────────────────────────────────────────
 *
 * No restaurant booking platform is going to hand a new concierge a write
 * API on day one. OpenTable, Resy and Tock all gate reservation writes
 * behind a signed partnership, and pretending otherwise would mean shipping
 * a "Booked!" screen that booked nothing — the single worst thing this
 * product could do to somebody standing outside a restaurant.
 *
 * So this ships the thing that works today and needs nobody's permission: a
 * deep link with the party size, date and time ALREADY IN IT. The guest taps
 * once and lands on the venue's own booking page with the form filled. That
 * is a real booking, made by the guest, on the platform the restaurant
 * actually uses — and it is what most concierge products do behind the
 * curtain anyway.
 *
 * When a partnership lands, `mode` for that platform flips from 'deeplink'
 * to 'api' and only the execution changes. The discovery work — knowing that
 * this venue books through Resy and its slug is `bestia` — is the hard part,
 * it is done once by the crawler, and it is what makes the partnership worth
 * signing when we go asking.
 *
 * ── WHY A REF AND NOT A URL ──────────────────────────────────────────────
 *
 * Storing "https://www.opentable.com/r/bestia-los-angeles?restref=87421" is
 * ~55 bytes of mostly template. Storing 'opentable' + '87421' is 15, and it
 * is the form you need anyway to add a party size and a time. Across a city
 * that is the difference between a few MB and a few hundred KB, and across
 * the whole directory it is the difference between D1 growing and not.
 */

/**
 * Every platform we can recognise, how to spot it, and how to link into it.
 *
 * `pattern` reads the venue's own website for an outbound booking link;
 * `link` rebuilds a filled-in URL from the stored ref.
 */
export const PLATFORMS = {
  opentable: {
    label: 'OpenTable',
    kind: 'table',
    mode: 'deeplink',
    pattern: /opentable\.[a-z.]+\/(?:r\/|restaurant\/profile\/)?([\w-]+)|opentable\.[a-z.]+\/.*?(?:rid|restref)=(\d+)/i,
    link: (ref, o) => {
      const u = new URL(`https://www.opentable.com/r/${ref}`);
      if (o.party) u.searchParams.set('covers', String(o.party));
      if (o.datetime) u.searchParams.set('dateTime', o.datetime);
      return u.toString();
    },
  },
  resy: {
    label: 'Resy',
    kind: 'table',
    mode: 'deeplink',
    pattern: /resy\.com\/cities\/[\w-]+\/(?:venues\/)?([\w-]+)/i,
    link: (ref, o) => {
      const u = new URL(`https://resy.com/cities/la/${ref}`);
      if (o.party) u.searchParams.set('seats', String(o.party));
      if (o.date) u.searchParams.set('date', o.date);
      return u.toString();
    },
  },
  tock: {
    label: 'Tock',
    kind: 'table',
    mode: 'deeplink',
    pattern: /(?:exploretock|tock)\.com\/([\w-]+)/i,
    link: (ref, o) => {
      const u = new URL(`https://www.exploretock.com/${ref}`);
      if (o.party) u.searchParams.set('size', String(o.party));
      if (o.date) u.searchParams.set('date', o.date);
      if (o.time) u.searchParams.set('time', o.time);
      return u.toString();
    },
  },
  sevenrooms: {
    label: 'SevenRooms',
    kind: 'table',
    mode: 'deeplink',
    pattern: /sevenrooms\.com\/(?:reservations|explore)\/([\w-]+)/i,
    link: (ref, o) => {
      const u = new URL(`https://www.sevenrooms.com/reservations/${ref}`);
      if (o.party) u.searchParams.set('party_size', String(o.party));
      if (o.date) u.searchParams.set('date', o.date);
      return u.toString();
    },
  },
  yelp: {
    label: 'Yelp Reservations',
    kind: 'table',
    mode: 'deeplink',
    pattern: /yelp\.com\/reservations\/([\w-]+)/i,
    link: (ref, o) => {
      const u = new URL(`https://www.yelp.com/reservations/${ref}`);
      if (o.party) u.searchParams.set('covers', String(o.party));
      return u.toString();
    },
  },
  // Square publishes a real public Bookings API, so this is the first
  // candidate to move from 'deeplink' to 'api' — no partnership needed,
  // only OAuth from the merchant.
  square: {
    label: 'Square Appointments',
    kind: 'appointment',
    mode: 'deeplink',
    pattern: /(?:squareup\.com\/appointments\/book\/|book\.squareup\.com\/appointments\/)([\w-]+)/i,
    link: (ref) => `https://squareup.com/appointments/book/${ref}`,
  },
  booksy: {
    label: 'Booksy',
    kind: 'appointment',
    mode: 'deeplink',
    pattern: /booksy\.com\/[a-z-]+\/[\w-]*?(\d{4,})/i,
    link: (ref) => `https://booksy.com/en-us/${ref}`,
  },
  mindbody: {
    label: 'Mindbody',
    kind: 'appointment',
    mode: 'deeplink',
    pattern: /(?:mindbodyonline\.com|mindbody\.io).*?(?:studioid|id)=(\d+)/i,
    link: (ref) => `https://www.mindbodyonline.com/explore/locations/${ref}`,
  },
  calendly: {
    label: 'Calendly',
    kind: 'appointment',
    mode: 'deeplink',
    pattern: /calendly\.com\/([\w-]+(?:\/[\w-]+)?)/i,
    link: (ref) => `https://calendly.com/${ref}`,
  },
  toast: {
    label: 'Toast',
    kind: 'order',
    mode: 'deeplink',
    pattern: /toasttab\.com\/(?:local\/)?([\w-]+)/i,
    link: (ref) => `https://www.toasttab.com/${ref}`,
  },

  /* ─────────────────────────── HOTELS ────────────────────────────────
   *
   * kind: 'stay'. Every one of these is the hotel's OWN booking engine, which
   * is the entire point: the guest completes on the hotel's page, the
   * reservation lands in the hotel's own system, the hotel pays no OTA
   * commission, and NUM holds no money at any point. That last property is
   * what keeps a seller-of-travel bond at zero (Cal. B&P §17550.11) and it is
   * the same promise made to LetsGo2Trip. A deep link preserves it; an API
   * that books on the hotel's behalf does not.
   *
   * ── WHY MOST OF THESE DO NOT PREFILL DATES ────────────────────────
   *
   * Only entries with a `dates` function prefill. The others deliberately
   * return a bare property link.
   *
   * Every one of these engines is a single-page app that answers HTTP 200 to
   * any query string at all — including invented parameter names. So "the URL
   * loaded" is NOT evidence the dates were understood, and guessing
   * `checkInDate` when the engine wants `dateFrom` produces a page that opens
   * cleanly on today's date while the traveller believes they are looking at
   * their weekend. A link that opens unfilled is honest; one that is
   * confidently prefilled with the wrong week is not.
   *
   * So `dates` is added ONLY for an engine whose parameters have been observed
   * on a live hotel page. SynXis below is the worked example — its full
   * parameter set was read straight off a Bath hotel's booking button.
   * ------------------------------------------------------------------ */

  synxis: {
    label: 'the hotel’s own booking page',
    kind: 'stay',
    mode: 'deeplink',
    // Sabre's booking engine. Needs BOTH hotel and chain, so the ref carries
    // them as "hotel:chain" — a hotel id alone lands on a chain picker.
    //
    // AND THE HOST, when the engine is white-labelled.
    //
    // Hotels routinely put SynXis on their own domain: The Fingal's booking
    // button is book.fingal.co.uk, carrying the identical hotel/chain/level
    // triple. Matching only be.synxis.com missed every one of them — and
    // Fingal is a hotel that claimed its listing on NUM the same week. So the
    // host is captured as a third ref segment and the link is rebuilt on it,
    // which also keeps the guest on the hotel's own branding rather than
    // bouncing them to a Sabre URL they have never seen.
    //
    // `level=hotel` is what makes the host-agnostic half safe to match: it is
    // a SynXis-ism, and requiring it alongside both ids keeps a stray
    // "?hotel=2&chain=3" on some unrelated site from being read as a booking
    // engine.
    // ONE pattern, host captured, and two ways to qualify.
    //
    // be.synxis.com needs no further proof — the host IS the evidence, and a
    // live fixture links it without level=hotel at all. Any OTHER host must
    // also carry level=hotel, which is a SynXis-ism: that is what stops a
    // stray "?hotel=2&chain=3" on an unrelated site being read as a booking
    // engine.
    //
    // Written first as canonical-then-generic alternatives, which never fired:
    // alternation is leftmost-FIRST, and a branch starting at "https://" wins
    // over one starting at "be.synxis.com" eight characters later. Every
    // Sabre-hosted link took the white-label path and grew a third ref
    // segment, changing ids already stored on live rows. The existing fixture
    // caught it. Both branches now start at the same offset.
    pattern: new RegExp(
      'https?://(?:(be\\.synxis\\.com)|([\\w.-]+)(?=[^"\'\\s]*level=hotel))'
      + '/[^"\'\\s]*?(?:hotel=(\\d+)[^"\'\\s]*?chain=(\\d+)'
      + '|chain=(\\d+)[^"\'\\s]*?hotel=(\\d+))',
      'i',
    ),
    ref: (m) => {
      const hotel = m[3] || m[6];
      const chain = m[4] || m[5];
      if (!hotel || !chain) return '';
      // The canonical host stays a two-segment ref, byte-identical to what is
      // already written on live rows. Only a white-labelled engine adds the
      // third segment, because only then is it needed.
      return m[1] ? `${hotel}:${chain}` : `${hotel}:${chain}:${String(m[2]).toLowerCase()}`;
    },
    link: (ref, o) => {
      const [hotel, chain, host] = String(ref).split(':');
      const u = new URL(`https://${host || 'be.synxis.com'}/`);
      u.searchParams.set('hotel', hotel);
      if (chain) u.searchParams.set('chain', chain);
      u.searchParams.set('level', 'hotel');
      u.searchParams.set('locale', 'en-GB');
      return u.toString();
    },
    // Observed live: ?hotel=5160&chain=32565&arrive=…&depart=…&adult=2&rooms=1
    dates: (u, o) => {
      u.searchParams.set('arrive', o.checkin);
      u.searchParams.set('depart', o.checkout);
      if (o.adults) u.searchParams.set('adult', String(o.adults));
      u.searchParams.set('rooms', String(o.rooms || 1));
    },
  },

  mews: {
    label: 'the hotel’s own booking page',
    kind: 'stay',
    mode: 'deeplink',
    pattern: /app\.mews\.com\/distributor\/([0-9a-f-]{36})/i,
    link: (ref) => `https://app.mews.com/distributor/${ref}`,
    // Mews's documented distributor convention.
    dates: (u, o) => {
      u.searchParams.set('mewsStart', o.checkin);
      u.searchParams.set('mewsEnd', o.checkout);
      if (o.adults) u.searchParams.set('mewsAdultCount', String(o.adults));
    },
  },

  siteminder: {
    label: 'the hotel’s own booking page',
    kind: 'stay',
    mode: 'deeplink',
    pattern: /(?:direct-book\.com|book-directonline\.com)\/properties\/([\w-]+)/i,
    link: (ref) => `https://direct-book.com/properties/${ref}`,
  },

  cloudbeds: {
    label: 'the hotel’s own booking page',
    kind: 'stay',
    mode: 'deeplink',
    // Two shapes in the wild: the reservation page and the embeddable widget
    // (hotels.cloudbeds.com/widget/load/<ref>/horiz). Mono Suites in Edinburgh
    // publishes only the widget form, so a pattern that knows one and not the
    // other silently classes a connectable hotel as unreachable.
    pattern: /hotels\.cloudbeds\.com\/(?:en\/)?(?:reservation|widget\/load)\/([\w-]+)/i,
    link: (ref) => `https://hotels.cloudbeds.com/reservation/${ref}`,
  },

  littlehotelier: {
    label: 'the hotel’s own booking page',
    kind: 'stay',
    mode: 'deeplink',
    pattern: /(?:app\.)?littlehotelier\.com\/(?:properties\/)?([\w-]+)/i,
    link: (ref) => `https://app.littlehotelier.com/properties/${ref}`,
  },

  eviivo: {
    label: 'the hotel’s own booking page',
    kind: 'stay',
    mode: 'deeplink',
    pattern: /(?:bookings|book)\.eviivo\.com\/([\w-]+)/i,
    link: (ref) => `https://bookings.eviivo.com/${ref}`,
  },

  guestline: {
    label: 'the hotel’s own booking page',
    kind: 'stay',
    mode: 'deeplink',
    // Guestline is regionalised: booking.eu.guestline.app, book.guestline.app,
    // bookings.guestline.com. Frederick House in Edinburgh sits on the .eu
    // host, which a fixed-hostname pattern misses entirely.
    pattern: /(?:[\w.]*\.)?guestline\.(?:app|com)\/([\w-]+)\b/i,
    link: (ref) => `https://booking.eu.guestline.app/${ref}/availability`,
  },

  travelclick: {
    label: 'the hotel’s own booking page',
    kind: 'stay',
    mode: 'deeplink',
    pattern: /reservations\.travelclick\.com\/(\d+)/i,
    link: (ref) => `https://reservations.travelclick.com/${ref}`,
  },

  freetobook: {
    label: 'the hotel’s own booking page',
    kind: 'stay',
    mode: 'deeplink',
    pattern: /(?:www\.)?freetobook\.com\/([\w-]+)/i,
    link: (ref) => `https://www.freetobook.com/${ref}`,
  },

  profitroom: {
    label: 'the hotel’s own booking page',
    kind: 'stay',
    mode: 'deeplink',
    pattern: /booking\.profitroom\.com\/(?:[a-z]{2}\/)?([\w-]+)/i,
    link: (ref) => `https://booking.profitroom.com/en/${ref}/home`,
  },

  roomraccoon: {
    label: 'the hotel’s own booking page',
    kind: 'stay',
    mode: 'deeplink',
    pattern: /([\w-]+)\.roomraccoon\.co(?:m|\.uk)/i,
    link: (ref) => `https://${ref}.roomraccoon.com`,
  },
};

/** The engines whose date parameters have been confirmed on a live page. */
export const PREFILLS_DATES = Object.entries(PLATFORMS)
  .filter(([, p]) => typeof p.dates === 'function')
  .map(([id]) => id);

/** Every stay engine NUM can deep-link into. */
export const STAY_PLATFORMS = Object.entries(PLATFORMS)
  .filter(([, p]) => p.kind === 'stay')
  .map(([id]) => id);

/** Read a page's outbound links and name the booking platform, if any. */
export function detectBooking(html, pageUrl = '') {
  const hay = `${html ?? ''}\n${pageUrl}`;
  for (const [id, p] of Object.entries(PLATFORMS)) {
    const m = p.pattern.exec(hay);
    if (!m) continue;
    // SynXis needs two numbers (hotel AND chain), so a platform may supply its
    // own ref builder. Everything else keeps the first captured group.
    const ref = String(p.ref ? p.ref(m) : (m[1] || m[2] || '')).trim();
    // Platform front pages ("resy.com/cities/la") are not a venue.
    if (!ref || ref.length < 2 || /^(www|cities|reservations|book|explore|local|r)$/i.test(ref)) continue;
    return { platform: id, ref, kind: p.kind, mode: p.mode };
  }
  return null;
}

/**
 * A booking link for this place, prefilled.
 *
 * @param {object} place  needs booking_platform + booking_ref
 * @param {object} [when] { party, date: 'YYYY-MM-DD', time: 'HH:MM' }
 * @returns {{ label, kind, mode, url }|null} — null when we simply cannot
 *   book here, which the caller must say out loud rather than paper over.
 */
export function bookingLink(place, when = {}) {
  const p = PLATFORMS[place?.booking_platform];
  if (!p || !place?.booking_ref) return null;
  const o = {
    party: when.party && Number(when.party) > 0 ? Math.min(Number(when.party), 20) : null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(when.date ?? '') ? when.date : null,
    time: /^\d{2}:\d{2}$/.test(when.time ?? '') ? when.time : null,
  };
  o.datetime = o.date && o.time ? `${o.date}T${o.time}` : null;
  // Stay parameters. A restaurant asks for a party and a time; a hotel asks
  // for two dates. Both live on the same object so one link() signature serves
  // every platform.
  const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v ?? '') ? v : null);
  o.checkin = ymd(when.checkin);
  o.checkout = ymd(when.checkout);
  o.adults = when.adults && Number(when.adults) > 0 ? Math.min(Number(when.adults), 12) : null;
  o.rooms = when.rooms && Number(when.rooms) > 0 ? Math.min(Number(when.rooms), 5) : null;
  try {
    let url = p.link(place.booking_ref, o);
    // Dates are added ONLY by an engine that has published or demonstrated its
    // parameter names. Checkout must be after checkin — an inverted pair is a
    // caller bug, and silently sending it produces a booking page for the
    // wrong week rather than an error anyone would notice.
    //
    // Computed ONCE. This used to be the same expression written twice, here
    // and in the `dated` flag below, which is two places to change and one to
    // forget — and forgetting the second is the version where NUM tells a
    // guest "dates already filled in" over a link that has none.
    const dated = !!(p.dates && o.checkin && o.checkout && o.checkout > o.checkin);
    if (dated) {
      const u = new URL(url);
      p.dates(u, o);
      url = u.toString();
    }
    return {
      label: p.label,
      kind: p.kind,
      mode: p.mode,
      url,
      // The caller can tell a guest "dates already filled in" only when this
      // is true. Saying it otherwise is the small lie that costs a booking.
      dated,
    };
  } catch {
    return null;
  }
}

/** True when this place can be booked at all — the flag the API exposes. */
export const bookable = (place) => !!bookingLink(place);
