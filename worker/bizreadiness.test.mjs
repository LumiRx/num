// "Has this business got everything it needs to operate?" — the question that
// could not be asked of any table before bizreadiness.mjs existed.
//
// Real SQLite, real schema, and a D1 shim that THROWS on a missing table
// rather than returning null. That difference is the whole point of several
// tests below: production creates num_business_notify, num_paylinks and
// num_business_verification lazily, so "the table is not there" is the normal
// state for a young business — and reporting it as "not done" would chase a
// merchant for something we simply cannot see.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ITEMS, STAGES, checklistFor, stageOf, outstanding, readinessFor, roster, debts,
} from './bizreadiness.mjs';
import { agentIdFor, ensureAgent, agentBrief, agentReport, agentSweep, draftNudge, rollup } from './bizagent.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, p), 'utf8');

/** A D1 shim that does NOT swallow errors — a missing table must surface. */
function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      const st = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: st.all(...args), success: true };
      st.run(...args); return { results: [], success: true };
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
    },
  });
  return {
    prepare(sql) { const b = (a) => ({ bind: (...m) => b([...a, ...m]), ...shape(sql, a) }); return b([]); },
    batch: async (s) => Promise.all(s.map((x) => x.run())),
  };
}

const db = new DatabaseSync(':memory:');
const env = { DB: d1(db) };

before(() => {
  db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, category TEXT, dest TEXT, area TEXT,
    address TEXT, phone TEXT, website TEXT, hours TEXT, cuisine TEXT, rating REAL)`);
  db.exec(`CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, status TEXT, created_at TEXT)`);
  db.exec(`CREATE TABLE num_business_profiles (business_id TEXT PRIMARY KEY, vertical TEXT,
    commerce_status TEXT, country TEXT, city TEXT, timezone TEXT, place_id TEXT, phone_e164 TEXT,
    email TEXT, website TEXT, notify_channel TEXT DEFAULT 'none', notify_address TEXT,
    owner_agent TEXT, verified_at INTEGER, updated_at INTEGER)`);
  db.exec(`CREATE TABLE num_business_settings (business_id TEXT PRIMARY KEY, f_bookings INTEGER DEFAULT 0,
    commission_bp INTEGER DEFAULT 1000, updated_at INTEGER)`);
  db.exec(`CREATE TABLE num_place_owners (place_id TEXT PRIMARY KEY, business_id TEXT, claim_id TEXT,
    method TEXT, verified_at TEXT, revoked_at TEXT)`);
  db.exec(`CREATE TABLE num_claim_decisions (claim_id TEXT PRIMARY KEY, decision TEXT,
    decided_by TEXT, onboarded INTEGER DEFAULT 0, created_at TEXT)`);
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, business_name TEXT, contact_name TEXT,
    email TEXT, phone TEXT, country TEXT, state TEXT, place_id TEXT, created_at TEXT)`);
  db.exec(`CREATE TABLE num_booking_requests (place_id TEXT, created_at TEXT)`);
  db.exec(`CREATE TABLE num_asks (dest TEXT, text TEXT, ts TEXT)`);
  // The agent tables are created here rather than left to bizagent.ensure()
  // only because that function caches `ready` at module scope — correct in a
  // Worker isolate where the tables persist, wrong across a test file that
  // empties the database between cases. Same DDL, so ensure() is a no-op.
  db.exec(`CREATE TABLE num_business_agents (business_id TEXT PRIMARY KEY, agent_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', brief TEXT, brief_at TEXT,
    report TEXT, report_at TEXT, created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE num_business_agent_notes (id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
    ai_generated INTEGER NOT NULL DEFAULT 1, sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now')))`);
  // num_business_notify, num_paylinks and num_business_verification are
  // DELIBERATELY absent: that is production for a business nobody has
  // configured yet, and the code must degrade to `unknown` rather than false.
});

beforeEach(() => {
  for (const t of ['places', 'businesses', 'num_business_profiles', 'num_business_settings',
    'num_place_owners', 'num_claim_decisions', 'claims', 'num_booking_requests', 'num_asks',
    'num_business_agents', 'num_business_agent_notes']) {
    db.exec(`DELETE FROM ${t}`);
  }
});

