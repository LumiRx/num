// Duffel — the provider that can actually issue a ticket.
//
// Decision D-008 chose Duffel over Sabre for one reason that survives every
// other comparison: Duffel supplies the accreditation. "With Duffel, you don't
// need to be an ARC/IATA travel agent. We take care of this for you."
// (https://help.duffel.com/hc/en-gb/articles/360019644700). Sabre gives Num
// content and leaves the ticketing authority as Num's problem; Duffel does
// not. Everything below follows from that.
//
// ── WHAT THIS FILE IS, AND IS NOT ────────────────────────────────────────
//
// worker/sabre.mjs is finished and live, and it can only SHOP. It says what a
// flight costs and cannot claim a seat. worker/sabre-booking.mjs is the
// opposite shape: a complete security model — tier table, two-key production
// gate, admin-key money tier, mandatory idempotency, redacted audit — with no
// working provider behind it, because Sabre never gave us one.
//
// This file keeps the second and replaces the first. The gates, the tiers, the
// idempotency rule and the audit shape are lifted deliberately from
// sabre-booking.mjs, because they were right and none of them were the reason
// Sabre stalled. Only the provider call changes.
//
// ── WHAT IS PROVEN AND WHAT IS NOT ───────────────────────────────────────
//
// As of 2026-08-18 there is NO Duffel token. Every request shape here is built
// from Duffel's published documentation and every function in this file is
// exercised against RECORDED responses in duffel.test.mjs. That proves the
// request bodies, the header set, the normalizer and the gates. It proves
// NOTHING about whether Duffel accepts them. Do not read a green test run as
// "booking works" — read it as "the code does what the docs describe".
//
// Two things Num did not have. ONE OF THEM IS NOW BUILT:
//
//   1. A PASSENGER RECORD — **BUILT, 2026-08-18.** `worker/passengers.mjs` and
//      `worker/migrations/0002_passengers.sql` hold every field create-order
//      requires per passenger: given_name, family_name, born_on, gender, title,
//      email, phone_number, plus optional passport details for the airlines
//      that set `passenger_identity_documents_required`, plus companions who
//      are not Num members and the infant→responsible-adult association.
//      `passengerFromRecord()` below turns one stored row into one Duffel
//      Order Request Passenger. The only part of the passenger object that is
//      NOT stored is Duffel's `id` (`pas_…`): it is minted per offer request
//      and is meaningless against any other offer, so it is supplied by the
//      caller from the live offer and never persisted.
//      Retention, redaction and the rule that none of it may cross to 5arz are
//      in HQ/divisions/num/PASSENGER_RECORD_MODEL.md.
//   2. A FORM OF PAYMENT — **STILL MISSING, and it is now the only engineering
//      item between here and a test booking.** An instant order needs
//      `payments: [{ type: 'balance', ... }]` drawn from a pre-funded Duffel
//      Balance topped up by bank transfer, or Duffel Payments card collection
//      (which needs Duffel's approval). Num has neither. In test mode balance
//      payments settle against play money; in live mode they settle against
//      real money that has to be there first.
//
// Until the second exists, `createOrder` can be called and will be refused by
// the gates before it reaches the network — which is the correct behaviour, not
// a bug to route around. Nothing in this file's routing or gating changed when
// the passenger record landed: `permitted()` is untouched and the commit path
// is still not routed.
//
// ── TEST MODE IS IN THE CREDENTIAL, NOT IN A SEPARATE SWITCH ─────────────
//
// Sabre needed SABRE_ENV because its two estates share a credential shape.
// Duffel does not: a test token literally starts with `duffel_test_`
// (https://duffel.com/docs/api/overview/test-mode/duffel-airways), so the
// environment is READ OFF THE TOKEN and cannot disagree with it. There is no
// way to point a live token at a sandbox by mistake, because there is no
// sandbox host to point it at — one base URL, two kinds of key.
//
// Docs this file was written from, all fetched 2026-08-18:
//   https://duffel.com/docs/api/overview/making-requests
//   https://duffel.com/docs/api/offer-requests/create-offer-request
//   https://duffel.com/docs/api/v2/offers/get-offer-by-id
//   https://duffel.com/docs/api/orders/create-order
//   https://duffel.com/docs/api/overview/response-handling/order-and-booking-creation
//   https://duffel.com/docs/api/overview/test-mode/duffel-airways
//   https://duffel.com/docs/guides/collecting-and-making-payments

