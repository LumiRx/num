// The statement you can send a scout.
//
// These tests run the real handler against a real SQLite carrying the real
// scout schema. The assertions that matter are not about arithmetic — they are
// about NAMING, because the expensive mistake here is not an off-by-one, it is
// telling somebody "you generated 40 bookings" when you mean "we showed your
// hotels 40 times". That is a number they will do arithmetic on, and the
// conversation when the money does not follow is one nobody recovers from.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleScoutUsage, MEANING } from './scoutusage.mjs';

const SCHEMA = readFileSync(new URL('./migrations/0006_scouts.sql', import.meta.url), 'utf8');

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      const stmt = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: stmt.all(...args), success: true };
      stmt.run(...args);
      return { results: [], success: true };
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => ({ success: true, meta: { changes: db.prepare(sql).run(...args).changes } }),
  });
  return {
    prepare(sql) {
      const bound = (args) => ({ bind: (...more) => bound([...args, ...more]), ...shape(sql, args) });
      return bound([]);
    },
    batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
  };
}

let db;
let env;
const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, dest TEXT)`);
  db.exec(`CREATE TABLE num_affiliate_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT NOT NULL, programme TEXT,
    tagged INTEGER NOT NULL DEFAULT 0, event TEXT NOT NULL DEFAULT 'handoff',
    surface TEXT, kind TEXT, member_id TEXT, dest TEXT,
    place_id TEXT, scout_id TEXT, ts INTEGER NOT NULL)`);
  db.exec(`INSERT INTO num_scouts (id,name,email,email_lc,code,terms_version,agreed_at)
           VALUES ('sc_adam','Adam','a@b.c','a@b.c','ADAM','pre-terms','2026-09-01')`);
  db.exec(`INSERT INTO places (id,name,dest) VALUES
           ('h1','The Caledonian Edinburgh','edinburgh'),
           ('h2','W Edinburgh','edinburgh')`);
  db.exec(`INSERT INTO num_scout_places (id,scout_id,place_id,biz_name,state,finder_cents,share_bps,sub_share_bps)
           VALUES ('sp1','sc_adam','h1','The Caledonian','introduced',500,2000,2000),
                  ('sp2','sc_adam','h2','W Edinburgh','verified',500,2000,2000)`);
  // ADMIN_KEY because this endpoint is gated as of 3 Sep 2026 — it used to
  // answer 200 to the open internet with every scout's commission terms.
  env = { DB: d1(db), ADMIN_KEY: 'test-admin-key' };
});

const hand = (place, tagged = 1, host = 'hilton.sjv.io', ts = now()) =>
  db.exec(`INSERT INTO num_affiliate_clicks (host,tagged,event,place_id,scout_id,dest,ts)
           VALUES ('${host}',${tagged},'handoff','${place}','sc_adam','edinburgh',${ts})`);

const KEYED = { headers: { 'X-Admin-Key': 'test-admin-key' } };
const get = async (qs = '') =>
  (await handleScoutUsage(
    new Request(`https://app.itsnum.com/api/admin/scout-usage${qs}`, KEYED), env)).json();

/* ── the naming, which is the point ─────────────────────────────────────── */

describe('what the numbers are called', () => {
  test('nothing anywhere is called a booking or a click', async () => {
    hand('h1'); hand('h2');
    const body = await get('?code=ADAM');
    const text = JSON.stringify(body);
    // MEANING deliberately explains what a handoff is NOT, so the words appear
    // there legitimately. Everywhere else they must not.
    const withoutMeaning = JSON.stringify({ ...body, meaning: undefined });
    assert.ok(!/"bookings"|"clicks"/.test(withoutMeaning), withoutMeaning.slice(0, 400));
    assert.ok(/handoff/i.test(text));
  });

  test('the disclaimer ships as DATA, not as something a caller must remember', async () => {
    const body = await get('?code=ADAM');
    assert.equal(body.meaning.handoff, MEANING.handoff);
    assert.match(body.meaning.handoff, /NOT a click and NOT a booking/);
    assert.match(body.meaning.earned, /never be added together/);
  });

  test('earnings are read from the ledger, never derived from traffic', async () => {
    // 40 handoffs and nothing collected must report zero owed. If this number
    // could be computed from the traffic, it would be, and it would be wrong.
    for (let i = 0; i < 40; i++) hand('h1');
    const s = (await get('?code=ADAM')).scouts[0];
    assert.equal(s.handoffs, 40);
    assert.deepEqual(s.earned, [], 'traffic invented an amount owed');
  });

  test('a real earning shows up with its state and currency', async () => {
    db.exec(`INSERT INTO num_scout_earnings (id,scout_id,scout_place_id,kind,amount_minor,gross_minor,currency)
             VALUES ('e1','sc_adam','sp1','finder',500,500,'USD')`);
    const s = (await get('?code=ADAM')).scouts[0];
    assert.deepEqual(s.earned, [{ state: 'accrued', currency: 'USD', minor: 500, entries: 1 }]);
  });
});

