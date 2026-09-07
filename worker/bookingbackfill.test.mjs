/**
 * Switching on the deeplink we already had.
 *
 * The feature that sends a guest to a venue's own OpenTable page has worked
 * since August and fired for 17 places out of 1.86 million, because nothing
 * ever looked at a website. These tests are about looking politely, recording
 * every outcome so the job advances, and never overwriting a human's answer
 * with a crawler's guess.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { candidates, scanOne, backfillBookings, progress, NONE, FINAL, isFinal, MAX_ATTEMPTS } from './bookingbackfill.mjs';

let db; let env;
const d1 = (database) => ({
  prepare: (sql) => {
    const st = { sql, binds: [] };
    st.bind = (...a) => { st.binds = a; return st; };
    const run = () => {
      const text = sql.replace(/\?(\d+)/g, () => '?');
      const order = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]) - 1);
      return { text, args: order.map((n) => st.binds[n]) };
    };
    st.first = async () => { const { text, args } = run(); return database.prepare(text).get(...args) ?? null; };
    st.all = async () => { const { text, args } = run(); return { results: database.prepare(text).all(...args) }; };
    st.run = async () => { const { text, args } = run(); const r = database.prepare(text).run(...args); return { meta: { changes: r.changes } }; };
    return st;
  },
  batch: async (sts) => { for (const s of sts) await s.run(); return []; },
});

const page = (body) => ({ ok: true, status: 200, url: 'https://kata.example', text: async () => body });
const fetcher = (byUrl) => async (url) => {
  const v = byUrl[url];
  if (v instanceof Error) throw v;
  return v ?? { ok: false, status: 404, url, text: async () => '' };
};

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, website TEXT, dest TEXT, category TEXT, reviews INTEGER, hours_mask TEXT, booking_platform TEXT, booking_ref TEXT)`);
  db.exec(`INSERT INTO places VALUES
    ('p1','Bestia','https://bestia.example','los-angeles','restaurant',4200,'ffff',NULL,NULL),
    ('p2','Quiet Cafe','https://quiet.example','los-angeles','cafe',NULL,NULL,NULL,NULL),
    ('p3','A Museum','https://museum.example','los-angeles','museum',900,'ffff',NULL,NULL),
    ('p4','No Site','','los-angeles','restaurant',10,'ffff',NULL,NULL),
    ('p5','Already Known','https://known.example','los-angeles','restaurant',50,'ffff','resy','known-la')`);
  env = { DB: d1(db) };
});

describe('who it looks at', () => {
  test('restaurants, bars and cafés — not museums', async () => {
    const ids = (await candidates(env)).map((r) => r.id);
    assert.ok(ids.includes('p1'));
    assert.ok(ids.includes('p2'));
    assert.ok(!ids.includes('p3'), 'a museum does not take reservations');
  });

  test('a place with no website is nothing to read', async () => {
    assert.ok(!(await candidates(env)).some((r) => r.id === 'p4'));
  });

  test('a place that already HAS a platform is left alone', async () => {
    assert.ok(!(await candidates(env)).some((r) => r.id === 'p5'));
  });

  test('NO SINGLE CITY CAN EAT THE QUEUE', async () => {
    // Found after 160 live rows: 144 of them were Phuket and 16 Lisbon, and
    // nowhere else had been touched — because a global sort by reviews simply
    // worked through the city with the biggest review counts. Los Angeles and
    // London, where a booking link is worth the most, sat behind it.
    db.exec(`INSERT INTO places VALUES
      ('l1','Big LA','https://la1.example','los-angeles','restaurant',9000,'ffff',NULL,NULL),
      ('l2','Also LA','https://la2.example','los-angeles','restaurant',8000,'ffff',NULL,NULL),
      ('k1','Big London','https://ldn.example','london','restaurant',7000,'ffff',NULL,NULL),
      ('r1','Big Paris','https://par.example','paris','restaurant',6000,'ffff',NULL,NULL)`);
    // Three cities are waiting and the tick has room for three. Every city
    // must get its best venue looked at before ANY city gets its second.
    const dests = (await candidates(env, { limit: 3 })).map((r) => r.dest);
    assert.equal(new Set(dests).size, 3, 'one destination took the whole tick');
    // Los Angeles has the highest review count in the fixture, so a global
    // sort would have taken LA twice before touching London at all.
    assert.ok(dests.includes('london') && dests.includes('paris'));
  });

  test('THE MOST-RECOMMENDED VENUES ARE CHECKED FIRST', async () => {
    // A guest is shown three places, and those three are the well-reviewed
    // ones — the exact venues most likely to run OpenTable AND the only ones
    // whose booking link anybody will ever tap. 348,408 rows at 40 a tick is
    // thirty days; ordering by reviews puts most of the value in the first
    // afternoon and lets the long tail fill in behind it.
    // Within a destination, the best-reviewed venue leads.
    const order = (await candidates(env)).map((r) => r.id);
    assert.equal(order[0], 'p1', 'the 4,200-review restaurant is not first in the queue');
    // A row with no review count sorts last rather than unpredictably.
    assert.equal(order.at(-1), 'p2');
  });

  test('a place with a real ANSWER is not looked at twice', async () => {
    await backfillBookings(env, { fetchImpl: fetcher({}) });
    assert.deepEqual(await candidates(env), [], 'the job would loop on the same venues for ever');
  });
});

describe('A RATE-LIMIT IS NOT AN ANSWER', () => {
  // Found in the first live tick: of 40 venues, two returned HTTP 429 and one
  // 403. The first version wrote all three down as checked, which meant never
  // looked at again — a restaurant that happened to be busy when we knocked
  // would be recorded as having no booking system for ever, and its guests
  // sent to a phone number instead of its reservation page.
  test('only a real reading counts as final', () => {
    assert.deepEqual([...FINAL], ['found', 'none', 'http-404', 'no-site']);
    for (const bad of ['http-429', 'http-403', 'http-500', 'unreachable']) {
      assert.equal(isFinal(bad), false, `${bad} was treated as a settled answer`);
    }
  });

  test('a rate-limited venue comes back into the queue once it has cooled off', async () => {
    await backfillBookings(env, { fetchImpl: async () => ({ ok: false, status: 429, url: 'x', text: async () => '' }) });
    // Not immediately — hammering a site that just said "too many" is how you
    // earn a block.
    assert.deepEqual(await candidates(env), []);
    db.exec(`UPDATE num_booking_scan SET checked_at = datetime('now','-30 days')`);
    assert.ok((await candidates(env)).length > 0, 'a busy moment became a permanent verdict');
  });

  test('but it gives up eventually rather than knocking for ever', async () => {
    await backfillBookings(env, { fetchImpl: async () => ({ ok: false, status: 429, url: 'x', text: async () => '' }) });
    db.exec(`UPDATE num_booking_scan SET checked_at = datetime('now','-30 days'), attempts = ${MAX_ATTEMPTS}`);
    assert.deepEqual(await candidates(env), []);
  });

  test('progress names the ones still being retried, so a wall of 429s is visible', async () => {
    await backfillBookings(env, { fetchImpl: async () => ({ ok: false, status: 429, url: 'x', text: async () => '' }) });
    const p = await progress(env);
    assert.ok(p.retrying > 0, 'rate-limits hid inside "checked" and looked like progress');
    assert.equal(p.found, 0);
  });
});

describe('what it reads', () => {
  test('an OpenTable widget on the venue’s own page is recognised', async () => {
    const out = await scanOne(env, { id: 'p1', website: 'https://bestia.example' }, {
      fetchImpl: fetcher({ 'https://bestia.example': page('<a href="https://www.opentable.com/r/bestia-los-angeles">Book a table</a>') }),
    });
    assert.equal(out.outcome, 'found');
    assert.equal(out.platform, 'opentable');
    assert.equal(out.ref, 'bestia-los-angeles');
  });

  test('a site with no booking system is a RESULT, not a failure', async () => {
    // "We looked and there was nothing" has to be recorded, or the job
    // re-reads the same hundred sites for ever.
    const out = await scanOne(env, { id: 'p2', website: 'https://quiet.example' }, {
      fetchImpl: fetcher({ 'https://quiet.example': page('<h1>Coffee</h1>') }),
    });
    assert.equal(out.outcome, 'none');
  });

  test('a dead, slow or hostile site never stops the run', async () => {
    const dead = await scanOne(env, { id: 'p1', website: 'https://bestia.example' }, {
      fetchImpl: fetcher({ 'https://bestia.example': new Error('certificate expired') }),
    });
    assert.equal(dead.outcome, 'unreachable');
    const gone = await scanOne(env, { id: 'p1', website: 'https://bestia.example' }, { fetchImpl: fetcher({}) });
    assert.equal(gone.outcome, 'http-404');
    const nosite = await scanOne(env, { id: 'p4', website: '' }, { fetchImpl: fetcher({}) });
    assert.equal(nosite.outcome, 'no-site');
  });

  test('it says who it is, in the request', async () => {
    let seen = null;
    await scanOne(env, { id: 'p1', website: 'https://bestia.example' }, {
      fetchImpl: async (u, init) => { seen = init; return page(''); },
    });
    // A crawler that hides what it is has already decided it is doing
    // something it should not.
    assert.match(seen.headers['User-Agent'], /NumBot/);
    assert.match(seen.headers['User-Agent'], /itsnum\.com/);
  });
});

describe('what it writes', () => {
  test('a find fills the blank and the deeplink starts working', async () => {
    const out = await backfillBookings(env, {
      fetchImpl: fetcher({ 'https://bestia.example': page('<a href="https://resy.com/cities/la/bestia">Reserve</a>') }),
    });
    assert.equal(out.found, 1);
    const row = db.prepare(`SELECT booking_platform, booking_ref FROM places WHERE id='p1'`).get();
    assert.equal(row.booking_platform, 'resy');
    assert.equal(row.booking_ref, 'bestia');
  });

  test('it NEVER overwrites a platform somebody set by hand', async () => {
    // A partner telling us directly outranks anything a crawler guessed.
    db.exec(`UPDATE places SET booking_platform=NULL WHERE id='p5'`);
    db.exec(`UPDATE places SET booking_platform='opentable', booking_ref='by-hand' WHERE id='p1'`);
    await backfillBookings(env, {
      fetchImpl: fetcher({ 'https://bestia.example': page('<a href="https://resy.com/cities/la/wrong">x</a>') }),
    });
    const row = db.prepare(`SELECT booking_platform, booking_ref FROM places WHERE id='p1'`).get();
    assert.equal(row.booking_ref, 'by-hand');
  });

  test('a failed fetch writes nothing to the place row', async () => {
    await backfillBookings(env, { fetchImpl: fetcher({ 'https://bestia.example': new Error('boom') }) });
    const row = db.prepare(`SELECT booking_platform FROM places WHERE id='p1'`).get();
    assert.equal(row.booking_platform, null);
    // But it IS recorded as looked-at, so the job moves on.
    assert.equal(db.prepare(`SELECT outcome FROM num_booking_scan WHERE place_id='p1'`).get().outcome, 'unreachable');
  });

  test('progress is reportable, and says what "found" actually means', async () => {
    await backfillBookings(env, {
      fetchImpl: fetcher({ 'https://bestia.example': page('<a href="https://www.opentable.com/r/bestia-la">Book</a>') }),
    });
    const p = await progress(env);
    assert.equal(p.found, 1);
    assert.ok(p.checked >= 2);
    // The claim has to stay honest: we link, we do not book through them.
    assert.match(p.note, /does not book through it/);
  });

  test('an empty run reports done rather than spinning', async () => {
    await backfillBookings(env, { fetchImpl: fetcher({}) });
    assert.deepEqual(await backfillBookings(env, { fetchImpl: fetcher({}) }), { looked: 0, found: 0, done: true });
  });
});

describe('the file itself', () => {
  const SRC = readFileSync(new URL('./bookingbackfill.mjs', import.meta.url), 'utf8');
  const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  test('it reads the VENUE’S site, never a booking platform’s', () => {
    // We are not scraping OpenTable. We look at the restaurant's own homepage
    // and notice the button they already advertise there.
    assert.match(code, /place\?\.website/);
    assert.doesNotMatch(code, /fetch\([^)]*opentable|fetch\([^)]*resy/i);
  });

  test('fetches are sequential — forty at once looks like an attack', () => {
    assert.doesNotMatch(code, /Promise\.all\([^)]*scanOne/);
    assert.match(code, /results\.push\(await scanOne/);
  });

  test('every fetch has a timeout, so one slow site cannot hold the tick', () => {
    assert.match(code, /AbortSignal\.timeout\(\d+\)/);
  });

  test('NONE is exported for callers that mark an empty result', () => {
    assert.equal(NONE, '-');
  });
});
