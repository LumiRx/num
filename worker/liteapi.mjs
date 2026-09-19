/**
 * LiteAPI (Nuitée) — the first rail that can actually BOOK a room.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * Everything NUM has done for stays until now has been a hand-off: a deep link
 * into the hotel's own engine (worker/booking.mjs) or into a partner's
 * checkout (worker/letsgo2trip.mjs). worker/sabre.mjs can quote a room and
 * cannot take it — its own header says so, and worker/sabre-booking.mjs maps
 * only flight operations, so there has never been a hotel booking path in this
 * codebase at all.
 *
 * This is that path. rates → prebook → book → cancel, end to end, inside NUM.
 *
 * ── THE TWO THINGS THAT SHAPE EVERY DECISION BELOW ────────────────────────
 *
 * 1. THE COMPARISON ARRIVES IN THE PAYLOAD. Every rate carries both
 *    `retailRate` (what NUM sells it for, margin included) and
 *    `suggestedSellingPrice` (the public price the hotel and the OTAs show).
 *    So NUM never has to read a competitor's page to know where it stands.
 *    That matters twice over: scraping Kayak or Booking.com is against their
 *    terms and breaks the first time they change their HTML, and a comparison
 *    NUM was GIVEN is one NUM can defend.
 *
 *    That comparison is BACKEND ONLY. It decides the order and it decides
 *    whether an option is offered at all. It is not a table shown to a guest —
 *    a guest gets NUM's options, which is the whole point of a concierge.
 *    `publicOption()` is the only function that produces a guest-facing shape,
 *    and `liteapi.test.mjs` asserts that nothing from `intel()` ever survives
 *    it. If that test ever fails, the leak is real, not cosmetic.
 *
 * 2. PRICING BELOW THE PUBLIC PRICE IS ONLY LAWFUL IN A CLOSED USER GROUP.
 *    LiteAPI's rate rule: price at or above the hotel's Suggested Selling
 *    Price in public channels, or keep below-SSP rates behind a login. NUM's
 *    app requires an account, so NUM qualifies — which is exactly what lets a
 *    signed-in member see a price a public site is not allowed to advertise.
 *
 *    It is also a contract term, not a preference. So it is a GUARD
 *    (`assertPublicSafe`) with a test behind it, not a convention someone
 *    remembers. A below-SSP rate served to a logged-out visitor is a breach,
 *    and the way that happens is never a decision — it is a refactor.
 *
 * ── CAPABILITY IS NOT PERMISSION ──────────────────────────────────────────
 *
 * Lifted deliberately from worker/sabre-booking.mjs, because the reasoning is
 * right and should not have to be re-derived per rail:
 *
 *   - LITEAPI_BOOKING_ENABLED — booking is off even with working credentials.
 *     Shopping keeps working; committing does not, until someone says so.
 *   - Production needs LITEAPI_BOOKING_LIVE on top of a prod_ key. Two
 *     switches, because the failure mode of one is a real charge against what
 *     someone believed was a sandbox.
 *   - THE MODEL NEVER BOOKS. It prepares a booking and says what it costs; a
 *     human taps confirm. An agent that can autonomously spend a stranger's
 *     money is a liability, and that tap is the product working correctly
 *     rather than a limitation.
 */

/**
 * Two hosts, and they are NOT interchangeable.
 *
 * Search lives on api.liteapi.travel; everything that commits lives on
 * book.liteapi.travel. Pointing a book call at the search host fails as a 404,
 * which reads exactly like a missing booking rather than a wrong base URL.
 */
const HOST = {
  search: 'https://api.liteapi.travel/v3.0',
  book: 'https://book.liteapi.travel/v3.0',
};

/**
 * Sandbox and production are told apart by the KEY PREFIX, not by a base URL.
 * `sand_` and `prod_`. That is unusual and it is worth encoding, because it
 * means there is no URL to eyeball when you want to know which estate you are
 * about to charge.
 */
export const keyEstate = (env) => {
  const k = String(env?.LITEAPI_KEY ?? '');
  if (k.startsWith('prod_')) return 'production';
  if (k.startsWith('sand_')) return 'sandbox';
  return k ? 'unknown' : 'none';
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const readBody = async (req) => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};

