// Sabre — real flight and hotel content, at last.
//
// Everything Num has done for air and stays until now has been a hand-off: a
// deep link into somebody else's app. Sabre is the first source that can
// actually answer "what does it cost and when does it leave" from inside Num.
//
// THE LIMIT THAT SHAPES THIS FILE: every endpoint here is SHOPPING, not
// booking. Flight Shop, Flight Search, Hotel Rates and Price Check return
// offers and prices. None of them creates a PNR, an order or a reservation.
// Flight Check and Hotel Price Check are the closest — they revalidate a fare
// or rate with the supplier — and they are still the step *before* a booking.
// Flight Check is explicit that it does not decrement or hold inventory, so it
// buys certainty about the price and no claim at all on the seat.
//
// Booking itself lives in Sabre Order / the Booking Management API, which is
// not wired here.
//
// So Num can now say "that flight is $122.99 and leaves at 23:59" as fact,
// and still cannot say "I've booked it". Those are different claims and the
// prompt has to keep them apart, because a concierge that invents a booking
// is worse than one that admits it can only quote.
//
// A second thing worth stating plainly: an offer has a shelf life. Every
// response carries `validUntil` (often ~20 minutes) and a `paymentTimeLimit`.
// A price shown after that is not a price, it is a memory of one — so the
// normalizer keeps the expiry and callers are expected to honour it.

const REST = {
  // Sabre runs two estates. Certification is where an integration lives until
  // it has proved itself; pointing at production early is how you find out
  // that your test data was real money.
  cert: 'https://api.cert.platform.sabre.com',
  prod: 'https://api.platform.sabre.com',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const readBody = async (req) => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};

export const sabreReady = (env) => !!(env.SABRE_CLIENT_ID && env.SABRE_CLIENT_SECRET);

const base = (env) => (env.SABRE_ENV === 'prod' ? REST.prod : REST.cert);

/**
 * Paths this file is SURE of, taken from the published request/response docs.
 *
 * The hotel and reshop services are deliberately absent: their documentation
 * gives the request bodies but not the endpoint paths, and a guessed path is
 * indistinguishable from an outage at 3am. They are read from config instead,
 * so the operator pastes the real path once and everything downstream works —
 * see `/api/sabre/status`, which says exactly which ones are still missing.
 */
const PATHS = {
  flightShopLite: '/v1/offers/flightShopLite',
  flightShop: '/v1/offers/flightShop',
  flightSearch: '/v1/offers/flightSearch',
  flightCheck: '/v1/offers/flightCheck',
  flightRefresh: '/v1/offers/flightRefresh',
  hotelRates: '/v1/hotels/getHotelRates',
  hotelPriceCheck: '/v1/hotels/checkHotelRate',
};

const configuredPath = (env, key) =>
  ({
    flightRefresh: env.SABRE_FLIGHT_REFRESH_PATH,
    hotelRates: env.SABRE_HOTEL_RATES_PATH,
    hotelPriceCheck: env.SABRE_HOTEL_PRICECHECK_PATH,
    flightReshop: env.SABRE_FLIGHT_RESHOP_PATH,
  })[key] || null;

// ── auth ──────────────────────────────────────────────────────────────────

// A token is good for days, so minting one per request would be both slow and
// rude. Cached per isolate, refreshed a minute early so a request never races
// its own expiry.
let cached = { token: null, expires: 0 };
/** Which encoding this account actually accepts, once we have learned it. */
let workingStyle = null;

const encodings = {
  // The documented v2 scheme: each half encoded, joined, encoded again.
  double: (id, secret) => btoa(`${btoa(id)}:${btoa(secret)}`),
  // Ordinary HTTP Basic. Some accounts and some proxies want this instead.
  plain: (id, secret) => btoa(`${id}:${secret}`),
};

