/**
 * Attributing the people a Num Expert actually brought in.
 *
 * The gap these tests close: `introduce()` needs a place_id, and most of what
 * an Expert signs up on a street has no listing in `places` — and a host never
 * will. Before this module those sign-ups were unattributable, which meant an
 * Expert could walk a whole block and show zero.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  attachScoutToClaim, attachScoutToHost, pendingFor, ensureScoutColumns, __resetSchema,
} from './scoutintro.mjs';

const read = (f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
const SCOUTS = read('./migrations/0006_scouts.sql');
const SCOUTS_REF = read('./migrations/0032_scout_referrals.sql');

function makeEnv() {
  __resetSchema();
  const d = new DatabaseSync(':memory:');
  d.exec(SCOUTS);
  d.exec(SCOUTS_REF);
  // The two columns the real tables have, minus everything this module never
  // touches. Deliberately WITHOUT scout_code: ensureScoutColumns must add it,
  // which is the thing production will have to do too.
  d.exec(`CREATE TABLE claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT, business_name TEXT NOT NULL,
    place_id TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE num_hosts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE num_place_owners (place_id TEXT PRIMARY KEY, business_id TEXT, revoked_at TEXT)`);
  d.exec(`INSERT INTO num_scout_terms (version,body,effective_at) VALUES ('v1','T','2026-08-01')`);
  d.exec(`INSERT INTO num_scouts (id,name,email,email_lc,code,terms_version,agreed_at)
          VALUES ('sc1','Isaiah Farmer','i@n.test','i@n.test','FARMER','v1','2026-09-15')`);
  d.exec(`INSERT INTO num_scouts (id,name,email,email_lc,code,terms_version,agreed_at,status)
          VALUES ('sc2','Gone','g@n.test','g@n.test','GONE','v1','2026-09-15','ended')`);
  d.exec(`INSERT INTO claims (id,business_name,place_id) VALUES (1,'Joe''s Tacos',NULL)`);
  d.exec(`INSERT INTO claims (id,business_name,place_id) VALUES (2,'Mai Thai','p1')`);
  d.exec(`INSERT INTO num_hosts (id,name,email,code) VALUES ('h1','Sean','s@n.test','SEAN-2222')`);

  const prep = (sql) => {
    let args = [];
    const api = {
      bind: (...a) => { args = a; return api; },
      first: async () => d.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: d.prepare(sql).all(...args) }),
      run: async () => { const r = d.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
      _exec: () => d.prepare(sql).run(...args),
    };
    return api;
  };
  return { DB: { prepare: prep, batch: async (st) => { for (const x of st) x._exec(); } }, _raw: d };
}

const PLACE = { id: 'p1', name: 'Mai Thai', dest: 'bangkok', country: 'TH', lat: 13.7, lng: 100.5 };

describe('a business with no listing', () => {
  test('THE GAP: the Expert is recorded even though there is no place to bind', async () => {
    const env = makeEnv();
    const r = await attachScoutToClaim(env, { claimId: 1, code: 'FARMER', place: null });
    assert.equal(r.ok, true);
    assert.equal(r.introduced, false, 'invented an introduction with no place');
    const row = env._raw.prepare('SELECT scout_code FROM claims WHERE id=1').get();
    assert.equal(row.scout_code, 'FARMER');
  });

  test('it does NOT spend the monthly cap — there is nothing to be first to', async () => {
    const env = makeEnv();
    await attachScoutToClaim(env, { claimId: 1, code: 'FARMER', place: null });
    const n = env._raw.prepare('SELECT COUNT(*) n FROM num_scout_places').get().n;
    assert.equal(n, 0, 'a lead consumed a claim slot');
  });

  test('a lowercase or spaced code off a card still lands', async () => {
    const env = makeEnv();
    const r = await attachScoutToClaim(env, { claimId: 1, code: ' farmer ', place: null });
    assert.equal(r.ok, true);
    assert.equal(env._raw.prepare('SELECT scout_code FROM claims WHERE id=1').get().scout_code, 'FARMER');
  });
});

describe('a business with a listing', () => {
  test('binds a real introduction, at the lead — not only at verify', async () => {
    const env = makeEnv();
    const r = await attachScoutToClaim(env, { claimId: 2, code: 'FARMER', place: PLACE });
    assert.equal(r.introduced, true);
    const sp = env._raw.prepare('SELECT * FROM num_scout_places WHERE place_id=?').get('p1');
    assert.equal(sp.scout_id, 'sc1');
    assert.equal(sp.state, 'introduced');
    assert.equal(sp.dest, 'bangkok');
  });

  test('the rates are copied onto the row, not read live later', async () => {
    const env = makeEnv();
    await attachScoutToClaim(env, { claimId: 2, code: 'FARMER', place: PLACE });
    const sp = env._raw.prepare('SELECT * FROM num_scout_places WHERE place_id=?').get('p1');
    assert.equal(sp.finder_cents, 500);
    assert.equal(sp.share_bps, 2000);
  });

  test('a second Expert on the same place does not overwrite the first', async () => {
    const env = makeEnv();
    env._raw.prepare(`INSERT INTO num_scouts (id,name,email,email_lc,code,terms_version,agreed_at)
                      VALUES ('sc3','Andrew','a@n.test','a@n.test','ANDREW','v1','2026-09-15')`).run();
    await attachScoutToClaim(env, { claimId: 2, code: 'FARMER', place: PLACE });
    await attachScoutToClaim(env, { claimId: 2, code: 'ANDREW', place: PLACE });
    const rows = env._raw.prepare('SELECT scout_id FROM num_scout_places WHERE place_id=?').all('p1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scout_id, 'sc1', 'first-come lost');
  });
});

describe('refusals are quiet and never write', () => {
  test('an unknown code records nothing at all', async () => {
    const env = makeEnv();
    // The column is added up front so the assertion below is about the VALUE.
    // Without this the test passes for the wrong reason: a refused code returns
    // before ensureScoutColumns runs, so the SELECT would fail on a missing
    // column rather than prove nothing was written.
    await ensureScoutColumns(env);
    const r = await attachScoutToClaim(env, { claimId: 1, code: 'NOBODY', place: null });
    assert.equal(r.ok, false);
    assert.equal(env._raw.prepare('SELECT scout_code FROM claims WHERE id=1').get().scout_code, null);
  });

  test('an ENDED Expert records nothing — they may have been removed for cause', async () => {
    const env = makeEnv();
    await ensureScoutColumns(env);
    const r = await attachScoutToClaim(env, { claimId: 1, code: 'GONE', place: null });
    assert.equal(r.ok, false);
    assert.equal(env._raw.prepare('SELECT scout_code FROM claims WHERE id=1').get().scout_code, null);
  });

  test('a refused code does not even touch the schema', async () => {
    const env = makeEnv();
    await attachScoutToClaim(env, { claimId: 1, code: 'NOBODY', place: null });
    const cols = env._raw.prepare('PRAGMA table_info(claims)').all().map((c) => c.name);
    assert.ok(!cols.includes('scout_code'), 'a junk query string altered a table');
  });

  test('first touch wins: a second code does not overwrite the first', async () => {
    const env = makeEnv();
    env._raw.prepare(`INSERT INTO num_scouts (id,name,email,email_lc,code,terms_version,agreed_at)
                      VALUES ('sc3','Andrew','a@n.test','a@n.test','ANDREW','v1','2026-09-15')`).run();
    await attachScoutToClaim(env, { claimId: 1, code: 'FARMER', place: null });
    await attachScoutToClaim(env, { claimId: 1, code: 'ANDREW', place: null });
    assert.equal(env._raw.prepare('SELECT scout_code FROM claims WHERE id=1').get().scout_code, 'FARMER');
  });

  test('nothing throws without a database, a code, or an id', async () => {
    assert.equal((await attachScoutToClaim({}, { code: 'FARMER' })).ok, false);
    assert.equal((await attachScoutToClaim(makeEnv(), {})).ok, false);
    assert.equal((await attachScoutToHost(makeEnv(), { code: 'FARMER' })).ok, false);
    assert.equal((await attachScoutToHost(makeEnv(), { hostId: 'h1' })).ok, false);
  });
});

describe('hosts', () => {
  test('a host is recorded on the host row', async () => {
    const env = makeEnv();
    const r = await attachScoutToHost(env, { hostId: 'h1', code: 'FARMER' });
    assert.equal(r.ok, true);
    assert.equal(env._raw.prepare('SELECT scout_code FROM num_hosts WHERE id=?').get('h1').scout_code, 'FARMER');
  });

  test('A HOST NEVER BECOMES EARNINGS. The terms price a business, not a guide.', async () => {
    const env = makeEnv();
    await attachScoutToHost(env, { hostId: 'h1', code: 'FARMER' });
    assert.equal(env._raw.prepare('SELECT COUNT(*) n FROM num_scout_earnings').get().n, 0);
    assert.equal(env._raw.prepare('SELECT COUNT(*) n FROM num_scout_places').get().n, 0);
  });
});

describe('what the Expert is shown', () => {
  test('leads and hosts are counted separately and said not to earn', async () => {
    const env = makeEnv();
    await attachScoutToClaim(env, { claimId: 1, code: 'FARMER', place: null });
    await attachScoutToHost(env, { hostId: 'h1', code: 'FARMER' });
    const p = await pendingFor(env, 'FARMER');
    assert.equal(p.leads, 1);
    assert.equal(p.hosts, 1);
    assert.equal(p.earning, false, 'a pending count must never read as money');
    assert.match(p.note, /does not earn|Neither earns/i);
  });

  test('a bound introduction is not double-counted as a pending lead', async () => {
    const env = makeEnv();
    await attachScoutToClaim(env, { claimId: 2, code: 'FARMER', place: PLACE });
    const p = await pendingFor(env, 'FARMER');
    assert.equal(p.leads, 0, 'a claim with a listing counted twice');
  });

  test('pendingFor is safe on a database that refuses everything', async () => {
    __resetSchema();
    const env = { DB: { prepare: () => { throw new Error('down'); } } };
    const p = await pendingFor(env, 'FARMER');
    assert.equal(p.leads, 0);
    assert.equal(p.hosts, 0);
  });
});

test('ensureScoutColumns is idempotent — it runs on every claim', async () => {
  const env = makeEnv();
  await ensureScoutColumns(env);
  __resetSchema();
  await ensureScoutColumns(env);
  const cols = env._raw.prepare('PRAGMA table_info(claims)').all().map((c) => c.name);
  assert.equal(cols.filter((c) => c === 'scout_code').length, 1);
});
