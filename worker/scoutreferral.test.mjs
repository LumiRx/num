// An expert who brings another expert — attribution, and a one-level override.
//
// The rule this file exists to hold down: ONE LEVEL. The referrer's own
// referrer earns nothing on the third person. `worker/scouts.mjs` and
// migration 0032 both say so in prose; prose does not fail a build, so the
// assertion lives here. If somebody adds a recursive walk over
// referred_by_scout_id, `an override never pays a second level` goes red.
//
// The second rule: an override is ADDED, never deducted. The recruit who did
// the walking is paid the fee they were told about, in full, and the override
// is Num's cost of having been introduced to them. A test asserts the
// recruit's own finder fee is untouched, because the cheapest way to make the
// numbers balance is also the one that quietly robs the person doing the work.
//
// Run against real SQLite with the real migrations, so the CHECK constraints
// and the code are tested together rather than separately.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  REFERRER_SHARE_BPS, REFERRER_TERM_MONTHS,
  enrol, introduce, markVerified, recordRevenue, resolveReferrer,
  tidyEmail, tidyName,
} from './scouts.mjs';

const sql = (f) => readFileSync(fileURLToPath(new URL(`./migrations/${f}`, import.meta.url)), 'utf8');
const SCHEMA = sql('0006_scouts.sql');
const REFERRALS = sql('0032_scout_referrals.sql');

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  d.exec(REFERRALS);
  // introduce() refuses a business Num already has an owner for. That table
  // belongs to the claim flow, not to 0006, so the shape it reads is declared
  // here rather than pulling an unrelated migration in.
  d.exec('CREATE TABLE num_place_owners (place_id TEXT PRIMARY KEY, revoked_at TEXT)');
  d.prepare("INSERT INTO num_scout_terms (version,body,effective_at) VALUES ('v1','the terms','2026-08-01')").run();

  // The D1 surface this code actually uses, over real SQLite. Errors are
  // thrown rather than swallowed: enrol() reads UNIQUE failures to decide
  // whether to remint a code, so a shim that hides them would test nothing.
  const DB = {
    prepare(text) {
      const b = [];
      const api = {
        bind(...a) { b.push(...a); return api; },
        async first() { return d.prepare(text).get(...b) ?? null; },
        async all() { return { results: d.prepare(text).all(...b) }; },
        async run() {
          const r = d.prepare(text).run(...b);
          return { meta: { changes: Number(r.changes ?? 0) } };
        },
      };
      return api;
    },
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  };
  return { d, env: { DB } };
}

/** A referrer who already exists, so a recruit has somebody to name. */
async function referrer(env, { name = 'Isaiah Ward', email = 'isaiah@example.com' } = {}) {
  const r = await enrol(env, { name, email });
  assert.equal(r.ok, true, r.why);
  return r;
}

const rowFor = (d, id) => d.prepare('SELECT * FROM num_scouts WHERE id=?').get(id);
const earningsOf = (d, scoutId) =>
  d.prepare('SELECT kind, amount_minor, gross_minor, scout_place_id FROM num_scout_earnings WHERE scout_id=? ORDER BY kind').all(scoutId);

/* ── the fields, cleaned once, on the server ─────────────────────────────── */

describe('a typed name is tidied, never corrected', () => {
  test('a name typed in one case is given its capitals back', () => {
    assert.equal(tidyName('  isaiah   ward '), 'Isaiah Ward');
    assert.equal(tidyName('ADAM OSMAN'), 'Adam Osman');
    assert.equal(tidyName('mary-jane okafor'), 'Mary-Jane Okafor');
  });

  test('a name somebody chose the case of is left exactly as typed', () => {
    // The whole point of the rule. Renaming people is worse than a lowercase
    // row in a table.
    assert.equal(tidyName('van der Berg'), 'van der Berg');
    assert.equal(tidyName('bell hooks II'), 'bell hooks II');
    assert.equal(tidyName("Siobhán O'Neill"), "Siobhán O'Neill");
  });

  test('nothing typed stays nothing', () => {
    assert.equal(tidyName(''), '');
    assert.equal(tidyName(null), '');
  });
});