async function mint(env, style) {
  const res = await fetch(`${base(env)}/v2/auth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${encodings[style](env.SABRE_CLIENT_ID, env.SABRE_CLIENT_SECRET)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && !!body.access_token, status: res.status, body };
}

/**
 * Mint an ATK access token, working out the encoding rather than assuming it.
 *
 * v2 documents **double Base64**: each credential half encoded on its own,
 * joined with a colon, then the whole thing encoded again —
 *
 *   base64( base64(clientId) + ':' + base64(clientSecret) )
 *
 * The clientId is an EPR triplet like `V1:user:group:domain`, provisioned by a
 * Sabre account manager. But a wrong guess here fails as a bare 401 saying
 * only "syntax is not correct", which is indistinguishable from a wrong
 * password — so instead of forcing an operator to bisect that by hand, this
 * tries the documented scheme, then plain Basic, and remembers whichever the
 * account accepts. SABRE_CREDENTIAL_STYLE pins it if you would rather not
 * have the fallback.
 *
 * One token serves everything: REST takes it as `Authorization: Bearer`, SOAP
 * takes the identical string inside <wsse:BinarySecurityToken>.
 */
async function token(env) {
  const now = Date.now();
  if (cached.token && now < cached.expires) return cached.token;

  const pinned = env.SABRE_CREDENTIAL_STYLE;
  const order = pinned ? [pinned] : [workingStyle, 'double', 'plain'].filter((v, i, a) => v && a.indexOf(v) === i);

  const attempts = [];
  let last = null;
  for (const style of order) {
    const attempt = await mint(env, style);
    attempts.push({ style, status: attempt.status, error: attempt.body?.error_description ?? attempt.body?.error ?? null });
    if (attempt.ok) {
      workingStyle = style;
      cached = {
        token: attempt.body.access_token,
        expires: now + Math.max(60, (attempt.body.expires_in ?? 604800) - 60) * 1000,
      };
      return cached.token;
    }
    last = attempt;
    // A 401 means "these credentials, encoded this way, are not accepted" —
    // worth trying the other encoding. Anything else is not an encoding
    // problem and retrying would just be noise.
    if (attempt.status !== 401) break;
  }

  // Report the DOCUMENTED encoding's error, not whichever attempt happened to
  // run last. Sabre distinguishes the two failures precisely and reporting the
  // wrong one sends you hunting the wrong bug:
  //
  //   "Wrong clientID or clientSecret"  → header parsed fine, VALUES are wrong
  //   "...syntax is not correct"        → header could not be parsed at all
  //
  // The plain-Basic fallback always produces the syntax message on an account
  // that wants double-Base64, so surfacing it as THE error made a plain
  // wrong-password look like an encoding problem.
  const primary = attempts.find((a) => a.style === 'double') ?? attempts[0];
  const err = new Error(primary?.error ?? `Sabre auth ${last?.status ?? 'failed'}`);
  err.status = primary?.status ?? last?.status ?? 502;
  err.attempts = attempts;
  err.hint = pinned
    ? `Pinned to the ${pinned} encoding.`
    : /wrong client/i.test(primary?.error ?? '')
      ? 'The encoding is correct — Sabre parsed the header and rejected the credentials themselves. Check the secret was copied after clicking the eye icon, and that the test pair has not been reset. Run `node scripts/sabre-check.mjs` to test a pair directly.'
      : 'Neither encoding was accepted. Run `node scripts/sabre-check.mjs` to test the pair directly against Sabre.';
  throw err;
}

/** Which encoding worked, for the status endpoint. Never the token itself. */
export const credentialStyle = () => workingStyle;

/** Shared with the booking module so both estates reuse one cached token. */
export const sabreToken = (env) => token(env);

/** One 401 is worth retrying — a cached token can expire between check and use. */
async function call(env, path, body, { method = 'POST', retry = true } = {}) {
  const res = await fetch(`${base(env)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token(env)}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    // Shopping across many sources is not instant, but a traveller staring at
    // a spinner is not waiting a minute either.
    signal: AbortSignal.timeout(30_000),
  });

  if (res.status === 401 && retry) {
    cached = { token: null, expires: 0 };
    return call(env, path, body, { method, retry: false });
  }

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    const err = new Error(parsed?.message ?? parsed?.error_description ?? parsed?.error ?? `Sabre ${res.status}`);
    err.status = res.status;
    err.detail = parsed;
    throw err;
  }
  return parsed;
}

// ── normalizing ───────────────────────────────────────────────────────────

/**
 * Flatten the ref graph into something a person can read.
 *
 * Sabre's response is normalized by design: offers point at journeys, journeys
 * point at flights, and fares point back at flights again for cabin and
 * booking class. That is the right shape to send over a wire and the wrong
 * shape to render, so this resolves it once, here, rather than in every caller.
 */
