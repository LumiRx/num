// Member photos of places: the proof rule, the payment rule, the cap, the
// dedupe, and the one thing that must never happen — paying twice.
// Run: node --test worker/placephotos.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  proofOf, earns, haversineKm, upload, review, handlePlacePhotos,
  NEAR_KM, SCAN_WINDOW_MIN, CAP_PER_PLACE_30D, REWARD_CENTS, CENTS_PER_STAR,
} from './placephotos.mjs';

// ── pure rules ────────────────────────────────────────────────────────────

test('a scan of the venue code inside the window is proof, however far the fix is', () => {
  assert.equal(proofOf({ scannedAgoMin: 5, fixKm: 40 }).proof, 'scan');
  assert.equal(proofOf({ scannedAgoMin: SCAN_WINDOW_MIN }).proof, 'scan');
  assert.equal(proofOf({ scannedAgoMin: SCAN_WINDOW_MIN + 1, fixKm: 40 }).proof, 'none');
});

test('a fix within 150 m is proof; further is not', () => {
  assert.equal(proofOf({ fixKm: NEAR_KM }).proof, 'fix');
  assert.equal(proofOf({ fixKm: NEAR_KM + 0.001 }).proof, 'none');
  assert.equal(proofOf({}).proof, 'none');
  assert.equal(proofOf({ scannedAgoMin: -3 }).proof, 'none'); // a scan from the future is no scan
});

test('the cent needs all three: approved, proof, 5arz identity', () => {
  assert.equal(earns({ state: 'approved', proof: 'fix', identity_verified: 1 }), true);
  assert.equal(earns({ state: 'approved', proof: 'scan', identity_verified: 1 }), true);
  assert.equal(earns({ state: 'approved', proof: 'none', identity_verified: 1 }), false);
  assert.equal(earns({ state: 'approved', proof: 'fix', identity_verified: 0 }), false);
  assert.equal(earns({ state: 'pending', proof: 'fix', identity_verified: 1 }), false);
});

test('the reward is one cent and a Star is a hundred of them', () => {
  assert.equal(REWARD_CENTS, 1);
  assert.equal(CENTS_PER_STAR, 100);
  assert.equal(CAP_PER_PLACE_30D, 3);
});

test('haversine: Trafalgar Square to Charing Cross is about 250 m', () => {
  const km = haversineKm(51.508, -0.1281, 51.5074, -0.1246);
  assert.ok(km > 0.2 && km < 0.3, km);
});

// ── a tiny D1 that remembers what it was asked ────────────────────────────

