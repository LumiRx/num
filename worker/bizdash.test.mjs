import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { travellerDemand, payQr, verification, dashboardData, DASHBOARD_VERSION } from './bizdash.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, p), 'utf8');

const DB = (handlers) => ({
  prepare(q) {
    const h = Object.entries(handlers).find(([re]) => new RegExp(re).test(q));
    const run = async (a) => (h ? h[1](a, q) : null);
    return {
      bind: (...a) => ({ all: async () => (await run(a)) ?? { results: [] }, first: async () => (await run(a)) ?? null, run: async () => ({}) }),
      all: async () => (await run([])) ?? { results: [] },
      first: async () => (await run([])) ?? null,
      run: async () => ({}),
    };
  },
});

test('the dashboard carries a version somebody can quote back at us', () => {
  assert.match(DASHBOARD_VERSION, /^\d+\.\d+\.\d+$/);
  // And it has to reach the page, or it answers nothing.
  assert.match(src('bizconsole.mjs'), /Dashboard v\$\{H\(extra\.version/,
    'the version is computed but never shown to the business');
});

test('demand is real questions, never an invented number', async () => {
  const env = { DB: DB({ 'FROM num_asks': () => ({ results: [{ text: 'where should we eat tonight', n: 12 }] }) }) };
  const out = await travellerDemand(env, { dest: 'phuket' });
  assert.equal(out.available, true);
  assert.deepEqual(out.asks, [{ text: 'where should we eat tonight', n: 12 }]);
});

test('no demand says so in words, and never shows a zero that looks measured', async () => {
  const env = { DB: DB({ 'FROM num_asks': () => ({ results: [] }) }) };
  const out = await travellerDemand(env, { dest: 'kata', days: 30 });
  assert.equal(out.available, false);
  assert.match(out.reason, /No traveller asked/);
  assert.equal(out.asks, undefined, 'an empty list would render as a table of nothing');
  // A listing with no destination must not silently show another town's data.
  assert.equal((await travellerDemand(env, {})).available, false);
});

test('a database failure is an absent figure, never a wrong one', async () => {
  const env = { DB: { prepare() { throw new Error('down'); } } };
  const out = await travellerDemand(env, { dest: 'phuket' });
  assert.equal(out.available, false);
  assert.match(out.reason, /could not be read/);
});

test('the pay QR reports state and never promises a rail that is off', async () => {
  // num_paylinks has no rows in production. The dashboard must say "not set
  // up", not show a merchant a payment surface that cannot take money.
  //
  // Keyed on business_id, not place_id: the table has no place_id column, and
  // the statement that named one threw on every call for weeks. See the note
  // on payQr and worker/bizqrcode.test.mjs.
  const empty = { DB: DB({ 'FROM num_paylinks': () => null }) };
  const out = await payQr(empty, { businessId: 'biz1' });
  assert.equal(out.ready, false);
  assert.match(out.reason, /No pay code yet/);
  assert.doesNotMatch(out.reason, /\d+\s?%|fee/i, 'the setup copy quotes a commercial figure');

  const live = { DB: DB({ 'FROM num_paylinks': () => ({ token: 'pl_1', label: 'Counter', created_at: '2026-08-01' }) }) };
  const ok = await payQr(live, { businessId: 'biz1' });
  assert.equal(ok.ready, true);
  assert.equal(ok.token, 'pl_1');

  // No business, nothing to answer about.
  assert.equal((await payQr(live, {})).ready, false);
});

test('the verified badge is absent until something proved it', async () => {
  const none = { DB: DB({ 'num_business_verification': () => null }) };
  assert.equal((await verification(none, 'p1')).verified, false);
  const yes = { DB: DB({ 'num_business_verification': () => ({ method: 'website file', created_at: '2026-08-30' }) }) };
  const v = await verification(yes, 'p1');
  assert.equal(v.verified, true);
  assert.equal(v.method, 'website file');
});

test('owner view and admin preview are built from ONE function', async () => {
  // A preview that assembles its own numbers is a preview of a screen nobody
  // has. Both callers must go through dashboardData.
  assert.match(src('bizconsole.mjs'), /dashboardData\(env, \{/, 'the owner dashboard no longer uses dashboardData');
  assert.match(src('index.mjs'), /dashboardData\(env, \{/, 'the admin preview no longer uses dashboardData');
  assert.match(src('index.mjs'), /insightsForAdmin/,
    'the admin preview computes impressions its own way — it will disagree with the owner page');

  const env = { DB: DB({ 'FROM num_asks': () => ({ results: [] }), 'FROM num_paylinks': () => null, 'num_business_verification': () => null }) };
  const data = await dashboardData(env, { place: { place_id: 'p1', dest: 'phuket' }, plan: { analytics_days: 7 }, insights: null, bookings: [] });
  for (const k of ['version', 'released', 'place', 'plan', 'insights', 'bookings', 'demand', 'pay_qr', 'verification']) {
    assert.ok(k in data, `dashboardData dropped ${k}`);
  }
});

test('the admin preview is read-only and admin-gated', () => {
  const idx = src('index.mjs');
  const start = idx.indexOf("'/api/admin/biz-view'");
  const block = idx.slice(start, start + 2600);
  assert.match(block, /X-Admin-Key/, 'the see-what-they-see view is not admin-gated');
  assert.doesNotMatch(block, /INSERT|UPDATE|DELETE/, 'the preview writes to the database — it must only read');
});
