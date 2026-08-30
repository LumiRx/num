// The review queue for num_place_submissions.
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
import { __testables } from './console.mjs';
import { DESTINATIONS } from '../scripts/destinations.mjs';

const { adminSubmissions, adminSubmissionLink, adminSubmissionPromote } = __testables;

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
  db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, name_local TEXT, category TEXT,
    lat REAL NOT NULL, lng REAL NOT NULL, cell_lat INTEGER, cell_lng INTEGER, dest TEXT NOT NULL,
    area TEXT, country TEXT, phone TEXT, website TEXT, email TEXT, address TEXT, source TEXT,
    status TEXT DEFAULT 'unclaimed')`);
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, business_name TEXT, place_id TEXT,
    state TEXT DEFAULT 'new')`);
  db.exec(`CREATE TABLE num_place_submissions (id TEXT PRIMARY KEY, name TEXT NOT NULL,
    name_local TEXT, address TEXT, website TEXT, category TEXT, phone TEXT, email TEXT,
    country TEXT, dest TEXT, lat REAL, lng REAL, claim_id INTEGER,
    status TEXT NOT NULL DEFAULT 'new', place_id TEXT, review_note TEXT,
    created_at TEXT DEFAULT (datetime('now')), reviewed_at TEXT)`);
});

beforeEach(() => {
  db.exec('DELETE FROM places; DELETE FROM claims; DELETE FROM num_place_submissions;');
  db.prepare(`INSERT INTO places (id,name,lat,lng,dest,area,country,phone,email,website)
    VALUES ('pl_fingal','Fingal Hotel',55.98,-3.17,'edinburgh','Edinburgh','GB',
            '+441313575000','reservations@fingal.co.uk','https://fingal.co.uk')`).run();
  db.prepare(`INSERT INTO claims (id,business_name,place_id,state) VALUES (15,'Fingal Hotel',NULL,'new')`).run();
  db.prepare(`INSERT INTO num_place_submissions
      (id,name,address,phone,email,country,claim_id,status)
    VALUES ('sub_fingal','Fingal Hotel','Alexandra, Dock Pl, Edinburgh','+441313575000',
            'Reservations@Fingal.co.uk','GB',15,'new')`).run();
});

describe('adminSubmissions — the queue', () => {
  test('lists pending submissions and flags the Fingal-shaped case: an exact phone match already on Num', async () => {
    const res = await adminSubmissions(env, new URL('https://x/admin/submissions'));
    const body = await res.json();
    assert.equal(body.count, 1);
    assert.equal(body.submissions[0].id, 'sub_fingal');
    assert.ok(body.submissions[0].possible_match, 'the exact phone match against places was not surfaced');
    assert.equal(body.submissions[0].possible_match.id, 'pl_fingal');
  });

  test('a submission with nothing matching gets no false hint', async () => {
    db.prepare(`UPDATE num_place_submissions SET phone=NULL, name='Nobody Has Heard Of This' WHERE id='sub_fingal'`).run();
    const res = await adminSubmissions(env, new URL('https://x/admin/submissions'));
    const body = await res.json();
    assert.equal(body.submissions[0].possible_match, null);
  });

  test('status= filters to whatever the reviewer asks for', async () => {
    db.prepare(`UPDATE num_place_submissions SET status='rejected' WHERE id='sub_fingal'`).run();
    const open = await (await adminSubmissions(env, new URL('https://x/admin/submissions'))).json();
    assert.equal(open.count, 0, 'rejected should not show under the default new/geocoded view');
    const rejected = await (await adminSubmissions(env, new URL('https://x/admin/submissions?status=rejected'))).json();
    assert.equal(rejected.count, 1);
  });
});