describe('an email is lower-cased, and a typo is suggested rather than applied', () => {
  test('a mistyped domain comes back as a suggestion, with the address untouched', () => {
    const out = tidyEmail('  Isaiah@GMIAL.com ');
    assert.equal(out.email, 'isaiah@gmial.com');
    assert.equal(out.valid, true);
    assert.equal(out.suggestion, 'isaiah@gmail.com');
  });

  test('a good address suggests nothing', () => {
    const out = tidyEmail('adam@itsnum.com');
    assert.equal(out.email, 'adam@itsnum.com');
    assert.equal(out.valid, true);
    assert.ok(!out.suggestion);
  });

  test('a non-address is not valid and is not guessed at', () => {
    const out = tidyEmail('isaiah at gmail');
    assert.equal(out.valid, false);
    assert.ok(!out.suggestion);
  });
});

/* ── who sent them ───────────────────────────────────────────────────────── */

describe('resolving who referred somebody', () => {
  test('a real active code resolves to that expert', async () => {
    const { env } = db();
    const ref = await referrer(env);
    const out = await resolveReferrer(env, ref.code);
    assert.equal(out.scoutId, ref.id);
    assert.equal(out.note, null);
    assert.equal(out.why, null);
  });

  test('a word that is not a code is kept as a note and carries no money', async () => {
    const { env } = db();
    const out = await resolveReferrer(env, 'Instagram');
    assert.equal(out.scoutId, null);
    assert.equal(out.note, 'Instagram');
  });

  test('a code shaped right but belonging to nobody says so', async () => {
    const { env } = db();
    const out = await resolveReferrer(env, 'ZZZZZZ');
    assert.equal(out.scoutId, null);
    assert.equal(out.note, 'ZZZZZZ');
    assert.match(out.why, /not one of ours/);
  });

  test('an expert who is no longer active cannot be named as a referrer', async () => {
    const { d, env } = db();
    const ref = await referrer(env);
    d.prepare("UPDATE num_scouts SET status='paused' WHERE id=?").run(ref.id);
    const out = await resolveReferrer(env, ref.code);
    assert.equal(out.scoutId, null);
    assert.match(out.why, /paused/);
  });

  test('you cannot refer yourself — the first thing anybody tries', async () => {
    const { env } = db();
    const ref = await referrer(env);
    const out = await resolveReferrer(env, ref.code, { selfEmailLc: 'isaiah@example.com' });
    assert.equal(out.scoutId, null);
    assert.equal(out.note, null, 'a self-referral is not even kept as a note');
    assert.match(out.why, /cannot refer yourself/);
  });
});

/* ── sign-up ─────────────────────────────────────────────────────────────── */

