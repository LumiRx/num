// The trust envelope: what Num tells a partner about a person.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
//
// Three properties are asserted here and they pull against each other, which
// is the whole reason the envelope is worth testing rather than eyeballing:
//
//   1. WHOSE ID REACHES 5ARZ. The ledger must only ever be queried with a 5arz
//      member id Num itself recorded under consent — never with an id handed in
//      by the caller. `GET /api/trust?member=` is reachable by any holder of
//      AIR_SHARED_KEY, and it used to pass that query-string value straight
//      into our parent company's members table. That made Num a lookup oracle
//      for 5arz identity data about people who may never have used Num.
//
//   2. PRECEDENCE. `phone_verified` sets the identity basis to 'sms'; a
//      completed ID check overwrites it with 'id_check'. Lose the ordering and
//      a fully verified member is reported to a partner as merely
//      phone-verified — quieter than a crash and more expensive, because the
//      envelope's entire value is that a partner can trust the basis it names.
//
//   3. LATENCY. LetsGo2Trip term 9 asks for under 100 ms of added latency per
//      envelope. The ledger reads must overlap, and for a member with no 5arz
//      link they must not happen at all.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { linked5arzId, trustEnvelope } from './air.mjs';

/**
 * A stub database whose reads take real time, so overlap is observable, and
 * which records the parameters every query was bound with — because "which id
 * reached the ledger" is the property this file most needs to see.
 */
function slowDb(rows, delayMs, log) {
  return {
    prepare(sql) {
      const bound = (params = []) => ({
        bind: (...a) => bound([...params, ...a]),
        first: async () => {
          const started = Date.now();
          await new Promise((r) => setTimeout(r, delayMs));
          log.push({ sql, params, started, ended: Date.now() });
          for (const [match, row] of rows) if (sql.includes(match)) return row;
          return null;
        },
      });
      return bound();
    },
  };
}

// Two namespaces that both start `mem_`, which is how the original bug got
// written. Ours is `mem_` + 20 hex; 5arz's is `mem_` + 12. Checked against
// production on 12 Sep 2026: of 147 Num members the 2 who are genuinely
// 5arz-verified both have a 5arz id that differs from their Num id, so the old
// `WHERE id = <num id>` lookup had never once matched.
const NUM_ID = 'mem_365034d0416e491ea8aa';
const ARZ_ID = 'mem_mdbyo5w95oq2';

const MEMBER = {
  id: NUM_ID,
  name: 'Viv',
  phone_verified: 1,
  created_at: '2026-06-01T00:00:00Z',
  bio: JSON.stringify({ '5arz_id': ARZ_ID, '5arz_verified_at': '2026-07-01T00:00:00Z' }),
};
const UNLINKED = { ...MEMBER, bio: JSON.stringify({ note: 'no 5arz account' }) };

const LEDGER_ROWS = [
  ['FROM members', { id: ARZ_ID, verified_at: '2026-07-01T00:00:00Z', country: 'TH' }],
  ['uniqueness_attestations', { level: 'strong', status: 'active', valid_until: '2027-01-01' }],
  ['verified_sessions', { n: 12, passed: 10, rejected: 2, avg_score: 0.82 }],
];

let log;
beforeEach(() => { log = []; });

const envWith = (delay, member = MEMBER) => ({
  DB: slowDb([['num_members', member]], delay, log),
  LEDGER: slowDb(LEDGER_ROWS, delay, log),
});

const ledgerReads = () => log.filter((q) => !q.sql.includes('num_members'));

describe('whose id reaches 5arz', () => {
  test('the ledger is queried with OUR stored 5arz id, never the caller\'s', async () => {
    await trustEnvelope(envWith(1), { memberId: NUM_ID });
    const reads = ledgerReads();
    assert.equal(reads.length, 3, 'expected the three ledger reads');
    for (const q of reads) {
      assert.deepEqual(q.params, [ARZ_ID], `ledger read bound ${q.params} — ${q.sql.slice(0, 40)}`);
      assert.ok(!q.params.includes(NUM_ID), 'a Num member id reached the 5arz ledger');
    }
  });

  test('a caller-supplied id that is not one of ours reads nothing from 5arz', async () => {
    // The oracle. A partner putting a 5arz member id in ?member= must learn
    // nothing: there is no num_members row for it, so there is no link, so the
    // ledger is never consulted.
    const env = {
      DB: slowDb([['num_members', null]], 1, log),
      LEDGER: slowDb(LEDGER_ROWS, 1, log),
    };
    const t = await trustEnvelope(env, { memberId: ARZ_ID });
    assert.equal(ledgerReads().length, 0, 'the ledger was read for an id we do not hold');
    assert.equal(t.identity.verified, false);
    assert.equal(t.work, null);
  });

  test('a member with no 5arz link never touches the ledger', async () => {
    // 145 of our 147 members. Three cross-company reads that could never have
    // returned anything, now not issued at all.
    const t = await trustEnvelope(envWith(1, UNLINKED), { memberId: NUM_ID });
    assert.equal(ledgerReads().length, 0);
    assert.equal(t.identity.basis, 'sms', 'the Num side must still answer');
  });

  test('a malformed or missing link is null, not a lookup', async () => {
    for (const bio of ['{not json', '', null, '{}', JSON.stringify({ '5arz_id': '' }), JSON.stringify({ '5arz_id': 42 })]) {
      log = [];
      await trustEnvelope(envWith(1, { ...MEMBER, bio }), { memberId: NUM_ID });
      assert.equal(ledgerReads().length, 0, `bio ${JSON.stringify(bio)} produced a ledger read`);
    }
  });

  test('linked5arzId reads only a real stored string', () => {
    assert.equal(linked5arzId({ bio: JSON.stringify({ '5arz_id': ARZ_ID }) }), ARZ_ID);
    assert.equal(linked5arzId({ bio: { '5arz_id': ARZ_ID } }), ARZ_ID, 'an already-parsed bio works too');
    assert.equal(linked5arzId(null), null);
    assert.equal(linked5arzId({}), null);
    assert.equal(linked5arzId({ bio: 'rubbish' }), null);
  });
});