/* ── the number that decides whether money can arrive at all ────────────── */

test('handoffs that cannot pay anyone are counted separately', async () => {
  // A handoff on a host with no affiliate programme earns NUM nothing, and
  // therefore earns the scout nothing. Folding it into one total is how a
  // scout is told their hotels are working when no money can possibly arrive.
  hand('h1', 1);
  hand('h2', 0);
  const s = (await get('?code=ADAM')).scouts[0];
  assert.equal(s.handoffs, 2);
  assert.equal(s.earning_handoffs, 1);
});

/* ── grouped by venue, because that is the useful question ─────────────── */

test('usage is grouped by VENUE, not by host', async () => {
  // Both hotels go out through the same Impact domain. A per-host total
  // cannot tell a scout which of their venues is working, which is the only
  // thing they actually want to know.
  hand('h1'); hand('h1'); hand('h2');
  const s = (await get('?code=ADAM')).scouts[0];
  assert.equal(s.venues_used, 2);
  const cal = s.by_venue.find((v) => v.place_id === 'h1');
  assert.equal(cal.handoffs, 2);
  assert.equal(cal.name, 'The Caledonian Edinburgh', 'the venue must be named, not just its id');
  assert.ok(cal.last_handoff, 'a scout asks "is it still being used", which needs a date');
});

test('a delisted place still reports its usage', async () => {
  // The row in `places` can be merged away by a dedupe pass. The handoff still
  // happened and somebody was still credited with it.
  hand('gone-from-directory');
  const s = (await get('?code=ADAM')).scouts[0];
  assert.equal(s.by_venue.find((v) => v.place_id === 'gone-from-directory').name, '(delisted)');
});

/* ── the terms travel with the statement ────────────────────────────────── */

test('the rates reported are the ones THIS scout was promised', async () => {
  db.exec(`UPDATE num_scouts SET share_bps = 3000 WHERE id = 'sc_adam'`);
  const s = (await get('?code=ADAM')).scouts[0];
  assert.equal(s.terms.share_bps, 3000, 'rates are locked at sign-up, not read off the programme');
  assert.equal(s.terms.finder, 500);
});

test('introductions are reported by state, so nothing looks earned early', async () => {
  const s = (await get('?code=ADAM')).scouts[0];
  assert.deepEqual(s.introduced, { introduced: 1, verified: 1 });
});

/* ── it must not fall over ──────────────────────────────────────────────── */

describe('robustness', () => {
  test('an unknown code is an empty list, not an error', async () => {
    const body = await get('?code=NOBODY');
    assert.equal(body.ok, true);
    assert.deepEqual(body.scouts, []);
    assert.equal(body.meaning.handoff, MEANING.handoff, 'the disclaimer ships even when empty');
  });

  test('no code at all reports every scout', async () => {
    hand('h1');
    const body = await get();
    assert.equal(body.scouts.length, 1);
    assert.equal(body.scouts[0].code, 'ADAM');
  });

  test('the window is clamped and honoured', async () => {
    hand('h1', 1, 'hilton.sjv.io', now() - 60 * 86400);
    assert.equal((await get('?code=ADAM&days=30')).scouts[0].handoffs, 0);
    assert.equal((await get('?code=ADAM&days=90')).scouts[0].handoffs, 1);
    assert.equal((await get('?code=ADAM&days=9999')).window_days, 365);
    assert.equal((await get('?code=ADAM&days=-5')).window_days, 30);
  });

  test('a missing click table reports zeroes rather than a 500', async () => {
    // An admin page that dies because one table has not been migrated is an
    // admin page nobody trusts during the exact incident they opened it for.
    db.exec('DROP TABLE num_affiliate_clicks');
    const body = await get('?code=ADAM');
    assert.equal(body.ok, true);
    assert.equal(body.scouts[0].handoffs, 0);
  });

  test('no DB is a 503, not a crash', async () => {
    const res = await handleScoutUsage(
      new Request('https://app.itsnum.com/api/admin/scout-usage', KEYED),
      { ADMIN_KEY: 'test-admin-key' });
    assert.equal(res.status, 503);
  });

  test('without the key it says nothing at all', async () => {
    // Until 3 Sep 2026 this answered 200 to anyone who guessed the path,
    // carrying scout names, referral codes, commission terms and money owed.
    const res = await handleScoutUsage(
      new Request('https://app.itsnum.com/api/admin/scout-usage'), env);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ['error']);
  });

  test('and it is shut, not open, when no key is configured', async () => {
    const res = await handleScoutUsage(
      new Request('https://app.itsnum.com/api/admin/scout-usage', KEYED), { DB: env.DB });
    assert.equal(res.status, 401, 'an unset ADMIN_KEY left the door open');
  });
});