import { TITLES, GENDERS, PASSENGER_TYPES, paxTypeOn } from './passengers.mjs';

const API = 'https://api.duffel.com';

// Pinned, not floated. Duffel versions its API by header, and "whatever is
// current" is how a working integration breaks on somebody else's release day.
const DUFFEL_VERSION = 'v2';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const readBody = async (req) => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/** Mirrors sabreReady: one predicate, asked before anything else runs. */
export const duffelReady = (env) => !!env.DUFFEL_ACCESS_TOKEN;

/**
 * 'test' | 'live', read off the token itself.
 *
 * Returns null when there is no token at all, so callers can tell "not
 * configured" apart from "configured for test".
 */
export function duffelMode(env) {
  const t = env?.DUFFEL_ACCESS_TOKEN;
  if (!t) return null;
  return String(t).startsWith('duffel_test_') ? 'test' : 'live';
}

/**
 * What a commit would do RIGHT NOW, in one word, derived from the gate itself.
 *
 *   'no_token' — DUFFEL_ACCESS_TOKEN is unset. Nothing here works.
 *   'locked'   — the token loads, search works, and `permitted(env,'create')`
 *                refuses. This is the state Num is meant to sit in.
 *   'live'     — every gate would let a create through.
 *
 * It asks `permitted` rather than re-reading the two env vars, so this string
 * cannot drift away from what the code actually does. A capability flag that
 * is computed a second way is a capability flag that will eventually lie, and
 * this one is read by whoever is deciding whether it is safe to deploy.
 */
export function duffelCommitState(env) {
  if (!duffelReady(env)) return 'no_token';
  return permitted(env, 'create').ok ? 'live' : 'locked';
}

/**
 * The /api/version entry. Three honest states, not one boolean.
 *
 * `search` and `commit` are deliberately separate fields because they are
 * separate permissions — the whole lesson of flightcap.test.mjs is that
 * collapsing "can price it" and "can buy it" into one line makes something
 * downstream believe the wrong half.
 */
export const duffelCapability = (env) => ({
  search: duffelReady(env),
  estate: duffelMode(env),
  commit: duffelCommitState(env),
});

// ── operations, by how much damage each can do ────────────────────────────

/**
 * The security model in one table, carried over from sabre-booking.mjs.
 *
 * `tier` is derived from consequence, not from HTTP verb: creating an offer
 * request is a POST and costs nothing; cancelling an order is a POST and ends
 * somebody's holiday.
 */
export const OPS = {
  search: { tier: 'read', what: 'Create an offer request and read back offers. Holds nothing.' },
  offer: { tier: 'read', what: 'Re-read one offer, with its expiry and payment requirements.' },
  order: { tier: 'read', what: 'Retrieve an order that already exists.' },
  create: { tier: 'commit', what: 'Create the order. Takes real inventory and, for an instant order, real money.' },
  cancel: { tier: 'money', what: 'Cancel an order. Moves money that has already moved once.' },
};

const PATHS = {
  search: '/air/offer_requests',
  offer: (id) => `/air/offers/${encodeURIComponent(id)}`,
  order: (id) => `/air/orders/${encodeURIComponent(id)}`,
  create: '/air/orders',
  cancel: '/air/order_cancellations',
};

/**
 * Whether this operation may run at all, and if not, why in plain words.
 *
 * Same three gates as Sabre, with the middle one improved: Sabre needed
 * SABRE_ENV=prod plus SABRE_BOOKING_LIVE because its estate was a config
 * value. Here the estate is the token, so the second key guards the thing that
 * is actually dangerous — committing with a LIVE token — and cannot be
 * satisfied by a config typo.
 */
