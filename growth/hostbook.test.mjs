// A host's clients and their work, joined.
//
// The console has had both lists since August and has never shown them
// together, so a host looking at one client scrolls to a second card and does
// the join in their head. This is that join, and the thing it has to get right
// is not the count — it is whose move it is.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agenda, book, foldClient, TURN } from './hostbook.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const NOW = Date.parse('2026-09-12T12:00:00Z');
const day = (n) => new Date(NOW + n * 86400000).toISOString().replace('T', ' ').slice(0, 19);

const client = (id, name, extra = {}) => ({
  id, name, status: 'active', created_at: day(-200), ...extra,
});
const req = (id, clientId, status, extra = {}) => ({
  id, client_id: clientId, status, title: 'A job', created_at: day(-1), starts_at: null, ...extra,
});

describe('whose move is it', () => {
  test('a request they sent and you have not answered is yours', () => {
    const c = foldClient(client('c1', 'Priya'), [req('r1', 'c1', 'new')], NOW);
    assert.equal(c.turn, TURN.HOST);
    assert.equal(c.waiting_on_you, 1);
  });

  test('a draft or a quote you sent is theirs', () => {
    for (const s of ['drafted', 'awaiting_host']) {
      const c = foldClient(client('c1', 'Priya'), [req('r1', 'c1', s)], NOW);
      assert.equal(c.turn, TURN.CLIENT, `${s} should be waiting on the client`);
      assert.equal(c.waiting_on_you, 0);
    }
  });

  test('confirmed work is nobody’s move — it is in the diary', () => {
    const c = foldClient(client('c1', 'Priya'),
      [req('r1', 'c1', 'confirmed', { starts_at: day(3) })], NOW);
    assert.equal(c.turn, TURN.NOBODY);
    assert.equal(c.next.id, 'r1');
  });

  test('one unanswered request outranks three you have already replied to', () => {
    const c = foldClient(client('c1', 'Priya'), [
      req('r1', 'c1', 'drafted'), req('r2', 'c1', 'drafted'),
      req('r3', 'c1', 'awaiting_host'), req('r4', 'c1', 'new'),
    ], NOW);
    assert.equal(c.turn, TURN.HOST, 'the one you owe an answer to decides the whole row');
  });

  test('closed work is counted but never open', () => {
    const c = foldClient(client('c1', 'Priya'), [
      req('r1', 'c1', 'done'), req('r2', 'c1', 'declined'), req('r3', 'c1', 'cancelled'),
    ], NOW);
    assert.equal(c.turn, TURN.NOBODY);
    assert.equal(c.open_count, 0);
    assert.equal(c.total_count, 3);
  });
});

describe('the numbers a host acts on', () => {
  test('days waiting is the OLDEST unanswered, not the newest and not a mean', () => {
    // The oldest one is what the client is feeling.
    const c = foldClient(client('c1', 'Priya'), [
      req('r1', 'c1', 'new', { created_at: day(-9) }),
      req('r2', 'c1', 'new', { created_at: day(-1) }),
    ], NOW);
    assert.equal(c.days_waiting, 9);
  });

  test('silence is reported, because nothing is not a row', () => {
    // "Who have I not spoken to since June" is invisible in a list of
    // requests: the absence of work leaves no record to scroll past.
    const quiet = foldClient(client('c1', 'Old Friend'),
      [req('r1', 'c1', 'done', { created_at: day(-120), confirmed_at: day(-118) })], NOW);
    assert.equal(quiet.quiet_days, 118);
    const fresh = foldClient(client('c2', 'Recent'), [req('r1', 'c2', 'new', { created_at: day(-2) })], NOW);
    assert.equal(fresh.quiet_days, 2);
  });

  test('a client with no work at all still has an honest age', () => {
    const c = foldClient(client('c1', 'Never Asked', { created_at: day(-30) }), [], NOW);
    assert.equal(c.quiet_days, 30);
    assert.equal(c.turn, TURN.NOBODY);
    assert.equal(c.next, null);
  });

  test('next is the soonest FUTURE booking, not the most recent one', () => {
    const c = foldClient(client('c1', 'Priya'), [
      req('past', 'c1', 'confirmed', { starts_at: day(-5) }),
      req('far', 'c1', 'confirmed', { starts_at: day(20) }),
      req('soon', 'c1', 'confirmed', { starts_at: day(2) }),
    ], NOW);
    assert.equal(c.next.id, 'soon');
  });

  test('a date nothing can parse never becomes a booking', () => {
    // A job in the wrong place in a diary is worse than one that is missing,
    // because a host plans around it.
    const c = foldClient(client('c1', 'Priya'),
      [req('r1', 'c1', 'confirmed', { starts_at: 'next tuesday-ish' })], NOW);
    assert.equal(c.next, null);
  });
});