export function normalizeOffers(rs) {
  const flights = new Map((rs.flights ?? []).map((f) => [f.id, f]));
  const journeys = new Map((rs.journeys ?? []).map((j) => [j.id, j]));

  return (rs.offers ?? []).map((offer) => {
    // Cabin and booking class live on the fare, keyed by flight — collect them
    // first so each leg can carry what the traveller actually gets.
    const perFlight = new Map();
    for (const item of offer.items ?? []) {
      for (const fare of item.fares ?? []) {
        for (const comp of fare.fareComponents ?? []) {
          for (const seg of comp.segmentDetails ?? []) {
            perFlight.set(seg.flightRef, {
              cabin: seg.cabinName ?? null,
              bookingClass: seg.bookingClassCode ?? null,
              fareBasis: comp.fareBasisCode ?? null,
              ...(comp.brand ? { brand: comp.brand.name ?? comp.brand.code } : {}),
              ...(seg.carbonEmissionsInGramsPerPassenger
                ? { carbonKgPerPassenger: Math.round(seg.carbonEmissionsInGramsPerPassenger / 1000) }
                : {}),
            });
          }
        }
      }
    }

    const legs = (offer.journeyRefs ?? [])
      .map((ref) => journeys.get(ref))
      .filter(Boolean)
      .map((j) => ({
        requestedJourneyIndex: j.requestedJourneyIndex ?? null,
        // One journey may be several flights; the count minus one is the thing
        // travellers actually care about, so it is computed rather than implied.
        stops: Math.max(0, (j.flightRefs ?? []).length - 1),
        segments: (j.flightRefs ?? [])
          .map((fr) => {
            const f = flights.get(fr);
            if (!f) return null;
            const extra = perFlight.get(fr) ?? {};
            return {
              from: f.departureAirportCode,
              to: f.arrivalAirportCode,
              departs: `${f.departureDate}T${f.departureTime}`,
              arrives: `${f.arrivalDate}T${f.arrivalTime}`,
              marketing: `${f.marketingAirlineCode}${f.marketingFlightNumber}`,
              // Codeshares matter to travellers: the plane you board is the
              // operating carrier, whatever the ticket says.
              operating: `${f.operatingAirlineCode}${f.operatingFlightNumber}`,
              codeshare: f.operatingAirlineCode !== f.marketingAirlineCode,
              aircraft: f.aircraftTypeCode ?? null,
              durationInMinutes: f.durationInMinutes ?? null,
              ...(f.hiddenStops?.length ? { hiddenStops: f.hiddenStops } : {}),
              ...extra,
            };
          })
          .filter(Boolean),
      }));

    const firstFare = offer.items?.[0]?.fares?.[0];
    return {
      id: offer.id,
      price: offer.totalPrice?.amount ?? null,
      currency: offer.totalPrice?.currencyCode ?? null,
      tax: firstFare?.fareTotal?.taxAmount ?? null,
      validatingCarrier: firstFare?.validatingAirlineCode ?? null,
      source: offer.source ?? null,
      // Both clocks the caller has to respect. An offer past `validUntil` is
      // not a cheap fare, it is a stale one.
      validUntil: offer.validUntil ?? null,
      paymentTimeLimit: offer.paymentTimeLimit ?? null,
      legs,
      totalDurationInMinutes: legs.reduce(
        (n, l) => n + l.segments.reduce((m, s) => m + (s.durationInMinutes ?? 0), 0),
        0,
      ),
    };
  });
}

// ── the shopping calls ────────────────────────────────────────────────────

/**
 * The everyday search: origin, destination, date, who is flying.
 *
 * Lite is the default because it answers in seconds off pre-computed offers
 * and costs nothing per look. Full Flight Shop is there for when the answer
 * has to be live rather than fast.
 *
 * Everything else in the request is forwarded untouched, because the schema
 * carries far more than an origin and a date and a concierge needs it: `route`
 * caps stops and connection times, `airlines` includes or excludes carriers
 * and alliances, `fare` sets currency and cabin, `retailing` asks for baggage
 * and flexibility, `sources` picks which content to shop. An adapter that
 * quietly forwarded only journeys and travelers would make "cheapest non-stop
 * on a Star Alliance carrier in premium economy" impossible to express, which
 * is most of what a good concierge actually does.
 */
