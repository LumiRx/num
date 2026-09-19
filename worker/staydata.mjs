/**
 * Everything the supplier knows that NUM was not asking for.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * worker/liteapi.mjs reads one endpoint — `/hotels/rates` — and throws most of
 * even that away. The rail works, and it is answering a guest with a hotel
 * name and a number when the supplier is also holding photographs, amenities,
 * check-in times, guest reviews, an independent public-price reference, and a
 * commission ledger that says what NUM has actually been paid.
 *
 * Four of those change what NUM can do rather than how it looks:
 *
 *   1. PRICE INDEX is a SECOND public-price source. The cross-check in
 *      liteapi.mjs rests entirely on `suggestedSellingPrice` arriving in the
 *      rate payload. One number from one place, and NUM's whole member-rate
 *      claim leans on it. `/price-index/public-price` is a cached public price
 *      for the same property from the same supplier by a different route. Two
 *      references that agree is a fact; one is an assertion.
 *
 *   2. COMMISSION REPORT is the supplier's own record of what NUM earned.
 *      affiliate-setup.md already made this argument for scout attribution —
 *      "two independent records that have to agree is what makes a commission
 *      owed to a real person checkable rather than assertable". Same reasoning,
 *      and here it answers the harder question: is NUM being paid at all.
 *
 *   3. TAX SCHEMA says which taxes a property charges and when. NUM currently
 *      reports fees at the desk only when a rate happens to mark one excluded.
 *
 *   4. PLACES resolves a real placeId. Today NUM sends `cityName` + country,
 *      which is the weakest of the six ways their rates endpoint accepts a
 *      location, and it is why "Sukhumvit, Bangkok" searches Bangkok.
 *
 * ── WHAT THIS FILE DOES NOT DO ────────────────────────────────────────────
 *
 * It does not decide anything. Every function here READS. The wall in
 * liteapi.mjs still owns what reaches a guest, and nothing below is wired into
 * publicOption() — a richer payload is exactly how a margin leaks out by
 * accident.
 */

const HOST = {
  data: 'https://api.liteapi.travel/v3.0',
  book: 'https://book.liteapi.travel/v3.0',
};

const liteapiReady = (env) => !!env?.LITEAPI_KEY;

