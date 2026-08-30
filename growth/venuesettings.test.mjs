// The venue's own switches.
//
// Three columns decide what a venue is charged and what its guests are
// offered — f_bill_value, f_priority_seating and f_tips — and until today
// nothing in the repo could write any of them. So the tests here are mostly
// not about "does it save". They are about the four things a writable
// settings endpoint can get catastrophically wrong:
//
//   1. letting a venue set NUM's side of the deal (its own commission, its
//      own share of a priority fee),
//   2. writing a value the schema forbids, turning a typo into a 500,
//   3. leaving a switch ON that does nothing, so a venue believes guests are
//      being offered something no guest is ever offered,
//   4. collecting tips without the undertaking that they reach the staff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  FIELDS, LOCKED, TIPS_UNDERTAKING, asFlag, coerce, planChange,
  readSettings, writeSettings, settingHistory, _resetSchemaCache,
} from './venuesettings.mjs';
import { CAN, can } from './qrsystem.mjs';
import { PRIORITY_MAX_CS } from '../worker/aftertable.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WORKER = readFileSync(join(HERE, 'worker.js'), 'utf8');

/**
 * A real SQLite carrying the CHECK constraints the production table carries.
 *
 * The clamps in venuesettings.mjs exist to keep a bad request from reaching
 * these constraints. Testing against a table without them would test the
 * clamp against nothing.
 */
