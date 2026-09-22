/**
 * THE TWO ENDS OF A SUBSCRIPTION: COMING BACK, AND LEAVING.
 *
 * Traced end to end against production on 16 Sep 2026. The price list, the
 * subscribe call and the webhook code all existed and worked. Two things did
 * not:
 *
 *   · Stripe returned a paying member to `/?paid=cs_live_…` and NOTHING read
 *     that parameter. They were charged and landed on the ordinary app screen
 *     with no acknowledgement.
 *   · `/api/membership/cancel` had existed for weeks, carrying a comment
 *     saying cancelling has to be as easy as joining, and nothing in the app
 *     ever called it — while the pricing card said "Cancel any time".
 *
 * The confirmation tests are mostly about the RACE: the tier is granted by
 * Stripe's webhook, not by the redirect, and telling a member who just paid
 * that they are on the free plan is the worst available way to be wrong.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Node cannot resolve an extensionless TypeScript import. Same resolver
// signup.test.mjs uses — see the note there.
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
globalThis.location = { search: '', href: 'https://app.itsnum.com/', origin: 'https://app.itsnum.com', protocol: 'https:', hostname: 'app.itsnum.com', pathname: '/' };
globalThis.history = { replaceState() {} };

const { paidParam, confirmPaid, cancelSubscription } = await import('./subscription.ts');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/* ── reading the return ────────────────────────────────────────────────── */

describe('the parameter Stripe sends back', () => {
  test('a real session id is read', () => {
    assert.equal(paidParam('?paid=cs_live_a1DBC7YCTfZPg5'), 'cs_live_a1DBC7YCTfZPg5');
    assert.equal(paidParam('?paid=cs_test_abc123'), 'cs_test_abc123');
  });

  test('junk is refused rather than trusted', () => {
    // It only ever gates which screen shows, but a value that reaches state
    // should still look like what Stripe actually sends.
    for (const q of ['?paid=', '?paid=../../etc', '?paid=<script>', '?other=1', '']) {
      assert.equal(paidParam(q), null, q);
    }
  });
});

/* ── the race ──────────────────────────────────────────────────────────── */

describe('confirming a payment that the webhook has not delivered yet', () => {
  const noSleep = () => Promise.resolve();

  function server(seq) {
    let i = 0;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => seq[Math.min(i++, seq.length - 1)],
    });
  }

  test('confirms once the server reports the NEW tier', async () => {
    server([{ tier: 'free' }, { tier: 'plus', name: 'Num Plus', renews_at: '2026-10-16' }]);
    const r = await confirmPaid('mem_1', 'free', { sleep: noSleep });
    assert.equal(r.state, 'upgraded');
    assert.equal(r.name, 'Num Plus');
  });

  test('THE RACE: it waits instead of reporting free a second after they paid', async () => {
    // A single read would return `free` here — the webhook is still in flight.
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: true, json: async () => ({ tier: calls < 4 ? 'free' : 'plus', name: 'Num Plus' }) };
    };
    const r = await confirmPaid('mem_1', 'free', { sleep: noSleep });
    assert.equal(r.state, 'upgraded');
    assert.ok(calls >= 4, 'gave up before the webhook landed');
  });

  test('PLUS → PRO confirms on the CHANGE, not on "any paid tier"', async () => {
    // Comparing against `was` rather than against 'free' is the whole reason
    // the previous tier is captured before checkout.
    server([{ tier: 'plus' }, { tier: 'plus' }, { tier: 'pro', name: 'Num Pro' }]);
    const r = await confirmPaid('mem_1', 'plus', { sleep: noSleep });
    assert.equal(r.state, 'upgraded');
    assert.equal(r.tier, 'pro');
  });

  test('a webhook that never lands reads PENDING, never failed', async () => {
    // Stripe has the money either way. Calling this a failure would send a
    // paying member to support over something that is about to resolve.
    server([{ tier: 'free' }]);
    const r = await confirmPaid('mem_1', 'free', { tries: 2, sleep: noSleep });
    assert.equal(r.state, 'pending');
  });

  test('it gives up eventually rather than polling forever', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return { ok: true, json: async () => ({ tier: 'free' }) }; };
    await confirmPaid('mem_1', 'free', { tries: 3, sleep: noSleep });
    assert.equal(calls, 3);
  });

  test('a server error is pending, not a wrong answer', async () => {
    globalThis.fetch = async () => { throw new Error('offline'); };
    const r = await confirmPaid('mem_1', 'free', { tries: 2, sleep: noSleep });
    assert.equal(r.state, 'pending');
  });

  test('no member id is unknown, and never claims an upgrade', async () => {
    assert.equal((await confirmPaid('', 'free', { sleep: noSleep })).state, 'unknown');
  });
});

