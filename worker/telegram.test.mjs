/**
 * The alert channel that has to work when Num does not.
 *
 * The property that matters most here is the dullest one: an unconfigured or
 * failed send must NEVER report success. health.alert() decides whether any
 * channel carried an alert, and records a critical `alert_undelivered` when
 * none did. A channel that lies about delivery erases that protection and
 * recreates the exact 30 Aug 2026 blind spot where trying and succeeding
 * were indistinguishable.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { notify, configured } from './telegram.mjs';

const WIRED = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '4242' };
let calls; let realFetch;

beforeEach(() => { calls = []; realFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; });

const stub = (impl) => { globalThis.fetch = async (url, init) => { calls.push({ url, init }); return impl(); }; };
const okResponse = () => ({ ok: true, status: 200, text: async () => '{"ok":true}' });

describe('configuration', () => {
  test('both secrets are required', () => {
    assert.equal(configured(WIRED), true);
    assert.equal(configured({ TELEGRAM_BOT_TOKEN: '123:abc' }), false);
    assert.equal(configured({ TELEGRAM_CHAT_ID: '4242' }), false);
    assert.equal(configured({}), false);
    assert.equal(configured(undefined), false);
  });

  test('unconfigured is skipped, and skipped is NOT delivered', async () => {
    stub(okResponse);
    const r = await notify({}, 'sign-in is down');
    assert.equal(r.ok, false, 'must never count as a delivery');
    assert.equal(r.skipped, true, 'but must not raise a false alarm about the alerter');
    assert.equal(calls.length, 0, 'and must not call out at all');
  });

  test('an empty message is skipped rather than sent', async () => {
    stub(okResponse);
    const r = await notify(WIRED, '   ');
    assert.equal(r.skipped, true);
    assert.equal(calls.length, 0);
  });
});

describe('sending', () => {
  test('posts the text to the configured chat', async () => {
    stub(okResponse);
    const r = await notify(WIRED, '[SIGN-IN DOWN] no code has sent in 20 min');
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /api\.telegram\.org\/bot123:abc\/sendMessage/);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.chat_id, '4242');
    assert.match(body.text, /SIGN-IN DOWN/);
    assert.equal(body.disable_web_page_preview, true, 'a link card must not push the alert out of the notification preview');
  });

  test('an HTTP error is reported, never swallowed', async () => {
    stub(() => ({ ok: false, status: 400, text: async () => '{"description":"chat not found"}' }));
    const r = await notify(WIRED, 'hello');
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.match(r.error, /chat not found/, 'the real setup mistake must reach the logs');
  });

  test('a network failure resolves false instead of throwing', async () => {
    globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
    const r = await notify(WIRED, 'hello');
    assert.equal(r.ok, false);
    assert.match(r.error, /ENOTFOUND/);
  });

  test('a hang is abandoned rather than held open during an incident', async () => {
    globalThis.fetch = async (_u, init) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
    });
    const r = await notify(WIRED, 'hello', { timeoutMs: 20 });
    assert.equal(r.ok, false);
    assert.match(r.error, /timed out/);
  });

  test('over-long text is trimmed to what Telegram will accept', async () => {
    stub(okResponse);
    await notify(WIRED, 'x'.repeat(9000));
    assert.ok(JSON.parse(calls[0].init.body).text.length <= 4096);
  });
});