function fakeDb(answers) {
  const log = [];
  const db = {
    log,
    prepare(sql) {
      const bound = [];
      const hit = answers.find(([re]) => re.test(sql));
      const reply = (kind) => {
        log.push({ sql, bound, kind });
        const v = hit ? hit[1] : undefined;
        return typeof v === 'function' ? v(bound, kind) : v;
      };
      const stmt = {
        bind(...a) { bound.push(...a); return stmt; },
        async first() { return reply('first') ?? null; },
        async all() { return { results: reply('all') ?? [] }; },
        async run() { const r = reply('run'); return r ?? { meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  return db;
}

const req = (body, type = 'image/jpeg') => new Request('https://app.itsnum.com/api/photos/upload', {
  method: 'POST', headers: { 'Content-Type': type }, body,
});
const bytes = (n, fill = 7) => new Uint8Array(n).fill(fill);

const MEMBER = { id: 'm1', phone_verified: 1, email_verified: 0 };
const PLACE = { id: 'p1', name: 'Dishoom', lat: 51.5122, lng: -0.1265 };

function uploadEnv({ member = MEMBER, place = PLACE, recent = 0, dupe = null, scanAgo = null, idv = 1, puts = [] } = {}) {
  const db = fakeDb([
    [/SELECT id, phone_verified, email_verified FROM num_members/, member],
    [/SELECT identity_verified FROM num_members/, { identity_verified: idv }],
    [/FROM places WHERE id/, place],
    [/COUNT\(\*\) n FROM num_place_photos/, { n: recent }],
    [/FROM num_connections/, scanAgo == null ? null : { ago: scanAgo }],
    [/SELECT id, state FROM num_place_photos WHERE member_id = \?1 AND sha256/, dupe],
  ]);
  const PHOTOS = { async put(key, buf, opts) { puts.push({ key, len: buf.byteLength, type: opts?.httpMetadata?.contentType }); } };
  return { env: { DB: db, PHOTOS }, db, puts };
}

const url = (q) => new URL('https://app.itsnum.com/api/photos/upload?' + q);

test('upload: a verified member at the place gets proof fix, and the cent is promised only after review', async () => {
  const { env, db, puts } = uploadEnv();
  const res = await upload(env, req(bytes(1000)), url(`me=m1&place=p1&lat=${PLACE.lat}&lng=${PLACE.lng + 0.0004}`));
  const d = await res.json();
  assert.equal(res.status, 200);
  assert.equal(d.state, 'pending');
  assert.equal(d.proof, 'fix');
  assert.equal(d.earns_when_approved, true);
  assert.match(d.note, /once it’s been checked/);
  assert.doesNotMatch(d.note, /you earned/i);
  assert.equal(puts.length, 1);
  assert.match(puts[0].key, /^place-photos\/p1\/ph_[a-z2-9]{10}\.jpg$/);
  const ins = db.log.find((l) => /INSERT INTO num_place_photos/.test(l.sql));
  assert.equal(ins.bound[7], 'fix');
  assert.equal(ins.bound[9], 1); // identity_verified stamped on the row
});

test('upload: far from the place with no scan is proof none, and the note says what would earn', async () => {
  const { env } = uploadEnv();
  const d = await (await upload(env, req(bytes(10)), url('me=m1&place=p1&lat=48.85&lng=2.35'))).json();
  assert.equal(d.proof, 'none');
  assert.equal(d.earns_when_approved, false);
  assert.match(d.note, /location on/);
});

test('upload: a scan in the last hour is proof even without a fix', async () => {
  const { env } = uploadEnv({ scanAgo: 12 });
  const d = await (await upload(env, req(bytes(10)), url('me=m1&place=p1'))).json();
  assert.equal(d.proof, 'scan');
});

test('upload: at the place but not 5arz-verified — stored, not paid, and told why', async () => {
  const { env } = uploadEnv({ idv: 0 });
  const d = await (await upload(env, req(bytes(10)), url(`me=m1&place=p1&lat=${PLACE.lat}&lng=${PLACE.lng}`))).json();
  assert.equal(d.proof, 'fix');
  assert.equal(d.earns_when_approved, false);
  assert.match(d.note, /5arz/);
});

test('upload: no verified contact → 403 verify_to_send, nothing stored', async () => {
  const { env, puts } = uploadEnv({ member: { id: 'm1', phone_verified: 0, email_verified: 0 } });
  const res = await upload(env, req(bytes(10)), url('me=m1&place=p1'));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'verify_to_send');
  assert.equal(puts.length, 0);
});

test('upload: the cap is 3 per place per month and refuses before storing', async () => {
  const { env, puts } = uploadEnv({ recent: CAP_PER_PLACE_30D });
  const res = await upload(env, req(bytes(10)), url('me=m1&place=p1'));
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'capped');
  assert.equal(puts.length, 0);
});

test('upload: the same bytes twice is one photo', async () => {
  const { env, puts } = uploadEnv({ dupe: { id: 'ph_old', state: 'pending' } });
  const d = await (await upload(env, req(bytes(10)), url('me=m1&place=p1'))).json();
  assert.equal(d.duplicate, true);
  assert.equal(d.id, 'ph_old');
  assert.equal(puts.length, 0);
});

test('upload: wrong type 415, oversize 413, empty 400', async () => {
  assert.equal((await upload(uploadEnv().env, req(bytes(10), 'application/pdf'), url('me=m1&place=p1'))).status, 415);
  assert.equal((await upload(uploadEnv().env, req(bytes(8 * 1024 * 1024 + 1)), url('me=m1&place=p1'))).status, 413);
  assert.equal((await upload(uploadEnv().env, req(new Uint8Array(0)), url('me=m1&place=p1'))).status, 400);
});

// ── review: the money ─────────────────────────────────────────────────────

function reviewEnv({ row, credit = 0, flipChanges = 1, moveChanges = 1 }) {
  const db = fakeDb([
    [/SELECT \* FROM num_place_photos WHERE id/, row],
    [/UPDATE num_place_photos SET state/, { meta: { changes: flipChanges } }],
    [/SELECT cents FROM num_photo_credit/, () => ({ cents: credit + REWARD_CENTS })],
    [/INSERT OR IGNORE INTO num_star_moves/, { meta: { changes: moveChanges } }],
  ]);
  return { env: { DB: db }, db };
}
const PENDING = { id: 'ph_1', place_id: 'p1', member_id: 'm1', state: 'pending', proof: 'fix', identity_verified: 1 };

test('review: approving a proven, verified photo pays one cent and no Star yet', async () => {
  const { env, db } = reviewEnv({ row: PENDING, credit: 0 });
  const d = await (await review(env, { id: 'ph_1', state: 'approved' })).json();
  assert.equal(d.cents, 1);
  assert.equal(d.starred, 0);
  assert.ok(db.log.some((l) => /UPDATE num_photo_credit SET cents = cents \+/.test(l.sql)));
  assert.ok(!db.log.some((l) => /num_star_balances/.test(l.sql)));
});

test('review: the hundredth cent becomes ★1 as kind reward, and the credit is drawn down', async () => {
  const { env, db } = reviewEnv({ row: PENDING, credit: 99 });
  const d = await (await review(env, { id: 'ph_1', state: 'approved' })).json();
  assert.equal(d.starred, 1);
  const move = db.log.find((l) => /INSERT OR IGNORE INTO num_star_moves/.test(l.sql));
  assert.equal(move.bound[0], 'photo:ph_1');
  assert.equal(move.bound[2], 1);
  assert.match(move.sql, /'reward'/);
  const grow = db.log.find((l) => /num_star_balances SET stars = stars \+/.test(l.sql));
  assert.equal(grow.bound[1], 1);
  const draw = db.log.find((l) => /num_photo_credit SET cents = cents -/.test(l.sql));
  assert.equal(draw.bound[1], 100);
});

test('review: if the move already exists, the balance does not grow (retried review)', async () => {
  const { env, db } = reviewEnv({ row: PENDING, credit: 99, moveChanges: 0 });
  const d = await (await review(env, { id: 'ph_1', state: 'approved' })).json();
  assert.equal(d.starred, 0);
  assert.ok(!db.log.some((l) => /num_star_balances/.test(l.sql)));
});

test('review: a second approval of a non-pending row pays nothing', async () => {
  const { env, db } = reviewEnv({ row: { ...PENDING, state: 'approved' } });
  const d = await (await review(env, { id: 'ph_1', state: 'approved' })).json();
  assert.equal(d.already, true);
  assert.ok(!db.log.some((l) => /num_photo_credit|num_star/.test(l.sql)));
});

test('review: when the flip changed no row (raced), nothing is paid', async () => {
  const { env, db } = reviewEnv({ row: PENDING, flipChanges: 0 });
  const d = await (await review(env, { id: 'ph_1', state: 'approved' })).json();
  assert.equal(d.already, true);
  assert.ok(!db.log.some((l) => /num_photo_credit|num_star/.test(l.sql)));
});

test('review: proof none or unverified identity approves without paying', async () => {
  for (const row of [{ ...PENDING, proof: 'none' }, { ...PENDING, identity_verified: 0 }]) {
    const { env, db } = reviewEnv({ row });
    const d = await (await review(env, { id: 'ph_1', state: 'approved' })).json();
    assert.equal(d.state, 'approved');
    assert.equal(d.cents, 0);
    assert.ok(!db.log.some((l) => /num_photo_credit|num_star/.test(l.sql)));
  }
});

test('review: rejecting never pays and records the reason', async () => {
  const { env, db } = reviewEnv({ row: PENDING });
  const d = await (await review(env, { id: 'ph_1', state: 'rejected', reason: 'blurry' })).json();
  assert.equal(d.cents, 0);
  const flip = db.log.find((l) => /UPDATE num_place_photos SET state/.test(l.sql));
  assert.equal(flip.bound[3], 'blurry');
  assert.equal(flip.bound[4], 0);
});

// ── the door ──────────────────────────────────────────────────────────────

test('routes: pending and review need the admin key; a wrong key is forbidden', async () => {
  const env = { DB: fakeDb([]), ADMIN_KEY: 'k' };
  const u = new URL('https://app.itsnum.com/api/photos/pending');
  const r1 = await handlePlacePhotos(new Request(u), env, '/pending', u);
  assert.equal(r1.status, 403);
  const r2 = await handlePlacePhotos(new Request(u, { headers: { 'X-Admin-Key': 'wrong' } }), env, '/pending', u);
  assert.equal(r2.status, 403);
  const r3 = await handlePlacePhotos(new Request(u, { headers: { 'X-Admin-Key': 'k' } }), env, '/pending', u);
  assert.equal(r3.status, 200);
  assert.deepEqual((await r3.json()).pending, []);
});

test('routes: a pending image is not served to the public', async () => {
  const env = { DB: fakeDb([[/SELECT r2_key/, { r2_key: 'x', content_type: 'image/jpeg', state: 'pending' }]]), PHOTOS: {} };
  const u = new URL('https://app.itsnum.com/api/photos/img/ph_1');
  const r = await handlePlacePhotos(new Request(u), env, '/img/ph_1', u);
  assert.equal(r.status, 404);
});

test('routes: /place/<id> lists approved photos as urls under this origin', async () => {
  const env = { DB: fakeDb([[/state = 'approved' ORDER BY created_at DESC/, [{ id: 'ph_9', member_id: 'm1', created_at: '2026-09-18' }]]]) };
  const u = new URL('https://app.itsnum.com/api/photos/place/p1');
  const d = await (await handlePlacePhotos(new Request(u), env, '/place/p1', u)).json();
  assert.equal(d.photos[0].url, 'https://app.itsnum.com/api/photos/img/ph_9');
});
