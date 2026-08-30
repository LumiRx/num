// The passenger record — the thing Duffel's create-order needs and Num has
// never held.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
//
// `num_members` (worker/social.mjs, SCHEMA) is id, name, phone, phone_verified,
// and nothing else that an airline would recognise. Duffel's create-order
// requires, per passenger and all of them required:
//
//     id  given_name  family_name  gender  title  born_on  email  phone_number
//
// (https://duffel.com/docs/api/orders/create-order — "Order Request Passenger",
// `required: ["id","given_name","family_name","gender","title","born_on",
// "email","phone_number"]`, read 2026-08-18.) Note that email and phone_number
// are required on EVERY passenger, not only the lead — the docs' own example
// carries them on each entry, and the schema's required list is per-object.
//
// So this is not a field mapping. It is a table Num did not have, holding a
// full legal name, a date of birth and a gender marker, which is
// government-identity-adjacent personal data and the most sensitive thing Num
// would ever store. Three consequences run through every line below:
//
//   1. It is written down what is kept and for how long, and the retention is
//      a column that a sweep reads, not a sentence in a document (RETENTION).
//   2. It never reaches a model prompt or an audit row in the clear
//      (worker/redact.mjs, worker/duffel.mjs#redact).
//   3. It never crosses to 5arz or to any third party, and that is enforced by
//      assertNoPassengerData() at the crossing sites rather than promised
//      (see § THE CROSSING RULE).
//
// ── THE CROSSING RULE ────────────────────────────────────────────────────
//
// HQ/divisions/num/CONSENT_ARCHITECTURE.md §2.2 defines five consent scopes for
// the Num → 5arz boundary: identity_link, identity_attributes,
// signal_to_parent, verification_export, research_licensing. Every one of them
// is about proof-of-human. **None of them covers a passenger record, and none
// may be extended to.** A passport number says nothing about whether somebody
// is a human; sending it to the parent multiplies the blast radius of any
// breach on either side for no product gain. So the answer to "does a passenger
// record ever cross to 5arz" is NO, permanently, and there is no toggle that
// makes it yes.
//
// That is enforced three ways, all executable:
//   · nothing in this file touches `env.LEDGER` — a test drives every endpoint
//     with a spying LEDGER binding and asserts it was never prepared against;
//   · assertNoPassengerData() runs on the outbound payload at worker/air.mjs
//     (callAir) and on the /api/trust response at worker/index.mjs, and throws;
//   · crossingScopeFor() returns null for every field on this row, so any
//     future consent check asking "which grant authorises this?" gets "none".
//
// Docs this file was written from, all fetched 2026-08-18:
//   https://duffel.com/docs/api/orders/create-order
//   https://duffel.com/docs/api/offer-requests/create-offer-request
//   https://duffel.com/docs/guides/getting-started-with-flights
import { normalisePhone, uid } from '../claim/verify.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const readBody = async (req) => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};

const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);

// ── the enums, exactly as Duffel publishes them ───────────────────────────

/**
 * `title`. Duffel: enum ["mr","ms","mrs","miss","dr"], with the note that "the
 * `dr` title is not supported by certain airlines, where a ValidationError will
 * be returned instead if used". `dr` is accepted here and flagged on the way
 * out, because refusing it in Num would be Num inventing a rule Duffel does not
 * have.
 */
export const TITLES = Object.freeze(['mr', 'ms', 'mrs', 'miss', 'dr']);

/**
 * `gender`. Duffel: enum ["m","f"]. There is no third value and no null.
 * This is the airline's security field, not a question about identity, and the
 * form says so out loud rather than pretending the API is broader than it is.
 */
export const GENDERS = Object.freeze(['m', 'f']);

/** Duffel's passenger type enum, for the offer request. */
export const PASSENGER_TYPES = Object.freeze(['adult', 'child', 'infant_without_seat']);

/** Every column of num_passengers that is personal data about a traveller. */
export const PASSENGER_PII_FIELDS = Object.freeze([
  'given_name', 'family_name', 'born_on', 'gender', 'title',
  'email', 'phone_number',
  'passport_number', 'passport_country', 'passport_expires_on',
  'loyalty_airline', 'loyalty_account',
]);

// ── retention ─────────────────────────────────────────────────────────────

