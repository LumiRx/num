/**
 * Handing a share of a bill to the person it is for.
 *
 * The property that matters most here is not that a message sends. It is that
 * a share is NEVER left with no way of reaching anybody: on 19 Sep 2026 the
 * live database held zero push tokens and one member email across 156
 * members, and `splitBill` fanned out to push alone, so a correctly minted
 * share told nobody at all. These tests pin the floor — a link, always — and
 * then pin the rules that make texting somebody else's friend lawful.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  CHANNEL, REACH_LIMITS, shareLink, maskContact, shareMessage,
  destinationsFor, mayText, deliverShare, deliverShares, reachTrail,
} from './billreach.mjs';

function world({ twilio = true } = {}) {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT, phone TEXT,
      phone_verified INTEGER DEFAULT 0, email TEXT);
    INSERT INTO num_members VALUES ('m1','Dre','+14155550001',1,'dre@example.com');
    INSERT INTO num_members VALUES ('m2','Viv','+14155550002',0,NULL);
    INSERT INTO num_members VALUES ('m3','Sam',NULL,0,NULL);
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
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
  const env = {
    DB, SITE: 'https://itsnum.com',
    ...(twilio ? { TWILIO_SID: 'AC_test', TWILIO_TOKEN: 'tok', TWILIO_FROM: '+15005550006' } : {}),
  };
  return { d, env };
}

/** A Twilio stub that records what it was asked to send. */
function twilioStub({ ok = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)) });
    return ok
      ? { ok: true, status: 201, json: async () => ({ sid: 'SM' + calls.length }), text: async () => '' }
      : { ok: false, status: 400, json: async () => ({}), text: async () => '{"code":30034}' };
  };
  return { calls, fetchImpl };
}

const SHARE = { token: 'SHR1', amount: '21.00', currency: 'USD', amount_minor: 2100 };
const PARENT = { token: 'PARENT', venue: 'Bar Nine', currency: 'USD', business_id: 'b1' };
const DRE = { id: 'm1', name: 'Dre', phone_verified: 1 };

/* ── the floor ─────────────────────────────────────────────────────────── */

test('a share with nobody attached still comes back with a link', async () => {
  const { env } = world({ twilio: false });
  const out = await deliverShare(env, { share: { ...SHARE }, parent: PARENT, from: DRE });
  assert.equal(out.ok, true);
  assert.equal(out.link, 'https://itsnum.com/p/SHR1');
  assert.deepEqual(out.reached, []);
  assert.match(out.say, /pass on the link/i);
});

test('a handover says so rather than reporting a send that did not happen', async () => {
  const { env } = world({ twilio: false });
  const out = await deliverShare(env, { share: { ...SHARE }, parent: PARENT, from: DRE });
  assert.doesNotMatch(out.say, /^Sent/, 'nothing left the building and the guest must not be told it did');
  // And the link is recorded as an attempt, so a split that worked by
  // handover does not read as three failures in the trail.
  const trail = await reachTrail(env, 'SHR1');
  assert.ok(trail.some((t) => t.channel === CHANNEL.LINK && t.ok));
});

test('the link is the live pay page, not an app-only route', async () => {
  const { env } = world();
  assert.equal(shareLink(env, 'abc1'), 'https://itsnum.com/p/ABC1');
  // num-app carries no SITE var, so the fallback has to be the real host.
  assert.equal(shareLink({}, 'ABC1'), 'https://itsnum.com/p/ABC1');
});

/* ── who a person is ───────────────────────────────────────────────────── */

test('a member_id alone is enough to find the phone and email on file', async () => {
  const { env } = world();
  const to = await destinationsFor(env, { member_id: 'm1' });
  assert.equal(to.phone, '+14155550001');
  assert.equal(to.email, 'dre@example.com');
  assert.equal(to.name, 'Dre');
});

test('a number typed at the table beats the one on file', async () => {
  const { env } = world();
  const to = await destinationsFor(env, { member_id: 'm1', phone: '+14155559999' });
  assert.equal(to.phone, '+14155559999', 'tonight’s number is the one that was typed');
});

test('a friend who is not on NUM is still a destination', async () => {
  const { env } = world();
  const to = await destinationsFor(env, { name: 'Jo', phone: '+14155550777' });
  assert.equal(to.memberId, null);
  assert.equal(to.phone, '+14155550777');
});

test('a malformed number or address is dropped rather than handed to a provider', async () => {
  const { env } = world();
  const to = await destinationsFor(env, { phone: '5550001', email: 'not-an-address' });
  assert.equal(to.phone, null);
  assert.equal(to.email, null);
});

