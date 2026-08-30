// The connector pipeline — every rail Num could have, and exactly where each one is stuck.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
//
// services.mjs already answers "can we complete this right now?" (ADAPTERS +
// connected()). That is the runtime question and it is answered well. It does
// NOT answer the operator's question, which is the one that actually decides
// what Num can do in six weeks:
//
//   "Which rails are one signup away, which need a human to email someone,
//    and which are we wasting our time on?"
//
// That answer lived in a research document, then in somebody's head, then
// nowhere. So the same connector got investigated three times and the two that
// were self-serve never got signed up for, because nothing in the codebase
// said they were self-serve.
//
// This is that list, in code, next to the seam it feeds. A connector moves
// through STATES, and the state is not an opinion:
//
//   live       — credentials present in env RIGHT NOW. Verified, not claimed.
//   keyless    — works with no credential at all. If it is not wired, that is
//                purely our own backlog and nobody else's gate.
//   self_serve — a key exists behind a signup form we can complete in minutes.
//                No sales call, no volume minimum, no approval queue.
//   apply      — a real application to a real human. Weeks, and it can be
//                refused. Worth starting early precisely because it is slow.
//   gated      — an API that exists but is closed to a company our size today.
//                Revisit at a stated threshold, not on a feeling.
//   dead       — verified closed, or verified not to do the thing we need.
//                Recorded so nobody researches it a fourth time.
//
// ── THE RULE THAT MAKES THIS SAFE ────────────────────────────────────────
//
// `live` is NEVER hand-written. It is derived from ADAPTERS[].ready(env), the
// same predicate the prompt uses. A connector cannot be described as live in
// the console while the concierge believes it is a hand-off, because both read
// the same function. Every other state is editorial and is allowed to be.
//
// ── WHAT WE LEARNED, WRITTEN DOWN ────────────────────────────────────────
//
// The research behind these entries (Aug 2026) found one pattern worth stating
// plainly, because it should shape every future decision here: self-serve
// travel APIs cover the US, UK and Europe. For Thailand and SE Asia — where
// Num's traffic actually is — there is Viator, there is Klook, and then there
// is almost nothing. Ground transport is the sharpest case: Grab is the
// dominant operator in Thailand and exposes no third-party ride-booking API at
// all, so that gap is not an integration problem we can solve by trying
// harder. It is a partnership problem or it is a hand-off forever.
//
// Which is why the `note` on a dead entry matters as much as the state.

/** The states, in the order an operator should read them. */
export const STATES = Object.freeze(['live', 'keyless', 'self_serve', 'apply', 'gated', 'dead']);

/** What a rail can actually DO. Collapsing these is how a prompt learns to lie. */
export const POWERS = Object.freeze([
  'book',     // creates a real reservation/order in the supplier's system
  'search',   // returns real availability or inventory we may quote
  'link',     // attributed deep link only — the user completes it there
  'data',     // reference data, no transaction (currency, ATMs, event listings)
]);

const entry = (o) => Object.freeze({ note: '', coverage: '', power: 'link', url: '', ...o });

/**
 * The pipeline.
 *
 * `adapter` names the ADAPTERS key that decides liveness. An entry without one
 * can never be `live` — which is correct for a rail we only ever deep-link to.
 *
 * `next` is the single next action, written so a person can do it without
 * re-reading the research. "Apply" is not an action; "fill the consumer-facing
 * branch of the OpenTable partner form" is.
 */
