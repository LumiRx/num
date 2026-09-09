// "Your neighbour just joined" — who to tell, and who never to.
//
// The pitch is good and the danger is the channel. NUM holds ~1.8M business
// phone numbers scraped off open map data with no consent rows against any of
// them; texting that list is the end of the company, in the words of
// smsconsent.mjs. So the shape of this module is as much about what it refuses
// to return as what it finds.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_KM, MAX_BATCH, contactable, ensure, neighbourEmail, neighboursOf, recordBatch,
} from './bizneighbours.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      const st = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: st.all(...args), success: true };
      st.run(...args); return { results: [], success: true };
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
  });
  return {
    prepare(sql) { const b = (a) => ({ bind: (...m) => b([...a, ...m]), ...shape(sql, a) }); return b([]); },
    batch: async (s) => Promise.all(s.map((x) => x.run())),
  };
}

const db = new DatabaseSync(':memory:');
const env = { DB: d1(db) };

// Arroyo del Sol, Pasadena.
const AT = { lat: 34.1478, lng: -118.1445 };
const near = (n, dLat, email, extra = {}) => ({
  id: `p_${n}`, name: n, category: 'Cafe', email,
  lat: AT.lat + dLat, lng: AT.lng, status: 'unclaimed', alive: null, address: `${n} St`, ...extra,
});