/** A fully set-up business: account, ownership, decision, welcome, listing. */
function seedComplete({ notified = true } = {}) {
  db.exec(`INSERT INTO places (id,name,category,dest,area,address,phone,website,hours,cuisine)
    VALUES ('pl_suay','Suay Restaurant','Restaurant','phuket','Old Town','50 Takua Pa Rd',
            '+66 76 000000','https://suay.example','Mon-Sun 11:00-23:00','Thai')`);
  db.exec(`INSERT INTO businesses (id,name,status,created_at) VALUES ('biz_1','Suay Restaurant','active','2026-08-01')`);
  db.exec(`INSERT INTO num_business_profiles (business_id,vertical,commerce_status,city,timezone,place_id,
    phone_e164,email,notify_channel,notify_address,updated_at)
    VALUES ('biz_1','restaurant','active','Phuket','Asia/Bangkok','pl_suay','+6676000000','owner@suay.example',
            ${notified ? "'sms','+6676000000'" : "'none',NULL"},0)`);
  db.exec(`INSERT INTO num_business_settings (business_id,f_bookings,updated_at) VALUES ('biz_1',0,0)`);
  db.exec(`INSERT INTO num_place_owners (place_id,business_id,claim_id,method,verified_at)
    VALUES ('pl_suay','biz_1','7','sms','2026-08-02')`);
  db.exec(`INSERT INTO num_claim_decisions (claim_id,decision,decided_by,onboarded,created_at)
    VALUES ('7','approved','admin:cron',1,'2026-08-02')`);
}

describe('the checklist', () => {
  test('every item says whose move it is — a list that mixes them is unactionable', () => {
    for (const i of ITEMS) {
      assert.ok(['num', 'business'].includes(i.owner), `${i.id} has no owner`);
      assert.ok(i.why && i.why.length > 20, `${i.id} does not say why it matters`);
      assert.ok(typeof i.required === 'boolean', `${i.id} does not say whether it is required`);
    }
  });

  test('a missing table is "cannot see", never "not done"', async () => {
    seedComplete();
    const r = await readinessFor(env, 'biz_1');
    const qr = r.checklist.find((c) => c.id === 'pay_qr');
    assert.equal(qr.unknown, true, 'num_paylinks does not exist — that is unknown, not false');
    assert.equal(qr.done, false);
    const badge = r.checklist.find((c) => c.id === 'verified_badge');
    assert.equal(badge.unknown, true);
    // And nothing unknown is ever counted as something the business owes us.
    assert.equal(r.outstanding.theirs.some((c) => c.id === 'pay_qr'), false);
    assert.ok(r.outstanding.unknown.includes('pay_qr'));
  });

  test('whitespace and placeholders are not an address', () => {
    const c = checklistFor({ place: { address: '   ', hours: '-', phone: 'n/a' } });
    for (const id of ['address', 'hours', 'phone']) {
      assert.equal(c.find((x) => x.id === id).done, false, `${id} accepted a placeholder`);
    }
  });
});

describe('stage', () => {
  test('a complete business is operating', async () => {
    seedComplete();
    await ensureAgent(env, 'biz_1');
    const r = await readinessFor(env, 'biz_1');
    assert.equal(r.stage, 'operating');
    assert.deepEqual(r.outstanding.ours, []);
    assert.deepEqual(r.outstanding.theirs, []);
  });

  test('approved but never told is its own stage — the 30 Aug failure, named', async () => {
    seedComplete();
    db.exec(`UPDATE num_claim_decisions SET onboarded = 0 WHERE claim_id = '7'`);
    const r = await readinessFor(env, 'biz_1');
    assert.equal(r.stage, 'account_built');
    assert.deepEqual(r.outstanding.ours.map((c) => c.id).sort(), ['agent', 'welcomed']);
    // This is OUR debt, not theirs. Getting that backwards produces a nudge
    // to a business asking them to fix something we never did.
    assert.deepEqual(r.outstanding.theirs, []);
  });

  test('a listing with no hours is not ready, and it is the business that owes it', async () => {
    seedComplete();
    await ensureAgent(env, 'biz_1');
    db.exec(`UPDATE places SET hours = '' WHERE id = 'pl_suay'`);
    const r = await readinessFor(env, 'biz_1');
    assert.equal(r.stage, 'welcomed');
    assert.deepEqual(r.outstanding.theirs.map((c) => c.id), ['hours']);
    assert.deepEqual(r.outstanding.ours, []);
  });

  test('nobody to tell about a booking stops a listing short of operating', async () => {
    seedComplete({ notified: false });
    await ensureAgent(env, 'biz_1');
    const r = await readinessFor(env, 'biz_1');
    assert.equal(r.stage, 'listing_ready');
    assert.deepEqual(r.outstanding.theirs.map((c) => c.id), ['notify']);
  });

  test('every stage the code can produce is in the published list', () => {
    const ids = new Set(STAGES.map((s) => s.id));
    for (const combo of [[], ['account'], ['account', 'welcomed'],
      ['account', 'welcomed', 'hours', 'phone', 'address'],
      ['account', 'welcomed', 'hours', 'phone', 'address', 'notify']]) {
      const list = ITEMS.map((i) => ({ ...i, done: combo.includes(i.id), unknown: false }));
      assert.ok(ids.has(stageOf(list)), `stageOf produced an unlisted stage for ${combo}`);
    }
  });
});

