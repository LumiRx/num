// What Num earns, and the four ways getting it wrong loses a merchant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RATES, categoryFor, accrue, settleValue, termsText } from './commission.mjs';
import { tag, affiliates, programmes } from './affiliate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** D1 stand-in that remembers the rows it was asked to insert. */
function db() {
  const rows = [];
  const settings = new Map();
  return {
    rows, settings,
    prepare(q) {
      let args = [];
      // `bind` must return the STATEMENT, not the db. An arrow function here
      // captures the outer `this` and silently hands back the database, so
      // every .bind(...).run() resolves against the wrong object — and
      // accrue's own try/catch swallows the TypeError, so the test fails with
      // "null" and no clue why.
      const stmt = {
        bind: (...a) => { args = a; return stmt; },
        run: async () => {
          if (/INSERT OR IGNORE INTO num_commissions/.test(q)) {
            if (!rows.some((r) => r.booking_id === args[1])) {
              rows.push({
                id: args[0], booking_id: args[1], business_id: args[2], category: args[7],
                kind: args[8], rate_bp: args[9], flat_cs: args[10], amount_cs: args[12], state: args[14],
              });
            }
          }
          return { meta: { changes: 1 } };
        },
        first: async () => {
          if (/FROM num_business_settings/.test(q)) return settings.get(args[0]) ?? null;
          if (/FROM num_commissions/.test(q)) return rows.find((r) => r.booking_id === args[0] && r.state === 'awaiting_value') ?? null;
          return null;
        },
        all: async () => ({ results: rows }),
      };
      return stmt;
    },
    batch: async () => [],
  };
}

test('a reservation is a flat fee, not a percentage', () => {
  // 10% of a $300 dinner is $30 for a table the venue might have filled
  // anyway. Nobody signs that twice. The industry pays $1–3 per cover.
  assert.equal(RATES.reservation.flat_cs, 200);
  assert.equal(RATES.reservation.bp, undefined,
    'reservations grew a percentage rate — that is the pricing mistake this file exists to avoid');
});

test('a sale is a percentage, inside its market band', () => {
  assert.ok(RATES.activity.bp >= 1500 && RATES.activity.bp <= 3000, 'activities: market is 20–30%');
  assert.ok(RATES.stay.bp >= 1000 && RATES.stay.bp <= 2500, 'stays: market is 15–25%');
  assert.ok(RATES.appointment.bp >= 1000 && RATES.appointment.bp <= 2000, 'appointments: market is 10–20%');
});

test('categories route to the right rate', () => {
  assert.equal(categoryFor({ category: 'Restaurant' }), 'reservation');
  assert.equal(categoryFor({ category: 'Hotel' }), 'stay');
  assert.equal(categoryFor({ category: 'Diving' }), 'activity');
  assert.equal(categoryFor({ category: 'Massage & spa' }), 'appointment');
});

test('an unknown category under-bills rather than guesses', () => {
  // A merchant who finds an unexpected charge stops trusting the whole ledger.
  // One $2 line is a cheaper mistake than one 20% line.
  assert.equal(categoryFor({ category: 'Something Novel' }), 'reservation');
  assert.equal(categoryFor({}), 'reservation');
});

test('a confirmed table accrues exactly two dollars', async () => {
  const env = { DB: db() };
  const out = await accrue(env, { bookingId: 'bk_1', place: { category: 'Restaurant', id: 'p1' } });
  assert.equal(out.kind, 'flat');
  assert.equal(out.amount_cs, 200);
  assert.equal(out.state, 'accrued');
});

test('the same booking cannot be billed twice', async () => {
  // The confirmation URL lives in an SMS on a stranger's phone. It gets tapped
  // twice, forwarded, and prefetched by link previewers.
  const env = { DB: db() };
  await accrue(env, { bookingId: 'bk_2', place: { category: 'Restaurant' } });
  await accrue(env, { bookingId: 'bk_2', place: { category: 'Restaurant' } });
  await accrue(env, { bookingId: 'bk_2', place: { category: 'Restaurant' } });
  assert.equal(env.DB.rows.filter((r) => r.booking_id === 'bk_2').length, 1,
    'one table produced three charges — the merchant finds out before we do');
});

test('a percentage with no known value is a claim, not an invoice', async () => {
  // At confirmation we know four people are coming. We do NOT know what they
  // spent. Billing a guess is how you lose a merchant.
  const env = { DB: db() };
  const out = await accrue(env, { bookingId: 'bk_3', place: { category: 'Diving' } });
  assert.equal(out.state, 'awaiting_value');
  assert.equal(out.amount_cs, null, 'an amount was invented for a booking whose value nobody knows');
});

