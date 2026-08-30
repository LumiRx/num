// The first screen, driven for real.
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
//
// Signup has broken twice, on two different layers, and both times every test
// in the repo stayed green because every test in the repo was a regex over the
// source of the thing it was testing.
//
//   15 Aug 2026 — the first TestFlight build. A relative `/api` fetch resolved
//   against `capacitor://localhost`, the SPA fallback returned index.html with
//   status 200, and the signup handler read `.name` on undefined. The bundle
//   contained every string anybody grepped for.
//
//   19 Aug 2026 — the SEC-001 × SEC-006 server fix. `POST /api/social/me` now
//   answers 202 `{recovery:'code_sent'}` for a number that already has an
//   account, WITH NO MEMBER ID — deliberately, because the id is the
//   credential. `signUp()` threw "Couldn't finish signing you up" on exactly
//   that shape, so the day the Worker deployed, every returning number —
//   Andre's, the App Review demo account's, all 125 members reinstalling —
//   would have hit a hard error on the first screen with no way past it.
//
// So this file imports the REAL `social.ts` and drives `signUp()` and
// `verifyCode()` against a stubbed `fetch` that returns each shape the server
// can actually produce. Every case must end in the right state or the right
// sentence — never an unhandled throw, and never a screen the user cannot get
// off.
//
// It runs under `node --test` with type stripping (Node ≥ 22.18). The resolve
// hook below exists only because TypeScript writes `from './store'` where Node
// wants `from './store.ts'`; it adds an extension and nothing else.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
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

