// Every guest-facing feature, what it needs, whether it is on, and how to
// turn it on or off without a deploy.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
//
// connectors.mjs answers "which vendor rails do we have, and where is each
// one stuck" — the supply side. services.mjs answers "can we complete this
// request right now" — the runtime. Neither answers the question that costs
// the most time in practice:
//
//   "Flight Watch — is it on? What does it need? How do I switch it off at
//    two in the morning without shipping code, and what do I check first?"
//
// That answer lived in three chat threads and one person's memory. Here it
// is next to the code, as data, so a feature is a thing you can read, turn
// on, verify and turn off rather than a thing you have to go and find.
//
// ── THE THREE RULES ──────────────────────────────────────────────────────
//
// 1. `ready` IS DERIVED, NEVER DECLARED. It reads the same env the feature's
//    code reads. A feature cannot claim to be live in the console while the
//    worker believes its key is missing, because both read this predicate.
//
// 2. EVERY FEATURE HAS AN OFF SWITCH, and it is an env var, because the
//    moment you need one is the moment you least want to be running a build.
//    `NUM_OFF` takes a comma-separated list of ids: `NUM_OFF=tonight,runner`.
//
// 3. THE SOP IS PART OF THE DECLARATION. A runbook in a document is a
//    runbook nobody opens. Three lines: how to turn it on, how to check it
//    is working, what breaking looks like. If it cannot be said in three
//    lines the feature is not understood well enough to be on.
//
// GET /api/features returns all of this, live. That endpoint is the console.