async function get(env, host, path, params = {}, { fetchImpl } = {}) {
  if (!liteapiReady(env)) {
    const err = new Error('LiteAPI is not configured. Set LITEAPI_KEY.');
    err.status = 503;
    throw err;
  }
  const url = new URL(`${HOST[host]}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const f = fetchImpl ?? fetch;
  const res = await f(url.toString(), {
    headers: { 'X-API-Key': env.LITEAPI_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(out?.error?.description ?? out?.message ?? `LiteAPI ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return out;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* ── HOTEL CONTENT ─────────────────────────────────────────────────────── */

/**
 * What a property actually is, beyond its name.
 *
 * The fields picked here are the ones a concierge would say out loud. Check-in
 * and check-out times are top of that list and NUM has never had them: "you
 * land at 6am and the room is not ready until 3pm, so leave the bags and go
 * and eat" is the whole job, and it is unanswerable without two timestamps.
 */
export async function hotelContent(env, hotelId, { fetchImpl } = {}) {
  const rs = await get(env, 'data', '/data/hotel', { hotelId }, { fetchImpl });
  const d = rs?.data ?? rs;
  if (!d) return null;
  return {
    hotelId: d.id ?? hotelId,
    name: d.name ?? null,
    description: d.hotelDescription ?? d.description ?? null,
    stars: num(d.starRating ?? d.stars),
    rating: num(d.rating),
    reviewCount: num(d.reviewCount),
    chain: d.chain ?? d.chainName ?? null,
    hotelType: d.hotelType ?? null,
    address: d.address ?? null,
    city: d.city ?? null,
    country: d.country ?? null,
    lat: num(d.latitude),
    lng: num(d.longitude),
    // The two that answer the most common real question.
    checkinFrom: d.checkinCheckoutTimes?.checkin ?? null,
    checkoutBefore: d.checkinCheckoutTimes?.checkout ?? null,
    checkinStart: d.checkinCheckoutTimes?.checkinStart ?? null,
    facilities: (d.hotelFacilities ?? d.facilities ?? []).map((f) => f?.name ?? f).filter(Boolean),
    // Photographs, kept as urls only. NUM does not rehost somebody else's
    // images and does not need to.
    images: (d.hotelImages ?? d.images ?? []).map((i) => i?.url ?? i).filter(Boolean).slice(0, 12),
    phone: d.phone ?? null,
    email: d.email ?? null,
  };
}

/** Guest reviews, for the one line a concierge would quote. */
export async function hotelReviews(env, hotelId, { limit = 10, fetchImpl } = {}) {
  const rs = await get(env, 'data', '/data/reviews', { hotelId, limit, getSentiment: true }, { fetchImpl });
  const rows = rs?.data ?? [];
  return rows.map((r) => ({
    rating: num(r.averageScore ?? r.rating),
    date: r.date ?? null,
    country: r.country ?? null,
    type: r.travelerType ?? null,
    headline: r.headline ?? null,
    pros: r.pros ?? null,
    cons: r.cons ?? null,
  }));
}

/**
 * Which taxes this property charges, and whether they are already in the rate.
 *
 * Today NUM only knows about a fee when a rate marks one excluded. That is the
 * supplier remembering to tell us. This is asking.
 */
export async function taxSchema(env, hotelId, { fetchImpl } = {}) {
  const rs = await get(env, 'data', '/data/hotel/tax-schema', { hotelId }, { fetchImpl });
  return rs?.data ?? null;
}

/* ── THE SECOND OPINION ────────────────────────────────────────────────── */

/**
 * A cached public price for this property, by a different route.
 *
 * ── WHY THIS MATTERS MORE THAN IT LOOKS ───────────────────────────────────
 *
 * Everything NUM says or implies about a member rate rests on
 * `suggestedSellingPrice` in the rate payload. One field, one call. If it is
 * ever wrong, missing, or stale, NUM floors a signed-out visitor to a bad
 * number or claims a saving that is not there — and NUM would have no way of
 * knowing.
 *
 * This is the same supplier saying the same thing by another road. Where the
 * two agree, the comparison is evidenced. Where they disagree, that is a
 * finding, not a rounding error, and `agreement()` below names it rather than
 * averaging it away.
 */
export async function publicPrice(env, { hotelId, checkin, checkout, currency = 'USD', fetchImpl } = {}) {
  const rs = await get(env, 'book', '/price-index/public-price',
    { hotelId, checkin, checkout, currency }, { fetchImpl });
  const d = rs?.data ?? rs;
  return {
    hotelId,
    total: num(d?.publicPrice ?? d?.price ?? d?.amount),
    currency: d?.currency ?? currency,
    asOf: d?.updatedAt ?? d?.cachedAt ?? null,
  };
}

/**
 * Do the two public-price references agree?
 *
 * `tolerancePct` is deliberately generous: these are two caches of a moving
 * number and a couple of per cent apart is normal. What this is looking for is
 * the case where one of them is plainly wrong — a stale figure, a different
 * room, a currency mix-up — which shows up as a large gap, not a small one.
 *
 * Returns a verdict rather than a boolean so a caller can log WHY.
 */
export function agreement(fromRate, fromIndex, { tolerancePct = 8 } = {}) {
  if (fromRate == null || fromIndex == null) {
    return { verdict: 'one_sided', usable: fromRate ?? fromIndex ?? null, gapPct: null };
  }
  if (fromRate <= 0 || fromIndex <= 0) return { verdict: 'nonsense', usable: null, gapPct: null };
  const gapPct = (Math.abs(fromRate - fromIndex) / Math.max(fromRate, fromIndex)) * 100;
  if (gapPct <= tolerancePct) {
    // Agreed. Use the HIGHER of the two as the public reference, because the
    // consequence of overstating a saving is worse than understating one.
    return { verdict: 'agreed', usable: Math.max(fromRate, fromIndex), gapPct };
  }
  // Disagreed. Do not average — one of them is wrong and averaging two numbers
  // when one is wrong produces a third number that is also wrong, while
  // looking more considered. Take the lower public price, which is the
  // conservative claim, and say the references disagreed.
  return { verdict: 'disagreed', usable: Math.min(fromRate, fromIndex), gapPct };
}

/* ── IS NUM ACTUALLY BEING PAID ────────────────────────────────────────── */

/**
 * The supplier's own commission ledger.
 *
 * NUM writes `margin_pct` and a total on every held row. That is NUM's record.
 * This is theirs. The question they answer together — "was NUM paid what NUM
 * believes it earned" — cannot be answered by either alone, and it is the
 * question that decides whether this rail is a business or a hobby.
 *
 * Payouts land weekly and a booking only counts as confirmed once the guest
 * has checked out, so a fresh booking legitimately appears in NUM's rows and
 * not here. Reconciliation has to allow for that rather than treat it as a
 * missing payment.
 */
export async function commissionReport(env, { from, to, fetchImpl } = {}) {
  const rs = await get(env, 'book', '/commissions/report', { from, to }, { fetchImpl });
  const rows = rs?.data ?? [];
  return rows.map((r) => ({
    bookingId: r.bookingId ?? r.booking_id ?? null,
    clientReference: r.clientReference ?? r.client_reference ?? null,
    commission: num(r.commission ?? r.amount),
    currency: r.currency ?? null,
    status: r.status ?? null,
    checkout: r.checkout ?? null,
    paidAt: r.paidAt ?? null,
  }));
}

/**
 * NUM's rows against theirs, matched on the reference NUM minted.
 *
 * Three buckets, and the names are the point: `unpaid` is not the same as
 * `not_yet_due`, and reporting them together is how a rail that has quietly
 * stopped paying looks healthy for a month.
 */
export function reconcile(ourRows, theirRows, { now = new Date() } = {}) {
  const theirs = new Map();
  for (const r of theirRows) if (r.clientReference) theirs.set(r.clientReference, r);

  const matched = [];
  const unpaid = [];
  const notYetDue = [];
  const unknownToUs = [];

  for (const our of ourRows) {
    const t = theirs.get(our.client_reference);
    if (t) {
      matched.push({ clientReference: our.client_reference, ours: our.total_cs, theirs: t.commission, status: t.status });
      theirs.delete(our.client_reference);
      continue;
    }
    // A stay whose checkout has not happened cannot have been paid yet.
    const out = Date.parse(`${our.checkout}T00:00:00Z`);
    if (Number.isFinite(out) && out > now.getTime()) notYetDue.push(our.client_reference);
    else unpaid.push(our.client_reference);
  }
  // Rows they have and NUM does not. Rare and worth shouting about: it means a
  // booking was made against NUM's account that NUM has no record of.
  for (const left of theirs.values()) unknownToUs.push(left.clientReference ?? left.bookingId);

  return { matched, unpaid, notYetDue, unknownToUs };
}

/* ── LOCATION ──────────────────────────────────────────────────────────── */

/**
 * A real placeId, instead of a city name.
 *
 * `cityName` is the weakest of the six ways their rates endpoint accepts a
 * location, and it is why "Sukhumvit, Bangkok" returns Bangkok. A concierge
 * whose whole claim is that it knows the neighbourhood should not be throwing
 * the neighbourhood away at the search.
 */
export async function resolvePlace(env, textQuery, { fetchImpl } = {}) {
  const rs = await get(env, 'data', '/data/places', { textQuery }, { fetchImpl });
  const rows = rs?.data ?? [];
  return rows.slice(0, 5).map((p) => ({
    placeId: p.placeId ?? p.place_id ?? null,
    name: p.displayName ?? p.name ?? null,
    type: p.types?.[0] ?? p.type ?? null,
    lat: num(p.latitude ?? p.location?.latitude),
    lng: num(p.longitude ?? p.location?.longitude),
  })).filter((p) => p.placeId);
}

/** The cheap "from $X" for a city, without pulling every rate. */
export async function minRates(env, body = {}, { fetchImpl } = {}) {
  const f = fetchImpl ?? fetch;
  const res = await f(`${HOST.data}/hotels/min-rates`, {
    method: 'POST',
    headers: { 'X-API-Key': env.LITEAPI_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(out?.error?.description ?? `LiteAPI ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return (out?.data ?? []).map((r) => ({
    hotelId: r.hotelId ?? r.id,
    from: num(r.minRate ?? r.price),
    currency: r.currency ?? null,
  }));
}

/* ── THE DISCLOSURE THAT COMES WITH THIS RAIL ──────────────────────────── */

/**
 * A booking made this way is not a booking made with the hotel.
 *
 * This is not a LiteAPI quirk, it is how wholesale distribution works
 * everywhere: a room bought through a third party does not earn the chain's
 * points, and Marriott stopped extending elite benefits to reservations made
 * through online travel agencies at all. A Bonvoy Titanium who books a
 * Marriott through NUM can lose their upgrade, their breakfast and their
 * points on the same stay.
 *
 * For most travellers that is worth less than the money saved. For some it is
 * worth far more, and they are exactly the guests NUM most wants. So the rule
 * is not to hide it and not to lead with it: say it where it applies, which is
 * a chain property, and say what the alternative is — NUM already knows the
 * hotel's own booking page for the properties in worker/booking.mjs, and
 * sending somebody there is a real answer rather than a lost sale.
 */
export const LOYALTY_DISCLOSURE =
  'A room booked through NUM does not earn the hotel chain\'s own points, and at some chains it does '
  + 'not carry elite benefits either — Marriott withdrew those from online travel agency bookings. '
  + 'If they hold status with the chain, SAY THIS BEFORE THEY BOOK, not after, and offer to send them '
  + 'to the hotel\'s own page instead. Losing a night\'s upgrade to save eleven dollars is not a saving, '
  + 'and being the one who told them is worth more than the booking.';

/** True where the disclosure applies: a property belonging to a loyalty chain. */
const CHAIN_WORDS =
  /marriott|bonvoy|hilton|honors|hyatt|ihg|intercontinental|holiday inn|kimpton|crowne plaza|accor|all ?-? ?accor|sofitel|novotel|mercure|radisson|wyndham|best western|choice|comfort inn|sheraton|westin|ritz|st\.? regis|w hotels|four points|courtyard|residence inn|doubletree|hampton|embassy suites|waldorf|conrad/i;

export const chainProperty = (hotel = {}) =>
  CHAIN_WORDS.test(`${hotel.chain ?? ''} ${hotel.name ?? hotel.hotelName ?? ''}`);