// ── the browser, in the smallest form the module graph will accept ────────
globalThis.window = globalThis;
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
  clear() { this._m.clear(); },
};
globalThis.location = { search: '', pathname: '/', href: 'https://app.itsnum.com/', protocol: 'https:', hostname: 'app.itsnum.com', origin: 'https://app.itsnum.com' };
globalThis.history = { replaceState() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.document = {
  addEventListener() {},
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  body: { appendChild() {} },
  documentElement: { style: { setProperty() {} } },
};
try {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', onLine: true }, configurable: true });
} catch { /* node already provides one that is good enough */ }

/** Every request the module made, newest last. */
let calls = [];
/** path → () => Response-ish, consulted before the harmless default. */
let routes = new Map();

/** A response the module can actually read: text(), json-by-parse, headers.get. */
const reply = (status, body, contentType = 'application/json') => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

globalThis.fetch = async (url, init) => {
  const path = String(url);
  let sent = null;
  try { sent = init?.body ? JSON.parse(init.body) : null; } catch { sent = init?.body ?? null; }
  calls.push({ url: path, sent });
  for (const [match, make] of routes) {
    if (path.includes(match)) { routes.delete(match); return make(); }
  }
  // Everything the signed-in refreshers ask for. Shapeless on purpose: this
  // file is about signup, and a background refresh must never be the thing
  // that fails it.
  return reply(200, { ok: true, friends: [], plans: [], requests: {}, balance: 0, moves: [], threads: [] });
};

/** The next call to `match` answers with this, once. */
const answer = (match, status, body, contentType) => routes.set(match, () => reply(status, body, contentType));

let social;
let store;

before(async () => {
  social = await import('./social.ts');
  ({ store } = await import('./store.ts'));
});

beforeEach(() => {
  calls = [];
  routes = new Map();
  store.set({ me: null, msgs: [], chips: [] });
  localStorage.clear();
});

const meRow = {
  id: 'mem_abc123', name: 'Andre', phone: '+66811110001',
  phone_verified: false, name_locked: false, avatar: null, bio: {}, ref: 'LECGVX',
};

// ── OUTCOME 1 — a new number gets an account ──────────────────────────────

test('a new number gets an account, and the app knows who it is', async () => {
  answer('/api/social/me', 200, {
    me: meRow, ref: 'LECGVX', link: 'https://app.itsnum.com/r/LECGVX',
    verification: { sent: false, reason: '30034', note: 'Number saved, but not verified — SMS is not switched on yet.' },
  });

  const out = await social.signUp('Andre', '+66811110001');

  assert.equal(out.outcome, 'account');
  assert.equal(out.me.id, 'mem_abc123');
  assert.equal(store.get().me?.id, 'mem_abc123', 'the account was not stored — the next screen has no identity');
  assert.equal(social.pendingRecovery(), null, 'a fresh signup must not leave a code screen pending');
  assert.equal(out.verification?.sent, false, 'the SMS truth was dropped — the UI would offer a code box for a text nobody sent');
});

// ── OUTCOME 2 — an existing number gets a code, and NO id ─────────────────

test('an existing number moves to the code screen instead of erroring', async () => {
  // The exact body worker/social.mjs returns after the SEC-001 fix.
  answer('/api/social/me', 202, {
    recovery: 'code_sent',
    recovered: false,
    phone: '+66811110001',
    verification: { sent: true, channel: 'sms', expires_in_min: 10 },
    next: 'POST /api/social/verify with { phone, code } to finish signing in.',
  });

  const out = await social.signUp('Andre', '+66811110001');

  assert.equal(out.outcome, 'code_sent', 'the 202 was not recognised — this is the "Couldn’t finish signing you up" dead end');
  assert.equal(out.phone, '+66811110001');
  assert.equal(store.get().me, null, 'a 202 carries no member; inventing one would be worse than the error it replaced');
  assert.equal(social.pendingRecovery(), '+66811110001', 'the number was not kept — /verify has nothing to present');
  assert.match(
    store.get().msgs.at(-1)?.text ?? '',
    /already on Num/i,
    'nothing told the person what happened, so the code box appears out of nowhere',
  );
});

test('the code screen finishes the sign-in — /verify is where the id is released', async () => {
  answer('/api/social/me', 202, { recovery: 'code_sent', phone: '+66811110001', verification: { sent: true, channel: 'sms' } });
  await social.signUp('Andre', '+66811110001');
  calls = [];

  answer('/api/social/verify', 200, { ok: true, phone_verified: true, recovered: true, me: meRow, ref: 'LECGVX' });
  const ok = await social.verifyCode('123456');

  assert.equal(ok, true);
  const verify = calls.find((c) => c.url.includes('/api/social/verify'));
  assert.equal(verify.sent.phone, '+66811110001', 'the number was not presented, so the server cannot take the recovery path');
  assert.ok(!('id' in verify.sent),
    'an id rode along — worker/social.mjs takes the phone path ONLY when the body has no id, so this silently 404s');
  assert.equal(store.get().me?.id, 'mem_abc123', 'the code was accepted and the app still has no account');
  assert.equal(social.pendingRecovery(), null, 'the pending code screen was never cleared');
  assert.equal(store.get().inviteOpen, null, 'the sign-up sheet stayed up after a successful sign-in');
});

test('a member who already has an id proves it with the id, never the number', async () => {
  store.set({ me: { ...meRow } });
  answer('/api/social/verify', 200, { ok: true, phone_verified: true });

  assert.equal(await social.verifyCode('123456'), true);
  const verify = calls.find((c) => c.url.includes('/api/social/verify'));
  assert.equal(verify.sent.id, 'mem_abc123');
  assert.ok(!('phone' in verify.sent), 'both proofs were sent at once — the server would take the id path and the client cannot tell');
  assert.equal(store.get().me?.phone_verified, true);
});

// ── OUTCOME 3 — the failures, each with a sentence a person can act on ────

test('409: the number is verified on another device — say so, do not invent an account', async () => {
  answer('/api/social/me', 409, {
    error: 'That number is already on Num. Sign in from the device that has it.',
    number_taken: true,
  });

  await assert.rejects(
    social.signUp('Mallory', '+66811110001'),
    (err) => {
      assert.match(err.message, /already on Num\. Sign in from the device that has it\./,
        'the server wrote a sentence for this and the client threw something else away');
      return true;
    },
  );
  assert.equal(store.get().me, null);
  assert.equal(social.pendingRecovery(), null, 'a refusal must not leave a code screen waiting for a code nobody sent');
});

test('503: the code could not be texted — the A2P reality today', async () => {
  // This is what EVERY recovery attempt gets until A2P 10DLC is approved.
  answer('/api/social/me', 503, {
    error: 'That number is already on Num, and I can’t text a code to it right now. Message us and we’ll get you back in.',
    number_taken: true,
    recovery: 'unavailable',
    verification: { sent: false, reason: '30034' },
  });

  await assert.rejects(social.signUp('Andre', '+66811110001'), (err) => {
    assert.match(err.message, /can’t text a code to it right now/,
      'the person is told nothing about why, on the one screen they cannot get past');
    assert.doesNotMatch(err.message, /^social \d+$/, 'a status code is not an explanation');
    return true;
  });
  assert.equal(social.pendingRecovery(), null, 'no code was sent, so no code screen');
});

test('HTML with status 200 — the capacitor bug — is a failure, not an empty object', async () => {
  // The 15 Aug TestFlight build, exactly: the native shell resolved /api
  // against its own bundle and the SPA fallback answered index.html, 200.
  answer('/api/social/me', 200, '<!doctype html><html><head><title>Num</title></head><body></body></html>', 'text/html');

  await assert.rejects(social.signUp('Andre', '+66811110001'), (err) => {
    assert.match(err.message, /Couldn't reach Num — the server answered with something unexpected\./,
      'a 200 full of HTML parsed into `{}` again, and the failure will surface two frames away as a property error');
    assert.doesNotMatch(err.message, /undefined is not an object/);
    return true;
  });
  assert.equal(store.get().me, null);
});

test('nothing answered at all — the message names the address it tried', async () => {
  routes.set('/api/social/me', () => { throw new TypeError('Load failed'); });

  await assert.rejects(social.signUp('Andre', '+66811110001'), (err) => {
    assert.match(err.message, /\/api\/social\/me/,
      '"Load failed" names nothing; the address is the only fact that identifies this');
    return true;
  });
});

test('a wrong code keeps the code screen up rather than dropping the sign-in', async () => {
  answer('/api/social/me', 202, { recovery: 'code_sent', phone: '+66811110001', verification: { sent: true, channel: 'sms' } });
  await social.signUp('Andre', '+66811110001');

  answer('/api/social/verify', 400, { error: 'wrong code', attempts_left: 4 });
  await assert.rejects(social.verifyCode('000000'), (err) => {
    assert.match(err.message, /wrong code/);
    return true;
  });
  assert.equal(social.pendingRecovery(), '+66811110001',
    'one wrong digit threw the recovery away — the person is back on a screen that will not let them in');
  assert.equal(store.get().me, null);

  // …and the next attempt still works.
  answer('/api/social/verify', 200, { ok: true, phone_verified: true, recovered: true, me: meRow, ref: 'LECGVX' });
  assert.equal(await social.verifyCode('123456'), true);
  assert.equal(store.get().me?.id, 'mem_abc123');
});

test('the App Review grant is the same shape, and claims no verification', async () => {
  answer('/api/social/me', 202, {
    recovery: 'code_sent',
    recovered: false,
    phone: '+66811110001',
    verification: { sent: false, channel: 'review', note: 'Enter the sign-in code from App Store Connect.' },
    next: 'POST /api/social/verify with { phone, code } to finish signing in.',
  });
  const out = await social.signUp('Apple Review', '+66811110001');
  assert.equal(out.outcome, 'code_sent');

  answer('/api/social/verify', 200, {
    ok: true, phone_verified: false, recovered: true, review_access: true, me: { ...meRow, phone_verified: false }, ref: 'LECGVX',
  });
  assert.equal(await social.verifyCode('NUM-REVIEW-abc123'), true);
  assert.equal(store.get().me?.id, 'mem_abc123', 'the reviewer typed the right code and still has no account');
  assert.equal(store.get().me?.phone_verified, false,
    'the grant does not text anybody, so it must not claim the number was proved');
});
