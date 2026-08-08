// The console that cannot not work.
//
// Five rebuilds of the static gate each fixed a real bug and each uncovered
// the next, because every one of them lived in the browser layer — service
// workers, cached shells, refused cookies, racing scripts. This console has
// none of those parts: /api/* bypasses the service worker and asset cache by
// construction, and the dashboard arrives IN the login response. One POST,
// one page. These tests drive the real handler end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleConsole } from './console.mjs';

const stmt = { bind: () => stmt, run: async () => ({}), all: async () => ({ results: [] }), first: async () => ({ n: 0 }) };
const env = { ADMIN_KEY: 'k123', ADMIN_EMAIL: 'a@b.c', DB: { prepare: () => stmt, batch: async () => [] } };
const post = (key) => new Request('http://x/api/admin/console', { method: 'POST', body: new URLSearchParams({ key }) });

test('the right key returns the dashboard in the same response', async () => {
  // No redirect, no cookie, no second fetch — nothing left between the
  // password and the numbers.
  const r = await handleConsole(post('k123'), env, '/admin/console');
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.ok(html.includes('Recent payments'), 'the login response does not contain the dashboard — a second round trip is back');
  assert.ok(!r.headers.get('Location'), 'the login redirects again — the class of failure this rebuild removes');
});

test('the wrong key says Wrong password, in the page itself', async () => {
  const html = await (await handleConsole(post('nope'), env, '/admin/console')).text();
  assert.ok(html.includes('Wrong password.'), 'a wrong key fails without saying so — silence again');
  assert.ok(!html.includes('Recent payments'), 'a wrong key rendered the dashboard');
});

test('the session token in the links keeps working as a GET', async () => {
  const html = await (await handleConsole(post('k123'), env, '/admin/console')).text();
  const s = /s=([^&"]+)/.exec(html)?.[1];
  assert.ok(s, 'the rendered page carries no session — refresh and range links are dead');
  const again = await (await handleConsole(new Request(`http://x/api/admin/console?s=${s}&days=7`), env, '/admin/console')).text();
  assert.ok(again.includes('last 7 days'), 'the token GET does not render — every refresh demands the password again');
});

test('no session, no numbers', async () => {
  const html = await (await handleConsole(new Request('http://x/api/admin/console?s=garbage.token'), env, '/admin/console')).text();
  assert.ok(!html.includes('Recent payments'), 'a garbage token rendered the dashboard — the console is public');
});

test('hostile data renders as text, never as markup', async () => {
  const evil = { ...stmt, all: async () => ({ results: [{ name: '<script>alert(1)</script>', ref: '"><img onerror=x>', state: 'paid', created_at: 'now' }] }) };
  const r = await handleConsole(post('k123'), { ...env, DB: { prepare: () => evil, batch: async () => [] } }, '/admin/console');
  const html = await r.text();
  assert.ok(!html.includes('<script>alert'), 'a member name executes in the admin console — stored XSS against the operator');
  assert.ok(!html.includes('<img onerror'), 'a payment ref injects markup into the console');
});

test('the page never caches and never gets indexed', async () => {
  const r = await handleConsole(post('k123'), env, '/admin/console');
  assert.equal(r.headers.get('Cache-Control'), 'no-store', 'a cached copy of the admin console could outlive the session');
  assert.match(await (await handleConsole(new Request('http://x/api/admin/console'), env, '/admin/console')).text(), /noindex/);
});