function env({ row = null } = {}) {
  _resetSchemaCache();
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE num_business_settings (
    business_id        TEXT PRIMARY KEY,
    f_bill_value       INTEGER NOT NULL DEFAULT 0 CHECK (f_bill_value IN (0,1)),
    f_priority_seating INTEGER NOT NULL DEFAULT 0 CHECK (f_priority_seating IN (0,1)),
    priority_max_cs    INTEGER NOT NULL DEFAULT 0
                       CHECK (priority_max_cs >= 0 AND priority_max_cs <= 2000),
    priority_share_bps INTEGER NOT NULL DEFAULT 4000
                       CHECK (priority_share_bps BETWEEN 0 AND 10000),
    f_tips             INTEGER NOT NULL DEFAULT 0 CHECK (f_tips IN (0,1)),
    tips_terms_at      INTEGER,
    tips_terms_by      TEXT,
    commission_bp      INTEGER NOT NULL DEFAULT 1000
                       CHECK (commission_bp BETWEEN 0 AND 10000),
    booking_fee_cs     INTEGER NOT NULL DEFAULT 200 CHECK (booking_fee_cs >= 0),
    updated_at         INTEGER NOT NULL,
    updated_by         TEXT)`);
  if (row) {
    const cols = Object.keys(row);
    d.prepare(`INSERT INTO num_business_settings (${cols.join(',')},updated_at)
               VALUES (${cols.map(() => '?').join(',')},0)`).run(...cols.map((c) => row[c]));
  }
  const DB = {
    prepare(q) {
      let args = [];
      const stmt = {
        bind: (...a) => { args = a; return stmt; },
        run: async () => { d.prepare(q).run(...args.map((v) => v ?? null)); return { meta: {} }; },
        first: async () => d.prepare(q).get(...args.map((v) => v ?? null)) ?? null,
        all: async () => ({ results: d.prepare(q).all(...args.map((v) => v ?? null)) }),
      };
      return stmt;
    },
  };
  return { DB, raw: d };
}

const BIZ = 'biz_1';

/* ══ 1. a venue may not set NUM's side of the deal ═══════════════════════ */

test('a venue cannot set its own commission', async () => {
  const e = env({ row: { business_id: BIZ } });
  const out = await writeSettings(e, { businessId: BIZ, patch: { commission_bp: 0 } });
  assert.equal(out.changed.length, 0);
  assert.equal(out.refused[0].field, 'commission_bp');
  assert.equal(
    e.raw.prepare('SELECT commission_bp AS c FROM num_business_settings').get().c,
    1000, 'the rate must be untouched',
  );
});

test('a venue cannot set its own share of a priority fee', async () => {
  // The one field on this table with a direct, arithmetic incentive to
  // change: priority_share_bps is what NUM pays OUT. 10000 = the venue keeps
  // the whole fee and NUM collects a payment it then owes away entirely.
  const e = env({ row: { business_id: BIZ } });
  const out = await writeSettings(e, { businessId: BIZ, patch: { priority_share_bps: 10000 } });
  assert.equal(out.refused[0].field, 'priority_share_bps');
  assert.equal(
    e.raw.prepare('SELECT priority_share_bps AS b FROM num_business_settings').get().b, 4000,
  );
});

test('a locked field is refused by name, never silently dropped', () => {
  // A silently ignored field is indistinguishable from an accepted one, and
  // these are exactly the fields somebody would have a motive to change
  // quietly. Every locked field carries a sentence, and it is a sentence.
  for (const [field, reason] of Object.entries(LOCKED)) {
    const p = planChange({}, { [field]: 1 });
    assert.equal(p.refused.length, 1, `${field} was not refused`);
    assert.equal(p.refused[0].field, field);
    assert.ok(reason.length > 15 && /[a-z]/.test(reason), `${field}: reason reads as an error code`);
    assert.deepEqual(p.sets, {}, `${field} reached the SET list`);
  }
});

test('the settable and the locked sets never overlap', () => {
  for (const f of Object.keys(FIELDS)) {
    assert.equal(f in LOCKED, false, `${f} is both settable and locked`);
  }
});

/* ══ 2. no request may write a value the schema forbids ═════════════════ */

test('a ceiling above $20 is clamped, not rejected and not written', async () => {
  const e = env({ row: { business_id: BIZ } });
  const out = await writeSettings(e, {
    businessId: BIZ, patch: { priority_max_cs: 20000, f_priority_seating: 1 },
  });
  assert.equal(out.ok, true);
  const r = e.raw.prepare('SELECT priority_max_cs AS m FROM num_business_settings').get();
  assert.equal(r.m, PRIORITY_MAX_CS, 'clamped to the ceiling the migration CHECKs');
});

test('every integer field clamps to exactly what its CHECK allows', async () => {
  for (const [field, spec] of Object.entries(FIELDS)) {
    if (spec.type !== 'int') continue;
    assert.equal(coerce(field, spec.max + 1), spec.max, `${field} over max`);
    assert.equal(coerce(field, -1), spec.min ?? 0, `${field} under min`);
    assert.equal(coerce(field, 'nonsense'), spec.min ?? 0, `${field} garbage`);
  }
});

test('a flag accepts every shape JSON and a form send', () => {
  for (const yes of [true, 1, '1', 'true', 'on', 'yes']) assert.equal(asFlag(yes), 1, String(yes));
  for (const no of [false, 0, '0', null, undefined, '', 'off', 'banana']) assert.equal(asFlag(no), 0, String(no));
});

test('a garbage flag value never reaches the database as garbage', async () => {
  const e = env({ row: { business_id: BIZ } });
  await writeSettings(e, { businessId: BIZ, patch: { f_bill_value: 'banana' } });
  const v = e.raw.prepare('SELECT f_bill_value AS v FROM num_business_settings').get().v;
  assert.equal(v, 0, 'the CHECK would have thrown on anything else');
});

/* ══ 3. a switch that is on must do something ═══════════════════════════ */

test('priority seating cannot be switched on without a ceiling', async () => {
  // aftertable.prioritySeating() returns null when max_cs is 0. Allowing this
  // would give the venue a toggle that reads "on" while no guest is ever
  // offered anything — the worst state, because it is invisible from both
  // sides.
  const e = env({ row: { business_id: BIZ } });
  const out = await writeSettings(e, { businessId: BIZ, patch: { f_priority_seating: 1 } });
  assert.equal(out.refused[0].field, 'f_priority_seating');
  assert.match(out.refused[0].reason, /amount|asked for/i);
  assert.equal(e.raw.prepare('SELECT f_priority_seating AS f FROM num_business_settings').get().f, 0);
});

test('priority seating switches on when the ceiling arrives in the same save', async () => {
  const e = env({ row: { business_id: BIZ } });
  const out = await writeSettings(e, {
    businessId: BIZ, patch: { f_priority_seating: 1, priority_max_cs: 1000 },
  });
  assert.equal(out.refused.length, 0);
  const r = e.raw.prepare('SELECT f_priority_seating AS f, priority_max_cs AS m FROM num_business_settings').get();
  assert.deepEqual([r.f, r.m], [1, 1000]);
});

test('a venue already carrying a ceiling may switch priority on alone', async () => {
  const e = env({ row: { business_id: BIZ, priority_max_cs: 500 } });
  const out = await writeSettings(e, { businessId: BIZ, patch: { f_priority_seating: 1 } });
  assert.equal(out.refused.length, 0);
  assert.equal(e.raw.prepare('SELECT f_priority_seating AS f FROM num_business_settings').get().f, 1);
});

/* ══ 4. tips need the undertaking ═══════════════════════════════════════ */

test('tips cannot be switched on without accepting the undertaking', async () => {
  const e = env({ row: { business_id: BIZ } });
  const out = await writeSettings(e, { businessId: BIZ, patch: { f_tips: 1 } });
  assert.equal(out.refused[0].field, 'f_tips');
  assert.equal(out.refused[0].reason, TIPS_UNDERTAKING);
  assert.equal(e.raw.prepare('SELECT f_tips AS f FROM num_business_settings').get().f, 0);
});

test('the undertaking names who may not keep a tip', () => {
  // 29 U.S.C. §203(m)(2)(B). A vague "tips go to staff" is not the promise;
  // the promise is that no owner, manager or supervisor takes a share.
  for (const word of ['owner', 'manager', 'supervisor', 'staff']) {
    assert.match(TIPS_UNDERTAKING, new RegExp(word, 'i'), `undertaking omits "${word}"`);
  }
});

test('accepting stamps who accepted and when, in the same write', async () => {
  const e = env({ row: { business_id: BIZ } });
  const out = await writeSettings(e, {
    businessId: BIZ, patch: { f_tips: 1, tips_terms: true }, by: 'nina@venue.example',
  });
  assert.equal(out.refused.length, 0);
  const r = e.raw.prepare('SELECT f_tips AS f, tips_terms_at AS at, tips_terms_by AS by_ FROM num_business_settings').get();
  assert.equal(r.f, 1);
  assert.ok(r.at > 1_700_000_000, 'no timestamp on the acceptance');
  assert.equal(r.by_, 'nina@venue.example');
});

test('a venue that accepted once may switch tips off and on again', async () => {
  // The acceptance is a historical fact. Re-asking for it would imply it
  // could be un-given, which it cannot.
  const e = env({ row: { business_id: BIZ, f_tips: 0, tips_terms_at: 1_750_000_000, tips_terms_by: 'nina' } });
  const out = await writeSettings(e, { businessId: BIZ, patch: { f_tips: 1 } });
  assert.equal(out.refused.length, 0);
  assert.equal(e.raw.prepare('SELECT f_tips AS f FROM num_business_settings').get().f, 1);
  assert.equal(
    e.raw.prepare('SELECT tips_terms_at AS t FROM num_business_settings').get().t,
    1_750_000_000, 'the original acceptance date must not be rewritten',
  );
});

/* ══ scoped to venues where the product means something ═════════════════ */

test('a hotel is refused priority seating and tips, with a reason', () => {
  const p = planChange({}, { f_priority_seating: 1, priority_max_cs: 500, f_tips: 1, tips_terms: 1 },
    { foodAndDrink: false });
  const fields = p.refused.map((r) => r.field).sort();
  assert.deepEqual(fields, ['f_priority_seating', 'f_tips', 'priority_max_cs']);
  assert.deepEqual(p.sets, {});
});

test('a hotel may still switch bill value on', () => {
  const p = planChange({}, { f_bill_value: 1 }, { foodAndDrink: false });
  assert.deepEqual(p.sets, { f_bill_value: 1 });
});

test('every food-and-drink-only field is one the consumer also scopes', () => {
  // If this file scoped a field that aftertable/commission did not, a venue
  // would be told "not for you" about something it was in fact being charged
  // or offered. Both sides read foodAndDrink().
  const after = readFileSync(join(HERE, '../worker/aftertable.mjs'), 'utf8');
  for (const [f, spec] of Object.entries(FIELDS)) {
    if (!spec.foodAndDrinkOnly) continue;
    assert.match(after, /foodAndDrink\(place\)/, `${f} is scoped here but not at the consumer`);
  }
});

/* ══ only switches with a consumer are shown ════════════════════════════ */

test('no dead switch is offered', () => {
  // The schema carries eleven f_* flags that nothing in this codebase reads.
  // A control panel full of switches that do nothing teaches a merchant that
  // none of the controls are real — including the three that are.
  for (const dead of [
    'f_bookings', 'f_booking_fee', 'f_deposits', 'f_orders', 'f_delivery',
    'f_sms_commerce', 'f_guest_list', 'f_cabanas', 'f_bottle_service',
    'f_perks', 'f_auto_confirm', 'cancel_window_min', 'hold_ttl_min',
  ]) {
    assert.equal(dead in FIELDS, false,
      `${dead} has no reader anywhere — add the consumer before the switch`);
  }
});

test('every offered switch names why it matters, in sentences', () => {
  for (const [f, spec] of Object.entries(FIELDS)) {
    assert.ok(spec.label && spec.label.length > 4, `${f} has no label`);
    assert.ok(spec.why && spec.why.length > 40, `${f} has no explanation`);
    assert.doesNotMatch(spec.label, /_/, `${f} label is a column name, not English`);
  }
});

test('f_bill_value says what it costs, both ways', () => {
  // A venue switching this on moves from a fee NUM can always collect to one
  // that depends on them reporting. If the copy does not say that, the venue
  // finds out from an invoice.
  assert.match(FIELDS.f_bill_value.why, /\$2/);
  assert.match(FIELDS.f_bill_value.why, /10%/);
});

/* ══ nothing changed is not a change ════════════════════════════════════ */

test('re-saving the same values writes nothing and logs nothing', async () => {
  const e = env({ row: { business_id: BIZ, f_bill_value: 1 } });
  const out = await writeSettings(e, { businessId: BIZ, patch: { f_bill_value: 1 } });
  assert.deepEqual(out.changed, []);
  assert.equal((await settingHistory(e, BIZ)).length, 0,
    'a no-op must not fill the audit log with noise');
});

test('an unknown field is reported, not silently swallowed', () => {
  const p = planChange({}, { f_teleportation: 1 });
  assert.deepEqual(p.ignored, ['f_teleportation']);
  assert.deepEqual(p.sets, {});
});

/* ══ the audit log ══════════════════════════════════════════════════════ */

test('every change records what it was, what it became, and who did it', async () => {
  const e = env({ row: { business_id: BIZ } });
  await writeSettings(e, {
    businessId: BIZ, patch: { f_bill_value: 1 }, by: 'key', via: 'key', ip: '1.2.3.4',
  });
  const log = await settingHistory(e, BIZ);
  assert.equal(log.length, 1);
  assert.equal(log[0].field, 'f_bill_value');
  assert.equal(log[0].was, '0');
  assert.equal(log[0].now, '1');
  assert.equal(log[0].changed_by, 'key');
  // "We were charged 10% of the bill in March — who agreed to that?" is a
  // question a merchant asks months later, and the settings row alone cannot
  // answer it.
  assert.equal(log[0].via, 'key');
});

/* ══ a business that predates the settings row ══════════════════════════ */

test('a venue with no settings row gets one rather than an error', async () => {
  const e = env();                                   // no row at all
  const before = await readSettings(e, BIZ);
  assert.equal(before.commission_bp, 1000, 'defaults must match the schema defaults');
  const out = await writeSettings(e, { businessId: BIZ, patch: { f_bill_value: 1 } });
  assert.equal(out.ok, true);
  assert.equal(e.raw.prepare('SELECT f_bill_value AS v FROM num_business_settings').get().v, 1);
});

/* ══ who may do this ════════════════════════════════════════════════════ */

test('settings is the owner\'s, not a manager\'s', () => {
  assert.equal(can('owner', 'settings'), true);
  assert.equal(can('manager', 'settings'), false, 'a manager runs a shift, not the contract');
  assert.equal(can('staff', 'settings'), false);
  assert.equal(can('readonly', 'settings'), false);
  assert.equal(CAN.owner.includes('settings'), true);
});

/* ══ the routes ═════════════════════════════════════════════════════════ */

test('the settings API is registered, and reading is not writing', () => {
  assert.match(WORKER, /p === "\/api\/venue\/settings" && req\.method === "GET"/);
  assert.match(WORKER, /p === "\/api\/venue\/settings" && req\.method === "POST"/);
  assert.match(WORKER, /p === "\/biz\/settings"/);
});

test('every venue console page can reach settings', () => {
  // A page nobody can navigate to is a page nobody uses. Five navs, five links.
  const links = WORKER.match(/href="\/biz\/settings\?k=/g) || [];
  assert.ok(links.length >= 5, `only ${links.length} navs link to settings`);
});

test('the settings handlers go through the role gate, not bizAuth alone', () => {
  const fn = WORKER.slice(WORKER.indexOf('async function settingsWho('));
  assert.match(fn.slice(0, 400), /QR\.can\(who\.role, "settings"\)/);
  for (const h of ['venueSettingsGet', 'venueSettingsSet', 'venueSettingsPage']) {
    const body = WORKER.slice(WORKER.indexOf(`async function ${h}(`));
    assert.match(body.slice(0, 300), /settingsWho\(req, env, url\)/, `${h} skips the gate`);
  }
});

test('the settings response never carries the console key', () => {
  const body = WORKER.slice(
    WORKER.indexOf('async function venueSettingsGet('),
    WORKER.indexOf('async function venueSettingsSet('),
  );
  assert.doesNotMatch(body, /console_key/);
});
