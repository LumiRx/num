/**
 * NUM · the passenger record.
 *
 * WHAT THESE PROVE, AND HOW
 *
 * Not by reading the source. Nineteen of the fifty-odd test files in this repo
 * assert on the TEXT of the module they cover, which passes happily when the
 * code is right-looking and wrong. Everything here imports the real modules and
 * drives real `Request`s — through `handlePassengersSafe` and, for the wiring
 * and gate questions, through the REAL Worker in `worker/index.mjs` — against a
 * REAL SQLite database running the REAL schema. A regression fails here
 * whatever it is spelled like.
 *
 * The list:
 *   · every field Duffel requires is required, and named when it is missing
 *   · every format Duffel publishes is enforced — date, title, gender, E.164,
 *     the name charset, the 130-year age cap
 *   · a companion who will never install Num can be saved; a second "this is
 *     me" cannot
 *   · a soft delete disappears from the API and schedules its own destruction
 *   · members only, and one member cannot see another's record
 *   · a date of birth and a legal name reach neither a model prompt nor an
 *     audit row
 *   · a passenger record cannot leave Num — the crossing guard throws, and no
 *     passenger endpoint ever touches the 5arz ledger binding
 *   · the Duffel commit gate is still shut
 *
 *   node --test worker/passengers.test.mjs
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import {
  handlePassengersSafe, validatePassenger, retentionSweep, RETENTION, TITLES, GENDERS,
  SCHEMA, statementsOf, assertNoPassengerData, findPassengerData, crossingScopeFor,
  PASSENGER_PII_FIELDS, ageOn, paxTypeOn, isRealDate, offerRequestPassenger, loadForMember, markUsed,
} from './passengers.mjs';
import { passengerFromRecord, orderPassengersFromRecords, validateOrder, redact as auditRedact, PASSENGER_FIELDS } from './duffel.mjs';
import { isIdentifying, redactProfile, redactState } from './redact.mjs';
import { handleSocialSafe } from './social.mjs';
import { callAir } from './air.mjs';

// ── a D1 that is actually SQLite ───────────────────────────────────────────
//
// Same shim as worker/social.takeover.test.mjs, and for the same reason: what
// is under test here is decided by which row a WHERE clause finds and by
// whether a UNIQUE index fires. A hand-written fake returning canned rows
// cannot answer either question.

function d1(db, onPrepare) {
  const shape = (sql, args) => ({
    all: async () => {
      const stmt = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: stmt.all(...args), success: true };
      stmt.run(...args);
      return { results: [], success: true };
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
    },
  });
  return {
    prepare(sql) {
      onPrepare?.(sql);
      const bound = (args) => ({ bind: (...more) => bound([...args, ...more]), ...shape(sql, args) });
      return bound([]);
    },
    batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
  };
}

const db = new DatabaseSync(':memory:');
// social.mjs writes a member's referral code into the num-claim Worker's table
// during signup. Without it every signup fails and nothing below means anything.
db.exec(`CREATE TABLE IF NOT EXISTS num_referral_codes (
  code TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT, reward_cs INTEGER, reward_referee_cs INTEGER,
  max_conversions INTEGER, max_reward_total_cs INTEGER, active INTEGER, created_at INTEGER)`);

/**
 * The 5arz production ledger binding, as a tripwire.
 *
 * `wrangler.app.jsonc` binds LEDGER to the parent's live D1 with full write
 * authority (CONSENT_ARCHITECTURE.md §1.3). Every statement prepared against it
 * is recorded here, so "no passenger data crosses to 5arz" is a thing the test
 * suite watches rather than a thing a comment claims.
 */
const ledgerTouches = [];
const env = {
  DB: d1(db),
  LEDGER: d1(new DatabaseSync(':memory:'), (sql) => ledgerTouches.push(sql)),
  NUM_APP_ORIGIN: 'https://app.itsnum.com',
};

// Nothing in this file is allowed to leave the machine.
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async (url, init) => {
  outbound.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ?? null });
  throw new Error(`unexpected fetch: ${url}`);
};

let ip = 0;
const nextIp = () => `203.0.113.${(ip++ % 250) + 1}`;

