/**
 * The venue's own switches.
 *
 * `num_business_settings` has existed since the business schema was written.
 * It carries twenty-odd columns, three of which decide what a venue is
 * charged and what its guests are offered. Until 26 Aug 2026 there was no
 * `UPDATE num_business_settings` anywhere in the repo — not in a venue route,
 * not in an admin route, not in worker/console.mjs. Every flag was created at
 * 0 by claim/onboard.mjs and stayed 0 for the life of the business. The
 * consumers in worker/commission.mjs and worker/aftertable.mjs have therefore
 * always taken the off-branch, every time, for every venue. This file is the
 * missing writer.
 *
 * Two rules shape everything below.
 *
 * ── 1. A venue may change what it commits to. It may not change what it pays.
 *
 * `commission_bp`, `booking_fee_cs` and `priority_share_bps` are the contract
 * between NUM and that venue. A settings endpoint that accepted them would
 * let anyone holding a console link set their own commission to zero and
 * their own share of a priority fee to 100%. They are listed in LOCKED, shown
 * read-only in the console, and refused by name — not silently dropped, so a
 * venue that tries learns that the number is not theirs to move rather than
 * believing it moved.
 *
 * ── 2. Only switches with a consumer appear.
 *
 * The schema has eleven f_* flags. NOTHING in this codebase reads nine of
 * them: f_bookings, f_booking_fee, f_deposits, f_orders, f_delivery,
 * f_sms_commerce, f_guest_list, f_cabanas, f_bottle_service, f_perks and
 * f_auto_confirm have zero call sites outside the schema that defines them.
 * Putting them on a page would be eleven switches that do nothing, and a
 * control panel full of dead switches teaches a merchant that none of the
 * controls are real — including the three that are.
 *
 * So the surface is three things, and it grows when a consumer does.
 */

/** A tip is the server's money; a fee is not. Kept for the error text. */
const TIPS_UNDERTAKING =
  'Tips are your staff\'s money. By switching this on you confirm that every ' +
  'tip left through NUM reaches the people who served the table, and that no ' +
  'owner, manager or supervisor keeps any part of it.';

export { TIPS_UNDERTAKING };

/**
 * What a venue may set, and what it may set it to.
 *
 * `max` on an integer field is not advice — it mirrors the CHECK constraint
 * in the migration that created the column. Clamping here and constraining
 * there means a bad request produces a clamped value rather than a 500 from
 * D1, and the schema stays the thing that is finally true.
 */
export const FIELDS = Object.freeze({
  f_bill_value: Object.freeze({
    type: 'flag',
    label: 'I will tell NUM what the table spent',
    /* Read by worker/commission.mjs:305. */
    why: 'Switches this venue from the $2 per confirmed table to 10% of the '
       + 'bill. It is a real commitment on both sides: NUM stops charging a fee '
       + 'it can always collect and starts charging one that depends on you '
       + 'reporting. Leave it off and $2 is what you pay.',
  }),
  f_priority_seating: Object.freeze({
    type: 'flag',
    label: 'Offer priority seating',
    /* Read by worker/aftertable.mjs:233. */
    why: 'Guests may pay to be seated sooner, and you keep 40% of what they '
       + 'pay. It never changes where you appear in NUM — a guest who declines '
       + 'sees exactly the same list.',
    foodAndDrinkOnly: true,
  }),
  priority_max_cs: Object.freeze({
    type: 'int',
    min: 0,
    max: 2000,                 // = aftertable.PRIORITY_MAX_CS, = the CHECK in 0009
    label: 'Most a guest may be asked for',
    why: 'In cents. $20 is the ceiling NUM will bill regardless of what is '
       + 'stored here.',
    foodAndDrinkOnly: true,
  }),
  f_tips: Object.freeze({
    type: 'flag',
    label: 'Ask guests to leave something for the server',
    why: TIPS_UNDERTAKING + ' NUM takes nothing from a tip and never holds '
       + 'one — it moves on your rail, not ours.',
    needs: 'tips_terms',
    foodAndDrinkOnly: true,
  }),
});

/**
 * Columns a venue may never write, and the sentence to say when it tries.
 *
 * Refused explicitly rather than ignored. A silently dropped field is
 * indistinguishable from an accepted one, and the fields here are exactly the
 * ones somebody would have a motive to change quietly.
 */
export const LOCKED = Object.freeze({
  commission_bp: 'Your rate is part of your agreement with NUM, not a setting. '
    + 'Reply to any NUM email to talk about it.',
  booking_fee_cs: 'The per-table fee is part of your agreement with NUM.',
  max_booking_fee_cs: 'The per-table fee is part of your agreement with NUM.',
  priority_share_bps: 'Your 40% share of a priority fee is part of your '
    + 'agreement with NUM.',
  fee_creditable: 'Whether the table fee comes off the bill is part of your '
    + 'agreement with NUM.',
  f_stars_settle: 'Stars settlement is switched on by NUM once your business '
    + 'has been approved for it.',
  f_crypto_settle: 'Crypto settlement is switched on by NUM once your business '
    + 'has been approved for it.',
  stars_approved_at: 'The date NUM approved you for Stars settlement is a '
    + 'record of what happened, not a setting.',
  stars_approved_by: 'Who at NUM approved you for Stars settlement is a record '
    + 'of what happened, not a setting.',
  business_id: 'Which business this is cannot be changed from inside it.',
  updated_at: 'When these settings last changed is recorded automatically.',
  updated_by: 'Who last changed these settings is recorded automatically.',
  tips_terms_at: 'The date you accepted the tipping undertaking is recorded '
    + 'when you accept it.',
  tips_terms_by: 'Who accepted the tipping undertaking is recorded when they '
    + 'accept it.',
});

