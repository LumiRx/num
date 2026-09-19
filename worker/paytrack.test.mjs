// The funnel. Its whole value is that what it says is true, so most of what is
// pinned here is what it refuses to record and what it refuses to claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { KINDS, scrub, track, trailFor, funnelFor } from './paytrack.mjs';

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE num_pay_events (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT, business_id TEXT,
      kind TEXT, billable INTEGER DEFAULT 0, visitor_id TEXT, ip_hash TEXT, day TEXT, created_at TEXT,
      rail TEXT, member_id TEXT, detail TEXT, amount_minor INTEGER);
  `);
  const DB = {
    prepare(sql) {
      const bound = [];
      const api = {
        bind(...a) { bound.push(...a); return api; },
        async first() { return d.prepare(sql).get(...bound) ?? null; },
        async all() { return { results: d.prepare(sql).all(...bound) }; },
        async run() { const r = d.prepare(sql).run(...bound); return { meta: { changes: Number(r.changes ?? 0) } }; },
      };
      return api;
    },
  };
  return { d, env: { DB } };
}

test('an unknown kind is refused, not invented', async () => {
  // A typo that quietly adds a funnel stage nobody counts is worse than a
  // missing event, because the funnel then looks complete and is not.
  const { d, env } = db();
  assert.equal(await track(env, { token: 'T1', kind: 'chekout_opened' }), null);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM num_pay_events').get().n, 0);
});

test('every kind in the vocabulary says what it means', () => {
  for (const [k, v] of Object.entries(KINDS)) {
    assert.ok(typeof v === 'string' && v.length > 8, `${k} needs a description a person can read`);
  }
});

test('a reason never carries a secret out of Stripe', async () => {
  // These rows are read by venue staff in a console, and the reasons come
  // from vendors we do not control.
  assert.equal(scrub('No such customer: cus_x for acct_1UGjiZRVBFilubPX'), 'No such customer: cus_x for [redacted]');
  assert.match(scrub('bad key sk_live_abc123'), /\[redacted\]/);
  assert.match(scrub('signature check failed for whsec_zzz'), /\[redacted\]/);
  assert.match(scrub('session cs_test_9 expired'), /\[redacted\]/);
  assert.match(scrub('Authorization: Bearer abc.def.ghi'), /\[redacted\]/);
  assert.equal(scrub(null), null);
  assert.equal(scrub('x'.repeat(400)).length, 160);
});

test('a write that fails never becomes an error the caller has to handle', async () => {
  // A guest's money must not fail to move because we could not write a row
  // about it, and a webhook that throws over analytics makes Stripe retry a
  // settled bill.
  const broken = { DB: { prepare: () => ({ bind: () => ({ run: async () => { throw new Error('no such column: rail'); } }) }) } };
  assert.equal(await track(broken, { token: 'T1', kind: 'paid' }), null);
  assert.equal(await track({ DB: null }, { token: 'T1', kind: 'paid' }), null);
  assert.equal(await track(db().env, { kind: 'paid' }), null);
});

test('one bill\'s trail comes back in order, in words', async () => {
  const { env } = db();
  await track(env, { token: 'b1', businessId: 'biz', kind: 'scan' });
  await track(env, { token: 'b1', businessId: 'biz', kind: 'rail_chosen', rail: 'card', memberId: 'm1' });
  await track(env, { token: 'b1', businessId: 'biz', kind: 'checkout_opened', rail: 'card', amountMinor: 8450 });
  await track(env, { token: 'b1', businessId: 'biz', kind: 'paid', rail: 'card' });
  const trail = await trailFor(env, 'B1');
  assert.deepEqual(trail.map((e) => e.kind), ['scan', 'rail_chosen', 'checkout_opened', 'paid']);
  assert.equal(trail[3].what, KINDS.paid);
  assert.equal(trail[2].amount_minor, 8450);
});

test('the funnel counts by step and by rail, and names the refusals', async () => {
  const { env } = db();
  for (let i = 0; i < 5; i += 1) await track(env, { token: `b${i}`, businessId: 'biz', kind: 'scan' });
  await track(env, { token: 'b1', businessId: 'biz', kind: 'checkout_opened', rail: 'card' });
  await track(env, { token: 'b1', businessId: 'biz', kind: 'paid', rail: 'card' });
  await track(env, { token: 'b2', businessId: 'biz', kind: 'checkout_refused', rail: 'pay_by_bank', detail: "Pay by Bank is not switched on in this venue's Stripe account" });
  await track(env, { token: 'b3', businessId: 'biz', kind: 'checkout_refused', rail: 'pay_by_bank', detail: "Pay by Bank is not switched on in this venue's Stripe account" });

  const f = await funnelFor(env, 'biz');
  assert.equal(f.counts.scan, 5);
  assert.equal(f.counts.paid, 1);
  assert.equal(f.rails.card.paid, 1);
  assert.equal(f.rails.pay_by_bank.refused, 2);
  // A funnel that says two people dropped is interesting. One that says they
  // dropped because a rail is switched off in the venue's own Stripe account
  // is something to go and fix.
  assert.equal(f.refusals[0].n, 2);
  assert.match(f.refusals[0].detail, /not switched on/);
});

test('the funnel offers no conversion rate, because it does not have one', async () => {
  // Scans and payments are counted over the same window and are not the same
  // population: a guest can scan on Monday and pay on Tuesday, and a bill can
  // be paid in the app without /p/ ever being opened. A ratio of the two looks
  // like a rate and is not one, and a venue would act on it.
  const { env } = db();
  await track(env, { token: 'b1', businessId: 'biz', kind: 'scan' });
  const f = await funnelFor(env, 'biz');
  assert.equal(f.rate, undefined);
  assert.equal(f.conversion, undefined);
  assert.equal(f.counts.paid, 0, 'a step nothing reached is zero, not missing');
});

test('one venue never sees another venue\'s events', async () => {
  const { env } = db();
  await track(env, { token: 'b1', businessId: 'mine', kind: 'paid', rail: 'card' });
  await track(env, { token: 'b2', businessId: 'theirs', kind: 'paid', rail: 'card' });
  assert.equal((await funnelFor(env, 'mine')).counts.paid, 1);
  assert.equal((await funnelFor(env, 'theirs')).counts.paid, 1);
});

test('before migration 0047 the funnel says so instead of drawing an empty one', async () => {
  // An empty funnel and a funnel that cannot be read look identical on a
  // screen, and a venue reads the first as "nobody paid".
  const broken = { DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error('no such column: rail'); } }) }) } };
  assert.equal(await funnelFor(broken, 'biz'), null);
  assert.deepEqual(await trailFor(broken, 'b1'), []);
});
