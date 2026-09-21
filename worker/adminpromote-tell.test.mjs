// Promote with owner:true must TELL the business (21 Sep 2026).
// Before: the sign-in link went only back to the admin; nobody emailed it.
// Derived from adminsubmissions.test.mjs's fixtures.
//
// Found live 29 Aug 2026: a business (Fingal Hotel) submitted itself through
// /claim/ without picking the listing NUM already held for it — same phone
// number, digit for digit. Nothing in the codebase had ever read
// num_place_submissions after growth/worker.js wrote it: no geocoding, no
// dedup, no promotion, exactly as worker/migrations/0007_place_submissions.sql
// always said should happen ("held, geocoded and reviewed... then promoted"),
// none of it built. The submission sat in 'new' forever. This is the missing
// half: a queue an admin can act on, and the two ways a submission is
// actually resolved — link it to a listing that already exists, or promote
// it into a brand new one.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __testables } from './console.mjs';
import { DESTINATIONS } from '../scripts/destinations.mjs';

const { adminSubmissionPromote } = __testables;
const HERE = dirname(fileURLToPath(import.meta.url));

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
const env = { DB: d1(db), RESEND_KEY: 'test', MAIL_FROM: 'NUM <hello@itsnum.com>' };

before(() => {
  db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, name_local TEXT, category TEXT,
    lat REAL NOT NULL, lng REAL NOT NULL, cell_lat INTEGER, cell_lng INTEGER, dest TEXT NOT NULL,
    area TEXT, country TEXT, phone TEXT, website TEXT, email TEXT, address TEXT, source TEXT,
    status TEXT DEFAULT 'unclaimed', business_id TEXT)`);
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, business_name TEXT, place_id TEXT,
    state TEXT DEFAULT 'new', contact_name TEXT, phone TEXT, email TEXT, source TEXT,
    country TEXT, decided_at TEXT, decided_by TEXT,
    created_at TEXT DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE num_claims (id TEXT PRIMARY KEY, place_id TEXT, business_id TEXT,
    state TEXT, channel TEXT, channel_value TEXT, code_hash TEXT, code_salt TEXT,
    claimant_name TEXT, claimant_email TEXT, claimant_phone TEXT, review_reason TEXT,
    decided_at TEXT, decided_by TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  db.exec('CREATE TABLE num_claim_events (claim_id TEXT, event TEXT)');
  db.exec(`CREATE TABLE num_place_submissions (id TEXT PRIMARY KEY, name TEXT NOT NULL,
    name_local TEXT, address TEXT, website TEXT, category TEXT, phone TEXT, email TEXT,
    country TEXT, dest TEXT, lat REAL, lng REAL, claim_id INTEGER,
    status TEXT NOT NULL DEFAULT 'new', place_id TEXT, review_note TEXT,
    created_at TEXT DEFAULT (datetime('now')), reviewed_at TEXT)`);

  // The tables the owner path writes. Promotion used to stop at `places`,
  // which is exactly why a business that had already signed up was made to
  // sign up again.
  db.exec(`CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, kind TEXT, category TEXT,
    territory TEXT, status TEXT, onboarded_by TEXT, notes TEXT,
    created_at TEXT DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE num_place_owners (place_id TEXT PRIMARY KEY, business_id TEXT NOT NULL,
    claim_id INTEGER, method TEXT, phone TEXT,
    verified_at TEXT DEFAULT (datetime('now')), revoked_at TEXT)`);
  db.exec(`CREATE TABLE num_business_profiles (business_id TEXT PRIMARY KEY, vertical TEXT,
    country TEXT, city TEXT, area TEXT, address TEXT, lat REAL, lng REAL, timezone TEXT,
    place_id TEXT, phone_e164 TEXT, email TEXT, website TEXT, verified_by TEXT,
    verified_at INTEGER, created_at INTEGER, updated_at INTEGER)`);
  db.exec(`CREATE TABLE num_business_settings (business_id TEXT PRIMARY KEY,
    commission_bps INTEGER, currency TEXT, created_at INTEGER, updated_at INTEGER,
    updated_by TEXT)`);
  db.exec(`CREATE TABLE destinations (slug TEXT PRIMARY KEY, name TEXT, tz TEXT, country TEXT)`);
  db.exec(`CREATE TABLE num_business_users (id TEXT PRIMARY KEY, business_id TEXT, email TEXT,
    name TEXT, role TEXT, status TEXT, created_at INTEGER)`);
  db.exec(`INSERT INTO destinations (slug,name,tz,country)
    VALUES ('edinburgh','Edinburgh','Europe/London','GB')`);
});

beforeEach(() => {
  db.exec('DELETE FROM places; DELETE FROM claims; DELETE FROM num_place_submissions;');
  db.exec('DELETE FROM num_business_users; DROP TABLE IF EXISTS num_claim_decisions;');
  db.exec('DELETE FROM businesses; DELETE FROM num_place_owners; DELETE FROM num_business_profiles;');
  db.prepare(`INSERT INTO places (id,name,lat,lng,dest,area,country,phone,email,website)
    VALUES ('pl_fingal','Fingal Hotel',55.98,-3.17,'edinburgh','Edinburgh','GB',
            '+441313575000','reservations@fingal.co.uk','https://fingal.co.uk')`).run();
  db.prepare(`INSERT INTO claims (id,business_name,place_id,state) VALUES (15,'Fingal Hotel',NULL,'new')`).run();
  db.prepare(`INSERT INTO num_place_submissions
      (id,name,address,phone,email,country,claim_id,status)
    VALUES ('sub_fingal','Fingal Hotel','Alexandra, Dock Pl, Edinburgh','+441313575000',
            'Reservations@Fingal.co.uk','GB',15,'new')`).run();
});


let sent = [];
let resendUp = true;
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      if (!resendUp) return new Response('{"message":"down"}', { status: 500 });
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    return realFetch(url, init);
  };
});
beforeEach(() => { sent = []; resendUp = true; });

const edinburgh = DESTINATIONS.find((d) => d.slug === 'edinburgh') ?? DESTINATIONS[0];
const promote = (extra) => adminSubmissionPromote(env, new Request('https://app.itsnum.com/api/admin/submissions/promote', {
  method: 'POST',
  body: JSON.stringify({ submission_id: 'sub_fingal', lat: 55.98, lng: -3.17, dest: edinburgh.slug, ...extra }),
}));

describe('promote owner:true — the business is told', () => {
  test('the onboarding email goes to the submitter, with a one-use sign-in link', async () => {
    const body = await (await promote({ by: 'dre', owner: true })).json();
    assert.equal(body.ok, true);
    assert.equal(sent.length, 1, 'exactly one email to the business: ' + JSON.stringify(body.told));
    assert.deepEqual(sent[0].to, ['reservations@fingal.co.uk']);
    assert.match(sent[0].text, /\/api\/biz\/console\?t=/, 'the email carries the sign-in link');
    assert.equal(body.told.sent, true);
  });

  test('the approval is on the ledger, so the retry sweep can see it', async () => {
    await promote({ by: 'dre', owner: true });
    const d = db.prepare("SELECT decision, decided_by FROM num_claim_decisions WHERE claim_id='15'").get();
    assert.equal(d.decision, 'approved');
    assert.equal(d.decided_by, 'admin:dre');
  });

  test('the owner gets a login row, lower-cased, for the /biz email sign-in', async () => {
    const body = await (await promote({ by: 'dre', owner: true })).json();
    const u = db.prepare('SELECT business_id, email, role, status FROM num_business_users').get();
    assert.equal(u.business_id, body.business_id);
    assert.equal(u.email, 'reservations@fingal.co.uk');
    assert.equal(u.role, 'owner');
    assert.equal(u.status, 'active');
  });

  test('a mail outage never undoes the promotion, and says so', async () => {
    resendUp = false;
    const body = await (await promote({ by: 'dre', owner: true })).json();
    assert.equal(body.ok, true);
    assert.equal(body.told.sent, false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM businesses').get().n, 1);
  });

  test('without owner:true nobody is emailed and no login is created', async () => {
    await promote({ by: 'dre' });
    assert.equal(sent.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM num_business_users').get().n, 0);
  });
});