describe('the roster', () => {
  test('a claim that never became an account is a prospect, not a bad business', async () => {
    seedComplete();
    db.exec(`INSERT INTO claims (id,business_name,contact_name,email,country,state,created_at)
      VALUES (99,'Fingal Hotel','Sean','sean@example.com','IE','new','2026-08-29')`);
    const r = await roster(env);
    assert.equal(r.counts.total, 1);
    assert.equal(r.counts.prospects, 1);
    assert.equal(r.prospects[0].business_name, 'Fingal Hotel');
    // It must NOT appear in the roster dragging the readiness numbers down.
    assert.equal(r.businesses.some((b) => b.name === 'Fingal Hotel'), false);
  });

  test('a claim that DID become an account is not double-counted as a prospect', async () => {
    seedComplete();
    db.exec(`INSERT INTO claims (id,business_name,email,state,created_at)
      VALUES (7,'Suay Restaurant','owner@suay.example','new','2026-08-01')`);
    const r = await roster(env);
    assert.equal(r.counts.prospects, 0, 'claim 7 already owns pl_suay');
  });

  test('what we owe is grouped by the switch that fixes it, not by business', async () => {
    seedComplete();
    db.exec(`UPDATE num_claim_decisions SET onboarded = 0`);
    db.exec(`INSERT INTO places (id,name,dest,address,phone,hours) VALUES ('pl_b','B','phuket','x','+66','Mon')`);
    db.exec(`INSERT INTO businesses (id,name,status,created_at) VALUES ('biz_2','B','active','2026-08-03')`);
    db.exec(`INSERT INTO num_business_profiles (business_id,vertical,place_id,email,notify_channel,notify_address,updated_at)
      VALUES ('biz_2','cafe','pl_b','b@example.com','sms','+66',0)`);
    db.exec(`INSERT INTO num_business_settings (business_id,updated_at) VALUES ('biz_2',0)`);
    db.exec(`INSERT INTO num_place_owners (place_id,business_id,claim_id,method,verified_at)
      VALUES ('pl_b','biz_2','8','email','2026-08-03')`);
    db.exec(`INSERT INTO num_claim_decisions (claim_id,decision,decided_by,onboarded) VALUES ('8','approved','cron',0)`);

    const grouped = debts(await roster(env));
    const welcome = grouped.find((g) => g.id === 'welcomed');
    assert.equal(welcome.businesses.length, 2, 'two businesses, one job');
    // Biggest job first — that is the ordering that makes the list a plan.
    assert.ok(grouped[0].businesses.length >= grouped[grouped.length - 1].businesses.length);
  });
});