export function shopFlights(env, { journeys, travelers, limit, full = false, raw: _raw, ...rest }) {
  const pcc = rest.processingOptions?.pseudoCityCode ?? env.SABRE_PCC;
  return call(env, full ? PATHS.flightShop : PATHS.flightShopLite, {
    ...rest,
    journeys,
    travelers: travelers?.length ? travelers : [{ passengerTypeCode: 'ADT' }],
    // Merge rather than replace: building this object fresh would silently
    // discard a caller's cabin logic, configurationId or PCC.
    processingOptions: {
      ...(rest.processingOptions ?? {}),
      ...(limit ? { limitNumberOfOffers: Math.min(1000, Math.max(1, Math.floor(limit))) } : {}),
      ...(pcc ? { pseudoCityCode: pcc } : {}),
    },
  });
}

/**
 * The inspirational one: anywhere, sometime, under this much.
 *
 * This is the call behind "somewhere warm in November for under £500" — open
 * destination, open date, budget capped. It is a different question from
 * "get me to Dallas on the 9th" and Num should not conflate them.
 */
export function exploreFlights(env, body) {
  return call(env, PATHS.flightSearch, withPcc(env, body));
}

/**
 * Attach the point of sale, if we have one.
 *
 * Without an explicit PCC Sabre derives one from the credential, and a
 * credential whose group is not a valid 3-4 character PCC (DEVCENTER, say)
 * yields either a validation error or, worse, an empty result set that looks
 * exactly like "no flights today".
 */
function withPcc(env, body) {
  const pcc = body?.processingOptions?.pseudoCityCode ?? env.SABRE_PCC;
  if (!pcc) return body;
  return { ...body, processingOptions: { ...(body.processingOptions ?? {}), pseudoCityCode: pcc } };
}

/**
 * Revalidate one itinerary — the step that stops a booking failing.
 *
 * This is the strongest thing Num can currently do to an air offer, and its
 * limit is the interesting part: Flight Check is fully live, but it does NOT
 * decrement or hold airline inventory. So "that fare is still there at that
 * price, right now" is true after this call, and "I've held your seat" is not
 * and never will be. Those two sentences are one word apart in English and a
 * whole contract apart in reality.
 *
 * Two mutually exclusive shapes, per the spec's `oneOf`:
 *   journeys + travelers   traditional ATPCO — each journey carries `flights`
 *   offerItemIds           NDC — the ids the carrier gave you, as an ARRAY
 *
 * Note `offerItemIds`, plural and lowercase-d. The prose calls it offerItemID
 * and the schema does not, and the schema is the one the server validates.
 *
 * The PCC belongs at `processingOptions.pseudoCityCode`, not the top level,
 * and the schema does not mark it required — so it is filled in when we have
 * one and left alone when we do not, rather than being invented or demanded.
 */
export function checkFlight(env, body) {
  const pcc = body.processingOptions?.pseudoCityCode ?? body.pseudoCityCode ?? env.SABRE_PCC;
  const { pseudoCityCode: _drop, ...rest } = body;
  return call(env, PATHS.flightCheck, {
    ...rest,
    ...(pcc ? { processingOptions: { ...(body.processingOptions ?? {}), pseudoCityCode: pcc } } : {}),
  });
}

/**
 * A flight check answers two questions, and only one of them is the price.
 *
 * `bookingClassCodeValidation` is the one that decides what Num is allowed to
 * say. "Matched" means the fare came back exactly as shopped. "Same cabin"
 * means the airline gave us something else in the same cabin — still a real
 * offer, but NOT the one the traveller was looking at, and presenting it as
 * unchanged would be a lie of omission about the thing they cared about.
 */
export function normalizeFlightCheck(rs) {
  const offers = normalizeOffers(rs);
  const verdictFor = new Map((rs.offerValidationResults ?? []).map((v) => [v.offerRef, v.bookingClassCodeValidation]));

  return {
    offers: offers.map((o) => {
      const verdict = verdictFor.get(o.id) ?? 'Unknown';
      return {
        ...o,
        bookingClassValidation: verdict,
        // One boolean the caller cannot misread. Anything that is not an exact
        // match is an alternative, including "Unknown" — when the API will not
        // say it matched, we do not get to assume it did.
        isSameFare: verdict === 'Matched',
        // Unadvertised stops are exactly the kind of thing a traveller finds
        // out about at the gate, so they are lifted to the top rather than
        // left buried in the flight objects.
        hiddenStops: o.legs.flatMap((l) => l.segments).flatMap((sg) => sg.hiddenStops ?? []),
      };
    }),
    // The airline's own words. NDC carriers put card fees and loyalty notes
    // here, and they are worth passing through rather than swallowing.
    warnings: rs.warnings ?? [],
    errors: rs.errors ?? [],
    taxItems: rs.taxItems ?? [],
    offerAttributes: rs.offerAttributes ?? null,
  };
}