/* ── texting somebody else's friend ────────────────────────────────────── */

test('NUM will not text on behalf of a member who has not verified their own number', async () => {
  const { env } = world();
  const may = await mayText(env, { to: '+14155550777', from: { phone_verified: 0 }, shareToken: 'SHR1' });
  assert.equal(may.ok, false);
  assert.match(may.why, /verify your own number/);
});

test('STOP is honoured before anything else', async () => {
  const { env } = world();
  await env.DB.prepare("CREATE TABLE num_text_optouts (phone TEXT PRIMARY KEY, reason TEXT, evidence TEXT, created_at TEXT)").run();
  await env.DB.prepare("INSERT INTO num_text_optouts VALUES ('+14155550777','user_stop','','2026-09-01')").run();
  const may = await mayText(env, { to: '+14155550777', from: DRE, shareToken: 'SHR1' });
  assert.equal(may.ok, false);
  assert.match(may.why, /asked not to be texted/);
});

test('one share is one text, forever', async () => {
  const { env } = world();
  const tw = twilioStub();
  await deliverShare(env, { share: { ...SHARE, phone: '+14155550777' }, parent: PARENT, from: DRE, fetchImpl: tw.fetchImpl });
  await deliverShare(env, { share: { ...SHARE, phone: '+14155550777' }, parent: PARENT, from: DRE, fetchImpl: tw.fetchImpl });
  assert.equal(tw.calls.length, 1, 'a second tap of Send is a second tap, not a second dinner');
});

test('a repeat send is not recorded as a failed rail', async () => {
  const { env } = world();
  const tw = twilioStub();
  await deliverShare(env, { share: { ...SHARE, phone: '+14155550777' }, parent: PARENT, from: DRE, fetchImpl: tw.fetchImpl });
  await deliverShare(env, { share: { ...SHARE, phone: '+14155550777' }, parent: PARENT, from: DRE, fetchImpl: tw.fetchImpl });
  const trail = await reachTrail(env, 'SHR1');
  const sms = trail.filter((t) => t.channel === CHANNEL.SMS);
  assert.equal(sms.length, 1, 'the second attempt was a no-op and must leave no failure behind');
  assert.equal(sms[0].ok, true);
});

test('a number that has had several of these this month is left alone', async () => {
  const { env } = world();
  const tw = twilioStub();
  for (let i = 0; i < REACH_LIMITS.perRecipientPer30d; i += 1) {
    await deliverShare(env, {
      share: { ...SHARE, token: `SH${i}`, phone: '+14155550777' }, parent: PARENT, from: DRE, fetchImpl: tw.fetchImpl,
    });
  }
  assert.equal(tw.calls.length, REACH_LIMITS.perRecipientPer30d);
  const out = await deliverShare(env, {
    share: { ...SHARE, token: 'SHX', phone: '+14155550777' }, parent: PARENT, from: DRE, fetchImpl: tw.fetchImpl,
  });
  assert.equal(tw.calls.length, REACH_LIMITS.perRecipientPer30d, 'the cap did not hold');
  // And it still hands back a link, because the share is real either way.
  assert.equal(out.link, 'https://itsnum.com/p/SHX');
  assert.match(out.say, /pass on the link/i);
});

test('the invite budget is not spent by eating together twice', () => {
  // friendtext caps a stranger at 3 cold invites in 30 days. A bill share is
  // not a cold invite and must not be refused by that number.
  assert.ok(REACH_LIMITS.perRecipientPer30d > 3);
});

test('every text says who asked and how to stop', async () => {
  const { env } = world();
  const tw = twilioStub();
  await deliverShare(env, { share: { ...SHARE, phone: '+14155550777' }, parent: PARENT, from: DRE, fetchImpl: tw.fetchImpl });
  const body = tw.calls[0].body.Body;
  assert.match(body, /Dre/, 'NUM has to be able to say who asked');
  assert.match(body, /Reply STOP/);
  assert.match(body, /https:\/\/itsnum\.com\/p\/SHR1/);
});

test('a refused text leaves the reason behind, not a silence', async () => {
  const { env } = world();
  const tw = twilioStub({ ok: false });
  const out = await deliverShare(env, { share: { ...SHARE, phone: '+14155550777' }, parent: PARENT, from: DRE, fetchImpl: tw.fetchImpl });
  assert.deepEqual(out.reached, []);
  const trail = await reachTrail(env, 'SHR1');
  const sms = trail.find((t) => t.channel === CHANNEL.SMS);
  assert.equal(sms.ok, false);
  assert.match(sms.detail, /30034|twilio 400/);
});