describe('the order of the book', () => {
  const rows = () => book([
    client('c1', 'Alice'),
    client('c2', 'Bob'),
    client('c3', 'Carla'),
    client('c4', 'Dana', { status: 'paused' }),
  ], [
    req('r1', 'c2', 'new', { created_at: day(-2) }),
    req('r2', 'c3', 'new', { created_at: day(-11) }),
    req('r3', 'c1', 'drafted'),
    req('r4', 'c4', 'new', { created_at: day(-40) }),
  ], NOW);

  test('whoever is owed an answer comes first, longest wait at the top', () => {
    assert.deepEqual(rows().clients.slice(0, 2).map((c) => c.name), ['Carla', 'Bob']);
  });

  test('waiting on the client comes after waiting on you', () => {
    assert.equal(rows().clients[2].name, 'Alice');
  });

  test('a paused client sinks even with the oldest unanswered request', () => {
    // They are in the book for continuity, not for attention.
    assert.equal(rows().clients.at(-1).name, 'Dana');
  });

  test('with nothing outstanding, the quietest relationship rises', () => {
    const out = book([
      client('c1', 'Recent'), client('c2', 'Forgotten'),
    ], [
      req('r1', 'c1', 'done', { created_at: day(-3), confirmed_at: day(-3) }),
      req('r2', 'c2', 'done', { created_at: day(-200), confirmed_at: day(-200) }),
    ], NOW);
    assert.equal(out.clients[0].name, 'Forgotten');
  });
});

describe('nothing is dropped', () => {
  test('a request with no client attached still appears', () => {
    // It is somebody's work. A row that exists and is shown nowhere is how a
    // host misses a job and blames the product.
    const out = book([client('c1', 'Priya')], [
      req('r1', null, 'new'), req('r2', 'c1', 'new'),
    ], NOW);
    assert.equal(out.unassigned.length, 1);
    assert.equal(out.unassigned[0].id, 'r1');
    assert.equal(out.counts.waiting_on_you, 2, 'the orphan was left out of the count');
  });

  test('a closed orphan is not resurrected', () => {
    const out = book([], [req('r1', null, 'done')], NOW);
    assert.deepEqual(out.unassigned, []);
  });

  test('paused clients do not inflate the headline count', () => {
    const out = book([client('c1', 'A'), client('c2', 'B', { status: 'paused' })], [], NOW);
    assert.equal(out.counts.clients, 1);
  });

  test('empty everything is a book, not a crash', () => {
    const out = book([], [], NOW);
    assert.deepEqual(out.clients, []);
    assert.equal(out.counts.waiting_on_you, 0);
    assert.deepEqual(book(null, null, NOW).clients, []);
  });
});

describe('the agenda', () => {
  const rs = [
    req('a', 'c1', 'confirmed', { starts_at: day(1) }),
    req('b', 'c1', 'confirmed', { starts_at: day(5) }),
    req('c', 'c2', 'confirmed', { starts_at: day(40) }),
    req('d', 'c1', 'confirmed', { starts_at: day(-2) }),
    req('e', 'c1', 'new', { starts_at: day(2) }),
    req('f', 'c1', 'done', { starts_at: day(3) }),
  ];
  const cs = [client('c1', 'Priya'), client('c2', 'Sam')];

  test('only confirmed work, only ahead, only inside the window, in order', () => {
    assert.deepEqual(agenda(cs, rs, { now: NOW, days: 30 }).map((r) => r.id), ['a', 'b']);
  });

  test('it names the client, so a line in a diary means something', () => {
    assert.equal(agenda(cs, rs, { now: NOW })[0].client_name, 'Priya');
  });

  test('it reads the same rows the calendar feed publishes', () => {
    // Two queries with their own filters is how the app says Tuesday and the
    // calendar says Wednesday.
    const inApp = agenda(cs, rs, { now: NOW, days: 365 }).map((r) => r.id);
    const inFeed = rs.filter((r) => r.status === 'confirmed' && r.starts_at
      && Date.parse(r.starts_at.replace(' ', 'T') + 'Z') >= NOW).map((r) => r.id);
    assert.deepEqual(inApp, inFeed);
  });

  test('a wider window reaches further and nowhere else', () => {
    assert.deepEqual(agenda(cs, rs, { now: NOW, days: 60 }).map((r) => r.id), ['a', 'b', 'c']);
  });
});

