// The settlement feed, through the REAL router.
//
// `/api/partner/reconcile` sits beside `/api/partner`, `/api/partner/mcp`,
// `/api/partner/signup` and `/api/partner/usage`. This repo has already lost a
// whole feature to exactly that shape once: '/api/booking/status'.startsWith
// ('/api/book') is true, so every Sabre request reached the booking desk as
// the path 'ing/status' and came back {"error":"not found"} for days
// (worker/bookdesk.wiring.test.mjs tells the story).
//
// A unit test of handleReconcile() cannot see that class of bug — the handler
// is perfect and unreachable. So this drives real Requests at real paths
// through the real Worker and asserts on real response bodies.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from './index.mjs';
import { mintHandoff, _resetForTests } from './handoff.mjs';

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
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
    },
  });
  return {
    prepare(sql) { const b = (a) => ({ bind: (...m) => b([...a, ...m]), ...shape(sql, a) }); return b([]); },
    batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
  };
}

const db = new DatabaseSync(':memory:');
const env = { DB: d1(db), ADMIN_KEY: 'test-admin-key', NUM_APP_ORIGIN: 'https://app.itsnum.com' };
const ctx = { waitUntil() {}, passThroughOnException() {} };

const KEY = 'letsgo2trip_' + 'a'.repeat(32);
let ref;

before(async () => {
  _resetForTests();
  // sha256 of the key, computed the same way partnersignup.mjs does.
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(KEY));
  const hash = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  db.exec(`CREATE TABLE IF NOT EXISTS num_partner_keys (id TEXT PRIMARY KEY, company TEXT NOT NULL,
    email TEXT NOT NULL, use_case TEXT, key_hash TEXT NOT NULL, tier TEXT DEFAULT 'partner',
    monthly_limit INTEGER DEFAULT 250000, state TEXT DEFAULT 'active', created_at TEXT)`);
  db.prepare(`INSERT INTO num_partner_keys (id, company, email, key_hash, tier, monthly_limit, state)
              VALUES ('letsgo2trip','LetsGo2Trip','ops@letsgo2trip.com',?,'partner',250000,'active')`).run(hash);
  ({ ref } = await mintHandoff(env, {
    partnerId: 'letsgo2trip', memberId: 'mem_1', product: 'flight', dest: 'phuket',
  }));
});

// index.mjs runs a per-IP limiter in front of every POST /api/*; a suite that
// fires several requests from one address is throttled by it, which is the
// limiter working and not the route failing. Each request is a different caller.
let n = 0;
const hit = (path, init) =>
  worker.fetch(
    new Request(`https://app.itsnum.com${path}`, {
      ...init,
      headers: {
        'CF-Connecting-IP': `203.0.113.${(n++ % 250) + 1}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    }),
    env, ctx,
  );

const post = (body, key = KEY) =>
  hit('/api/partner/reconcile', { method: 'POST', body: JSON.stringify(body), headers: { 'X-Partner-Key': key } });

describe('POST /api/partner/reconcile', () => {
  test('the route is reachable and is not shadowed by a sibling', async () => {
    const res = await post({ rows: [] });
    assert.equal(res.status, 200);
    const body = await res.json();
    // A JSON-RPC error here would mean the MCP handler answered instead.
    assert.equal(body.jsonrpc, undefined, 'the MCP route swallowed this path');
    assert.equal(body.partner_id, 'letsgo2trip');
    assert.deepEqual(body.deductions_agreed, ['tax_cs', 'surcharge_cs', 'gds_cs', 'gateway_cs']);
  });

  test('no key is 401, a wrong key is 401', async () => {
    assert.equal((await hit('/api/partner/reconcile', { method: 'POST', body: '{"rows":[]}' })).status, 401);
    assert.equal((await post({ rows: [] }, 'nope_' + 'b'.repeat(32))).status, 401);
  });

  test('a real settlement lands and comes back per row', async () => {
    const res = await post({
      rows: [{
        num_ref: ref, partner_ref: 'LG2T-1', status: 'confirmed', currency: 'THB',
        gross_cs: 100_000,
        deductions: { tax_cs: 30_000, surcharge_cs: 8_000, gds_cs: 1_500, gateway_cs: 2_500 },
        net_cs: 58_000, commission_cs: 4_060,
      }],
    });
    const body = await res.json();
    assert.equal(body.accepted, 1);
    assert.equal(body.rejected, 0);
    assert.equal(body.disputed, 0);
    assert.equal(body.results[0].arithmetic_ok, true);
  });

  test('one bad row does not reject the good ones', async () => {
    // A partner who must re-send the whole day to fix one row stops sending.
    const a = await mintHandoff(env, { partnerId: 'letsgo2trip', product: 'hotel' });
    const b = await mintHandoff(env, { partnerId: 'letsgo2trip', product: 'hotel' });
    const body = await (await post({
      rows: [
        { num_ref: a.ref, status: 'confirmed', gross_cs: 100, net_cs: 100, commission_cs: 10 },
        { num_ref: 'garbage', status: 'confirmed' },
        { num_ref: b.ref, status: 'confirmed', gross_cs: 200, net_cs: 200, commission_cs: 20 },
      ],
    })).json();
    assert.equal(body.received, 3);
    assert.equal(body.accepted, 2);
    assert.equal(body.rejected, 1);
    assert.equal(body.results[1].reason, 'malformed');
  });

  test('an oversized file is refused with a number, not a timeout', async () => {
    const res = await post({ rows: new Array(1001).fill({ num_ref: 'x.y', status: 'confirmed' }) });
    assert.equal(res.status, 413);
    assert.match((await res.json()).error, /1000 rows/);
  });

  test('a malformed body is a 400 that says what to send', async () => {
    assert.equal((await post({ nope: true })).status, 400);
  });
});

describe('GET /api/partner/reconcile', () => {
  test('returns what NUM holds, so both sides compare one list', async () => {
    const res = await hit('/api/partner/reconcile?since=0', { headers: { 'X-Partner-Key': KEY } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.partner, 'LetsGo2Trip');
    assert.ok(body.rows.length > 0);
    assert.ok(body.totals.confirmed >= 1);
    assert.ok(body.totals.commission_cs >= 4060);
    assert.equal(typeof body.totals.disputed, 'number');
  });

  test('the preflight allows the header the feed authenticates with', async () => {
    // A browser dashboard sends X-Partner-Key, so the preflight has to permit
    // it. Server-to-server callers never preflight, which is exactly why an
    // omission here stays invisible: the nightly job works and the console
    // fails at OPTIONS with nothing in the network tab to explain it.
    const res = await hit('/api/partner/reconcile', { method: 'OPTIONS' });
    assert.ok(res.status === 200 || res.status === 204, `preflight returned ${res.status}`);
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /X-Partner-Key/i);
  });
});

describe('the neighbours still work', () => {
  test('/api/partner still serves the index, not the feed', async () => {
    const body = await (await hit('/api/partner')).json();
    assert.equal(body.partner_id, undefined);
    assert.ok(JSON.stringify(body).length > 50);
  });

  test('/api/partner/mcp still speaks JSON-RPC', async () => {
    const body = await (await hit('/api/partner/mcp', {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })).json();
    assert.equal(body.jsonrpc, '2.0');
    assert.ok(Array.isArray(body.result?.tools));
  });
});