describe('signing up with a referrer', () => {
  test('the relationship, the rate and the end date are written in one row', async () => {
    const { d, env } = db();
    const ref = await referrer(env);
    const now = new Date('2026-09-18T12:00:00.000Z');

    const out = await enrol(env, {
      name: 'adam osman', email: 'ADAM@example.com', referredBy: ref.code, now,
    });
    assert.equal(out.ok, true, out.why);
    assert.deepEqual(out.referredBy, { name: 'Isaiah Ward', code: ref.code });

    const row = rowFor(d, out.id);
    assert.equal(row.name, 'Adam Osman', 'the name was tidied on the way in');
    assert.equal(row.email_lc, 'adam@example.com');
    assert.equal(row.referred_by_scout_id, ref.id);
    assert.equal(row.referred_by_note, null);
    assert.equal(row.referrer_share_bps, REFERRER_SHARE_BPS);
    assert.equal(row.referrer_ends_at.slice(0, 10), '2027-09-18',
      `the override runs ${REFERRER_TERM_MONTHS} months from sign-up`);
  });

  test('somebody who arrives alone owes nobody anything', async () => {
    const { d, env } = db();
    const out = await enrol(env, { name: 'Solo Person', email: 'solo@example.com' });
    const row = rowFor(d, out.id);
    assert.equal(row.referred_by_scout_id, null);
    assert.equal(row.referrer_share_bps, 0, 'a row that names nobody cannot start owing anybody');
    assert.equal(row.referrer_ends_at, null);
  });

  test('"my cousin" is recorded as what was typed and grants no override', async () => {
    const { d, env } = db();
    const out = await enrol(env, { name: 'Ana', email: 'ana@example.com', referredBy: 'my cousin' });
    const row = rowFor(d, out.id);
    assert.equal(row.referred_by_scout_id, null);
    assert.equal(row.referred_by_note, 'my cousin');
    assert.equal(row.referrer_share_bps, 0);
    assert.equal(out.referredBy, null);
    assert.equal(out.referrerNote, 'my cousin');
  });

  test('a bad referrer code does not cost somebody their sign-up', async () => {
    // The person in front of us is real and joining. A typo in the box below
    // their name is worth an explanation, never a refusal.
    const { env } = db();
    const out = await enrol(env, { name: 'Ana', email: 'ana2@example.com', referredBy: 'ZZZZZZ' });
    assert.equal(out.ok, true);
    assert.match(out.referrerWhy, /not one of ours/);
  });

  test('a phone that cannot be read is refused, not quietly stored as nothing', async () => {
    const { env } = db();
    const out = await enrol(env, { name: 'Ana', email: 'ana3@example.com', phone: '12345', country: 'US' });
    assert.equal(out.ok, false);
    assert.match(out.why, /phone number/);
  });

  test('a readable phone is stored in one shape', async () => {
    const { d, env } = db();
    const out = await enrol(env, {
      name: 'Ana', email: 'ana4@example.com', phone: '(213) 555-0148', country: 'US',
    });
    assert.equal(out.ok, true, out.why);
    assert.equal(rowFor(d, out.id).phone, '+12135550148');
  });

  test('no phone at all is fine — the field is optional', async () => {
    const { d, env } = db();
    const out = await enrol(env, { name: 'Ana', email: 'ana5@example.com', phone: '' });
    assert.equal(out.ok, true, out.why);
    assert.equal(rowFor(d, out.id).phone, null);
  });
});

/* ── introductions and money ─────────────────────────────────────────────── */

/** Walk one place from introduced to activated, and hand back the earnings. */
async function activate(env, { scoutId, placeId = 'p_cafe', now = new Date('2026-10-01T00:00:00.000Z') }) {
  const intro = await introduce(env, { scoutId, placeId, bizName: 'A Cafe', dest: 'Los Angeles', now });
  assert.equal(intro.ok, true, intro.why);
  await markVerified(env, { placeId, now });
  const rev = await recordRevenue(env, { placeId, amountMinor: 900, now });
  assert.equal(rev.activated, true, 'crossing the $5 gate activates the place');
  return intro;
}

