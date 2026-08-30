/**
 * NUM · Duffel provider tests.
 *
 * WHAT THESE PROVE, PRECISELY:
 *   · the header set and the request bodies match Duffel's published examples
 *   · the normalizer reads a real-shaped offer correctly
 *   · every gate refuses what it is supposed to refuse, before the network
 *   · the audit row is written and is redacted
 *   · idempotency short-circuits a replay and does NOT short-circuit a failure
 *
 * WHAT THEY DO NOT PROVE:
 *   that Duffel accepts any of it. There is no token. `globalThis.fetch` below
 *   is a stub built from the response bodies in Duffel's own documentation, so
 *   a green run here means "the code does what the docs describe", not
 *   "a booking works". Nothing in this file has ever spoken to api.duffel.com.
 *
 *   node --test worker/duffel.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  duffelReady, duffelMode, permitted, OPS,
  searchOffers, getOffer, createOrder, normalizeOffers, validateOrder, redact,
  handleDuffel,
} from './duffel.mjs';

// ── recorded responses, from Duffel's documented examples ─────────────────
// https://duffel.com/docs/api/offer-requests/create-offer-request
// https://duffel.com/docs/api/v2/offers/get-offer-by-id
// https://duffel.com/docs/api/orders/create-order

const OFFER = {
  id: 'off_00009htyDGjIfajdNBZRlw',
  total_amount: '45.00',
  total_currency: 'GBP',
  base_amount: '30.20',
  tax_amount: '14.80',
  expires_at: '2026-09-02T05:56:43.954Z',
  owner: { name: 'Duffel Airways', iata_code: 'ZZ' },
  payment_requirements: { requires_instant_payment: false, payment_required_by: '2026-09-01T17:00:00Z' },
  passengers: [{ id: 'pas_00009hj8USM7Ncg31cBCLL', type: 'adult' }],
  slices: [
    {
      duration: 'PT7H31M',
      origin: { iata_code: 'LHR' },
      destination: { iata_code: 'JFK' },
      segments: [
        {
          origin: { iata_code: 'LHR' },
          destination: { iata_code: 'JFK' },
          departing_at: '2026-09-15T09:45:00',
          arriving_at: '2026-09-15T12:16:00',
          marketing_carrier: { name: 'British Airways', iata_code: 'BA' },
          operating_carrier: { name: 'Duffel Airways', iata_code: 'ZZ' },
          marketing_carrier_flight_number: '1234',
          operating_carrier_flight_number: '9876',
          aircraft: { name: 'Boeing 747' },
          passengers: [
            {
              cabin_class: 'economy',
              cabin_class_marketing_name: 'Economy Basic',
              baggages: [{ type: 'checked', quantity: 1 }, { type: 'carry_on', quantity: 1 }],
            },
          ],
        },
      ],
    },
  ],
};

const OFFER_REQUEST = {
  id: 'orq_00009hjdomFOCJyxHG7k7k',
  created_at: '2026-08-18T05:56:43.954Z',
  live_mode: false,
  client_key: 'eyJhbGciOi.SECRET.TOKEN',
  slices: [{ origin: { iata_code: 'LHR' }, destination: { iata_code: 'JFK' }, departure_date: '2026-09-15' }],
  passengers: [{ id: 'pas_00009hj8USM7Ncg31cBCLL', type: 'adult' }],
  offers: [OFFER],
};

const ORDER = {
  id: 'ord_00009hthhsUZ8W4LxQgkjo',
  booking_reference: 'RZPNX8',
  live_mode: false,
  total_amount: '45.00',
  total_currency: 'GBP',
  documents: [{ type: 'electronic_ticket', unique_identifier: '0125340999999' }],
  passengers: [{ id: 'pas_00009hj8USM7Ncg31cBCLL', given_name: 'Amelia', family_name: 'Earhart', born_on: '1987-07-24' }],
  slices: OFFER.slices,
};

const DUFFEL_ERROR = {
  errors: [{ type: 'validation_error', title: 'Invalid passenger', message: 'Passenger id was not found on this offer', code: 'validation_required' }],
  meta: { request_id: 'FZPNX8abcdef', status: 422 },
};

// ── the fetch stub ────────────────────────────────────────────────────────

/** Every request the code made, so a test can assert on headers and body. */
let sent = [];
/** Flip to make the next create fail the way Duffel fails. */
let createFails = null;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (!target.startsWith('https://api.duffel.com/')) {
    throw new Error(`unexpected fetch — the only network this test allows is Duffel: ${target}`);
  }
  sent.push({ url: target, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });

  const path = new URL(target).pathname;
  const ok = (data, status = 200) => new Response(JSON.stringify({ data }), { status });

  if (path === '/air/offer_requests') return ok(OFFER_REQUEST, 201);
  if (path.startsWith('/air/offers/')) return ok(OFFER);
  if (path.startsWith('/air/orders/')) return ok(ORDER);
  if (path === '/air/orders') {
    if (createFails) return new Response(JSON.stringify(DUFFEL_ERROR), { status: createFails });
    return ok(ORDER, 201);
  }
  return new Response(JSON.stringify({ errors: [{ title: 'Not found' }] }), { status: 404 });
};
test.after(() => { globalThis.fetch = realFetch; });

