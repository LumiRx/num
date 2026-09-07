/**
 * A person with a problem must have somewhere to put it.
 *
 * 7 Sep 2026, from Dre: "we need to create a support tab for people to submit
 * any issues that they're having."
 *
 * The evidence it was needed is in the database: 33 rows in `feature_requests`,
 * every one still `status = 'new'`, some six weeks old. When there is no door,
 * people knock on the wall and we call it silence.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileTicket, ticketsFor, queue, setStatus, handleSupport, KINDS, STATES } from './support.mjs';

const d1 = (db) => ({
  prepare: (sql) => {
    const st = { binds: [] };
    st.bind = (...a) => { st.binds = a; return st; };
    const run = () => {
      const order = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]) - 1);
      return { text: sql.replace(/\?\d+/g, '?'), args: order.map((n) => st.binds[n]) };
    };
    st.first = async () => { const { text, args } = run(); return db.prepare(text).get(...args) ?? null; };
    st.all = async () => { const { text, args } = run(); return { results: db.prepare(text).all(...args) }; };
    st.run = async () => { const { text, args } = run(); const r = db.prepare(text).run(...args); return { meta: { changes: r.changes } }; };
    return st;
  },
});

let db; let env;
beforeEach(() => { db = new DatabaseSync(':memory:'); env = { DB: d1(db) }; });

describe('filing', () => {
  test('anyone may file — signed in or not', async () => {
    const anon = await fileTicket(env, { body: 'The sign-up code never arrived.', kind: 'account' });
    assert.equal(anon.ok, true);
    assert.match(anon.id, /^sup_/);
    const member = await fileTicket(env, { me: 'mem_1', body: 'Map pin is in the wrong place.', kind: 'wrong' });
    assert.equal(member.ok, true);
    assert.equal((await queue(env)).length, 2);
  });

  test('it refuses only an empty description, and says what to do instead', async () => {
    for (const bad of ['', '   ', 'x', null, undefined]) {
      const r = await fileTicket(env, { body: bad });
      assert.equal(r.ok, false, `"${bad}" should be refused`);
      assert.match(r.error, /Tell us what happened/);
    }
  });

  test('the reply promises nothing we cannot keep', async () => {
    const r = await fileTicket(env, { body: 'Something is broken' });
    assert.doesNotMatch(r.message, /24 hours|business day|shortly|soon/i, 'no invented reply time');
    assert.match(r.message, /If you left a way to reach you/);
  });

  test('an unknown kind lands as "other" rather than being rejected', async () => {
    const r = await fileTicket(env, { body: 'A thing happened', kind: 'nonsense' });
    assert.equal(r.ok, true);
    assert.equal((await queue(env))[0].kind, 'other');
  });
});

describe('context — the whole point', () => {
  test('a ticket carries version, platform and place without anyone typing them', async () => {
    await fileTicket(env, { body: 'Crashed on open' }, { version: '0.8.241', platform: 'iPhone', dest: 'los-angeles' });
    const t = (await queue(env))[0];
    assert.equal(t.version, '0.8.241');
    assert.equal(t.platform, 'iPhone');
    assert.equal(t.dest, 'los-angeles');
  });

  test('the last thing they asked Num is attached ONLY if they ticked the box', async () => {
    await fileTicket(env, { body: 'Wrong answer' }, { lastAsk: 'dinner in Edinburgh' });
    assert.equal((await queue(env))[0].last_ask, null, 'a private conversation is not ours to attach by default');

    await fileTicket(env, { body: 'Wrong answer', include_last_ask: true }, { lastAsk: 'dinner in Edinburgh' });
    const withAsk = (await queue(env)).find((x) => x.last_ask);
    assert.equal(withAsk.last_ask, 'dinner in Edinburgh');
  });
});

describe('the queue', () => {
  test('oldest open first — the person waiting longest is served first', async () => {
    await fileTicket(env, { body: 'first' });
    await fileTicket(env, { body: 'second' });
    db.prepare("UPDATE num_support_tickets SET created_at='2026-01-01' WHERE body='second'").run();
    assert.equal((await queue(env))[0].body, 'second');
  });

  test('a person can see their own tickets, and only their own', async () => {
    await fileTicket(env, { me: 'mem_a', body: 'mine' });
    await fileTicket(env, { me: 'mem_b', body: 'theirs' });
    const mine = await ticketsFor(env, { memberId: 'mem_a' });
    assert.equal(mine.length, 1);
    assert.equal(mine[0].body, 'mine');
    assert.deepEqual(await ticketsFor(env, {}), [], 'no id, no tickets — never everyone’s');
  });

  test('only a person moves a ticket, and only to a real state', async () => {
    const { id } = await fileTicket(env, { body: 'help' });
    assert.equal((await setStatus(env, { id, status: 'sideways' })).ok, false);
    assert.equal((await setStatus(env, { id: 'nope', status: 'seen' })).ok, false);
    assert.equal((await setStatus(env, { id, status: 'answered', note: 'emailed them' })).ok, true);
    const t = db.prepare('SELECT status, note, answered_at FROM num_support_tickets WHERE id=?').get(id);
    assert.equal(t.status, 'answered');
    assert.equal(t.note, 'emailed them');
    assert.ok(t.answered_at, 'answering stamps the time');
  });

  test('nothing auto-closes — a queue that closes itself is a queue nobody reads', () => {
    const src = readFileSync(new URL('./support.mjs', import.meta.url), 'utf8');
    // Newline-tolerant on purpose: the promise lives in a wrapped block
    // comment, and a regex that breaks when a sentence rewraps teaches people
    // to delete the sentence rather than fix the test.
    assert.match(src, /does not[\s*]+auto-close/);
    assert.match(src, /never closed by a machine/);
    assert.deepEqual([...STATES], ['open', 'seen', 'answered', 'closed']);
  });
});

describe('over HTTP', () => {
  test('POST files, GET /mine lists, GET /kinds offers the short list', async () => {
    const post = new Request('https://app.itsnum.com/api/support', {
      method: 'POST', body: JSON.stringify({ me: 'mem_x', body: 'Cannot add a product', kind: 'business' }),
    });
    const r = await handleSupport(post, env, new URL(post.url));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);

    const mine = await handleSupport(new Request('https://x/api/support/mine?me=mem_x'), env, new URL('https://x/api/support/mine?me=mem_x'));
    assert.equal((await mine.json()).tickets.length, 1);

    const kinds = await handleSupport(new Request('https://x/api/support/kinds'), env, new URL('https://x/api/support/kinds'));
    const list = (await kinds.json()).kinds;
    assert.ok(list.length <= 8, 'a long list is a quiz, not a form');
    assert.deepEqual(list, KINDS);
  });

  test('the route is wired, and open to a guest who is not signed in', () => {
    const idx = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
    assert.match(idx, /url\.pathname\.startsWith\('\/api\/support'\)/);
    const block = idx.slice(idx.indexOf("startsWith('/api/support')") - 300, idx.indexOf("startsWith('/api/support')"));
    assert.match(block, /signed in or not/, 'the reason must survive next to the code');
  });
});
