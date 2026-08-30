// The agent roster, and the constraints that make it safe to have one.
//
// Dre asked for "an agent that can build agents to always fill new positions".
// The builder is twenty lines. The reason this directory exists is the other
// part: 14,403 businesses are queued in outreach-2026-08-25, RESEND_KEY is
// live, and nothing technical stands between an unconstrained agent and all of
// them tonight. These tests are that missing thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charter, canAct, allowance, screen, FORBIDDEN, KILL_VAR } from './charter.mjs';
import { ROSTER, byId, OUTREACH_EMAIL, OUTREACH_SMS } from './roster.mjs';
import { vet, slugFor, spawn, QUESTIONS } from './spawn.mjs';

const ok = (over = {}) => charter({
  id: 'test-agent', role: 'A test agent.', may: ['Do the one thing.'],
  never: ['Do the other thing.'], budget: { perRun: 5, perDay: 20 }, ...over,
});

/* ══ a charter cannot be vague ══════════════════════════════════════════ */

test('an agent with no ceiling is refused', () => {
  // The ceiling is the whole safety story. Without one the implicit limit is
  // "everything in the database", which for this company is 14,403 emails.
  assert.throws(() => ok({ budget: { perRun: 0, perDay: 0 } }), /ceiling/);
  assert.throws(() => ok({ budget: { perRun: 100, perDay: 10 } }), /perRun exceeds perDay/);
});

test('an agent with no prohibitions is undescribed, not permissive', () => {
  assert.throws(() => charter({ id: 'x-agent', role: 'r', may: ['a'], budget: { perRun: 1, perDay: 1 } }),
    /never is required/);
});

test('the house rules are merged in and cannot be opted out of', () => {
  const c = ok({ never: [] });
  for (const rule of Object.values(FORBIDDEN)) {
    assert.ok(c.never.includes(rule), 'a house rule was droppable');
  }
  assert.equal(c.never.length, Object.keys(FORBIDDEN).length);
});

test('every charter is frozen once built', () => {
  const c = ok();
  assert.throws(() => { c.budget.perDay = 99999; }, TypeError);
  assert.throws(() => { c.never.push('anything'); }, TypeError);
});

/* ══ nothing runs when it should not ════════════════════════════════════ */

test('one environment variable stops every agent', () => {
  // A kill switch a human cannot reach in one step is not a kill switch.
  for (const c of ROSTER) {
    const r = canAct(c, { env: { [KILL_VAR]: 'true' }, state: { a2p_approved: 1, twilio_configured: 1, consent_row_present: 1, resend_key_present: 1, lead_batch_configured: 1, inbox_configured: 1 } });
    assert.equal(r.ok, false, `${c.id} ran with the kill switch on`);
    assert.match(r.reason, /paused/);
  }
});