export function permitted(env, op, { adminKey = false } = {}) {
  const spec = OPS[op];
  if (!spec) return { ok: false, why: `Unknown operation "${op}".`, status: 404 };
  if (!duffelReady(env)) return { ok: false, why: 'DUFFEL_ACCESS_TOKEN is not set.', status: 503 };
  if (spec.tier === 'read') return { ok: true, tier: 'read' };

  if (env.DUFFEL_BOOKING_ENABLED !== 'true') {
    return { ok: false, why: 'Booking is switched off. Set DUFFEL_BOOKING_ENABLED=true to allow commits.', status: 403 };
  }
  // The two-key rule. A live token alone must not be enough.
  if (duffelMode(env) === 'live' && env.DUFFEL_BOOKING_LIVE !== 'true') {
    return {
      ok: false,
      why: 'This is a live Duffel token but DUFFEL_BOOKING_LIVE is not true. Refusing to commit against live inventory.',
      status: 403,
    };
  }
  if (spec.tier === 'money' && !adminKey) {
    return { ok: false, why: `"${op}" moves money and needs the admin key. It is not reachable from an app session.`, status: 401 };
  }
  return { ok: true, tier: spec.tier };
}

// ── audit ─────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_duffel_orders (
  id TEXT PRIMARY KEY, op TEXT NOT NULL, tier TEXT NOT NULL, member_id TEXT,
  idem TEXT, order_id TEXT, booking_reference TEXT, ok INTEGER NOT NULL DEFAULT 0,
  request TEXT, response TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_duffel_idem ON num_duffel_orders(idem) WHERE idem IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_duffel_order ON num_duffel_orders(order_id);
`;
let ready = false;
async function ensure(env) {
  if (ready || !env.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

/**
 * Tokens, card numbers and passport numbers must never reach an audit row.
 *
 * Duffel's create-order body carries more personal data than Sabre's ever did
 * — date of birth and identity documents alongside the card — so the redactor
 * covers those too. Over-redacting an audit row costs a debugging session;
 * under-redacting builds a searchable table of passports.
 */
export function redact(v) {
  if (v == null) return v;
  try {
    return JSON.parse(
      JSON.stringify(v)
        .replace(/"(Authorization|token|access_token|api_key|apiKey|password|client_key)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"')
        .replace(
          /"(card_number|number|cvc|security_code|expiry_month|expiry_year|born_on|unique_identifier|passport_number)"\s*:\s*"[^"]*"/gi,
          '"$1":"<redacted>"',
        )
        // The passenger record landed on 2026-08-18 and with it a create-order
        // body that carries a full legal name. A ticket number was already
        // redacted here; the name on the ticket was not, which made the audit
        // table the one place in Num holding government-style identity in the
        // clear. given_name/family_name/title/gender go the same way as the
        // date of birth above, and for the same reason.
        .replace(
          /"(given_name|family_name|title|gender|email|phone_number|issuing_country_code|loyalty_programme_accounts|account_number)"\s*:\s*"[^"]*"/gi,
          '"$1":"<redacted>"',
        )
        .replace(/\b\d{13,19}\b/g, '<redacted-number>'),
    );
  } catch {
    return { unserializable: true };
  }
}

// ── calling ───────────────────────────────────────────────────────────────

/**
 * One HTTP shape for the whole API.
 *
 * Duffel authenticates with a static bearer token, so unlike Sabre there is no
 * token mint, no cache and no 401-retry dance — the credential is the
 * credential. Everything that made sabre.mjs#call complicated is absent here
 * by construction.
 *
 * The timeout is not a round number by accident. Duffel's own guidance is to
 * allow at least 130 seconds because "Airline and Accommodation APIs can
 * occasionally be slow, taking up to 120s"
 * (docs/api/overview/response-handling/order-and-booking-creation). Aborting
 * a create at 30s does not cancel the order — it just means Num stops
 * watching while an airline issues a ticket nobody knows about.
 */
async function call(env, path, { method = 'GET', body = null, query = null, timeout = 130_000 } = {}) {
  const url = new URL(path, API);
  for (const [k, v] of Object.entries(query ?? {})) if (v != null) url.searchParams.set(k, String(v));

  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${env.DUFFEL_ACCESS_TOKEN}`,
      'Duffel-Version': DUFFEL_VERSION,
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify({ data: body }) } : {}),
    signal: AbortSignal.timeout(timeout),
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 800) };
  }

  if (!res.ok) {
    // Duffel returns { errors: [{ title, message, code, type }], meta: {...} }.
    // The request_id in meta is what their support asks for first, so it is
    // carried on the error rather than thrown away.
    const first = parsed?.errors?.[0];
    const err = new Error(first?.message ?? first?.title ?? `Duffel ${res.status}`);
    err.status = res.status;
    err.code = first?.code ?? null;
    err.requestId = parsed?.meta?.request_id ?? null;
    err.detail = parsed;
    throw err;
  }
  // Every successful Duffel response is enveloped in `data`. Unwrapping here
  // means no caller has to remember to.
  return parsed?.data ?? parsed;
}

