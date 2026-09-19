// Telling a guest their connection is broken when ours is, is a lie that
// costs them money — roaming data, a hotel wifi pass, an hour of their
// evening. Every one of these is a case that used to produce "looks like
// we've dropped the line".
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify, SAY, BANNER, browserOffline, confirmDown } from './outage.ts';

const res = (status) => ({ status, ok: status >= 200 && status < 300 });
const ON = { onLine: true };
const OFF = { onLine: false };

describe('whose fault it is', () => {
  test('our 500 is ours, even on a perfect connection', () => {
    assert.equal(classify(res(500), new Error('Unexpected token'), ON), 'down');
    assert.equal(classify(res(502), null, ON), 'down');
    assert.equal(classify(res(503), null, ON), 'down');
  });

  test('a 500 is still ours even when the phone is also offline', () => {
    // The response ARRIVED. Whatever the browser thinks of the network now,
    // our server answered and what it answered was a failure.
    assert.equal(classify(res(500), null, OFF), 'down');
  });

  test('numreply throwing "backend 500" is ours too — no Response survives that path', () => {
    assert.equal(classify(null, new Error('backend 500'), ON), 'down');
  });

  test('a stream that stops mid-answer is ours', () => {
    assert.equal(classify(null, new Error('backend stream ended without an answer'), ON), 'down');
  });

  test('429 is ours, and says so without pretending to be an outage', () => {
    assert.equal(classify(res(429), null, ON), 'busy');
    assert.doesNotMatch(SAY.busy, /down|outage|broken/i);
  });

  test('a rejected fetch on a phone that knows it is offline is theirs', () => {
    assert.equal(classify(null, new TypeError('Failed to fetch'), OFF), 'offline');
  });

  test('a rejected fetch on a phone that thinks it is online is UNKNOWN, and admits it', () => {
    // navigator.onLine is true on unpaid hotel wifi, behind a captive portal,
    // and in a tunnel. Claiming either side here would be a guess.
    assert.equal(classify(null, new TypeError('Failed to fetch'), ON), 'unreachable');
    assert.match(SAY.unreachable, /cannot tell|could be/i);
  });

  test('browserOffline only answers when the browser is certain', () => {
    assert.equal(browserOffline(OFF), true);
    assert.equal(browserOffline(ON), false);
    assert.equal(browserOffline(undefined), false, 'no navigator (SSR, old webview) is not evidence of offline');
    assert.equal(browserOffline({}), false, 'a navigator without onLine is not evidence either');
  });
});

describe('what it says', () => {
  test('nothing blames the guest for a fault that is ours', () => {
    // The rule is about ATTRIBUTION, not about the word "connection" —
    // `down` mentions their connection precisely in order to clear it.
    for (const k of ['down', 'busy']) {
      assert.doesNotMatch(SAY[k], /check your|dropped the line|try (?:another|a different) (?:network|connection)/i,
        `${k}: must not send the guest hunting for wifi over a fault of ours`);
    }
    // And `down` says whose it is in so many words, because a guest who is
    // not told will go looking for wifi.
    assert.match(SAY.down, /on us|our end/i);
    assert.match(SAY.down, /nothing is wrong with your connection/i);
  });

  test('every message ends with what happens next', () => {
    for (const [k, s] of Object.entries(SAY)) {
      assert.match(s, /send it again|back/i, `${k}: an apology with no next step is not a message`);
    }
  });

  test('a banner is offered only when we KNOW it is ours', () => {
    assert.ok(BANNER.down && BANNER.busy);
    assert.equal(BANNER.offline, undefined, 'the phone already shows its own offline state');
    assert.equal(BANNER.unreachable, undefined, 'a banner asserting an outage we cannot prove is the same lie');
  });

  test('the old one-size message is gone from the ask path', () => {
    const src = readFileSync(new URL('./concierge.ts', import.meta.url), 'utf8');
    // Comments are stripped first: the replacement comment QUOTES the old
    // sentence to explain why it went, and a test that cannot tell a quote
    // from a shipped string would forbid explaining the fix.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.doesNotMatch(code, /dropped the line/,
      'the catch-all that blamed the guest for our 500s is back');
    assert.match(code, /from '\.\/outage'/, 'the ask path must classify rather than guess');
    assert.match(code, /classify\(failedRes, err\)/,
      'the catch must see the Response — a 500 resolves, so without it only the thrown error is left to guess from');
  });
});

describe('asking our own health endpoint', () => {
  test('a healthy 200 means we are up, so it was not us', async () => {
    assert.equal(await confirmDown((p) => p, async () => ({ ok: true })), false);
  });

  test('a 503 confirms it', async () => {
    assert.equal(await confirmDown((p) => p, async () => ({ ok: false })), true);
  });

  test('health being unreachable confirms rather than throws', async () => {
    assert.equal(await confirmDown((p) => p, async () => { throw new Error('nope'); }), true);
  });

  test('it asks the real endpoint, and never from cache', async () => {
    let seen = null, opts = null;
    await confirmDown((p) => `https://x${p}`, async (u, o) => { seen = u; opts = o; return { ok: true }; });
    assert.equal(seen, 'https://x/api/health');
    assert.equal(opts.cache, 'no-store', 'a cached 200 would hide a live outage');
  });
});

describe('the thrown error never reaches the guest', () => {
  // lib/saferr.ts exists because `err.message` used to be rendered straight
  // into the thread. classify() reads it — to MATCH, then discard — so the
  // guarantee cannot be "the linter did not spot it". It has to be shown.
  test('no message interpolates anything', () => {
    for (const [k, s] of Object.entries(SAY)) {
      assert.doesNotMatch(s, /\$\{|\+ *err|\.message/, `${k}: a template hole is a leak waiting to happen`);
    }
  });

  test('a hostile error message changes the classification, never the words', () => {
    const nasty = new Error('Failed to fetch sk-ant-api03-SECRET at https://internal.num/api HTTP 500');
    const kind = classify(null, nasty, { onLine: true });
    const shown = SAY[kind];
    for (const leak of ['sk-ant', 'internal.num', 'HTTP 500', 'Failed to fetch']) {
      assert.equal(shown.includes(leak), false, `"${leak}" reached the guest`);
    }
  });

  test('every classification maps to one of the four written sentences', () => {
    const all = new Set(Object.values(SAY));
    for (const e of [new Error('backend 500'), new Error('boom'), new TypeError('Failed to fetch'), 'a string', null, undefined]) {
      assert.ok(all.has(SAY[classify(null, e, { onLine: true })]), 'a classification with no sentence behind it');
    }
  });
});