describe('the route', () => {
  const SRC = readFileSync(join(HERE, 'worker.js'), 'utf8');
  const fn = SRC.slice(SRC.indexOf('async function hostBook'), SRC.indexOf('async function hostClients'));

  test('it is routed and it is a read', () => {
    assert.match(SRC, /p === "\/api\/host\/book" && req\.method === "GET"/);
  });

  test('both queries are scoped to the authenticated host, never to the URL', () => {
    // A host id in a query string is a wish. Two people's client books are the
    // one thing that must never cross.
    assert.match(fn, /const host = await hostAuth\(env, url\)/);
    assert.match(fn, /if \(!host\) return J\(\{ ok: false, error: "unauthorised" \}, 401\)/);
    for (const m of fn.matchAll(/\.bind\(([^)]*)\)/g)) {
      assert.match(m[1], /host\.id/, `a query was bound to something other than host.id: ${m[1]}`);
    }
  });

  test('the agenda comes from the same rows as the calendar feed', () => {
    assert.match(fn, /agenda\(clients, requests/);
    assert.match(fn, /calendar\.ics\?t=/);
  });

  test('it reuses the shaping module rather than re-deriving it', () => {
    assert.match(fn, /from "\.\/hostbook\.mjs"|import\("\.\/hostbook\.mjs"\)/);
    assert.ok(!/status === .new./.test(fn),
      'the route is deciding whose move it is again, in its own words');
  });
});

describe('the console shows it', () => {
  const H = readFileSync(join(HERE, '..', 'public', 'host', 'index.html'), 'utf8');

  test('the page reads the book, and survives it failing', () => {
    // One broken panel must not take away a host's working tool.
    assert.match(H, /api\('book'\)/, 'the console never calls the book');
    const load = H.slice(H.indexOf("api('book')"), H.indexOf("api('intros')"));
    assert.match(load, /loadClients\(\)/, 'no fallback if the book call fails');
  });

  test('a row says whose move it is, not how many requests exist', () => {
    // "3 requests" is not something a host can act on at eight in the morning.
    assert.match(H, /Your move/);
    assert.match(H, /Waiting on them/);
    assert.ok(!/requests?<\/b>\s*<\/td>/.test(H));
  });

  test('the people waiting are named, not counted', () => {
    const paint = H.slice(H.indexOf('function paintBook'), H.indexOf('function loadBook'));
    assert.match(paint, /waiting\.slice\(0, 6\)/, 'the overdue list is a number with no names');
    assert.match(paint, /esc\(c\.name\)/);
  });

  test('the agenda says it is the same list the calendar subscribes to', () => {
    assert.match(H, /the same list your calendar/);
  });

  test('unassigned work is surfaced rather than silently dropped', () => {
    assert.match(H, /not attached to anyone in your book/);
  });

  test('every value painted into the book is escaped', () => {
    const paint = H.slice(H.indexOf('function paintBook'), H.indexOf('function loadBook'));
    for (const m of paint.matchAll(/\+ (r|c)\.(name|title|city|client_name)[^+]/g)) {
      assert.fail(`unescaped value in the book view: ${m[0].trim()}`);
    }
  });

  test('silence is only mentioned once it means something', () => {
    // "Quiet 0 months" against a client seen last week is noise.
    assert.match(H, /quiet_days >= 60/);
  });
});