/**
 * Are these still available? Asked about many itineraries at once.
 *
 * The division of labour against Flight Check is worth keeping straight,
 * because using the wrong one is either slow or misleading:
 *
 *   Refresh  MANY itineraries, availability only, against Sabre inventory.
 *            The cheap sweep — "is any of this shortlist still bookable".
 *   Check    ONE itinerary, revalidates the PRICE as well, offers upsells,
 *            and returns what an order needs. The deep look, once they have
 *            chosen.
 *
 * So Refresh is what a saved trip runs against every leg overnight, and Check
 * is what runs the moment somebody says "that one". Refresh saying a flight is
 * available is NOT a statement that the price held — only Check speaks to that.
 *
 * Per the spec, all three of journeys, travelers and itineraries are required:
 * `itineraries` is the batch being validated, and the other two give the trip
 * criteria it is validated against. Missing one is the likely first mistake,
 * so it is caught by name here rather than as a schema violation.
 */
export function refreshFlights(env, body) {
  const missing = ['journeys', 'travelers', 'itineraries'].filter((k) => !body?.[k]?.length);
  if (missing.length) {
    const err = new Error(`Flight Refresh needs ${missing.join(', ')}.`);
    err.status = 400;
    throw err;
  }
  const path = configuredPath(env, 'flightRefresh') ?? PATHS.flightRefresh;
  return call(env, path, withPcc(env, body));
}

/**
 * Every rate for one property and one stay.
 *
 * The PCC lives at `pos.source.pseudoCityCode` and must be FOUR characters —
 * the hotel APIs are stricter than the flight ones, which accept three or
 * four. Without it Sabre derives a point of sale from the credential, which is
 * exactly what returned empty results across every flight market until it was
 * sent explicitly.
 */
export function hotelRates(env, b) {
  const path = configuredPath(env, 'hotelRates') ?? PATHS.hotelRates;
  const pcc = b.pos?.source?.pseudoCityCode ?? env.SABRE_PCC;
  return call(env, path, {
    currencyCode: b.currencyCode ?? 'USD',
    checkInDate: b.checkInDate,
    checkOutDate: b.checkOutDate,
    hotelCode: String(b.hotelCode),
    numberOfAdults: Math.max(1, Math.floor(Number(b.numberOfAdults)) || 2),
    numberOfChildren: Math.max(0, Math.floor(Number(b.numberOfChildren)) || 0),
    ...(b.childAges?.length ? { childAges: b.childAges } : {}),
    ...(b.roomType ? { roomType: b.roomType } : {}),
    ...(b.bedType ? { bedType: b.bedType } : {}),
    ...(b.searchSource ? { searchSource: b.searchSource } : {}),
    ...(b.sortBy ? { sortBy: b.sortBy } : {}),
    ...(b.sortOrder ? { sortOrder: b.sortOrder } : {}),
    maxResults: Math.min(40, Math.max(1, Math.floor(Number(b.maxResults)) || 10)),
    ...(pcc && pcc.length === 4 ? { pos: { source: { pseudoCityCode: pcc } } } : {}),
  });
}

/**
 * Flatten rooms → rate plans into one list a person can read.
 *
 * The graph is three deep (room → ratePlan → rateDetails) and the thing a
 * traveller actually compares — nightly rate, total, refundable or not — is
 * spread across all three levels.
 */
export function normalizeRates(rs) {
  const out = [];
  for (const room of rs.rooms ?? []) {
    for (const plan of room.ratePlans ?? []) {
      const d = plan.rateDetails ?? {};
      const cancel = (d.cancelPenalties ?? [])[0];
      out.push({
        // The key a price check needs. Without it a rate is a number you
        // cannot act on.
        rateKey: plan.rateKey ?? null,
        roomType: room.roomTypeName ?? room.roomTypeCode ?? null,
        roomName: room.roomDescription?.name ?? null,
        description: room.roomDescription?.text ?? null,
        beds: (room.bedTypes ?? []).map((b) => `${b.numberOfBeds ?? 1}× ${b.description ?? b.name ?? 'bed'}`).join(', ') || null,
        amenities: room.amenities ?? [],
        plan: plan.ratePlanName ?? null,
        mealPlan: plan.mealPlanDescription ?? null,
        inclusions: plan.inclusions ?? [],
        prepaid: !!plan.isRatePrepaid,
        limited: !!plan.limitedAvailability,
        nightly: d.averageNightlyRate ?? null,
        total: d.approxTotalPrice ?? null,
        currency: d.currencyCode ?? rs.currencyCode ?? null,
        taxInclusive: !!d.isTaxInclusive,
        feesInclusive: !!d.areAdditionalFeesInclusive,
        taxes: d.taxes?.amount ?? null,
        fees: d.fees?.amount ?? null,
        // Refundability is the first thing anybody asks and the last thing
        // most booking screens show.
        refundable: cancel?.refundable ?? null,
        cancelPolicy: cancel?.description ?? null,
        guarantee: d.guarantee?.guaranteeDescription ?? null,
        adults: room.numberOfAdults ?? null,
      });
    }
  }
  return out;
}