export const CONNECTORS = Object.freeze([
  // ── ALREADY OURS ───────────────────────────────────────────────────────
  entry({
    id: 'doordash_drive', category: 'courier', vendor: 'DoorDash Drive',
    adapter: 'doordash_drive', state: 'self_serve', power: 'book',
    coverage: 'US, CA, AU, NZ, JP',
    url: "https://developer.doordash.com/portal/integration/drive",
    next: 'Credentials are already set. This one books — it is the only rail that does.',
    note: 'Delivery-as-a-service between two addresses, not food ordering. Covers the errand case.',
  }),
  entry({
    id: 'sabre_air', category: 'flights', vendor: 'Sabre', adapter: 'sabre_air',
    state: 'self_serve', power: 'search', coverage: 'global',
    url: "https://developer.sabre.com/",
    next: 'Connected for shopping. Booking stays off until a registered seller of travel issues.',
    note: 'Quotes and revalidates. Does not issue tickets — see the §17550 note in services.mjs.',
  }),
  entry({
    id: 'sabre_hotel', category: 'stays', vendor: 'Sabre', adapter: 'sabre_hotel',
    state: 'self_serve', power: 'search', coverage: 'global',
    url: "https://developer.sabre.com/",
    next: 'Set SABRE_HOTEL_RATES_PATH — the credentials are already there, the endpoint path is not.',
  }),
  entry({
    id: 'duffel', category: 'flights', vendor: 'Duffel', adapter: 'duffel',
    state: 'self_serve', power: 'search', coverage: 'global',
    url: "https://app.duffel.com/",
    next: 'Token present. Duffel can issue, unlike Sabre — decide whether Num ever wants to be the merchant.',
  }),

  // ── ONE SIGNUP AWAY. THIS IS THE SHORT LIST THAT MATTERS. ──────────────
  entry({
    id: 'viator', category: 'activities', vendor: 'Viator (Tripadvisor)',
    adapter: 'viator', state: 'self_serve', power: 'search',
    coverage: 'global — the best single source for Thailand, UK and US in one API',
    url: "https://partnerresources.viator.com/travel-commerce/affiliate/basic-access/golden-path/",
    next: 'Create a free Viator affiliate account; Basic Access key is issued from the dashboard immediately. Set VIATOR_API_KEY.',
    note: '8% commission, 30-day cookie, no traffic minimum. Basic Access is search + deep link; Full+Booking needs approval and certification later.',
  }),
  entry({
    id: 'airalo', category: 'connectivity', vendor: 'Airalo', adapter: 'airalo',
    state: 'self_serve', power: 'book',
    coverage: '200+ destinations — works identically in Thailand, UK and US',
    url: "https://app.partners.airalo.com/sign-up",
    next: 'Sign up at partners.airalo.com, then confirm whether client_id/secret are issued from the dashboard or need a sales touch.',
    note: 'The only researched rail that is transactional AND geographically uniform. Every traveller needs a SIM; nobody has to be sold one.',
  }),
  entry({
    id: 'frankfurter', category: 'money', vendor: 'Frankfurter', adapter: 'frankfurter',
    state: 'keyless', power: 'data', coverage: 'global, 201 currencies',
    url: "https://frankfurter.dev/",
    next: 'No key exists to get. If this is not wired, that is our backlog and nothing else.',
    note: 'Free for commercial use, no quota, self-hostable. ECB reference rates.',
  }),
  entry({
    id: 'ticketmaster', category: 'events', vendor: 'Ticketmaster Discovery',
    adapter: 'ticketmaster', state: 'self_serve', power: 'data',
    coverage: 'MEASURED 30 Aug 2026 — Edinburgh 327 events, Los Angeles 1,693, Thailand 0. Their docs list TH under Supported Country Codes; that is where tickets COULD be sold, not where they are.',
    url: "https://developer.ticketmaster.com/user/register",
    next: 'Register at developer.ticketmaster.com for an instant key. 5,000 calls/day.',
    note: 'Discovery only. The Partner API that sells tickets is restricted to existing distribution relationships — do not chase it.',
  }),
  entry({
    id: 'skiddle', category: 'events', vendor: 'Skiddle', adapter: 'skiddle',
    state: 'self_serve', power: 'link', coverage: 'UK only',
    url: "https://www.skiddle.com/api/join.php",
    next: 'Free key at skiddle.com/api/join.php, then email dev@skiddle.com for written commercial approval.',
    note: 'Grassroots and club inventory Ticketmaster misses. Affiliate pays from 30% of their booking fee.',
  }),
  entry({
    id: 'gettransfer', category: 'transport', vendor: 'GetTransfer (via Travelpayouts)',
    adapter: 'gettransfer', state: 'self_serve', power: 'book',
    coverage: '180+ countries — Bangkok and Phuket confirmed',
    url: "https://www.travelpayouts.com/en/",
    next: 'Free Travelpayouts signup, then email support@travelpayouts.com for an X-ACCESS-TOKEN. Sandbox is gtrbox.org.',
    note: 'The ONLY ground-transport rail found that a company our size can actually book through. Two limits: minimum 6 hours ahead, and only routes returning a book_now offer are instant — so it never serves "a car now".',
  }),

  // ── SLOW, REAL, AND WORTH STARTING TODAY ───────────────────────────────
  entry({
    id: 'opentable', category: 'dining', vendor: 'OpenTable', state: 'apply', power: 'book',
    coverage: 'Bangkok and Phuket live, plus the strongest UK/US inventory anywhere',
    url: "https://www.opentable.com/restaurant-solutions/api-partners/become-a-partner/",
    next: 'Submit the partner form via the "Consumer-Facing Partner" branch. Needs a live product and a registered entity — 5arz qualifies.',
    note: '6–12 weeks with real rejection risk. The Booking API is stated to work on third-party platforms, which is exactly our shape.',
  }),
  entry({
    id: 'chope', category: 'dining', vendor: 'Chope', state: 'apply', power: 'link',
    coverage: 'Bangkok, Phuket, Singapore, Bali, HK — 13,000 restaurants',
    url: "https://www.chope.co/singapore-restaurants/pages/affiliateprogram",
    next: 'Submit the affiliate Typeform and ask ONE question: does the API create reservations, or only attribute clicks?',
    note: 'Their affiliate page says "widgets, cookies and API" but publishes no docs. That single answer is worth more than any other email in this list — it covers exactly our geography.',
  }),
  entry({
    id: 'gowabi', category: 'wellness', vendor: 'GoWabi', state: 'apply', power: 'link',
    coverage: 'Bangkok, Phuket, Pattaya',
    url: "https://www.gowabi.com",
    next: 'Email them directly. Affiliate programme confirmed via Optimise Media; terms and API status unknown.',
    note: 'Massage is a repeated ask and Thailand has no programmatic wellness rail at any price. This is the highest-value unknown in the whole category.',
  }),
  entry({
    id: 'hungryhub', category: 'dining', vendor: 'Hungry Hub', state: 'apply', power: 'link',
    coverage: 'Thailand — 1,400+ restaurants and hotels',
    url: "https://www.hungryhub.com",
    next: 'Direct BD email. They have closed 11 channel integrations already, so the conversation is routine for them.',
    note: 'Thailand-native supply. The most relevant dining inventory for where Num traffic actually is.',
  }),
  entry({
    id: 'mozrest', category: 'dining', vendor: 'Mozrest', state: 'apply', power: 'book',
    coverage: '200k+ restaurants across 60+ reservation systems — Europe/UK strong, Thailand depth unverified',
    url: "https://mozrest.com/en-gb/solutions-for-booking-channels/",
    next: 'Contact form. They want "an established product with a clear route to market".',
    note: 'One integration replaces six. The right structural answer if dining demand ever broadens past Thailand.',
  }),

  // ── CLOSED TO US TODAY. STATED THRESHOLD, NOT A FEELING. ───────────────
  entry({
    id: 'getyourguide', category: 'activities', vendor: 'GetYourGuide', state: 'gated',
    power: 'search', coverage: 'Europe-heavy',
    url: "https://partner.getyourguide.support/hc/en-us/articles/13981133907613-API-integration-and-requirements",
    next: 'Revisit at 100,000 monthly visits or 50,000 app downloads — their published minimum, not a guess.',
  }),
  entry({
    id: 'tiqets', category: 'activities', vendor: 'Tiqets', state: 'gated', power: 'search',
    coverage: 'Europe strong, weak SE Asia',
    url: "https://www.tiqets.com/en/partner-program/api-program/",
    next: 'Revisit at ~200 orders/month, which is their stated bar for the Booking API.',
    note: 'The distributor API itself is free. Content and availability are available before then.',
  }),
  entry({
    id: 'mindbody', category: 'wellness', vendor: 'Mindbody', state: 'gated', power: 'book',
    coverage: 'US-dominant, thin in Thailand',
    url: "https://developers.mindbodyonline.com/",
    next: 'Revisit when Num holds direct venue relationships — every booking needs that specific studio to enter our activation code.',
    note: 'Per-site activation codes. No aggregate coverage exists, so this never answers "a massage in Bangkok tonight".',
  }),

  // ── VERIFIED DEAD. DO NOT RESEARCH AGAIN. ──────────────────────────────
  entry({
    id: 'grab', category: 'transport', vendor: 'Grab', state: 'dead', power: 'link',
    coverage: 'dominant across SE Asia',
    next: 'Deep link only, forever, until a partnership conversation changes it.',
    note: 'The Rides section of their developer portal offers fare display only. No third-party ride creation exists. This is the single most painful gap in the product and it cannot be closed with code.',
  }),
  entry({
    id: 'uber', category: 'transport', vendor: 'Uber', state: 'dead', power: 'link',
    coverage: 'US, UK, EU — not Thailand',
    next: 'Deep link only.',
    note: 'Guest Rides is Uber for Business Enterprise clients only, by their own docs. And Uber left Thailand in 2018. Either reason alone disqualifies it.',
  }),
  entry({
    id: 'resy', category: 'dining', vendor: 'Resy', state: 'dead', power: 'link',
    next: 'Deep link only.',
    note: 'No self-serve portal, and "consumer booking aggregator" is not one of their four partner categories.',
  }),
  entry({
    id: 'tock', category: 'dining', vendor: 'Tock', state: 'dead', power: 'link',
    next: 'Deep link only.',
    note: 'Their own API FAQ: reservation creation and cancellation must be done through the Tock dashboard. Not a candidate at any timeline.',
  }),
  entry({
    id: 'thefork', category: 'dining', vendor: 'TheFork', state: 'dead', power: 'link',
    coverage: '12 countries, Europe and Australia — no Thailand',
    next: 'Deep link only.',
    note: 'The best-documented booking API in the category, attached to the wrong map and aimed at the supply side.',
  }),
  entry({
    id: 'fresha', category: 'wellness', vendor: 'Fresha', state: 'dead', power: 'link',
    next: 'Deep link only.',
    note: 'No write API of any kind. Read-only BI connector for Power BI and Tableau. Painful, because Fresha has the best real spa density in several of our markets.',
  }),
  entry({
    id: 'eventbrite', category: 'events', vendor: 'Eventbrite', state: 'dead', power: 'data',
    next: 'Do not integrate.',
    note: 'Public event search was shut down in December 2019 and never returned. You can only fetch events you already know about — which cannot answer "what is on in Bangkok this weekend".',
  }),

  // ── GROUND AND SEA IN SE ASIA ──────────────────────────────────────────
  //
  // The ask that drove this: "koh Phangan to don sak with a 4WD, need to be in
  // Bangkok by the 6th". Every aggregator below sells the PASSENGER ferry on
  // that route. None of them was verified to sell a vehicle slot — on Raja and
  // Seatran that is conventionally bought at the pier, and Thai rental
  // agreements commonly forbid taking the car on an inter-island ferry without
  // written permission. Num must never imply it can put a hire 4WD on that
  // boat. The honest decomposition is: passenger ferry + a car picked up on the
  // mainland at Surat Thani + the drive north.
  entry({
    id: 'twelvego', category: 'transport', vendor: '12Go Asia', state: 'self_serve', power: 'link',
    coverage: 'Thailand, Vietnam, Laos, Cambodia, Malaysia, Singapore, Myanmar, Philippines, Indonesia, India',
    url: 'https://agent.12go.asia/',
    next: 'Free instant affiliate signup — no website required. Deep links only; the API is discretionary and undocumented.',
    note: '50% rev-share, ~$3/booking, 30-day cookie. Carries Lomprayah, Raja Ferry and Seatran — i.e. the actual Koh Phangan/Don Sak supply. The single best ground-transport rail for our geography.',
  }),
  entry({
    id: 'directferries', category: 'transport', vendor: 'Direct Ferries', state: 'apply', power: 'link',
    coverage: '4,400 routes, 260+ operators — Donsak/Koh Phangan and Donsak/Koh Samui verified',
    url: 'https://ww2.directferries.com/affiliate/partner_sign_up.aspx?stdc=DF10',
    next: 'Application form, reviewed individually. Ask whether Connect API creates bookings — their material does not say.',
    note: '50% of the commission they receive from the operator.',
  }),
  entry({
    id: 'localrent', category: 'car_rental', vendor: 'Localrent', adapter: 'localrent', state: 'self_serve', power: 'link',
    coverage: '37 countries, 434 city pages — Europe, Caucasus, Gulf, North Africa, Thailand/Malaysia/Vietnam. NO US, NO UK, NO INDONESIA.',
    url: 'https://partner.localrent.com/users/sign_up/?locale=en&role=agent',
    next: 'Self-serve agent registration, instant. That gets the partner id the link rail needs — the API is a separate ask to support@localrent.com.',
    note: 'VERIFIED 30 Aug 2026: their partners page lists "API Integration" as a tool and says NOTHING else about it. There is no public documentation — /en/api/ and /en/affiliate/ both 404, api.localrent.com serves the booking app rather than docs, and no doc path exists under it. So this is a deep-link rail until somebody at Localrent says otherwise, and it is filed as power:link for exactly that reason. 50% rev-share, ~€22 average. Blurbs saying Thailand is excluded are stale — their own Thai landing page is live.',
  }),
  entry({
    id: 'avis', category: 'car_rental', vendor: 'Avis Budget Group', state: 'self_serve', power: 'book',
    coverage: 'Avis, Budget, Payless — Bangkok, Phuket, Samui, Surat Thani, LAX',
    url: 'https://developer.avis.com/getting-started',
    next: 'Self-serve: name + email gets an OAuth2 client ID and secret in under an hour. Sandbox only — production credentials need a conversation with Avis.',
    note: 'car_locations / car_availability / car_reservation, publicly documented. The only car API we can hold in our hands today. Surat Thani matters: it is the mainland side of the Koh Phangan problem.',
  }),
  entry({
    id: 'bikesbooking', category: 'car_rental', vendor: 'BikesBooking', state: 'self_serve', power: 'link',
    coverage: 'Phuket confirmed; global scooter and motorbike',
    url: 'https://bikesbooking.com/en/api-and-affiliate-partner-program/',
    next: 'Self-serve through Travelpayouts (advertiser #57).',
    note: '4% of booking value, 5% above 500/month. The ONLY motorbike aggregator with any partner programme — and scooters are how people actually move around Phuket. Everything else in that category is a WhatsApp business.',
  }),

  // ── AIRPORT ANCILLARIES ────────────────────────────────────────────────
  entry({
    id: 'dragonpass', category: 'airport', vendor: 'DragonPass', state: 'apply', power: 'book',
    coverage: 'Asia-strongest lounge network — Bangkok, Phuket, Chiang Mai',
    url: 'https://developer.dragonpass.com/',
    next: 'Read the public docs first, then one scoped email. Their onboarding is four documented steps ending in sandbox credentials.',
    note: 'Lounge, Fast Track, Dining, Fitness, eSIM and Local Offers through ONE integration, and it creates bookings. The best-documented candidate found anywhere in this research. Plaza Premium is reachable through it rather than directly.',
  }),
  entry({
    id: 'radicalstorage', category: 'airport', vendor: 'Radical Storage', state: 'self_serve', power: 'link',
    coverage: '80+ countries, 800+ cities',
    url: 'https://radicalstorage.com/affiliates',
    next: 'Auto-approved on signup. The lowest-friction rail in the whole registry.',
    note: 'Luggage storage. Small money, but it answers a real gap-day question — "we check out at 11 and fly at 21:00".',
  }),
  entry({
    id: 'bounce', category: 'airport', vendor: 'Bounce', adapter: 'bounce', state: 'self_serve', power: 'link',
    coverage: '4,000+ cities including Asia',
    url: 'https://partner.bounce.com/signup/affiliate',
    next: 'Self-serve signup then approval. One signup also covers Nannybag, which Bounce absorbed.',
    note: '10% commission.',
  }),

  // ── KEYLESS DATA. NO GATEKEEPER, PURE BACKLOG. ─────────────────────────
  entry({
    id: 'openmeteo', category: 'data', vendor: 'Open-Meteo', state: 'apply', power: 'data',
    coverage: 'global',
    url: 'https://open-meteo.com/en/pricing',
    next: 'Buy a paid tier before shipping. Do NOT use the free tier.',
    note: 'TRAP, and an easy one to walk into: their terms say the free API is for NON-COMMERCIAL use only. Num is a paid product. Marked apply rather than keyless deliberately — the key here is a card, not an approval.',
  }),
  entry({
    id: 'nagerdate', category: 'data', vendor: 'Nager.Date', state: 'keyless', power: 'data',
    coverage: '200+ countries',
    url: 'https://nagerholidays.com/api/v3/AvailableCountries',
    next: 'No key, works today — but check AvailableCountries before relying on it anywhere.',
    note: 'VERIFIED 30 Aug 2026: /PublicHolidays/2026/TH returns 204 No Content. Thailand is NOT covered, and Thailand is our main market. GB and US return real data. So this is a UK/US rail only, and Thai public holidays — which close kitchens and move ferry timetables — still need another source.',
  }),
  entry({
    id: 'ourairports', category: 'data', vendor: 'OurAirports', state: 'keyless', power: 'data',
    coverage: 'every airport on earth, IATA and ICAO',
    url: 'https://davidmegginson.github.io/ourairports-data/airports.csv',
    next: 'A 12.7MB static CSV in the public domain. Vendor it; there is nothing to sign up for.',
    note: 'Use this rather than OpenFlights, which has been stale since roughly 2017.',
  }),
  entry({
    id: 'foursquare_os', category: 'data', vendor: 'Foursquare OS Places', state: 'keyless', power: 'data',
    coverage: '100M+ POIs worldwide',
    url: 'https://huggingface.co/datasets/foursquare/fsq-os-places',
    next: 'Apache 2.0 — commercial use and redistribution both permitted. Download it.',
    note: 'The escape hatch from Google Places, whose terms restrict caching to ~30 days and forbid display alongside non-Google maps. We hold 2.5M places already; this is how that number grows without a licence problem.',
  }),
  entry({
    id: 'aerodatabox', category: 'data', vendor: 'AeroDataBox', state: 'self_serve', power: 'data',
    coverage: 'global flight status',
    url: 'https://rapid.aerodatabox.com/',
    next: 'Pro is $5/month for 6,000 units. Skip the free tier — it prohibits commercial use.',
    note: 'Twenty times cheaper than FlightAware AeroAPI, whose commercial floor is $100/month. OpenSky is legally closed to us: their terms require a written licence for ANY for-profit entity, regardless of purpose.',
  }),
  entry({
    id: 'geoapify', category: 'data', vendor: 'Geoapify', adapter: 'geoapify', state: 'self_serve', power: 'data',
    coverage: 'global geocoding',
    url: 'https://myprojects.geoapify.com',
    next: 'Instant key, 3,000 credits/day free, commercial use permitted with an attribution link.',
    note: 'Wired to the submissions queue (worker/geocode.mjs), which migration 0007 was written for and nobody built — every self-submitted business had sat at status=new with null coordinates, and places.lat is NOT NULL, so none could ever be promoted. Also the reason we do not use the public Nominatim instance: OSM policy says an app whose primary function is geocoding must run its own service, and bans autocomplete outright.',
  }),

  // ── AGENTIC COMMERCE. WHERE THE INDUSTRY IS GOING, AND WHAT IT COST. ───
  //
  // Two findings from Aug 2026 that should shape everything here.
  //
  // First: OpenAI shut down Instant Checkout in March 2026, about six months
  // after launching it, and moved back to "discover in ChatGPT, then send the
  // buyer to the merchant's own checkout" — with no fee. The flagship
  // agent-completes-the-purchase product retreated to referral within two
  // quarters. Num's hand-off model, which we adopted for legal reasons, turns
  // out to be where the industry landed anyway.
  //
  // Second, and this one is a hard constraint: on 10 March 2026 Amazon won a
  // preliminary injunction against Perplexity, blocking Comet from logging
  // into Amazon accounts to buy on a user's behalf. The court's reasoning is
  // the part that binds us — Comet acted "with the Amazon user's permission,
  // but without authorization by Amazon", likely violating the CFAA. So Num
  // must never book by driving a logged-in session on a site we have no
  // agreement with, however clearly the user consented. Partnership or
  // published protocol. Never browser automation.
  entry({
    id: 'ucp_lodging', category: 'agentic', vendor: 'Universal Commerce Protocol', state: 'apply', power: 'book',
    coverage: 'lodging vertical: Amadeus, Booking.com, Expedia, Hilton, Marriott',
    url: 'https://developers.google.com/hotels/ucp',
    next: 'Join the lodging waitlist. This is the highest-leverage single action in the registry.',
    note: 'Apache 2.0, co-developed by Google, Shopify, Amazon, Walmart, Microsoft and Stripe, and it speaks MCP natively. Every major hotel supply source is a co-author. If stays ever become real for Num, this is the door.',
  }),
  entry({
    id: 'mcp_registry', category: 'agentic', vendor: 'Official MCP Registry', state: 'self_serve', power: 'data',
    coverage: 'global agent discovery',
    url: 'https://github.com/modelcontextprotocol/registry',
    next: 'Publish /api/partner/mcp with the mcp-publisher CLI. DNS TXT auth lets us claim a thatislumi.com namespace rather than io.github.*.',
    note: 'Free, open, no restrictions. We already run an MCP server and nothing can find it. Still pre-GA — expect breaking changes.',
  }),
  entry({
    id: 'stripe_machine', category: 'agentic', vendor: 'Stripe Machine Payments', state: 'self_serve', power: 'book',
    coverage: 'GB, US, EU and 30+ countries on request',
    url: 'https://docs.stripe.com/payments/machine.md',
    next: 'GA and self-serve. This is how OTHER agents pay US for what /api/partner/mcp returns.',
    note: 'Minimum $0.50 by card, $0.01 in USDC. The inverse of every other entry in this registry: not a rail we consume, a rail that bills for us.',
  }),
  entry({
    id: 'anthropic_directory', category: 'agentic', vendor: 'Anthropic MCP Directory', state: 'apply', power: 'data',
    coverage: 'Claude users',
    url: 'https://claude.com/docs/connectors/building/submission',
    next: 'Needs a Team or Enterprise org to submit at all — individual plans have no submission surface. Then: OAuth 2.0, a privacy policy at an HTTPS URL, and title + readOnlyHint/destructiveHint on every tool.',
    note: 'A missing privacy policy is an immediate rejection. The URL slug is permanent.',
  }),
]);

