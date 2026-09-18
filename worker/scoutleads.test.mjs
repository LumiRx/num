// An Expert's own list.
//
// The rule this file exists to hold: A LEAD EARNS NOTHING, SPENDS NO CAP, AND
// RESERVES NOTHING. It is a note about a conversation. Every temptation here
// runs the same way — make the lead a little bit real, let it hold a shop for
// the person who typed it first — and every one of them turns typing into a
// land grab, which is the same failure as paying for signatures, one step
// earlier.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { enrol, introduce, dashboard, MONTHLY_CLAIM_CAP } from './scouts.mjs';
import {
  addLead, updateLead, leadsFor, promoteLead, dedupeKey, MAX_LEADS, STATES,
} from './scoutleads.mjs';

const read = (f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
const SCHEMA = read('./migrations/0006_scouts.sql')
  + '\n' + read('./migrations/0032_scout_referrals.sql')
  + '\n' + read('./migrations/0034_scout_milestones.sql')
  + '\n' + read('./migrations/0036_scout_leads.sql');

function makeEnv() {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  d.exec('CREATE TABLE IF NOT EXISTS num_place_owners (place_id TEXT PRIMARY KEY, business_id TEXT, revoked_at TEXT)');
  d.exec('CREATE TABLE IF NOT EXISTS num_referral_conversions (id TEXT PRIMARY KEY, referrer_id TEXT)');
  d.exec("INSERT INTO num_scout_terms (version, body, effective_at) VALUES ('v1','T','2026-08-01')");
  const prep = (sql) => {
    let args = [];
    const api = {
      bind: (...a) => { args = a; return api; },
      first: async () => d.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: d.prepare(sql).all(...args) }),
      // D1 reports row counts under meta.changes; node:sqlite puts them at the
      // top level. Code that checks "did this UPDATE hit anything" reads the
      // D1 shape, so the harness has to speak it or the test passes against a
      // fiction.
      run: async () => {
        const r = d.prepare(sql).run(...args);
        return { ...r, meta: { changes: Number(r?.changes ?? 0) } };
      },
      _exec: () => d.prepare(sql).run(...args),
    };
    return api;
  };
  return { DB: { prepare: prep, batch: async (s) => { for (const x of s) x._exec(); } }, _raw: d };
}

const NOW = new Date('2026-09-18T12:00:00Z');

async function aScout(env, name = 'Tyler') {
  const r = await enrol(env, { name, email: `${name.toLowerCase()}@num.test`, now: NOW });
  assert.equal(r.ok, true, r.why);
  return r;
}

describe('adding what you found', () => {
  test('a shop with nothing but a name is enough — that is the point', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    const r = await addLead(env, { scoutId: t.id, name: 'The corner place', now: NOW });
    assert.equal(r.ok, true, r.why);
    assert.equal(r.state, 'to_visit');
  });

  test('a lead with no name is refused rather than saved as blank', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    const r = await addLead(env, { scoutId: t.id, address: '12 Main St', now: NOW });
    assert.equal(r.ok, false);
    assert.match(r.why, /called/);
  });

  test('adding the same shop twice is thoroughness, not an error', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    const a = await addLead(env, { scoutId: t.id, name: "Joe's Tacos", address: '114 Main St', now: NOW });
    const b = await addLead(env, { scoutId: t.id, name: 'joes tacos', address: '114 Main Street, LA', now: NOW });
    assert.equal(b.ok, true);
    assert.equal(b.already, true);
    assert.equal(b.id, a.id, 'and it points at the row they already had');
    assert.equal(env._raw.prepare('SELECT COUNT(*) n FROM num_scout_leads').get().n, 1);
  });

  test('two branches on the same street stay two leads', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    await addLead(env, { scoutId: t.id, name: 'Kopi', address: '114 Main St', now: NOW });
    await addLead(env, { scoutId: t.id, name: 'Kopi', address: '330 Main St', now: NOW });
    assert.equal(env._raw.prepare('SELECT COUNT(*) n FROM num_scout_leads').get().n, 2,
      'a key loose enough to merge two real shops would lose one of them silently');
  });

  test('the key is name plus house number, and nothing cleverer', () => {
    assert.equal(dedupeKey({ name: "Joe's Tacos", address: '114 Main St, LA' }), 'joestacos|114');
    assert.equal(dedupeKey({ name: 'joes tacos', address: '114 Main Street' }), 'joestacos|114');
    assert.notEqual(dedupeKey({ name: 'Kopi', address: '114 Main' }), dedupeKey({ name: 'Kopi', address: '330 Main' }));
  });

  test('one Expert cannot hold an unbounded list', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    for (let i = 0; i < MAX_LEADS; i += 1) {
      await addLead(env, { scoutId: t.id, name: `Shop ${i}`, address: `${i} Main St`, now: NOW });
    }
    const over = await addLead(env, { scoutId: t.id, name: 'One too many', address: '9999 Main St', now: NOW });
    assert.equal(over.ok, false);
    assert.match(over.why, /open leads/);
  });
});