/**
 * Confirm one rate with the supplier before anybody commits.
 *
 * `priceChange` is the field that decides what Num may say — the hotel
 * equivalent of the flight check's booking-class verdict. A rate that came
 * back with priceChange true is NOT the rate the traveller was looking at,
 * and `bookingKey` is what an actual booking would need.
 */
export function hotelPriceCheck(env, b) {
  const path = configuredPath(env, 'hotelPriceCheck') ?? PATHS.hotelPriceCheck;
  const pcc = b.pseudoCityCode ?? env.SABRE_PCC;
  return call(env, path, {
    hotelPriceCheckRq: {
      ...(pcc && pcc.length === 4 ? { pos: { source: { pseudoCityCode: pcc } } } : {}),
      rateInfoRef: {
        rateKey: b.rateKey,
        ...(b.checkInDate && b.checkOutDate
          ? { stayDateTimeRange: { checkInDate: b.checkInDate, checkOutDate: b.checkOutDate } }
          : {}),
        rooms: {
          room: [
            {
              roomIndex: 1,
              numberOfAdults: Math.max(1, Math.floor(Number(b.numberOfAdults)) || 2),
              numberOfChildren: Math.max(0, Math.floor(Number(b.numberOfChildren)) || 0),
              ...(b.childAges?.length ? { childAges: b.childAges } : {}),
            },
          ],
        },
      },
    },
  });
}

/** The answer in the two terms that matter: did it move, and by how much. */
export function normalizePriceCheck(rs) {
  const info = rs.hotelPriceCheckRs?.priceCheckInfo;
  if (!info) return null;
  const first = info.hotelRateInfo?.rateInfos?.rateInfo?.[0] ?? {};
  return {
    bookingKey: info.bookingKey ?? null,
    priceChanged: !!info.priceChange,
    priceDifference: info.priceDifference ?? null,
    currency: info.currencyCode ?? first.currencyCode ?? null,
    total: first.amountAfterTax ?? first.approxTotalPrice ?? null,
    beforeTax: first.amountBeforeTax ?? null,
    nightly: first.averageNightlyRate ?? null,
    taxInclusive: !!first.taxInclusive,
  };
}

/** Exchange options for a ticket already held./** Exchange options for a ticket already held. ATPCO only while in beta. */
export function reshopFlight(env, body) {
  const path = configuredPath(env, 'flightReshop');
  if (!path) throw pathMissing('flight reshop', 'SABRE_FLIGHT_RESHOP_PATH');
  return call(env, path, body);
}

function pathMissing(what, envVar) {
  const err = new Error(
    `The Sabre ${what} endpoint path isn’t configured. Set ${envVar} to the path from its API reference — it is not guessed here on purpose.`,
  );
  err.status = 501;
  return err;
}

// ── routes ────────────────────────────────────────────────────────────────