test('the amount lands once the value is known', async () => {
  const env = { DB: db() };
  await accrue(env, { bookingId: 'bk_4', place: { category: 'Diving' } });
  const s = await settleValue(env, 'bk_4', 40000); // a $400 dive trip
  assert.equal(s.amount_cs, 8000, '20% of $400 should be $80');
});

test("a merchant's own terms beat the category default", async () => {
  // A rate agreed in a conversation must not be silently overwritten by a
  // code change six months later.
  const env = { DB: db() };
  env.DB.settings.set('biz_9', { commission_bp: null, booking_fee_cs: 50 });
  const out = await accrue(env, { bookingId: 'bk_5', place: { category: 'Restaurant', business_id: 'biz_9' } });
  assert.equal(out.amount_cs, 50, 'the negotiated 50¢ fee was overridden by the $2 default');
});

test('an agreed zero is honoured', async () => {
  const env = { DB: db() };
  env.DB.settings.set('biz_free', { commission_bp: 0, booking_fee_cs: 0 });
  assert.equal(await accrue(env, { bookingId: 'bk_6', place: { category: 'Restaurant', business_id: 'biz_free' } }), null);
});

test('a ledger failure never costs a guest their table', async () => {
  const broken = { DB: { prepare() { throw new Error('D1 down'); }, batch: async () => { throw new Error('D1 down'); } } };
  assert.equal(await accrue(broken, { bookingId: 'bk_7', place: {} }), null,
    'accrue threw — money we forgot to record is recoverable, a lost booking is not');
});

test('only a confirmation that actually flipped is billed', () => {
  const src = readFileSync(join(HERE, 'bookdesk.mjs'), 'utf8');
  assert.match(src, /flip\.meta\.changes > 0 && verdict === 'confirmed'/,
    'the accrual moved outside the idempotency guard — a re-tapped link bills again');
  assert.ok(src.indexOf('accrue(env') > src.indexOf("verdict === 'confirmed'"),
    'a declined booking can now be billed');
});

test('terms read as a sentence a merchant can check', () => {
  const t = termsText();
  assert.match(t, /\$2 per confirmed booking/);
  assert.match(t, /only on bookings the venue confirms/);
});

// ── affiliate ────────────────────────────────────────────────────────────

test('a link is tagged only where we have a programme', () => {
  const env = { NUM_AFFILIATES: JSON.stringify({ 'resy.com': { ref: 'num01', param: 'ref' } }) };
  assert.match(tag('https://resy.com/cities/la/bestia', env), /ref=num01/);
  assert.equal(tag('https://example.com/x', env), 'https://example.com/x',
    'an unconfigured host was tagged — that is an open redirect with our name on it');
});

test('www and subdomains match one rule', () => {
  const env = { NUM_AFFILIATES: JSON.stringify({ 'opentable.com': { ref: 'x' } }) };
  assert.match(tag('https://www.opentable.com/r/bestia', env), /ref=x/);
});

test("someone else's attribution is left alone", () => {
  const env = { NUM_AFFILIATES: JSON.stringify({ 'resy.com': { ref: 'num01', param: 'ref' } }) };
  const already = 'https://resy.com/x?ref=theirs';
  assert.equal(tag(already, env), already, 'we overwrote a partner’s own tracking parameter');
});

test('cleartext and malformed URLs are returned untouched', () => {
  const env = { NUM_AFFILIATES: JSON.stringify({ '*': { ref: 'num' } }) };
  assert.equal(tag('http://resy.com/x', env), 'http://resy.com/x', 'a click was tagged over plain http');
  assert.equal(tag('not a url', env), 'not a url');
  assert.equal(tag('', env), '');
});

test('a malformed table disables tagging instead of half-applying it', () => {
  assert.deepEqual(affiliates({ NUM_AFFILIATES: '{oops' }), {});
  assert.equal(tag('https://resy.com/x', { NUM_AFFILIATES: '{oops' }), 'https://resy.com/x');
  assert.deepEqual(programmes({}), []);
});

test('tagging cannot reach the ranking', () => {
  // The one rule that matters. The moment a recommendation is for sale, the
  // product is worth nothing and no commission buys the trust back.
  const aff = readFileSync(join(HERE, 'affiliate.mjs'), 'utf8');
  const bare = aff.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/ORDER BY|\brank\b|\bscore\b|SELECT /i.test(bare),
    'affiliate.mjs grew a query or a ranking term — tagging must only ever decorate a URL already chosen on merit');
  const places = readFileSync(join(HERE, '..', 'ai', 'places.js'), 'utf8');
  assert.ok(!/affiliate|NUM_AFFILIATES/.test(places),
    'the ranking module now knows about affiliates — recommendations are for sale');
});