// ── a D1 stand-in, enough for the audit table ────────────────────────────
function fakeDB() {
  const rows = [];
  const db = {
    rows,
    batch: async () => [],
    prepare(sql) {
      const st = {
        _b: [],
        bind(...a) { st._b = a; return st; },
        async run() {
          if (/INSERT INTO num_duffel_orders/.test(sql)) rows.push(st._b);
          return { success: true };
        },
        async first() {
          if (/SELECT response, ok FROM num_duffel_orders/.test(sql)) {
            const hit = rows.find((r) => r[4] === st._b[0] && r[7] === 1);
            return hit ? { response: hit[9], ok: 1 } : null;
          }
          return null;
        },
      };
      return st;
    },
  };
  return db;
}

const TEST_ENV = { DUFFEL_ACCESS_TOKEN: 'duffel_test_abc123' };
const LIVE_ENV = { DUFFEL_ACCESS_TOKEN: 'duffel_live_abc123' };

// ── readiness and mode ───────────────────────────────────────────────────

test('duffelReady mirrors sabreReady: one env var, asked before anything runs', () => {
  assert.equal(duffelReady({}), false);
  assert.equal(duffelReady({ DUFFEL_ACCESS_TOKEN: '' }), false);
  assert.equal(duffelReady(TEST_ENV), true);
});

test('the environment is read off the token, so config cannot disagree with it', () => {
  assert.equal(duffelMode({}), null);
  assert.equal(duffelMode(TEST_ENV), 'test');
  assert.equal(duffelMode(LIVE_ENV), 'live');
});

// ── the request shape ────────────────────────────────────────────────────

test('every request carries the four headers Duffel documents as required', async () => {
  sent = [];
  await searchOffers(TEST_ENV, {
    slices: [{ origin: 'LHR', destination: 'JFK', departure_date: '2026-09-15' }],
    passengers: [{ type: 'adult' }],
  });
  const h = sent[0].headers;
  assert.equal(h.Authorization, 'Bearer duffel_test_abc123');
  assert.equal(h['Duffel-Version'], 'v2');
  assert.equal(h.Accept, 'application/json');
  assert.equal(h['Content-Type'], 'application/json');
  assert.equal(h['Accept-Encoding'], 'gzip');
});

test('the offer request body matches Duffel’s documented example', async () => {
  sent = [];
  await searchOffers(TEST_ENV, {
    slices: [{ origin: 'LHR', destination: 'JFK', departure_date: '2026-09-15' }],
    passengers: [{ type: 'adult' }],
    cabin_class: 'economy',
    max_connections: 0,
  });
  const req = sent[0];
  assert.equal(req.method, 'POST');
  assert.match(req.url, /^https:\/\/api\.duffel\.com\/air\/offer_requests\?/);
  // Everything Duffel takes as a QUERY parameter must not be in the body.
  const q = new URL(req.url).searchParams;
  assert.equal(q.get('return_offers'), 'true');
  assert.equal(q.get('supplier_timeout'), '20000');
  // And the body is enveloped in `data`, which is not optional.
  assert.deepEqual(req.body, {
    data: {
      slices: [{ origin: 'LHR', destination: 'JFK', departure_date: '2026-09-15' }],
      passengers: [{ type: 'adult' }],
      cabin_class: 'economy',
      max_connections: 0,
    },
  });
});

test('a search with no slices or no passengers fails here, not at Duffel', async () => {
  await assert.rejects(() => searchOffers(TEST_ENV, { passengers: [{ type: 'adult' }] }), /slices required/);
  await assert.rejects(
    () => searchOffers(TEST_ENV, { slices: [{ origin: 'LHR', destination: 'JFK', departure_date: '2026-09-15' }] }),
    /passengers required/,
  );
});

test('getOffer hits the documented path and passes return_available_services', async () => {
  sent = [];
  await getOffer(TEST_ENV, 'off_00009htyDGjIfajdNBZRlw', { services: true });
  assert.equal(new URL(sent[0].url).pathname, '/air/offers/off_00009htyDGjIfajdNBZRlw');
  assert.equal(new URL(sent[0].url).searchParams.get('return_available_services'), 'true');
});

// ── the normalizer ───────────────────────────────────────────────────────

