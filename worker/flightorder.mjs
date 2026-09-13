/**
 * THE BOOKING THAT WAS BUILT AND NEVER CONNECTED.
 *
 * ── WHAT WAS ALREADY HERE ────────────────────────────────────────────────
 *
 * By 13 Sep 2026 Num had, written and under test:
 *
 *   flightbooking.mjs  the eight facts per passenger, the order to ask them
 *                      in, and the three checks that stop somebody being
 *                      turned away at a desk (passport under six months, a
 *                      name that is not the passport name, an infant who
 *                      turns two mid-trip).
 *   flightpay.mjs      authorize → issue → capture, with a void on every
 *                      failure path so a hold is never left hanging.
 *   issuer.mjs         the pluggable issuer, real or simulated.
 *   flightconfirm.mjs  the itinerary, the email, the SMS, and deliver().
 *
 * Every one of those was reachable only from its own tests. Nothing called
 * startBooking. Nothing called deliver. The concierge read `state.flightBooking`
 * — a field the CLIENT sends — and nothing ever put a booking in it.
 *
 * So the honest description of the flight booking feature on 13 Sep was: a
 * complete engine with no ignition, no fuel line, and no wheels. This file
 * is those three things.
 *
 * ── WHY THE BOOKING LIVES IN D1 AND NOT IN THE TRIP STATE ────────────────
 *
 * The concierge used to read the open booking out of the state blob posted by
 * the app. That is fine while the whole feature is inert and became a real
 * problem the moment it was not, for two reasons:
 *
 *   1. A passport number and a date of birth would round-trip through the
 *      client on every single turn of the conversation. There is no reason
 *      for that data to leave the server once it has arrived.
 *   2. `readyToIssue()` would be evaluated against a record the client
 *      supplied. A client that says "state: ready, everything collected" is
 *      a client that gets the concierge to read a total back and invite a
 *      confirmation for a booking that does not exist.
 *
 * The order is server-side, keyed by member. The client sends answers; it
 * never sends the booking.
 *
 * ── IT IS STILL OFF ──────────────────────────────────────────────────────
 *
 * Every route here refuses while `canIssueFlight(env)` is false, which it is
 * on every deployment today: SABRE_BOOKING_ENABLED is unset and the Sabre
 * environment is `certification`. The day that flips — and the day the
 * seller-of-travel registration is in hand, which is the same day — this
 * connects with no code change. Until then the tests are the only caller,
 * and they pass an env that says booking is on.
 */
import { canIssueFlight } from './services.mjs';
import {
  STATE, apply, complete, nextPrompt, preflight, readyToIssue, remaining, startBooking,
} from './flightbooking.mjs';

const SCHEMA = `CREATE TABLE IF NOT EXISTS num_flight_orders (
  ref TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  state TEXT NOT NULL,
  booking TEXT NOT NULL,
  pnr TEXT,
  total_cs INTEGER,
  currency TEXT,
  intent_id TEXT,
  failure TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const IDX = [
  // One open order per member is the rule the code enforces; the index is
  // what makes finding it cheap rather than what makes it true.
  `CREATE INDEX IF NOT EXISTS idx_flight_order_member ON num_flight_orders(member_id, state)`,
];

// Keyed on the binding object, never a module boolean: a module flag is
// shared across every test in a file and makes the second test silently skip
// its own migration.
const built = new WeakSet();

export async function ensure(env) {
  const db = env?.DB;
  if (!db || built.has(db)) return;
  await db.prepare(SCHEMA).run();
  for (const i of IDX) await db.prepare(i).run().catch(() => {});
  built.add(db);
}

/** States a traveller can still act on. ISSUED and FAILED are history. */
export const OPEN_STATES = Object.freeze([STATE.QUOTED, STATE.COLLECTING, STATE.READY, STATE.ISSUING]);

export const newRef = (rand = crypto.randomUUID.bind(crypto)) =>
  `fo_${String(rand()).replace(/-/g, '').slice(0, 20)}`;

/** The one thing every route answers with, so the app has a single shape. */
export function view(row) {
  if (!row) return null;
  const booking = JSON.parse(row.booking);
  const next = nextPrompt(booking);
  const pf = preflight(booking);
  const r = remaining(booking);
  return {
    ref: row.ref,
    state: row.state,
    offer: booking.offer ?? null,
    passengers: booking.passengers.length,
    collected: r.have,
    total: r.total,
    // The QUESTION, never the answers. The app renders the prompt; the
    // passport numbers behind it stay on the server.
    next: next ? { key: next.key, index: next.index, label: next.label, ask: next.ask, why: next.why ?? null } : null,
    blocking: pf.blocking.map((b) => b.message),
    warnings: pf.warnings.map((w) => w.message),
    ready: readyToIssue(booking).ok,
    pnr: row.pnr ?? null,
    failure: row.failure ?? null,
  };
}

async function load(env, memberId) {
  await ensure(env);
  const marks = OPEN_STATES.map((_, i) => `?${i + 2}`).join(', ');
  return await env.DB.prepare(
    `SELECT * FROM num_flight_orders WHERE member_id = ?1 AND state IN (${marks})
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(memberId, ...OPEN_STATES).first();
}