describe('adminSubmissionLink — the Fingal Hotel case: bind to a listing that already exists', () => {
  test('links the submission to the existing place, and backfills the claim it came from', async () => {
    const req = new Request('https://x/admin/submissions/link', {
      method: 'POST',
      body: JSON.stringify({ submission_id: 'sub_fingal', place_id: 'pl_fingal', by: 'andre' }),
    });
    const res = await adminSubmissionLink(env, req);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, 'duplicate');

    const sub = db.prepare("SELECT status, place_id FROM num_place_submissions WHERE id='sub_fingal'").get();
    assert.equal(sub.status, 'duplicate');
    assert.equal(sub.place_id, 'pl_fingal');

    const claim = db.prepare('SELECT place_id FROM claims WHERE id=15').get();
    assert.equal(claim.place_id, 'pl_fingal', 'the originating claim never learned which listing it belongs to');

    // No new places row was created — this is a link, never a write to places
    // beyond the one that was already there.
    const count = db.prepare('SELECT COUNT(*) n FROM places').get().n;
    assert.equal(count, 1);
  });

  test('refuses a place_id that does not exist, rather than linking to nothing', async () => {
    const req = new Request('https://x/admin/submissions/link', {
      method: 'POST',
      body: JSON.stringify({ submission_id: 'sub_fingal', place_id: 'pl_does_not_exist' }),
    });
    const res = await adminSubmissionLink(env, req);
    assert.equal(res.status, 404);
  });

  test('a submission already resolved cannot be resolved twice', async () => {
    db.prepare(`UPDATE num_place_submissions SET status='promoted', place_id='pl_fingal' WHERE id='sub_fingal'`).run();
    const req = new Request('https://x/admin/submissions/link', {
      method: 'POST',
      body: JSON.stringify({ submission_id: 'sub_fingal', place_id: 'pl_fingal' }),
    });
    const res = await adminSubmissionLink(env, req);
    assert.equal(res.status, 409);
  });
});

describe('adminSubmissionPromote — a business nothing had crawled', () => {
  test('creates a real places row, with the not-null columns places actually enforces', async () => {
    const dest = DESTINATIONS[0];
    const req = new Request('https://x/admin/submissions/promote', {
      method: 'POST',
      body: JSON.stringify({ submission_id: 'sub_fingal', lat: dest.lat, lng: dest.lng, dest: dest.slug, by: 'andre' }),
    });
    const res = await adminSubmissionPromote(env, req);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, 'promoted');
    assert.ok(body.place_id);

    const place = db.prepare('SELECT * FROM places WHERE id=?').get(body.place_id);
    assert.equal(place.name, 'Fingal Hotel');
    assert.equal(place.lat, dest.lat);
    assert.equal(place.lng, dest.lng);
    assert.equal(place.dest, dest.slug);
    assert.equal(place.cell_lat, Math.floor(dest.lat * 10));
    assert.equal(place.status, 'unclaimed');

    const sub = db.prepare("SELECT status, place_id FROM num_place_submissions WHERE id='sub_fingal'").get();
    assert.equal(sub.status, 'promoted');
    assert.equal(sub.place_id, body.place_id);

    const claim = db.prepare('SELECT place_id FROM claims WHERE id=15').get();
    assert.equal(claim.place_id, body.place_id);
  });

  test('refuses to invent coordinates — no lat/lng is a 400, never a guess', async () => {
    const req = new Request('https://x/admin/submissions/promote', {
      method: 'POST',
      body: JSON.stringify({ submission_id: 'sub_fingal', dest: 'edinburgh' }),
    });
    const res = await adminSubmissionPromote(env, req);
    assert.equal(res.status, 400);
    const places = db.prepare('SELECT COUNT(*) n FROM places').get().n;
    assert.equal(places, 1, 'a places row was written despite no coordinates');
  });

  test('refuses a dest that is not one of Num’s own destination slugs', async () => {
    const req = new Request('https://x/admin/submissions/promote', {
      method: 'POST',
      body: JSON.stringify({ submission_id: 'sub_fingal', lat: 1, lng: 1, dest: 'not-a-real-place' }),
    });
    const res = await adminSubmissionPromote(env, req);
    assert.equal(res.status, 400);
  });
});