test('an offer normalizes to the shape sabre.mjs already produces', async () => {
  const rs = await searchOffers(TEST_ENV, {
    slices: [{ origin: 'LHR', destination: 'JFK', departure_date: '2026-09-15' }],
    passengers: [{ type: 'adult' }],
  });
  const [o] = normalizeOffers(rs);
  assert.equal(o.id, 'off_00009htyDGjIfajdNBZRlw');
  assert.equal(o.provider, 'duffel');
  assert.equal(o.total, '45.00');
  assert.equal(o.currency, 'GBP');
  assert.equal(o.owner, 'Duffel Airways');
  assert.equal(o.owner_iata, 'ZZ');
  assert.equal(o.expires_at, '2026-09-02T05:56:43.954Z');
  assert.equal(o.requires_instant_payment, false);
  assert.deepEqual(o.passenger_ids, ['pas_00009hj8USM7Ncg31cBCLL']);
  assert.equal(o.slices[0].origin, 'LHR');
  assert.equal(o.slices[0].destination, 'JFK');
  const seg = o.slices[0].segments[0];
  // The OPERATING carrier wins. A traveller told "British Airways" who is met
  // by a Duffel Airways gate agent has been misled by us.
  assert.equal(seg.carrier, 'Duffel Airways');
  assert.equal(seg.flight, '9876');
  assert.equal(seg.cabin, 'Economy Basic');
  assert.deepEqual(seg.baggage, ['1× checked', '1× carry_on']);
});

test('normalizeOffers survives a sparse offer without inventing fields', () => {
  const [o] = normalizeOffers([{ id: 'off_x', slices: [] }]);
  assert.equal(o.total, null);
  assert.equal(o.owner, null);
  assert.equal(o.requires_instant_payment, null);
  assert.deepEqual(o.passenger_ids, []);
  assert.deepEqual(o.slices, []);
});

// ── the gates ────────────────────────────────────────────────────────────

test('read operations need only a token; commits need the switch', () => {
  assert.equal(permitted({}, 'search').ok, false);
  assert.equal(permitted(TEST_ENV, 'search').ok, true);
  assert.equal(permitted(TEST_ENV, 'offer').ok, true);

  const g = permitted(TEST_ENV, 'create');
  assert.equal(g.ok, false);
  assert.match(g.why, /DUFFEL_BOOKING_ENABLED/);
  assert.equal(g.status, 403);

  assert.equal(permitted({ ...TEST_ENV, DUFFEL_BOOKING_ENABLED: 'true' }, 'create').ok, true);
});

test('a live token alone is not enough to commit — the second key is required', () => {
  const g = permitted({ ...LIVE_ENV, DUFFEL_BOOKING_ENABLED: 'true' }, 'create');
  assert.equal(g.ok, false);
  assert.match(g.why, /DUFFEL_BOOKING_LIVE/);
  assert.equal(
    permitted({ ...LIVE_ENV, DUFFEL_BOOKING_ENABLED: 'true', DUFFEL_BOOKING_LIVE: 'true' }, 'create').ok,
    true,
  );
});

test('money-tier operations are unreachable without the admin key', () => {
  const env = { ...TEST_ENV, DUFFEL_BOOKING_ENABLED: 'true' };
  assert.equal(permitted(env, 'cancel').ok, false);
  assert.equal(permitted(env, 'cancel').status, 401);
  assert.equal(permitted(env, 'cancel', { adminKey: true }).ok, true);
  assert.equal(OPS.cancel.tier, 'money');
});

test('an unknown operation is a 404, not a silent allow', () => {
  assert.equal(permitted(TEST_ENV, 'wire_money_to_me').ok, false);
  assert.equal(permitted(TEST_ENV, 'wire_money_to_me').status, 404);
});

// ── what create-order needs that Num does not have ───────────────────────

test('validateOrder names every field Num cannot supply today', () => {
  const problems = validateOrder({
    selected_offers: ['off_00009htyDGjIfajdNBZRlw'],
    // A num_members row is exactly this much: an id, a name, a phone.
    passengers: [{ id: 'pas_00009hj8USM7Ncg31cBCLL', given_name: 'Viv', family_name: 'Chen', phone_number: '+66824234437' }],
    payments: [{ type: 'balance', amount: '45.00', currency: 'GBP' }],
  });
  const joined = problems.join(' ');
  assert.match(joined, /born_on/);
  assert.match(joined, /gender/);
  assert.match(joined, /title/);
  assert.match(joined, /email/);
});

test('validateOrder accepts a complete instant order', () => {
  assert.deepEqual(
    validateOrder({
      selected_offers: ['off_1'],
      type: 'instant',
      passengers: [{
        id: 'pas_1', given_name: 'Amelia', family_name: 'Earhart', born_on: '1987-07-24',
        gender: 'f', title: 'mrs', email: 'amelia@example.com', phone_number: '+442080160509',
      }],
      payments: [{ type: 'balance', amount: '45.00', currency: 'GBP' }],
    }),
    [],
  );
});