async function save(env, ref, booking, extra = {}) {
  const sets = ['state = ?2', 'booking = ?3', "updated_at = datetime('now')"];
  const binds = [ref, booking.state, JSON.stringify(booking)];
  let n = 4;
  for (const [col, val] of Object.entries(extra)) {
    sets.push(`${col} = ?${n}`);
    binds.push(val);
    n += 1;
  }
  await env.DB.prepare(`UPDATE num_flight_orders SET ${sets.join(', ')} WHERE ref = ?1`).bind(...binds).run();
}

/**
 * The booking the concierge is told about.
 *
 * Replaces reading `state.flightBooking` off the request. Returns null when
 * booking is off, so the prompt block simply does not appear rather than
 * appearing empty.
 */
export async function openBookingFor(env, memberId) {
  if (!canIssueFlight(env ?? {}) || !env?.DB || !memberId) return null;
  const row = await load(env, memberId).catch(() => null);
  return row ? JSON.parse(row.booking) : null;
}

export async function startOrder(env, { memberId, offer, seats = 1 }) {
  await ensure(env);
  // An existing open order wins. Starting a second one while the first is
  // half-collected is how a traveller answers eight questions into a record
  // nobody issues, and the first sign of it is two rows in the table.
  const existing = await load(env, memberId);
  if (existing) return { ok: true, reused: true, order: view(existing) };

  const booking = startBooking(offer, seats);
  const ref = newRef();
  await env.DB.prepare(
    'INSERT INTO num_flight_orders (ref, member_id, state, booking) VALUES (?1,?2,?3,?4)',
  ).bind(ref, memberId, booking.state, JSON.stringify(booking)).run();
  return { ok: true, reused: false, order: view({ ref, state: booking.state, booking: JSON.stringify(booking) }) };
}

export async function answerOrder(env, { memberId, key, value, index = 0 }) {
  const row = await load(env, memberId);
  if (!row) return { ok: false, error: 'no_open_booking' };
  if (row.state === STATE.ISSUING) {
    // A ticket is being issued against this exact record. Changing a
    // passport number underneath that is how the document and the person
    // stop matching.
    return { ok: false, error: 'locked', message: 'This booking is being issued — nothing can change now.' };
  }
  const out = apply(JSON.parse(row.booking), key, value, index);
  if (!out.ok) return { ok: false, error: 'invalid', message: out.error };
  await save(env, row.ref, out.booking);
  return { ok: true, order: view({ ...row, state: out.booking.state, booking: JSON.stringify(out.booking) }) };
}

/**
 * Buy the ticket.
 *
 * The order of operations is not negotiable and every step of it is somebody
 * else's hard-won code:
 *
 *   readyToIssue   — refuses on a missing field OR a blocking preflight, so
 *                    a passport expiring inside six months stops the sale
 *                    rather than producing a ticket that will be refused.
 *   purchase       — authorize, issue, capture, with a void on every failure
 *                    path except the one where the ticket exists.
 *   deliver        — the confirmation. Called AFTER capture, never before:
 *                    an email saying "you're booked" that arrives before the
 *                    money moved is a promise we might have to take back.
 *
 * `deliver` cannot fail the booking. The traveller has paid and holds a PNR;
 * a bounced email is a loud log line and a row in the mail ledger, not a
 * reason to tell them their flight did not happen.
 */