// ── shopping ──────────────────────────────────────────────────────────────

/**
 * Search. Offer request in, offers out, one round trip.
 *
 * `return_offers=true` is Duffel's default and is set explicitly anyway: the
 * two-step form (create the request, then poll for offers) exists for very
 * wide searches and doubles the latency of the common case.
 *
 * `supplier_timeout` is deliberately below our own AbortSignal. Duffel waits
 * that long per airline and then returns what it has; if our socket gives up
 * first we get nothing at all instead of the six airlines that did answer.
 */
export async function searchOffers(env, { slices, passengers, cabin_class, max_connections, supplier_timeout = 20_000 } = {}) {
  if (!Array.isArray(slices) || !slices.length) {
    const err = new Error('slices required — where from, where to, what date.');
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(passengers) || !passengers.length) {
    // Duffel prices per passenger and will not guess. One adult is a
    // different fare from one adult and a lap infant.
    const err = new Error('passengers required — at least one, e.g. [{ "type": "adult" }].');
    err.status = 400;
    throw err;
  }
  return call(env, PATHS.search, {
    method: 'POST',
    query: { return_offers: 'true', supplier_timeout },
    timeout: 60_000,
    body: {
      slices: slices.map((s) => ({
        origin: s.origin,
        destination: s.destination,
        departure_date: s.departure_date ?? s.date,
        ...(s.departure_time ? { departure_time: s.departure_time } : {}),
        ...(s.arrival_time ? { arrival_time: s.arrival_time } : {}),
      })),
      passengers,
      ...(cabin_class ? { cabin_class } : {}),
      ...(max_connections != null ? { max_connections } : {}),
    },
  });
}

/** One offer, re-read. This is how you find out the price is still the price. */
export const getOffer = (env, id, { services = false } = {}) =>
  call(env, PATHS.offer(id), { query: { return_available_services: services ? 'true' : 'false' }, timeout: 30_000 });

export const getOrder = (env, id) => call(env, PATHS.order(id), { timeout: 30_000 });

/**
 * Flatten an offer into the shape the concierge and the app already read.
 *
 * Deliberately the same field names sabre.mjs#normalizeOffers produces, so a
 * caller can be handed either provider's output without a second renderer.
 * Duffel's graph is already resolved — segments are nested inside slices, not
 * referenced by id — so this is a projection, not a join.
 *
 * `expires_at` is carried because an offer has a shelf life. A price shown
 * after its expiry is not a price, it is a memory of one.
 */
export function normalizeOffers(rs) {
  const offers = Array.isArray(rs) ? rs : (rs?.offers ?? []);
  return offers.map((o) => ({
    id: o.id,
    provider: 'duffel',
    total: o.total_amount ?? null,
    currency: o.total_currency ?? null,
    base: o.base_amount ?? null,
    tax: o.tax_amount ?? null,
    owner: o.owner?.name ?? null,
    owner_iata: o.owner?.iata_code ?? null,
    expires_at: o.expires_at ?? null,
    // The airline may demand payment before Num has collected any. Hold orders
    // are only possible when this is false, so it decides which flow is even
    // available and is surfaced rather than buried.
    requires_instant_payment: o.payment_requirements?.requires_instant_payment ?? null,
    payment_required_by: o.payment_requirements?.payment_required_by ?? null,
    // Passenger ids are minted by the offer request and MUST be echoed back on
    // create-order. Losing them is the single most common way an integration
    // gets a 422 it cannot explain.
    passenger_ids: (o.passengers ?? []).map((p) => p.id),
    slices: (o.slices ?? []).map((s) => ({
      origin: s.origin?.iata_code ?? null,
      destination: s.destination?.iata_code ?? null,
      duration: s.duration ?? null,
      segments: (s.segments ?? []).map((g) => ({
        from: g.origin?.iata_code ?? null,
        to: g.destination?.iata_code ?? null,
        depart: g.departing_at ?? null,
        arrive: g.arriving_at ?? null,
        // The OPERATING carrier, not the marketing one. A traveller who booked
        // "BA" and is met by an Iberia gate agent has been misled by us.
        carrier: g.operating_carrier?.name ?? g.marketing_carrier?.name ?? null,
        flight: g.operating_carrier_flight_number ?? g.marketing_carrier_flight_number ?? null,
        aircraft: g.aircraft?.name ?? null,
        cabin: g.passengers?.[0]?.cabin_class_marketing_name ?? g.passengers?.[0]?.cabin_class ?? null,
        baggage: (g.passengers?.[0]?.baggages ?? []).map((b) => `${b.quantity}× ${b.type}`),
      })),
    })),
  }));
}

