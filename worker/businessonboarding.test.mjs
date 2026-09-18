// Business onboarding, 18 Sep 2026 — the four things Hugo's Restaurant asked
// for, each pinned by a test that fails if it is taken away again.
//
// Hugo's wrote in from West Hollywood: four Los Angeles sites, an established
// reservation system, no reservations by text message, and a claim form that
// would not submit without a mobile number. Every assertion below traces to
// one of those sentences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  channelFor, setChannel, deliverable, bookingEmail, bookingUrl, __resetReady,
} from './bookingchannel.mjs';
import {
  detectFromHtml, handoffLink, requestIntegration, needsHuman, openWork, __resetQueueReady,
} from './ressystem.mjs';
import { classifyBounce, sendHealth, recordBounce, BOUNCE_CEILING } from './bouncepolicy.mjs';
import {
  createGroup, addSite, addPerson, sitesFor, mayCross, __resetReady as resetGroups,
} from './bizgroup.mjs';
import { parseFinding, blockerFor } from './integrationagent.mjs';

function realDb(extra = '') {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, status TEXT);
    CREATE TABLE num_business_profiles (business_id TEXT PRIMARY KEY, city TEXT, area TEXT,
      address TEXT, vertical TEXT, commerce_status TEXT);
    CREATE TABLE num_suppressions (email TEXT PRIMARY KEY, reason TEXT, note TEXT);
    CREATE TABLE leads (id TEXT PRIMARY KEY, email TEXT, status TEXT, updated_at TEXT);
    CREATE TABLE num_invites (token TEXT PRIMARY KEY, email TEXT, provider_id TEXT,
      status TEXT, error TEXT, sent_at TEXT);
    ${extra}
  `);
  const DB = {
    prepare(sql) {
      const bound = [];
      const api = {
        bind(...a) { bound.push(...a); return api; },
        async first() { try { return d.prepare(sql).get(...bound) ?? null; } catch { return null; } },
        async all() { try { return { results: d.prepare(sql).all(...bound) }; } catch { return { results: [] }; } },
        async run() {
          const r = d.prepare(sql).run(...bound);
          return { meta: { changes: Number(r.changes ?? 0) } };
        },
      };
      return api;
    },
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
  __resetReady(); __resetQueueReady(); resetGroups();
  return { d, env: { DB } };
}

/* ══ 1. The claim form ══════════════════════════════════════════════════ */

const FORM = readFileSync(new URL('../public/claim/index.html', import.meta.url), 'utf8');

test('the browser no longer refuses a claim that has no mobile number', () => {
  // THE ACTUAL BUG. The label said "(optional)", the server accepted a phone
  // OR an email, and a comment in the file explained at length why the mobile
  // requirement had been removed — while this line went on rejecting every
  // submission with fewer than seven digits in the phone box. The form is
  // `novalidate`, so the HTML `required` attribute the old test checked was
  // never the lock. This line was.
  assert.ok(
    !/if \(payload\.phone\.replace\(\/\[\^\\d\]\/g, ""\)\.length < 7\) return showError\(T\.errPhone\);/.test(FORM),
    'the unconditional phone check is still in the submit handler',
  );
  // It is conditional on having asked for bookings by text, and nothing else.
  assert.match(FORM, /payload\.booking_via === "sms"\s+&& digits < 7\) return showError\(T\.errPhone\)/);
});

test('a claim still cannot be submitted with no way to reach anybody', () => {
  // Optional is not "ask for nothing". A claim nobody can be contacted about
  // cannot be verified by anybody.
  assert.match(FORM, /if \(digits < 7 && !mailOk\)\s+return showError\(T\.errReach\)/);
});

test('the form asks how bookings should reach them, and offers four answers', () => {
  assert.match(FORM, /<select id="booking_via" name="booking_via">/);
  for (const v of ['sms', 'email', 'own', 'none']) {
    assert.match(FORM, new RegExp(`<option value="${v}"`), `no "${v}" option`);
  }
  // Every locale must be able to say all four, or a Thai owner picks between
  // four English sentences.
  for (const key of ['lBookingVia', 'viaOpts', 'hintVia', 'errReach', 'errNeedEmail']) {
    const n = FORM.split(`${key}:`).length - 1;
    assert.ok(n >= 3, `${key} is translated ${n} times, expected one per locale`);
  }
});

/* ══ 2. The booking channel ═════════════════════════════════════════════ */

test('a venue that was never asked is not recorded as having chosen anything', async () => {
  const { env } = realDb();
  const c = await channelFor(env, { placeId: 'p1' });
  assert.equal(c.via, 'sms', 'the historical default');
  assert.equal(c.asked, false, '"nobody asked" and "they chose text" are different facts');
});

test('email as a channel is refused without an address to send to', async () => {
  const { env } = realDb();
  const out = await setChannel(env, 'p1', { via: 'email' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'email_required');
  // The failure this prevents is silent on both ends: a venue believing
  // bookings arrive and a guest told they were sent.
});

test('a venue that asks not to be sent bookings is honoured, not chased', async () => {
  const { env } = realDb();
  await setChannel(env, 'p1', { via: 'none' });
  const route = deliverable(await channelFor(env, { placeId: 'p1' }));
  assert.equal(route.send, false);
  assert.match(route.reason, /asked not to be sent/);
});

test("Hugo's case end to end: email chosen, and the request is deliverable", async () => {
  const { env } = realDb();
  const out = await setChannel(env, 'p_hugos_weho', {
    via: 'email', email_to: 'Reservations@Hugos.example ',
  }, { businessId: 'b_hugos', by: 'bill@hugos.example' });
  assert.equal(out.ok, true);
  const route = deliverable(out.channel);
  assert.deepEqual(
    { send: route.send, via: route.via, to: route.to },
    { send: true, via: 'email', to: 'reservations@hugos.example' },
  );
});

test('a venue on its own system is handed off, never counted as booked', async () => {
  const { env } = realDb();
  const out = await setChannel(env, 'p2', {
    via: 'own', system_key: 'opentable', system_name: 'OpenTable',
    booking_url: 'opentable.com/r/hugos-west-hollywood',
  });
  assert.equal(out.channel.integration, 'handoff');
  const route = deliverable(out.channel);
  assert.equal(route.send, false, 'a handoff is not a booking and must never be sent as one');
  assert.equal(route.via, 'handoff');
});

test('a system named with no link is a job to do, not a failed form', async () => {
  const { env } = realDb();
  const out = await setChannel(env, 'p3', { via: 'own', system_name: 'SevenRooms' });
  assert.equal(out.ok, true, 'a venue often knows its system and not its own URL');
  assert.equal(out.channel.integration, 'requested');
});

test('an address we could not deliver to is refused where a human can fix it', async () => {
  assert.equal(bookingEmail('reservations@hugos'), null, 'no TLD');
  assert.equal(bookingEmail('two words@x.com'), null);
  assert.equal(bookingEmail('RESERVATIONS@Hugos.Example'), 'reservations@hugos.example');
  assert.equal(bookingUrl('not a url'), null);
  assert.equal(bookingUrl('javascript:alert(1)'), null);
  assert.match(bookingUrl('opentable.com/r/x'), /^https:\/\/opentable\.com\/r\/x/);
});

test('a booking with no listing behind it still goes out the old door', async () => {
  // Most bookings carry no place_id — the concierge books by venue NAME
  // whenever the directory holds the place loosely or not at all. channelFor
  // answers null there, because "we do not know who this is" is a real answer
  // and dressing it up as a preference would be a lie with consequences.
  //
  // The first version of the caller read `channel.via` off that null and threw
  // a 500 on the majority of all bookings. The contract is pinned here so the
  // next caller cannot repeat it.
  const { env } = realDb();
  assert.equal(await channelFor(env, {}), null);
  const route = deliverable(null);
  assert.equal(route.send, false);
  assert.equal(route.reason, 'unknown_venue');

  const DESK = readFileSync(new URL('./bookdesk.mjs', import.meta.url), 'utf8');
  assert.match(DESK, /\?\? \{ via: 'sms'/, 'bookdesk must supply the default itself, not assume a row');
});

/* ══ 3. Reading the reservation system ══════════════════════════════════ */

test('an OpenTable widget on a venue website is read, not asked about', () => {
  const html = '<html><body><script src="https://www.opentable.com/widget/reservation/loader?rid=12345"></script></body></html>';
  assert.deepEqual(detectFromHtml(html).map((s) => s.key), ['opentable']);
});

test('a page can carry two systems and both are returned', () => {
  // A hotel running Mews for rooms and SevenRooms for its restaurant is a
  // normal arrangement. Picking one would silently drop the half we needed.
  const html = '<a href="https://app.mews.com/distributor/abc">Rooms</a><div class="sr-widget" data-src="sevenrooms.com/r/x"></div>';
  const keys = detectFromHtml(html).map((s) => s.key);
  assert.ok(keys.includes('mews') && keys.includes('sevenrooms'), keys.join(','));
});

test('the handoff link carries the party and the time the guest already gave', () => {
  const link = handoffLink('opentable', 'https://www.opentable.com/r/hugos', { party: 4, date: '2026-09-25', time: '19:30' });
  assert.match(link, /covers=4/);
  assert.match(link, /dateTime=2026-09-25T19%3A30/);
});

test('no link means no button — a booking button that goes nowhere is worse than none', () => {
  assert.equal(handoffLink('opentable', null, { party: 2 }), null);
});

test('one venue naming one system three times is one piece of work', async () => {
  const { env } = realDb();
  await requestIntegration(env, { systemKey: 'sevenrooms', systemName: 'SevenRooms', placeId: 'p1', venueName: "Hugo's" });
  await requestIntegration(env, { systemKey: 'sevenrooms', systemName: 'SevenRooms', placeId: 'p1', venueName: "Hugo's" });
  await requestIntegration(env, { systemKey: 'sevenrooms', systemName: 'SevenRooms', placeId: 'p1' });
  const open = await openWork(env, { limit: 50 });
  const human = await needsHuman(env, { limit: 50 });
  assert.equal(open.length + human.length, 1, 'three rows would be three people researching the same thing');
});

test('a partner-only system goes straight to the person who can sign', async () => {
  const { env } = realDb();
  const out = await requestIntegration(env, { systemKey: 'opentable', systemName: 'OpenTable', placeId: 'p9' });
  assert.equal(out.needsHuman, true);
  assert.equal(out.request.blocked_on, 'dre');
  // And it is NOT in the agent's queue, because no agent can produce a
  // countersigned commercial agreement.
  assert.equal((await openWork(env)).length, 0);
});

test('a system with a self-serve door is the agent"s work, not Dre"s', async () => {
  const { env } = realDb();
  await requestIntegration(env, { systemKey: 'square', systemName: 'Square Appointments', placeId: 'p8' });
  assert.equal((await openWork(env))[0].blocked_on, 'build');
  assert.equal((await needsHuman(env)).length, 0);
});

/* ══ 4. Why our mail was going to spam ══════════════════════════════════ */

test('a full mailbox is not a dead address', () => {
  assert.equal(classifyBounce({ bounce: { type: 'Transient', subType: 'MailboxFull' } }), 'transient');
  assert.equal(classifyBounce({ reason: 'mailbox full, try again later' }), 'transient');
  // Over-suppressing is quiet and permanent. Anything unclassifiable stays.
  assert.equal(classifyBounce({ reason: 'something we have never seen' }), 'unknown');
});

test('a mailbox that does not exist is suppressed and the lead is marked dead', async () => {
  const { d, env } = realDb();
  d.prepare("INSERT INTO num_invites (token,email,provider_id,status,sent_at) VALUES ('t1','x@dead.example','em_1','sent','2026-09-18')").run();
  d.prepare("INSERT INTO leads (id,email,status) VALUES ('l1','x@dead.example',NULL)").run();

  const out = await recordBounce(env, {
    ref: 'em_1', to: 'x@dead.example', type: 'email.bounced',
    data: { bounce: { type: 'Permanent', subType: 'NoEmail' }, reason: 'user unknown' },
  });
  assert.equal(out.kind, 'permanent');
  assert.equal(out.suppressed, true);
  assert.equal(d.prepare('SELECT reason FROM num_suppressions WHERE email=?').get('x@dead.example').reason, 'bounce');
  // 'dead', not 'opted_out' — they did not refuse us, the mailbox is gone,
  // and conflating the two misreports how many people actually said no.
  assert.equal(d.prepare('SELECT status FROM leads WHERE id=?').get('l1').status, 'dead');
  assert.equal(d.prepare('SELECT status FROM num_invites WHERE token=?').get('t1').status, 'bounced_permanent');
});

test('a transient bounce is recorded and the address is kept', async () => {
  const { d, env } = realDb();
  d.prepare("INSERT INTO num_invites (token,email,provider_id,status,sent_at) VALUES ('t1','x@busy.example','em_1','sent','2026-09-18')").run();
  const out = await recordBounce(env, {
    ref: 'em_1', to: 'x@busy.example', type: 'email.bounced',
    data: { bounce: { type: 'Transient', subType: 'MailboxFull' } },
  });
  assert.equal(out.suppressed, false, 'the person behind a full mailbox may be a customer next month');
  assert.equal(d.prepare('SELECT status FROM num_invites WHERE token=?').get('t1').status, 'bounced_transient');
});

test('the drain stops when the hard-bounce rate is over the ceiling', async () => {
  const { d, env } = realDb();
  // 100 attempts, 21 of them permanently bounced — the real September figure
  // on itsnum.com was 207 hard bounces in 1,821 sends, and nothing stopped.
  for (let i = 0; i < 79; i++) {
    d.prepare('INSERT INTO num_invites (token,email,status,sent_at) VALUES (?,?,?,?)')
      .run(`ok${i}`, `a${i}@x.example`, 'sent', '2026-09-18');
  }
  for (let i = 0; i < 21; i++) {
    d.prepare('INSERT INTO num_invites (token,email,status,sent_at) VALUES (?,?,?,?)')
      .run(`no${i}`, `b${i}@x.example`, 'bounced_permanent', '2026-09-18');
  }
  const h = await sendHealth(env);
  assert.equal(h.ok, false);
  assert.ok(h.rate > BOUNCE_CEILING, `rate ${h.rate}`);
  assert.match(h.reason, /hard bounces/, 'a pause with no figure attached is a pause people override');
});

test('a handful of bounces in a handful of sends is noise, and does not stop a launch', async () => {
  const { d, env } = realDb();
  d.prepare("INSERT INTO num_invites (token,email,status,sent_at) VALUES ('a','a@x.example','sent','2026-09-18')").run();
  d.prepare("INSERT INTO num_invites (token,email,status,sent_at) VALUES ('b','b@x.example','bounced_permanent','2026-09-18')").run();
  const h = await sendHealth(env);
  assert.equal(h.ok, true);
  assert.equal(h.known, false, 'one bounce in two sends is 50% and means nothing');
});

/* ══ 5. One account, several addresses ══════════════════════════════════ */

test('four sites under one group, each keeping its own identity', async () => {
  const { d, env } = realDb();
  for (const [id, name, area] of [
    ['b1', "Hugo's Restaurant", 'West Hollywood'],
    ['b2', "Hugo's Restaurant", 'Studio City'],
    ['b3', "Hugo's Tacos", 'Studio City'],
    ['b4', "Hugo's Tacos", 'Atwater Village'],
  ]) {
    d.prepare('INSERT INTO businesses (id,name,status) VALUES (?,?,?)').run(id, name, 'active');
    d.prepare('INSERT INTO num_business_profiles (business_id,area) VALUES (?,?)').run(id, area);
  }
  const g = await createGroup(env, { name: "Hugo's", country: 'US', by: 'bill@hugos.example' });
  for (const [i, id] of ['b1', 'b2', 'b3', 'b4'].entries()) {
    const r = await addSite(env, g.id, { businessId: id, placeId: `p${i + 1}`, proven: true });
    assert.equal(r.ok, true, id);
  }
  const sites = await sitesFor(env, g.id);
  assert.equal(sites.length, 4);
  // A switcher showing four rows that all read "Hugo's" is useless.
  assert.ok(sites.every((s) => /—/.test(s.display)), sites.map((s) => s.display).join(' | '));
});

test('joining a group never claims a location', async () => {
  const { env } = realDb();
  const g = await createGroup(env, { name: 'Somebody', by: 'a@b.example' });
  const r = await addSite(env, g.id, { businessId: 'b_not_mine', placeId: 'p1' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_proven', '"add a location" must not become a way to take one');
});

test('a location cannot belong to two groups, and the second is refused not moved', async () => {
  const { env } = realDb();
  const a = await createGroup(env, { name: 'Real owner', by: 'a@b.example' });
  const b = await createGroup(env, { name: 'Somebody else', by: 'c@d.example' });
  assert.equal((await addSite(env, a.id, { businessId: 'b1', placeId: 'p1', proven: true })).ok, true);
  const second = await addSite(env, b.id, { businessId: 'b1', placeId: 'p1', proven: true });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'claimed_by_another_group');
});

test('two ungrouped venues are not "the same group" because both are null', async () => {
  // The 2.5-million-venue bug. groupForPlace returns null for any ungrouped
  // listing, and null === null is true, so an equality check here would have
  // let a session on any unclaimed venue act on every other one.
  const { env } = realDb();
  const cross = await mayCross(env, 'p_random_1', 'p_random_2');
  assert.equal(cross.ok, false);
});

test('a manager signed in at one site can switch to its sibling and nowhere else', async () => {
  const { env } = realDb();
  const g = await createGroup(env, { name: "Hugo's", by: 'bill@hugos.example' });
  await addSite(env, g.id, { businessId: 'b1', placeId: 'p1', proven: true });
  await addSite(env, g.id, { businessId: 'b2', placeId: 'p2', proven: true });
  await addPerson(env, g.id, { email: 'floor@hugos.example', role: 'manager' });
  assert.equal((await mayCross(env, 'p1', 'p2')).ok, true);
  assert.equal((await mayCross(env, 'p1', 'p_someone_else')).ok, false);
});

/* ══ 6. The agent, and when it is allowed to wake a person ══════════════ */

test('an answer the model did not give in the required shape is filed as no answer', () => {
  assert.equal(parseFinding('I think OpenTable probably has an API somewhere?'), null);
  assert.equal(parseFinding('{"reach":"maybe","summary":"x","confidence":"high"}'), null);
  assert.equal(parseFinding('{"reach":"open","summary":"","confidence":"high"}'), null,
    'an empty summary is not a finding');
});

test('a well-formed finding routes the work and keeps its confidence', () => {
  const f = parseFinding('prose before {"reach":"partner","needs":["signed agreement"],"summary":"Partner programme.","confidence":"medium"} and after');
  assert.equal(f.reach, 'partner');
  assert.equal(f.confidence, 'medium');
  assert.equal(blockerFor(f), 'dre');
  assert.equal(blockerFor(parseFinding('{"reach":"open","needs":[],"summary":"Self-serve OAuth.","confidence":"high"}')), 'build');
});

test('confidence is never upgraded by a model that forgot to state it', () => {
  assert.equal(parseFinding('{"reach":"open","summary":"x"}').confidence, 'low');
});

/* ══ 7. The API a business (or its agent) actually drives ═══════════════ */

const API = readFileSync(new URL('./bizapi.mjs', import.meta.url), 'utf8');

test('adding a location to a group is proven by that location"s own key', () => {
  // The only evidence accepted is the numbiz_ key that a verified claim on the
  // OTHER listing issued. Not its id, not its name, not a checkbox. So "add a
  // location" proves control exactly as claiming it did, and cannot become a
  // way to take one — which is the same rule the claim flow has always had and
  // the reason this endpoint is safe to expose to an agent.
  assert.match(API, /async function addToGroup\(env, auth, request\)/);
  assert.match(API, /SELECT id, business_id, revoked_at FROM num_biz_keys WHERE key_hash=\?1/);
  assert.match(API, /proven: true/);
  // And a listing already spoken for is refused, not moved.
  assert.match(API, /claimed_by_another_group/);
});

test('the locations endpoint no longer implies a feature that does not exist', () => {
  // num_place_owners can hold many places per business and nothing has ever
  // written a second one — every claim door mints a fresh businesses row. The
  // endpoint now says so rather than answering "1" for ever.
  assert.match(API, /group_note/);
  assert.match(API, /POST \/v1\/group with a name to start one/);
});

test('the channel endpoint distinguishes a choice from a default', () => {
  // "they chose text" and "nobody ever asked them" are different facts, and
  // reporting the second as the first describes a venue as having turned down
  // something it was never offered.
  assert.match(API, /asked: c\.asked/);
});

test('naming your own booking system opens a piece of work, not a dead end', () => {
  assert.match(API, /requestIntegration\(env, \{/);
});