const BY_ID = Object.freeze(Object.fromEntries(CONNECTORS.map((c) => [c.id, c])));

/**
 * The state of one connector, with `live` derived rather than declared.
 *
 * `adapters` is injected rather than imported so this module stays testable
 * without standing up the whole service layer, and so a caller cannot
 * accidentally report liveness from a stale copy of the registry.
 */
export function stateOf(connector, env = {}, adapters = {}) {
  const a = connector.adapter ? adapters[connector.adapter] : null;
  if (a?.ready?.(env)) return 'live';
  return connector.state;
}

/** Everything, resolved. Sorted by how soon a person could plausibly act on it. */
export function pipeline(env = {}, adapters = {}) {
  const rank = Object.fromEntries(STATES.map((s, i) => [s, i]));
  return CONNECTORS
    .map((c) => ({ ...c, state: stateOf(c, env, adapters) }))
    .sort((x, y) => rank[x.state] - rank[y.state] || x.category.localeCompare(y.category) || x.id.localeCompare(y.id));
}

/**
 * The operator's answer: what is one action away from being real.
 *
 * Deliberately excludes `keyless` — a keyless rail has no external action, so
 * putting it on a list of things to go and do is noise. It shows up as work in
 * the backlog instead, which is where it belongs.
 */
export const actionable = (env = {}, adapters = {}) =>
  pipeline(env, adapters).filter((c) => c.state === 'self_serve' || c.state === 'apply');

/** Categories where nothing can currently transact. The honest gap list. */
export function gaps(env = {}, adapters = {}) {
  const byCat = new Map();
  for (const c of pipeline(env, adapters)) {
    const cur = byCat.get(c.category) || { category: c.category, canBook: false, canSearch: false, rails: [] };
    if (c.state === 'live' || c.state === 'keyless') {
      if (c.power === 'book') cur.canBook = true;
      if (c.power === 'search' || c.power === 'data') cur.canSearch = true;
      cur.rails.push(c.id);
    }
    byCat.set(c.category, cur);
  }
  return [...byCat.values()].filter((c) => !c.canBook).sort((a, b) => a.category.localeCompare(b.category));
}

export const connector = (id) => BY_ID[id] || null;
