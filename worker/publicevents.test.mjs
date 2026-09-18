// Business and host events on the public shelf: only what was marked public,
// shaped like every other listing, nearest first — and the create gate that
// keeps a dateless or placeless event private.
// Run: node --test worker/publicevents.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicEventsFor, handleEvents } from './events.mjs';
import { tonightPick } from './discover.mjs';

function fakeDb(answers) {
  const log = [];
  return {
    log,
    prepare(sql) {
      const bound = [];
      const hit = answers.find(([re]) => re.test(sql));
      const reply = () => { log.push({ sql, bound }); const v = hit ? hit[1] : undefined; return typeof v === 'function' ? v(bound, sql) : v; };
      const s = {
        bind(...a) { bound.push(...a); return s; },
        async first() { return reply() ?? null; },
        async all() { return { results: reply() ?? [] }; },
        async run() { reply(); return { meta: { changes: 1 } }; },
        async batch() { return []; },
      };
      return s;
    },
    async batch() { return []; },
    async exec() { return {}; },
  };
}

const ROW = { id: 'evt_1', slug: 'abc123XY', title: 'Rooftop launch', day: '2026-09-25', time: '19:30', place: 'Sky Bar', capacity: 80, public: 1, state: 'open', lat: 13.7236, lng: 100.5145, cover: null, price_note: 'Free entry', yes: 12 };

test('a public event is shaped like a listing: source num, /e/ url, Hosted on NUM, going count', async () => {
  const env = { DB: fakeDb([[/FROM num_events e WHERE e.public = 1/, [ROW]]]) };
  const [e] = await publicEventsFor(env, { dest: 'bangkok', day: '2026-09-24', origin: 'https://app.itsnum.com' });
  assert.equal(e.source, 'num');
  assert.equal(e.id, 'ev_abc123XY');
  assert.equal(e.url, 'https://app.itsnum.com/e/abc123XY');
  assert.equal(e.label, 'Hosted on NUM');
  assert.equal(e.starts_on, '2026-09-25');
  assert.equal(e.starts_at, '2026-09-25T19:30:00');
  assert.equal(e.going, 12);
  assert.equal(e.price_note, 'Free entry');
  assert.equal(e.distance_km, null);
});

test('with a fix, distance is computed and anything over 40 km is dropped', async () => {
  const far = { ...ROW, id: 'evt_2', slug: 'far', lat: 7.88, lng: 98.39 }; // Phuket
  const env = { DB: fakeDb([[/FROM num_events e WHERE e.public = 1/, [ROW, far]]]) };
  const out = await publicEventsFor(env, { lat: 13.7563, lng: 100.5018, day: '2026-09-24' });
  assert.equal(out.length, 1);
  assert.ok(out[0].distance_km > 3 && out[0].distance_km < 5, out[0].distance_km);
  const q = env.DB.log.find((l) => /public = 1/.test(l.sql));
  assert.match(q.sql, /e\.lat IS NOT NULL/);
});

test('the query asks for public = 1 and open only — private events cannot leak through this path', async () => {
  const env = { DB: fakeDb([[/FROM num_events e/, []]]) };
  await publicEventsFor(env, { dest: 'bangkok' });
  const q = env.DB.log.find((l) => /FROM num_events e/.test(l.sql));
  assert.match(q.sql, /e\.public = 1 AND e\.state = 'open' AND e\.day >= \?1/);
});

test('tonightPick ranks a hosted event beside Ticketmaster rows by day, then distance', () => {
  const hosted = { source: 'num', id: 'ev_x', title: 'Rooftop launch', starts_on: '2026-09-24', ends_on: '2026-09-24', starts_at: '2026-09-24T19:30:00', distance_km: 1.2 };
  const tm = [{ source: 'ticketmaster', id: 'tm_1', title: 'Big gig', starts_on: '2026-09-24', starts_at: '2026-09-24T20:00:00', distance_km: 6 }];
  const picked = tonightPick([hosted], tm, '2026-09-24');
  assert.deepEqual(picked.map((p) => p.id), ['ev_x', 'tm_1']);
});

