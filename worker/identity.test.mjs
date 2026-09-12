/**
 * One person, several hats — and one code per hat.
 *
 * Surveyed before writing: `num_place_owners.member_ref` existed but was NULL
 * on all three live rows (they came through the web claim, which knows an
 * email and never a member); `num_hosts` had no member column at all; the QR
 * system covered tables and bills, never identity; and nothing recorded who
 * had met whom.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  identitiesFor, codeFor, resolveCode, recordScan, connectionsFor,
  claimHost, claimBusinessByPhone, identityPayload, linkFor, newCode, HATS,
} from './identity.mjs';

let db; let env;
const d1 = (database) => ({
  prepare: (sql) => {
    const st = { sql, binds: [] };
    st.bind = (...a) => { st.binds = a; return st; };
    const run = () => {
      const text = sql.replace(/\?(\d+)/g, () => '?');
      const order = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]) - 1);
      return { text, args: order.map((n) => st.binds[n]) };
    };
    st.first = async () => { const { text, args } = run(); return database.prepare(text).get(...args) ?? null; };
    st.all = async () => { const { text, args } = run(); return { results: database.prepare(text).all(...args) }; };
    st.run = async () => { const { text, args } = run(); const r = database.prepare(text).run(...args); return { meta: { changes: r.changes } }; };
    return st;
  },
  batch: async (sts) => { for (const s of sts) await s.run(); return []; },
});

const ME = 'mem_dre'; const OTHER = 'mem_guest';

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  // phone and phone_verified matter now: claimBusinessByPhone reads the
  // number off the MEMBER rather than taking one from the caller, because a
  // venue's number is printed on its own door.
  db.exec(`CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT, phone TEXT, phone_verified INTEGER NOT NULL DEFAULT 0)`);
  db.prepare('INSERT INTO num_members VALUES (?,?,?,?)').run(ME, 'Dre', '+1 (310) 555-0000', 1);
  db.prepare('INSERT INTO num_members VALUES (?,?,?,?)').run(OTHER, 'Guest', '+13105551111', 1);
  db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, dest TEXT)`);
  db.prepare('INSERT INTO places VALUES (?,?,?)').run('p1', 'Bestia', 'los-angeles');
  db.exec(`CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT)`);
  db.prepare('INSERT INTO businesses VALUES (?,?)').run('biz1', 'Bestia');
  db.exec(`CREATE TABLE num_place_owners (place_id TEXT PRIMARY KEY, business_id TEXT, claim_id TEXT, method TEXT, phone TEXT, verified_at TEXT, revoked_at TEXT, member_ref TEXT)`);
  db.prepare("INSERT INTO num_place_owners VALUES ('p1','biz1','c1','sms','+13105550000',datetime('now'),NULL,NULL)").run();
  db.exec(`CREATE TABLE num_hosts (id TEXT PRIMARY KEY, name TEXT, company TEXT, console_key TEXT, status TEXT DEFAULT 'active', closed_at TEXT)`);
  db.prepare("INSERT INTO num_hosts (id,name,company,console_key,status) VALUES ('h1','Sean','Edinburgh Concierge','KEY-SEAN','active')").run();
  env = { DB: d1(db) };
});

describe('the hats a member wears', () => {
  test('everyone is at least a member', async () => {
    const hats = await identitiesFor(env, ME);
    assert.equal(hats.length, 1);
    assert.deepEqual({ ...hats[0] }, { type: 'member', id: ME, name: null });
  });

  test('an unlinked business is NOT one of their hats', async () => {
    // The live state before this: ownership proven, member_ref NULL, so the
    // app could not tell the person signed in owns the place.
    assert.equal((await identitiesFor(env, ME)).some((h) => h.type === 'business'), false);
  });

  test('linking by the verified number makes it a hat', async () => {
    const out = await claimBusinessByPhone(env, { memberId: ME });
    assert.equal(out.ok, true);
    const hats = await identitiesFor(env, ME);
    assert.ok(hats.some((h) => h.type === 'business' && h.id === 'biz1' && h.name === 'Bestia'));
  });

  test('a revoked ownership is not a hat', async () => {
    await claimBusinessByPhone(env, { memberId: ME });
    db.prepare("UPDATE num_place_owners SET revoked_at=datetime('now')").run();
    assert.equal((await identitiesFor(env, ME)).some((h) => h.type === 'business'), false);
  });

  test('a host links with its console key and becomes a hat', async () => {
    const out = await claimHost(env, { memberId: ME, consoleKey: 'KEY-SEAN' });
    assert.equal(out.ok, true);
    assert.ok((await identitiesFor(env, ME)).some((h) => h.type === 'host' && h.name === 'Edinburgh Concierge'));
  });

  test('a closed host keeps no dashboard', async () => {
    await claimHost(env, { memberId: ME, consoleKey: 'KEY-SEAN' });
    db.prepare("UPDATE num_hosts SET closed_at=datetime('now')").run();
    assert.equal((await identitiesFor(env, ME)).some((h) => h.type === 'host'), false);
  });
});

describe('proof, not assertion', () => {
  test('the wrong console key links nothing', async () => {
    const out = await claimHost(env, { memberId: ME, consoleKey: 'GUESSED' });
    assert.equal(out.ok, false);
    assert.equal(db.prepare('SELECT member_id FROM num_hosts WHERE id=?').get('h1').member_id, null);
  });

  test('a host already linked cannot be taken over', async () => {
    await claimHost(env, { memberId: ME, consoleKey: 'KEY-SEAN' });
    const out = await claimHost(env, { memberId: OTHER, consoleKey: 'KEY-SEAN' });
    assert.equal(out.ok, false);
    assert.match(out.error, /another account/);
    assert.equal(db.prepare('SELECT member_id FROM num_hosts WHERE id=?').get('h1').member_id, ME);
  });

  test('a business already linked cannot be taken over', async () => {
    await claimBusinessByPhone(env, { memberId: ME });
    // OTHER's own verified number is a different one, so this is refused twice
    // over. Point the listing at their number to test the takeover rule itself.
    db.prepare("UPDATE num_place_owners SET phone='+13105551111'").run();
    const out = await claimBusinessByPhone(env, { memberId: OTHER });
    assert.equal(out.ok, false);
    assert.equal(db.prepare('SELECT member_ref FROM num_place_owners').get().member_ref, ME);
  });

  test('a member whose number matches nothing links nothing', async () => {
    assert.equal((await claimBusinessByPhone(env, { memberId: OTHER })).ok, false);
  });

  /**
   * THE HOLE THIS CLOSES.
   *
   * The route used to pass `body.phone` straight through. A venue's number is
   * on its listing, its door and its Google entry, so anyone who could read a
   * signboard could have typed it in and been handed that business's
   * dashboard, bookings and guest list. Caught on review before it shipped.
   */
  test('knowing the venue\'s number is not proof of anything', async () => {
    const out = await claimBusinessByPhone(env, { memberId: OTHER, phone: '+13105550000' });
    assert.equal(out.ok, false, 'the phone in the body must be ignored entirely');
    assert.equal(db.prepare('SELECT member_ref FROM num_place_owners').get().member_ref, null);
  });

  test('an unverified number proves nothing either', async () => {
    db.prepare('UPDATE num_members SET phone_verified=0 WHERE id=?').run(ME);
    const out = await claimBusinessByPhone(env, { memberId: ME });
    assert.equal(out.ok, false);
    assert.match(out.error, /verify your phone/);
  });

  test('formatting does not decide who owns a restaurant', async () => {
    // The member is stored as "+1 (310) 555-0000" and the listing as
    // "+13105550000". A `WHERE phone = ?` would have missed it silently.
    assert.equal((await claimBusinessByPhone(env, { memberId: ME })).ok, true);
  });
});

