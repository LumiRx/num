// The giveaways window: lists from the rules, enters through the one writer,
// and never says "you're in" when the row was not written.
// Run: node --test worker/giveaways.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LIVE, FRIDAY_PACKS_ID, list, handleGiveaways } from './giveaways.mjs';
import { RULES } from '../growth/fridayrules.mjs';
import { ENTRY_CODE } from './packdraw.mjs';

function fakeDb(answers) {
  const log = [];
  return {
    log,
    prepare(sql) {
      const bound = [];
      const hit = answers.find(([re]) => re.test(sql));
      const reply = (kind) => { log.push({ sql, bound, kind }); const v = hit ? hit[1] : undefined; return typeof v === 'function' ? v(bound) : v; };
      const s = {
        bind(...a) { bound.push(...a); return s; },
        async first() { return reply('first') ?? null; },
        async all() { return { results: reply('all') ?? [] }; },
        async run() { return reply('run') ?? { meta: { changes: 1 } }; },
      };
      return s;
    },
  };
}

const MEMBER = { id: 'm1', phone: null, phone_verified: 0, email: 'a@b.c', email_verified: 1 };

test('the Friday pack draw is still worded from the rules object', () => {
  // Two live giveaways since 19 Sep: the Friday packs and the Tokyo trip.
  // Asserted by ID rather than by position, so adding a third cannot make
  // this test silently check the wrong one.
  const g = LIVE.find((x) => x.id === FRIDAY_PACKS_ID);
  assert.ok(g, 'the Friday pack draw is gone');
  assert.match(g.prize, new RegExp(`^${RULES.winnersPerWeek} winners`));
  assert.match(g.how, new RegExp(ENTRY_CODE));
  assert.match(g.who, /United States and United Kingdom, 18\+/);
  assert.equal(g.rules_url, 'https://itsnum.com/friday-rules');
  assert.match(g.note, /Not sponsored by or affiliated with Nintendo/);
});

test('list: a signed-out visitor sees the giveaway, cannot enter, and is not "in"', async () => {
  const env = { DB: fakeDb([[/COUNT\(DISTINCT entrant_key\)/, { n: 7 }]]) };
  const d = await list(env, null, 1789689600); // Fri 18 Sep 2026 00:00 UTC — a period opens
  assert.equal(d.can_enter, false);
  const friday = d.giveaways.find((g) => g.id === 'friday-packs');
  assert.ok(friday);
  assert.equal(friday.entered, false);
  assert.equal(friday.entries, 7);
  assert.equal(friday.draw_label, '2026-09-24');
  assert.match(friday.closes_at, /^2026-09-24T23:59:59/);
  // A signed-out visitor sees the trip too, and is in neither.
  const tokyo = d.giveaways.find((g) => g.id === 'tokyo-2026');
  assert.ok(tokyo, 'the Tokyo trip is not listed');
  assert.equal(tokyo.entered, false);
});

test('a one-off campaign keeps its own closing date, not the Friday week', () => {
  // The Friday draw closes on Sunday. Before 19 Sep every item inherited that
  // boundary, which would have told everybody the trip closed this weekend.
  const tokyo = LIVE.find((g) => g.id === 'tokyo-2026');
  assert.ok(tokyo.closesAt, 'the trip has no end date of its own');
  assert.equal(/2026-09-2[0-9]/.test(tokyo.closesAt), false,
    'the trip inherited the Friday week boundary: ' + tokyo.closesAt);
});

test('the free route is the button, and it asks for nothing', () => {
  // THE CLAUSE THAT KEEPS IT LAWFUL. Entries earned by recruiting people can
  // count as consideration, and a draw with consideration is a lottery. The
  // Enter button must stay a free door that needs no referrals.
  const tokyo = LIVE.find((g) => g.id === 'tokyo-2026');
  assert.match(tokyo.who, /free to enter/i);
  assert.match(tokyo.who, /no purchase necessary/i);
  assert.match(tokyo.note, /no referrals/i);
  assert.equal(typeof tokyo.enter, 'function');
});

test('list: a verified member who entered by text this week shows as in — one ticket, either door', async () => {
  const env = { DB: fakeDb([
    [/SELECT id, phone, phone_verified, email, email_verified FROM num_members/, { ...MEMBER, phone: '+447700900123' }],
    [/SELECT phone FROM num_members/, { phone: '+447700900123' }],
    [/COUNT\(DISTINCT entrant_key\)/, { n: 3 }],
    [/FROM num_giveaway_entrants WHERE entrant_key/, (b) => (b[0] === 'phone:+447700900123' ? { one: 1 } : null)],
  ]) };
  const d = await list(env, 'm1');
  assert.equal(d.can_enter, true);
  assert.equal(d.giveaways[0].entered, true);
});