const post = (path, body) =>
  handlePassengersSafe(
    new Request(`https://app.itsnum.com/api/passengers${path === '/' ? '' : path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
      body: JSON.stringify(body),
    }),
    env,
    path,
  );

const get = (path) =>
  handlePassengersSafe(
    new Request(`https://app.itsnum.com/api/passengers${path === '/' ? '' : path}`, { headers: { 'CF-Connecting-IP': nextIp() } }),
    env,
    path.split('?')[0] || '/',
  );

const read = async (res) => ({ status: res.status, body: await res.json() });

/** A real member row, made the way the app makes one. */
async function member(name) {
  const id = `mem_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const res = await handleSocialSafe(
    new Request('https://app.itsnum.com/api/social/me', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
      body: JSON.stringify({ id, name }),
    }),
    env,
    '/me',
  );
  const body = await res.json();
  assert.ok(body.me?.id, `member setup failed: ${JSON.stringify(body)}`);
  return body.me.id;
}

/** A complete, valid passenger. Duffel's own documented example person. */
const AMELIA = {
  title: 'mrs',
  given_name: 'Amelia',
  family_name: 'Earhart',
  born_on: '1987-07-24',
  gender: 'f',
  email: 'amelia@example.com',
  phone_number: '+442080160509',
};

let ME = '';
let OTHER = '';

before(async () => {
  ME = await member('Dre');
  OTHER = await member('Somebody Else');
});

// ══ 1 · every field Duffel requires ══════════════════════════════════════

describe('the required set is exactly Duffel’s required set', () => {
  test('PASSENGER_FIELDS matches the create-order schema’s required list', () => {
    // https://duffel.com/docs/api/orders/create-order — "Order Request
    // Passenger", required: ["id","given_name","family_name","gender","title",
    // "born_on","email","phone_number"]. `id` is Duffel's per-offer handle and
    // is supplied from the live offer, never stored.
    assert.deepEqual(
      [...PASSENGER_FIELDS].sort(),
      ['born_on', 'email', 'family_name', 'gender', 'given_name', 'id', 'phone_number', 'title'],
    );
  });

  for (const field of ['title', 'given_name', 'family_name', 'born_on', 'gender', 'email', 'phone_number']) {
    test(`a record with no ${field} is refused, and the message names it`, async () => {
      const { [field]: _drop, ...rest } = AMELIA;
      const { status, body } = await read(await post('/', { me: ME, ...rest }));
      assert.equal(status, 400, `${field} was accepted as missing`);
      assert.match(body.error, new RegExp(field), `the refusal did not name ${field}: ${body.error}`);
    });
  }

  test('email and phone_number are required on EVERY passenger, not just the lead', () => {
    const complete = { ...AMELIA, id: 'pas_1' };
    const second = { ...complete, id: 'pas_2' };
    delete second.email;
    const problems = validateOrder({
      selected_offers: ['off_1'],
      type: 'instant',
      passengers: [complete, second],
      payments: [{ type: 'balance', amount: '45.00', currency: 'GBP' }],
    });
    assert.match(problems.join(' '), /passengers\[1\] is missing email/);
  });
});

// ══ 2 · formats ══════════════════════════════════════════════════════════

describe('formats, so a bad record fails in Num rather than at the airline', () => {
  const rejected = async (patch, why) => {
    const { status, body } = await read(await post('/', { me: ME, ...AMELIA, ...patch }));
    assert.equal(status, 400, `accepted: ${JSON.stringify(patch)}`);
    assert.match(body.error, why, body.error);
  };

  test('born_on: wrong shape', () => rejected({ born_on: '24/07/1987' }, /YYYY-MM-DD/));
  test('born_on: right shape, not a real date', () => rejected({ born_on: '2026-02-30' }, /not a real date/));
  test('born_on: in the future', () => rejected({ born_on: '2099-01-01' }, /future/));
  test('born_on: older than Duffel’s 130-year cap', () => rejected({ born_on: '1850-01-01' }, /130/));
  test('title: an honorific Duffel does not have', () => rejected({ title: 'prof' }, /mr, ms, mrs, miss, dr/));
  test('title: capitalised is normalised, not rejected', async () => {
    const { status, body } = await read(await post('/', { me: ME, ...AMELIA, title: 'MRS', label: 'caps' }));
    assert.equal(status, 201);
    assert.equal(body.passenger.title, 'mrs');
    await post('/delete', { me: ME, id: body.passenger.id });
  });
  test('gender: anything but m or f', () => rejected({ gender: 'x' }, /'m' or 'f'/));
  test('phone_number: no country code', () => rejected({ phone_number: '02080160509' }, /E\.164/));
  test('email: not an address', () => rejected({ email: 'amelia' }, /email/));
  test('name: characters outside Duffel’s charts', () => rejected({ family_name: 'Earhart2' }, /letters, spaces, hyphens/));
  test('name: the specific ligatures Duffel excludes', () => rejected({ family_name: 'Æthelred' }, /letters, spaces, hyphens/));
  test('name: accented Latin is fine — most of the world has one', async () => {
    const { status, body } = await read(await post('/', { me: ME, ...AMELIA, family_name: 'Ngô-Đăng', given_name: "O'Brien", label: 'accents' }));
    assert.equal(status, 201, JSON.stringify(body));
    await post('/delete', { me: ME, id: body.passenger.id });
  });
  test('name: given + family over 40 characters together', () =>
    rejected({ given_name: 'A'.repeat(21), family_name: 'B'.repeat(21) }, /40 characters/));
  test('passport: two of the three fields is not a passport', () =>
    rejected({ passport_number: '19KL56147', passport_country: 'GB' }, /all three/));
  test('passport: issuing country must be ISO 3166-1 alpha-2', () =>
    rejected({ passport_number: '19KL56147', passport_country: 'GBR', passport_expires_on: '2031-04-25' }, /alpha-2/));

  test('the enums are exactly what Duffel publishes', () => {
    assert.deepEqual([...TITLES], ['mr', 'ms', 'mrs', 'miss', 'dr']);
    assert.deepEqual([...GENDERS], ['m', 'f']);
  });

  test('nothing is written when validation fails', async () => {
    const before = db.prepare('SELECT COUNT(*) n FROM num_passengers').get().n;
    await post('/', { me: ME, ...AMELIA, gender: 'x', born_on: 'nope' });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM num_passengers').get().n, before, 'a half-valid record landed');
  });
});

// ══ 3 · self vs companion ════════════════════════════════════════════════

describe('the member, and the people they travel with', () => {
  test('a companion who will never install Num can be saved', async () => {
    const { status, body } = await read(await post('/', { me: ME, ...AMELIA, is_self: false, label: 'Mum' }));
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.passenger.is_self, false);
    assert.equal(body.passenger.label, 'Mum');
    assert.match(body.passenger.id, /^pax_/);
  });

  test('one "this is me" per member — a second is refused, not silently kept', async () => {
    const first = await read(await post('/', { me: ME, ...AMELIA, is_self: true, given_name: 'Dre' }));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await read(await post('/', { me: ME, ...AMELIA, is_self: true, given_name: 'Andre' }));
    assert.equal(second.status, 409, 'two legal names landed on one account');
    assert.match(second.body.error, /already have/);
  });

  test('the same person can be "me" on one account and a companion on another', async () => {
    const { status } = await read(await post('/', { me: OTHER, ...AMELIA, is_self: true }));
    assert.equal(status, 201);
  });

  test('an update changes only what was sent', async () => {
    const made = await read(await post('/', { me: ME, ...AMELIA, label: 'patchme', given_name: 'Bea' }));
    const id = made.body.passenger.id;
    const { status, body } = await read(await post('/', { me: ME, id, phone_number: '+66811110001' }));
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.passenger.phone_number, '+66811110001');
    assert.equal(body.passenger.given_name, 'Bea', 'an update wiped a field it was not given');
    assert.equal(body.passenger.born_on, AMELIA.born_on);
  });

  test('an update is validated to the same standard as a create', async () => {
    const made = await read(await post('/', { me: ME, ...AMELIA, label: 'strictpatch', given_name: 'Cal' }));
    const { status, body } = await read(await post('/', { me: ME, id: made.body.passenger.id, born_on: '2026-02-30' }));
    assert.equal(status, 400);
    assert.match(body.error, /not a real date/);
  });
});

// ══ 4 · infants ══════════════════════════════════════════════════════════

describe('the infant rule', () => {
  test('a lap infant must point at an adult the same member owns', async () => {
    const { status, body } = await read(
      await post('/', { me: ME, ...AMELIA, label: 'orphan', born_on: '2025-06-01', travels_with_id: 'pax_not_yours' }),
    );
    assert.equal(status, 400);
    assert.match(body.error, /another passenger you have saved/);
  });

  test('one adult, one infant — a second infant on the same adult is refused', async () => {
    const adult = (await read(await post('/', { me: OTHER, ...AMELIA, label: 'adult', given_name: 'Ada' }))).body.passenger.id;
    const one = await read(await post('/', { me: OTHER, ...AMELIA, label: 'baby1', given_name: 'Bo', born_on: '2025-06-01', travels_with_id: adult }));
    assert.equal(one.status, 201, JSON.stringify(one.body));
    const two = await read(await post('/', { me: OTHER, ...AMELIA, label: 'baby2', given_name: 'Cy', born_on: '2025-07-01', travels_with_id: adult }));
    assert.equal(two.status, 409, 'two infants were assigned to one adult');
    assert.match(two.body.error, /already carrying an infant/);
  });

  test('paxTypeOn reads Duffel’s age-0-or-1 rule off the date of the final flight', () => {
    assert.equal(paxTypeOn('2025-06-01', '2026-09-15'), 'infant_without_seat');
    assert.equal(paxTypeOn('2024-01-01', '2026-09-15'), 'child');
    assert.equal(paxTypeOn('1987-07-24', '2026-09-15'), 'adult');
    // The boundary is the birthday, not the year.
    assert.equal(ageOn('2024-09-16', '2026-09-15'), 1);
    assert.equal(ageOn('2024-09-15', '2026-09-15'), 2);
    assert.equal(isRealDate('2026-02-29'), false);
  });
});

// ══ 5 · soft delete ══════════════════════════════════════════════════════

describe('soft delete', () => {
  test('it disappears from the API, stays in the table, and schedules its own end', async () => {
    const made = await read(await post('/', { me: OTHER, ...AMELIA, label: 'doomed', given_name: 'Del' }));
    const id = made.body.passenger.id;

    const del = await read(await post('/delete', { me: OTHER, id }));
    assert.equal(del.status, 200);
    assert.equal(del.body.deleted, id);

    const one = await read(await get(`/${id}?me=${OTHER}`));
    assert.equal(one.status, 404, 'a deleted record is still readable');

    const listed = await read(await get(`/?me=${OTHER}`));
    assert.ok(!JSON.stringify(listed.body).includes(id), 'a deleted record is still listed');

    const row = db.prepare('SELECT deleted_at, purge_after FROM num_passengers WHERE id=?').get(id);
    assert.ok(row.deleted_at, 'nothing was soft-deleted');
    assert.ok(row.purge_after, 'a soft delete with no purge date is just hiding it forever');
    const gap = (Date.parse(`${row.purge_after}Z`) - Date.parse(`${row.deleted_at}Z`)) / 86_400_000;
    assert.equal(Math.round(gap), RETENTION.soft_delete_grace_days);
  });

  test('deleting an adult does not leave an infant pointing at a ghost', async () => {
    const adult = (await read(await post('/', { me: ME, ...AMELIA, label: 'ghostadult', given_name: 'Gus' }))).body.passenger.id;
    const baby = (await read(await post('/', { me: ME, ...AMELIA, label: 'ghostbaby', given_name: 'Gia', born_on: '2025-06-01', travels_with_id: adult }))).body.passenger.id;
    await post('/delete', { me: ME, id: adult });
    assert.equal(db.prepare('SELECT travels_with_id FROM num_passengers WHERE id=?').get(baby).travels_with_id, null);
  });

  test('deleting one that is not yours is a 404, which does not confirm it exists', async () => {
    const mine = (await read(await post('/', { me: ME, ...AMELIA, label: 'notyours', given_name: 'Nia' }))).body.passenger.id;
    const { status } = await read(await post('/delete', { me: OTHER, id: mine }));
    assert.equal(status, 404);
    assert.equal(db.prepare('SELECT deleted_at FROM num_passengers WHERE id=?').get(mine).deleted_at, null);
  });

  test('the purge is a real DELETE once the grace period is up', async () => {
    const made = await read(await post('/', { me: ME, ...AMELIA, label: 'purgeme', given_name: 'Pia' }));
    const id = made.body.passenger.id;
    await post('/delete', { me: ME, id });
    db.prepare("UPDATE num_passengers SET purge_after = datetime('now','-1 day') WHERE id=?").run(id);
    const out = await retentionSweep(env);
    assert.ok(out.purged >= 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM num_passengers WHERE id=?').get(id).n, 0, 'the row survived its purge date');
  });

  test('a dormant record soft-deletes itself, and a passport expires sooner than the record', async () => {
    const made = await read(await post('/', {
      me: ME, ...AMELIA, label: 'dormant', given_name: 'Dot',
      passport_number: '19KL56147', passport_country: 'GB', passport_expires_on: '2031-04-25',
    }));
    const id = made.body.passenger.id;

    // 13 months untouched: the passport goes, the record stays.
    db.prepare("UPDATE num_passengers SET last_used_at = datetime('now','-400 days') WHERE id=?").run(id);
    await retentionSweep(env);
    let row = db.prepare('SELECT passport_number, deleted_at FROM num_passengers WHERE id=?').get(id);
    assert.equal(row.passport_number, null, 'a passport number survived its 12-month clock');
    assert.equal(row.deleted_at, null, 'the whole record was deleted when only the document should have been');

    // 25 months untouched: the record goes too.
    db.prepare("UPDATE num_passengers SET last_used_at = datetime('now','-800 days') WHERE id=?").run(id);
    await retentionSweep(env);
    row = db.prepare('SELECT deleted_at, purge_after FROM num_passengers WHERE id=?').get(id);
    assert.ok(row.deleted_at, 'a record nobody has used in two years is still live');
    assert.ok(row.purge_after);
  });

  test('markUsed is what keeps a record alive', async () => {
    const made = await read(await post('/', { me: ME, ...AMELIA, label: 'used', given_name: 'Uma' }));
    const id = made.body.passenger.id;
    db.prepare("UPDATE num_passengers SET created_at = datetime('now','-800 days') WHERE id=?").run(id);
    await markUsed(env, [id]);
    await retentionSweep(env);
    assert.equal(db.prepare('SELECT deleted_at FROM num_passengers WHERE id=?').get(id).deleted_at, null);
  });
});

// ══ 6 · members only ═════════════════════════════════════════════════════

describe('members only, and one member at a time', () => {
  test('no `me` at all is a 400', async () => {
    assert.equal((await read(await post('/', AMELIA))).status, 400);
    assert.equal((await read(await get('/'))).status, 400);
  });

  test('a member id nobody signed up with is a 404, not a new account', async () => {
    const { status, body } = await read(await post('/', { me: 'mem_never_existed0001', ...AMELIA }));
    assert.equal(status, 404);
    assert.match(body.error, /sign up first/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM num_members WHERE id=?').get('mem_never_existed0001').n, 0);
  });

  test('one member cannot read another member’s passenger', async () => {
    const mine = (await read(await post('/', { me: ME, ...AMELIA, label: 'private', given_name: 'Pri' }))).body.passenger.id;
    const { status, body } = await read(await get(`/${mine}?me=${OTHER}`));
    assert.equal(status, 404, 'a passport record was readable by a stranger');
    // 404 rather than 403: a 403 confirms the id exists, which is itself a
    // disclosure about somebody who is not asking.
    assert.equal(body.error, 'no such passenger');
  });

  test('one member cannot update another member’s passenger', async () => {
    const mine = (await read(await post('/', { me: ME, ...AMELIA, label: 'private2', given_name: 'Pru' }))).body.passenger.id;
    const { status } = await read(await post('/', { me: OTHER, id: mine, given_name: 'Mallory' }));
    assert.equal(status, 404);
    assert.equal(db.prepare('SELECT given_name FROM num_passengers WHERE id=?').get(mine).given_name, 'Pru');
  });

  test('the list is scoped to the caller and nothing else', async () => {
    const { body } = await read(await get(`/?me=${ME}`));
    const ids = body.passengers.map((p) => p.id);
    const theirs = db.prepare('SELECT id FROM num_passengers WHERE member_id=? AND deleted_at IS NULL').all(OTHER).map((r) => r.id);
    assert.equal(theirs.some((id) => ids.includes(id)), false, 'another member’s records were in the list');
  });
});

// ══ 7 · redaction ════════════════════════════════════════════════════════

describe('a date of birth and a legal name reach neither a prompt nor an audit row', () => {
  test('worker/redact.mjs now recognises the passenger fields it used to miss', () => {
    // Before this change `\bname\b` did not match `given_name` — `_` is a word
    // character, so there is no boundary — and `birth` did not match `born_on`.
    // The three fields that make up a travel document were the three the
    // denylist did not cover.
    for (const f of ['given_name', 'family_name', 'born_on', 'gender', 'passport_number', 'passport_expires_on']) {
      assert.equal(isIdentifying(f, 'x'), true, `${f} would reach a model prompt`);
    }
  });

  test('a passenger record inside a profile does not survive redactProfile', () => {
    const { profile, removed } = redactProfile({ ...AMELIA, likes: 'window seat' });
    // Six of the seven go. `title` stays, deliberately: a plan has a title and
    // an item has a title, and redacting those would strip the concierge of the
    // thing it is reasoning about. An honorific with the other six fields gone
    // identifies nobody.
    assert.equal(removed, 6);
    assert.deepEqual(profile, { title: 'mrs', likes: 'window seat' });
  });

  test('a passenger record nested in trip state does not survive redactState', () => {
    const { state } = redactState({ trip: { flight: { passenger: AMELIA } } });
    const p = state.trip.flight.passenger;
    assert.equal(p.given_name, '[redacted]');
    assert.equal(p.family_name, '[redacted]');
    assert.equal(p.born_on, '[redacted]');
    assert.equal(p.gender, '[redacted]');
  });

  test('the Duffel audit redactor removes the legal name and the date of birth', () => {
    const out = auditRedact({
      selected_offers: ['off_1'],
      passengers: [{ ...AMELIA, id: 'pas_1', identity_documents: [{ type: 'passport', unique_identifier: '19KL56147', issuing_country_code: 'GB' }] }],
    });
    const p = out.passengers[0];
    for (const f of ['given_name', 'family_name', 'born_on', 'gender', 'title', 'email', 'phone_number']) {
      assert.equal(p[f], '<redacted>', `${f} was written into num_duffel_orders in the clear`);
    }
    assert.equal(p.identity_documents[0].unique_identifier, '<redacted>');
    assert.equal(p.identity_documents[0].issuing_country_code, '<redacted>');
    // The handle Duffel minted survives, because the audit row is about the
    // operation and an order that cannot be traced is not an audit.
    assert.equal(p.id, 'pas_1');
    assert.deepEqual(out.selected_offers, ['off_1']);
  });

  test('no stored value appears anywhere in the serialised audit row', () => {
    const s = JSON.stringify(auditRedact({ passengers: [AMELIA] }));
    assert.equal(s.includes('Earhart'), false);
    assert.equal(s.includes('1987-07-24'), false);
  });
});

// ══ 8 · the crossing rule ════════════════════════════════════════════════

describe('a passenger record cannot leave Num', () => {
  test('no consent scope authorises any passenger field — the answer is null, not "not yet"', () => {
    for (const f of PASSENGER_PII_FIELDS) assert.equal(crossingScopeFor(f), null, `${f} has a crossing scope`);
  });

  test('the guard finds passenger data by key shape', () => {
    assert.deepEqual(findPassengerData({ ok: 1 }), []);
    assert.deepEqual(findPassengerData({ traveller: { born_on: '1987-07-24' } }), ['traveller.born_on']);
    assert.ok(findPassengerData({ docs: [{ unique_identifier: 'x' }] }).length);
  });

  test('the guard finds a stored value hidden in an innocently-named field', () => {
    // The failure a key denylist cannot see: somebody copies the legal name
    // into `note` and it looks like free text.
    const hits = findPassengerData({ note: 'booked for Earhart' }, { values: ['Earhart', '1987-07-24'] });
    assert.equal(hits.length, 1);
    assert.match(hits[0], /passenger value/);
  });

  test('assertNoPassengerData throws rather than returning false', () => {
    assert.throws(() => assertNoPassengerData({ p: { family_name: 'Earhart' } }, 'test'), /must never leave Num/);
    assert.doesNotThrow(() => assertNoPassengerData({ availability: { day: 'tuesday' } }, 'test'));
  });

  test('a normal AiR contact — a name and an email — is NOT blocked', () => {
    // A guard that fires on ordinary traffic is a guard somebody deletes.
    assert.doesNotThrow(() =>
      assertNoPassengerData({ name: 'Dre', email: 'dre@example.com', phone: '+66811110001' }, 'test'));
  });

  test('callAir refuses to put a passenger record on the wire, before the fetch', async () => {
    outbound.length = 0;
    await assert.rejects(
      () => callAir(
        { AIR_MCP_URL: 'https://air.example.com/mcp', AIR_API_KEY: 'k', DB: env.DB },
        'manage_contact_add',
        { given_name: 'Amelia', family_name: 'Earhart', born_on: '1987-07-24' },
        { memberId: ME },
      ),
      /must never leave Num/,
    );
    assert.equal(outbound.length, 0, 'the payload left the building before the guard ran');
  });

  test('no passenger endpoint ever touches the 5arz ledger binding', async () => {
    ledgerTouches.length = 0;
    const made = await read(await post('/', { me: ME, ...AMELIA, label: 'ledgerwatch', given_name: 'Lex' }));
    await get(`/?me=${ME}`);
    await get(`/${made.body.passenger.id}?me=${ME}`);
    await post('/', { me: ME, id: made.body.passenger.id, given_name: 'Lexi' });
    await post('/delete', { me: ME, id: made.body.passenger.id });
    await retentionSweep(env);
    assert.deepEqual(ledgerTouches, [], `a passenger request prepared statements against the parent ledger: ${ledgerTouches.join(' | ')}`);
  });
});

// ══ 9 · the Duffel seam ══════════════════════════════════════════════════

describe('a stored record becomes a Duffel passenger payload', () => {
  test('passengerFromRecord produces exactly Duffel’s Order Request Passenger', async () => {
    const made = await read(await post('/', {
      me: OTHER, ...AMELIA, label: 'wire', given_name: 'Wren',
      passport_number: '19KL56147', passport_country: 'GB', passport_expires_on: '2031-04-25',
    }));
    const [row] = await loadForMember(env, OTHER, [made.body.passenger.id]);
    const p = passengerFromRecord(row, { id: 'pas_00009hj8USM7Ncg31cBCLL' });

    assert.deepEqual(p, {
      id: 'pas_00009hj8USM7Ncg31cBCLL',
      title: 'mrs',
      given_name: 'Wren',
      family_name: 'Earhart',
      born_on: '1987-07-24',
      gender: 'f',
      email: 'amelia@example.com',
      phone_number: '+442080160509',
      identity_documents: [{ type: 'passport', unique_identifier: '19KL56147', issuing_country_code: 'GB', expires_on: '2031-04-25' }],
    });
  });

  test('the payload it builds is one validateOrder accepts — no missing fields left', async () => {
    const made = await read(await post('/', { me: OTHER, ...AMELIA, label: 'valid', given_name: 'Van' }));
    const [row] = await loadForMember(env, OTHER, [made.body.passenger.id]);
    const problems = validateOrder({
      selected_offers: ['off_00009htyDGjIfajdNBZRlw'],
      type: 'instant',
      passengers: [passengerFromRecord(row, { id: 'pas_1' })],
      payments: [{ type: 'balance', amount: '45.00', currency: 'GBP' }],
    });
    assert.deepEqual(problems, [], problems.join(' '));
  });

  test('the infant association is flipped onto the adult, the way Duffel wants it', async () => {
    const adultId = (await read(await post('/', { me: OTHER, ...AMELIA, label: 'flipA', given_name: 'Fay' }))).body.passenger.id;
    const babyId = (await read(await post('/', { me: OTHER, ...AMELIA, label: 'flipB', given_name: 'Fen', born_on: '2025-06-01', travels_with_id: adultId }))).body.passenger.id;
    const rows = await loadForMember(env, OTHER, [adultId, babyId]);
    const { passengers, problems } = orderPassengersFromRecords(rows, ['pas_adult', 'pas_baby'], { finalFlightDate: '2026-09-15' });
    assert.deepEqual(problems, []);
    assert.equal(passengers[0].infant_passenger_id, 'pas_baby', 'the infant was not attached to the adult');
    assert.equal(passengers[1].infant_passenger_id, undefined, 'the infant is carrying itself');
  });

  test('an infant with no responsible adult is refused here, not by the airline', async () => {
    const babyId = (await read(await post('/', { me: OTHER, ...AMELIA, label: 'lone', given_name: 'Lou', born_on: '2025-06-01' }))).body.passenger.id;
    const rows = await loadForMember(env, OTHER, [babyId]);
    const { problems } = orderPassengersFromRecords(rows, ['pas_1'], { finalFlightDate: '2026-09-15' });
    assert.match(problems.join(' '), /responsible adult/);
  });

  test('a party of three priced against two records is a problem, not a two-person order', () => {
    const { passengers, problems } = orderPassengersFromRecords([{ id: 'a' }, { id: 'b' }], ['p1', 'p2', 'p3']);
    assert.deepEqual(passengers, []);
    assert.match(problems.join(' '), /priced for 3 passenger\(s\)/);
  });

  test('the offer request sends an age for a child and a bare type for an adult', () => {
    assert.deepEqual(offerRequestPassenger({ born_on: '2016-06-01' }, '2026-09-15'), { age: 10 });
    assert.deepEqual(offerRequestPassenger({ born_on: '1987-07-24' }, '2026-09-15'), { type: 'adult' });
    // Names ride along only when a loyalty account does — Duffel requires them
    // then, and nothing needs a legal name to price a seat otherwise.
    assert.deepEqual(
      offerRequestPassenger({ born_on: '1987-07-24', given_name: 'A', family_name: 'E', loyalty_airline: 'BA', loyalty_account: '12901014' }, '2026-09-15'),
      { type: 'adult', given_name: 'A', family_name: 'E', loyalty_programme_accounts: [{ airline_iata_code: 'BA', account_number: '12901014' }] },
    );
  });

  test('a Duffel passenger id is never stored — it belongs to one offer request', () => {
    const cols = db.prepare('PRAGMA table_info(num_passengers)').all().map((c) => c.name);
    assert.equal(cols.includes('duffel_passenger_id'), false);
    assert.equal(cols.some((c) => /pas_|duffel/.test(c)), false);
  });
});

// ══ 10 · the schema itself ═══════════════════════════════════════════════

describe('the schema', () => {
  test('the inlined SCHEMA and worker/migrations/0002_passengers.sql have not drifted', async () => {
    const file = await readFile(new URL('./migrations/0002_passengers.sql', import.meta.url), 'utf8');
    assert.deepEqual(statementsOf(SCHEMA), statementsOf(file));
  });

  test('every field Duffel requires is a NOT NULL column', () => {
    const info = db.prepare('PRAGMA table_info(num_passengers)').all();
    for (const c of ['title', 'given_name', 'family_name', 'born_on', 'gender', 'email', 'phone_number']) {
      const col = info.find((i) => i.name === c);
      assert.ok(col, `${c} is not a column`);
      assert.equal(col.notnull, 1, `${c} is nullable — a booking can be assembled without it`);
    }
  });

  test('the database refuses an out-of-enum title or gender even if the code lets one past', () => {
    assert.throws(
      () => db.prepare("INSERT INTO num_passengers (id, member_id, title, given_name, family_name, born_on, gender, email, phone_number) VALUES ('pax_x','m','prof','A','B','1987-07-24','f','a@b.com','+441')").run(),
      /CHECK/,
    );
    assert.throws(
      () => db.prepare("INSERT INTO num_passengers (id, member_id, title, given_name, family_name, born_on, gender, email, phone_number) VALUES ('pax_y','m','mr','A','B','1987-07-24','x','a@b.com','+441')").run(),
      /CHECK/,
    );
  });
});

// ══ 11 · the gate is still shut ══════════════════════════════════════════
//
// The passenger record model closes item 4 of the go-live gate
// (DUFFEL_INTEGRATION.md §10). It closes NOTHING ELSE, and in particular it
// does not open the commit path. These drive the REAL Worker, so a routing
// change made in the excitement of finishing item 4 fails here.

import worker from './index.mjs';

const hit = (path, e, init) =>
  worker.fetch(
    new Request(`https://app.itsnum.com${path}`, {
      ...init,
      headers: { 'CF-Connecting-IP': nextIp(), ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
    }),
    e,
    { waitUntil: () => {} },
  );