describe('latency', () => {
  test('the ledger reads overlap rather than queue', async () => {
    const DELAY = 40;
    await trustEnvelope(envWith(DELAY), { memberId: NUM_ID });
    const reads = ledgerReads();
    assert.equal(reads.length, 3);
    // Stronger than a clock bound, which can pass by luck on a fast machine:
    // every ledger read must have started before the first one finished.
    const firstEnd = Math.min(...reads.map((q) => q.ended));
    for (const q of reads) {
      assert.ok(q.started < firstEnd, `a read started only after another finished: ${q.sql.slice(0, 40)}`);
    }
  });

  test('the member row is read once, not once per ledger query', async () => {
    await trustEnvelope(envWith(1), { memberId: NUM_ID });
    assert.equal(log.filter((q) => q.sql.includes('num_members')).length, 1);
  });
});

describe('precedence', () => {
  test('an ID check overrides SMS as the identity basis', async () => {
    // Both signals present: phone_verified = 1 and a ledger verified_at.
    const t = await trustEnvelope(envWith(1), { memberId: NUM_ID });
    assert.equal(t.identity.basis, 'id_check');
    assert.equal(t.identity.verified, true);
    assert.equal(t.identity.country, 'TH');
  });

  test('SMS stands when there is no ID check', async () => {
    const env = {
      DB: slowDb([['num_members', MEMBER]], 1, log),
      LEDGER: slowDb([['uniqueness_attestations', null], ['verified_sessions', null]], 1, log),
    };
    const t = await trustEnvelope(env, { memberId: NUM_ID });
    assert.equal(t.identity.basis, 'sms');
  });
});

describe('honesty when things are missing', () => {
  test('nothing proved means nothing claimed', async () => {
    const t = await trustEnvelope({}, { memberId: NUM_ID });
    assert.deepEqual(t.identity, { verified: false, basis: 'none' });
    assert.equal(t.uniqueness.attested, false);
    assert.equal(t.work, null);
    assert.equal(t.account, null);
    assert.equal(t.source, 'num/5arz');
  });

  test('a phone lookup does not read the ledger member row', async () => {
    // A lookup by phone is not a lookup by member id, and must not be silently
    // answered with one.
    await trustEnvelope(envWith(1), { memberId: NUM_ID, phone: '+66812345678' });
    assert.ok(!log.some((q) => q.sql.includes('FROM members')),
      'the ledger member row was read on a phone lookup');
  });

  test('one database being down degrades the envelope, never fails it', async () => {
    // A checkout that gets "unverified" still works. A checkout that gets a
    // 500 does not.
    const dead = { prepare() { const b = () => ({ bind: () => b(), first: async () => { throw new Error('D1 down'); } }); return b(); } };
    const t = await trustEnvelope(
      { DB: slowDb([['num_members', MEMBER]], 1, log), LEDGER: dead }, { memberId: NUM_ID },
    );
    assert.equal(t.identity.basis, 'sms', 'the Num side should still have answered');
    assert.equal(t.uniqueness.attested, false);
    assert.equal(t.work, null);
  });

  test('the envelope reports uniqueness and work when the ledger has them', async () => {
    const t = await trustEnvelope(envWith(1), { memberId: NUM_ID });
    assert.deepEqual(t.uniqueness, { attested: true, level: 'strong', valid_until: '2027-01-01' });
    assert.deepEqual(t.work, { sessions: 12, passed: 10, rejected: 2, avg_score: 0.82 });
    assert.equal(t.account.phone_verified, true);
    assert.equal(t.account.phone_unique, true);
  });
});
