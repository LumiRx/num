// Sabre Booking Management — the point where Num stops quoting and commits.
//
// Everything in worker/sabre.mjs is reversible because none of it does
// anything: shopping and revalidation cost nothing and leave no trace. This
// file is the opposite. Create Booking takes a seat out of inventory. Fulfill
// issues a ticket, which is a financial document. Refund and Void move money
// that has already moved once. Getting one of these wrong is not a bad answer,
// it is somebody's money and somebody's flight.
//
// So the design rule here is different from everywhere else in this codebase:
// **capability is not the same as permission.** Having credentials that CAN
// issue a ticket must not be the same thing as being allowed to. Three gates,
// each deliberate:
//
//   1. SABRE_BOOKING_ENABLED — booking is off even with working credentials.
//      Shopping keeps working; committing does not, until someone says so.
//   2. Production needs SABRE_BOOKING_LIVE on top of SABRE_ENV=prod. Two
//      switches, because the failure mode of one is issuing a real ticket
//      against what you thought was a sandbox.
//   3. Money operations (fulfill, void, refund) need the admin key. They are
//      not reachable from an app session, which means they are not reachable
//      by the model, which means no chain of prompt text can reach them.
//
// The model never calls anything here. It can PREPARE a booking and say what
// it would cost; a human confirms. That is not timidity — an agent that can
// autonomously spend money on a stranger's behalf is a liability, and the
// confirmation is the product working correctly rather than a limitation.

import { sabreReady } from './sabre.mjs';

