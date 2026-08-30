// 10% when NUM can see the bill, $2 when it cannot.
//
// Replaces commission.country.test.mjs (26 Aug 2026). That file tested a
// per-country override: Thailand billed 10% of a real bill, everywhere else
// paid $2 flat. The override was never really about Thailand — it was about
// whether anything in the venue reports a total, and a Bali warung with a
// connected POS and a Bangkok bar with none were on the wrong side of a
// country flag.
//
// The trap this file exists to guard is subtle and expensive. Giving a venue a
// percentage does not ADD 10%; if the flat fee stops applying, it REMOVES the
// only fee NUM can always collect. A venue that takes fifty tables and never
// once reports a bill then pays nothing, for ever, while the ledger shows
// fifty healthy accruals. The flat fee is a FLOOR, not an alternative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RATES, accrue, feeSentence, lapseAwaitingValue } from './commission.mjs';

/** D1 stand-in that keeps the rows accrue() writes and can hold merchant
    settings, so "this venue reports bill values" is testable. */
function db({ settings = null } = {}) {
  const rows = [];
  const DB = {
    prepare(q) {
      let args = [];
      const stmt = {
        bind: (...a) => { args = a; return stmt; },
        run: async () => {
          if (/INSERT OR IGNORE INTO num_commissions/.test(q)) {
            rows.push({
              booking_id: args[1], category: args[7], kind: args[8],
              rate_bp: args[9], flat_cs: args[10], basis_cs: args[11],
              amount_cs: args[12], state: args[14], note: args[16],
            });
          }
          return { meta: { changes: 1 } };
        },
        first: async () => (/num_business_settings/.test(q) ? settings : null),
        all: async () => ({ results: rows }),
      };
      return stmt;
    },
    batch: async () => [],
  };
  return { rows, DB };
}

const RESTAURANT = { id: 'p1', name: 'Kan Eang', category: 'Seafood Restaurant', country: 'TH', dest: 'phuket', business_id: 'biz_1' };
const NO_SYSTEM = null;
const ON_A_SYSTEM = { commission_bp: 1000, booking_fee_cs: 200, delivery_fee_cs: 500, f_bill_value: 1 };

/* ── the rate card ──────────────────────────────────────────────────────── */

test('a reservation carries both numbers', () => {
  assert.equal(RATES.reservation.bp, 1000);
  assert.equal(RATES.reservation.flat_cs, 200);
});

test('the quote states both, so neither can be a surprise on an invoice', () => {
  const s = feeSentence(RESTAURANT);
  assert.match(s, /10% of the bill/);
  assert.match(s, /\$2 per confirmed table/);
});

/* ── which one applies ──────────────────────────────────────────────────── */

test('a venue with no seating or billing system pays the flat floor', async () => {
  // The case Dre named: no system yet, so there is no bill to take ten percent
  // of. Bills immediately — a flat fee needs no amount.
  const d = db({ settings: NO_SYSTEM });
  const out = await accrue({ DB: d.DB }, { bookingId: 'b1', place: RESTAURANT });
  assert.equal(out.kind, 'flat');
  assert.equal(out.amount_cs, 200);
  assert.equal(out.state, 'accrued');
});

test('a venue that reports bill values waits for the bill', async () => {
  const d = db({ settings: ON_A_SYSTEM });
  const out = await accrue({ DB: d.DB }, { bookingId: 'b2', place: RESTAURANT });
  assert.equal(out.kind, 'percent');
  assert.equal(out.state, 'awaiting_value');
  assert.equal(out.amount_cs, null, 'a percentage of an unknown number is a guess');
  assert.equal(d.rows[0].rate_bp, 1000);
});

test('a bill that arrives with the booking is billed at 10% on the spot', async () => {
  const d = db({ settings: NO_SYSTEM });
  // ฿2,400 ≈ $73.44. An amount in hand beats any flag: we can see it.
  const out = await accrue({ DB: d.DB }, { bookingId: 'b3', place: RESTAURANT, valueCents: 7344 });
  assert.equal(out.kind, 'percent');
  assert.equal(out.amount_cs, 734, '10% of $73.44');
  assert.equal(out.state, 'accrued');
});

test('the same venue is priced the same in every country', async () => {
  // The country override is gone. What decides the rate is the system, not
  // the passport.
  const th = db({ settings: NO_SYSTEM });
  const gb = db({ settings: NO_SYSTEM });
  await accrue({ DB: th.DB }, { bookingId: 'b4', place: { ...RESTAURANT, country: 'TH' } });
  await accrue({ DB: gb.DB }, { bookingId: 'b5', place: { ...RESTAURANT, country: 'GB' } });
  assert.equal(th.rows[0].kind, gb.rows[0].kind);
  assert.equal(th.rows[0].amount_cs, gb.rows[0].amount_cs);
});