// ── committing ────────────────────────────────────────────────────────────

/**
 * Duffel's required list for an Order Request Passenger, verbatim.
 *
 * From the create-order schema, read 2026-08-18:
 *   required: ["id","given_name","family_name","gender","title","born_on",
 *              "email","phone_number"]
 * (https://duffel.com/docs/api/orders/create-order)
 *
 * `email` and `phone_number` are on that list, which means they are required on
 * EVERY passenger and not only the lead. An earlier version of this file asked
 * for them on `passengers[0]` alone; that was a guess, and it would have
 * produced a 422 on the second traveller in a party of two.
 *
 * Checked BEFORE the network so a missing date of birth reads as a missing date
 * of birth rather than as a Duffel 422 three seconds later. Every field here
 * is now a column in `num_passengers` — see worker/passengers.mjs.
 */
export const PASSENGER_FIELDS = ['id', 'given_name', 'family_name', 'gender', 'title', 'born_on', 'email', 'phone_number'];

/**
 * One stored `num_passengers` row → one Duffel Order Request Passenger.
 *
 * The single field this cannot come up with on its own is `id`. Duffel mints a
 * `pas_…` id per OFFER REQUEST and it is valid only against the offers that
 * request produced — `normalizeOffers()` surfaces them as `passenger_ids` for
 * exactly this moment. Storing one would be storing a stale id that produces a
 * 422 nobody can explain, so it is passed in and never persisted.
 *
 * `infant_passenger_id` goes on the ADULT, carrying the INFANT's Duffel id.
 * `num_passengers` stores the association the other way round (the infant
 * points at its responsible adult) because that is the direction a traveller
 * thinks in and the direction a unique index can police; the flip happens in
 * `orderPassengersFromRecords` below.
 *
 * Nothing here is invented and nothing is defaulted. If the row is short of a
 * required field the field is absent and `validateOrder` says which one — a
 * silently defaulted title is a person checking in as somebody they are not.
 */
export function passengerFromRecord(row, { id, infant_passenger_id } = {}) {
  if (!row) return null;
  const p = {
    ...(id ? { id } : {}),
    title: row.title,
    given_name: row.given_name,
    family_name: row.family_name,
    born_on: row.born_on,
    gender: row.gender,
    email: row.email,
    phone_number: row.phone_number,
  };
  if (infant_passenger_id) p.infant_passenger_id = infant_passenger_id;
  // Only the airlines that set `passenger_identity_documents_required` need
  // this, and Duffel requires all four sub-fields together or none.
  if (row.passport_number && row.passport_country && row.passport_expires_on) {
    p.identity_documents = [{
      type: 'passport',
      unique_identifier: row.passport_number,
      issuing_country_code: row.passport_country,
      expires_on: row.passport_expires_on,
    }];
  }
  return p;
}

/**
 * A whole party: stored rows plus the offer's passenger ids, in order.
 *
 * Returns `{ passengers, problems }`. It refuses to guess: if the offer was
 * priced for three passengers and two records were supplied, that is a problem
 * and not a two-passenger order, because Duffel would reject it anyway and the
 * message it returns is written for a developer.
 */