describe('a lead is not a claim on a business', () => {
  test('it earns nothing', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    await addLead(env, { scoutId: t.id, name: 'Somewhere', state: 'signed_up', now: NOW });
    const rows = env._raw.prepare('SELECT COUNT(*) n FROM num_scout_earnings').get();
    assert.equal(rows.n, 0, 'even at signed_up, which is a thing people say');
  });

  test('it spends no monthly cap', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    for (let i = 0; i < 80; i += 1) {
      await addLead(env, { scoutId: t.id, name: `Shop ${i}`, address: `${i} Main St`, now: NOW });
    }
    // 80 leads is past the cap of 60. An introduction must still be allowed.
    const r = await introduce(env, { scoutId: t.id, placeId: 'p1', bizName: 'Real one', now: NOW });
    assert.equal(r.ok, true, `the cap is spent by introduce(), not by typing: ${r.why}`);
  });

  test('it reserves nothing — another Expert can still introduce that place first', async () => {
    const env = makeEnv();
    const first = await aScout(env, 'Tyler');
    const second = await aScout(env, 'Isaiah');

    await addLead(env, { scoutId: first.id, name: 'The corner place', placeId: 'p1', now: NOW });
    const theirs = await introduce(env, { scoutId: second.id, placeId: 'p1', bizName: 'The corner place', now: NOW });
    assert.equal(theirs.ok, true, 'whoever introduces it first wins, however old the other list is');

    const mine = await promoteLead(env, { scoutId: first.id, id: (await leadsFor(env, first.id)).list[0].id, now: NOW });
    assert.equal(mine.ok, false);
    assert.match(mine.why, /introduced this business first/);
  });

  test('the dashboard counts leads beside businesses and never inside them', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    for (let i = 0; i < 12; i += 1) {
      await addLead(env, { scoutId: t.id, name: `Shop ${i}`, address: `${i} Main St`, now: NOW });
    }
    await introduce(env, { scoutId: t.id, placeId: 'p1', bizName: 'Real one', now: NOW });

    const d = await dashboard(env, t.id, { now: NOW });
    assert.equal(d.leads.total, 12);
    assert.equal(d.businesses.total, 1, 'twelve leads and one introduction is one introduction');
  });
});