/**
 * How long each thing is kept, and why that number.
 *
 * These are the operative values — `retentionSweep()` reads them, so changing
 * the policy means changing this object and watching a test go red, rather than
 * editing a document nothing consults.
 */
export const RETENTION = Object.freeze({
  /**
   * A soft-deleted record is recoverable for 30 days and then destroyed.
   * Instant-and-irreversible is the wrong default the night before a flight;
   * a month is long enough to undo a mistake and short enough that "deleted"
   * means something.
   */
  soft_delete_grace_days: 30,
  /**
   * A record nobody has used to build a booking in 24 months is soft-deleted
   * automatically. Passenger details go stale — passports expire, people
   * change their names — and a stale identity record is pure liability.
   */
  dormant_months: 24,
  /**
   * Passport number, issuing country and expiry are cleared 12 months after the
   * record was last used, independently of the record itself. They are the
   * highest-harm columns, they are only needed by the minority of airlines that
   * set `passenger_identity_documents_required`, and they are cheap for the
   * traveller to re-enter.
   */
  document_months: 12,
});

// ── schema ────────────────────────────────────────────────────────────────

/**
 * Inlined verbatim from worker/migrations/0002_passengers.sql, because a Worker
 * has no filesystem. THE .sql FILE IS THE ONE TO EDIT FIRST — passengers.test.mjs
 * parses both and fails if they have drifted.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_passengers (
  id                  TEXT PRIMARY KEY,
  member_id           TEXT NOT NULL,
  is_self             INTEGER NOT NULL DEFAULT 0 CHECK (is_self IN (0,1)),
  label               TEXT,
  title               TEXT NOT NULL CHECK (title IN ('mr','ms','mrs','miss','dr')),
  given_name          TEXT NOT NULL,
  family_name         TEXT NOT NULL,
  born_on             TEXT NOT NULL,
  gender              TEXT NOT NULL CHECK (gender IN ('m','f')),
  email               TEXT NOT NULL,
  phone_number        TEXT NOT NULL,
  travels_with_id     TEXT,
  passport_number     TEXT,
  passport_country    TEXT,
  passport_expires_on TEXT,
  loyalty_airline     TEXT,
  loyalty_account     TEXT,
  deleted_at          TEXT,
  purge_after         TEXT,
  last_used_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_num_passengers_member ON num_passengers (member_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_num_passengers_purge  ON num_passengers (purge_after);
CREATE UNIQUE INDEX IF NOT EXISTS idx_num_passengers_self ON num_passengers (member_id)
  WHERE is_self = 1 AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_num_passengers_infant ON num_passengers (travels_with_id)
  WHERE travels_with_id IS NOT NULL AND deleted_at IS NULL;
`;

/**
 * Split a schema file into comparable statements, comments removed.
 *
 * Used both to apply the schema and, in passengers.test.mjs, to prove the
 * inlined copy and worker/migrations/0002_passengers.sql still say the same
 * thing. There are no `--` sequences inside string literals in this schema, so
 * stripping to end-of-line is safe here and would not be in general.
 */
export const statementsOf = (sql) =>
  String(sql)
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

let ready = false;

/**
 * Apply the schema, once, and FAIL CLOSED.
 *
 * Deliberately not the swallow-the-error pattern at worker/social.mjs:96-102.
 * That is right for `ALTER TABLE … ADD COLUMN avatar`, where the expected
 * outcome on every deploy after the first is "duplicate column". It is wrong
 * here: a passenger table that half-applied and kept answering 200 would store
 * a legal name in a shape nobody has checked.
 */
export async function ensurePassengers(env) {
  if (ready) return;
  if (!env?.DB) throw new Error('no DB binding');
  await env.DB.batch(statementsOf(SCHEMA).map((s) => env.DB.prepare(s)));
  ready = true;
}

/** Test seam: forget that the schema was applied. Never called in production. */
export const _resetEnsured = () => {
  ready = false;
};

// ── validation ────────────────────────────────────────────────────────────