export const liteapiReady = (env) => !!env?.LITEAPI_KEY;

/* ── MARGIN ────────────────────────────────────────────────────────────────

   `margin` is a percentage sent on the rates request. 0 returns net rates;
   15 adds 15% and that is NUM's earning, with no platform fee taken out of
   it. So the number below is not a setting, it is the price of the room.

   Two numbers, on purpose:

     LITEAPI_MARGIN_PUBLIC   what an unauthenticated search may be priced at
     LITEAPI_MARGIN_MEMBER   what a signed-in member is priced at

   The member number may be LOWER. That is the entire member-rate mechanic and
   it is the one thing NUM can offer that a public metasearch cannot match,
   because a public channel is not permitted to show it.

   Neither has a hardcoded default that earns money. An unset margin means
   NET RATES — NUM sells at cost — rather than a number this file invented on
   someone's behalf. A margin is a commercial decision and a file is not
   entitled to make one quietly.
*/

const pct = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};

export const marginFor = (env, { member = false } = {}) => {
  const m = member ? pct(env?.LITEAPI_MARGIN_MEMBER) : null;
  if (member && m !== null) return m;
  return pct(env?.LITEAPI_MARGIN_PUBLIC) ?? 0;
};

/* ── TRANSPORT ─────────────────────────────────────────────────────────── */

/**
 * One call. `fetchImpl` is injectable so the whole rail — including the parts
 * that commit — is exercised in tests without credentials and without ever
 * reaching Nuitée. worker/bookingbackfill.mjs takes the same shape.
 */