const REST = {
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
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/**
 * Operations, by how much damage each can do.
 *
 * This table is the security model in one place. `tier` decides which gate an
 * operation has to pass, and it is derived from consequence, not from HTTP
 * verb — Cancel Booking is a POST and it un-books a holiday.
 */
export const OPS = {
  get: { tier: 'read', what: 'Retrieve a reservation — PNR and NDC order, normalized.' },
  checkTickets: { tier: 'read', what: 'Is this ticket voidable or refundable, and for how much.' },
  create: { tier: 'commit', what: 'Create the booking. Takes real inventory.' },
  modify: { tier: 'commit', what: 'Change an existing booking.' },
  cancel: { tier: 'commit', what: 'Cancel all or part of a reservation.' },
  fulfill: { tier: 'money', what: 'Issue tickets and EMDs. This is a financial document.' },
  void: { tier: 'money', what: 'Void issued documents.' },
  refund: { tier: 'money', what: 'Refund issued documents.' },
};

/**
 * The confirmed base for every Booking Management operation.
 *
 * Read off the API page rather than inferred: the server block computes to
 * https://api.cert.platform.sabre.com/v1/trip/orders. Only the per-operation
 * suffixes are still unknown.
 */
const BOOKING_BASE = '/v1/trip/orders';

/**
 * The operation suffixes, read off the OpenAPI spec.
 *
 * These were inferred from the sibling naming convention first and then
 * confirmed against the spec — every one matched. They are defaults now rather
 * than a guess behind a flag, but SABRE_BOOKING_PATHS still overrides any of
 * them, because a beta API is entitled to move its endpoints.
 */
const OPERATION_PATH = {
  get: 'getBooking',
  create: 'createBooking',
  modify: 'modifyBooking',
  cancel: 'cancelBooking',
  fulfill: 'fulfillFlightTickets',
  checkTickets: 'checkFlightTickets',
  void: 'voidFlightTickets',
  refund: 'refundFlightTickets',
};

/**
 * What each operation cannot proceed without, per the spec's `required`.
 *
 * Checked here so a missing confirmationId reads as a missing confirmationId
 * rather than as a schema violation from a server that has already been asked
 * to do something. On the commit tier that difference is the gap between a
 * clear refusal and a half-finished reservation.
 */
const REQUIRED = {
  get: ['confirmationId'],
  cancel: ['confirmationId'],
  modify: ['confirmationId', 'bookingSignature', 'before', 'after'],
  fulfill: ['confirmationId', 'fulfillments'],
};

/**
 * Resolve each operation to a path.
 *
 * SABRE_BOOKING_PATHS is one JSON object so it is a single paste. Values may
 * be a full path ("/v1/trip/orders/getBooking") or just the suffix
 * ("getBooking") — the suffix form is less to type and less to get wrong, and
 * both are accepted because an operator pasting from a spec will have the
 * full one.
 */
function paths(env) {
  let configured = {};
  try {
    const p = JSON.parse(env.SABRE_BOOKING_PATHS || '{}');
    if (p && typeof p === 'object') configured = p;
  } catch {
    console.warn('[sabre-booking] SABRE_BOOKING_PATHS is not valid JSON — treating as unconfigured');
  }

  const out = {};
  for (const op of Object.keys(OPS)) {
    const raw = configured[op] ?? OPERATION_PATH[op];
    if (!raw) continue;
    out[op] = String(raw).startsWith('/') ? String(raw) : `${BOOKING_BASE}/${String(raw).replace(/^\/+/, '')}`;
  }
  return out;
}

export const bookingConfigured = (env) => sabreReady(env) && env.SABRE_BOOKING_ENABLED === 'true';

/**
 * Whether this operation may run at all, and if not, why in plain words.
 *
 * Returns a reason rather than a boolean because every one of these refusals
 * is something an operator will have to debug at some point, and "false" is
 * not a debuggable value.
 */
export function permitted(env, op, { adminKey = false } = {}) {
  const spec = OPS[op];
  if (!spec) return { ok: false, why: `Unknown operation "${op}".`, status: 404 };
  if (!sabreReady(env)) return { ok: false, why: 'Sabre credentials are not set.', status: 503 };
  if (env.SABRE_BOOKING_ENABLED !== 'true') {
    return { ok: false, why: 'Booking is switched off. Set SABRE_BOOKING_ENABLED=true to allow commits.', status: 403 };
  }
  if (!paths(env)[op]) {
    return { ok: false, why: `No endpoint path configured for "${op}". Add it to SABRE_BOOKING_PATHS.`, status: 501 };
  }
  // The two-key rule for production. One switch flipped by accident is a
  // sandbox mistake; two is a decision.
  if (env.SABRE_ENV === 'prod' && env.SABRE_BOOKING_LIVE !== 'true' && spec.tier !== 'read') {
    return {
      ok: false,
      why: 'Pointed at production but SABRE_BOOKING_LIVE is not true. Refusing to commit against live inventory.',
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
CREATE TABLE IF NOT EXISTS num_sabre_bookings (
  id TEXT PRIMARY KEY, op TEXT NOT NULL, tier TEXT NOT NULL, member_id TEXT,
  idem TEXT, confirmation_id TEXT, ok INTEGER NOT NULL DEFAULT 0,
  request TEXT, response TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sabre_idem ON num_sabre_bookings(idem) WHERE idem IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sabre_conf ON num_sabre_bookings(confirmation_id);
`;
let ready = false;
async function ensure(env) {
  if (ready || !env.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

/** Tokens and card numbers must never reach an audit row. */
function redact(v) {
  if (v == null) return v;
  try {
    return JSON.parse(
      JSON.stringify(v)
        .replace(/"(Authorization|token|access_token|api_key|apiKey|password)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"')
        // Card numbers, however they are keyed. Better to over-redact an audit
        // row than to build a searchable table of PANs.
        .replace(/"(cardNumber|number|accountNumber|securityCode|cvv|expiryDate)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"')
        .replace(/\b\d{13,19}\b/g, '<redacted-number>'),
    );
  } catch {
    return { unserializable: true };
  }
}

// ── calling ───────────────────────────────────────────────────────────────

/**
 * The same ATK the shopping calls use.
 *
 * The docs name two different services — "Create Access Token" for booking and
 * "OAuth Token Create" for shopping — but both mint the one ATK from
 * /v2/auth/token, and REST takes it as a Bearer either way. So the token cache
 * is shared rather than duplicated. SABRE_BOOKING_TOKEN stays as an override
 * for the case where an operator has to pin a token obtained out of band.
 */
async function authHeader(env) {
  if (env.SABRE_BOOKING_TOKEN) return `Bearer ${env.SABRE_BOOKING_TOKEN}`;
  const { sabreToken } = await import('./sabre.mjs');
  return `Bearer ${await sabreToken(env)}`;
}

async function callBooking(env, op, body) {
  const path = paths(env)[op];
  const res = await fetch(`${(env.SABRE_ENV === 'prod' ? REST.prod : REST.cert)}${path}`, {
    method: 'POST',
    headers: {
      Authorization: await authHeader(env),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    // Ticketing is slow and must not be abandoned halfway: a timeout that
    // fires after Sabre has committed leaves a ticket nobody knows about.
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 800) };
  }
  if (!res.ok) {
    const err = new Error(parsed?.message ?? parsed?.error_description ?? parsed?.error ?? `Sabre booking ${res.status}`);
    err.status = res.status;
    err.detail = parsed;
    throw err;
  }
  return parsed;
}

/**
 * Run one operation, with the audit row written either way.
 *
 * `idem` is not optional politeness on a commit — a retried Create Booking
 * without it books the trip twice, and the second one is discovered by the
 * traveller at the airport. The unique index does the enforcing; a replay
 * returns the first result rather than doing it again.
 */
export async function run(env, op, body, { memberId, idem, adminKey } = {}) {
  const gate = permitted(env, op, { adminKey });
  if (!gate.ok) {
    const err = new Error(gate.why);
    err.status = gate.status;
    throw err;
  }
  await ensure(env);

  const missing = (REQUIRED[op] ?? []).filter((k) => body?.[k] == null);
  if (missing.length) {
    const err = new Error(`${op} needs ${missing.join(', ')}.`);
    err.status = 400;
    throw err;
  }

  const tier = OPS[op].tier;
  if (tier !== 'read' && !idem) {
    const err = new Error('An idempotency key is required for anything that commits. Send `idem`.');
    err.status = 400;
    throw err;
  }

  if (idem && env.DB) {
    const seen = await env.DB.prepare('SELECT response, ok FROM num_sabre_bookings WHERE idem=?1').bind(idem).first().catch(() => null);
    // Only a SUCCESSFUL previous attempt short-circuits. Replaying after a
    // failure is the whole point of having a retry.
    if (seen?.ok) return { ...JSON.parse(seen.response || '{}'), _replayed: true };
  }

  const id = crypto.randomUUID();
  let out = null;
  let ok = 0;
  let note = null;
  try {
    out = await callBooking(env, op, body);
    ok = 1;
  } catch (err) {
    note = String(err?.message ?? err).slice(0, 400);
    await record(env, { id, op, tier, memberId, idem: null, body, out: err?.detail ?? null, ok, note });
    throw err;
  }

  await record(env, {
    id,
    op,
    tier,
    memberId,
    idem,
    body,
    out,
    ok,
    note,
    confirmationId: out?.confirmationId ?? out?.confirmationID ?? null,
  });
  return out;
}

async function record(env, { id, op, tier, memberId, idem, body, out, ok, note, confirmationId }) {
  if (!env.DB) return;
  await env.DB.prepare(
    `INSERT INTO num_sabre_bookings (id, op, tier, member_id, idem, confirmation_id, ok, request, response, note)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
  )
    .bind(
      id,
      op,
      tier,
      clip(memberId, 40),
      idem ?? null,
      clip(confirmationId, 40),
      ok,
      JSON.stringify(redact(body)).slice(0, 12_000),
      JSON.stringify(redact(out)).slice(0, 12_000),
      note,
    )
    .run()
    .catch((e) => console.warn('[sabre-booking] audit failed', e?.message ?? e));
}

// ── routes ────────────────────────────────────────────────────────────────

export async function handleBooking(request, env, path) {
  const op = path.replace(/^\//, '');

  if (op === 'status' || op === '') {
    const configured = paths(env);
    return json({
      enabled: bookingConfigured(env),
      environment: env.SABRE_ENV === 'prod' ? 'production' : 'certification',
      base_path: BOOKING_BASE,
      paths_source: 'confirmed against the Booking Management OpenAPI spec',
      live_commits_allowed: env.SABRE_ENV !== 'prod' || env.SABRE_BOOKING_LIVE === 'true',
      operations: Object.fromEntries(
        Object.entries(OPS).map(([k, v]) => {
          const g = permitted(env, k, { adminKey: false });
          return [k, { tier: v.tier, what: v.what, path_configured: !!configured[k], available: g.ok, ...(g.ok ? {} : { blocked_by: g.why }) }];
        }),
      ),
      note:
        'Money operations (fulfill, void, refund) require the admin key and are not reachable from an app session. ' +
        'The concierge never calls anything here — it prepares, a person confirms.',
    });
  }

  /**
   * Check the configured paths exist, WITHOUT committing anything.
   *
   * Only the read operations are actually called — with a deliberately absent
   * confirmation id, so the worst case is "no such booking". Commit and money
   * operations are never probed; their resolved URL is reported so it can be
   * eyeballed against the spec, because the only safe way to test whether
   * createBooking's path is right is to read it, not to fire it.
   */
  if (op === 'probe') {
    if (!env.ADMIN_KEY || request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) return json({ error: 'unauthorized' }, 401);
    const configured = paths(env);
    const host = env.SABRE_ENV === 'prod' ? REST.prod : REST.cert;
    const out = {};
    for (const [name, spec] of Object.entries(OPS)) {
      const path = configured[name];
      if (!path) {
        out[name] = { configured: false };
        continue;
      }
      if (spec.tier !== 'read') {
        out[name] = { configured: true, url: host + path, probed: false, why: 'not probed — it commits' };
        continue;
      }
      try {
        await callBooking(env, name, { confirmationId: 'NUMPRB' });
        out[name] = { configured: true, url: host + path, probed: true, path_exists: true };
      } catch (err) {
        // 404 on the PATH and 404 for "no such booking" are different things,
        // and the body is what tells them apart.
        const looksLikeMissingRoute = err.status === 404 && !JSON.stringify(err.detail ?? {}).length;
        out[name] = {
          configured: true,
          url: host + path,
          probed: true,
          path_exists: !looksLikeMissingRoute && err.status !== 405,
          status: err.status,
          reply: String(err.message).slice(0, 160),
        };
      }
    }
    return json({ base: BOOKING_BASE, environment: env.SABRE_ENV === 'prod' ? 'production' : 'certification', operations: out });
  }

  if (request.method !== 'POST') return json({ error: 'not found' }, 404);

  const admin = !!env.ADMIN_KEY && request.headers.get('X-Admin-Key') === env.ADMIN_KEY;
  const body = await readBody(request);

  try {
    const out = await run(env, op, body.payload ?? body, {
      memberId: body.me,
      idem: body.idem,
      adminKey: admin,
    });
    return json(out);
  } catch (err) {
    console.error('[sabre-booking]', op, err?.message ?? err);
    return json({ error: err?.message ?? 'that didn’t go through', detail: err?.detail ?? null }, err?.status ?? 500);
  }
}