test('a hold order must not carry a payment, and an instant order must', () => {
  const pax = [{
    id: 'pas_1', given_name: 'A', family_name: 'E', born_on: '1987-07-24',
    gender: 'f', title: 'mrs', email: 'a@e.com', phone_number: '+442080160509',
  }];
  assert.deepEqual(validateOrder({ selected_offers: ['off_1'], type: 'hold', passengers: pax }), []);
  assert.match(
    validateOrder({ selected_offers: ['off_1'], type: 'hold', passengers: pax, payments: [{ type: 'balance' }] }).join(' '),
    /must not carry payments/,
  );
  assert.match(
    validateOrder({ selected_offers: ['off_1'], type: 'instant', passengers: pax }).join(' '),
    /needs exactly one payment/,
  );
});

test('exactly one offer per order — two is a Duffel 422 we can refuse first', () => {
  assert.match(validateOrder({ selected_offers: ['a', 'b'], passengers: [] }).join(' '), /exactly one offer id/);
});

// ── committing ───────────────────────────────────────────────────────────

const GOOD_ORDER = {
  selected_offers: ['off_00009htyDGjIfajdNBZRlw'],
  type: 'instant',
  passengers: [{
    id: 'pas_00009hj8USM7Ncg31cBCLL', given_name: 'Amelia', family_name: 'Earhart', born_on: '1987-07-24',
    gender: 'f', title: 'mrs', email: 'amelia@example.com', phone_number: '+442080160509',
  }],
  payments: [{ type: 'balance', amount: '45.00', currency: 'GBP' }],
};

test('createOrder refuses before the network when the switch is off', async () => {
  sent = [];
  await assert.rejects(
    () => createOrder(TEST_ENV, GOOD_ORDER, { idem: 'k1' }),
    /Booking is switched off/,
  );
  assert.equal(sent.length, 0, 'the gate must fire before any HTTP call');
});

test('createOrder refuses without an idempotency key', async () => {
  sent = [];
  await assert.rejects(
    () => createOrder({ ...TEST_ENV, DUFFEL_BOOKING_ENABLED: 'true' }, GOOD_ORDER, {}),
    /idempotency key is required/,
  );
  assert.equal(sent.length, 0);
});

test('createOrder posts the documented body and returns the booking reference', async () => {
  sent = [];
  createFails = null;
  const env = { ...TEST_ENV, DUFFEL_BOOKING_ENABLED: 'true', DB: fakeDB() };
  const out = await createOrder(env, GOOD_ORDER, { memberId: 'mem_1', idem: 'idem-abc' });
  assert.equal(out.booking_reference, 'RZPNX8');
  assert.equal(out.id, 'ord_00009hthhsUZ8W4LxQgkjo');
  assert.equal(new URL(sent[0].url).pathname, '/air/orders');
  assert.deepEqual(sent[0].body, { data: GOOD_ORDER });
  assert.equal(env.DB.rows.length, 1, 'an audit row is written on success');
  assert.equal(env.DB.rows[0][6], 'RZPNX8');
});

test('a replay with the same key returns the first result and does not book twice', async () => {
  sent = [];
  const env = { ...TEST_ENV, DUFFEL_BOOKING_ENABLED: 'true', DB: fakeDB() };
  await createOrder(env, GOOD_ORDER, { idem: 'idem-replay' });
  const calls = sent.length;
  const again = await createOrder(env, GOOD_ORDER, { idem: 'idem-replay' });
  assert.equal(again._replayed, true);
  assert.equal(sent.length, calls, 'the replay must not reach Duffel');
});

test('a FAILED create does not lock the key — the retry is the whole point', async () => {
  sent = [];
  const env = { ...TEST_ENV, DUFFEL_BOOKING_ENABLED: 'true', DB: fakeDB() };
  createFails = 503;
  await assert.rejects(() => createOrder(env, GOOD_ORDER, { idem: 'idem-retry' }), /Passenger id was not found/);
  assert.equal(env.DB.rows[0][7], 0, 'the failure is recorded');
  assert.equal(env.DB.rows[0][4], null, 'with a NULL idem, so the same key can be retried');
  createFails = null;
  const out = await createOrder(env, GOOD_ORDER, { idem: 'idem-retry' });
  assert.equal(out.booking_reference, 'RZPNX8');
});

test('a Duffel error carries its request_id, which is what their support asks for', async () => {
  const env = { ...TEST_ENV, DUFFEL_BOOKING_ENABLED: 'true', DB: fakeDB() };
  createFails = 422;
  await createOrder(env, GOOD_ORDER, { idem: 'idem-422' }).then(
    () => assert.fail('should have thrown'),
    (err) => {
      assert.equal(err.status, 422);
      assert.equal(err.code, 'validation_required');
      assert.equal(err.requestId, 'FZPNX8abcdef');
    },
  );
  createFails = null;
});

