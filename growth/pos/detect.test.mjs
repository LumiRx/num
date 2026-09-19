// Guessing which till a venue runs, from the thing NUM already knows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessTill, tillPrompt } from './detect.mjs';

test('a venue whose own link is a Square link is probably on Square', () => {
  for (const url of ['https://square.link/u/abc', 'https://barnine.square.site/pay', 'https://checkout.squareup.com/x']) {
    const g = guessTill({ kind: 'url', target: url });
    assert.equal(g.vendor, 'square', url);
    assert.equal(g.connect, true);
  }
  assert.match(tillPrompt(guessTill({ kind: 'url', target: 'https://square.link/u/abc' })), /Looks like you use Square/);
});

test('the three tills NUM can actually read say so, and nothing else does', () => {
  const can = ['https://square.link/u/a', 'https://pay.clover.com/x', 'https://api.lsk.lightspeed.app/y']
    .map((t) => guessTill({ kind: 'url', target: t }));
  assert.deepEqual(can.map((g) => g.vendor), ['square', 'clover', 'lightspeed']);
  assert.ok(can.every((g) => g.connect));

  const cannot = ['https://pay.sumup.com/x', 'https://toasttab.com/x', 'https://paypal.me/barnine', 'https://buy.stripe.com/x']
    .map((t) => guessTill({ kind: 'url', target: t }));
  assert.ok(cannot.every((g) => g.connect === false));
});

test('a vendor NUM cannot read is TOLD so, not offered a dead button', () => {
  // Leaving somebody tapping a button that will never do anything is worse
  // than telling them plainly.
  const sumup = guessTill({ kind: 'url', target: 'https://pay.sumup.com/abc' });
  assert.equal(sumup.label, 'SumUp');
  assert.match(tillPrompt(sumup), /cannot see your checks/);
  assert.match(tillPrompt(sumup), /everything else works/i);

  const toast = guessTill({ kind: 'url', target: 'https://barnine.toasttab.com/order' });
  assert.match(tillPrompt(toast), /no self-serve access/);
});

test('a Stripe link is told to connect Stripe, not a till', () => {
  const g = guessTill({ kind: 'url', target: 'https://buy.stripe.com/abc' });
  assert.equal(g.vendor, 'stripe');
  assert.equal(g.connect, false);
  assert.match(tillPrompt(g), /connect your Stripe account itself/);
});

test('it is never more confident than likely, because a link is not a till', () => {
  // Someone can take card on a Square reader and send guests to a Stripe page.
  const g = guessTill({ kind: 'url', target: 'https://square.link/u/abc' });
  assert.equal(g.confidence, 'likely');
  assert.notEqual(g.confidence, 'certain');
  assert.match(tillPrompt(g), /^Looks like/);
});

test('a Thai sticker and a wallet are certain, and both mean no till', () => {
  const pp = guessTill({ kind: 'promptpay', target: '0812345678' });
  assert.equal(pp.confidence, 'certain');
  assert.equal(pp.connect, false);
  assert.match(pp.why, /photograph the bill/);

  const crypto = guessTill({ kind: 'crypto', target: '0xabc' });
  assert.equal(crypto.connect, false);
  assert.match(crypto.why, /staff type the total/);
});

test('an unknown or unreadable target is no guess at all, and shows nothing', () => {
  for (const t of ['https://pay.barnine.com/bill', 'not a url', '', null]) {
    const g = guessTill({ kind: 'url', target: t });
    assert.equal(g.vendor, null, String(t));
    assert.equal(g.confidence, 'none');
    assert.equal(tillPrompt(g), null, 'no guess means no prompt, not a wrong one');
  }
});

test('a lookalike domain does not match', () => {
  // squareup.com.evil.example is not Square.
  for (const t of ['https://squareup.com.evil.example/x', 'https://notsquare.link/x', 'https://myclover.com.co/x']) {
    assert.equal(guessTill({ kind: 'url', target: t }).vendor, null, t);
  }
});

test('the guess changes nothing but which prompt is shown first', () => {
  // It carries no permission, no connection, no vendor the caller can act on
  // beyond a label — the full picker is always one tap away.
  const g = guessTill({ kind: 'url', target: 'https://square.link/u/abc' });
  assert.deepEqual(Object.keys(g).sort(), ['confidence', 'connect', 'country', 'host', 'label', 'vendor', 'why'].sort());
  assert.equal(g.why, null, 'a connectable vendor needs no excuse');
});