/* ── what the guest is told ────────────────────────────────────────────── */

test('the text and the email quote the same amount', () => {
  const m = shareMessage({ venue: 'Bar Nine', amount: '21.00', currency: 'USD', fromName: 'Dre', link: 'https://x/p/A' });
  assert.match(m.sms, /USD 21\.00/);
  assert.match(m.text, /USD 21\.00/);
  assert.match(m.subject, /USD 21\.00/);
});

test('the guest is told they pay the venue, not NUM', () => {
  const m = shareMessage({ venue: 'Bar Nine', amount: '21.00', currency: 'USD', fromName: 'Dre', link: 'https://x/p/A' });
  assert.match(m.text, /pay the venue directly/);
  assert.match(m.text, /NUM never holds the money/);
});

test('a share link is for one share and says so', () => {
  const m = shareMessage({ venue: 'Bar Nine', amount: '21.00', currency: 'USD', fromName: 'Dre', link: 'https://x/p/A' });
  assert.match(m.text, /nobody else at the table can be charged on it/);
});

test('a note from the splitter is carried but clipped', () => {
  const m = shareMessage({
    amount: '9.00', currency: 'USD', fromName: 'Dre', link: 'https://x/p/A',
    note: 'x'.repeat(400),
  });
  const quoted = m.sms.match(/“(x+)”/)[1];
  assert.equal(quoted.length, REACH_LIMITS.noteMax);
});

/* ── never giving a number away ────────────────────────────────────────── */

test('a contact shown back to the splitter is masked', () => {
  // Last four, so one friend is distinguishable from another and nothing is
  // claimed about a country code the digits cannot actually tell us.
  assert.equal(maskContact('+14155550777'), '…0777');
  assert.equal(maskContact('+447700900123'), '…0123');
  assert.equal(maskContact('dre@example.com'), 'dr…@example.com');
  assert.equal(maskContact(''), null);
});

test('the result never hands the raw number back to the caller', async () => {
  const { env } = world();
  const tw = twilioStub();
  const out = await deliverShare(env, { share: { ...SHARE, phone: '+14155550777' }, parent: PARENT, from: DRE, fetchImpl: tw.fetchImpl });
  assert.equal(JSON.stringify(out).includes('4155550777'), false);
  assert.equal(out.to.phone, '…0777');
});

/* ── the whole split ───────────────────────────────────────────────────── */

test('a split reports how many NUM reached and how many are handovers', async () => {
  const { env } = world();
  const tw = twilioStub();
  const out = await deliverShares(env, {
    shares: [
      { token: 'S1', amount: '21.00', currency: 'USD', member_id: 'm1' },
      { token: 'S2', amount: '21.00', currency: 'USD', phone: '+14155550777' },
      { token: 'S3', amount: '21.00', currency: 'USD', name: 'a friend with nothing on file' },
    ],
    parent: PARENT, from: DRE, fetchImpl: tw.fetchImpl,
  });
  assert.equal(out.shares.length, 3);
  assert.equal(out.reached, 2, 'm1 by app+sms, the typed number by sms');
  assert.equal(out.handover, 1);
  assert.ok(out.shares.every((s) => s.link), 'every share has a link whatever happened');
});

test('four shares to one number do not all slip past the cap at once', async () => {
  // Sequential on purpose: the per-recipient check reads rows the same loop
  // writes, and a parallel fan-out would have every send see zero priors.
  const { env } = world();
  const tw = twilioStub();
  await deliverShares(env, {
    shares: Array.from({ length: 8 }, (_, i) => ({ token: `P${i}`, amount: '1.00', currency: 'USD', phone: '+14155550777' })),
    parent: PARENT, from: DRE, fetchImpl: tw.fetchImpl,
  });
  assert.equal(tw.calls.length, REACH_LIMITS.perRecipientPer30d);
});

/* ── it must never take the split down with it ─────────────────────────── */

test('no database is a handover, not a crash', async () => {
  const out = await deliverShare({}, { share: { ...SHARE }, parent: PARENT, from: DRE });
  assert.equal(out.ok, false);
  assert.deepEqual(out.attempts, []);
});

test('a share with no token is refused rather than minting a link to nowhere', async () => {
  const { env } = world();
  const out = await deliverShare(env, { share: { amount: '1.00' }, parent: PARENT, from: DRE });
  assert.equal(out.ok, false);
  assert.equal(out.link, null);
});