export function orderPassengersFromRecords(rows, offerPassengerIds, { finalFlightDate } = {}) {
  const problems = [];
  const list = Array.isArray(rows) ? rows : [];
  const ids = Array.isArray(offerPassengerIds) ? offerPassengerIds : [];
  if (list.length !== ids.length) {
    problems.push(`the offer was priced for ${ids.length} passenger(s) and ${list.length} record(s) were supplied.`);
    return { passengers: [], problems };
  }

  // Duffel id per stored record, positionally — the order the offer request was
  // made in is the order the ids come back in.
  const duffelIdFor = new Map(list.map((r, i) => [r.id, ids[i]]));

  const passengers = list.map((row) => {
    const infant = list.find((o) => o.travels_with_id === row.id);
    return passengerFromRecord(row, {
      id: duffelIdFor.get(row.id),
      infant_passenger_id: infant ? duffelIdFor.get(infant.id) : undefined,
    });
  });

  // Sanity, only where it is cheap and the failure is expensive: an infant with
  // no responsible adult is refused by every airline, and finding that out at
  // the airport is the worst possible time.
  if (finalFlightDate) {
    for (const row of list) {
      const type = paxTypeOn(row.born_on, finalFlightDate);
      if (type === 'infant_without_seat' && !row.travels_with_id) {
        problems.push(`${row.given_name} is an infant on the date of travel and must be linked to a responsible adult.`);
      }
      if (type && !PASSENGER_TYPES.includes(type)) problems.push(`unknown passenger type for ${row.id}.`);
    }
  }
  return { passengers, problems };
}

export function validateOrder(body) {
  const problems = [];
  const offers = body?.selected_offers;
  if (!Array.isArray(offers) || offers.length !== 1) {
    problems.push('selected_offers must be an array containing exactly one offer id.');
  }
  const pax = body?.passengers;
  if (!Array.isArray(pax) || !pax.length) {
    problems.push('passengers is required — one entry per passenger id on the offer.');
  } else {
    pax.forEach((p, i) => {
      const missing = PASSENGER_FIELDS.filter((f) => !p?.[f]);
      if (missing.length) problems.push(`passengers[${i}] is missing ${missing.join(', ')}.`);
      // Enum and format checks, so a bad record fails in Num rather than at the
      // airline. The same rules are enforced at write time in
      // worker/passengers.mjs; they are repeated here because a create-order
      // body can also be assembled by hand.
      if (p?.title && !TITLES.includes(String(p.title).toLowerCase())) {
        problems.push(`passengers[${i}].title must be one of ${TITLES.join(', ')}.`);
      }
      if (p?.gender && !GENDERS.includes(String(p.gender).toLowerCase())) {
        problems.push(`passengers[${i}].gender must be 'm' or 'f'.`);
      }
      if (p?.born_on && !/^\d{4}-\d{2}-\d{2}$/.test(String(p.born_on))) {
        problems.push(`passengers[${i}].born_on must be YYYY-MM-DD.`);
      }
      if (p?.phone_number && !String(p.phone_number).startsWith('+')) {
        problems.push(`passengers[${i}].phone_number must be E.164 — it starts with +.`);
      }
    });
  }
  const type = body?.type ?? 'instant';
  if (type === 'instant') {
    const pay = body?.payments;
    if (!Array.isArray(pay) || pay.length !== 1) {
      problems.push('An instant order needs exactly one payment, e.g. [{ "type": "balance", "amount": "…", "currency": "…" }].');
    } else if (!pay[0]?.amount || !pay[0]?.currency) {
      problems.push('payments[0] needs amount and currency, matching the offer exactly.');
    }
  } else if (type === 'hold') {
    // Duffel: "You can only use hold with offers where
    // payment_requirements.requires_instant_payment is false."
    if (body?.payments) problems.push('A hold order must not carry payments. Pay it later with the payments endpoint.');
  } else {
    problems.push(`type must be "instant" or "hold", not "${type}".`);
  }
  return problems;
}

/**
 * Create an order, with the audit row written either way.
 *
 * `idem` is not optional politeness — a retried create without it books the
 * trip twice, and the second booking is discovered by the traveller at the
 * airport. The unique index does the enforcing; a replay returns the first
 * result rather than doing it again.
 *
 * Duffel's own guidance makes this sharper than it was for Sabre: a 202 means
 * "pending confirmation" and MUST NOT be retried, and a 500 means a supplier
 * problem where an order may or may not exist. In both cases the honest move
 * is to stop and reconcile against the `order.created` webhook, not to try
 * again. So a failed create records the failure and re-throws; it never
 * silently retries.
 */
