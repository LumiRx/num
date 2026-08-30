// After the table: rating, tip, priority seating.
//
// Three rules are load-bearing and every one of them is a rule about money
// that is not ours:
//
//   1. NUM takes NOTHING from a tip. Not a percentage, not a fee, not a
//      rounding. 29 U.S.C. §203(m)(2)(B): no employer, manager or supervisor
//      may keep any part of an employee's tips.
//   2. NUM never HOLDS a tip. Money in transit for someone else is money
//      transmission, which is what every table in this schema avoids.
//   3. Priority seating must never touch ranking. A guest paying for a better
//      table is a product; a venue paying for a better rank is the thing NUM
//      promises in writing that it does not do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  rate, ratingFor, tip, prioritySeating, accruePriority, prioritySentence,
  tipsOffered, PRIORITY_MAX_CS, PRIORITY_SHARE_BPS, MIN_RATINGS, _resetSchemaCache,
} from './aftertable.mjs';
import { foodAndDrink, accrue } from './commission.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = readFileSync(join(HERE, 'aftertable.mjs'), 'utf8');
// The code with its prose removed. The file has to be able to SAY "this must
// never touch ranking" without that sentence failing the test that enforces
// it — the same trap worker/unicode.test.mjs had to step around.
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const MIG = readFileSync(join(HERE, 'migrations', '0009_tips_ratings_priority.sql'), 'utf8');