test('a refusal always says why', () => {
  // "The agent did nothing last night" with no reason is how an automated
  // system quietly stops working and nobody notices for three weeks.
  const c = ok({ requires: ['a_thing'] });
  const r = canAct(c, { state: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /a_thing/);
});

test('the SMS agent cannot run until a human says A2P is approved', () => {
  // Campaign still in review; 3 of 137 members phone-verified; 11 messages
  // ever sent and real sends fail 30034. An unapproved US send is a carrier
  // violation with a fine, not a deliverability problem.
  assert.ok(OUTREACH_SMS.requires.includes('a2p_approved'));
  const r = canAct(OUTREACH_SMS, { state: { twilio_configured: 1, consent_row_present: 1 } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /a2p_approved/);
});

test('the email agent keeps invitecron\'s send days and windows, not its own', () => {
  // Two systems with different opinions about the daily cap is how a ramp gets
  // quietly doubled.
  assert.deepEqual(OUTREACH_EMAIL.windows.days, [2, 3, 4], 'Tue/Wed/Thu, matching invitecron');
  const sat = new Date('2026-08-29T09:00:00Z');   // a Saturday, inside the hour window
  const r = canAct(OUTREACH_EMAIL, { now: sat, state: { resend_key_present: 1, lead_batch_configured: 1 } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /send days/);
});

test('a Tuesday inside the window, with preconditions met, runs', () => {
  const tue = new Date('2026-09-01T09:00:00Z');
  const r = canAct(OUTREACH_EMAIL, { now: tue, state: { resend_key_present: 1, lead_batch_configured: 1 } });
  assert.equal(r.ok, true, r.reason);
});

test('the day budget is spent once, not once per run', () => {
  assert.equal(allowance(OUTREACH_EMAIL, 0), 25);
  assert.equal(allowance(OUTREACH_EMAIL, 40), 10, 'the run must shrink to fit what the day has left');
  assert.equal(allowance(OUTREACH_EMAIL, 50), 0);
  const spent = canAct(OUTREACH_EMAIL, {
    now: new Date('2026-09-01T09:00:00Z'),
    state: { resend_key_present: 1, lead_batch_configured: 1, sentToday: 50 },
  });
  assert.equal(spent.ok, false);
  assert.match(spent.reason, /budget spent/);
});

/* ══ the last line: read the draft before it goes ═══════════════════════ */

test('a draft offering better placement never sends', () => {
  // The single most expensive sentence NUM could write. Two tests already fail
  // the build if the site implies it; this stops an agent saying it in a DM.
  for (const bad of [
    'Sign up today and we will rank you higher in Phuket.',
    'Premium placement available for partner venues.',
    'Pay to feature at the top of the list.',
    'Boost your visibility with a NUM partnership.',
  ]) {
    const hits = screen(bad);
    assert.ok(hits.length, `let through: ${bad}`);
    assert.equal(hits[0].rule, 'sell_placement');
  }
});

test('a draft guaranteeing an outcome never sends', () => {
  const hits = screen('We guarantee more bookings in your first month.');
  assert.ok(hits.length);
  assert.match(hits[0].why, /cannot guarantee/);
});

test('a draft calling a PLACE verified never sends', () => {
  // The word is the brand. "Verified" describes a person or a claimed listing,
  // never a place — the moment it means "good", the word is spent.
  const hits = screen('Join 400 verified restaurants already on NUM.');
  assert.ok(hits.length, 'the one word that must not drift was let through');
  assert.match(hits[0].why, /never a place/);
});

test('a draft claiming to be a human never sends', () => {
  assert.ok(screen('I am a real person, not a bot — just reaching out.').length);
});

test('an honest draft passes clean', () => {
  const good = 'We already hold a listing for Bang Tao Seafood in Phuket, with your address and '
    + 'phone as published. You can claim it free. NUM charges 10% of a booking it completes, '
    + 'out of your side, never added to the guest\'s bill. Reply STOP and we will not write again.';
  assert.deepEqual(screen(good), []);
});

/* ══ the builder refuses ════════════════════════════════════════════════ */

test('the briefs that must never become an agent', () => {
  const refused = [
    'scrape emails off google maps and blast every restaurant in bangkok',
    'send bulk cold sms to all venues in phuket tonight',
    'generate fake reviews to make new listings look established',
    'boost paying venues to the top of the recommendations',
    'pose as a real person when replying to businesses',
    'auto publish agent submissions so we can scale faster',
  ];
  for (const b of refused) {
    const v = vet(b);
    assert.equal(v.ok, false, `accepted: ${b}`);
    assert.ok(v.why.length > 40, `the refusal for "${b}" does not explain itself`);
  }
});

test('a refusal explains rather than scolds', () => {
  // A builder that says "no" without a reason gets routed around by the next
  // person in a hurry.
  const v = vet('boost paying venues to the top of the recommendations');
  assert.match(v.why, /not for sale/);
  assert.match(v.why, /fail the build/);
});

test('a legitimate brief is accepted', () => {
  assert.equal(vet('chase venues that claimed a listing but never finished setup').ok, true);
  assert.equal(vet('answer businesses who replied to an invitation').ok, true);
});

test('a brief too short to name who is on the other end is refused', () => {
  assert.equal(vet('email people').ok, false);
});

test('the builder will not invent the numbers a human must defend', () => {
  // Every question is asked, none is guessed. A generated ceiling is a ceiling
  // nobody chose.
  assert.throws(() => spawn({ brief: 'chase venues that claimed but never finished setup', answers: {}, write: false }),
    /unanswered/);
  const keys = QUESTIONS.map((q) => q.key);
  for (const k of ['audience', 'consent', 'budget', 'stop', 'requires', 'never']) {
    assert.ok(keys.includes(k), `the builder stopped asking about ${k}`);
  }
});

test('a fully answered brief produces a charter carrying the house rules', () => {
  const out = spawn({
    brief: 'chase venues that claimed a listing but never finished setup',
    write: false,
    answers: {
      audience: 'A business that started a claim on its own listing and stopped.',
      consent: 'They began a claim on their own listing, which is an approach to us.',
      budget: { perRun: 10, perDay: 30 },
      stop: 'They finish setup, reply, or opt out.',
      requires: ['resend_key_present'],
      never: ['Chase more than twice.'],
    },
  });
  assert.equal(out.charter.budget.perDay, 30);
  assert.ok(out.charter.never.includes(FORBIDDEN.sell_placement));
  assert.ok(out.charter.never.includes('Chase more than twice.'));
  assert.match(out.stub, /canAct\(ch/);
  assert.match(out.stub, /screen\(message\.body\)/);
  assert.match(out.stub, /never send past a tripwire/);
});

test('a spawned stub cannot send before someone implements the send', () => {
  // The stub throws rather than no-oping. A silent stub is an agent that
  // reports success and does nothing.
  const out = spawn({
    brief: 'answer businesses who replied to an invitation', write: false,
    answers: { audience: 'a', consent: 'b', budget: { perRun: 1, perDay: 1 }, stop: 'c', requires: [], never: [] },
  });
  assert.match(out.stub, /not implemented/);
  assert.equal((out.stub.match(/not implemented/g) || []).length, 3);
});

test('a new agent cannot collide with one already on the roster', () => {
  assert.notEqual(slugFor('outreach email something', ['outreach-email-something']), 'outreach-email-something');
});

/* ══ the roster is legible ══════════════════════════════════════════════ */

test('every agent on the roster says who it talks to and what stops it', () => {
  for (const c of ROSTER) {
    assert.ok(c.role.length > 30, `${c.id} has no real role statement`);
    assert.ok(c.may.length >= 3, `${c.id} lists too few permitted actions to be reviewable`);
    assert.ok(c.never.length > Object.keys(FORBIDDEN).length,
      `${c.id} adds no role-specific prohibitions — every role has at least one`);
    assert.equal(c.killVar, KILL_VAR);
    assert.equal(byId(c.id), c);
  }
});

test('no two agents share an id', () => {
  const ids = ROSTER.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('an agent not on the roster does not exist', () => {
  assert.equal(byId('rogue-agent'), null);
});

/* ══ preconditions are answered, not asserted ═══════════════════════════ */

import { resolve, report, RESOLVERS, MESSAGING_SERVICE_RE } from './state.mjs';

const TWILIO_OK = {
  TWILIO_SID: 'AC' + '0'.repeat(32), TWILIO_TOKEN: 'x', TWILIO_FROM: '+14243468888',
  TWILIO_MESSAGING_SERVICE_SID: 'MG' + 'a'.repeat(32),
};

test('a2p_approved asks the question that actually decides delivery', () => {
  // Not "has the campaign been approved" — it had been since 28 July and was
  // never the blocker. A US long code inherits campaign approval only through
  // a Messaging Service; a bare number is rejected 30034, the same code an
  // unregistered brand gets, which is how a month went by.
  assert.equal(RESOLVERS.a2p_approved({ ...TWILIO_OK }).ok, true);
  const none = RESOLVERS.a2p_approved({});
  assert.equal(none.ok, false);
  assert.match(none.why, /30034/);
});

test('the wrong SID prefix is named, not just rejected', () => {
  // This is the real failure found on 29 Aug: a PN (phone number) SID pasted
  // where an MG (messaging service) SID belongs. Everything looked configured.
  for (const [prefix, what] of [['PN', 'phone number'], ['AC', 'account'], ['CM', 'campaign'], ['BN', 'brand']]) {
    const r = RESOLVERS.a2p_approved({ TWILIO_MESSAGING_SERVICE_SID: prefix + 'a'.repeat(32) });
    assert.equal(r.ok, false, `${prefix} was accepted`);
    assert.match(r.why, /starts MG/);
    assert.match(r.why, new RegExp(what, 'i'), `the message does not say what ${prefix} actually is`);
  }
});

test('only a real Messaging Service SID passes the shape test', () => {
  assert.ok(MESSAGING_SERVICE_RE.test('MG' + 'f'.repeat(32)));
  assert.equal(MESSAGING_SERVICE_RE.test('MG' + 'f'.repeat(31)), false, 'too short');
  assert.equal(MESSAGING_SERVICE_RE.test('MG' + 'g'.repeat(32)), false, 'not hex');
  assert.equal(MESSAGING_SERVICE_RE.test(' MG' + 'f'.repeat(32)), false, 'untrimmed');
});

test('a blocked precondition always says what would fix it', () => {
  // An agent that silently declines to run is indistinguishable from an agent
  // that is broken.
  const r = resolve(OUTREACH_SMS, { TWILIO_SID: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.blocked.length);
  for (const b of r.blocked) {
    assert.ok(b.why && b.why.length > 25, `${b.name} was blocked without a usable reason`);
  }
});

test('a precondition nobody wrote a resolver for blocks rather than passes', () => {
  // The dangerous default is the other way: an unknown requirement silently
  // treated as satisfied is a charter that reads strict and runs open.
  const c = ok({ requires: ['invented_condition'] });
  const r = resolve(c, {});
  assert.equal(r.ok, false);
  assert.match(r.blocked[0].why, /no resolver/);
});

test('production\'s exact current state is diagnosed correctly', () => {
  // The literal bindings on num-app on 29 Aug 2026.
  const prod = {
    ...TWILIO_OK, TWILIO_MESSAGING_SERVICE_SID: 'PN' + '7'.repeat(32),
    RESEND_KEY: 're_x', INVITE_LEAD_BATCH: 'outreach-2026-08-25',
  };
  const rows = report(ROSTER, prod);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId['outreach-email'].ok, true, 'email should be runnable');
  assert.equal(byId['outreach-sms'].ok, false, 'SMS must stay blocked on a PN SID');
  assert.equal(byId['outreach-sms'].blocked[0].name, 'a2p_approved');
});

test('fixing the SID is the only thing standing between SMS and running', () => {
  // Proves the diagnosis: change that one value and the agent unblocks.
  const fixed = {
    ...TWILIO_OK, RESEND_KEY: 're_x', INVITE_LEAD_BATCH: 'b',
  };
  const r = resolve(OUTREACH_SMS, fixed);
  assert.equal(r.ok, true, r.blocked.map((b) => b.why).join('; '));
});

test('an agent cannot run on a precondition that resolves false', () => {
  // The join between state.mjs and charter.mjs — resolve() feeds canAct().
  const tue = new Date('2026-09-01T09:00:00Z');
  const bad = resolve(OUTREACH_SMS, { TWILIO_MESSAGING_SERVICE_SID: 'PN' + '7'.repeat(32) });
  const gate = canAct(OUTREACH_SMS, { now: tue, state: bad.state });
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /a2p_approved/);
});