export async function handleSabre(request, env, path) {
  if (!sabreReady(env)) {
    return json(
      {
        connected: false,
        needs: 'SABRE_CLIENT_ID and SABRE_CLIENT_SECRET',
        note: 'Sabre shops flights and hotel rates. None of these endpoints book — they quote.',
      },
      path === '/status' ? 200 : 503,
    );
  }
  const url = new URL(request.url);
  const post = request.method === 'POST';

  try {
    if (path === '/status') {
      // A real token round trip. Config-shaped health checks pass right up
      // until the moment someone actually needs the thing to work.
      let auth = { ok: true };
      try {
        await token(env);
      } catch (err) {
        auth = {
          ok: false,
          error: err.message,
          status: err.status ?? null,
          ...(err.attempts ? { attempts: err.attempts } : {}),
          ...(err.hint ? { hint: err.hint } : {}),
        };
      }
      return json({
        connected: auth.ok,
        environment: env.SABRE_ENV === 'prod' ? 'production' : 'certification',
        ...(auth.ok ? { credential_encoding: credentialStyle() } : { auth }),
        capabilities: {
          shop_flights: true,
          explore_flights: true,
          // Revalidate a fare before handing off. Live, but holds nothing.
          flight_check: true,
          flight_refresh: true,
          hotel_rates: true,
          hotel_price_check: true,
          flight_reshop: !!configuredPath(env, 'flightReshop'),
          book_anything: false,
        },
        // Said out loud so it cannot be assumed away later.
        note: 'Shopping only. No endpoint here creates a booking, PNR or order.',
        ...(configuredPath(env, 'hotelRates') && configuredPath(env, 'hotelPriceCheck')
          ? {}
          : { missing_paths: ['SABRE_HOTEL_RATES_PATH', 'SABRE_HOTEL_PRICECHECK_PATH', 'SABRE_FLIGHT_RESHOP_PATH'].filter((v) => !env[v]) }),
      });
    }

    if (path === '/flights' && post) {
      const b = await readBody(request);
      if (!b.journeys?.length) return json({ error: 'journeys required — where from, where to, what date' }, 400);
      const rs = await shopFlights(env, b);
      return json({ offers: normalizeOffers(rs), count: (rs.offers ?? []).length, raw: b.raw ? rs : undefined });
    }

    if (path === '/explore' && post) {
      const rs = await exploreFlights(env, await readBody(request));
      return json({ offers: normalizeOffers(rs), count: (rs.offers ?? []).length });
    }

    if (path === '/flight-check' && post) {
      const b = await readBody(request);
      // One of the two modes has to be present. Checking this here means a
      // missing offer reads as a missing offer, not as a Sabre 400.
      // The spec is a oneOf: journeys+travelers, or offerItemIds. Anything
      // else is a 400 from us with a useful sentence rather than a schema
      // violation from Sabre.
      if (!b.offerItemIds?.length && !b.journeys?.length) {
        return json({ error: 'send either offerItemIds (NDC, an array) or journeys + travelers (ATPCO)' }, 400);
      }
      if (b.journeys?.length && !b.travelers?.length) {
        return json({ error: 'travelers is required alongside journeys' }, 400);
      }
      const rs = await checkFlight(env, b);
      return json({ ...normalizeFlightCheck(rs), result: b.raw ? rs : undefined });
    }

    if (path === '/refresh' && post) {
      const rs = await refreshFlights(env, await readBody(request));
      // Refresh answers with `itineraries`, NOT the offers/journeys/flights
      // graph its siblings return — it is an availability verdict per
      // itinerary, not a repriced offer. Running it through normalizeOffers
      // would quietly yield nothing and look like "no availability".
      return json({ itineraries: rs.itineraries ?? [], errors: rs.errors ?? [], timestamp: rs.timestamp ?? null });
    }

    if (path === '/hotel/rates' && post) {
      const b = await readBody(request);
      if (!b.hotelCode || !b.checkInDate || !b.checkOutDate) {
        return json({ error: 'hotelCode, checkInDate and checkOutDate are required' }, 400);
      }
      const rs = await hotelRates(env, b);
      return json({
        hotelCode: rs.hotelCode ?? b.hotelCode,
        chainCode: rs.chainCode ?? null,
        rates: normalizeRates(rs),
        errors: rs.errors ?? [],
        warnings: rs.warnings ?? [],
        ...(b.raw ? { result: rs } : {}),
      });
    }

    if (path === '/hotel/price-check' && post) {
      const b = await readBody(request);
      if (!b.rateKey) return json({ error: 'rateKey required — it comes from a rates response' }, 400);
      const rs = await hotelPriceCheck(env, b);
      const checked = normalizePriceCheck(rs);
      return json(checked ? { ...checked, result: b.raw ? rs : undefined } : { error: 'No price check came back for that rate.', result: rs });
    }

    if (path === '/reshop' && post) return json(await reshopFlight(env, await readBody(request)));

    return json({ error: 'not found' }, 404);
  } catch (err) {
    console.error('[sabre]', path, err?.message ?? err);
    return json({ error: err?.message ?? 'that didn’t go through', detail: err?.detail ?? null }, err?.status ?? 500);
  }
}
