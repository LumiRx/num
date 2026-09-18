// GET /api/social/requests — the app's inbox, and the one call it makes on
// every cold open.
//
// STATUS.md has carried this as a known gap since early September: "drops the
// connection (status 000) when a member id contains a quote character". The
// quote is a red herring. Every query in the handler binds its parameters, so
// a quote reaches SQLite as data and finds nothing — production answers 200
// with empty lists today for `'`, `"`, `\`, a smart quote, a 300-character id
// and `' OR 1=1--`, which the first block below pins so it stays that way.
//
// What can actually fall over is the LAST query: `num_event_guests JOIN
// num_events`. Those two tables belong to worker/events.mjs and are created by
// ITS ensure(), not by social's. On a database where nothing has touched the
// events routes yet, the inbox throws `no such table: num_event_guests` — for
// every member, quote or no quote — and before handleSocialSafe existed that
// surfaced as a 1101 with no response at all, which is what a dropped
// connection looks like from the app.
//
// Real Requests through the real router against real SQLite with the real
// schema, in the idiom of social.takeover.test.mjs: a fix that only looks
// right fails here.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSocialSafe } from './social.mjs';

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      const stmt = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: stmt.all(...args), success: true };
      stmt.run(...args);
      return { results: [], success: true };
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
    },
  });
  return {
    prepare(sql) {
      const bound = (args) => ({ bind: (...more) => bound([...args, ...more]), ...shape(sql, args) });
      return bound([]);
    },
    batch: async (stmts) => stmts.map((s) => s.run()),
  };
}

// ONE database for the whole file, because social.mjs remembers that it has
// already built its schema (`ensured`) for the life of the module. A fresh
// DatabaseSync per test would get the tables only for whichever test ran
// first, and every other one would fail on an empty database for a reason
// that has nothing to do with what it is asserting.
const db = new DatabaseSync(':memory:');
const env = { DB: d1(db) };

/** The two tables events.mjs owns, in the shape its ensure() leaves them. */
const EVENT_TABLES = `
CREATE TABLE IF NOT EXISTS num_events (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, business_id TEXT,
  title TEXT NOT NULL, day TEXT, time TEXT, place TEXT, address TEXT, dress TEXT, note TEXT,
  capacity INTEGER, plan_id TEXT, slug TEXT UNIQUE, state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS num_event_guests (token TEXT PRIMARY KEY, event_id TEXT NOT NULL, name TEXT,
  phone TEXT, member_id TEXT, rsvp TEXT NOT NULL DEFAULT 'pending', plus_ones INTEGER NOT NULL DEFAULT 0,
  message TEXT, invited_at TEXT NOT NULL DEFAULT (datetime('now')), opened_at TEXT, replied_at TEXT,
  via TEXT NOT NULL DEFAULT 'link');
`;
db.exec(EVENT_TABLES);

const get = async (query) =>
  handleSocialSafe(new Request(`https://app.itsnum.com/api/social/requests?${query}`), env, '/requests');

const read = async (res) => ({ status: res.status, body: await res.json() });

// One real call before anything else, so social.mjs builds its schema. Until
// it has, there is no num_members to clear between tests.
await get('me=mem_warm');

const member = (id, name, phone) =>
  db.prepare('INSERT INTO num_members (id, name, phone) VALUES (?,?,?)').run(id, name, phone);