describe('the Duffel commit gate, after the passenger record shipped', () => {
  test('POST /api/duffel/order is STILL a 404 with every gate open', async () => {
    outbound.length = 0;
    const wideOpen = {
      DUFFEL_ACCESS_TOKEN: 'duffel_live_FAKE_FOR_TEST',
      DUFFEL_BOOKING_ENABLED: 'true',
      DUFFEL_BOOKING_LIVE: 'true',
      DB: env.DB,
    };
    const res = await hit('/api/duffel/order', wideOpen, {
      method: 'POST',
      body: JSON.stringify({ idem: 'k', order: { selected_offers: ['off_1'], passengers: [{ ...AMELIA, id: 'pas_1' }] } }),
    });
    assert.equal(res.status, 404, 'the ORDER CREATION path is routed — this books flights with real money');
    assert.equal(outbound.some((o) => o.url.includes('/air/orders')), false, 'a request reached Duffel’s order endpoint');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='num_duffel_orders'").get().n, 0, 'an order audit table appeared');
  });

  test('the passenger route IS wired, through the same real router', async () => {
    const res = await hit(`/api/passengers?me=${ME}`, env);
    assert.equal(res.status, 200, 'the passenger route is not reachable from the internet');
    const body = await res.json();
    assert.ok(Array.isArray(body.passengers));
  });

  test('the passenger route is members-only through the real router too', async () => {
    const res = await hit('/api/passengers?me=mem_not_a_member01', env);
    assert.equal(res.status, 404);
  });
});

globalThis.fetch = realFetch;
