/**
 * A CRASH WE CAN READ.
 *
 * The bug behind this file is not in the code — it is in the loop. On 12 Sep
 * 2026 Dre hit a real render crash ("it said num stopped working" is the
 * boundary's own heading, read back) and the only trace it left was a gtag
 * event nobody can query. Every fix after that is a guess shipped to a phone
 * we do not hold.
 *
 * So these tests hold three promises: the report is stored, the same crash
 * looping does not flood the table, and nothing private rides along.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  record, recent, fingerprint, safePath, handleCrash, __resetReady, LIMITS,
} from './crashlog.mjs';

/** The same node:sqlite harness the rest of the worker tests use. */
function d1(db) {
  return {
    prepare(sql) {
      let bound = [];
      const api = {
        bind(...a) { bound = a; return api; },
        async run() { db.prepare(sql).run(...bound); return { success: true }; },
        async first() { const r = db.prepare(sql).get(...bound); return r ? { ...r } : null; },
        async all() { return { results: db.prepare(sql).all(...bound).map((r) => ({ ...r })) }; },
      };
      return api;
    },
  };
}

let env;
beforeEach(() => {
  __resetReady();
  env = { DB: d1(new DatabaseSync(':memory:')) };
});

const META = { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0)', ip: '1.2.3.4' };

describe('a crash is written down', () => {
  test('the message, the component and the path all land', async () => {
    const out = await record(env, {
      message: "Cannot read properties of undefined (reading 'name')",
      stack: 'TypeError: x\n    at Qr (index-abc.js:1:2)',
      component: '\n    at IdentityCard\n    at ProfileView',
      path: '/',
    }, META);
    assert.equal(out.ok, true);
    assert.equal(out.recorded, true);

    const [row] = await recent(env);
    assert.match(row.message, /Cannot read properties of undefined/);
    assert.match(row.component, /IdentityCard/);
    assert.equal(row.path, '/');
    assert.equal(row.times, 1);
    assert.match(row.ua, /iPhone/);
  });

  test('a report with no message is not a report', async () => {
    assert.deepEqual(await record(env, { stack: 'x' }, META), { ok: false, reason: 'no message' });
    assert.equal((await recent(env)).length, 0);
  });

  test('no database is a shrug, not a throw', async () => {
    assert.deepEqual(await record({}, { message: 'boom' }, META), { ok: false, reason: 'no database' });
  });
});

describe('a crash loop does not become a flood', () => {
  test('the same crash on the same phone counts up instead of piling up', async () => {
    const crash = { message: 'boom', stack: 'at A (x.js:1:1)', path: '/' };
    for (let i = 0; i < 5; i++) await record(env, crash, META);
    const rows = await recent(env);
    assert.equal(rows.length, 1, 'one row — a reload loop writes the same thing every second');
    assert.equal(rows[0].times, 5);
  });

  test('a different crash on the same phone is its own row', async () => {
    await record(env, { message: 'boom', stack: 'at A', path: '/' }, META);
    await record(env, { message: 'other', stack: 'at B', path: '/' }, META);
    assert.equal((await recent(env)).length, 2);
  });

  test('the same crash on a different phone is its own row — that is how you see spread', async () => {
    await record(env, { message: 'boom', stack: 'at A', path: '/' }, META);
    await record(env, { message: 'boom', stack: 'at A', path: '/' }, { ua: 'Android', ip: '9.9.9.9' });
    assert.equal((await recent(env)).length, 2);
  });

  test('the fingerprint ignores frames past the first', () => {
    const a = fingerprint({ message: 'boom', stack: 'at A (i.js:1:2)\nat B' });
    const b = fingerprint({ message: 'boom', stack: 'at A (i.js:1:2)\nat C\nat D' });
    assert.equal(a, b, 'minified stacks differ below the top frame between reloads of one build');
  });
});

