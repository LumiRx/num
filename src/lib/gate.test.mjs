// Who may send a message, and what happens to the words of somebody who may
// not yet.
//
// 18 Sep 2026, in Dre's words: "make sure that you can't use the chat without
// signing in and verifying your number, we are getting a ton of users and
// they're just closing the sign-in box", then: "they can go through the app
// but they have to verify their number or email to send a message".
//
// So: browsing stays open, sending needs a proved channel. The tests that
// matter most here are the two that could cost us something real — the App
// Review reviewer, who is deliberately NOT marked verified, and the guest's
// own sentence, which must not vanish into a sheet.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('.') && !/\.[mc]?[jt]sx?$/.test(spec)) {
      const base = ctx.parentURL ? dirname(fileURLToPath(ctx.parentURL)) : process.cwd();
      for (const ext of ['.ts', '.tsx', '.mjs', '.js']) {
        const p = resolvePath(base, spec + ext);
        if (existsSync(p)) return next(pathToFileURL(p).href, ctx);
      }
    }
    return next(spec, ctx);
  },
});

globalThis.window = globalThis;
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };
globalThis.location = { search: '', pathname: '/', href: 'https://app.itsnum.com/', protocol: 'https:', hostname: 'app.itsnum.com', origin: 'https://app.itsnum.com' };
globalThis.history = { replaceState() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.document = { addEventListener() {}, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), body: { appendChild() {}, dataset: {} }, documentElement: { style: { setProperty() {} } } };
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', onLine: true }, configurable: true }); } catch { /* fine */ }

let canSend, mayAsk, holdAndAsk, takeHeldAsk, store;
before(async () => {
  ({ canSend, mayAsk, holdAndAsk, takeHeldAsk } = await import('./gate.ts'));
  ({ store } = await import('./store.ts'));
});
beforeEach(() => store.set({ me: null, pendingAsk: null, inviteOpen: null }));

const member = (over = {}) => ({ id: 'm1', name: 'Dre', phone: null, phone_verified: false, ...over });

describe('who may send', () => {
  test('a visitor with no account may not', () => {
    assert.equal(canSend(null), false);
    assert.equal(canSend(undefined), false);
  });

  test('an account with nothing proved may not — an unanswerable answer is not work', () => {
    assert.equal(canSend(member()), false);
    assert.equal(canSend(member({ phone: '+15555551234' })), false, 'a number typed in is not a number proved');
  });

  test('a proved number may, and so may a proved address', () => {
    assert.equal(canSend(member({ phone_verified: true })), true);
    assert.equal(canSend(member({ email: 'a@b.com', email_verified: true })), true);
  });

  test('THE APP REVIEW REVIEWER MAY', () => {
    // worker/social.mjs hands the reviewer a member id and deliberately does
    // NOT set phone_verified, because no SMS was ever sent and the flag would
    // be a lie in our own database. A gate that read only that flag would
    // hand Apple an app whose concierge refuses every message — a rejection
    // earned by our own honesty. If this test ever goes red, the app is
    // unusable for the one person who decides whether it ships.
    assert.equal(canSend(member({ review_access: true })), true);
  });

  test('nothing else counts — not a name, not a plan, not being signed in', () => {
    assert.equal(canSend(member({ name_locked: true, avatar: 'data:,' })), false);
  });
});

describe('the words of somebody not yet reachable', () => {
  test('the question is held, the sheet opens, the thread is shown', () => {
    holdAndAsk('table for four at 8');
    const s = store.get();
    assert.equal(s.pendingAsk, 'table for four at 8');
    assert.deepEqual(s.inviteOpen, {});
    assert.equal(s.threadOpen, true);
  });

  test('it comes back exactly once', () => {
    holdAndAsk('a driver to the airport');
    assert.equal(takeHeldAsk(), 'a driver to the airport');
    assert.equal(takeHeldAsk(), null, 'a held ask must not fire twice');
  });

  test('an empty hold — the mic, tapped by a visitor — opens the door and holds nothing', () => {
    holdAndAsk('   ');
    assert.equal(store.get().pendingAsk, null);
    assert.deepEqual(store.get().inviteOpen, {});
  });

  test('it is not persisted: a question from Tuesday must not fire itself off on Friday', async () => {
    const { persistable } = await import('./data.ts');
    store.set({ pendingAsk: 'still here?' });
    assert.equal('pendingAsk' in persistable(store.get()), false);
  });
});