async function call(env, host, path, body, { method = 'POST', fetchImpl } = {}) {
  if (!liteapiReady(env)) {
    const err = new Error('LiteAPI is not configured. Set LITEAPI_KEY.');
    err.status = 503;
    throw err;
  }
  const f = fetchImpl ?? fetch;
  const res = await f(`${HOST[host]}${path}`, {
    method,
    headers: {
      'X-API-Key': env.LITEAPI_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(out?.error?.description ?? out?.message ?? `LiteAPI ${res.status}`);
    err.status = res.status;
    err.body = out;
    throw err;
  }
  return out;
}

/* ── SEARCH ────────────────────────────────────────────────────────────── */

/**
 * The fields a rates call CANNOT go without, per their reference.
 *
 * `guestNationality` is the one worth calling out: it is required, it changes
 * which rates are returned at all, and NUM has never asked anyone for it. A
 * stay search that guesses it is a stay search returning the wrong inventory
 * and looking like it worked.
 */
export const RATE_REQUIRED = Object.freeze([
  'checkin',
  'checkout',
  'currency',
  'guestNationality',
  'occupancies',
]);

/** One of these must also be present, or there is nowhere to search. */
const PLACE_KEYS = Object.freeze(['hotelIds', 'placeId', 'cityName', 'latitude', 'iataCode']);

/**
 * What is missing, in the guest's terms rather than the API's.
 *
 * Returned as a list rather than thrown, because the caller's job is to go and
 * ASK for the missing thing, and it can only do that if it knows which.
 */
export function missingForRates(q = {}) {
  const missing = RATE_REQUIRED.filter((k) => {
    if (k === 'occupancies') return !Array.isArray(q.occupancies) || q.occupancies.length === 0;
    return !q[k];
  });
  if (!PLACE_KEYS.some((k) => q[k] != null && q[k] !== '')) missing.push('where');
  // Children without ages is not a smaller version of the same search — the
  // supplier prices a 2-year-old and a 15-year-old differently, and an
  // unpriced child is how a family arrives to a bill they did not agree to.
  for (const occ of q.occupancies ?? []) {
    const kids = Number(occ?.children ?? (Array.isArray(occ?.childrenAges) ? occ.childrenAges.length : 0));
    if (kids > 0 && (occ.childrenAges ?? []).length !== kids) missing.push('childrenAges');
  }
  return [...new Set(missing)];
}

export async function searchRates(env, q = {}, { member = false, fetchImpl } = {}) {
  const missing = missingForRates(q);
  if (missing.length) {
    const err = new Error(`Cannot search for a stay without: ${missing.join(', ')}.`);
    err.status = 400;
    err.missing = missing;
    throw err;
  }
  const body = {
    occupancies: q.occupancies,
    currency: q.currency,
    guestNationality: q.guestNationality,
    checkin: q.checkin,
    checkout: q.checkout,
    margin: marginFor(env, { member }),
    roomMapping: true,
    includeHotelData: true,
    maxRatesPerHotel: Math.min(10, Math.max(1, Number(q.maxRatesPerHotel) || 4)),
    limit: Math.min(200, Math.max(1, Number(q.limit) || 30)),
    ...(q.hotelIds ? { hotelIds: q.hotelIds } : {}),
    ...(q.placeId ? { placeId: q.placeId } : {}),
    ...(q.cityName ? { cityName: q.cityName, countryCode: q.countryCode } : {}),
    ...(q.latitude != null ? { latitude: q.latitude, longitude: q.longitude, radius: q.radius ?? 5000 } : {}),
    ...(q.iataCode ? { iataCode: q.iataCode } : {}),
    ...(q.refundableRatesOnly ? { refundableRatesOnly: true } : {}),
    // Their session id keeps a price consistent across the search → prebook
    // hop. Without it a rate can legitimately move between two calls seconds
    // apart and look like a bug.
    ...(q.sessionId ? { sessionId: q.sessionId } : {}),
  };
  return call(env, 'search', '/hotels/rates', body, { fetchImpl });
}

/* ── NORMALIZE ─────────────────────────────────────────────────────────── */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Flatten hotel → roomTypes → rates into one list a person can read.
 *
 * Same job normalizeRates does for Sabre in worker/sabre.mjs, and the same
 * reason: what a traveller actually compares — nightly, total, refundable —
 * is spread across three levels of the graph.
 *
 * `taxesAndFees[].included` is carried verbatim rather than folded into the
 * total, because a rate quoted excluding a resort fee is not a cheaper rate,
 * it is a worse disclosure, and the caller has to be able to tell.
 */
export function normalizeRates(rs, { hotels = null } = {}) {
  const byId = new Map();
  for (const h of hotels ?? rs?.data?.hotels ?? rs?.hotels ?? []) byId.set(h.id ?? h.hotelId, h);

  const out = [];
  for (const entry of rs?.data ?? []) {
    const hotelId = entry.hotelId ?? entry.id;
    const hotel = byId.get(hotelId) ?? entry.hotel ?? null;
    for (const rt of entry.roomTypes ?? []) {
      for (const rate of rt.rates ?? []) {
        const excluded = (rate.retailRate?.taxesAndFees ?? []).filter((t) => t?.included === false);
        out.push({
          hotelId,
          hotelName: hotel?.name ?? entry.name ?? null,
          address: hotel?.address ?? null,
          stars: num(hotel?.starRating ?? hotel?.stars),
          lat: num(hotel?.latitude),
          lng: num(hotel?.longitude),

          // The key the next step needs. A rate without it is a number nobody
          // can act on.
          offerId: rt.offerId ?? rate.offerId ?? null,
          rateId: rate.rateId ?? null,

          roomName: rate.name ?? rt.name ?? null,
          boardType: rate.boardType ?? null,
          boardName: rate.boardName ?? null,
          maxOccupancy: num(rt.maxOccupancy),

          // `RFN` / `NRFN`. Refundability is the first thing everybody asks
          // and the last thing most booking screens show.
          refundable: rate.refundableTag === 'RFN' ? true : rate.refundableTag === 'NRFN' ? false : null,
          cancelPolicies: rate.cancellationPolicies?.cancelPolicyInfos ?? rate.cancelPolicyInfos ?? [],
          hotelRemarks: rate.cancellationPolicies?.hotelRemarks ?? null,

          currency: rate.retailRate?.total?.[0]?.currency ?? rs?.data?.currency ?? null,
          total: num(rate.retailRate?.total?.[0]?.amount),
          publicTotal: num(rate.retailRate?.suggestedSellingPrice?.[0]?.amount),
          commission: num(rate.retailRate?.commission?.[0]?.amount),
          taxesAndFees: rate.retailRate?.taxesAndFees ?? [],
          feesExcluded: excluded.reduce((a, t) => a + (num(t.amount) ?? 0), 0) || 0,
          feesExcludedNames: excluded.map((t) => t.description).filter(Boolean),
        });
      }
    }
  }
  return out;
}

/** Nights between two ISO dates, for a nightly figure nobody has to compute twice. */
export const nightsBetween = (checkin, checkout) => {
  const a = Date.parse(`${checkin}T00:00:00Z`);
  const b = Date.parse(`${checkout}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return Math.round((b - a) / 86_400_000);
};

/* ── THE BACKEND CROSS-CHECK ───────────────────────────────────────────────

   This is the part a guest never sees.

   Three sources, all of them ones NUM is entitled to read:
     A  what NUM can sell the room for            rate.total
     B  the public price, same payload            rate.publicTotal
     C  whether the hotel's own engine is known   places.booking_platform

   It produces a verdict used for ORDERING and for SUPPRESSION, and it stops
   there. `publicOption()` is the wall.
*/

/**
 * @returns {{savingCs:number, savingPct:number|null, belowPublic:boolean,
 *            direct:boolean, feesExcluded:number, verdict:string}}
 */
export function intel(rate, { directKnown = false } = {}) {
  const total = rate?.total ?? null;
  const pub = rate?.publicTotal ?? null;
  const saving = total != null && pub != null ? pub - total : null;
  const savingPct = saving != null && pub > 0 ? (saving / pub) * 100 : null;

  let verdict = 'unknown';
  if (total == null) verdict = 'unpriced';
  else if (pub == null) verdict = 'no_public_reference';
  else if (saving > 0) verdict = 'below_public';
  else if (saving === 0) verdict = 'at_public';
  else verdict = 'above_public';

  return {
    savingCs: saving == null ? 0 : Math.round(saving * 100),
    savingPct,
    belowPublic: verdict === 'below_public',
    direct: !!directKnown,
    feesExcluded: rate?.feesExcluded ?? 0,
    verdict,
  };
}

/**
 * Rank. Not by price.
 *
 * A list sorted by price is a search engine, and Kayak already exists and is
 * better at it. What a concierge is for is the ordering underneath: a room
 * that can be cancelled, at a place that is actually where you are going, with
 * no fee waiting at the desk, beats one that is eleven dollars cheaper.
 *
 * Weights are deliberately blunt and deliberately in one place. Tuning them is
 * a product decision somebody should have to make on purpose.
 */
export function rank(rates, { directKnownIds = new Set() } = {}) {
  return rates
    .map((r) => {
      const i = intel(r, { directKnown: directKnownIds.has(r.hotelId) });
      let score = 0;
      if (r.refundable === true) score += 30;
      if (r.refundable === null) score -= 5; // unknown is worse than known-rigid
      if (i.belowPublic) score += Math.min(25, (i.savingPct ?? 0));
      if (i.feesExcluded > 0) score -= 15; // a fee at the desk is a bad surprise
      if (r.boardType && r.boardType !== 'RO') score += 8;
      if (r.stars) score += Math.min(10, r.stars * 2);
      return { ...r, _intel: i, _score: score };
    })
    .sort((a, b) => b._score - a._score || (a.total ?? Infinity) - (b.total ?? Infinity));
}

/* ── THE WALL ──────────────────────────────────────────────────────────── */

/**
 * The ONLY shape that may leave this worker for a guest.
 *
 * Everything the cross-check produced — the public price, the saving, the
 * verdict, the commission NUM earns, the score — stops here. A guest gets
 * NUM's options: the room, what it costs all in, whether they can cancel, and
 * by when.
 *
 * `showSaving` exists because there is one honest sentence in the intel worth
 * saying out loud — "this is below the public price" — and whether NUM says it
 * is a product decision, not a code one. It is OFF unless
 * LITEAPI_SHOW_SAVING is set, and even then it emits a number and never a
 * competitor's name, because NUM has not read a competitor's page and must not
 * imply that it has.
 */
export function publicOption(ranked, { nights = null, showSaving = false } = {}) {
  const first = (ranked.cancelPolicies ?? [])[0];
  const out = {
    id: ranked.offerId,
    hotel: ranked.hotelName,
    address: ranked.address,
    stars: ranked.stars,
    room: ranked.roomName,
    board: ranked.boardName ?? (ranked.boardType === 'RO' ? 'Room only' : null),
    currency: ranked.currency,
    total: ranked.total,
    nightly: nights && ranked.total != null ? Math.round((ranked.total / nights) * 100) / 100 : null,
    refundable: ranked.refundable,
    cancelBy: first?.cancelTime ?? null,
    // Said plainly rather than left for the desk to explain.
    payAtHotel: ranked.feesExcluded > 0 ? ranked.feesExcluded : null,
    payAtHotelFor: ranked.feesExcludedNames?.length ? ranked.feesExcludedNames : null,
  };
  if (showSaving && ranked._intel?.belowPublic) {
    out.belowPublicBy = Math.round(ranked._intel.savingCs) / 100;
  }
  return out;
}

/**
 * The contract term, as a guard.
 *
 * A below-SSP rate may only be shown inside the closed user group. Logged out,
 * it must not be served — not hidden in the UI, not served. This throws rather
 * than filtering, because a silent filter is how the rule stops being tested.
 */
export function assertPublicSafe(ranked, { signedIn }) {
  if (signedIn) return true;
  // Checked on the NUMBERS as they stand now, not on the verdict intel()
  // recorded earlier. floorToPublic() re-prices a rate after intel() has run,
  // and a guard that trusts a stale flag is a guard that passes the one case
  // it exists to catch.
  if (ranked?.publicTotal != null && ranked?.total != null && ranked.total < ranked.publicTotal) {
    const err = new Error(
      'A member rate below the public price cannot be served to a signed-out visitor. '
      + 'This is a supplier contract term, not a display preference.',
    );
    err.status = 403;
    err.code = 'cug_required';
    throw err;
  }
  return true;
}

/**
 * Lift a below-public rate UP to the public price for a signed-out viewer.
 *
 * ── WHY THIS IS NOT A FILTER ──────────────────────────────────────────────
 *
 * The first version of this dropped below-public rates from a logged-out
 * answer. A test with two ordinary fixtures returned zero options, which is
 * not a fixture problem — it is what actually happens. Net rates plus a modest
 * margin land BELOW the public price most of the time, which is the whole
 * reason this rail is worth building. So "filter the below-public ones out"
 * means "a signed-out visitor sees nothing", and a concierge that answers
 * "nothing" to a stranger has no way of ever gaining one.
 *
 * Dropping the rate also treats a PRICING problem as a DISPLAY problem. The
 * supplier's term is about the price NUM publishes, not about which rows NUM
 * renders. Publishing the public price is compliant, honest, and identical to
 * what every OTA shows.
 *
 * And it is the conversion mechanic, done without a single dishonest word:
 * signed out you see the market price, signed in you see the member price.
 * The gap is real, NUM did not invent it, and nobody had to be told the
 * cheaper number exists before they were eligible for it.
 *
 * `_floored` is kept for the ledger. NUM should be able to count the searches
 * where a member would have paid less, because that number is the value of a
 * membership stated in money rather than in adjectives.
 */
export function floorToPublic(ranked) {
  if (ranked?.publicTotal == null || ranked?.total == null) return ranked;
  if (ranked.total >= ranked.publicTotal) return ranked;
  return {
    ...ranked,
    total: ranked.publicTotal,
    _floored: true,
    _memberTotal: ranked.total,
  };
}

/** Everything the guest sees, in one call, with the wall enforced. */
export function offer(rates, { signedIn, nights = null, directKnownIds, showSaving = false, take = 3 } = {}) {
  const ranked = rank(rates, { directKnownIds });
  const priced = signedIn ? ranked : ranked.map(floorToPublic);
  return priced.slice(0, take).map((r) => {
    assertPublicSafe(r, { signedIn });
    // A floored rate is being sold AT the public price, so there is no saving
    // to mention and mentioning one would be a lie about the guest's own bill.
    return publicOption(r, { nights, showSaving: showSaving && !r._floored });
  });
}

/* ── PREBOOK ───────────────────────────────────────────────────────────── */

/**
 * The revalidation step, and the only honest moment to say the price moved.
 *
 * This is the hotel equivalent of Sabre's price check, with one difference
 * that matters: this one actually holds the offer for a checkout session. So
 * the response is what a guest is committing against, not what they were
 * browsing.
 */
export async function prebook(env, { offerId, usePaymentSdk = true, voucherCode, fetchImpl } = {}) {
  if (!offerId) {
    const err = new Error('prebook needs an offerId.');
    err.status = 400;
    throw err;
  }
  const rs = await call(env, 'book', '/rates/prebook', {
    offerId,
    usePaymentSdk,
    ...(voucherCode ? { voucherCode } : {}),
  }, { fetchImpl });

  const d = rs?.data ?? rs;
  return {
    prebookId: d?.prebookId ?? null,
    transactionId: d?.transactionId ?? null,
    secretKey: d?.secretKey ?? null,
    currency: d?.currency ?? null,
    total: num(d?.price ?? d?.retailRate?.total?.[0]?.amount),
    // Their field naming for this has moved before. Read defensively and, when
    // it cannot be determined, say so rather than reporting "no change" — the
    // failure mode of a wrong "no change" is somebody charged a price they
    // never saw.
    priceChanged:
      d?.priceChanged ?? d?.price_changed ?? (d?.priceDifference != null ? d.priceDifference !== 0 : null),
    priceDifference: num(d?.priceDifference),
    cancelPolicies: d?.cancellationPolicies?.cancelPolicyInfos ?? d?.cancelPolicyInfos ?? [],
    raw: d,
  };
}

/* ── BOOK ──────────────────────────────────────────────────────────────── */

/**
 * Everything a booking cannot go without.
 *
 * This list is the answer to "did we collect all the fields" and it belongs
 * next to the call that needs them, not in a form component. A form is a view;
 * this is the contract.
 */
export const BOOK_REQUIRED = Object.freeze({
  top: ['prebookId', 'holder', 'guests', 'payment'],
  holder: ['firstName', 'lastName', 'email'],
  guest: ['occupancyNumber', 'firstName', 'lastName'],
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * What is still missing, named in full dotted paths so a caller can put the
 * cursor in the right box.
 */
export function missingForBook(p = {}) {
  const missing = BOOK_REQUIRED.top.filter((k) => {
    if (k === 'guests') return !Array.isArray(p.guests) || p.guests.length === 0;
    return !p[k];
  });
  for (const k of BOOK_REQUIRED.holder) if (!p.holder?.[k]) missing.push(`holder.${k}`);
  if (p.holder?.email && !EMAIL.test(String(p.holder.email))) missing.push('holder.email (not an email)');
  (p.guests ?? []).forEach((g, i) => {
    for (const k of BOOK_REQUIRED.guest) {
      if (g?.[k] == null || g[k] === '') missing.push(`guests[${i}].${k}`);
    }
  });
  if (p.payment && !p.payment.method) missing.push('payment.method');
  if (p.payment?.method === 'TRANSACTION_ID' && !p.payment.transactionId) missing.push('payment.transactionId');
  return [...new Set(missing)];
}

/**
 * Whether this environment may commit at all, and if not, why in plain words.
 *
 * A reason rather than a boolean, because every one of these refusals is
 * something an operator will read at a bad moment.
 */
export function bookingGate(env) {
  if (!liteapiReady(env)) return { ok: false, why: 'LITEAPI_KEY is not set.' };
  if (env.LITEAPI_BOOKING_ENABLED !== 'true') {
    return { ok: false, why: 'Booking is switched off. Set LITEAPI_BOOKING_ENABLED=true to allow it.' };
  }
  if (keyEstate(env) === 'production' && env.LITEAPI_BOOKING_LIVE !== 'true') {
    return {
      ok: false,
      why: 'This is a production key. Live booking additionally needs LITEAPI_BOOKING_LIVE=true — two switches, on purpose.',
    };
  }
  return { ok: true, estate: keyEstate(env) };
}

export async function book(env, payload = {}, { fetchImpl } = {}) {
  const gate = bookingGate(env);
  if (!gate.ok) {
    const err = new Error(gate.why);
    err.status = 503;
    err.code = 'booking_gated';
    throw err;
  }
  const missing = missingForBook(payload);
  if (missing.length) {
    const err = new Error(`Cannot book without: ${missing.join(', ')}.`);
    err.status = 400;
    err.missing = missing;
    throw err;
  }
  const rs = await call(env, 'book', '/rates/book', {
    prebookId: payload.prebookId,
    holder: {
      firstName: payload.holder.firstName,
      lastName: payload.holder.lastName,
      email: payload.holder.email,
    },
    guests: payload.guests.map((g) => ({
      occupancyNumber: g.occupancyNumber,
      firstName: g.firstName,
      lastName: g.lastName,
      ...(g.email ? { email: g.email } : {}),
      ...(g.remarks ? { remarks: g.remarks } : {}),
    })),
    payment: payload.payment,
    // Idempotency. Without it a retried tap is a second room.
    ...(payload.clientReference ? { clientReference: payload.clientReference } : {}),
  }, { fetchImpl });

  const d = rs?.data ?? rs;
  return {
    bookingId: d?.bookingId ?? null,
    clientReference: d?.clientReference ?? payload.clientReference ?? null,
    supplierBookingId: d?.supplierBookingId ?? d?.supplierBookingReference ?? null,
    hotelConfirmationCode: d?.hotelConfirmationCode ?? null,
    status: d?.status ?? null,
    currency: d?.currency ?? null,
    total: num(d?.price ?? d?.retailRate?.total?.[0]?.amount),
    checkin: d?.checkin ?? null,
    checkout: d?.checkout ?? null,
    cancelPolicies: d?.cancellationPolicies?.cancelPolicyInfos ?? d?.cancelPolicyInfos ?? [],
    raw: d,
  };
}

export async function cancelBooking(env, bookingId, { fetchImpl } = {}) {
  const gate = bookingGate(env);
  if (!gate.ok) {
    const err = new Error(gate.why);
    err.status = 503;
    throw err;
  }
  if (!bookingId) {
    const err = new Error('cancel needs a bookingId.');
    err.status = 400;
    throw err;
  }
  const rs = await call(env, 'book', `/bookings/${encodeURIComponent(bookingId)}`, null, {
    method: 'PUT',
    fetchImpl,
  });
  const d = rs?.data ?? rs;
  return { bookingId, status: d?.status ?? 'CANCELLED', refund: num(d?.refundAmount), raw: d };
}

/* ── ROUTES ──────────────────────────────────────────────────────────────

   The routes are where the supplier call and the RECORD are joined, and the
   order matters more than it looks:

     prebook  → call the supplier, THEN write a held row
     book     → confirm the held row, or mark it failed with the supplier's
                own words
     cancel   → cancel at the supplier, THEN mark the row cancelled

   The row is written at prebook and not at book, deliberately. If it were only
   written on success, a booking the supplier confirmed and whose response NUM
   failed to read would be a room that exists with nothing in NUM pointing at
   it. This way the worst case is a held row that never became a booking —
   visible and reconcilable. The other way round is a guest holding a
   reservation NUM denies.
*/
import { hold, confirm as recordConfirm, fail as recordFail, cancelled as recordCancelled, forMember, byId, newClientReference } from './staybookings.mjs';

export async function handleStays(request, env, path, { session = null, fetchImpl } = {}) {
  const post = request.method === 'POST';
  const signedIn = !!(session?.memberId ?? session?.member_id);

  try {
    if (path === '/status') {
      const gate = bookingGate(env);
      return json({
        connected: liteapiReady(env),
        estate: keyEstate(env),
        shopping: liteapiReady(env),
        booking: gate.ok,
        booking_blocked_by: gate.ok ? null : gate.why,
        margin_public: marginFor(env, { member: false }),
        margin_member: marginFor(env, { member: true }),
        note:
          'Rates and booking are separate permissions. A margin of 0 means NUM sells at net — it is not a default this file chose.',
      });
    }

    if (path === '/search' && post) {
      const q = await readBody(request);
      const missing = missingForRates(q);
      if (missing.length) return json({ error: 'missing', missing }, 400);
      const rs = await searchRates(env, q, { member: signedIn, fetchImpl });
      const rates = normalizeRates(rs);
      const nights = nightsBetween(q.checkin, q.checkout);
      return json({
        options: offer(rates, {
          signedIn,
          nights,
          directKnownIds: new Set(q._directKnownIds ?? []),
          showSaving: env.LITEAPI_SHOW_SAVING === 'true',
        }),
        nights,
        // Deliberately NOT the count of everything found. A concierge that
        // says "and 213 more" is a search engine wearing a coat.
        member: signedIn,
      });
    }

    if (path === '/prebook' && post) {
      const b = await readBody(request);
      const pre = await prebook(env, { ...b, fetchImpl });
      // A hold is only recorded for a known member. An anonymous prebook is a
      // price check; there is nobody to show a receipt to and nobody to charge.
      let stayId = null;
      let clientReference = null;
      if (signedIn && b.option && b.query) {
        clientReference = newClientReference();
        const rec = await hold(env, {
          memberId: session.memberId ?? session.member_id,
          clientReference,
          prebook: pre,
          option: b.option,
          query: b.query,
          marginPct: marginFor(env, { member: true }),
          wasMemberRate: true,
        });
        stayId = rec.id;
      }
      // `raw` is the supplier's whole body. Useful on the server, not something
      // to hand a browser — it carries fields NUM has not read or vouched for.
      const { raw, ...safe } = pre;
      return json({ ...safe, stayId, clientReference });
    }

    if (path === '/mine') {
      if (!signedIn) return json({ error: 'Sign in to see your stays.' }, 401);
      return json({ stays: await forMember(env, session.memberId ?? session.member_id) });
    }

    if (path === '/book' && post) {
      const b = await readBody(request);
      const missing = missingForBook(b);
      if (missing.length) return json({ error: 'missing', missing }, 400);
      try {
        const confirmed = await book(env, b, { fetchImpl });
        if (b.stayId) await recordConfirm(env, b.stayId, confirmed);
        const { raw, ...safe } = confirmed;
        return json(safe);
      } catch (err) {
        // The held row must not be left saying "held" for a booking that will
        // never happen — that is the row somebody chases in March.
        if (b.stayId) await recordFail(env, b.stayId, err.message).catch(() => {});
        throw err;
      }
    }

    if (path.startsWith('/cancel/') && post) {
      // NUM's own id, not the supplier's. A route that took the supplier's id
      // would cancel any booking whose id somebody could guess; this one can
      // only reach a row that belongs to the caller.
      const stayId = path.slice('/cancel/'.length);
      if (!signedIn) return json({ error: 'Sign in to cancel a stay.' }, 401);
      const row = await byId(env, stayId, session.memberId ?? session.member_id);
      if (!row) return json({ error: 'No such stay.' }, 404);
      if (!row.booking_id) return json({ error: 'That stay was never confirmed, so there is nothing to cancel.' }, 409);
      const out = await cancelBooking(env, row.booking_id, { fetchImpl });
      await recordCancelled(env, stayId, { refund: out.refund ?? null });
      return json({ id: stayId, status: out.status, refund: out.refund ?? null });
    }

    return json({ error: 'No such stays route.' }, 404);
  } catch (err) {
    return json(
      { error: err.message, ...(err.missing ? { missing: err.missing } : {}), ...(err.code ? { code: err.code } : {}) },
      err.status ?? 500,
    );
  }
}
