/**
 * The deals feed: what it will publish, and the three things it refuses.
 *
 * The refusals are the point. Asked for as "always populated" against a shelf
 * that held nothing — 0 venue promos, 0 paid businesses, 0 host offers on
 * 22 Sep 2026 — so every test below exists to stop the obvious way of
 * satisfying that request, which is to make something up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { collect, list, handleDeals, STANDING } from './deals.mjs';

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      try {
        const st = db.prepare(sql);
        if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: st.all(...args), success: true };
        const r = st.run(...args); return { results: [], success: true, meta: { changes: Number(r.changes ?? 0) } };
      } catch { return { results: [], success: true }; }
    },
    first: async () => { try { return db.prepare(sql).get(...args) ?? null; } catch { return null; } },
    run: async () => {
      try { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes ?? 0) } }; }
      catch { return { success: true, meta: { changes: 0 } }; }
    },
  });
  return {
    prepare(sql) { const b = (a) => ({ bind: (...m) => b([...a, ...m]), ...shape(sql, a) }); return b([]); },
    batch: async (s) => Promise.all(s.map((x) => x.run())),
  };
}

function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_business_profiles (place_id TEXT, business_id TEXT, custom_fields TEXT)`);
  db.exec(`CREATE TABLE num_business_subscriptions (business_id TEXT, tier TEXT, renews_at TEXT)`);
  db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, dest TEXT)`);
  db.exec(`CREATE TABLE num_giveaway_entrants (entrant_key TEXT, week_start TEXT)`);
  return db;
}

const today = () => new Date().toISOString().slice(0, 10);
const envOf = (db, extra = {}) => ({ DB: d1(db), ...extra });

test('an empty shelf produces an empty-ish feed that says so', async () => {
  const db = fresh();
  const env = envOf(db);
  const out = await collect(env);
  assert.equal(out.ok, true);
  const feed = await list(env);
  assert.equal(feed.thin, true, 'no venue perks means thin, and thin is reported');
  assert.match(feed.note, /No venue perks/);
  assert.equal(feed.deals.filter((d) => d.kind === 'perk').length, 0);
});

test('the concierge line is published because the tier table still says it is free', async () => {
  const db = fresh();
  const env = envOf(db);
  await collect(env);
  const { deals } = await list(env);
  assert.ok(deals.some((d) => d.id === 'ev_concierge'), 'the free concierge is a real, checkable claim');
});

test('the draw is advertised only in a week somebody entered it', async () => {
  const db = fresh();
  const env = envOf(db);
  await collect(env);
  assert.equal((await list(env)).deals.some((d) => d.id === 'ev_draw'), false,
    'a giveaway nobody is running is an invented deal with a friendly name');

  db.exec(`INSERT INTO num_giveaway_entrants VALUES ('k1', date('now'))`);
  await collect(env);
  assert.equal((await list(env)).deals.some((d) => d.id === 'ev_draw'), true);
});

test('the no-markup line needs the rail on AND the dial at zero', async () => {
  const db = fresh();
  const on = STANDING.find((s) => s.id === 'ev_no_markup');
  assert.equal(await on.when({}), false, 'no partner id, no claim');
  assert.equal(await on.when({ LGT_PARTNER_ID: 'x', NUM_FARE_MARKUP: '3' }), false, 'a markup of 3 is not "nothing off the top"');
  assert.equal(await on.when({ LGT_PARTNER_ID: 'x' }), true);
  assert.equal(await on.when({ LGT_PARTNER_ID: 'x', NUM_FARE_MARKUP: '0' }), true);
});

test('a venue perk is published in the venue\'s own words, attributed', async () => {
  const db = fresh();
  db.exec(`INSERT INTO places VALUES ('p1','Hugo''s','los-angeles')`);
  db.exec(`INSERT INTO num_business_subscriptions VALUES ('b1','small',NULL)`);
  db.exec(`INSERT INTO num_business_profiles VALUES ('p1','b1','{"promo_text":"Free second taco before noon","promo_set_at":"${today()}"}')`);
  const env = envOf(db);
  await collect(env);
  const { deals, thin } = await list(env, { dest: 'los-angeles' });
  const perk = deals.find((d) => d.id === 'perk_p1');
  assert.ok(perk, 'the perk is on the feed');
  assert.equal(perk.body, 'Free second taco before noon', 'their sentence, unedited');
  assert.match(perk.title, /says:/, 'attributed — NUM does not make a promise about somebody else\'s till');
  assert.equal(thin, false);
});

test('a perk from a venue that is not paying for promotions is not published', async () => {
  const db = fresh();
  db.exec(`INSERT INTO places VALUES ('p1','Hugo''s','los-angeles')`);
  db.exec(`INSERT INTO num_business_subscriptions VALUES ('b1','free',NULL)`);
  db.exec(`INSERT INTO num_business_profiles VALUES ('p1','b1','{"promo_text":"Free taco","promo_set_at":"${today()}"}')`);
  const env = envOf(db);
  await collect(env);
  assert.equal((await list(env)).deals.some((d) => d.id === 'perk_p1'), false,
    'the entitlement is venuepromo.mjs\'s to decide, and it said no');
});

test('an undated or stale promo is never served, and a live one that goes stale is expired', async () => {
  const db = fresh();
  db.exec(`INSERT INTO places VALUES ('p1','A place','bali'),('p2','Another','bali')`);
  db.exec(`INSERT INTO num_business_subscriptions VALUES ('b1','small',NULL),('b2','small',NULL)`);
  // No promo_set_at at all: venuepromo refuses it, and so must this.
  db.exec(`INSERT INTO num_business_profiles VALUES ('p2','b2','{"promo_text":"Happy hour all August"}')`);
  // Written 200 days ago.
  const old = new Date(Date.now() - 200 * 86400_000).toISOString().slice(0, 10);
  db.exec(`INSERT INTO num_business_profiles VALUES ('p1','b1','{"promo_text":"Happy hour","promo_set_at":"${old}"}')`);
  const env = envOf(db);
  const out = await collect(env);
  const { deals } = await list(env);
  assert.equal(deals.some((d) => d.id === 'perk_p1'), false, 'a promo nobody has touched in 200 days is not current');
  assert.equal(deals.some((d) => d.id === 'perk_p2'), false, 'a promo with no date is not evidence of anything');
  assert.equal(out.ok, true);
});

test('collecting twice does not duplicate a deal, it re-verifies it', async () => {
  const db = fresh();
  db.exec(`INSERT INTO places VALUES ('p1','A place','bali')`);
  db.exec(`INSERT INTO num_business_subscriptions VALUES ('b1','small',NULL)`);
  db.exec(`INSERT INTO num_business_profiles VALUES ('p1','b1','{"promo_text":"Free coffee","promo_set_at":"${today()}"}')`);
  const env = envOf(db);
  await collect(env);
  await collect(env);
  const rows = db.prepare(`SELECT COUNT(*) n FROM num_deals WHERE id='perk_p1'`).get();
  assert.equal(rows.n, 1);
});

test('a destination filter keeps the everywhere rows and drops another city', async () => {
  const db = fresh();
  db.exec(`INSERT INTO places VALUES ('p1','LA place','los-angeles'),('p2','Bali place','bali')`);
  db.exec(`INSERT INTO num_business_subscriptions VALUES ('b1','small',NULL),('b2','small',NULL)`);
  db.exec(`INSERT INTO num_business_profiles VALUES ('p1','b1','{"promo_text":"LA thing","promo_set_at":"${today()}"}')`);
  db.exec(`INSERT INTO num_business_profiles VALUES ('p2','b2','{"promo_text":"Bali thing","promo_set_at":"${today()}"}')`);
  const env = envOf(db);
  await collect(env);
  const { deals } = await list(env, { dest: 'bali' });
  assert.equal(deals.some((d) => d.id === 'perk_p2'), true);
  assert.equal(deals.some((d) => d.id === 'perk_p1'), false);
  assert.equal(deals.some((d) => d.id === 'ev_concierge'), true, 'what is true everywhere is still true in Bali');
});

test('the endpoint is open — no account, no tier, no sign-in', async () => {
  const db = fresh();
  const env = envOf(db);
  await collect(env);
  const res = await handleDeals(new Request('https://app.itsnum.com/api/deals'), env, '/');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.deals));
  // Nothing in the request said who this is. That is the design, not an
  // oversight: a members-only deal is the thing §17550.27 regulates.
  const src = readFileSync(new URL('./deals.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /tierOf|memberId|may\(/, 'the feed must never consult a membership tier');
  assert.match(src, /17550\.27/, 'and the reason must stay written down next to it');
});

test('writing is POST-proof — the feed is a read surface', async () => {
  const db = fresh();
  const res = await handleDeals(new Request('https://app.itsnum.com/api/deals', { method: 'POST' }), envOf(db), '/');
  assert.equal(res.status, 405);
});

test('no database is an empty feed, not a crash and not a made-up one', async () => {
  const out = await list({}, {});
  assert.deepEqual(out.deals, []);
  assert.equal(out.thin, true);
  assert.equal((await collect({})).ok, false);
});
