/**
 * The encoder is now shared between the app and the server-rendered business
 * console, so "it still scans" has to be something a test can say.
 *
 * A QR that decodes wrong does not look wrong. Flip one bit of the format word
 * and the picture is indistinguishable to a human while every scanner in the
 * world reads it with the wrong mask and gives up. So these tests pin the exact
 * module matrix for payloads we actually mint: if a refactor changes a single
 * module, the hash moves and the build stops.
 *
 * The hashes were taken from the implementation on the day it moved out of
 * src/lib/qr.ts, which was itself verified module-for-module against the
 * reference `qrcode` package (scripts/qr-check.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrMatrix, qrSvg } from './qr.mjs';

/** Cheap, order-sensitive fingerprint of every module in the grid. */
function fingerprint(text) {
  const { size, modules } = qrMatrix(text);
  let h = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) h = (h * 31 + (modules(r, c) ? 49 : 48)) >>> 0;
  }
  return { size, h };
}

test('an identity code encodes to the same matrix it always has', () => {
  assert.deepEqual(fingerprint('https://app.itsnum.com/c/ABCD2345'), { size: 29, h: 892665769 });
});

test('a member connect link encodes to the same matrix it always has', () => {
  assert.deepEqual(fingerprint('https://app.itsnum.com/c/mem_9f2a1b'), { size: 29, h: 3699483006 });
});

test('a short payload still picks version 1', () => {
  assert.deepEqual(fingerprint('NUM'), { size: 21, h: 2131407170 });
});

test('the SVG is self-contained — no network, no script', () => {
  const svg = qrSvg('https://app.itsnum.com/c/ABCD2345');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(!svg.includes('<script'), 'a QR must never carry script');
  assert.ok(!svg.includes('http://www.w3.org/1999/xlink'), 'no external references');
  // One <path> of unit squares, nothing else to fetch.
  assert.ok(svg.includes('<path d="M'), 'the modules are drawn as a path');
});

test('the drawn size is what the caller asked for', () => {
  assert.match(qrSvg('NUM', { size: 208 }), /width="208" height="208"/);
});

test('a payload too long to encode fails loudly rather than drawing nonsense', () => {
  assert.throws(() => qrMatrix('x'.repeat(300)), /too long/);
});