// ── audit hygiene ────────────────────────────────────────────────────────

// CHANGED 2026-08-18, with the passenger record model.
//
// This test used to end `assert.equal(out.passengers[0].given_name, 'Amelia')`
// — "non-sensitive fields survive, or the audit row is useless". That was a
// defensible line when no create-order body could ever be assembled, because a
// given name with nothing attached to it is a given name. It stopped being
// defensible the moment `num_passengers` existed: the audit row now sits next
// to a family name, a date of birth and a gender marker for the same person,
// and a first name beside a redacted DOB in the same object re-identifies it.
// So the legal name is redacted too, and the audit row keeps what it is
// actually for — which operation ran, whether it succeeded, the order id and
// the booking reference. Those are asserted elsewhere in this file.
test('the audit redactor removes tokens, cards, dates of birth, ticket numbers and the legal name', () => {
  const out = redact({
    Authorization: 'Bearer duffel_live_secret',
    client_key: 'eyJhbGciOi.SECRET',
    payments: [{ card_number: '4111111111111111', cvc: '123' }],
    passengers: [{ born_on: '1987-07-24', given_name: 'Amelia' }],
    documents: [{ unique_identifier: '0125340999999' }],
  });
  assert.equal(out.Authorization, '<redacted>');
  assert.equal(out.client_key, '<redacted>');
  assert.equal(out.payments[0].card_number, '<redacted>');
  assert.equal(out.payments[0].cvc, '<redacted>');
  assert.equal(out.passengers[0].born_on, '<redacted>');
  assert.equal(out.documents[0].unique_identifier, '<redacted>');
  // The legal name goes the same way as the date of birth beside it.
  assert.equal(out.passengers[0].given_name, '<redacted>');
});

test('the audit row keeps what it is for — the operation, not the person', () => {
  const out = redact({
    selected_offers: ['off_00009htyDGjIfajdNBZRlw'],
    type: 'instant',
    passengers: [{ id: 'pas_00009hj8USM7Ncg31cBCLL', given_name: 'Amelia', family_name: 'Earhart', born_on: '1987-07-24', gender: 'f', title: 'mrs' }],
  });
  // What survives: the offer, the order type, the Duffel passenger handle.
  assert.deepEqual(out.selected_offers, ['off_00009htyDGjIfajdNBZRlw']);
  assert.equal(out.type, 'instant');
  assert.equal(out.passengers[0].id, 'pas_00009hj8USM7Ncg31cBCLL');
  // What does not: every field that describes the human being.
  for (const f of ['given_name', 'family_name', 'born_on', 'gender', 'title']) {
    assert.equal(out.passengers[0][f], '<redacted>', `${f} reached the audit row in the clear`);
  }
});

test('a bare 16-digit number anywhere in the payload is redacted too', () => {
  assert.match(JSON.stringify(redact({ note: 'paid with 4111111111111111' })), /redacted-number/);
});

// ── the (unwired) router ─────────────────────────────────────────────────

test('/status without a token is a 200 that says so, not a mystery 503', async () => {
  const res = await handleDuffel(new Request('https://app.itsnum.com/api/duffel/status'), {}, '/status');
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.connected, false);
  assert.equal(b.needs, 'DUFFEL_ACCESS_TOKEN');
});

test('any other route without a token is a 503', async () => {
  const res = await handleDuffel(new Request('https://app.itsnum.com/api/duffel/search', { method: 'POST' }), {}, '/search');
  assert.equal(res.status, 503);
});

test('/status reports create_order:false while the switch is off, with the reason', async () => {
  const res = await handleDuffel(new Request('https://app.itsnum.com/api/duffel/status'), TEST_ENV, '/status');
  const b = await res.json();
  assert.equal(b.connected, true);
  assert.equal(b.environment, 'test');
  assert.equal(b.api_version, 'v2');
  assert.equal(b.capabilities.search, true);
  assert.equal(b.capabilities.create_order, false);
  assert.deepEqual(b.missing, ['DUFFEL_BOOKING_ENABLED']);
  // CHANGED 2026-08-18: the passenger record model shipped, so /status no
  // longer claims it is missing. The payment is still missing and still said.
  assert.match(b.note, /passenger record model shipped/);
  assert.match(b.note, /funded Duffel Balance or Duffel Payments/);
});

test('/search returns normalized offers', async () => {
  const req = new Request('https://app.itsnum.com/api/duffel/search', {
    method: 'POST',
    body: JSON.stringify({
      slices: [{ origin: 'LHR', destination: 'JFK', departure_date: '2026-09-15' }],
      passengers: [{ type: 'adult' }],
    }),
  });
  const b = await (await handleDuffel(req, TEST_ENV, '/search')).json();
  assert.equal(b.count, 1);
  assert.equal(b.offer_request_id, 'orq_00009hjdomFOCJyxHG7k7k');
  assert.equal(b.offers[0].total, '45.00');
});