describe('the gate is on the one door, not on some of six', () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

  test('askNum refuses before it echoes, so nothing reaches the thread or the server', () => {
    const c = src('./concierge.ts');
    const fn = c.slice(c.indexOf('export async function askNum'));
    const gate = fn.indexOf('if (!mayAsk())');
    assert.ok(gate > 0, 'askNum must carry the gate');
    assert.ok(gate < fn.indexOf('observeUserMessage(text)'), 'the gate must come before the echo');
    assert.ok(gate < fn.indexOf("fetch(apiUrl('/api/num')"), 'the gate must come before the request');
  });

  test('the microphone is gated before the permission prompt, not after the transcription', () => {
    const c = src('./concierge.ts');
    const fn = c.slice(c.indexOf('export async function openVoice'), c.indexOf('export function closeVoice'));
    assert.ok(fn.indexOf('mayAsk()') < fn.indexOf('getUserMedia'), 'ask before taking the microphone');
  });

  test('the composer keeps the guest’s sentence in the box rather than into a sheet', () => {
    const t = src('../components/app/ThreadView.tsx');
    const send = t.slice(t.indexOf('const send = () => {'), t.indexOf('return (', t.indexOf('const send = () => {')));
    const gate = send.indexOf('canSend(store.get().me)');
    assert.ok(gate > 0, 'the composer must check before clearing');
    assert.ok(gate < send.indexOf("setDraft('')"), 'the draft must survive the gate');
  });

  test('and it says so above the box, before anyone presses send', () => {
    assert.match(src('../components/app/ThreadView.tsx'), /!canSend\(me\) && \(/);
  });

  test('the held question fires from ANY door, as a subscription, not a call site', () => {
    // Sign in with Apple, a recovered account and the review grant never
    // reach verifyCode(); the first version fired the held ask only there,
    // and Dre watched the sheet close on nothing.
    const g = src('./gate.ts');
    assert.match(g, /store\.subscribe\(\(\) => \{/);
    assert.match(g, /if \(now && !wasSendable\)/);
    assert.match(g, /const held = takeHeldAsk\(\);/);
    assert.doesNotMatch(src('./social.ts'), /takeHeldAsk/, 'social.ts must not keep its own copy of the rule');
    assert.match(src('./social.ts'), /if \(out\.review_access\) store\.set/);
  });

  test('a server refusal holds the question too, and takes the echo back', () => {
    const c = src('./concierge.ts');
    const at = c.indexOf("why?.error === 'verify_to_send'");
    const block = c.slice(at, at + 900);
    assert.match(block, /pendingAsk: text/);
    assert.match(block, /s2\.msgs\.slice\(0, -1\)/, 'the echoed question must not appear twice when it is re-sent');
  });

  test('becoming sendable sends the held question', async () => {
    // The subscription end to end: hold with no member, then a member with a
    // proved phone arrives. The ask must leave `pendingAsk` at once; the
    // actual send is concierge.askNum, imported late.
    store.set({ me: null, pendingAsk: null });
    holdAndAsk('a table for six');
    assert.equal(store.get().pendingAsk, 'a table for six');
    store.set({ me: member({ phone_verified: true }) });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(store.get().pendingAsk, null, 'the held ask was taken the moment the member became sendable');
    assert.equal(store.get().inviteOpen, null, 'and the sheet closed');
    store.set({ me: null });
  });
});