describe('the per-business agent', () => {
  test('the id is derived, so running twice never makes a second agent', async () => {
    seedComplete();
    const a = await ensureAgent(env, 'biz_1');
    const b = await ensureAgent(env, 'biz_1');
    assert.equal(a.agent_id, b.agent_id);
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.agent_id, agentIdFor('biz_1'));
    const { results } = await env.DB.prepare('SELECT agent_id FROM num_business_agents').all();
    assert.equal(results.length, 1);
  });

  test('it finally writes owner_agent — the column nothing has ever used', async () => {
    seedComplete();
    const before = await env.DB.prepare('SELECT owner_agent FROM num_business_profiles WHERE business_id=?1')
      .bind('biz_1').first();
    assert.equal(before.owner_agent, null);
    await ensureAgent(env, 'biz_1');
    const after = await env.DB.prepare('SELECT owner_agent FROM num_business_profiles WHERE business_id=?1')
      .bind('biz_1').first();
    assert.equal(after.owner_agent, agentIdFor('biz_1'));
  });

  test('a business with no profile row still gets an agent', async () => {
    // This is exactly the business whose setup is most incomplete. Denying it
    // an agent would blind us to the ones that need watching most.
    db.exec(`INSERT INTO businesses (id,name,status,created_at) VALUES ('biz_x','Orphan','active','2026-08-01')`);
    const out = await ensureAgent(env, 'biz_x');
    assert.equal(out.ok, true);
    assert.equal(out.created, true);
  });

  test('the sweep gives every business an agent and is safe to re-run', async () => {
    seedComplete();
    db.exec(`INSERT INTO businesses (id,name,status,created_at) VALUES ('biz_2','B','active','2026-08-03')`);
    const first = await agentSweep(env);
    assert.equal(first.created, 2);
    const second = await agentSweep(env);
    assert.equal(second.created, 0, 'a sweep that re-creates agents makes duplicates every five minutes');
    assert.ok(second.refreshed >= 1, 'it should still refresh what it knows');
  });

  test('the report says whose move it is in one sentence', async () => {
    seedComplete();
    db.exec(`UPDATE num_claim_decisions SET onboarded = 0`);
    await ensureAgent(env, 'biz_1');
    const rep = await agentReport(env, 'biz_1');
    assert.deepEqual(rep.we_owe, ['welcomed']);
    assert.deepEqual(rep.they_owe, []);
    assert.match(rep.headline, /^Waiting on us:/);
  });

  test('a draft is stored unsent, and never invented when there is nothing to ask for', async () => {
    seedComplete();
    await ensureAgent(env, 'biz_1');
    assert.equal(await draftNudge(env, 'biz_1'), null,
      'a business with nothing outstanding must not be messaged');

    db.exec(`UPDATE places SET hours = '' WHERE id = 'pl_suay'`);
    const draft = await draftNudge(env, 'biz_1');
    assert.equal(draft.ai_generated, true);
    assert.equal(draft.sent_at, null, 'nothing this file writes may leave the building unreviewed');
    assert.match(draft.body, /Opening hours published/);
    const row = await env.DB.prepare(
      'SELECT sent_at, ai_generated FROM num_business_agent_notes WHERE business_id=?1',
    ).bind('biz_1').first();
    assert.equal(row.sent_at, null);
    assert.equal(row.ai_generated, 1);
  });

  test('the brief reports measured figures or null — never a plausible zero', async () => {
    seedComplete();
    await ensureAgent(env, 'biz_1');
    const brief = await agentBrief(env, 'biz_1');
    assert.equal(brief.booking_requests_all_time, 0, 'measured: the table exists and is empty');
    assert.equal(brief.asks_in_destination_30d, 0);
    const orphan = await agentBrief(env, 'nope');
    assert.equal(orphan, null, 'no business, no brief — not an empty brief that looks real');
  });

  test('the rollup is what makes 200 notes a system: one job, not 200 errands', async () => {
    seedComplete();
    db.exec(`UPDATE num_claim_decisions SET onboarded = 0`);
    await agentSweep(env);
    const out = await rollup(env);
    assert.equal(out.counts.total, 1);
    assert.equal(out.counts.agents, 1);
    assert.equal(out.counts.agents_missing, 0);
    assert.ok(out.our_move.some((d) => d.id === 'welcomed'));
    assert.ok(out.generated_at, 'a page without a timestamp cannot be judged stale');
  });
});

// A figure that is computed and never reaches a screen answers nothing. This
// codebase has shipped that bug before (bizdash's version stamp), so the
// wiring is asserted rather than assumed.
describe('it actually reaches a human', () => {
  test('the ops console has an onboarding tab that reads the same rollup', () => {
    const c = src('console.mjs');
    assert.match(c, /'onboarding'/, 'the tab is not in TABS');
    assert.match(c, /rollup\(env/, 'the console builds its own answer instead of reading bizagent.rollup');
    assert.match(c, /waiting on us/, 'the split by whose move it is never reaches the page');
  });

  test('the admin API exposes the roster, admin-gated like its neighbours', () => {
    const i = src('index.mjs');
    assert.match(i, /\/api\/admin\/biz-onboarding/);
    const route = i.slice(i.indexOf("/api/admin/biz-onboarding"), i.indexOf("/api/admin/twilio"));
    assert.match(route, /X-Admin-Key/, 'the roster is a commercial fact, not a public one');
    assert.match(route, /json\(404/, 'a wrong key must not reveal that the route exists');
  });

  test('the cron creates agents, and cannot take health monitoring down with it', () => {
    const i = src('index.mjs');
    assert.match(i, /agentSweep\(env\)/, 'agents are never created for a business nobody touches');
    const sweep = i.slice(i.indexOf('agentSweep(env)') - 400, i.indexOf('agentSweep(env)') + 300);
    assert.match(sweep, /catch\(\(e\) => console\.error\('\[bizagent\]'/, 'no failure domain of its own');
  });
});