test('the router turns a gate refusal into its own status code, not a 500', async () => {
  const req = new Request('https://app.itsnum.com/api/duffel/order', {
    method: 'POST',
    body: JSON.stringify({ idem: 'k', order: GOOD_ORDER }),
  });
  const res = await handleDuffel(req, TEST_ENV, '/order');
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Booking is switched off/);
});

// ═════════════════════════════════════════════════════════════════════════
// PART TWO — the wiring.
//
// Everything above this line tests duffel.mjs in isolation against recorded
// responses. Everything below drives REAL Requests through the REAL Worker
// (worker/index.mjs), because the question these answer is not "does the
// module behave" but "can a request from the internet reach it, and can a
// request from the internet reach the part that spends money".
//
// This is the bookdesk.wiring.test.mjs lesson applied before the bug rather
// than after it: a regex over index.mjs would have found the string
// '/api/booking' on the exact day that route was dead. So no regexes. The
// router either answers or it does not.
//
// `duffel_live_FAKE_FOR_TEST` is the only "live" token that appears anywhere
// in this repo. A real one lives in Wrangler and nowhere else.
// ═════════════════════════════════════════════════════════════════════════
import worker from './index.mjs';
import { duffelCommitState, duffelCapability, searchRouteAllowed, SEARCH_ROUTES } from './duffel.mjs';

const FAKE_LIVE = 'duffel_live_FAKE_FOR_TEST';
const LIVE_FAKE_ENV = { DUFFEL_ACCESS_TOKEN: FAKE_LIVE };

// index.mjs runs one per-IP limiter in front of every POST /api/*, and a suite
// firing a dozen POSTs in a second from one address gets throttled by it —
// which is the limiter working, not the route failing. One caller per request.
let caller = 0;
const nextIp = () => `203.0.113.${(caller++ % 250) + 1}`;

const hit = (path, env, init) =>
  worker.fetch(
    new Request(`https://app.itsnum.com${path}`, {
      ...init,
      headers: {
        'CF-Connecting-IP': nextIp(),
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    }),
    env,
    { waitUntil: () => {} },
  );

const read = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) });

const SEARCH_BODY = {
  slices: [{ origin: 'LHR', destination: 'JFK', departure_date: '2026-09-15' }],
  passengers: [{ type: 'adult' }],
};

// ── the search path is actually reachable ────────────────────────────────

test('WIRING: POST /api/duffel/search reaches Duffel and returns normalized offers', async () => {
  sent = [];
  const { status, body } = await read(
    await hit('/api/duffel/search', TEST_ENV, { method: 'POST', body: JSON.stringify(SEARCH_BODY) }),
  );
  assert.equal(status, 200, 'the search route is not reachable through the real router');
  assert.equal(body.count, 1);
  assert.equal(body.offers[0].provider, 'duffel', 'the offer does not say which provider priced it');
  assert.equal(body.offers[0].total, '45.00');
  assert.equal(new URL(sent[0].url).pathname, '/air/offer_requests', 'the router did not actually call the offer-request endpoint');
});

test('WIRING: GET /api/duffel/status answers through the router', async () => {
  const { status, body } = await read(await hit('/api/duffel/status', TEST_ENV));
  assert.equal(status, 200);
  assert.equal(body.environment, 'test');
  assert.equal(body.capabilities.search, true);
  assert.equal(body.capabilities.create_order, false, '/status claims a commit capability the gate does not grant');
});

test('WIRING: GET /api/duffel/offer/:id re-reads one offer through the router', async () => {
  const { status, body } = await read(await hit('/api/duffel/offer/off_00009htyDGjIfajdNBZRlw', TEST_ENV));
  assert.equal(status, 200);
  assert.equal(body.offer.id, 'off_00009htyDGjIfajdNBZRlw');
});

test('WIRING: with no token the search route is a 503, not a 404 or a 500', async () => {
  const { status, body } = await read(await hit('/api/duffel/search', {}, { method: 'POST', body: JSON.stringify(SEARCH_BODY) }));
  assert.equal(status, 503);
  assert.equal(body.needs, 'DUFFEL_ACCESS_TOKEN');
});

// ── the commit path is NOT reachable, and that is asserted, not commented ─