const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.trunc(Number(v) || 0)));

/** JSON gives us true, "1", 1 and "on". All four mean the same thing. */
export function asFlag(v) {
  if (v === true || v === 1) return 1;
  if (v === false || v === 0 || v == null) return 0;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(s)) return 1;
  return 0;
}

/**
 * Turn one submitted value into the integer the column will hold.
 * Returns null for a field that is not settable at all.
 */
export function coerce(field, raw) {
  const spec = FIELDS[field];
  if (!spec) return null;
  if (spec.type === 'flag') return asFlag(raw);
  return clampInt(raw, spec.min ?? 0, spec.max ?? 0);
}

/**
 * Work out what a submitted patch actually changes, before touching the
 * database.
 *
 * Pure, and separated from the write for one reason: every rule worth having
 * here is a rule about a COMBINATION — turning priority on with no ceiling,
 * turning tips on without the undertaking, changing a locked field — and a
 * rule about a combination is only testable if something computes the whole
 * outcome in one pass.
 *
 * @param {object} current  the settings row as it stands (may be empty)
 * @param {object} patch    what was submitted
 * @param {object} opts     { foodAndDrink } — a per-cover product needs covers
 * @returns {{sets: object, changes: Array, refused: Array, ignored: Array}}
 */
export function planChange(current = {}, patch = {}, { foodAndDrink = true } = {}) {
  const sets = {};
  const changes = [];
  const refused = [];
  const ignored = [];

  for (const [field, raw] of Object.entries(patch || {})) {
    if (field === 'tips_terms') continue;               // an acceptance, not a column
    if (LOCKED[field]) { refused.push({ field, reason: LOCKED[field] }); continue; }
    const spec = FIELDS[field];
    if (!spec) { ignored.push(field); continue; }
    if (spec.foodAndDrinkOnly && !foodAndDrink) {
      refused.push({
        field,
        reason: 'This one is for places that seat people at tables — bars and '
              + 'restaurants. It would not do anything here.',
      });
      continue;
    }
    const value = coerce(field, raw);
    const was = current[field] ?? null;
    if (was === value) continue;                        // a no-op is not a change
    sets[field] = value;
    changes.push({ field, was, now: value });
  }

  // ── the combination rules ───────────────────────────────────────────────

  // Priority seating with no ceiling is a switch that does nothing:
  // aftertable.prioritySeating() returns null when max_cs is 0, so the venue
  // would see it on, believe guests were being offered it, and no guest ever
  // would be. Refuse rather than invent a price on their behalf.
  const priorityOn = 'f_priority_seating' in sets
    ? sets.f_priority_seating === 1
    : (current.f_priority_seating ?? 0) === 1;
  const ceiling = 'priority_max_cs' in sets
    ? sets.priority_max_cs
    : (current.priority_max_cs ?? 0);
  if (priorityOn && ceiling <= 0) {
    delete sets.f_priority_seating;
    refused.push({
      field: 'f_priority_seating',
      reason: 'Set the most a guest may be asked for first — with no amount, '
            + 'nobody would ever be offered it.',
    });
  }

  // Tips on requires the undertaking, once. A venue that accepted it before
  // and switched tips off may switch them back on without re-accepting: the
  // acceptance is a fact that already happened.
  if (sets.f_tips === 1 && !current.tips_terms_at && asFlag(patch.tips_terms) !== 1) {
    delete sets.f_tips;
    refused.push({ field: 'f_tips', reason: TIPS_UNDERTAKING });
  }

  return {
    sets,
    changes: changes.filter((c) => c.field in sets),
    refused,
    ignored,
  };
}

/* ── the database side ───────────────────────────────────────────────────── */

