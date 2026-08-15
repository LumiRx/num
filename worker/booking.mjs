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
};

/** Read a page's outbound links and name the booking platform, if any. */
export function detectBooking(html, pageUrl = '') {
  const hay = `${html ?? ''}\n${pageUrl}`;
  for (const [id, p] of Object.entries(PLATFORMS)) {
    const m = p.pattern.exec(hay);
    if (!m) continue;
    const ref = (m[1] || m[2] || '').trim();
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
  try {
    return { label: p.label, kind: p.kind, mode: p.mode, url: p.link(place.booking_ref, o) };
  } catch {
    return null;
  }
}

/** True when this place can be booked at all — the flag the API exposes. */
export const bookable = (place) => !!bookingLink(place);