test('WIRING: POST /api/duffel/order is a 404 even with EVERY gate open', async () => {
  // The strongest form of the claim. This env would let `createOrder` run:
  // live token, booking enabled, live commits allowed. If the commit path were
  // routed at all, this request would create a real order. It must not exist.
  sent = [];
  const wideOpen = { ...LIVE_FAKE_ENV, DUFFEL_BOOKING_ENABLED: 'true', DUFFEL_BOOKING_LIVE: 'true', DB: fakeDB() };
  const { status, body } = await read(
    await hit('/api/duffel/order', wideOpen, { method: 'POST', body: JSON.stringify({ idem: 'k', order: GOOD_ORDER }) }),
  );
  assert.equal(status, 404, 'the ORDER CREATION path is routed — this books flights with real money');
  assert.deepEqual(body.routes, SEARCH_ROUTES);
  assert.equal(
    sent.filter((r) => new URL(r.url).pathname === '/air/orders').length, 0,
    'a request reached Duffel’s order endpoint through the public router',
  );
  assert.equal(wideOpen.DB.rows.length, 0, 'an order audit row was written — something committed');
});

test('WIRING: no cancellation path is reachable under any spelling', async () => {
  sent = [];
  const wideOpen = { ...LIVE_FAKE_ENV, DUFFEL_BOOKING_ENABLED: 'true', DUFFEL_BOOKING_LIVE: 'true', DB: fakeDB() };
  for (const path of ['/api/duffel/cancel', '/api/duffel/order_cancellations', '/api/duffel/orders/ord_1/cancel']) {
    const res = await hit(path, wideOpen, { method: 'POST', body: '{}' });
    assert.equal(res.status, 404, `${path} is routed — cancellation moves money that has already moved`);
  }
  assert.equal(sent.length, 0, 'a cancellation attempt reached the network');
});

test('WIRING: reading an existing order is not routed either', async () => {
  // Harmless in itself, but there are no orders to read and every route that
  // exists is a route somebody can be talked into using. Allowlist, not
  // denylist: this comes back when a person adds it on purpose.
  const res = await hit('/api/duffel/order/ord_00009hthhsUZ8W4LxQgkjo', TEST_ENV);
  assert.equal(res.status, 404);
});

test('the route allowlist admits exactly three things and refuses the rest', () => {
  assert.equal(searchRouteAllowed('GET', '/status'), true);
  assert.equal(searchRouteAllowed('POST', '/search'), true);
  assert.equal(searchRouteAllowed('GET', '/offer/off_1'), true);

  assert.equal(searchRouteAllowed('POST', '/order'), false);
  assert.equal(searchRouteAllowed('GET', '/order/ord_1'), false);
  assert.equal(searchRouteAllowed('POST', '/cancel'), false);
  assert.equal(searchRouteAllowed('POST', '/offer/off_1'), false, 'a POST to an offer id is not a read');
  assert.equal(searchRouteAllowed('GET', '/offer/'), false, 'an empty offer id is not an offer id');
  assert.equal(searchRouteAllowed('GET', '/'), false);
  assert.equal(searchRouteAllowed('GET', '/search'), false, 'a search is a POST — a GET here would silently do nothing');
});

// ── the version flag, in all three states ────────────────────────────────

const versionBody = async (env) => (await read(await hit('/api/version', env))).body;

test('VERSION: no token → search false, estate null, commit "no_token"', async () => {
  const b = await versionBody({});
  assert.deepEqual(b.connected.duffel, { search: false, estate: null, commit: 'no_token' });
});

test('VERSION: token present but commit locked → the flag says locked, not false', async () => {
  // "locked" and "no_token" are different problems with different fixes, and a
  // single boolean cannot tell them apart. Whoever reads this flag is deciding
  // whether it is safe to ship.
  const b = await versionBody(TEST_ENV);
  assert.deepEqual(b.connected.duffel, { search: true, estate: 'test', commit: 'locked' });

  const live = await versionBody(LIVE_FAKE_ENV);
  assert.deepEqual(live.connected.duffel, { search: true, estate: 'live', commit: 'locked' },
    'a bare live token reports something other than locked — the two-key rule is not being reported');

  const oneKey = await versionBody({ ...LIVE_FAKE_ENV, DUFFEL_BOOKING_ENABLED: 'true' });
  assert.equal(oneKey.connected.duffel.commit, 'locked', 'one of the two keys reported as commit-live');
});

test('VERSION: both keys on a live token → commit "live", and it says the estate is live', async () => {
  const b = await versionBody({ ...LIVE_FAKE_ENV, DUFFEL_BOOKING_ENABLED: 'true', DUFFEL_BOOKING_LIVE: 'true' });
  assert.deepEqual(b.connected.duffel, { search: true, estate: 'live', commit: 'live' });
});