/** Comma-separated kill list: NUM_OFF=tonight,ratings */
export const isOff = (env, id) =>
  String(env?.NUM_OFF ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(id);

const has = (env, ...keys) => keys.every((k) => !!env?.[k]);

/**
 * @typedef {object} Feature
 * @property {string} id           stable, used by NUM_OFF and the console
 * @property {string} name         what a person calls it
 * @property {string} does         one line, guest's point of view
 * @property {string[]} needs      env keys, for the "what is missing" answer
 * @property {(env:object)=>boolean} ready  derived from env, never declared
 * @property {string} surface      where a guest meets it
 * @property {string[]} code       the files, so the next person starts in the right one
 * @property {{on:string, check:string, broken:string}} sop
 * @property {'free'|'plus'|'pro'} plan  the CHEAPEST plan that includes it
 * @property {string|null} entitlement   the key in membership.mjs a caller passes
 *                                       to may(), or null when nothing meters it
 * @property {boolean} [ungated]   travel — free on every plan, by law, for ever
 */

// ── WHAT `plan` MEANS, AND THE TWO RULES IT CANNOT BREAK ──────────────────
//
// `plan` is the cheapest plan a guest can be on and still meet this feature.
// It is documentation of a decision, not the enforcement of one: the gate
// itself lives in worker/membership.mjs, and a caller asks `may(env, member,
// <entitlement>)`. A feature with `entitlement: null` is not metered by
// anything — and on 18 Sep 2026 that was EVERY feature, because `may()` had
// no callers anywhere in the product. Declaring the plan here is step one of
// fixing that; step two is the call site.
//
// Rule 1 — GATE THE CEILING, NEVER THE CORE (membership.mjs's own rule).
//   A free guest is never told "Num can't help with that". They are told
//   "that's your third plan this month, here's when it resets".
//
// Rule 2 — TRAVEL IS UNGATEABLE. This is law, not taste: gating it makes the
//   paid tiers a "seller of travel discount program" under California B&P
//   §17550.27, which Num cannot comply with at any price. Anything that shops,
//   books or advises on travel carries `ungated: true` and `plan: 'free'`, and
//   a test below refuses any other combination.
const UNGATEABLE_PLAN = 'free';

/** @type {readonly Feature[]} */
export const FEATURES = Object.freeze([
  {
    id: 'concierge',
    plan: 'free',
    entitlement: 'concierge',
    name: 'The concierge',
    does: 'Answers anything, in any language, with three real places and the one NUM would pick.',
    needs: ['ANTHROPIC_API_KEY'],
    ready: (env) => has(env, 'ANTHROPIC_API_KEY') || has(env, 'NUM_OPENAI_KEY') || has(env, 'NUM_LLM_KEY'),
    surface: 'thread',
    code: ['worker/index.mjs', 'worker/brains.mjs', 'worker/director.mjs'],
    sop: {
      on: 'Always on. At least one of ANTHROPIC_API_KEY / NUM_OPENAI_KEY / NUM_LLM_KEY must be set.',
      check: 'POST /api/num with x-num-debug: 1 — the reply carries _timing {brain, model, lane}.',
      broken: 'Every brain cooling (GET /api/health → brains_state). Answers keep coming from whoever is left; cards and bookings stop.',
    },
  },
  {
    id: 'tonight',
    plan: 'free',
    entitlement: null,
    name: 'Tonight',
    does: 'Events, restaurants and bars near you on the TODAY tab, before you ask.',
    needs: ['TICKETMASTER_API_KEY'],
    ready: (env) => has(env, 'TICKETMASTER_API_KEY'),
    surface: 'dash rail',
    code: ['worker/discover.mjs', 'worker/events.tm.mjs', 'src/components/app/TonightStrip.tsx', 'src/components/app/NearbyRail.tsx'],
    sop: {
      on: 'Set TICKETMASTER_API_KEY. The restaurant and bar rails need no key — they read NUM\'s own directory.',
      check: 'GET /api/discover?mode=tonight&place=london&day=YYYY-MM-DD — expect items[], restaurants[], bars[].',
      broken: 'Empty items[] outside GB/US is normal (no Ticketmaster inventory); empty restaurants[] is not — check the directory for that destination.',
    },
  },
  {
    id: 'ratings',
    plan: 'free',
    entitlement: null,
    name: 'Real ratings',
    does: 'The first ask about a neighbourhood fetches real ratings for it, so the picks are ranked by something true.',
    needs: ['SERPAPI_KEY'],
    ready: (env) => has(env, 'SERPAPI_KEY'),
    surface: 'invisible — it ranks everything else',
    code: ['worker/placeratings.mjs', 'ai/places.js'],
    sop: {
      on: 'Set SERPAPI_KEY. One search per ~1 km cell per category per 30 days; the cost is bounded by geography, not by traffic.',
      check: 'SELECT cell, cat, datetime(ts/1000,\'unixepoch\') FROM num_rating_runs ORDER BY ts DESC LIMIT 5. The DATE is the check, not the counts: no row since yesterday means this is not running, whatever `state` says above. matched should also be more than half of found.',
      broken: 'THIS FEATURE READS "on" WHENEVER SERPAPI_KEY IS SET, INCLUDING WHEN EVERY SEARCH IS REFUSED — it was 429ing for nine hours on 18 Sep while this line said on. A refusal (429 spent plan, 401/403 bad key) now records a low-severity `ratings_refused` chore carrying the remedy: GET /api/admin/failures, or the chores count on /api/health. matched near zero is different and harmless — it means the directory has no rows where people are asking. Off entirely = the old ranking; picks get duller, nothing errors.',
    },
  },
  {
    id: 'flightwatch',
    plan: 'free',
    entitlement: null,
    ungated: true,
    name: 'Flight Watch',
    does: 'Watches a flight and pings once when the gate, the time or the plan changes.',
    needs: ['AERODATABOX_KEY'],
    ready: (env) => has(env, 'AERODATABOX_KEY'),
    surface: 'thread card + TODAY + Plan',
    code: ['worker/flightwatch.mjs', 'src/lib/flightwatch.ts', 'src/components/app/FlightCard.tsx'],
    sop: {
      on: 'Set AERODATABOX_KEY (RapidAPI). The 5-minute cron sweeps watches; no other wiring.',
      check: 'POST /api/flightwatch {me, flight_no, date} — the reply carries the airline\'s own times.',
      broken: 'Watches stop updating. Nothing tells the guest a stale time is stale, so switch it OFF rather than leave it half-working: NUM_OFF=flightwatch.',
    },
  },
  {
    id: 'i18n',
    plan: 'free',
    entitlement: null,
    name: 'The app in nine languages',
    does: 'The whole interface in the reader\'s language, machine-translated once and stored where a person can correct it.',
    needs: ['ANTHROPIC_API_KEY'],
    ready: (env) => has(env, 'ANTHROPIC_API_KEY') || has(env, 'AI'),
    surface: 'everywhere',
    code: ['worker/i18n.mjs', 'src/lib/i18n.ts', 'src/i18n/catalog.ts'],
    sop: {
      on: 'Always on. English is never translated and costs nothing.',
      check: 'POST /api/i18n {lang:"th", strings:["Nothing booked yet"]} — expect a Thai map back.',
      broken: 'Every string falls back to English, which is a worse app and a working one. A bad line is fixed in num_translations (status=approved), not in code.',
    },
  },
  {
    id: 'runner',
    plan: 'free',
    entitlement: 'errands',
    name: 'Runner',
    does: 'Moves something from A to B — the charger left at the hotel, flowers to the table.',
    needs: ['DOORDASH_KEY', 'UBER_DIRECT_CLIENT_ID'],
    ready: (env) => has(env, 'DOORDASH_KEY') || has(env, 'UBER_DIRECT_CLIENT_ID') || has(env, 'LALAMOVE_KEY'),
    surface: 'thread + business console',
    code: ['worker/courier.mjs', 'worker/doordash.mjs', 'worker/delivery.mjs'],
    sop: {
      on: 'Any one courier rail: DOORDASH_KEY (US/CA/AU/NZ/JP), UBER_DIRECT_* (UK/EU, pending approval), LALAMOVE_KEY (SEA).',
      check: 'A quote, not an order: the quote path never creates a delivery.',
      broken: 'No rail where the guest is → NUM says so and offers a NUM runner. It never pretends. Fees pass through at cost; a wrong fee is a dispute, so check the quote before the order.',
    },
  },
  {
    id: 'push',
    plan: 'free',
    entitlement: null,
    name: 'Push',
    does: 'The one ping that matters — a delay, a gate, a table confirmed.',
    needs: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'],
    ready: (env) => has(env, 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'),
    surface: 'lock screen',
    code: ['worker/push.mjs', 'src/lib/push.ts'],
    sop: {
      on: 'Set the VAPID pair. The app asks for permission after the first thing worth being told about, never on launch.',
      check: 'SELECT COUNT(*) FROM num_push_subs — and send yourself one.',
      broken: 'Silence. Nothing in the app says a push failed, so treat a flat subscription count as an outage, not as quiet.',
    },
  },
  {
    id: 'discover',
    plan: 'free',
    entitlement: null,
    name: 'Search & Suggest',
    does: 'One box in any language, and a "surprise me" deck that never repeats what you have done.',
    needs: [],
    ready: () => true,
    surface: 'thread sheet',
    code: ['worker/discover.mjs', 'src/components/app/DiscoverSheet.tsx'],
    sop: {
      on: 'Always on; it reads the directory. VIATOR_KEY adds bookable experiences, TICKETMASTER_API_KEY adds events.',
      check: 'GET /api/discover?mode=surprise&place=phuket&debug=1 — debug says why any rail came back empty.',
      broken: 'An empty rail is honest (nothing there); an empty ANSWER is not. Check ?debug=1 first.',
    },
  },

  // ── TRAVEL ────────────────────────────────────────────────────────────
  // Every feature below carries `ungated: true`. See Rule 2 at the top.
  {
    id: 'flights',
    plan: 'free',
    entitlement: 'flight_search',
    ungated: true,
    name: 'Flight search',
    does: 'Live fares from two independent sources, so a price is not one vendor\'s opinion.',
    needs: ['SABRE_CLIENT_ID', 'SABRE_CLIENT_SECRET', 'DUFFEL_ACCESS_TOKEN'],
    ready: (env) => has(env, 'SABRE_CLIENT_ID', 'SABRE_CLIENT_SECRET') || has(env, 'DUFFEL_ACCESS_TOKEN'),
    surface: 'thread card',
    code: ['worker/sabre.mjs', 'worker/duffel.mjs', 'worker/fares.mjs', 'worker/flighthandoff.mjs'],
    sop: {
      on: 'Either rail alone works. Both set = two quotes and a comparison.',
      check: 'GET /api/works-with — sabre_air and duffel should both read Live.',
      broken: 'SEARCH ONLY: no ticket is ever issued, on either rail. If a guest is told a seat is held, that is a bug and a liability — DUFFEL_BOOKING_LIVE and SABRE_BOOKING_LIVE stay unset until someone decides otherwise in writing.',
    },
  },
  {
    id: 'travel_docs',
    plan: 'free',
    entitlement: null,
    ungated: true,
    name: 'Entry rules',
    does: 'What this passport needs to enter that country — visa, onward ticket, passport validity.',
    needs: [],
    ready: () => true,
    surface: 'thread + TravelSheet',
    code: ['worker/traveldocs.mjs', 'worker/passportcheck.mjs', 'src/components/app/TravelSheet.tsx'],
    sop: {
      on: 'Always on; the ruleset ships with the worker.',
      check: 'GET /api/travel/docs?from=GB&to=TH — expect a rule, a source and a date.',
      broken: 'An out-of-date rule is worse than no rule: a guest turned away at a border is the failure mode. Every answer carries the date it was last checked, and NUM says "check with the embassy" rather than guessing.',
    },
  },
  {
    id: 'travel_health',
    plan: 'free',
    entitlement: null,
    ungated: true,
    name: 'Vaccinations',
    does: 'Which jabs are required and which are advised, for where they are going.',
    needs: [],
    ready: () => true,
    surface: 'thread + TravelSheet',
    code: ['worker/vaccines.mjs'],
    sop: {
      on: 'Always on. The ruleset ships with the worker; no key, no vendor.',
      check: 'GET /api/travel/vaccines?to=TH',
      broken: 'NUM is not a doctor and the copy says so. Required vs advised must never blur — one is a border, the other is advice.',
    },
  },
  {
    id: 'travel_insurance',
    plan: 'free',
    entitlement: null,
    ungated: true,
    name: 'Travel insurance',
    does: 'What cover this trip actually needs, and where to get it.',
    needs: [],
    ready: () => true,
    surface: 'thread + TravelSheet',
    code: ['worker/insurancereq.mjs'],
    sop: {
      on: 'Always on. No key: this reads requirements, it does not shop policies.',
      check: 'GET /api/travel/insurance?to=TH&days=14',
      broken: 'Insurance is a regulated product in most places. NUM explains and links; it does not sell, quote or advise on a policy.',
    },
  },
  {
    id: 'travel_pack',
    plan: 'free',
    entitlement: null,
    ungated: true,
    name: 'Packing list',
    does: 'What to take, built from the destination, the season and the length of the trip.',
    needs: [],
    ready: () => true,
    surface: 'thread + TravelSheet',
    code: ['worker/travelpack.mjs'],
    sop: {
      on: 'Always on. Reads the destination, the month and the trip length; no key.',
      check: 'GET /api/travel/pack?to=TH&days=7&month=11',
      broken: 'A generic list. Harmless, and the cheapest thing on this page to make delightful.',
    },
  },
  {
    id: 'travel_holidays',
    plan: 'free',
    entitlement: null,
    ungated: true,
    name: 'Public holidays',
    does: 'What is shut, and when — the reason the restaurant NUM picked is dark tonight.',
    needs: [],
    ready: () => true,
    surface: 'thread, and behind every opening-hours answer',
    code: ['worker/holidays.mjs', 'worker/hours.mjs'],
    sop: {
      on: 'Always on. The calendar ships with the worker and every hours answer reads it.',
      check: 'GET /api/travel/holidays?country=TH&year=2026',
      broken: 'Openings read as normal on a holiday. Worth switching off rather than being wrong: an "open now" that is shut is the one mistake a concierge does not get to make twice.',
    },
  },
  {
    id: 'emergency',
    plan: 'free',
    entitlement: null,
    ungated: true,
    name: 'Emergency numbers',
    does: 'Police, ambulance and the nearest hospital, for the country they are standing in.',
    needs: [],
    ready: () => true,
    surface: 'thread, and one tap from Profile',
    code: ['worker/emergency.mjs'],
    sop: {
      on: 'Always on, in every language, signed in or not.',
      check: 'Ask the concierge "emergency number" from a Thai IP.',
      broken: 'NEVER switch this off. A wrong emergency number is the worst single output this product can produce — if the data is in doubt, NUM gives the international 112 and says to confirm locally.',
    },
  },
  {
    id: 'bookings',
    plan: 'free',
    entitlement: 'concierge_booking',
    ungated: true,
    name: 'Bookings',
    does: 'NUM texts the venue, the venue answers, and the guest is told yes or no — no app on the venue\'s side.',
    // TWILIO_SID / TWILIO_TOKEN are the names actually set on num-app; the
    // longer spellings are accepted because both appear in this codebase and
    // a registry that reports a working feature as broken is the exact lie
    // this file exists to prevent.
    needs: ['TWILIO_SID', 'TWILIO_TOKEN'],
    ready: (env) => has(env, 'TWILIO_SID', 'TWILIO_TOKEN')
      || has(env, 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN')
      || has(env, 'RESEND_API_KEY'),
    surface: 'thread card + BookSheet',
    code: ['worker/booking.mjs', 'worker/bookdesk.mjs', 'src/components/app/BookSheet.tsx'],
    sop: {
      on: 'A channel that reaches venues: Twilio SMS, or Resend where the venue is on email.',
      check: 'POST /api/concierge/mcp request_table, then booking_status — only `confirmed` means a table.',
      broken: 'Requests go out and nothing comes back, so a guest sits in "requested" for ever. The status wording never says "booked" until the venue has said so — that distinction is the whole feature.',
    },
  },
  {
    id: 'activities',
    plan: 'free',
    entitlement: null,
    ungated: true,
    name: 'Tours & experiences',
    does: 'Bookable things to do, with the operator\'s own price and rating.',
    needs: ['VIATOR_API_KEY'],
    ready: (env) => has(env, 'VIATOR_API_KEY'),
    surface: 'thread + Suggest deck',
    code: ['worker/viator.mjs', 'worker/discover.mjs'],
    sop: {
      on: 'Set VIATOR_API_KEY. The destination list caches in D1 for a week.',
      check: 'GET /api/discover?place=phuket&q=cooking+class — expect Viator rows beside NUM\'s own.',
      broken: 'Silently empty, which is how this rail spent months dead before 17 Sep 2026: a 404 taxonomy path and a misspelled sort enum returned zero rather than erroring. Check ?debug=1, never the absence of rows.',
    },
  },
  {
    id: 'tickets',
    plan: 'free',
    entitlement: null,
    ungated: true,
    name: 'Event tickets',
    does: 'What is on while they are there, with a link that sells the ticket.',
    needs: ['TICKETMASTER_API_KEY'],
    ready: (env) => has(env, 'TICKETMASTER_API_KEY'),
    surface: 'thread + TODAY rail',
    code: ['worker/events.tm.mjs', 'worker/eventsearch.mjs'],
    sop: {
      on: 'Set TICKETMASTER_API_KEY (the Discovery API key — the Partner API that sells tickets is a separate, invite-only relationship NUM does not have).',
      check: 'GET /api/discover?place=edinburgh&mode=tonight',
      broken: 'NUM links out to Ticketmaster for the purchase and never implies it sold the ticket. Outside GB/US inventory is genuinely thin — an empty list there is honest, not broken.',
    },
  },
  {
    id: 'luggage',
    plan: 'free',
    entitlement: null,
    ungated: true,
    name: 'Luggage storage',
    does: 'Somewhere to leave the bags between checkout and the flight.',
    needs: ['BOUNCE_REF'],
    ready: (env) => has(env, 'BOUNCE_REF'),
    surface: 'thread, offered when a checkout time and a late flight are both known',
    code: ['worker/luggage.mjs'],
    sop: {
      on: 'Set BOUNCE_REF (affiliate reference).',
      check: 'Ask the concierge "where can I leave my bags in Patong".',
      broken: 'The rail goes quiet and NUM says it cannot find storage there. This is the single most under-used feature NUM has: almost nobody knows to ask for it, so it belongs in the starter chips, not behind a question.',
    },
  },
  {
    id: 'cars',
    plan: 'free',
    entitlement: null,
    ungated: true,
    name: 'Car hire',
    does: 'Cars from local firms rather than the airport desks.',
    needs: ['LOCALRENT_MARKER'],
    ready: (env) => has(env, 'LOCALRENT_MARKER'),
    surface: 'thread card',
    code: ['worker/localrent.mjs'],
    sop: {
      on: 'Set LOCALRENT_MARKER — an affiliate marker, not a key. Not connected as of 18 Sep 2026.',
      check: 'GET /api/works-with — localrent should read Live.',
      broken: 'Until the marker is set NUM answers car questions from the directory and the concierge, with no bookable link. That is an honest half-answer, which is why this ships as needs_setup rather than off.',
    },
  },
  {
    id: 'stays',
    plan: 'free',
    entitlement: null,
    ungated: true,
    name: 'Stays',
    does: 'Live room rates NUM can actually book, not a link out to somebody else.',
    // Moved off Sabre on 19 Sep 2026. Sabre SHOPS hotels and cannot take one —
    // its own header says so, and sabre-booking.mjs maps only flight
    // operations, so there has never been a hotel booking path behind it.
    // LiteAPI is the one supply route a company this size can hold today that
    // both prices and books.
    needs: ['LITEAPI_KEY'],
    ready: (env) => has(env, 'LITEAPI_KEY'),
    surface: 'STAYS page + thread card',
    code: ['worker/liteapi.mjs', 'worker/staykind.mjs', 'worker/booking.mjs'],
    sop: {
      on: 'Set LITEAPI_KEY (sand_ to rehearse, prod_ to sell). Shopping starts there. BOOKING is a separate switch — LITEAPI_BOOKING_ENABLED=true — and a production key needs LITEAPI_BOOKING_LIVE=true on top of it. Two switches, because the failure mode of one is a real charge against what you thought was a sandbox.',
      check: 'GET /api/stays/status — it reports the estate read off the key prefix, both margins, and which switch is holding booking shut.',
      broken: 'Without the key NUM still recommends hotels from its own directory and deep-links the ones whose own booking engine it knows, and it quotes nothing. Saying "from $X" without a live rate would be inventing a price, so it does not.',
    },
  },
  {
    id: 'stays_member_rate',
    plan: 'free',
    entitlement: null,
    ungated: true,
    name: 'Member room rate',
    does: 'A signed-in member is priced below the public rate on the same room.',
    // This is a supplier CONTRACT TERM expressed as a feature: below-public
    // pricing is only lawful inside a closed user group, and NUM's app is one
    // because it requires an account. Signed out, worker/liteapi.mjs floors
    // every rate up to the public price rather than hiding it.
    needs: ['LITEAPI_KEY', 'LITEAPI_MARGIN_PUBLIC', 'LITEAPI_MARGIN_MEMBER'],
    ready: (env) => has(env, 'LITEAPI_KEY', 'LITEAPI_MARGIN_PUBLIC', 'LITEAPI_MARGIN_MEMBER'),
    surface: 'STAYS page, signed in only',
    code: ['worker/liteapi.mjs'],
    sop: {
      on: 'Set both margins as percentages. LITEAPI_MARGIN_MEMBER below LITEAPI_MARGIN_PUBLIC is the whole mechanic; equal is legal and pointless.',
      check: 'Search signed out and signed in on the same room. Signed out must read the public price.',
      broken: 'With one margin set, members and strangers see the same number and the membership has nothing in it. With neither set, NUM sells at net — it earns nothing and it is not breaking anything.',
    },
  },

  // ── THE PEOPLE YOU TRAVEL WITH ────────────────────────────────────────
  // This is where the money is, and it is the only place it can be: these
  // are not travel benefits under §17550.27, so a ceiling here is lawful.
  {
    id: 'plans',
    plan: 'free',
    entitlement: 'plans_max',
    name: 'Plans with friends',
    does: 'A shared plan everyone can see and vote on, with no app on their side.',
    needs: [],
    ready: () => true,
    surface: 'PLAN tab',
    code: ['worker/social.mjs', 'worker/planprice.mjs', 'src/components/app/PlanView.tsx'],
    sop: {
      on: 'Always on. `plans_max` meters how many run at once: 3 free, 25 on Plus, unlimited on Pro.',
      check: 'GET /api/social/plans?me=<id>',
      broken: 'The ceiling counts plans IN FLIGHT — owned, not finished, date not yet passed — so it releases itself and a free member can never be walled out permanently. If that count ever becomes a plain COUNT(*), three plans becomes a life sentence, because there is no archive button in the app.',
    },
  },
  {
    id: 'friends',
    plan: 'free',
    entitlement: 'friends_max',
    name: 'Friends',
    does: 'Add the people you are travelling with by a link or a text — they need no account to answer.',
    needs: [],
    ready: () => true,
    surface: 'PLAN tab + InviteSheet',
    code: ['worker/social.mjs', 'worker/friendtext.mjs', 'src/components/app/InviteSheet.tsx'],
    sop: {
      on: 'Always on. Unlimited on every plan — a social product that meters friends kills its own growth.',
      check: 'POST /api/social/invite, then open the link in a private window.',
      broken: 'Invite links stop connecting people, which silently ends every referral loop NUM has.',
    },
  },
  {
    id: 'messages',
    plan: 'free',
    entitlement: null,
    name: 'Messages',
    does: 'Member to member, in the same thread as the plan they are arguing about.',
    needs: [],
    ready: () => true,
    surface: 'DmSheet',
    code: ['worker/dm.mjs', 'src/components/app/DmSheet.tsx'],
    sop: {
      on: 'Always on. Delivery rides on push where a member has it, email where they do not.',
      check: 'POST /api/dm/send, then GET /api/dm/thread.',
      broken: 'Messages queue and never arrive. Worse than off, because the sender believes it landed.',
    },
  },
  {
    id: 'events',
    plan: 'free',
    entitlement: null,
    name: 'Host an event',
    does: 'Invite a group and collect RSVPs from one text — no app on the guests\' side.',
    needs: [],
    ready: () => true,
    surface: 'EventSheet + TODAY',
    code: ['worker/events.mjs', 'worker/availability.mjs', 'src/components/app/EventSheet.tsx'],
    sop: {
      on: 'Always on; SMS or email carries the invite where a guest has no app.',
      check: 'Create an event, open the guest link in a private window, RSVP.',
      broken: 'RSVPs are recorded but never reach the host. The host plans for the wrong number of people, which is the failure a guest never forgives.',
    },
  },
  {
    id: 'tabs',
    plan: 'free',
    entitlement: 'tabs',
    name: 'Shared tabs',
    does: 'One bill, several people, settled without anyone doing arithmetic at the table.',
    needs: [],
    ready: () => true,
    surface: 'TabSheet + WALLET',
    code: ['worker/social.mjs', 'worker/balances.mjs', 'src/components/app/TabSheet.tsx'],
    sop: {
      on: 'Always on. Settling in cash needs nothing; settling in Stars needs the wallet.',
      check: 'Open a tab, add two members, settle it, then check num_memberships and the balances agree.',
      broken: 'A tab that will not settle leaves people owing each other money inside an app they did not choose. Switch it off rather than run it half-working.',
    },
  },

  // ── MONEY ─────────────────────────────────────────────────────────────
  {
    id: 'wallet',
    plan: 'free',
    entitlement: null,
    name: 'Stars & wallet',
    does: 'A balance that settles bills at the table, pays a runner, or buys a month of Plus.',
    needs: ['STRIPE_SECRET_KEY'],
    ready: (env) => has(env, 'STRIPE_SECRET_KEY'),
    surface: 'WALLET',
    code: ['worker/balances.mjs', 'worker/cashout.mjs', 'worker/starmembership.mjs', 'src/components/app/WalletSheet.tsx'],
    sop: {
      on: 'Set STRIPE_SECRET_KEY. Packs are pegged 1:1 to USD, so a Star is a dollar.',
      check: 'GET /api/balances?me=<id>; buying a pack should move the balance and leave a row in the ledger.',
      broken: 'Two rules hold whatever else breaks: the ★5 welcome grant can never buy a membership (origin-checked in starmembership.mjs), and paying in Stars is never cheaper than paying cash.',
    },
  },
  {
    id: 'payments',
    plan: 'free',
    entitlement: null,
    name: 'Payments',
    does: 'Card payments for packs, memberships and anything NUM settles on a guest\'s behalf.',
    needs: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
    ready: (env) => has(env, 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'),
    surface: 'PaySheet + billing portal',
    code: ['worker/pay.mjs', 'src/components/app/PaySheet.tsx'],
    sop: {
      on: 'Both Stripe keys. The account is LIVE — every write is real money.',
      check: 'Stripe dashboard: a test purchase should appear with the member id in metadata.',
      broken: 'The webhook is the part that matters: without it a guest is charged and never granted. If STRIPE_WEBHOOK_SECRET is missing, take purchases offline rather than take the money.',
    },
  },
  {
    id: 'billpay',
    plan: 'free',
    entitlement: null,
    name: 'Pay the bill through NUM',
    does: 'Scan the code on the table, see every way to pay decided by where the table is, pay on the venue\'s own Stripe account with NUM\'s fee taken at source.',
    needs: ['STRIPE_SECRET_KEY', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'a venue with a connected Stripe account (num_business_rails)',
      'a Connect webhook endpoint that EXISTS at Stripe — this registry cannot see one, only /api/health can'],
    ready: (env) => has(env, 'STRIPE_SECRET_KEY', 'STRIPE_CONNECT_WEBHOOK_SECRET'),
    surface: 'itsnum.com/p/<token> chooser · app BillSheet · console Pay page',
    code: ['worker/payrails.mjs', 'worker/billpay.mjs', 'growth/connect.mjs', 'src/components/app/BillSheet.tsx', 'worker/migrations/0035_pay_rails.sql'],
    sop: {
      on: 'Run migration 0035. Set STRIPE_CLIENT_ID + STRIPE_SECRET_KEY on num-growth (the Connect button) and STRIPE_CONNECT_WEBHOOK_SECRET on num-app (a Stripe webhook endpoint for "events on connected accounts" pointed at app.itsnum.com/api/pay/webhook/connect, listening to checkout.session.completed, charge.refunded, charge.dispute.created). A venue connects from Pay in its console; the card rails appear on its bill codes the moment Stripe enables charges.',
      check: 'In Stripe test mode: connect a test venue, mint a bill code from the console, open /p/<token> — the chooser lists the rails for that country; pay by card — the webhook flips settled_at and num_commissions.paid_cs equals the application fee.',
      broken: 'The rails list is decided ONLY by worker/payrails.mjs. Crypto is HELD for TH venues (CRYPTO_HELD) until Thai counsel clears it — do not remove TH to make a demo work. Never add on_behalf_of, transfer_data or destination charges: the venue is merchant of record and NUM never holds the money. If the Connect webhook secret is missing, bills pay but never settle — take the Stripe rails offline (venue toggles or NUM_OFF) rather than leave bills open. On 18 Sep 2026 this entry read `ready` for a day while NO Connect endpoint existed at Stripe at all: the secret was set, so `ready` was satisfied, and a paid bill would have left the check open in the venue till. `ready` here means the secrets are present and nothing more — it cannot reach Stripe. The endpoint itself is checked by /api/health → bill_pay (worker/health.mjs checkBillPay). Trust that, not this line.',
    },
  },
  {
    id: 'billitems',
    plan: 'free',
    entitlement: null,
    name: 'What was on the bill',
    does: 'A venue sends a total, or the things that made it up — tapped off its own saved price list — and the guest sees the lines they are paying for.',
    needs: ['migration 0045 — and `ready` below CANNOT see whether it ran, because the registry evaluates readiness synchronously and cannot ask the database'],
    ready: (env) => !!env.DB,
    surface: 'console Tables page · guest BillSheet and /p/<token>',
    code: ['worker/billitems.mjs', 'growth/worker.js', 'src/components/app/BillSheet.tsx', 'worker/migrations/0045_bill_items_and_split.sql'],
    sop: {
      on: 'Run migration 0045. Nothing to configure: the itemised path appears on the Tables page beside the amount box, and the owner can save a price list under it.',
      check: 'On the console, tap "Add what they had instead", add two lines, and watch the Amount box go read-only with their sum in it. Make the code and open /p/<token> — the lines are listed above the total.',
      broken: 'The total IS the lines, and there is deliberately no second field for a total when lines exist — a bill whose items say 2,400 and whose charge says 2,600 is what a guest disputes at the door. The server adds the lines up again and mints for that figure, so a tampered browser cannot produce a mismatch. Never make itemising compulsory: a paper-bill venue in Thailand types a total and always will. A bill line copies the product name and price at the moment it is added and never reads the product again, so changing a price cannot rewrite a receipt.',
    },
  },
  {
    id: 'paytrack',
    plan: 'free',
    entitlement: null,
    name: 'What happened to your bills',
    does: 'Every step of a bill written down — which rail a guest picked, whether the payment page opened, whether it settled, and whether the check actually closed in the till.',
    needs: ['migration 0047 — `ready` below cannot see whether it ran (see /api/health → bill_tracking, which can)'],
    ready: (env) => !!env.DB,
    surface: 'console Tables page tile · GET /api/venue/funnel · GET /api/venue/bill/trail?token=',
    code: ['worker/paytrack.mjs', 'growth/worker.js', 'worker/migrations/0047_pay_funnel.sql'],
    sop: {
      on: 'Run migration 0047. Nothing to configure — the events start landing on the next paid bill.',
      check: 'Pay a test bill, then open the Tables page: the funnel shows the scan, the rail, the session and the payment. Paste the bill code into "Trace one bill" and the whole trail comes back in order.',
      broken: 'This entry reports `on` from the CODE alone. features.mjs evaluates ready() synchronously, so a feature whose only precondition is a migration cannot check its own precondition — on 19 Sep paytrack read `on` before anyone confirmed 0047 had run, and it happened to be right, which is the problem. /api/health → bill_tracking asks the schema and is the thing to trust. It must never break a payment: every write is wrapped and returns null on failure, because a webhook that throws over analytics makes Stripe retry a settled bill. The kind vocabulary is closed — an unknown kind is dropped rather than inserted, since a typo that invents a stage nobody counts makes the funnel look complete when it is not. Reasons are scrubbed of anything shaped like a Stripe id or a key before they are stored, because venue staff read them. And there is deliberately NO conversion rate: scans and payments are counted over the same window but are not the same population, so a ratio would look like a rate and would not be one.',
    },
  },
  {
    id: 'venuepayout',
    plan: 'free',
    entitlement: null,
    name: 'Where your money is',
    does: 'Shows a venue what its NUM bills came to and, separately, when its own Stripe payouts land.',
    needs: ['migration 0056', 'the Connect webhook subscribed to payout.paid, payout.failed and payout.created'],
    ready: (env) => !!env.DB,
    surface: 'Console → Pay → Where your money is',
    code: ['worker/venuepayout.mjs', 'worker/billpay.mjs', 'growth/worker.js', 'worker/migrations/0056_venue_payouts.sql'],
    sop: {
      on: 'Run 0056, then add payout.created, payout.paid and payout.failed to the existing Connect endpoint (Dashboard → Webhooks → the endpoint at /api/pay/webhook/connect). No new credential: it is the same endpoint the bills already use.',
      check: 'In test mode, pay a bill on a connected venue and trigger a payout on that account. The tile shows the payout with Stripe\'s own status, and the NUM figure beside it — not added to it.',
      broken: 'The two figures are NEVER summed. A Stripe payout is the venue\'s whole balance — their own card sales, refunds and adjustments as well as anything through NUM — so a combined total would be a number nobody can check, and "your NUM money arrives Tuesday" would be false twice over. The payout status is copied from Stripe and never inferred: a failed payout must not read as arriving. What NUM settled is counted per currency and never summed across them, and a split dinner counts its SHARES (which were really charged) and not its parent (which never was). Nothing in venuepayout.mjs moves money and nothing ever should — a test refuses an exported function whose name starts with a verb like pay, send or release.',
    },
  },
  {
    id: 'tillbill',
    plan: 'free',
    entitlement: null,
    name: 'Scan the table, see your bill',
    does: 'At a venue whose till can be asked about one table, the permanent table sticker shows the real open check with its items, and the guest raises it as a bill themselves.',
    needs: ['migration 0057', 'a till that answers per table — only Lightspeed K-Series today', 'a table a person has mapped to its till number'],
    ready: (env) => !!env.DB,
    surface: '/p/<sticker token> → POST /p/<token>/bill',
    code: ['worker/tillbill.mjs', 'growth/worker.js', 'growth/pos/lightspeed.mjs', 'worker/migrations/0057_till_tables.sql'],
    sop: {
      on: 'Run 0057. Connect Lightspeed from Pay → Your till, then map each table to the number its till uses. Until a table is mapped it behaves exactly as a Square venue does: staff type the figure.',
      check: 'Open a check on table 7 in Lightspeed, scan that table\'s NUM sticker: the page shows the real amount and the real items, with the covers and the time it opened. Press the button and it becomes an ordinary NUM bill code carrying pos_order_id, so settling it closes that check.',
      broken: 'The table mapping is STORED and never parsed at read time. Digits in a name get it right most of the time, and the one time they do not a guest is shown somebody else\'s dinner and invited to pay for it — the exact failure Square and Clover avoid by leaving the match to a human. Nothing is minted by drawing a page: raising the bill is a POST, because a screen being drawn must never create a payable code. Two guests tapping at once get the SAME code, since two codes for one dinner is two ways to pay for it. The check is shown with its covers and open time so a person can tell it is theirs, because a correctly mapped table still holds the previous party\'s check if nobody cleared it. Only a till with checkForTable qualifies — matching an open check by amount would be the guess this whole feature refuses.',
    },
  },
  {
    id: 'billsplit',
    plan: 'free',
    entitlement: null,
    name: 'Split it with friends',
    does: 'One bill becomes one real bill code per person, each paid straight to the venue, each handed to that person by whatever actually reaches them — their NUM, a text, an email, or a link their friend passes over.',
    needs: ['migration 0045', 'the same connected Stripe account billpay needs', 'friends on a tab to split it between'],
    ready: (env) => !!env.DB,
    surface: 'app BillSheet → SPLIT IT WITH FRIENDS → POST /api/bill/<token>/split',
    code: ['worker/billsplit.mjs', 'worker/billreach.mjs', 'worker/billqr.mjs', 'src/components/app/BillSheet.tsx'],
    sop: {
      on: 'Run migration 0045. Kill switch is NUM_OFF_BILLSPLIT. It needs no new credential: a share is an ordinary bill code on the venue that is already connected.',
      check: 'Open a fixed bill in the app, tap SPLIT IT WITH FRIENDS, have a second member join the tab with the code, send the shares. Every share comes back with a link and a sentence saying whether NUM reached that person or somebody has to pass it on — read num_bill_reach for what was tried. Pay them all and confirm num_commissions gained ONE line, not one per friend, and that the parent flipped settled_at only on the last payment.',
      broken: 'NUM never moves money between people — that is the whole reason a split mints real codes instead of tracking who owes whom, and a ledger that settles between members would be money transmission in all three markets. Shares must sum to the parent exactly; the odd penny goes to whoever split it, never to the floor. The parent is closed to direct payment the moment it is split, or one dinner gets paid twice with no pleasant refund path. The fee is computed on the whole bill, allocated by largest remainder, and stamped on each share at split time — never recomputed per share. A share must always come back with a LINK: this fanned out to push alone until 19 Sep 2026, when the live base held zero push tokens and one member email, so every split told nobody and a share for a friend who is not on NUM had no member_id to notify at all. NUM texts a friend only when the splitter is phone-verified, the number has not said STOP, and that share has not been texted before; a rail that will not carry a message is a handover, never a reason to unwind a correct split.',
    },
  },
  {
    id: 'billreceipt',
    plan: 'free',
    entitlement: null,
    name: 'Your copy of the bill',
    does: 'A guest who has just paid is offered their receipt by email or text, on the confirmation screen — the one place a person has a reason to type an address in.',
    needs: ['RESEND_KEY for email', 'TWILIO_SID + TWILIO_TOKEN + a Messaging Service for text'],
    ready: (env) => !!env.DB && !!(env.RESEND_KEY || env.RESEND_API_KEY || (env.TWILIO_SID && env.TWILIO_TOKEN)),
    surface: '/p/<token> once settled → POST /p/<token>/receipt',
    code: ['worker/billreceipt.mjs', 'growth/worker.js'],
    sop: {
      on: 'Nothing to switch on beyond the transports already used for sign-in codes. The table is created on first use. With neither transport configured the box does not render at all rather than failing when somebody types in it.',
      check: 'Pay a bill, reopen /p/<token>, type an email address and press Send my receipt: the page comes back with "Sent". Press it again with the same address and it says "Already sent" without a second send. Type a number with no country code and it tells you to add one.',
      broken: 'The PAGE is the receipt and this is strictly an addition — a guest who gives nothing has lost nothing, and nothing here may block, delay or fail a payment. No receipt for an unpaid bill, and an unknown code gets the same answer as an unpaid one so this cannot be used to ask whether a venue is on NUM. A STOP outlives a request typed on a page: an opted-out number is not texted because a different screen offered, and it is told to use email. The redirect carries a CODE and never a sentence, because a sentence in a query string renders as NUM\'s own voice on NUM\'s own page. A failure says so and says the receipt is still on the page; "sent" is never reported for a send that did not happen. NOT sent automatically to a member\'s address on file: one member of 156 has an email and none is verified, so an automatic send would be mail to an address nobody has confirmed is theirs.',
    },
  },
  {
    id: 'ledger',
    plan: 'free',
    entitlement: null,
    name: 'Every line, in order',
    does: 'One ledger read by whoever is looking at it — a member sees what they paid and what is waiting for them, a venue sees what came in, what NUM took and what Stripe moved.',
    needs: ['migration 0045 for paid_by_member', 'nothing else — it derives from what is already written down'],
    ready: (env) => !!env.DB,
    surface: 'GET /api/ledger?me=<id> · WALLET → WAITING FOR YOU · /biz/pay → Every line',
    code: ['worker/ledger.mjs', 'growth/worker.js', 'src/components/app/WalletSheet.tsx'],
    sop: {
      on: 'Nothing to switch on and no new table. It is a READ MODEL over num_paylinks, num_commissions, num_business_payouts and num_venue_payouts; a ledger table would be a second copy of the money that can disagree with the first.',
      check: 'Pay a bill as a signed-in member: it appears under BILLS YOU HAVE PAID. Split one to that member and leave it unpaid: it appears under WAITING FOR YOU and NOT in any total. Open /biz/pay as the venue: the same bill is one line in, the fee is a separate line out, and a Stripe payout is its own line that is never added to either.',
      broken: 'Nothing is summed across currencies or units — a venue taking dollars and baht has two totals, and a ฿70 line once rendered as $70.00 thirty-three times over. Pending is never counted as settled; a payout status is copied from Stripe, never inferred. A bill with no paid_by_member belongs to nobody and must not be attached to the nearest member. The two fee lines stay SEPARATE: fee_at_source is money Stripe already moved and fee_invoiced is money NUM has asked for, and netting them would hide the double charge that chargedTwice() exists to surface. num_business_payouts (Stripe paying the venue\'s bank) and num_venue_payouts (NUM owing the venue a seat share) run in opposite directions and must never be confused.',
    },
  },
  {
    id: 'memberwallet',
    plan: 'free',
    entitlement: null,
    ungated: false,
    name: 'Your own wallet',
    does: 'A Base wallet of the member\'s own, made from their verified number without them ever having to understand one.',
    needs: ['PRIVY_APP_ID', 'PRIVY_APP_SECRET'],
    ready: (env) => has(env, 'PRIVY_APP_ID', 'PRIVY_APP_SECRET'),
    surface: 'WALLET → /api/wallet',
    code: ['worker/privy.mjs', 'worker/migrations/0039_wallets_and_pos.sql'],
    sop: {
      on: 'Create a Privy app, set both secrets on num-app. Free to 499 monthly active wallets. Nothing else: wallets are pregenerated from the phone number NUM already verified.',
      check: 'GET /api/wallet?me=<id> returns null and available:false while off; POST /api/wallet/create for a phone-verified member returns an address, and a second call returns the SAME address.',
      broken: 'Four rules hold whatever else changes: NUM never holds the key (Privy signs in a TEE), NUM never funds a wallet (no function here moves value in — see cashout.mjs on cash-in-cash-out), Stars and USDC are never one number, and only a phone-verified member gets a wallet. If Privy is down, the wallet screen says so; it never shows a zero balance, because a member reads zero as "my money is gone".',
    },
  },
  {
    id: 'pos',
    plan: 'free',
    entitlement: null,
    name: 'Read the venue\'s till',
    does: 'Pulls an open check from the venue\'s own point of sale, and closes it there when the guest pays through NUM.',
    needs: ['POS_TOKEN_KEY', 'SQUARE_APP_ID', 'SQUARE_APP_SECRET', 'a venue that has connected its till'],
    ready: (env) => has(env, 'POS_TOKEN_KEY', 'SQUARE_APP_ID', 'SQUARE_APP_SECRET'),
    surface: 'Console → Pay → Your till',
    code: ['growth/pos/index.mjs', 'growth/pos/square.mjs', 'growth/pos/clover.mjs', 'growth/pos/lightspeed.mjs', 'growth/pos/detect.mjs', 'worker/billpay.mjs', 'worker/migrations/0039_wallets_and_pos.sql'],
    sop: {
      on: 'Run 0039. Set POS_TOKEN_KEY (any long random string — it encrypts merchant tokens at rest) plus the Square app id and secret on num-growth AND num-app, because the console connects the till and the Stripe webhook closes the check. A venue connects from Pay → Your till and picks a location. Three adapters exist: Square and Clover need their own app id and secret, Lightspeed Restaurant needs LIGHTSPEED_CLIENT_ID and LIGHTSPEED_CLIENT_SECRET. An adapter without credentials is not offered rather than offered and broken.',
      check: 'Console → Pay → Your till → Show open checks lists what the till has open. Pay a bill minted from one of those checks and the order should read COMPLETED in Square.',
      broken: 'This is never the only way to get a bill — staff typing the figure still works and always must. NUM never guesses which check belongs to a table (Square has no table field, only free-text ticket_name), and a till that will not close a check never turns a paid bill into a failed one. Tell a Square venue that Square charges THEM 1% on an externally paid order before they switch it on. Lightspeed is the exception to the table rule and the reason it was worth building: K-Series reads the check BY TABLE and returns salesEntries, so a venue on it never types a bill and the guest sees the items. Its amounts are MAJOR units where everything else in NUM is minor, converted exactly once at the adapter boundary, and its response carries no currency at all — that comes from the venue profile, never the till, the same rule billphoto.mjs follows. The till NUM guesses from a venue\'s own payment link (detect.mjs) is only ever a guess: it reorders the buttons and changes nothing else, because a payment link is not a till.',
    },
  },
  {
    id: 'billphoto',
    plan: 'free',
    entitlement: null,
    name: 'Read the bill from a photo',
    does: 'Staff photograph the paper bill and the total fills itself in — for the venues that have no till to read.',
    needs: ['ANTHROPIC_API_KEY'],
    ready: (env) => has(env, 'ANTHROPIC_API_KEY'),
    surface: 'Console → tables → Photograph the bill instead',
    code: ['worker/billphoto.mjs', 'worker/migrations/0041_bill_proposals.sql'],
    sop: {
      on: 'Nothing beyond ANTHROPIC_API_KEY on num-growth and migration 0041. This is the Thailand path: Ocha, FoodStory and StoreHub have no public API, and a large share of Thai restaurants run on a paper slip.',
      check: 'Console → put an amount on a table → Photograph the bill instead. A clear photo of a printed total should fill the Amount box; a blurred one should say so and leave the box empty.',
      broken: 'THE MODEL PROPOSES, STAFF CONFIRM, THE GUEST NEVER SETS THE AMOUNT. Nothing here mints a bill code — that is still the button a human presses, because billqr.mjs\'s whole case that a venue cannot under-report rests on a person being accountable for the figure. A read below MIN_CONFIDENCE is refused rather than shown. The currency comes from the venue profile, never the photograph. The photograph is never stored — only the raw answer, the confidence and a hash.',
    },
  },
  {
    id: 'autopay',
    plan: 'free',
    entitlement: null,
    name: 'NUM just pays',
    does: 'Bills under a limit the member set are paid without a tap — on the venue\'s own Stripe account, like every other NUM bill.',
    needs: ['STRIPE_SECRET_KEY', 'a member who opted in', 'a venue with a connected Stripe account'],
    ready: (env) => has(env, 'STRIPE_SECRET_KEY'),
    surface: 'WALLET → auto-pay · BillSheet',
    code: ['worker/autopay.mjs', 'worker/billpay.mjs', 'worker/migrations/0042_autopay.sql'],
    sop: {
      on: 'Run 0042. Nothing else: it rides on the Stripe key that is already there. A member saves a card once (SetupIntent, 3DS at save time), sets a limit, and agrees to the mandate — which is stored with the row, because a mandate you cannot produce afterwards is a mandate you did not take.',
      check: 'Turn it on with a low cap, open a bill under it, and it should pay without a tap; raise the bill above the cap and the buttons should come back. num_autopay_attempts should have a row either way.',
      broken: 'This is the most dangerous thing in the product and it is built to fail towards the tap. It is opt-in, capped (HARD_CAP_MINOR, clamped server-side), limited per day, and every attempt is logged for the person whose money it is. The card is CLONED onto the venue\'s account for one charge — never a destination charge, because that would put the money through NUM. An issuer asking for the cardholder is the ordinary case, not an outage: it hands back to the tap and NEVER retries. If in doubt, switch it off — a guest tapping to pay is what happens today.',
    },
  },
  {
    id: 'membership',
    plan: 'free',
    entitlement: null,
    name: 'Num Plus & Num Pro',
    does: 'The paid plans — more room, more research, new things first.',
    needs: ['STRIPE_SECRET_KEY'],
    ready: (env) => has(env, 'STRIPE_SECRET_KEY'),
    surface: 'Profile → MembershipCard',
    code: ['worker/membership.mjs', 'worker/starmembership.mjs', 'src/components/app/MembershipCard.tsx'],
    sop: {
      on: 'Set STRIPE_SECRET_KEY. Prices live in membership.mjs; MEMBERSHIP_TIERS overrides them without a deploy and can never re-gate travel.',
      check: 'GET /api/membership — the tier table the client renders.',
      broken: 'Two limits are real as of 18 Sep 2026 — plans_max and deep_research_monthly — and everything else in the tier table is still decorative. Check `plans.enforced` on this endpoint before believing any claim on the pricing page: a limit not listed there is not being applied to anybody.',
    },
  },

  {
    id: 'research',
    plan: 'free',
    entitlement: 'deep_research_monthly',
    name: 'Deep research',
    does: 'The long answer — several questions at once, checked against real places, with what it could not confirm said out loud.',
    needs: ['ANTHROPIC_API_KEY'],
    ready: (env) => has(env, 'ANTHROPIC_API_KEY') || has(env, 'NUM_OPENAI_KEY') || has(env, 'NUM_LLM_KEY'),
    surface: 'thread — starts a run, pings when it is ready',
    code: ['worker/research.mjs', 'worker/migrations/0033_deep_research.sql'],
    sop: {
      on: 'Any brain key. Metered by deep_research_monthly: 3 a month free, 40 on Plus, unlimited on Pro.',
      check: 'POST /api/research {me, brief, dest}, then GET /api/research?id= until state is done.',
      broken: 'Runs sit at queued. THE FREE ALLOWANCE MUST STAY ABOVE ZERO — at zero this stops being a metered feature and becomes a travel benefit sold only to subscribers, which is the §17550.27 problem membership.mjs exists to avoid; assertFreeFloor() refuses to run without it. A failed run never charges the allowance.',
    },
  },

  // ── THE PLATFORM ──────────────────────────────────────────────────────
  {
    id: 'memory',
    plan: 'free',
    entitlement: null,
    name: 'Memory',
    does: 'Remembers the allergy, the budget and the fact they hate boats, so nobody says it twice.',
    needs: [],
    ready: () => true,
    surface: 'MEMORY tab',
    code: ['worker/memory.mjs', 'src/components/app/MemoryView.tsx'],
    sop: {
      on: 'Always on. Facts are shown to the member and can be deleted by them.',
      check: 'Tell NUM a preference, then GET the facts for that member.',
      broken: 'NUM repeats questions it has been answered. Annoying, never dangerous — except for an allergy, which is why allergies are surfaced on every food answer rather than trusted to the model.',
    },
  },
  {
    id: 'calendar',
    plan: 'free',
    entitlement: null,
    name: 'Trip calendar',
    does: 'Every booking in one place, with a warning when two of them collide.',
    needs: [],
    ready: () => true,
    surface: 'TODAY + CalendarSheet',
    code: ['worker/calendar.mjs', 'src/components/app/CalendarSheet.tsx'],
    sop: {
      on: 'Always on. Every booking NUM makes lands here without anyone choosing to save it.',
      check: 'Create two overlapping bookings and confirm the clash is flagged.',
      broken: 'A missed clash is a double booking the guest finds out about at the door.',
    },
  },
  {
    id: 'voice',
    plan: 'free',
    entitlement: 'voice',
    name: 'Voice',
    does: 'Talk to NUM instead of typing — which is what people do with their hands full and a bag on their shoulder.',
    needs: ['TWILIO_VOICE_FROM'],
    ready: (env) => has(env, 'TWILIO_VOICE_FROM') || has(env, 'ELEVENLABS_KEY'),
    surface: 'the mic in the composer',
    code: ['worker/voice.mjs', 'worker/notifyvoice.mjs'],
    sop: {
      on: 'TWILIO_VOICE_FROM for the phone side, ELEVENLABS_KEY for spoken replies.',
      check: 'Send a voice note in the app and confirm a transcript reaches num_asks.',
      broken: 'The mic button is visible in every screenshot of this app and does nothing without a key — so if it is not ready, hide the button rather than offer it.',
    },
  },
  {
    id: 'sms',
    plan: 'free',
    entitlement: null,
    name: 'NUM by text',
    does: 'The whole concierge over SMS, for a traveller with no data and no app.',
    needs: ['TWILIO_SID', 'TWILIO_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID'],
    ready: (env) => has(env, 'TWILIO_SID', 'TWILIO_TOKEN')
      || has(env, 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'),
    surface: 'a phone number',
    code: ['worker/sms.mjs', 'worker/twiliosender.mjs', 'worker/smsconsent.mjs'],
    sop: {
      on: 'The Twilio trio. A2P 10DLC registration must be live or US carriers drop the messages.',
      check: 'Text the number and expect an answer; GET /api/sms/status for delivery receipts.',
      broken: 'Error 30034 = unregistered A2P campaign, and it fails silently from the sender\'s point of view. This is the open blocker behind the Friday-draw winner notification.',
    },
  },
  {
    id: 'whatsapp',
    plan: 'free',
    entitlement: null,
    name: 'NUM on WhatsApp',
    does: 'The same concierge where most of Asia and Europe already talks.',
    needs: ['TWILIO_WHATSAPP_FROM'],
    ready: (env) => has(env, 'TWILIO_WHATSAPP_FROM'),
    surface: 'WhatsApp',
    code: ['worker/whatsapp.mjs'],
    sop: {
      on: 'Set TWILIO_WHATSAPP_FROM and approve the templates in Meta Business.',
      check: 'GET /api/version — connected.whatsapp should be true. It is false as of 18 Sep 2026.',
      broken: 'Not connected. Every LINE and WhatsApp mention in the marketing should say LINE only until this is true.',
    },
  },
  {
    id: 'agents',
    plan: 'free',
    entitlement: null,
    name: 'NUM for AI agents',
    does: 'Other assistants can ask NUM for real places, real hours and a real table — NUM as a tool, not a competitor.',
    needs: [],
    ready: () => true,
    surface: 'MCP, at /api/concierge/mcp and /api/partner/mcp',
    code: ['worker/conciergemcp.mjs', 'worker/partnermcp.mjs', 'worker/openapi.mjs'],
    sop: {
      on: 'Always on. Six partner tools and two concierge tools; the partner surface needs a key, the concierge one does not.',
      check: 'POST /api/partner/mcp {"method":"tools/list"} — expect search_places, concierge_answer, list_destinations, place_details, open_places, booking_link.',
      broken: 'This is the quietest surface NUM has and the one with the most leverage: the MCP registry does not list NUM, so nothing can find it. Listing it is a marketing task, not an engineering one.',
    },
  },
  {
    id: 'business',
    plan: 'free',
    entitlement: null,
    name: 'For businesses',
    does: 'A venue claims its page, answers booking texts, and is seen by every traveller who asks.',
    needs: [],
    ready: () => true,
    surface: 'itsnum.com/biz + the console',
    code: ['worker/bizconsole.mjs', 'worker/claim.mjs', 'worker/bizbilling.mjs'],
    sop: {
      on: 'Always on. Businesses pay on their own tier table in bizbilling.mjs, separate from member plans.',
      check: 'GET /api/biz — the console index.',
      broken: 'Claims stack up unanswered and venues that said yes to NUM hear nothing. The claim queue needs a human; the alert for it is in the ledger.',
    },
  },
  {
    id: 'verify',
    plan: 'free',
    entitlement: null,
    name: 'Verified identity',
    does: 'A member can prove who they are, which is what lets NUM vouch for them to a venue.',
    needs: [],
    ready: (env) => has(env, 'LEDGER') || has(env, 'VERIFY_5ARZ_URL'),
    surface: 'Profile → IdentityCard',
    code: ['worker/identity.mjs', 'worker/bizverify.mjs', 'src/components/app/Verify5arz.tsx'],
    sop: {
      on: 'Reads verification from the 5arz ledger binding. NUM never writes to that database.',
      check: 'GET /api/trust for a verified member.',
      broken: 'Members show as unverified, so NUM vouches for nobody and high-value bookings stop. Read-only, so it can never corrupt the ledger.',
    },
  },
  {
    id: 'scout',
    plan: 'free',
    entitlement: null,
    name: 'Scout',
    does: 'What opened, closed or changed in a destination since last week — so the answers are not last year\'s.',
    needs: [],
    ready: () => true,
    surface: 'behind every answer, and ScoutSheet',
    code: ['worker/scouts.mjs', 'worker/scoutpage.mjs'],
    sop: {
      on: 'Always on; the scout worker writes and the concierge reads.',
      check: 'GET /api/admin/scout-usage.',
      broken: 'Answers get stale slowly and nothing errors, which is the hardest kind of decay to notice. Watch the freshest row date, not the endpoint.',
    },
  },
]);

/**
 * Features whose limit is actually enforced by a `may()` call in the product.
 *
 * This set is edited BY HAND, deliberately, at the same moment the call site
 * is written — never derived, never inferred. A registry that guessed would
 * eventually guess wrong in the direction that flatters us, and the whole
 * point of `enforced` is to be the one field nobody can fudge.
 *
 *   plans    → worker/social.mjs, planWrite(), the create branch
 *   research → worker/research.mjs, startResearch()
 */
const ENFORCED = new Set(['plans', 'research']);

/** What a feature is doing right now, and why. */
export function statusOf(env, f) {
  const off = isOff(env, f.id);
  const ready = (() => { try { return !!f.ready(env); } catch { return false; } })();
  const missing = f.needs.filter((k) => !env?.[k]);
  return {
    id: f.id,
    name: f.name,
    does: f.does,
    surface: f.surface,
    state: off ? 'off' : ready ? 'on' : 'needs_setup',
    // Only ever the NAMES of what is missing. A key's value never leaves here.
    missing: ready ? [] : missing,
    switch: off ? `remove "${f.id}" from NUM_OFF` : `NUM_OFF=${f.id}`,
    code: f.code,
    sop: f.sop,
    plan: f.plan,
    entitlement: f.entitlement ?? null,
    ungated: !!f.ungated,
    // The honest bit. A feature can NAME an entitlement and still not be
    // metered by it, because naming is not calling. `enforced` is true only
    // where a may() call actually stands in the code path, and the pricing
    // page has no business claiming a limit this says is not real.
    //
    // 18 Sep 2026: this was `false` for everything, because may() had no
    // callers at all. The two below are the first real gates NUM has.
    enforced: ENFORCED.has(f.id),
  };
}

/**
 * Everything wrong with the registry itself, as a list.
 *
 * Kept here rather than only in the test file so an operator can ask the live
 * worker — a registry that disagrees with the law or with membership.mjs is a
 * production fact, not a CI detail.
 */
export function auditFeatures(plans = ['free', 'plus', 'pro']) {
  const problems = [];
  const seen = new Set();
  for (const f of FEATURES) {
    if (seen.has(f.id)) problems.push(`duplicate id: ${f.id}`);
    seen.add(f.id);
    if (!plans.includes(f.plan)) problems.push(`${f.id}: plan "${f.plan}" is not a real plan`);
    if (f.ungated && f.plan !== UNGATEABLE_PLAN) {
      problems.push(`${f.id}: travel is ungateable (B&P §17550.27) but plan is "${f.plan}"`);
    }
    for (const k of ['name', 'does', 'surface']) if (!f[k]) problems.push(`${f.id}: missing ${k}`);
    for (const k of ['on', 'check', 'broken']) if (!f.sop?.[k]) problems.push(`${f.id}: SOP missing "${k}"`);
    if (!Array.isArray(f.code) || !f.code.length) problems.push(`${f.id}: no code paths`);
  }
  return problems;
}

/** GET /api/features — the operator's one screen. */
export function handleFeatures(env) {
  const features = FEATURES.map((f) => statusOf(env, f));
  const body = {
    ok: true,
    on: features.filter((f) => f.state === 'on').length,
    needs_setup: features.filter((f) => f.state === 'needs_setup').map((f) => f.id),
    off: features.filter((f) => f.state === 'off').map((f) => f.id),
    // What a guest on each plan can meet, and how much of it is actually
    // enforced. `enforced: 0` is the true answer today and it should stay
    // visible until it is not.
    plans: {
      free: features.filter((f) => f.plan === 'free').length,
      plus: features.filter((f) => f.plan === 'plus').length,
      pro: features.filter((f) => f.plan === 'pro').length,
      metered: features.filter((f) => f.entitlement).map((f) => f.id),
      enforced: features.filter((f) => f.enforced).map((f) => f.id),
      ungated: features.filter((f) => f.ungated).map((f) => f.id),
    },
    audit: auditFeatures(),
    features,
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
