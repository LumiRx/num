// The trust envelope: four reads, one round trip's worth of waiting.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
//
// LetsGo2Trip's term 9 asks for under 100 ms of added latency per envelope.
// The envelope reads four rows across two databases — the Num member row, the
// 5arz ledger member row, the uniqueness attestation and the session history —
// and none of them feeds another. They were nonetheless issued one after
// another, so the envelope paid four serial round trips for work that fits in
// one. That was invisible while the envelope was internal and stopped being
// invisible the moment somebody asked us to sign a number.
//
// Two properties are asserted here and they pull in opposite directions, which
// is the whole reason the change is worth testing rather than eyeballing:
//
//   1. CONCURRENCY. The reads must actually overlap.
//   2. PRECEDENCE. The results must still be APPLIED in order. `phone_verified`
//      sets identity basis to 'sms'; a completed ID check overwrites it with
//      'id_check'. Parallelising the reads while losing that ordering reports
//      a fully verified member to a partner as merely phone-verified — quieter
//      than a crash and more expensive, because the envelope's entire value is
//      that a partner can trust the basis it names.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { trustEnvelope } from './air.mjs';

/**
 * A stub database whose reads take real time, so overlap is observable.
 * Records the wall-clock window of every query it serves.
 */
function slowDb(rows, delayMs, log) {
  return {
    prepare(sql) {
      const bound = () => ({
        bind: () => bound(),
        first: async () => {
          const started = Date.now();
          await new Promise((r) => setTimeout(r, delayMs));
          log.push({ sql, started, ended: Date.now() });
          for (const [match, row] of rows) if (sql.includes(match)) return row;
          return null;
        },
      });
      return bound();
    },
  };
}

const MEMBER = { id: 'mem_1', name: 'Viv', phone_verified: 1, created_at: '2026-06-01T00:00:00Z' };
const LEDGER_ROWS = [
  ['FROM members', { id: 'mem_1', verified_at: '2026-07-01T00:00:00Z', country: 'TH' }],
  ['uniqueness_attestations', { level: 'strong', status: 'active', valid_until: '2027-01-01' }],
  ['verified_sessions', { n: 12, passed: 10, rejected: 2, avg_score: 0.82 }],
];

let log;
beforeEach(() => { log = []; });

const envWith = (delay) => ({
  DB: slowDb([['num_members', MEMBER]], delay, log),
  LEDGER: slowDb(LEDGER_ROWS, delay, log),
});

describe('trustEnvelope', () => {
  test('the four reads overlap rather than queue', async () => {
    const DELAY = 40;
    const t0 = Date.now();
    await trustEnvelope(envWith(DELAY), { memberId: 'mem_1' });
    const elapsed = Date.now() - t0;

    assert.equal(log.length, 4, 'expected exactly four reads');
    // Serial would be ~4x DELAY. Concurrent is ~1x. The midpoint is a bound
    // loose enough to survive a slow CI box and tight enough that a
    // reintroduced `await` in the middle fails it.
    assert.ok(elapsed < DELAY * 2.5,
      `reads appear serial: ${elapsed}ms for 4 x ${DELAY}ms of work`);

    // Stronger than the clock: every read must have started before the first
    // one finished. A duration bound can pass by luck on a fast machine.
    const firstEnd = Math.min(...log.map((q) => q.ended));
    for (const q of log) {
      assert.ok(q.started < firstEnd, `a read started only after another finished: ${q.sql.slice(0, 40)}`);
    }
  });

  test('an ID check still overrides SMS as the identity basis', async () => {
    // The precedence rule. Both signals are present: phone_verified = 1 and a
    // ledger verified_at. id_check must win.
    const t = await trustEnvelope(envWith(1), { memberId: 'mem_1' });
    assert.equal(t.identity.basis, 'id_check');
    assert.equal(t.identity.verified, true);
    assert.equal(t.identity.country, 'TH');
  });

  test('SMS stands when there is no ID check', async () => {
    const env = {
      DB: slowDb([['num_members', MEMBER]], 1, log),
      LEDGER: slowDb([['uniqueness_attestations', null], ['verified_sessions', null]], 1, log),
    };
    const t = await trustEnvelope(env, { memberId: 'mem_1' });
    assert.equal(t.identity.basis, 'sms');
  });

  test('nothing proved means nothing claimed', async () => {
    const t = await trustEnvelope({}, { memberId: 'mem_1' });
    assert.deepEqual(t.identity, { verified: false, basis: 'none' });
    assert.equal(t.uniqueness.attested, false);
    assert.equal(t.work, null);
    assert.equal(t.account, null);
    assert.equal(t.source, 'num/5arz');
  });

  test('a phone lookup does not read the ledger member row', async () => {
    // A lookup by phone is not a lookup by member id, and must not be
    // silently answered with one. Behaviour preserved from the serial version.
    const env = envWith(1);
    await trustEnvelope(env, { memberId: 'mem_1', phone: '+66812345678' });
    assert.ok(!log.some((q) => q.sql.includes('FROM members')),
      'the ledger member row was read on a phone lookup');
  });

  test('one database being down degrades the envelope, never fails it', async () => {
    // A checkout that gets "unverified" still works. A checkout that gets a
    // 500 does not.
    const dead = { prepare() { const b = () => ({ bind: () => b(), first: async () => { throw new Error('D1 down'); } }); return b(); } };
    const t = await trustEnvelope({ DB: slowDb([['num_members', MEMBER]], 1, log), LEDGER: dead }, { memberId: 'mem_1' });
    assert.equal(t.identity.basis, 'sms', 'the Num side should still have answered');
    assert.equal(t.uniqueness.attested, false);
    assert.equal(t.work, null);
  });

  test('the envelope reports uniqueness and work when the ledger has them', async () => {
    const t = await trustEnvelope(envWith(1), { memberId: 'mem_1' });
    assert.deepEqual(t.uniqueness, { attested: true, level: 'strong', valid_until: '2027-01-01' });
    assert.deepEqual(t.work, { sessions: 12, passed: 10, rejected: 2, avg_score: 0.82 });
    assert.equal(t.account.phone_verified, true);
    assert.equal(t.account.phone_unique, true);
  });
});
