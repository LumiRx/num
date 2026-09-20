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

let canSend, mayAsk, holdAndAsk, takeHeldAsk, store, gateOpen, asksSpent, FREE_ANSWERS, needAccount, closeInvite;
before(async () => {
  ({ canSend, mayAsk, holdAndAsk, takeHeldAsk, gateOpen, asksSpent, FREE_ANSWERS, needAccount, closeInvite } = await import('./gate.ts'));
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
    // 20 Sep 2026: `{}` and not `{ intent: 'account' }` was half of "the
    // widget won't search unless I invite a friend" — the bare draft opens
    // the sheet on the invite-a-friend screen, and what is wanted here is a
    // number or an address. See src/lib/browsegate.test.mjs.
    assert.deepEqual(s.inviteOpen, { intent: 'account' });
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
    assert.deepEqual(store.get().inviteOpen, { intent: 'account' });
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
    // `mayAsk({ browse })` since 20 Sep: a widget search is a lookup and is
    // let through, and the gate is still here and still first.
    const gate = fn.indexOf('if (!mayAsk(');
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
    // `mayAsk()` since 18 Sep, because the first answer is free and the
    // composer must let an unspent stranger straight through. The ORDER is
    // what this test exists for and has not changed: check before clearing,
    // so a guest who meets the sheet still has their sentence in the box.
    const gate = send.indexOf('mayAsk()');
    assert.ok(gate > 0, 'the composer must check before clearing');
    assert.ok(gate < send.indexOf("setDraft('')"), 'the draft must survive the gate');
  });

  test('and it says so above the box — but only once the free answer is spent', () => {
    // Was `!canSend(me)`, which put the rules of the place above an EMPTY box
    // for every stranger who had never asked anything. That notice was part of
    // what the 18 Sep numbers indicted, so it now waits for the free answer to
    // be used. gateOpen takes msgs as well as me precisely so this stays
    // reactive: read from the store inside render and it would never update.
    assert.match(src('../components/app/ThreadView.tsx'), /!gateOpen\(me, msgs\) && \(/);
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

/* ── THE FIRST ANSWER IS FREE ─────────────────────────────────────────── */

describe('one answer, then the gate', () => {
  test('a stranger who has asked nothing may ask', () => {
    assert.equal(gateOpen(null, []), true, 'the first question must always go through');
    assert.equal(gateOpen(undefined, undefined), true, 'a cold start with no transcript is a stranger');
  });

  test('a stranger who has already asked may not ask again', () => {
    const asked = [{ who: 'c' }, { who: 'u' }, { who: 'c' }];
    assert.equal(gateOpen(null, asked), false, 'the second question is where being reachable is the price');
  });

  test('the concierge talking to itself does not spend the free answer', () => {
    // Greetings, ack lines and answers are all `who: 'c'`. Only the guest's
    // own words count, or a chatty cold open would close the gate before the
    // guest had said anything at all.
    const chatty = [{ who: 'c' }, { who: 'c' }, { who: 'c' }];
    assert.equal(asksSpent(chatty), 0);
    assert.equal(gateOpen(null, chatty), true);
  });

  test('a proved member is never counted or limited', () => {
    const many = Array.from({ length: 50 }, () => ({ who: 'u' }));
    assert.equal(gateOpen(member({ phone_verified: true }), many), true);
    assert.equal(gateOpen(member({ email: 'a@b.com', email_verified: true }), many), true);
    assert.equal(gateOpen(member({ review_access: true }), many), true,
      'the App Review reviewer must never meet the gate');
  });

  test('the free answer is exactly one, and the number is stated once', () => {
    assert.equal(FREE_ANSWERS, 1);
    const spent = Array.from({ length: FREE_ANSWERS }, () => ({ who: 'u' }));
    assert.equal(gateOpen(null, spent), false, 'spending FREE_ANSWERS must close the gate');
    assert.equal(gateOpen(null, spent.slice(0, -1)), true, 'one short must still be open');
  });

  test('a malformed transcript does not throw the guest out', () => {
    // msgs come back from localStorage, where anything can be waiting.
    assert.equal(asksSpent(null), 0);
    assert.equal(asksSpent([null, undefined, {}, { who: 7 }]), 0);
    assert.equal(gateOpen(null, [null, undefined]), true);
  });
});


// ── THE WAY BACK (18 Sep 2026) ────────────────────────────────────────────
//
// "the connection needs to point with the action … it needs direction to not
// lose the user's progress." A sheet that sends someone to sign in says why
// (intent) and where to put them back (returnTo); closing the account sheet
// restores that, unless an ask is held — then the thread is where the answer
// is about to land.
describe('the account sheet remembers where it came from', () => {
  test('needAccount opens the sheet with the intent and the way back', () => {
    store.set({ partyOpen: false });
    needAccount({ partyOpen: true }, 'plan');
    assert.deepEqual(store.get().inviteOpen, { intent: 'plan', returnTo: { partyOpen: true } });
  });

  test('closeInvite puts the interrupted sheet back', () => {
    store.set({ partyOpen: false, inviteOpen: { intent: 'plan', returnTo: { partyOpen: true } } });
    closeInvite();
    assert.equal(store.get().inviteOpen, null);
    assert.equal(store.get().partyOpen, true);
  });

  test('a held ask outranks the return — the thread is where the answer lands', () => {
    store.set({ partyOpen: false, pendingAsk: 'a table for two', inviteOpen: { intent: 'plan', returnTo: { partyOpen: true } } });
    closeInvite();
    assert.equal(store.get().inviteOpen, null);
    assert.equal(store.get().partyOpen, false, 'the plan does not reopen over an answer in flight');
  });

  test('a plain sign-in with nothing to return to just closes', () => {
    store.set({ inviteOpen: {} });
    closeInvite();
    assert.equal(store.get().inviteOpen, null);
  });
});