beforeEach(() => {
  for (const t of ['num_members', 'num_links', 'num_events', 'num_event_guests']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

describe('a member id is data, never SQL', () => {
  // Every one of these answers 200 with empty lists in production today. They
  // are here so that stays an assertion rather than a memory.
  const hostile = {
    'a single quote': "mem_te'st",
    'a double quote': 'mem_te"st',
    'a backslash': 'mem_te\\st',
    'a smart quote': 'mem_te’st',
    'the injection everyone tries': "' OR 1=1--",
    'a comment terminator': 'mem_test--',
    'a semicolon and a DROP': 'mem_x"; DROP TABLE num_members;--',
    'three hundred characters': 'm'.repeat(300),
  };

  for (const [what, id] of Object.entries(hostile)) {
    test(`${what} answers an empty inbox, not an error`, async () => {
      const { status, body } = await read(await get(`me=${encodeURIComponent(id)}`));
      assert.equal(status, 200, `${what} should not fall over`);
      assert.deepEqual(body, { connects: [], plans: [], events: [] });
    });
  }

  test('the members table is still there afterwards', async () => {
    // The DROP above is bound as a parameter, so it is a name nobody has.
    await get(`me=${encodeURIComponent('mem_x"; DROP TABLE num_members;--')}`);
    assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) AS n FROM num_members').get());
  });

  test('no member id at all is a 400 that says so', async () => {
    const { status, body } = await read(await get(''));
    assert.equal(status, 400);
    assert.match(body.error, /me required/);
  });
});

describe('the inbox on a database that has never served an event', () => {
  /** Run something with the events tables gone, then put them back. */
  async function withoutEvents(fn) {
    db.exec('DROP TABLE IF EXISTS num_event_guests; DROP TABLE IF EXISTS num_events;');
    try { return await fn(); } finally { db.exec(EVENT_TABLES); }
  }

  test('a real member gets their inbox, and their pending connection with it', async () => {
    // THE ACTUAL BUG behind "status 000", and the test that catches it coming
    // back. num_event_guests and num_events are built by events.mjs's
    // ensure(), which a member who only ever opens the app has never
    // triggered — so the last query in the handler threw, the whole inbox
    // 500'd, and a connection waiting on an answer was invisible.
    //
    // It has to be a REAL member: an unknown id returns before the events
    // query is ever reached, which is why this bug survived being looked at.
    member('mem_you', 'You', '+15550001111');
    member('mem_ana', 'Ana', '+15550002222');
    db.prepare("INSERT INTO num_links (id, a_id, b_id, state) VALUES ('lnk_1','mem_ana','mem_you','pending')").run();

    const { status, body } = await withoutEvents(async () => read(await get('me=mem_you')));
    assert.equal(status, 200, 'the inbox does not depend on the events routes having been used');
    assert.equal(body.connects.length, 1, 'and the connection waiting on them is still there');
    assert.equal(body.connects[0].from_name, 'Ana');
    assert.deepEqual(body.events, [], 'no events have been created, so none are waiting');
  });

  test('an unknown member is an empty inbox — it never reaches the events tables', async () => {
    // Stated so the asymmetry above is on the record rather than a surprise.
    const { status, body } = await withoutEvents(async () => read(await get('me=mem_nobody')));
    assert.equal(status, 200);
    assert.deepEqual(body, { connects: [], plans: [], events: [] });
  });
});

describe('the inbox on a database with everything', () => {
  test('a pending event invite matched by phone comes back, marked how it arrived', async () => {
    member('mem_you', 'You', '+15550001111');
    member('mem_host', 'Hosty', '+15550003333');
    db.prepare(`INSERT INTO num_events (id, host_id, title, day, place, slug, state)
                VALUES ('ev_1','mem_host','Dinner','2026-10-02','Bangkok','dinner-1','open')`).run();
    // Invited by PHONE, never by a link they clicked — the case the handler
    // exists for.
    db.prepare(`INSERT INTO num_event_guests (token, event_id, phone, rsvp, via)
                VALUES ('tok_1','ev_1','+15550001111','pending','agent')`).run();

    const { status, body } = await read(await get('me=mem_you'));
    assert.equal(status, 200);
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].title, 'Dinner');
    assert.equal(body.events[0].host_name, 'Hosty');
    assert.equal(body.events[0].via, 'agent', 'their Num asked yours, and the app says so');
  });

  test('an invite nobody stamped reads as a link, which is what it was', async () => {
    member('mem_you', 'You', '+15550001111');
    db.prepare("INSERT INTO num_events (id, host_id, title, slug, state) VALUES ('ev_2','mem_h','Drinks','drinks-2','open')").run();
    db.prepare("INSERT INTO num_event_guests (token, event_id, member_id, rsvp) VALUES ('tok_2','ev_2','mem_you','pending')").run();

    const { body } = await read(await get('me=mem_you'));
    assert.equal(body.events[0].via, 'link');
  });

  test('a closed event is not waiting on anybody', async () => {
    member('mem_you', 'You', '+15550001111');
    db.prepare("INSERT INTO num_events (id, host_id, title, slug, state) VALUES ('ev_3','mem_h','Over','over-3','closed')").run();
    db.prepare("INSERT INTO num_event_guests (token, event_id, member_id, rsvp) VALUES ('tok_3','ev_3','mem_you','pending')").run();

    const { body } = await read(await get('me=mem_you'));
    assert.deepEqual(body.events, []);
  });

  test('an invite already answered is not waiting either', async () => {
    member('mem_you', 'You', '+15550001111');
    db.prepare("INSERT INTO num_events (id, host_id, title, slug, state) VALUES ('ev_4','mem_h','Brunch','brunch-4','open')").run();
    db.prepare("INSERT INTO num_event_guests (token, event_id, member_id, rsvp) VALUES ('tok_4','ev_4','mem_you','yes')").run();

    const { body } = await read(await get('me=mem_you'));
    assert.deepEqual(body.events, []);
  });
});