export async function issueOrder(env, { memberId, sendSms = null, deps = null } = {}) {
  // The three collaborators are injectable for ONE reason: so the wiring can
  // be tested without a Stripe key and a live GDS. The default is the real
  // thing, imported lazily so a worker that never books never pulls them in.
  // A test that has to mock the module system to assert "deliver was called"
  // is a test that stops working when the module system changes; a parameter
  // is the same assertion with none of that.
  const use = deps ?? {
    purchase: (...a) => import('./flightpay.mjs').then((m) => m.purchase(...a)),
    issue: (...a) => import('./issuer.mjs').then((m) => m.issue(...a)),
    deliver: (...a) => import('./flightconfirm.mjs').then((m) => m.deliver(...a)),
    alert: (...a) => import('./health.mjs').then((m) => m.alert(...a)),
  };
  if (!canIssueFlight(env ?? {})) {
    return { ok: false, error: 'booking_off', message: 'Num cannot issue tickets on this deployment.' };
  }
  const row = await load(env, memberId);
  if (!row) return { ok: false, error: 'no_open_booking' };

  const booking = JSON.parse(row.booking);
  const gate = readyToIssue(booking);
  if (!gate.ok) {
    return {
      ok: false,
      error: gate.reason,
      missing: gate.missing ?? null,
      blocking: (gate.blocking ?? []).map((b) => b.message),
    };
  }
  if (row.state === STATE.ISSUING) {
    // Not an error the traveller caused. Two taps on a slow button must not
    // become two tickets.
    return { ok: false, error: 'in_flight', message: 'That booking is already being issued.' };
  }

  const issuing = { ...booking, state: STATE.ISSUING };
  await save(env, row.ref, issuing);

  const paid = await use.purchase(env, booking, {
    ref: row.ref,
    memberId,
    issueFn: () => use.issue(env, booking, { ref: row.ref }),
  });

  if (!paid.ok) {
    // needsHuman means the ticket exists and the money did not arrive. That
    // is NOT a failed order — marking it failed would invite someone to
    // retry and issue a second ticket. It stays ISSUING and shouts.
    const stuck = !!paid.needsHuman;
    await save(env, row.ref, stuck ? issuing : { ...booking, state: STATE.FAILED }, {
      failure: String(paid.message ?? paid.error ?? 'issue failed').slice(0, 400),
      ...(paid.intentId ? { intent_id: paid.intentId } : {}),
      ...(stuck && paid.issued?.reference ? { pnr: String(paid.issued.reference) } : {}),
    });
    if (stuck) {
      await use.alert(
        env,
        `[flight] TICKET ISSUED, PAYMENT DID NOT COMPLETE — ${row.ref}, pnr ${paid.issued?.reference}. `
        + 'Do not cancel the hold; that gives away a ticket.',
      ).catch(() => {});
    }
    return { ok: false, ...paid };
  }

  const issued = paid.issued;
  const done = { ...booking, state: STATE.ISSUED, issued };
  await save(env, row.ref, done, {
    pnr: String(issued.reference),
    total_cs: paid.captured_cs ?? null,
    currency: paid.amount?.currency ?? null,
    intent_id: paid.intentId ?? null,
  });

  const sent = await use.deliver(env, done, issued, { sendSms }).catch((e) => ({
    email: { ok: false, error: String(e?.message ?? e) }, sms: null, itinerary: null,
  }));

  return {
    ok: true,
    ref: row.ref,
    pnr: issued.reference,
    real: issued.real !== false,
    confirmation: { email: !!sent?.email?.ok, sms: sent?.sms ? !!sent.sms.ok : null },
    order: view({ ...row, state: STATE.ISSUED, booking: JSON.stringify(done), pnr: issued.reference }),
  };
}

/* ── THE ROUTE ───────────────────────────────────────────────────────────
   One path, four verbs, all POST except the read. Gated at the top so a
   deployment that cannot issue a ticket cannot be talked into collecting a
   passport number for one. */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function handleFlightOrder(request, env, path) {
  if (!canIssueFlight(env ?? {})) {
    // 200 for the same reason as the partner handoff: "we cannot book" is a
    // true answer to a fair question, and a 404 would make every correct
    // refusal look like a broken route.
    return json({ available: false, why: 'Num cannot issue tickets on this deployment yet.' });
  }
  if (!env?.DB) return json({ error: 'no database' }, 503);

  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
  const url = new URL(request.url);
  const memberId = String(body?.me ?? url.searchParams.get('me') ?? '').slice(0, 64);
  if (!memberId) return json({ error: 'Sign in first.' }, 401);

  if (request.method === 'GET' || path === '/' || path === '') {
    if (request.method === 'GET') {
      const row = await load(env, memberId);
      return json({ available: true, order: view(row) });
    }
  }

  if (path === '/start' && request.method === 'POST') {
    if (!body?.offer) return json({ error: 'Which fare?' }, 400);
    const seats = Number.isInteger(body.seats) && body.seats > 0 && body.seats <= 9 ? body.seats : 1;
    return json({ available: true, ...(await startOrder(env, { memberId, offer: body.offer, seats })) });
  }

  if (path === '/answer' && request.method === 'POST') {
    const out = await answerOrder(env, {
      memberId,
      key: String(body?.key ?? ''),
      value: body?.value,
      index: Number.isInteger(body?.index) ? body.index : 0,
    });
    return json({ available: true, ...out }, out.ok ? 200 : 400);
  }

  if (path === '/issue' && request.method === 'POST') {
    const out = await issueOrder(env, { memberId });
    return json({ available: true, ...out }, out.ok ? 200 : 400);
  }

  return json({ error: 'not found' }, 404);
}

export const __testables = { load, save, complete };