describe('working the list', () => {
  test('a state change sticks and comes back with what it means', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    const a = await addLead(env, { scoutId: t.id, name: 'Kopi', now: NOW });
    const u = await updateLead(env, { scoutId: t.id, id: a.id, state: 'interested', note: 'ask for Rosa', now: NOW });
    assert.equal(u.ok, true, u.why);
    const row = (await leadsFor(env, t.id)).list[0];
    assert.equal(row.state, 'interested');
    assert.equal(row.note, 'ask for Rosa');
  });

  test('a made-up state is refused', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    const a = await addLead(env, { scoutId: t.id, name: 'Kopi', now: NOW });
    const u = await updateLead(env, { scoutId: t.id, id: a.id, state: 'definitely_signing', now: NOW });
    assert.equal(u.ok, false);
  });

  test('one Expert cannot touch another Expert’s lead', async () => {
    const env = makeEnv();
    const mine = await aScout(env, 'Tyler');
    const theirs = await aScout(env, 'Isaiah');
    const a = await addLead(env, { scoutId: mine.id, name: 'Kopi', now: NOW });

    const u = await updateLead(env, { scoutId: theirs.id, id: a.id, state: 'dead', now: NOW });
    assert.equal(u.ok, false);
    assert.match(u.why, /not one of yours/);
    assert.equal((await leadsFor(env, mine.id)).list[0].state, 'to_visit', 'and it is untouched');
  });

  test('the ones needing a second visit come first', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    const dead = await addLead(env, { scoutId: t.id, name: 'Shut down', address: '1 A St', now: NOW });
    await addLead(env, { scoutId: t.id, name: 'Not been', address: '2 A St', now: NOW });
    const keen = await addLead(env, { scoutId: t.id, name: 'Wants it', address: '3 A St', now: NOW });
    await updateLead(env, { scoutId: t.id, id: dead.id, state: 'dead', now: NOW });
    await updateLead(env, { scoutId: t.id, id: keen.id, state: 'interested', now: NOW });

    const list = (await leadsFor(env, t.id)).list;
    assert.equal(list[0].name, 'Wants it', 'interested first — that is the one worth the trip');
    assert.equal(list[list.length - 1].name, 'Shut down');
  });

  test('every state has words the page is allowed to use', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    const m = (await leadsFor(env, t.id)).meaning;
    for (const s of STATES) assert.ok(m[s] && m[s].length > 8, `${s} has no explanation`);
  });
});

describe('promoting a lead once there is a listing', () => {
  test('it becomes a real introduction and the lead remembers which', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    const a = await addLead(env, { scoutId: t.id, name: 'The corner place', now: NOW });

    const r = await promoteLead(env, { scoutId: t.id, id: a.id, placeId: 'p1', now: NOW });
    assert.equal(r.ok, true, r.why);
    assert.ok(r.scout_place_id);

    const row = (await leadsFor(env, t.id)).list[0];
    assert.equal(row.place_id, 'p1');
    assert.equal(row.scout_place_id, r.scout_place_id);
  });

  test('with no listing to attach to, it says so instead of inventing one', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    const a = await addLead(env, { scoutId: t.id, name: 'The corner place', now: NOW });
    const r = await promoteLead(env, { scoutId: t.id, id: a.id, now: NOW });
    assert.equal(r.ok, false);
    assert.match(r.why, /no listing/);
  });

  test('promoting twice does not make two introductions', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    const a = await addLead(env, { scoutId: t.id, name: 'Kopi', now: NOW });
    await promoteLead(env, { scoutId: t.id, id: a.id, placeId: 'p1', now: NOW });
    const again = await promoteLead(env, { scoutId: t.id, id: a.id, placeId: 'p1', now: NOW });
    assert.equal(again.already, true);
    assert.equal(env._raw.prepare('SELECT COUNT(*) n FROM num_scout_places').get().n, 1);
  });

  test('promoting obeys the monthly cap, because introduce() does', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    for (let i = 0; i < MONTHLY_CLAIM_CAP; i += 1) {
      await introduce(env, { scoutId: t.id, placeId: `p${i}`, bizName: `Shop ${i}`, now: NOW });
    }
    const a = await addLead(env, { scoutId: t.id, name: 'One more', now: NOW });
    const r = await promoteLead(env, { scoutId: t.id, id: a.id, placeId: 'pX', now: NOW });
    assert.equal(r.ok, false);
    assert.match(r.why, /cap/, 'a lead is not a way round the cap');
  });
});
