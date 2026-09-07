// Handing one person another party's live orders.
//
// These orders carry a guest's name, their address and what they paid. The
// whole authorisation is a coincidence of two OTP proofs of the same phone
// number, so every test here is about the ways that could go wrong.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { e164, businessesForMember, ownsBusiness } from './bizowner.mjs';

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      const st = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: st.all(...args), success: true };
      st.run(...args); return { results: [], success: true };
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes ?? 0) } }),
  });
  return {
    prepare(sql) { const b = (a) => ({ bind: (...m) => b([...a, ...m]), ...shape(sql, a) }); return b([]); },
    batch: async (s) => Promise.all(s.map((x) => x.run())),
  };
}

const db = new DatabaseSync(':memory:');
const env = { DB: d1(db) };
const ALFREDO = '+18186676918';

before(() => {
  db.exec(`CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT, phone TEXT UNIQUE,
    phone_verified INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active')`);
  db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, dest TEXT)`);
  db.exec(`CREATE TABLE num_place_owners (place_id TEXT PRIMARY KEY, business_id TEXT, claim_id TEXT,
    method TEXT, phone TEXT, verified_at TEXT, revoked_at TEXT)`);
  db.exec(`CREATE TABLE num_business_profiles (business_id TEXT PRIMARY KEY, phone_e164 TEXT)`);
});

beforeEach(() => {
  for (const t of ['num_members', 'businesses', 'places', 'num_place_owners', 'num_business_profiles']) {
    db.exec(`DELETE FROM ${t}`);
  }
  db.exec(`INSERT INTO businesses (id,name,status) VALUES ('biz_lacc','LA Cannabis Club','active')`);
  db.exec(`INSERT INTO places (id,name,dest) VALUES ('pl_lacc','LA Cannabis Club','los-angeles')`);
  db.exec(`INSERT INTO num_place_owners (place_id,business_id,claim_id,method,phone,verified_at)
    VALUES ('pl_lacc','biz_lacc','16','sms','${ALFREDO}','2026-09-07')`);
  db.exec(`INSERT INTO num_business_profiles (business_id,phone_e164) VALUES ('biz_lacc','${ALFREDO}')`);
  db.exec(`INSERT INTO num_members (id,name,phone,phone_verified) VALUES ('mem_alfredo','Alfredo','${ALFREDO}',1)`);
});

describe('who gets to see a business’s orders', () => {
  test('the owner, signed in on the number that claimed the listing', async () => {
    const mine = await businessesForMember(env, 'mem_alfredo');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].business_id, 'biz_lacc');
    assert.equal(mine[0].name, 'LA Cannabis Club');
    assert.equal(await ownsBusiness(env, 'mem_alfredo', 'biz_lacc'), true);
  });

  test('an UNVERIFIED phone matches nothing, however right the number looks', async () => {
    db.exec("UPDATE num_members SET phone_verified = 0 WHERE id = 'mem_alfredo'");
    assert.deepEqual(await businessesForMember(env, 'mem_alfredo'), [],
      'an unverified phone is a string somebody typed');
    assert.equal(await ownsBusiness(env, 'mem_alfredo', 'biz_lacc'), false);
  });

  test('a stranger who knows the number sees nothing', async () => {
    // They can put it in their profile; they cannot receive the code.
    db.exec(`INSERT INTO num_members (id,name,phone,phone_verified) VALUES ('mem_x','Chancer','+18186676919',1)`);
    assert.deepEqual(await businessesForMember(env, 'mem_x'), []);
    assert.equal(await ownsBusiness(env, 'mem_x', 'biz_lacc'), false);
  });

  test('the PUBLISHED number on the profile is not a way in', async () => {
    // The most important line in bizowner.mjs. A listing's published phone is
    // on the door and on the website; for most venues it is the same string as
    // the claiming phone, so matching it would be a hole nobody could see.
    db.exec("DELETE FROM num_place_owners");
    db.exec(`INSERT INTO num_members (id,name,phone,phone_verified) VALUES ('mem_y','Y','${ALFREDO}2',1)`);
    db.exec(`UPDATE num_business_profiles SET phone_e164 = '${ALFREDO}2' WHERE business_id='biz_lacc'`);
    assert.deepEqual(await businessesForMember(env, 'mem_y'), [],
      'a public phone number became an authorisation');
  });

  test('a revoked claim ends the access with it', async () => {
    db.exec("UPDATE num_place_owners SET revoked_at = '2026-09-08' WHERE place_id = 'pl_lacc'");
    assert.deepEqual(await businessesForMember(env, 'mem_alfredo'), []);
  });

  test('a suspended business disappears from the app too', async () => {
    db.exec("UPDATE businesses SET status = 'suspended' WHERE id = 'biz_lacc'");
    assert.deepEqual(await businessesForMember(env, 'mem_alfredo'), []);
  });

  test('one person, two businesses — both, oldest first', async () => {
    db.exec(`INSERT INTO businesses (id,name,status) VALUES ('biz_2','Second Shop','active')`);
    db.exec(`INSERT INTO places (id,name,dest) VALUES ('pl_2','Second Shop','los-angeles')`);
    db.exec(`INSERT INTO num_place_owners (place_id,business_id,claim_id,method,phone,verified_at)
      VALUES ('pl_2','biz_2','17','sms','${ALFREDO}','2026-09-09')`);
    const mine = await businessesForMember(env, 'mem_alfredo');
    assert.deepEqual(mine.map((b) => b.business_id), ['biz_lacc', 'biz_2']);
  });

  test('nothing at all is the answer to every kind of nobody', async () => {
    for (const who of [null, undefined, '', 'mem_nope', 'x'.repeat(200)]) {
      assert.deepEqual(await businessesForMember(env, who), []);
      assert.equal(await ownsBusiness(env, who, 'biz_lacc'), false);
    }
    assert.equal(await ownsBusiness(env, 'mem_alfredo', null), false);
    assert.equal(await ownsBusiness(env, 'mem_alfredo', 'biz_someone_else'), false);
  });
});

describe('the phone comparison itself', () => {
  test('formatting differences do not lock an owner out', () => {
    for (const raw of ['+1 818 667 6918', '+1 (818) 667-6918', ' +18186676918 ']) {
      assert.equal(e164(raw), ALFREDO);
    }
  });

  test('a number with no country code is not guessed into one', () => {
    // "8186676918" could be a US number or the tail of somebody else's. A
    // guess here is an authorisation decision made by a regex.
    assert.equal(e164('8186676918'), null);
    assert.equal(e164('667-6918'), null);
    assert.equal(e164(''), null);
    assert.equal(e164(null), null);
    assert.equal(e164('+1'), null, 'too short to be anyone');
    assert.equal(e164(`+${'9'.repeat(20)}`), null, 'too long to be anyone');
  });
});