before(async () => {
  db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, category TEXT, email TEXT,
    address TEXT, area TEXT, dest TEXT, lat REAL, lng REAL, cell_lat INTEGER, cell_lng INTEGER,
    status TEXT, alive INTEGER)`);
  await ensure(env);
});

const put = (r) => db.prepare(
  `INSERT INTO places (id,name,category,email,address,area,lat,lng,cell_lat,cell_lng,status,alive)
   VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?)`,
).run(r.id, r.name, r.category, r.email, r.address, r.lat, r.lng,
  Math.floor(r.lat * 10), Math.floor(r.lng * 10), r.status, r.alive);

beforeEach(() => {
  db.exec('DELETE FROM places');
  db.exec('DELETE FROM num_neighbour_outreach');
  put({ ...near('Arroyo', 0, 'stay@arroyo.example'), id: 'p_anchor', status: 'claimed' });
});

describe('who gets the letter', () => {
  test('the ones nearby, nearest first, that we can actually write to', async () => {
    put(near('Corner Cafe', 0.002, 'hello@corner.example'));
    put(near('Far Diner', 0.5, 'hi@far.example'));
    const out = await neighboursOf(env, { placeId: 'p_anchor' });
    assert.equal(out.ok, true);
    assert.deepEqual(out.neighbours.map((n) => n.name), ['Corner Cafe'],
      'a business 55km away is not a neighbour');
    assert.equal(out.anchor.name, 'Arroyo');
  });

  test('a business already on NUM is not pitched NUM', async () => {
    put({ ...near('Already In', 0.002, 'hi@already.example'), status: 'claimed' });
    const out = await neighboursOf(env, { placeId: 'p_anchor' });
    assert.deepEqual(out.neighbours.map((n) => n.name), []);
  });

  test('a listing we know has closed is left alone', async () => {
    put({ ...near('Gone', 0.002, 'hi@gone.example'), alive: 0 });
    assert.deepEqual((await neighboursOf(env, { placeId: 'p_anchor' })).neighbours, []);
  });

  test('nobody is told twice', async () => {
    put(near('Corner Cafe', 0.002, 'hello@corner.example'));
    const first = await neighboursOf(env, { placeId: 'p_anchor' });
    await recordBatch(env, { anchorId: 'p_anchor', rows: first.neighbours });
    const second = await neighboursOf(env, { placeId: 'p_anchor' });
    assert.deepEqual(second.neighbours, [], 'the same shop got the same letter twice');
  });

  test('one letter per mailbox, however many branches share it', async () => {
    put(near('Chain A', 0.001, 'owner@chain.example'));
    put(near('Chain B', 0.002, 'OWNER@chain.example'));
    const out = await neighboursOf(env, { placeId: 'p_anchor' });
    assert.equal(out.neighbours.length, 1,
      'one owner read the same note about their own street twice');
  });
});

describe('who never gets it', () => {
  test('robot inboxes and platform addresses', async () => {
    // A "your neighbour joined" note in a booking aggregator's no-reply inbox
    // is wasted at best and a spam report against the sending domain at worst.
    for (const e of ['noreply@shop.example', 'do-not-reply@shop.example',
      'postmaster@shop.example', 'abuse@shop.example', 'x@booking.com', 'y@tripadvisor.co.uk']) {
      assert.equal(contactable(e), false, `${e} should never be written to`);
    }
    assert.equal(contactable('hello@corner.example'), true);
    assert.equal(contactable('not-an-email'), false);
  });

  test('a business with no email is simply not in the list', async () => {
    put(near('No Email', 0.002, null));
    put(near('Blank', 0.003, ''));
    assert.deepEqual((await neighboursOf(env, { placeId: 'p_anchor' })).neighbours, []);
  });

  test('NO PHONE NUMBER IS EVER RETURNED', async () => {
    // The whole reason this file is email-only. A field that exists is a field
    // somebody eventually sends to.
    put(near('Corner Cafe', 0.002, 'hello@corner.example'));
    const out = await neighboursOf(env, { placeId: 'p_anchor' });
    const keys = Object.keys(out.neighbours[0]);
    assert.ok(!keys.some((k) => /phone|tel|mobile|sms/i.test(k)),
      `a phone field appeared in the outreach list: ${keys.join(', ')}`);
    const src = readFileSync(join(HERE, 'bizneighbours.mjs'), 'utf8');
    assert.ok(!/SELECT[^;]*\bphone\b/i.test(src), 'phone is being selected out of places');
  });
});

describe('the anchor has to be real', () => {
  test('an unclaimed anchor is refused — there is nobody to name', async () => {
    put({ ...near('Not Signed Up', 0, 'x@y.example'), id: 'p_unclaimed' });
    const out = await neighboursOf(env, { placeId: 'p_unclaimed' });
    assert.equal(out.ok, false);
    assert.match(out.error, /has not claimed/);
  });

  test('a listing that does not exist is refused', async () => {
    assert.equal((await neighboursOf(env, { placeId: 'p_nope' })).ok, false);
    assert.equal((await neighboursOf(env, {})).ok, false);
  });
});

describe('the batch is small on purpose', () => {
  test('it will not hand back more than a person will read', async () => {
    for (let i = 0; i < MAX_BATCH + 20; i++) put(near(`Shop ${i}`, 0.0001 * (i + 1), `s${i}@x.example`));
    const out = await neighboursOf(env, { placeId: 'p_anchor', limit: 500 });
    assert.ok(out.neighbours.length <= MAX_BATCH,
      'a batch nobody checks is the failure this guards against');
  });

  test('the radius is a neighbourhood, not a city', () => {
    assert.ok(DEFAULT_KM <= 2);
  });
});

describe('the letter itself', () => {
  const mail = () => neighbourEmail({ anchorName: 'Arroyo del Sol', name: 'Corner Cafe', placeId: 'p_1' });

  test('it names the neighbour in the subject — that is the whole pitch', () => {
    assert.match(mail().subject, /Arroyo del Sol/);
  });

  test('it links them to their own listing, not to a marketing page', () => {
    // A business will click on itself before it clicks on us.
    assert.match(mail().body, /\/business\?q=Corner%20Cafe/);
  });

  test('it says how claiming proves control, because that is the objection', () => {
    assert.match(mail().body, /code to the number or address already published/);
  });

  test('it offers a way out in the first letter', () => {
    assert.match(mail().body, /ignore this and you will not hear from us again/);
  });

  test('it does not pitch a plan', () => {
    // OUR pricing, not the word "price": the letter says a claimed listing
    // gets the business's OWN prices read out, which is the benefit and has to
    // stay. An introduction that opens with what we charge is a sale, and
    // gets deleted.
    assert.ok(!/\$\d|our plans|upgrade|subscri|per month|\bfree trial\b/i.test(mail().body),
      'an introduction that opens with pricing is a sale, and gets deleted');
    assert.match(mail().body, /free and takes about a minute/,
      'claiming being free is the one commercial fact worth saying');
  });
});

describe('the route', () => {
  test('it is admin-gated and returns the letter with the list', () => {
    const c = readFileSync(join(HERE, 'console.mjs'), 'utf8');
    const block = c.slice(c.indexOf("path === '/admin/neighbours'"));
    assert.match(block.slice(0, 900), /neighboursOf/);
    assert.match(block.slice(0, 900), /sample: neighbourEmail/,
      'a reviewer would be approving a count without seeing the words');
    // Behind the isAdmin guard, like every other admin route on this router.
    assert.ok(c.indexOf('if (!(await isAdmin(env, request)))') < c.indexOf("path === '/admin/neighbours'"));
  });

  test('nothing in this module sends anything', () => {
    const src = readFileSync(join(HERE, 'bizneighbours.mjs'), 'utf8');
    assert.ok(!/sendEmail|sendMail|fetch\(|twilio/i.test(src),
      'this produces a batch for a person to read, never a send');
  });
});