export async function createOrder(env, body, { memberId, idem, adminKey } = {}) {
  const gate = permitted(env, 'create', { adminKey });
  if (!gate.ok) {
    const err = new Error(gate.why);
    err.status = gate.status;
    throw err;
  }
  if (!idem) {
    const err = new Error('An idempotency key is required for anything that commits. Send `idem`.');
    err.status = 400;
    throw err;
  }
  const problems = validateOrder(body);
  if (problems.length) {
    const err = new Error(problems.join(' '));
    err.status = 400;
    err.problems = problems;
    throw err;
  }

  await ensure(env);
  if (env.DB) {
    const seen = await env.DB.prepare('SELECT response, ok FROM num_duffel_orders WHERE idem=?1').bind(idem).first().catch(() => null);
    // Only a SUCCESSFUL previous attempt short-circuits. Replaying after a
    // failure is the whole point of having a retry.
    if (seen?.ok) return { ...JSON.parse(seen.response || '{}'), _replayed: true };
  }

  const id = crypto.randomUUID();
  try {
    const out = await call(env, PATHS.create, { method: 'POST', body });
    await record(env, {
      id, op: 'create', tier: 'commit', memberId, idem,
      orderId: out?.id ?? null, ref: out?.booking_reference ?? null,
      body, out, ok: 1, note: null,
    });
    return out;
  } catch (err) {
    // idem is stored as NULL on failure so the unique index does not lock the
    // key out — the caller is meant to retry a 503 with the SAME key.
    await record(env, {
      id, op: 'create', tier: 'commit', memberId, idem: null,
      orderId: null, ref: null, body, out: err?.detail ?? null, ok: 0,
      note: clip(`${err?.status ?? ''} ${err?.message ?? err} ${err?.requestId ? `request_id=${err.requestId}` : ''}`.trim(), 400),
    });
    throw err;
  }
}