describe('one code per hat, and it never moves', () => {
  test('asking twice returns the same code', async () => {
    const a = await codeFor(env, { ownerType: 'member', ownerId: ME });
    const b = await codeFor(env, { ownerType: 'member', ownerId: ME });
    assert.equal(a, b, 'a rotating code invalidates every printed QR');
  });

  test('the link is the code — one attribution path, not two', async () => {
    const code = await codeFor(env, { ownerType: 'member', ownerId: ME });
    assert.equal(linkFor(code, 'https://itsnum.com'), `https://itsnum.com/c/${code}`);
  });

  test('codes avoid characters people misread aloud', () => {
    for (let i = 0; i < 40; i++) assert.ok(!/[01OIL]/.test(newCode()), 'ambiguous character in a code');
  });

  test('each hat gets its own code', async () => {
    await claimBusinessByPhone(env, { memberId: ME, phone: '+13105550000' });
    const payload = await identityPayload(env, ME);
    const codes = payload.map((p) => p.code);
    assert.equal(new Set(codes).size, codes.length, 'two hats sharing a code cannot be told apart');
    assert.ok(payload.every((p) => p.code && p.link));
  });

  test('an unknown hat type mints nothing', async () => {
    assert.equal(await codeFor(env, { ownerType: 'wizard', ownerId: 'x' }), null);
  });
});