test('VERSION: the existing booking and flight_shopping flags are untouched', async () => {
  // Duffel was added ALONGSIDE Sabre, not over it. If wiring Duffel changed
  // what Sabre's flags say, something downstream that reads them is now wrong.
  const b = await versionBody({ ...TEST_ENV, SABRE_CLIENT_ID: 'id', SABRE_CLIENT_SECRET: 'secret' });
  assert.equal(b.connected.flight_shopping, true, 'Sabre shopping stopped being reported');
  assert.equal(b.connected.booking, false, 'the Sabre booking flag moved when Duffel was wired');

  const noSabre = await versionBody(TEST_ENV);
  assert.equal(noSabre.connected.flight_shopping, false,
    'flight_shopping reports true with no Sabre credentials — Duffel is being counted as Sabre');
});

test('VERSION: the response never contains the token, in any state', async () => {
  for (const env of [TEST_ENV, LIVE_FAKE_ENV, { ...LIVE_FAKE_ENV, DUFFEL_BOOKING_ENABLED: 'true', DUFFEL_BOOKING_LIVE: 'true' }]) {
    const text = JSON.stringify(await versionBody(env));
    assert.doesNotMatch(text, /duffel_(test|live)_/, 'the access token is being served on a public endpoint');
  }
});

// ── the two-key rule, exhaustively, on a simulated LIVE token ────────────
//
// The whole point of the second key is that a live credential alone must not
// be enough. Each row below is a way somebody could half-configure this, and
// every one of them must refuse.

const KEY_MATRIX = [
  { name: 'neither key set', env: {}, expect: /Booking is switched off/ },
  { name: 'only DUFFEL_BOOKING_ENABLED set', env: { DUFFEL_BOOKING_ENABLED: 'true' }, expect: /DUFFEL_BOOKING_LIVE is not true/ },
  { name: 'only DUFFEL_BOOKING_LIVE set', env: { DUFFEL_BOOKING_LIVE: 'true' }, expect: /Booking is switched off/ },
  { name: 'ENABLED set to something that is not "true"', env: { DUFFEL_BOOKING_ENABLED: '1', DUFFEL_BOOKING_LIVE: 'true' }, expect: /Booking is switched off/ },
  { name: 'LIVE set to something that is not "true"', env: { DUFFEL_BOOKING_ENABLED: 'true', DUFFEL_BOOKING_LIVE: 'yes' }, expect: /DUFFEL_BOOKING_LIVE is not true/ },
];

for (const row of KEY_MATRIX) {
  test(`LIVE TOKEN + ${row.name} → permitted() refuses the commit`, () => {
    const env = { ...LIVE_FAKE_ENV, ...row.env };
    const gate = permitted(env, 'create');
    assert.equal(gate.ok, false, `a create is permitted with ${row.name}`);
    assert.equal(gate.status, 403);
    assert.match(gate.why, row.expect);
    assert.equal(duffelCommitState(env), 'locked');
    assert.equal(duffelCapability(env).commit, 'locked');
  });

  test(`LIVE TOKEN + ${row.name} → createOrder throws BEFORE any network call`, async () => {
    sent = [];
    const env = { ...LIVE_FAKE_ENV, ...row.env, DB: fakeDB() };
    await assert.rejects(
      () => createOrder(env, GOOD_ORDER, { idem: 'live-should-never-run' }),
      (err) => err.status === 403 && row.expect.test(err.message),
    );
    assert.equal(sent.length, 0, `a live-mode create reached the network with ${row.name}`);
    assert.equal(env.DB.rows.length, 0, 'a commit audit row exists for a request that was supposed to be refused');
  });
}

test('LIVE TOKEN + both keys → the gate opens (so the refusals above mean something)', () => {
  // A refusal test suite that would pass with `permitted` hard-coded to false
  // proves nothing. This is the control.
  const env = { ...LIVE_FAKE_ENV, DUFFEL_BOOKING_ENABLED: 'true', DUFFEL_BOOKING_LIVE: 'true' };
  assert.equal(permitted(env, 'create').ok, true);
  assert.equal(duffelCommitState(env), 'live');
});

test('a TEST token does not need the second key — it guards live inventory only', () => {
  // DUFFEL_BOOKING_LIVE exists to stop a LIVE commit. Requiring it in test mode
  // would train whoever is testing to set it, which is exactly how it ends up
  // set in production.
  const env = { ...TEST_ENV, DUFFEL_BOOKING_ENABLED: 'true' };
  assert.equal(permitted(env, 'create').ok, true);
  assert.equal(duffelCommitState(env), 'live');
  assert.equal(duffelCapability(env).estate, 'test');
});

test('cancel stays money-tier and admin-keyed even with a live token and both keys', () => {
  const env = { ...LIVE_FAKE_ENV, DUFFEL_BOOKING_ENABLED: 'true', DUFFEL_BOOKING_LIVE: 'true' };
  assert.equal(permitted(env, 'cancel').ok, false);
  assert.equal(permitted(env, 'cancel').status, 401);
  assert.equal(permitted(env, 'cancel', { adminKey: true }).ok, true);
  assert.equal(OPS.cancel.tier, 'money');
});