async function record(env, { id, op, tier, memberId, idem, orderId, ref, body, out, ok, note }) {
  if (!env.DB) return;
  await env.DB.prepare(
    `INSERT INTO num_duffel_orders (id, op, tier, member_id, idem, order_id, booking_reference, ok, request, response, note)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
  )
    .bind(
      id, op, tier, memberId ?? null, idem ?? null, orderId ?? null, ref ?? null, ok,
      JSON.stringify(redact(body)).slice(0, 8000),
      JSON.stringify(redact(out)).slice(0, 8000),
      note ?? null,
    )
    .run()
    .catch((e) => console.warn('[duffel] audit write failed', e?.message));
}

// ── routes ────────────────────────────────────────────────────────────────

/**
 * The full Duffel surface, INCLUDING the commit routes.
 *
 * worker/index.mjs does NOT route here. It routes to `handleDuffelSearch`
 * below, which serves an allowlist of three read-only paths and 404s
 * everything else — so `/order` (create) and the cancellation path are not
 * reachable from the public Worker at all, on top of being refused by
 * `permitted`. Two independent locks, because one lock that everyone believes
 * in is how live inventory gets spent by accident.
 *
 * This function stays whole so the commit path can be tested and so wiring it
 * later is a routing change rather than a rewrite. Do not point index.mjs at
 * it. worker/duffel.test.mjs drives real requests through the real Worker and
 * fails if anything ever does.
 */
export async function handleDuffel(request, env, path) {
  if (!duffelReady(env)) {
    return json(
      {
        connected: false,
        needs: 'DUFFEL_ACCESS_TOKEN',
        note: 'Duffel shops and books flights. Nothing here works without a token.',
      },
      path === '/status' ? 200 : 503,
    );
  }
  const post = request.method === 'POST';

  try {
    if (path === '/status') {
      // A real round trip, not a config-shaped health check: an offer request
      // for a route Duffel Airways always serves in test mode. Config checks
      // pass right up until the moment someone needs the thing to work.
      let auth = { ok: true };
      try {
        await searchOffers(env, {
          slices: [{ origin: 'LHR', destination: 'JFK', departure_date: probeDate() }],
          passengers: [{ type: 'adult' }],
          supplier_timeout: 5000,
        });
      } catch (err) {
        auth = { ok: false, error: err.message, status: err.status ?? null, request_id: err.requestId ?? null };
      }
      return json({
        connected: auth.ok,
        environment: duffelMode(env) === 'live' ? 'live' : 'test',
        api_version: DUFFEL_VERSION,
        ...(auth.ok ? {} : { auth }),
        capabilities: {
          search: true,
          offer: true,
          // True only when every gate would let a commit through AND the two
          // things Num does not have are configured. Reported rather than
          // assumed, so nobody reads "we have a Duffel token" as "we can book".
          create_order: permitted(env, 'create').ok,
          hold_order: permitted(env, 'create').ok,
          cancel_order: permitted(env, 'cancel', { adminKey: true }).ok,
        },
        missing: [
          ...(env.DUFFEL_BOOKING_ENABLED === 'true' ? [] : ['DUFFEL_BOOKING_ENABLED']),
          ...(duffelMode(env) === 'live' && env.DUFFEL_BOOKING_LIVE !== 'true' ? ['DUFFEL_BOOKING_LIVE'] : []),
        ],
        note:
          'Search is live. The passenger record model shipped on 2026-08-18 (worker/passengers.mjs). '
          + 'Booking still needs a funded Duffel Balance or Duffel Payments approval, and the commit route is '
          + 'deliberately not wired.',
      });
    }

    if (path === '/search' && post) {
      const rs = await searchOffers(env, await readBody(request));
      const offers = normalizeOffers(rs);
      return json({ offer_request_id: rs?.id ?? null, offers, count: offers.length });
    }

    if (path?.startsWith('/offer/')) {
      const o = await getOffer(env, path.slice('/offer/'.length));
      return json({ offer: normalizeOffers([o])[0] ?? null });
    }

    if (path?.startsWith('/order/')) {
      return json({ order: await getOrder(env, path.slice('/order/'.length)) });
    }

    if (path === '/order' && post) {
      const b = await readBody(request);
      const out = await createOrder(env, b.order ?? b, { memberId: b.member_id, idem: b.idem });
      return json({ order_id: out?.id ?? null, booking_reference: out?.booking_reference ?? null, order: out }, 201);
    }

    return json({ error: `No Duffel route for ${request.method} ${path}` }, 404);
  } catch (err) {
    return json(
      { error: err?.message ?? 'Duffel request failed', code: err?.code ?? null, request_id: err?.requestId ?? null },
      err?.status ?? 502,
    );
  }
}

/**
 * The ONLY Duffel entry point worker/index.mjs is allowed to call.
 *
 * An allowlist, not a denylist. A denylist has to be updated every time Duffel
 * grows an endpoint and is wrong in the window before somebody remembers; an
 * allowlist is wrong in the safe direction — a new route is unreachable until
 * a person adds it here on purpose.
 *
 *   GET  /status      — configuration and a real round trip. Free.
 *   POST /search      — offer request → offers. Free, holds nothing.
 *   GET  /offer/:id   — re-read one offer to see if the price is still real.
 *
 * Everything else, including POST /order, is a 404 from here. That is not the
 * same claim as "the gate would refuse it": the gate is inside
 * `createOrder`, and this is in front of the router. Both are tested.
 */
export const SEARCH_ROUTES = Object.freeze([
  'GET /status',
  'POST /search',
  'GET /offer/:id',
]);

/** Split out so a test can ask the routing question without building a Request. */
export function searchRouteAllowed(method, path) {
  const m = String(method ?? '').toUpperCase();
  if (path === '/status') return m === 'GET' || m === 'HEAD';
  if (path === '/search') return m === 'POST';
  if (typeof path === 'string' && path.startsWith('/offer/') && path.length > '/offer/'.length) return m === 'GET';
  return false;
}

export async function handleDuffelSearch(request, env, path) {
  if (!searchRouteAllowed(request.method, path)) {
    return json(
      {
        error: `No Duffel route for ${request.method} ${path}`,
        routes: SEARCH_ROUTES,
        note:
          'Only the search path is wired. Creating and cancelling orders are not routed — they spend real money and ' +
          'issue real tickets. Num now has a passenger record model (worker/passengers.mjs, shipped 2026-08-18) and ' +
          'still has no funded form of payment, no order.created webhook and no successful test booking. ' +
          'See HQ/divisions/num/DUFFEL_INTEGRATION.md § go-live gate.',
      },
      404,
    );
  }
  return handleDuffel(request, env, path);
}

/** Two weeks out — far enough that test inventory exists, near enough to be real. */
function probeDate() {
  const d = new Date(Date.now() + 14 * 86_400_000);
  return d.toISOString().slice(0, 10);
}