test('a place with no business record still pays the floor', async () => {
  // No settings row means no way to know it reports anything, and the honest
  // reading of that is "it does not".
  const d = db({ settings: NO_SYSTEM });
  const out = await accrue({ DB: d.DB }, { bookingId: 'b6', place: { name: 'Unknown', category: 'Restaurant' } });
  assert.equal(out.kind, 'flat');
  assert.equal(out.amount_cs, 200);
});

/* ── what the gate must NOT touch ───────────────────────────────────────── */

test('a sale keeps its percentage even with no bill reported', async () => {
  // The mistake this catches: applying the see-the-bill gate to everything.
  // An activity, a stay and an appointment are SOLD through NUM, so the value
  // is knowable by definition — and they have no flat line to fall back to.
  // Gating them would drop a $4,000 holiday to a $2 table fee.
  for (const [category, bp] of [['Diving', 2000], ['Hotel', 1500], ['Massage & spa', 1500]]) {
    const d = db({ settings: NO_SYSTEM });
    const out = await accrue({ DB: d.DB }, { bookingId: `s_${category}`, place: { category } });
    assert.equal(out.state, 'awaiting_value', `${category} lost its percentage`);
    assert.equal(d.rows[0].rate_bp, bp, `${category} should be ${bp / 100}%`);
  }
});

test('a settings row does not give a dive shop a table fee', async () => {
  // Every num_business_settings row carries booking_fee_cs = 200 by default.
  // Reading the floor off the merchant's settings rather than off the rate
  // card would sprout a $2 line on categories that were never sold one.
  const d = db({ settings: { commission_bp: 2000, booking_fee_cs: 200, f_bill_value: 0 } });
  const out = await accrue({ DB: d.DB }, { bookingId: 'b7', place: { category: 'Diving', business_id: 'biz_2' } });
  assert.equal(out.kind, 'percent', 'a dive booking was billed as a table');
  assert.equal(out.state, 'awaiting_value');
});

test('a signed agreement prices itself, gate or no gate', async () => {
  // An explicit rateBp only ever comes from an agreement the booking was made
  // under, and the amount is already known there.
  const d = db({ settings: NO_SYSTEM });
  const out = await accrue({ DB: d.DB }, {
    bookingId: 'b8', place: RESTAURANT, categoryIn: 'stay', rateBp: 800, valueCents: 400000,
  });
  assert.equal(out.kind, 'percent');
  assert.equal(out.amount_cs, 32000, '8% of $4,000');
});

/* ── the floor catches what the percentage drops ────────────────────────── */

test('a claim nobody ever valued lapses to the floor, not to nothing', async () => {
  // The real cost of the old override, made impossible. A row stuck at
  // awaiting_value is invoiced never while the ledger looks healthy.
  let sql = '';
  const DB = {
    prepare(q) {
      const stmt = {
        bind: () => stmt,
        run: async () => { if (/UPDATE num_commissions/.test(q)) sql = q; return { meta: { changes: 3 } }; },
        first: async () => null,
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
    batch: async () => [],
  };
  const out = await lapseAwaitingValue({ DB }, { days: 30 });
  assert.equal(out.lapsed, 3);
  assert.match(sql, /state = 'awaiting_value'/);
  assert.match(sql, /invoiced_at IS NULL/, 'an invoiced line must never be rewritten');
  assert.match(sql, /paid_at IS NULL/, 'a paid line must never be rewritten');
  assert.match(sql, /amount_cs = \?1/);
});

test('the lapse writes the floor and nothing larger', async () => {
  let bound = null;
  const DB = {
    prepare() {
      const stmt = {
        bind: (...a) => { bound = a; return stmt; },
        run: async () => ({ meta: { changes: 0 } }),
        first: async () => null,
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
    batch: async () => [],
  };
  await lapseAwaitingValue({ DB }, { days: 45 });
  assert.deepEqual(bound, [RATES.reservation.flat_cs, 45],
    'the lapse must bill the flat floor, never an invented percentage');
});

test('the lapse is safe to call against a database with no rows', async () => {
  const d = db({ settings: NO_SYSTEM });
  const out = await lapseAwaitingValue({ DB: d.DB }, {});
  assert.equal(out.lapsed, 1); // the stub reports one change; the point is it does not throw
});

test('lapsing never runs without a database', async () => {
  assert.equal(await lapseAwaitingValue({}, {}), null);
  assert.equal(await lapseAwaitingValue(null, {}), null);
});