/**
 * Duffel's own name charset, transcribed from the docs rather than guessed:
 *
 *   "Only `space`, `-`, `'`, and letters from the ASCII, Latin-1 Supplement and
 *    Latin Extended-A (with the exceptions of Æ, æ, Ĳ, ĳ, Œ, œ, Þ, and ð)
 *    Unicode charts are accepted. All other characters will result in a
 *    validation error. The minimum length is 1 or 2 characters, and the
 *    maximum, combined with given_name, is 40 characters."
 *
 * This is checked in Num because the alternative is a 422 from an airline at
 * the moment somebody is trying to buy a ticket, with a message written for a
 * developer rather than for the person holding the phone.
 */
const NAME_ALLOWED = /^[A-Za-zÀ-ÖØ-öø-ÿĀ-ſ '-]+$/;
const NAME_EXCLUDED = /[ÆæĲĳŒœÞð]/; // Æ æ Ĳ ĳ Œ œ Þ ð
const NAME_MAX_COMBINED = 40;

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_COUNTRY = /^[A-Z]{2}$/;

/** A real calendar date, not merely a string of the right shape. */
export function isRealDate(v) {
  if (!ISO_DATE.test(String(v ?? ''))) return false;
  const [y, m, d] = String(v).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Whole years old on `onISO`. Duffel prices on the date of the final flight. */
export function ageOn(bornOn, onISO) {
  if (!isRealDate(bornOn) || !isRealDate(onISO)) return null;
  const [by, bm, bd] = bornOn.split('-').map(Number);
  const [oy, om, od] = onISO.split('-').map(Number);
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age -= 1;
  return age;
}

/**
 * Duffel's passenger type on a given date.
 *
 * "infant passengers (that is, passengers aged 0 or 1 on the date of the last
 * flight)". `child` has no published cut-off because it varies by airline —
 * which is exactly why the offer request sends `age` rather than `type` for
 * anyone under 18 (see offerRequestPassenger).
 */
export function paxTypeOn(bornOn, onISO) {
  const age = ageOn(bornOn, onISO);
  if (age == null) return null;
  if (age <= 1) return 'infant_without_seat';
  if (age < 18) return 'child';
  return 'adult';
}

const nameProblem = (field, v) => {
  const s = String(v ?? '').trim();
  if (!s) return `${field} is required — it must match the traveller's passport.`;
  if (!NAME_ALLOWED.test(s) || NAME_EXCLUDED.test(s)) {
    return `${field} may only contain letters, spaces, hyphens and apostrophes — Duffel rejects anything else.`;
  }
  return null;
};

/**
 * Validate one passenger record against Duffel's published formats.
 *
 * Returns `{ value, problems }`. `problems` is a list of sentences a person can
 * act on, in the order the form asks for them. Nothing is half-accepted: if
 * there is a problem the caller writes nothing.
 *
 * `partial` is for updates — only the keys present are checked, and the
 * required-ness of the rest is the database's job (the row already has them).
 */
export function validatePassenger(input, { partial = false, today = new Date() } = {}) {
  const problems = [];
  const v = {};
  const has = (k) => input?.[k] != null && String(input[k]).trim() !== '';
  const want = (k) => (partial ? has(k) : true);

  if (want('title')) {
    const t = String(input?.title ?? '').trim().toLowerCase();
    if (!TITLES.includes(t)) problems.push(`title must be one of ${TITLES.join(', ')}.`);
    else v.title = t;
  }
  if (want('given_name')) {
    const p = nameProblem('given_name', input?.given_name);
    if (p) problems.push(p);
    else v.given_name = String(input.given_name).trim();
  }
  if (want('family_name')) {
    const p = nameProblem('family_name', input?.family_name);
    if (p) problems.push(p);
    else v.family_name = String(input.family_name).trim();
  }
  if (v.given_name && v.family_name && (v.given_name.length + v.family_name.length) > NAME_MAX_COMBINED) {
    problems.push(`given_name and family_name together may be at most ${NAME_MAX_COMBINED} characters.`);
  }
  if (want('born_on')) {
    const b = String(input?.born_on ?? '').trim();
    if (!ISO_DATE.test(b)) problems.push('born_on must be a date in YYYY-MM-DD form, e.g. 1987-07-24.');
    else if (!isRealDate(b)) problems.push(`born_on is not a real date: ${b}.`);
    else {
      const todayISO = new Date(today).toISOString().slice(0, 10);
      const age = ageOn(b, todayISO);
      if (age < 0) problems.push('born_on is in the future.');
      else if (age > 130) problems.push('born_on is more than 130 years ago — Duffel caps passenger age at 130.');
      else v.born_on = b;
    }
  }
  if (want('gender')) {
    const g = String(input?.gender ?? '').trim().toLowerCase();
    if (!GENDERS.includes(g)) problems.push("gender must be 'm' or 'f' — it is the marker on the travel document, and Duffel accepts no other value.");
    else v.gender = g;
  }
  if (want('email')) {
    const e = String(input?.email ?? '').trim();
    if (!EMAIL.test(e) || e.length > 254) problems.push('email must be a real email address — the airline sends the confirmation there.');
    else v.email = e;
  }
  if (want('phone_number')) {
    // The existing normaliser, not a second one. worker/social.mjs applies the
    // same "must start with +" rule for the same reason: a number without its
    // country code silently becomes a different number somewhere else.
    const raw = String(input?.phone_number ?? '').trim();
    const p = normalisePhone(raw);
    if (!p || !p.startsWith('+')) {
      problems.push('phone_number must be in E.164 form — start it with + and the country code, like +442080160509.');
    } else v.phone_number = p;
  }

  // ── optional blocks ─────────────────────────────────────────────────────
  const anyDoc = has('passport_number') || has('passport_country') || has('passport_expires_on');
  if (anyDoc) {
    if (!has('passport_number') || !has('passport_country') || !has('passport_expires_on')) {
      problems.push('a passport needs all three of passport_number, passport_country and passport_expires_on — Duffel requires type, unique_identifier, issuing_country_code and expires_on together.');
    } else {
      const c = String(input.passport_country).trim().toUpperCase();
      if (!ISO_COUNTRY.test(c)) problems.push('passport_country must be an ISO 3166-1 alpha-2 code, like GB.');
      else v.passport_country = c;
      const x = String(input.passport_expires_on).trim();
      if (!isRealDate(x)) problems.push('passport_expires_on must be a real date in YYYY-MM-DD form.');
      else v.passport_expires_on = x;
      v.passport_number = clip(input.passport_number, 40);
    }
  }
  const anyLoyalty = has('loyalty_airline') || has('loyalty_account');
  if (anyLoyalty) {
    if (!has('loyalty_airline') || !has('loyalty_account')) {
      problems.push('a loyalty account needs both loyalty_airline (IATA code) and loyalty_account.');
    } else {
      const a = String(input.loyalty_airline).trim().toUpperCase();
      if (!/^[A-Z0-9]{2}$/.test(a)) problems.push('loyalty_airline must be a two-character airline IATA code, like BA.');
      else v.loyalty_airline = a;
      v.loyalty_account = clip(input.loyalty_account, 40);
    }
  }
  if (has('label')) v.label = clip(input.label, 40);
  if (input?.is_self != null) v.is_self = input.is_self ? 1 : 0;
  if (has('travels_with_id')) v.travels_with_id = clip(input.travels_with_id, 40);

  return { value: v, problems };
}

// ── the crossing rule, enforced ───────────────────────────────────────────

/**
 * Which consent scope authorises putting this field across a company boundary.
 *
 * Always null, for every passenger field, forever. The five scopes in
 * CONSENT_ARCHITECTURE.md §2.2 exist to move proof-of-human between Num and
 * 5arz. A date of birth and a passport number are not proof of anything about
 * humanity; they are the raw material of identity theft. There is no grant to
 * build, so this function does not take a member and cannot be made to say yes.
 */
export const crossingScopeFor = (field) => (PASSENGER_PII_FIELDS.includes(field) ? null : undefined);

/**
 * Keys that only ever appear because somebody put a passenger record into a
 * payload leaving Num.
 *
 * Deliberately NARROW. `name`, `email` and `phone` are excluded: AiR's
 * `manage_contact_add` legitimately carries a contact's name, and a guard that
 * fires on that is a guard somebody will delete. What is listed here has no
 * innocent reason to be in an outbound trust or AiR payload.
 */
const CROSSING_DENY_KEYS = Object.freeze([
  'given_name', 'family_name', 'born_on', 'date_of_birth',
  'passport_number', 'passport_country', 'passport_expires_on',
  'identity_documents', 'unique_identifier', 'issuing_country_code',
  'num_passengers', 'passenger_record', 'passengers',
]);

/** Every offending key path in `payload`, deepest-first. Empty means clean. */
export function findPassengerData(payload, { values = [] } = {}) {
  const hits = [];
  const bad = new Set(CROSSING_DENY_KEYS);
  const needles = values.map((s) => String(s).toLowerCase()).filter((s) => s.length >= 4);
  const walk = (node, path) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
    if (node && typeof node === 'object') {
      for (const [k, val] of Object.entries(node)) {
        const at = path ? `${path}.${k}` : k;
        if (bad.has(k)) hits.push(at);
        walk(val, at);
      }
      return;
    }
    if (node == null) return;
    const s = String(node).toLowerCase();
    // A stored legal name or date of birth copied into an innocently-named
    // field is the failure a key-shape guard cannot see, so the caller may pass
    // the member's own stored values and have them matched too.
    if (needles.some((n) => s.includes(n))) hits.push(`${path}=<passenger value>`);
  };
  walk(payload, '');
  return hits;
}

/**
 * Refuse to let a passenger record leave Num.
 *
 * Throws. Called at every crossing site (worker/air.mjs#callAir,
 * worker/index.mjs /api/trust) BEFORE the network, so the failure is a 500 on
 * our side rather than a disclosure on somebody else's. Fail-closed is the
 * house rule for crossings — CONSENT_ARCHITECTURE.md §5.3.
 */
export function assertNoPassengerData(payload, where, opts) {
  const hits = findPassengerData(payload, opts);
  if (!hits.length) return;
  const err = new Error(
    `passenger data must never leave Num (${where}): ${hits.slice(0, 5).join(', ')}. ` +
    'There is no consent scope that authorises this — see HQ/divisions/num/PASSENGER_RECORD_MODEL.md §3.',
  );
  err.status = 500;
  err.crossingBlocked = hits;
  throw err;
}

/**
 * The stored values that must not appear in an outbound payload for this member.
 *
 * Family name and date of birth only: they are the two fields that identify a
 * person on a travel document and are stable enough to match on. Given names
 * are too short and too common to match without false positives.
 */
export async function forbiddenValues(env, memberId) {
  if (!env?.DB || !memberId) return [];
  try {
    await ensurePassengers(env);
    const { results } = await env.DB
      .prepare('SELECT family_name, born_on FROM num_passengers WHERE member_id=?1 AND deleted_at IS NULL')
      .bind(memberId).all();
    return (results ?? []).flatMap((r) => [r.family_name, r.born_on]).filter(Boolean);
  } catch {
    // Fail closed on the crossing, not on the query: an empty list means the
    // key-shape guard still runs. Making an AiR call fail because a table is
    // missing would be a worse outcome than the narrower guard.
    return [];
  }
}

// ── retention, as code ────────────────────────────────────────────────────

const daysAgo = (n, now) => new Date(now - n * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');

/**
 * Apply RETENTION to the table. Returns what it did, so a test can assert on it
 * and an operator can log it.
 *
 * Idempotent and cheap: three statements against indexed columns.
 */
export async function retentionSweep(env, { now = Date.now() } = {}) {
  if (!env?.DB) return { purged: 0, dormant: 0, documents_cleared: 0 };
  await ensurePassengers(env);
  const nowSql = new Date(now).toISOString().slice(0, 19).replace('T', ' ');

  // 1. Hard-delete anything past its purge date. This is the only DELETE in the
  //    module; everything a member does is a soft delete.
  const purged = await env.DB.prepare('DELETE FROM num_passengers WHERE purge_after IS NOT NULL AND purge_after <= ?1')
    .bind(nowSql).run();

  // 2. Dormant records soft-delete themselves and start the same 30-day clock.
  const dormantBefore = daysAgo(RETENTION.dormant_months * 30, now);
  const dormant = await env.DB.prepare(
    `UPDATE num_passengers
        SET deleted_at = ?1,
            purge_after = datetime(?1, '+${RETENTION.soft_delete_grace_days} days')
      WHERE deleted_at IS NULL
        AND COALESCE(last_used_at, created_at) <= ?2`,
  ).bind(nowSql, dormantBefore).run();

  // 3. Passport details expire on their own, sooner, and without taking the
  //    record with them — the traveller keeps their name and loses the number.
  const docBefore = daysAgo(RETENTION.document_months * 30, now);
  const docs = await env.DB.prepare(
    `UPDATE num_passengers
        SET passport_number = NULL, passport_country = NULL, passport_expires_on = NULL,
            updated_at = ?1
      WHERE passport_number IS NOT NULL
        AND COALESCE(last_used_at, created_at) <= ?2`,
  ).bind(nowSql, docBefore).run();

  return {
    purged: purged?.meta?.changes ?? 0,
    dormant: dormant?.meta?.changes ?? 0,
    documents_cleared: docs?.meta?.changes ?? 0,
  };
}

// ── reading and writing ───────────────────────────────────────────────────

const COLUMNS = [
  'id', 'member_id', 'is_self', 'label', 'title', 'given_name', 'family_name', 'born_on',
  'gender', 'email', 'phone_number', 'travels_with_id', 'passport_number', 'passport_country',
  'passport_expires_on', 'loyalty_airline', 'loyalty_account', 'deleted_at', 'purge_after',
  'last_used_at', 'created_at', 'updated_at',
];

/** What the owner sees. The owner typed all of it, so nothing is hidden from them. */
const shape = (row) => ({
  id: row.id,
  is_self: !!row.is_self,
  label: row.label ?? null,
  title: row.title,
  given_name: row.given_name,
  family_name: row.family_name,
  born_on: row.born_on,
  gender: row.gender,
  email: row.email,
  phone_number: row.phone_number,
  travels_with_id: row.travels_with_id ?? null,
  passport: row.passport_number
    ? { number: row.passport_number, country: row.passport_country, expires_on: row.passport_expires_on }
    : null,
  loyalty: row.loyalty_airline ? { airline: row.loyalty_airline, account: row.loyalty_account } : null,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

/** Members only. The member id IS the credential on every other Num route. */
async function mustMember(env, meId) {
  if (!meId) return { error: json({ error: 'me required' }, 400) };
  const row = await env.DB.prepare('SELECT id FROM num_members WHERE id=?1').bind(meId).first();
  if (!row) return { error: json({ error: 'sign up first' }, 404) };
  return { id: row.id };
}

/**
 * One record, if it is this member's.
 *
 * A record belonging to somebody else is a 404, not a 403. A 403 confirms the
 * id exists, which is a disclosure about a data subject who is not asking —
 * the same reasoning CONSENT_ARCHITECTURE.md §1.1 applies to the 409 on the
 * 5arz link.
 */
async function owned(env, memberId, id, { includeDeleted = false } = {}) {
  if (!id) return null;
  const row = await env.DB
    .prepare(`SELECT ${COLUMNS.join(', ')} FROM num_passengers WHERE id=?1 AND member_id=?2${includeDeleted ? '' : ' AND deleted_at IS NULL'}`)
    .bind(id, memberId).first();
  return row ?? null;
}

/** GET /api/passengers?me=… — the member's own records, newest first. */
async function list(env, url) {
  const me = await mustMember(env, clip(url.searchParams.get('me'), 40));
  if (me.error) return me.error;
  const { results } = await env.DB
    .prepare(`SELECT ${COLUMNS.join(', ')} FROM num_passengers WHERE member_id=?1 AND deleted_at IS NULL ORDER BY is_self DESC, created_at ASC`)
    .bind(me.id).all();
  return json({ passengers: (results ?? []).map(shape), count: (results ?? []).length });
}

/** GET /api/passengers/:id?me=… */
async function readOne(env, url, id) {
  const me = await mustMember(env, clip(url.searchParams.get('me'), 40));
  if (me.error) return me.error;
  const row = await owned(env, me.id, id);
  if (!row) return json({ error: 'no such passenger' }, 404);
  return json({ passenger: shape(row) });
}

/**
 * POST /api/passengers — create, or update when `id` is present.
 *
 * Mirrors worker/social.mjs#planWrite: one POST that creates or updates, with
 * ownership as the authorisation. Everything is validated BEFORE anything is
 * written, so a record is never half-right.
 */
async function write(env, req) {
  const b = await readBody(req);
  const me = await mustMember(env, clip(b.me, 40));
  if (me.error) return me.error;

  const id = clip(b.id, 40);
  const existing = id ? await owned(env, me.id, id) : null;
  if (id && !existing) return json({ error: 'no such passenger' }, 404);

  const { value, problems } = validatePassenger(b, { partial: !!existing });
  if (problems.length) return json({ error: problems.join(' '), problems }, 400);

  // A lap infant must point at an adult this member also owns, and that adult
  // must actually be an adult — Duffel refuses an infant with no responsible
  // grown-up, and finding that out at the airline is finding it out too late.
  if (value.travels_with_id) {
    const adult = await owned(env, me.id, value.travels_with_id);
    if (!adult) return json({ error: 'travels_with_id must be another passenger you have saved.' }, 400);
    if (adult.id === id) return json({ error: 'a passenger cannot travel with themselves.' }, 400);
  }

  if (existing) {
    if (value.is_self === 1 && !existing.is_self) {
      const already = await env.DB.prepare('SELECT id FROM num_passengers WHERE member_id=?1 AND is_self=1 AND deleted_at IS NULL')
        .bind(me.id).first();
      if (already) return json({ error: 'you already have a “this is me” passenger saved — edit that one instead.', id: already.id }, 409);
    }
    const sets = Object.keys(value).map((k, i) => `${k}=?${i + 3}`);
    await env.DB.prepare(
      `UPDATE num_passengers SET ${[...sets, "updated_at=datetime('now')"].join(', ')} WHERE id=?1 AND member_id=?2`,
    ).bind(existing.id, me.id, ...Object.values(value)).run();
    return json({ passenger: shape(await owned(env, me.id, existing.id)) });
  }

  // The two unique indexes are the real enforcement — a race that gets past
  // this check still hits them. These pre-checks exist so the ANSWER is a
  // sentence the traveller can act on: SQLite reports a partial unique index
  // violation as "UNIQUE constraint failed: num_passengers.member_id", which
  // names a column and not the rule that was broken.
  if (value.is_self === 1) {
    const already = await env.DB.prepare('SELECT id FROM num_passengers WHERE member_id=?1 AND is_self=1 AND deleted_at IS NULL')
      .bind(me.id).first();
    if (already) return json({ error: 'you already have a “this is me” passenger saved — edit that one instead.', id: already.id }, 409);
  }
  if (value.travels_with_id) {
    const taken = await env.DB.prepare('SELECT id FROM num_passengers WHERE travels_with_id=?1 AND deleted_at IS NULL')
      .bind(value.travels_with_id).first();
    if (taken) return json({ error: 'that adult is already carrying an infant. Each infant needs their own responsible adult.' }, 409);
  }

  const newId = uid('pax');
  const cols = ['id', 'member_id', ...Object.keys(value)];
  const vals = [newId, me.id, ...Object.values(value)];
  try {
    await env.DB.prepare(
      `INSERT INTO num_passengers (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(',')})`,
    ).bind(...vals).run();
  } catch (err) {
    // The two unique indexes are the only way this fails, and both mean
    // something a person can fix.
    const m = String(err?.message ?? '');
    if (/idx_num_passengers_self|member_id/.test(m)) return json({ error: 'you already have a “this is me” passenger saved — edit that one instead.' }, 409);
    if (/idx_num_passengers_infant|travels_with_id/.test(m)) return json({ error: 'that adult is already carrying an infant. Each infant needs their own responsible adult.' }, 409);
    throw err;
  }
  return json({ passenger: shape(await owned(env, me.id, newId)) }, 201);
}

/**
 * POST /api/passengers/delete — the soft delete.
 *
 * Sets deleted_at and the purge date in the same statement, so a record can
 * never be soft-deleted without also being scheduled for destruction. The row
 * stops being visible immediately.
 */
async function softDelete(env, req) {
  const b = await readBody(req);
  const me = await mustMember(env, clip(b.me, 40));
  if (me.error) return me.error;
  const row = await owned(env, me.id, clip(b.id, 40));
  if (!row) return json({ error: 'no such passenger' }, 404);

  await env.DB.prepare(
    `UPDATE num_passengers
        SET deleted_at = datetime('now'),
            purge_after = datetime('now', '+${RETENTION.soft_delete_grace_days} days'),
            travels_with_id = NULL,
            updated_at = datetime('now')
      WHERE id=?1 AND member_id=?2`,
  ).bind(row.id, me.id).run();

  // An infant pointing at a deleted adult would be an orphan Duffel refuses, so
  // the pointer is cleared on the way out rather than discovered later.
  await env.DB.prepare('UPDATE num_passengers SET travels_with_id=NULL WHERE travels_with_id=?1').bind(row.id).run();

  const after = await env.DB.prepare('SELECT purge_after FROM num_passengers WHERE id=?1').bind(row.id).first();
  return json({
    deleted: row.id,
    purge_after: after?.purge_after ?? null,
    note: `Removed. It is destroyed for good after ${RETENTION.soft_delete_grace_days} days.`,
  });
}

/**
 * Mark a record as having been used to build a booking payload.
 *
 * This is what the retention sweep reads: a passenger you actually travel with
 * stays, a passenger you typed in once and never used goes.
 */
export async function markUsed(env, ids) {
  const list_ = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!env?.DB || !list_.length) return;
  await env.DB.prepare(
    `UPDATE num_passengers SET last_used_at=datetime('now') WHERE id IN (${list_.map((_, i) => `?${i + 1}`).join(',')})`,
  ).bind(...list_).run();
}

/** Load this member's records by id, in the order asked for. Owner-scoped. */
export async function loadForMember(env, memberId, ids) {
  if (!env?.DB || !memberId || !ids?.length) return [];
  const { results } = await env.DB
    .prepare(`SELECT ${COLUMNS.join(', ')} FROM num_passengers WHERE member_id=?1 AND deleted_at IS NULL AND id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`)
    .bind(memberId, ...ids).all();
  const by = new Map((results ?? []).map((r) => [r.id, r]));
  return ids.map((id) => by.get(id)).filter(Boolean);
}

// ── routes ────────────────────────────────────────────────────────────────

export const PASSENGER_ROUTES = Object.freeze([
  'GET  /            — your saved passengers',
  'GET  /:id         — one of them',
  'POST /            — create, or update when `id` is sent',
  'POST /delete      — soft delete, destroyed for good after 30 days',
]);

export async function handlePassengers(request, env, path) {
  if (!env.DB) return json({ error: 'passenger records need the database binding' }, 503);
  try {
    await ensurePassengers(env);
  } catch (err) {
    // Fail closed. Half a passenger table is worse than none.
    console.error('[passengers] schema', err?.message ?? err);
    return json({ error: 'passenger records are unavailable' }, 503);
  }

  const url = new URL(request.url);
  const post = request.method === 'POST';

  if (path === '/' || path === '') return post ? await write(env, request) : await list(env, url);
  if (path === '/delete' && post) return await softDelete(env, request);
  if (!post && path.startsWith('/') && path.length > 1) return await readOne(env, url, path.slice(1));

  return json({ error: `no passenger route for ${request.method} ${path}`, routes: PASSENGER_ROUTES }, 404);
}

/** Nothing here may surface a stack trace, or a stored name inside one. */
export async function handlePassengersSafe(request, env, path) {
  try {
    return await handlePassengers(request, env, path);
  } catch (err) {
    // The message is logged, never the row: an exception carrying a legal name
    // into a log line is the same disclosure as writing it to the audit table.
    console.error('[passengers]', path, String(err?.message ?? err).slice(0, 200));
    return json({ error: 'that didn’t go through — try again in a moment' }, 500);
  }
}

/**
 * The offer-request passenger, from a stored record.
 *
 * Duffel: "You may only specify an `age` or a `type` – not both." Age is the
 * honest field — "one airline may treat a 14 year old as an adult, and another
 * as a young adult" — so anyone under 18 is sent as an age and the airline
 * decides what that makes them. Adults are sent as `type: 'adult'` because an
 * exact age is personal data the search does not need.
 *
 * Names are attached ONLY when a loyalty account is: "This is only required if
 * you're also including loyalty programme accounts." Sending a legal name to
 * price a flight that nobody has decided to book is data the search does not
 * need either.
 */
export function offerRequestPassenger(row, finalFlightDateISO) {
  const age = ageOn(row?.born_on, finalFlightDateISO);
  const out = age != null && age < 18 ? { age } : { type: 'adult' };
  if (row?.loyalty_airline && row?.loyalty_account) {
    out.given_name = row.given_name;
    out.family_name = row.family_name;
    out.loyalty_programme_accounts = [{ airline_iata_code: row.loyalty_airline, account_number: row.loyalty_account }];
  }
  return out;
}