test('list: a win is surfaced from the claims table', async () => {
  const env = { DB: fakeDb([
    [/FROM num_members WHERE id/, MEMBER],
    [/SELECT phone FROM num_members/, { phone: null }],
    [/COUNT\(DISTINCT entrant_key\)/, { n: 3 }],
    [/FROM num_giveaway_claims c JOIN/, { draw_id: 'draw_1', state: 'won', drawn_at: '2026-09-11T00:05:00Z' }],
  ]) };
  const d = await list(env, 'm1');
  assert.deepEqual(d.giveaways[0].won, { draw: 'draw_1', state: 'won', drawn_at: '2026-09-11T00:05:00Z' });
});

const post = (body) => new Request('https://app.itsnum.com/api/giveaways/enter', { method: 'POST', body: JSON.stringify(body) });
const U = new URL('https://app.itsnum.com/api/giveaways/enter');

test('enter: no verified contact → 403 verify_to_send and no write', async () => {
  const db = fakeDb([[/FROM num_members WHERE id/, { ...MEMBER, email_verified: 0 }]]);
  const r = await handleGiveaways(post({ me: 'm1', id: FRIDAY_PACKS_ID }), { DB: db }, '/enter', U);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'verify_to_send');
  assert.ok(!db.log.some((l) => /INSERT INTO num_giveaway_entrants/.test(l.sql)));
});

test('enter: a verified member is written through giveaway.enter with source profile, and told they are in', async () => {
  const db = fakeDb([
    [/FROM num_members WHERE id/, MEMBER],
    [/SELECT phone FROM num_members/, { phone: null }],
    [/INSERT INTO num_giveaway_entrants/, { meta: { changes: 1 } }],
    [/COUNT\(DISTINCT entrant_key\)/, { n: 4 }],
    [/FROM num_giveaway_entrants WHERE entrant_key/, { one: 1 }],
  ]);
  const r = await handleGiveaways(post({ me: 'm1', id: FRIDAY_PACKS_ID }), { DB: db }, '/enter', U);
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.already, false);
  assert.equal(d.entered, true);
  const ins = db.log.find((l) => /INSERT INTO num_giveaway_entrants/.test(l.sql));
  assert.equal(ins.bound[1], 'member:m1');
  assert.equal(ins.bound[5], 'profile');
});

test('enter: the second tap in a week is "already", not a second ticket', async () => {
  const db = fakeDb([
    [/FROM num_members WHERE id/, MEMBER],
    [/SELECT phone FROM num_members/, { phone: null }],
    [/INSERT INTO num_giveaway_entrants/, { meta: { changes: 0 } }],
    [/COUNT\(DISTINCT entrant_key\)/, { n: 4 }],
    [/FROM num_giveaway_entrants WHERE entrant_key/, { one: 1 }],
  ]);
  const d = await (await handleGiveaways(post({ me: 'm1', id: FRIDAY_PACKS_ID }), { DB: db }, '/enter', U)).json();
  assert.equal(d.already, true);
});

test('enter: a failed write is reported as a failure, never as an entry', async () => {
  const db = fakeDb([
    [/FROM num_members WHERE id/, MEMBER],
    [/SELECT phone FROM num_members/, { phone: null }],
    [/INSERT INTO num_giveaway_entrants/, () => { throw new Error('D1 down'); }],
  ]);
  const r = await handleGiveaways(post({ me: 'm1', id: FRIDAY_PACKS_ID }), { DB: db }, '/enter', U);
  assert.equal(r.status, 500);
  assert.equal((await r.json()).ok, false);
});

test('enter: unknown giveaway 404, signed out 401', async () => {
  assert.equal((await handleGiveaways(post({ me: 'm1', id: 'nope' }), { DB: fakeDb([]) }, '/enter', U)).status, 404);
  assert.equal((await handleGiveaways(post({ id: FRIDAY_PACKS_ID }), { DB: fakeDb([]) }, '/enter', U)).status, 401);
});

test('this file writes to no giveaway table itself — giveaway.mjs stays the one writer', () => {
  const src = readFileSync(new URL('./giveaways.mjs', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /INSERT|UPDATE|DELETE/);
});
