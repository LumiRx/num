// The first screen must not ask who you are.
//
// This is the test for the most expensive single line NUM has shipped. The
// cold open ended "Let's start with your name" while an X campaign about
// flights spent $529.05 driving 842 clicks at it. 98 arrivals were recorded,
// 0 messages were sent and 0 accounts were created.
//
// Two rules come out of that, and both are easy to undo by accident because
// undoing them looks like helpfulness:
//
//   1. The opening asks for a TASK, never an identity. A stranger who has
//      been given nothing owes us nothing, and certainly not a phone number.
//   2. The opening answers the ad that sent them. A flight ad that lands on a
//      paragraph about dinner has thrown away whatever the click cost.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

// Source modules import each other without extensions, which vite resolves and
// node does not. Same hook gate.test.mjs uses, for the same reason.
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

let coldOpen, promiseOf;
before(async () => { ({ coldOpen, promiseOf } = await import('./coldopen.ts')); });

/** Ways of asking "who are you" that have appeared in this app's copy. */
const IDENTITY_ASKS = [
  /start with your name/i,
  /what(?:'|’)s your name/i,
  /tell me your name/i,
  /your (?:mobile|phone) number/i,
  /sign (?:up|in) (?:first|to start)/i,
  /create an account/i,
  /who are you\b/i,
];

const VARIANTS = ['flight-one', 'hotels_us', 'dinner-bkk', 'something-else', '', null, undefined];

describe('the cold open', () => {
  test('never asks the guest who they are', () => {
    for (const hint of VARIANTS) {
      const { text } = coldOpen(hint);
      for (const ask of IDENTITY_ASKS) {
        assert.ok(
          !ask.test(text),
          `the opening for ${JSON.stringify(hint)} asks for an identity (${ask}): ${JSON.stringify(text)}`,
        );
      }
    }
  });

  test('always ends in a question the guest can answer from their head', () => {
    for (const hint of VARIANTS) {
      const { text } = coldOpen(hint);
      assert.ok(text.trim().endsWith('?'), `no question to answer for ${JSON.stringify(hint)}: ${text}`);
    }
  });

  test('answers the ad that sent them', () => {
    assert.match(coldOpen('flight-one').text, /flight/i);
    assert.match(coldOpen('x flights_us cpc').text, /flight/i);
    assert.match(coldOpen('hotels_us').text, /stay|places to stay/i);
    assert.match(coldOpen('dinner-bkk').text, /mood|feel like/i);
  });

  test('a campaign named by someone else still matches', () => {
    // Campaigns get named by whoever sets them up. A miss here is invisible
    // and costs the entire screen, so the matcher is deliberately loose.
    for (const name of ['flight-one', 'FlightWatch-Sep', 'flights_us', 'fly-bkk', 'landing-late']) {
      assert.equal(promiseOf(name), 'flight', `${name} should read as a flight campaign`);
    }
    for (const name of ['hotel-rooms', 'STAYS-q4', 'where-to-sleep']) {
      assert.equal(promiseOf(name), 'stay', `${name} should read as a stay campaign`);
    }
  });

  test('an unknown campaign gets the generic open, not a broken one', () => {
    const { text, lead } = coldOpen('brand-awareness-42');
    assert.equal(lead, null);
    assert.ok(text.length > 40, 'the generic open must still be a real greeting');
    assert.ok(text.trim().endsWith('?'));
  });

  test('the check can fail', () => {
    // A guard that cannot fail gets deleted by someone tidying up.
    const bad = 'Hi, I’m NUM. Let’s start with your name.';
    assert.ok(IDENTITY_ASKS.some((r) => r.test(bad)), 'the identity matcher must catch the line that cost $529');
  });
});