/** A real SQLite behind a D1-shaped facade, so the CHECKs are exercised. */
function env({ settings = null } = {}) {
  _resetSchemaCache();
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE num_business_settings (
            business_id TEXT PRIMARY KEY,
            f_priority_seating INTEGER DEFAULT 0,
            priority_max_cs INTEGER DEFAULT 0,
            priority_share_bps INTEGER DEFAULT 4000,
            f_tips INTEGER DEFAULT 0)`);
  if (settings) {
    d.prepare(`INSERT INTO num_business_settings
               (business_id,f_priority_seating,priority_max_cs,priority_share_bps,f_tips)
               VALUES (?,?,?,?,?)`).run(
      settings.business_id, settings.f_priority_seating ?? 0,
      settings.priority_max_cs ?? 0, settings.priority_share_bps ?? 4000,
      settings.f_tips ?? 0,
    );
  }
  const DB = {
    prepare(q) {
      let args = [];
      const stmt = {
        bind: (...a) => { args = a; return stmt; },
        run: async () => { d.prepare(q).run(...args.map((v) => v ?? null)); return { meta: { changes: 1 } }; },
        first: async () => d.prepare(q).get(...args.map((v) => v ?? null)) ?? null,
        all: async () => ({ results: d.prepare(q).all(...args.map((v) => v ?? null)) }),
      };
      return stmt;
    },
    batch: async (stmts) => { for (const s of stmts) await s.run(); return []; },
  };
  return { DB, raw: d };
}

const RESTAURANT = { id: 'p1', category: 'Restaurant' };
const HOTEL = { id: 'p2', category: 'Hotel' };

/* ══ the tip rule ═══════════════════════════════════════════════════════ */

test('a tip returns no fee, no share and no net — because there is none', async () => {
  const e = env();
  const t = await tip(e, { bookingId: 'b1', businessId: 'biz_1', amountCs: 500 });
  assert.equal(t.amount_cs, 500, 'the whole tip, unreduced');
  for (const k of ['fee_cs', 'fee', 'commission_cs', 'commission', 'net_cs', 'net', 'share_bps', 'amount_net']) {
    assert.equal(k in t, false, `tip() returned ${k} — NUM must take nothing from a tip`);
  }
});

test('the tip table has nowhere to put a cut', async () => {
  // Enforced by construction rather than by discipline. There is no column to
  // write a commission into, so no future change can quietly start taking one
  // without also having to explain a migration.
  const e = env();
  await tip(e, { bookingId: 'cols', businessId: 'biz_1', amountCs: 1 }); // creates the schema
  const cols = e.raw.prepare("SELECT name FROM pragma_table_info('num_tips')").all().map((c) => c.name);
  for (const banned of ['fee', 'fee_cs', 'commission', 'commission_bp', 'commission_cs', 'share_bps', 'net_cs', 'platform_cs']) {
    assert.equal(cols.includes(banned), false, `num_tips.${banned} exists — a tip must not be reducible`);
  }
  assert.ok(cols.includes('amount_cs'));
});

test('tip() takes no commission argument at all', () => {
  // The signature is the interface. A caller cannot pass a cut because there
  // is no parameter for one.
  const sig = SRC.slice(SRC.indexOf('export async function tip('), SRC.indexOf('} = {}) {', SRC.indexOf('export async function tip(')));
  assert.doesNotMatch(sig, /fee|commission|share|net|cut|platform/i);
});

test('num_commissions is never written from this file', () => {
  // A tip is not revenue. If it ever reaches the commission ledger, it has
  // become revenue, and NUM has taken money that belongs to a server. Checked
  // against the code rather than the prose, so the file can still explain the
  // rule it is obeying.
  assert.doesNotMatch(CODE, /num_commissions/);
  assert.doesNotMatch(CODE, /INSERT[\s\S]{0,40}num_commissions/i);
});

test('NUM does not hold the tip — it records which rail carried it', async () => {
  const e = env();
  const t = await tip(e, { bookingId: 'b2', businessId: 'biz_1', amountCs: 1000, rail: 'paylink', railRef: 'pl_123' });
  assert.equal(t.rail, 'paylink');
  const cols = e.raw.prepare("SELECT name FROM pragma_table_info('num_tips')").all().map((c) => c.name);
  const banned = /card|pan\b|cvv|cvc|iban|swift|routing|account_number|bank|wallet|balance|stripe_|paypal/i;
  for (const c of cols) assert.doesNotMatch(c, banned, `num_tips.${c}`);
});

test('a zero or negative tip is not a tip', async () => {
  const e = env();
  assert.equal(await tip(e, { bookingId: 'b3', amountCs: 0 }), null);
  assert.equal(await tip(e, { bookingId: 'b4', amountCs: -500 }), null);
});

test('tipping twice edits one tip rather than adding a second', async () => {
  const e = env();
  await tip(e, { bookingId: 'b5', businessId: 'biz_1', amountCs: 500 });
  await tip(e, { bookingId: 'b5', businessId: 'biz_1', amountCs: 800 });
  const rows = e.raw.prepare('SELECT amount_cs FROM num_tips WHERE booking_id = ?').all('b5');
  assert.equal(rows.length, 1, 'a re-tapped link left two tips');
  assert.equal(rows[0].amount_cs, 800);
});

/* ══ the rating rule ════════════════════════════════════════════════════ */

test('a tip does not imply a rating, and a rating does not imply a tip', async () => {
  // Two columns, two tables, either one alone. A five-star average that only
  // exists because tipping guests were the ones asked is a fabricated number.
  const e = env();
  const onlyTip = await tip(e, { bookingId: 'b6', businessId: 'biz_1', amountCs: 500 });
  assert.ok(onlyTip, 'a guest must be able to tip without rating');
  const onlyRating = await rate(e, { bookingId: 'b7', businessId: 'biz_1', stars: 5 });
  assert.ok(onlyRating, 'a guest must be able to rate without tipping');
  assert.equal(e.raw.prepare('SELECT COUNT(*) n FROM num_tips WHERE booking_id = ?').get('b7').n, 0);
});

test('no opinion is invented for a guest who gave none', async () => {
  const e = env();
  assert.equal(await rate(e, { bookingId: 'b8', businessId: 'biz_1' }), null,
    'an empty rating was recorded — that is an opinion nobody held');
});

test('a comment with no stars is still worth recording', async () => {
  const e = env();
  const r = await rate(e, { bookingId: 'b9', businessId: 'biz_1', comment: 'terrace was closed' });
  assert.ok(r);
  assert.equal(r.stars, null, 'a comment was scored as if it were stars');
});

test('stars outside 1–5 are clamped, never stored raw', async () => {
  const e = env();
  assert.equal((await rate(e, { bookingId: 'c1', stars: 9 })).stars, 5);
  assert.equal((await rate(e, { bookingId: 'c2', stars: 0 })).stars, 1);
});

test('one rating per booking', async () => {
  const e = env();
  await rate(e, { bookingId: 'c3', businessId: 'biz_1', stars: 1 });
  await rate(e, { bookingId: 'c3', businessId: 'biz_1', stars: 5 });
  const rows = e.raw.prepare('SELECT stars FROM num_ratings WHERE booking_id = ?').all('c3');
  assert.equal(rows.length, 1, 'a venue could ask until it liked the answer');
});

test('a thin sample is not shown to guests as a score', async () => {
  // Three ratings averaging 4.7 read identically to three hundred and are
  // worth nothing like as much.
  const e = env();
  for (let i = 0; i < MIN_RATINGS - 1; i++) {
    await rate(e, { bookingId: `d${i}`, placeId: 'p1', stars: 5 });
  }
  const few = await ratingFor(e, { placeId: 'p1' });
  assert.equal(few.n, MIN_RATINGS - 1);
  assert.equal(few.show, false, 'a sample too thin to mean anything was shown as a score');
  assert.ok(few.avg, 'the venue still sees its own feedback');

  await rate(e, { bookingId: 'd_last', placeId: 'p1', stars: 5 });
  assert.equal((await ratingFor(e, { placeId: 'p1' })).show, true);
});

test('a rating cannot be bought — no money reaches this file', () => {
  // No rate, plan, tier or fee anywhere near rate() or ratingFor().
  const block = SRC.slice(SRC.indexOf('export async function rate('), SRC.indexOf('/* ── the server'));
  assert.doesNotMatch(block, /price|tier|plan|paid|subscription|commission_bp/i);
});

/* ══ priority seating ═══════════════════════════════════════════════════ */

test('it is off unless the venue switched it on', async () => {
  const off = env({ settings: { business_id: 'biz_1', f_priority_seating: 0, priority_max_cs: 2000 } });
  assert.equal(await prioritySeating(off, RESTAURANT, 'biz_1'), null);
  const none = env();
  assert.equal(await prioritySeating(none, RESTAURANT, 'biz_1'), null,
    'a venue with no settings row was opted in by default');
});

test('$20 is a ceiling in code as well as in the schema', async () => {
  // A settings row written before the CHECK existed, or by a migration that
  // forgets it, must not be able to bill a guest $200 for a table.
  const e = env({ settings: { business_id: 'biz_1', f_priority_seating: 1, priority_max_cs: 20000 } });
  const p = await prioritySeating(e, RESTAURANT, 'biz_1');
  assert.equal(p.max_cs, PRIORITY_MAX_CS);
  assert.equal(PRIORITY_MAX_CS, 2000, '$20.00');
});

test('the venue keeps 40%', async () => {
  const e = env({ settings: { business_id: 'biz_1', f_priority_seating: 1, priority_max_cs: 2000 } });
  const out = await accruePriority(e, { bookingId: 'p_1', businessId: 'biz_1', grossCs: 2000 });
  assert.equal(out.share_bps, PRIORITY_SHARE_BPS);
  assert.equal(out.amount_cs, 800, '40% of $20');
  assert.equal(PRIORITY_SHARE_BPS, 4000);
});

test('NUM never owes a venue more than the guest paid', async () => {
  const e = env();
  const out = await accruePriority(e, { bookingId: 'p_2', businessId: 'biz_1', grossCs: 500, shareBps: 10000 });
  assert.equal(out.amount_cs, 500);
  assert.ok(out.amount_cs <= out.gross_cs);
});

test('a share is rounded down, so a rounding never lands against us', async () => {
  const e = env();
  // 40% of $3.33 is 133.2 cents.
  const out = await accruePriority(e, { bookingId: 'p_3', businessId: 'biz_1', grossCs: 333 });
  assert.equal(out.amount_cs, 133);
});

test('a priority fee above the ceiling is clamped before it is split', async () => {
  const e = env();
  const out = await accruePriority(e, { bookingId: 'p_4', businessId: 'biz_1', grossCs: 999999 });
  assert.equal(out.gross_cs, PRIORITY_MAX_CS);
  assert.equal(out.amount_cs, 800);
});

test('a re-tapped link does not pay the venue twice', async () => {
  const e = env();
  await accruePriority(e, { bookingId: 'p_5', businessId: 'biz_1', grossCs: 1000 });
  await accruePriority(e, { bookingId: 'p_5', businessId: 'biz_1', grossCs: 1000 });
  const n = e.raw.prepare("SELECT COUNT(*) n FROM num_venue_payouts WHERE booking_id='p_5'").get().n;
  assert.equal(n, 1);
});

test('priority seating is offered only where there are covers', async () => {
  const e = env({ settings: { business_id: 'biz_1', f_priority_seating: 1, priority_max_cs: 2000 } });
  assert.ok(await prioritySeating(e, RESTAURANT, 'biz_1'));
  assert.equal(await prioritySeating(e, HOTEL, 'biz_1'), null,
    'a hotel was offered priority seating — there is no table to be seated at');
});

/* ══ THE LINE THAT MUST NOT BE CROSSED ══════════════════════════════════ */

test('priority seating never touches ranking', () => {
  // One word separates this feature from paid placement, and the word is who
  // pays. A guest paying for a better table is a product. A venue paying for
  // a better rank is the thing NUM promises, in writing, that it does not do
  // — and gate.test.mjs fails the build if the business page ever sells it.
  //
  // So no ranking, sorting or ordering concept may appear in this file.
  for (const word of [
    'rank', 'ranking', 'boost', 'promote', 'placement', 'sort', 'order by',
    'priority_score', 'weight', 'surface', 'top of',
  ]) {
    assert.doesNotMatch(CODE.toLowerCase(), new RegExp(word.toLowerCase()),
      `"${word}" appears in aftertable.mjs code — priority seating must never reach ranking`);
  }
});

test('the migration says so too, and says who pays', () => {
  assert.match(MIG, /must not touch recommendation order/i);
  assert.match(MIG, /guest pays for a better TABLE/);
  assert.match(MIG, /venue pays for a better RANK/);
});

test('what a venue is told is what a venue gets', () => {
  const s = prioritySentence(2000, 4000);
  assert.match(s, /\$20/);
  assert.match(s, /40%/);
  assert.match(s, /never changes where you appear/i);
});

/* ══ the $2 floor, now scoped ═══════════════════════════════════════════ */

test('the $2 floor is a bars-and-restaurants rule', () => {
  assert.equal(foodAndDrink({ category: 'Restaurant' }), true);
  assert.equal(foodAndDrink({ category: 'Bar' }), true);
  assert.equal(foodAndDrink({ category: 'Cafe' }), true);
  assert.equal(foodAndDrink({ category: 'Hotel' }), false);
  assert.equal(foodAndDrink({ category: 'Diving' }), false);
  assert.equal(foodAndDrink({ category: 'Massage & spa' }), false);
  // An unrecognised category is what `reservation` has always meant.
  assert.equal(foodAndDrink({ category: 'Kopitiam' }), true);
  assert.equal(foodAndDrink({}), true);
});

test('a spa with no reported bill is not billed a table fee', async () => {
  // Before scoping, `reservation`'s $2 could reach any venue that fell back to
  // it. A per-cover fee at a venue with no covers is a charge a merchant
  // cannot make sense of, and one they are right to query.
  const rows = [];
  const DB = {
    prepare(q) {
      let a = [];
      const s = {
        bind: (...x) => { a = x; return s; },
        run: async () => {
          if (/INSERT OR IGNORE INTO num_commissions/.test(q)) rows.push({ kind: a[8], amount_cs: a[12] });
          return { meta: { changes: 1 } };
        },
        first: async () => null,
        all: async () => ({ results: [] }),
      };
      return s;
    },
    batch: async () => [],
  };
  const out = await accrue({ DB }, { bookingId: 'sp_1', place: { category: 'Massage & spa' } });
  assert.equal(out.kind, 'percent', 'a spa was billed a per-cover fee');
});


/* ══ whether NUM asks at all ════════════════════════════════════════════ */

test('tips are not offered until the venue switches them on', async () => {
  const e = env({ settings: { business_id: 'biz_1' } });
  assert.equal(await tipsOffered(e, RESTAURANT, 'biz_1'), false);
});

test('tips are offered once the venue has switched them on', async () => {
  const e = env({ settings: { business_id: 'biz_1', f_tips: 1 } });
  assert.equal(await tipsOffered(e, RESTAURANT, 'biz_1'), true);
});

test('a hotel is never asked to tip, whatever the flag says', async () => {
  const e = env({ settings: { business_id: 'biz_1', f_tips: 1 } });
  assert.equal(await tipsOffered(e, HOTEL, 'biz_1'), false);
});

test('the flag gates the OFFER and never the record', async () => {
  // tip() records money that has already moved. A flag must not be able to
  // make NUM forget that it did — a venue could otherwise switch tipping off
  // after the fact and erase the evidence that a guest left something.
  const e = env({ settings: { business_id: 'biz_1', f_tips: 0 } });
  const t = await tip(e, { bookingId: 'b_off', businessId: 'biz_1', amountCs: 400 });
  assert.equal(t.amount_cs, 400, 'a tip that happened must be recorded regardless');
  const src = readFileSync(join(HERE, 'aftertable.mjs'), 'utf8');
  const body = src.slice(src.indexOf('export async function tip('), src.indexOf('export async function tipsOffered('));
  assert.doesNotMatch(body, /f_tips/, 'tip() must not read the flag');
});