describe('the override, once money actually appears', () => {
  test('the referrer earns a share of the recruit\'s fee, and the recruit still gets all of theirs', async () => {
    const { d, env } = db();
    const ref = await referrer(env);
    const recruit = await enrol(env, {
      name: 'Adam', email: 'adam2@example.com', referredBy: ref.code,
      now: new Date('2026-09-18T12:00:00.000Z'),
    });

    await activate(env, { scoutId: recruit.id });

    const mine = earningsOf(d, recruit.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].kind, 'finder');
    assert.equal(mine[0].amount_minor, 500, 'the recruit is paid the full $5.00 they were told about');

    const theirs = earningsOf(d, ref.id);
    assert.equal(theirs.length, 1);
    assert.equal(theirs[0].kind, 'referrer_override');
    assert.equal(theirs[0].amount_minor, 50, '10% of the $5.00 fee, added rather than deducted');
    assert.equal(theirs[0].scout_place_id, mine[0].scout_place_id,
      'the override hangs off the recruit\'s place, so one place can only ever pay one');
  });

  test('an override never pays a second level', async () => {
    // THE RULE. Three experts in a line: the first brought the second, the
    // second brought the third. When the third earns, the second is paid and
    // the FIRST IS PAID NOTHING. If this ever goes red, somebody has added a
    // recursive walk over referred_by_scout_id and turned a referral bonus
    // into the thing the FTC prosecutes.
    const { d, env } = db();
    const first = await referrer(env, { name: 'First', email: 'first@example.com' });
    const second = await enrol(env, { name: 'Second', email: 'second@example.com', referredBy: first.code });
    const third = await enrol(env, { name: 'Third', email: 'third@example.com', referredBy: second.code });

    await activate(env, { scoutId: third.id });

    assert.equal(earningsOf(d, third.id).length, 1, 'the third earns their own fee');
    assert.equal(earningsOf(d, second.id).length, 1, 'the second earns the override');
    assert.deepEqual(earningsOf(d, first.id), [], 'the first earns nothing on the third person');
  });

  test('a place introduced after the term ends carries no override at all', async () => {
    const { d, env } = db();
    const ref = await referrer(env);
    const recruit = await enrol(env, {
      name: 'Adam', email: 'adam3@example.com', referredBy: ref.code,
      now: new Date('2026-09-18T12:00:00.000Z'),
    });

    // Thirteen months later: past the twelve-month term.
    await activate(env, { scoutId: recruit.id, now: new Date('2027-10-18T00:00:00.000Z') });

    const place = d.prepare('SELECT referrer_scout_id, referrer_share_bps FROM num_scout_places WHERE scout_id=?').get(recruit.id);
    assert.equal(place.referrer_scout_id, null, 'what a place owes is readable off the place, forever');
    assert.equal(place.referrer_share_bps, 0);
    assert.deepEqual(earningsOf(d, ref.id), []);
  });

  test('a place introduced inside the term still pays when it activates years later', async () => {
    // The introduction is the thing that was referred. A business that takes
    // its time to produce revenue does not erase who brought the person who
    // brought it.
    const { d, env } = db();
    const ref = await referrer(env);
    const recruit = await enrol(env, {
      name: 'Adam', email: 'adam4@example.com', referredBy: ref.code,
      now: new Date('2026-09-18T12:00:00.000Z'),
    });

    const intro = await introduce(env, {
      scoutId: recruit.id, placeId: 'p_slow', bizName: 'Slow Bar',
      now: new Date('2026-10-01T00:00:00.000Z'),
    });
    assert.equal(intro.ok, true, intro.why);

    await recordRevenue(env, { placeId: 'p_slow', amountMinor: 900, now: new Date('2028-03-01T00:00:00.000Z') });

    const theirs = earningsOf(d, ref.id);
    assert.equal(theirs.length, 1);
    assert.equal(theirs[0].amount_minor, 50);
  });

  test('revenue recorded twice does not pay the override twice', async () => {
    const { d, env } = db();
    const ref = await referrer(env);
    const recruit = await enrol(env, { name: 'Adam', email: 'adam5@example.com', referredBy: ref.code });

    await activate(env, { scoutId: recruit.id });
    const again = await recordRevenue(env, { placeId: 'p_cafe', amountMinor: 900, now: new Date('2026-10-02T00:00:00.000Z') });
    assert.equal(again.activated, false, 'a place only crosses its gate once');

    assert.equal(earningsOf(d, ref.id).length, 1);
    assert.equal(earningsOf(d, recruit.id).length, 1);
  });

  test('a paused referrer stops collecting on people they have not brought yet', async () => {
    const { d, env } = db();
    const ref = await referrer(env);
    d.prepare("UPDATE num_scouts SET status='paused' WHERE id=?").run(ref.id);

    const recruit = await enrol(env, { name: 'Adam', email: 'adam6@example.com', referredBy: ref.code });
    await activate(env, { scoutId: recruit.id });

    assert.deepEqual(earningsOf(d, ref.id), []);
    assert.equal(earningsOf(d, recruit.id).length, 1, 'the recruit is unaffected — they still earn');
  });
});