describe('a scan is a connection both sides can see', () => {
  const scan = async () => {
    await claimBusinessByPhone(env, { memberId: ME, phone: '+13105550000' });
    const code = await codeFor(env, { ownerType: 'business', ownerId: 'biz1' });
    return recordScan(env, { code, scannerMemberId: OTHER, place: 'Arts District' });
  };

  test('the guest gets the place in their list', async () => {
    await scan();
    const mine = await connectionsFor(env, { ownerType: 'member', ownerId: OTHER });
    assert.equal(mine.length, 1);
    assert.equal(mine[0].to_type, 'business');
    assert.equal(mine[0].name, 'Bestia');
    assert.equal(mine[0].place, 'Arts District');
  });

  test('and the business gets the guest in theirs', async () => {
    await scan();
    const theirs = await connectionsFor(env, { ownerType: 'business', ownerId: 'biz1' });
    assert.equal(theirs.length, 1);
    assert.equal(theirs[0].to_id, OTHER);
    assert.equal(theirs[0].name, 'Guest');
  });

  test('a regular is one connection, counted — not forty rows', async () => {
    await scan(); await scan(); await scan();
    const mine = await connectionsFor(env, { ownerType: 'member', ownerId: OTHER });
    assert.equal(mine.length, 1);
    assert.equal(mine[0].times, 3);
  });

  test('a code that is not ours invents nothing', async () => {
    const out = await recordScan(env, { code: 'ZZZZZZZZ', scannerMemberId: OTHER });
    assert.equal(out.ok, false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM num_connections').get().n, 0,
      'a connection to a place that does not exist is a false memory of a real evening');
  });

  test('scanning your own code is a quiet no-op, not an error', async () => {
    const code = await codeFor(env, { ownerType: 'member', ownerId: ME });
    const out = await recordScan(env, { code, scannerMemberId: ME });
    assert.equal(out.ok, true);
    assert.equal(out.self, true);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM num_connections').get().n, 0);
  });

  test('scanning your own BUSINESS code is also a no-op', async () => {
    await claimBusinessByPhone(env, { memberId: ME, phone: '+13105550000' });
    const code = await codeFor(env, { ownerType: 'business', ownerId: 'biz1', memberId: ME });
    const out = await recordScan(env, { code, scannerMemberId: ME });
    assert.equal(out.self, true);
  });

  test('a signed-out scan records nothing', async () => {
    const code = await codeFor(env, { ownerType: 'member', ownerId: ME });
    assert.equal((await recordScan(env, { code, scannerMemberId: '' })).ok, false);
  });

  test('a link click is the same code and the same ledger', async () => {
    await claimBusinessByPhone(env, { memberId: ME, phone: '+13105550000' });
    const code = await codeFor(env, { ownerType: 'business', ownerId: 'biz1' });
    await recordScan(env, { code, scannerMemberId: OTHER, via: 'link' });
    const mine = await connectionsFor(env, { ownerType: 'member', ownerId: OTHER });
    assert.equal(mine[0].via, 'link');
  });

  test('an invented via is refused', async () => {
    const code = await codeFor(env, { ownerType: 'member', ownerId: ME });
    assert.equal((await recordScan(env, { code, scannerMemberId: OTHER, via: 'telepathy' })).ok, false);
  });
});

describe('the shape the app reads', () => {
  test('resolveCode is case-insensitive — codes get typed by hand', async () => {
    const code = await codeFor(env, { ownerType: 'member', ownerId: ME });
    assert.ok(await resolveCode(env, code.toLowerCase()));
  });

  test('the hats are declared in one place', () => {
    assert.deepEqual([...HATS], ['member', 'business', 'host']);
  });

  test('no database is a shape, not a crash', async () => {
    // ensure() no-ops without a binding; every entry point must guard too, or
    // it sails past and dereferences env.DB.prepare on undefined.
    assert.deepEqual(await identitiesFor({}, ME).catch(() => 'threw'), []);
    assert.deepEqual(await connectionsFor({}, { ownerType: 'member', ownerId: ME }).catch(() => 'threw'), []);
    assert.equal(await codeFor({}, { ownerType: 'member', ownerId: ME }).catch(() => 'threw'), null);
    assert.equal((await recordScan({}, { code: 'X', scannerMemberId: ME }).catch(() => 'threw')).ok, false);
  });
});
