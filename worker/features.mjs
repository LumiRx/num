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
 */

/** @type {readonly Feature[]} */
export const FEATURES = Object.freeze([
  {
    id: 'concierge',
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
    name: 'Real ratings',
    does: 'The first ask about a neighbourhood fetches real ratings for it, so the picks are ranked by something true.',
    needs: ['SERPAPI_KEY'],
    ready: (env) => has(env, 'SERPAPI_KEY'),
    surface: 'invisible — it ranks everything else',
    code: ['worker/placeratings.mjs', 'ai/places.js'],
    sop: {
      on: 'Set SERPAPI_KEY. One search per ~1 km cell per category per 30 days; the cost is bounded by geography, not by traffic.',
      check: 'SELECT cell, cat, found, matched FROM num_rating_runs ORDER BY ts DESC LIMIT 5 — matched should be more than half of found.',
      broken: 'matched near zero means the directory has no rows where people are asking, not that the search failed. Off = the old ranking; picks get duller, nothing errors.',
    },
  },
  {
    id: 'flightwatch',
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
]);

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
  };
}

/** GET /api/features — the operator's one screen. */
export function handleFeatures(env) {
  const features = FEATURES.map((f) => statusOf(env, f));
  const body = {
    ok: true,
    on: features.filter((f) => f.state === 'on').length,
    needs_setup: features.filter((f) => f.state === 'needs_setup').map((f) => f.id),
    off: features.filter((f) => f.state === 'off').map((f) => f.id),
    features,
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