/* ── leaving ───────────────────────────────────────────────────────────── */

describe('cancelling', () => {
  test("the server's own wording is passed through, never rewritten", async () => {
    // The server knows whether this runs to a period end, was a legacy one-off
    // that simply expires, or was free all along. Rewording it here is how the
    // UI ends up contradicting the billing system.
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ ok: true, note: 'Done — plus stays active until 2026-10-16, then won’t charge again.' }),
    });
    const out = await cancelSubscription('mem_1');
    assert.equal(out.ok, true);
    assert.match(out.note, /stays active until 2026-10-16/);
  });

  test('a refusal reports the reason and changes nothing', async () => {
    globalThis.fetch = async () => ({ ok: false, json: async () => ({ ok: false, error: 'Who is cancelling?' }) });
    const out = await cancelSubscription('mem_1');
    assert.equal(out.ok, false);
    assert.match(out.error, /Who is cancelling/);
  });

  test('an unreachable server says plainly that nothing changed', async () => {
    globalThis.fetch = async () => { throw new Error('offline'); };
    const out = await cancelSubscription('mem_1');
    assert.equal(out.ok, false);
    assert.match(out.error, /nothing was changed/);
  });
});

/* ── wiring ────────────────────────────────────────────────────────────── */

describe('the loop is actually connected', () => {
  const CARD = read('src/components/app/MembershipCard.tsx');
  const APP = read('src/components/app/ConciergeApp.tsx');
  const RETURN = read('src/components/app/PaidReturn.tsx');

  test('THE PROMISE THE UI COULD NOT KEEP: "cancel any time" now has a button', () => {
    assert.match(CARD, /Cancel any time/);
    assert.match(CARD, /CANCEL MY PLAN/);
    assert.match(CARD, /cancelSubscription/);
  });

  test('cancel is offered only to a paying member', () => {
    // An "unsubscribe" on a free plan reads like a threat.
    assert.match(CARD, /\{current !== 'free' && \(/);
  });

  test('cancelling takes two taps, and the second is plain rather than frightening', () => {
    assert.match(CARD, /confirmCancel/);
    assert.match(CARD, /YES, CANCEL IT/);
    assert.match(CARD, /KEEP IT/);
    assert.match(CARD, /concierge, your plans and your people stay yours/);
  });

  test('the tier before checkout is written wherever checkout starts', () => {
    // Read in ConciergeApp; without both writers a Plus→Pro upgrade would
    // compare against the wrong baseline.
    assert.match(CARD, /num-tier-before-checkout/);
    assert.match(read('src/components/app/WelcomePlans.tsx'), /num-tier-before-checkout/);
    assert.match(APP, /num-tier-before-checkout/);
  });

  test('the return screen is mounted, and beats the welcome sheet', () => {
    // Somebody coming back from a successful payment must not be shown the
    // plans screen again on the way in.
    assert.match(APP, /\{paid \? <PaidReturn/);
    assert.match(APP, /welcomePlans && !paid/);
  });

  test('the address bar is cleaned immediately, not on close', () => {
    // A refresh mid-poll would otherwise restart the whole confirmation.
    // Anchored on `useEffect(` — the bare word also matches the React import
    // line above, where `confirmPaid` happens to appear first and the order
    // read backwards.
    const effect = RETURN.slice(RETURN.indexOf('useEffect(('), RETURN.indexOf('const wrap'));
    assert.ok(effect.includes('clearPaidParam()'), 'the parameter is never cleared');
    assert.ok(effect.indexOf('clearPaidParam()') < effect.indexOf('confirmPaid'));
  });

  test('PENDING never reads as an error', () => {
    // FOURTH instance of the prose-grep trap in this repo (scanoutcomes,
    // tokenentropy, welcomeplans, here). The comment above this branch reads
    // "NOT an error, and it must never read as one" — which satisfied a grep
    // for "error" and failed the test that the comment exists to explain.
    // Assert against CODE, never against prose.
    const code = RETURN.replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    const pending = code.slice(code.indexOf("landed.state === 'pending'"));
    assert.match(pending, /PAYMENT RECEIVED/);
    assert.match(pending, /The payment went through/);
    assert.ok(!/failed|error|problem|sorry/i.test(pending.slice(0, 900)),
      'a successful payment is described as a failure');
  });
});