const LOG_TABLE = `CREATE TABLE IF NOT EXISTS num_business_setting_log (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL, field TEXT NOT NULL,
  was TEXT, now TEXT, changed_by TEXT, via TEXT, ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/**
 * Columns 0008, 0009 and 0010 add. Applied lazily and ignored on failure,
 * which is how every other migration in this repo reaches production: there
 * is no migration runner, so a column that a deploy needs has to be able to
 * create itself.
 */
const COLUMNS = [
  'ALTER TABLE num_business_settings ADD COLUMN f_bill_value INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE num_business_settings ADD COLUMN f_priority_seating INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE num_business_settings ADD COLUMN priority_max_cs INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE num_business_settings ADD COLUMN priority_share_bps INTEGER NOT NULL DEFAULT 4000',
  'ALTER TABLE num_business_settings ADD COLUMN f_tips INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE num_business_settings ADD COLUMN tips_terms_at INTEGER',
  'ALTER TABLE num_business_settings ADD COLUMN tips_terms_by TEXT',
];

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.prepare(LOG_TABLE).run().catch(() => {});
  for (const sql of COLUMNS) await env.DB.prepare(sql).run().catch(() => {});
  ready = true;
}
export const _resetSchemaCache = () => { ready = false; };

/** Everything the console shows, settable or not. */
export const READ_SQL = `SELECT f_bill_value, f_priority_seating, priority_max_cs,
         priority_share_bps, f_tips, tips_terms_at, tips_terms_by,
         commission_bp, booking_fee_cs, updated_at, updated_by
    FROM num_business_settings WHERE business_id = ?1`;

/**
 * The settings row, creating it if this business predates onboard.mjs.
 *
 * A business with no row is not an error state to report — it is a business
 * that signed up before the row existed. Returning defaults and writing them
 * on first change is the only behaviour that does not punish the earliest
 * merchants for being early.
 */
export async function readSettings(env, businessId) {
  if (!env?.DB || !businessId) return null;
  await ensure(env);
  const row = await env.DB.prepare(READ_SQL).bind(businessId).first().catch(() => null);
  return row || {
    f_bill_value: 0, f_priority_seating: 0, priority_max_cs: 0,
    priority_share_bps: 4000, f_tips: 0, tips_terms_at: null, tips_terms_by: null,
    commission_bp: 1000, booking_fee_cs: 200, updated_at: null, updated_by: null,
    _missing: true,
  };
}

const logId = () => `bsl_${Math.random().toString(36).slice(2, 12)}`;

/**
 * Apply a patch and record what moved.
 *
 * The log is written whether or not anyone ever reads it, because the
 * question it answers — "we were charged 10% of the bill in March, who agreed
 * to that" — is asked months later by a merchant who is already unhappy, and
 * a settings table that holds only the current value cannot answer it.
 */
export async function writeSettings(env, {
  businessId, patch = {}, by = 'key', via = 'key', ip = null, foodAndDrink = true,
} = {}) {
  if (!env?.DB || !businessId) return { ok: false, error: 'no_business' };
  await ensure(env);

  const current = await readSettings(env, businessId);
  const plan = planChange(current, patch, { foodAndDrink });

  const nowSec = Math.floor(Date.now() / 1000);
  if (!Object.keys(plan.sets).length) {
    return { ok: true, changed: [], refused: plan.refused, ignored: plan.ignored,
             settings: current };
  }

  // A first acceptance is stamped alongside the flag it unlocked, in the same
  // statement, so there is no window in which tips are on and unaccounted for.
  const sets = { ...plan.sets };
  if (sets.f_tips === 1 && !current.tips_terms_at) {
    sets.tips_terms_at = nowSec;
    sets.tips_terms_by = String(by).slice(0, 120);
  }

  const cols = Object.keys(sets);
  for (const c of cols) {
    // Field names are interpolated into SQL below. They come from FIELDS and
    // from the two acceptance columns and from nowhere else — but an assertion
    // is cheaper than the day somebody widens this loop.
    if (!(c in FIELDS) && !['tips_terms_at', 'tips_terms_by'].includes(c)) {
      throw new Error(`refusing to write unlisted column ${c}`);
    }
  }

  await env.DB.prepare(
    `INSERT INTO num_business_settings (business_id, updated_at, updated_by)
     VALUES (?1, ?2, ?3) ON CONFLICT(business_id) DO NOTHING`,
  ).bind(businessId, nowSec, String(by).slice(0, 120)).run().catch(() => {});

  const assigns = cols.map((c, i) => `${c} = ?${i + 1}`).join(', ');
  const binds = cols.map((c) => sets[c]);
  await env.DB.prepare(
    `UPDATE num_business_settings SET ${assigns},
            updated_at = ?${cols.length + 1}, updated_by = ?${cols.length + 2}
      WHERE business_id = ?${cols.length + 3}`,
  ).bind(...binds, nowSec, String(by).slice(0, 120), businessId).run();

  for (const c of plan.changes) {
    await env.DB.prepare(
      `INSERT INTO num_business_setting_log (id,business_id,field,was,now,changed_by,via,ip)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
    ).bind(
      logId(), businessId, c.field,
      c.was == null ? null : String(c.was), String(c.now),
      String(by).slice(0, 120), via, ip,
    ).run().catch(() => {});
  }

  return {
    ok: true,
    changed: plan.changes,
    refused: plan.refused,
    ignored: plan.ignored,
    settings: await readSettings(env, businessId),
  };
}

/** The last few changes, for the venue's own page. */
export async function settingHistory(env, businessId, limit = 20) {
  if (!env?.DB || !businessId) return [];
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT field, was, now, changed_by, via, created_at
       FROM num_business_setting_log WHERE business_id = ?1
      ORDER BY created_at DESC LIMIT ?2`,
  ).bind(businessId, Math.min(100, Math.max(1, limit))).all().catch(() => ({ results: [] }));
  return results || [];
}