describe('what never leaves the phone', () => {
  test('the query string is dropped — a connect code lives there', () => {
    assert.equal(safePath('/?c=ABCD2345&ref=DRE'), '/');
    assert.equal(safePath('/plan?p=mem_9f2a&a=5000'), '/plan');
    assert.equal(safePath('/x#frag'), '/x');
  });

  test('a stored row carries no member id, name or number', async () => {
    await record(env, {
      message: 'boom', stack: 'at A', path: '/?c=ABCD2345&p=mem_9f2a1b',
    }, META);
    const row = (await recent(env))[0];
    const all = JSON.stringify(row);
    assert.ok(!all.includes('ABCD2345'), 'a connect code is somebody\'s business');
    assert.ok(!all.includes('mem_9f2a1b'));
  });

  test('the device handle is a hash, never the address', async () => {
    await record(env, { message: 'boom', path: '/' }, META);
    const { results } = await env.DB.prepare('SELECT device_hash FROM num_app_crashes').all();
    assert.match(results[0].device_hash, /^[0-9a-f]{16}$/);
    assert.ok(!results[0].device_hash.includes('1.2.3.4'));
  });

  test('an enormous stack is clipped rather than stored whole', async () => {
    await record(env, { message: 'boom', stack: 'y'.repeat(9000), path: '/' }, META);
    const { results } = await env.DB.prepare('SELECT stack FROM num_app_crashes').all();
    assert.ok(results[0].stack.length <= LIMITS.stack);
  });
});

describe('the route the boundary calls', () => {
  const post = (body) => new Request('https://app.itsnum.com/api/crash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'iPhone' },
    body: JSON.stringify(body),
  });

  test('it answers 200 and records', async () => {
    const res = await handleCrash(post({ message: 'boom', path: '/' }), env);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.equal((await recent(env)).length, 1);
  });

  test('a malformed body is still a 200 — the caller is an error handler', async () => {
    const res = await handleCrash(
      new Request('https://app.itsnum.com/api/crash', { method: 'POST', body: 'not json' }), env,
    );
    assert.equal(res.status, 200);
  });

  test('a database that is down is still a 200', async () => {
    const res = await handleCrash(post({ message: 'boom' }), {});
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });
});

describe('the wiring, end to end', () => {
  const WORKER = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  const BOUNDARY = readFileSync(new URL('../src/components/app/Boundary.tsx', import.meta.url), 'utf8');
  const APIBASE = readFileSync(new URL('../src/lib/apibase.ts', import.meta.url), 'utf8');

  test('the worker answers POST /api/crash', () => {
    assert.match(WORKER, /url\.pathname === '\/api\/crash' && request\.method === 'POST'/);
  });

  test('reading crashes back is admin-only', () => {
    const i = WORKER.indexOf("url.pathname === '/api/crash/recent'");
    assert.ok(i > 0);
    assert.match(WORKER.slice(i, i + 400), /ADMIN_KEY/);
  });

  test('the boundary actually posts — a report nobody sends is the old bug', () => {
    assert.match(BOUNDARY, /fetch\(CRASH_ENDPOINT/);
    assert.match(BOUNDARY, /keepalive: true/, 'the person reloads immediately after');
  });

  test('the boundary sends the component stack, which is the whole point', () => {
    assert.match(BOUNDARY, /component: String\(info\?\.componentStack/);
  });

  test('the boundary sends a path with no query on it', () => {
    assert.match(BOUNDARY, /path: String\(location\.pathname/);
    assert.ok(!/location\.search/.test(BOUNDARY));
  });

  test('the endpoint literal matches the origin the rest of the app uses', () => {
    const b = /const CRASH_ENDPOINT = '([^']+)'/.exec(BOUNDARY);
    const a = /'(https:\/\/app\.itsnum\.com)'/.exec(APIBASE);
    assert.ok(b && a, 'both constants must exist');
    assert.equal(b[1], `${a[1]}/api/crash`);
  });

  test('the boundary still imports nothing from the app — rule 2', () => {
    const imports = [...BOUNDARY.matchAll(/^import .*? from '([^']+)'/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ['react', 'react'],
      'anything imported here is code that can throw here');
  });
});