// ── the create gate ───────────────────────────────────────────────────────

function createEnv({ host = { id: 'm1', name: 'Dre' }, member = { phone_verified: 1, email_verified: 0 }, place = null } = {}) {
  const db = fakeDb([
    [/SELECT id, name FROM num_members/, host],
    [/SELECT phone_verified, email_verified FROM num_members/, member],
    [/FROM places\s+WHERE lat IS NOT NULL/, place],
    [/FROM places WHERE id=/, place],
    [/SELECT \* FROM num_events WHERE id=/, (b) => ({ id: b[0], slug: 'sl', title: 'x' })],
    [/FROM destinations WHERE slug/, { slug: 'bangkok' }],
  ]);
  return { env: { DB: db }, db };
}
const post = (body) => new Request('https://app.itsnum.com/api/events/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const inserted = (db) => db.log.find((l) => /INSERT INTO num_events/.test(l.sql));

test('create: public with a day, a known venue and a verified host is listed', async () => {
  const { env, db } = createEnv({ place: { id: 'p9', business_id: null, name: 'Sky Bar', address: 'Silom', dest: 'bangkok', lat: 13.72, lng: 100.51 } });
  const r = await handleEvents(post({ host_id: 'm1', title: 'Rooftop launch', day: '2026-09-25', place: 'Sky Bar', public: true, dest: 'bangkok' }), env, '/create', 'https://app.itsnum.com');
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.public_refused, null);
  const ins = inserted(db);
  assert.equal(ins.bound[13], 1, 'public = 1');
  assert.equal(ins.bound[14], 'p9', 'place_id resolved from the name');
  assert.equal(ins.bound[16], 13.72);
});

test('create: public without a day is created privately and told why', async () => {
  const { env, db } = createEnv({ place: { id: 'p9', name: 'Sky Bar', dest: 'bangkok', lat: 13.72, lng: 100.51 } });
  const d = await (await handleEvents(post({ host_id: 'm1', title: 'x', place: 'Sky Bar', public: true }), env, '/create', 'https://x')).json();
  assert.match(d.public_refused, /needs a day/);
  assert.equal(inserted(db).bound[13], 0);
});

test('create: public with a venue the directory does not know stays private', async () => {
  const { env, db } = createEnv({ place: null });
  const d = await (await handleEvents(post({ host_id: 'm1', title: 'x', day: '2026-09-25', place: 'My flat', public: true }), env, '/create', 'https://x')).json();
  assert.match(d.public_refused, /place from the directory/);
  assert.equal(inserted(db).bound[13], 0);
});

test('create: public from an unverified host stays private', async () => {
  const { env, db } = createEnv({ member: { phone_verified: 0, email_verified: 0 }, place: { id: 'p9', name: 'Sky Bar', dest: 'bangkok', lat: 13.72, lng: 100.51 } });
  const d = await (await handleEvents(post({ host_id: 'm1', title: 'x', day: '2026-09-25', place: 'Sky Bar', public: true }), env, '/create', 'https://x')).json();
  assert.match(d.public_refused, /verify/);
  assert.equal(inserted(db).bound[13], 0);
});

test('create: an ordinary private event is untouched — public 0, free-text venue kept', async () => {
  const { env, db } = createEnv();
  const d = await (await handleEvents(post({ host_id: 'm1', title: 'Dinner', place: 'my place' }), env, '/create', 'https://x')).json();
  assert.equal(d.public_refused, null);
  const ins = inserted(db);
  assert.equal(ins.bound[13], 0);
  assert.equal(ins.bound[6], 'my place');
  assert.ok(!db.log.some((l) => /FROM places/.test(l.sql)), 'no directory lookup for a private event');
});
