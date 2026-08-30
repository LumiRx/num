// The email-open pixel, and the four ways it could quietly go wrong.
//
// It is tested by extracting the pieces out of worker.js rather than importing
// them, for the same reason campaign.test.mjs does: worker.js is a Cloudflare
// module worker with bindings, and standing one up in node is more machinery
// than the thing being tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('./worker.js', import.meta.url)), 'utf8');

/* ── the bytes ──────────────────────────────────────────────────────────── */

const gifBytes = () => {
  const m = SRC.match(/const PIXEL_GIF = new Uint8Array\(\[([\s\S]*?)\]\);/);
  assert.ok(m, 'PIXEL_GIF not found in worker.js');
  return Uint8Array.from(
    m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => Number(s)),
  );
};

test('the pixel is a real GIF, not a plausible-looking array of numbers', () => {
  const b = gifBytes();
  // A broken image icon in the middle of a cold email is worse than no pixel.
  assert.equal(String.fromCharCode(...b.slice(0, 6)), 'GIF89a');
  assert.equal(b.at(-1), 0x3b, 'GIF must end with the trailer byte 0x3B');
  assert.equal(b.length, 43, 'the canonical 1x1 transparent GIF is 43 bytes');
  // 1x1: width and height are little-endian uint16 at offsets 6 and 8.
  assert.equal(b[6] | (b[7] << 8), 1);
  assert.equal(b[8] | (b[9] << 8), 1);
  assert.ok(b.every((n) => Number.isInteger(n) && n >= 0 && n <= 255));
});

/* ── the four rules in the doc comment ──────────────────────────────────── */

const pixelFn = () => {
  const i = SRC.indexOf('async function evPixel(');
  assert.ok(i > 0, 'evPixel not found');
  return SRC.slice(i, SRC.indexOf('\n}', i));
};

test('it never applies the origin check that would reject every mail client', () => {
  // Gmail, Outlook and Apple's image proxy send no Origin header. badOrigin()
  // guards /api/ev because our own pages call it; reusing it here would pass
  // only forged requests and drop all the real ones.
  assert.doesNotMatch(pixelFn(), /badOrigin/);
});

test('a database failure still returns an image', () => {
  const fn = pixelFn();
  assert.match(fn, /try\s*\{/, 'the body must be wrapped in try');
  assert.match(fn, /catch\s*\(\s*e\s*\)/);
  // The return is outside the try, so it happens on both paths.
  const afterCatch = fn.slice(fn.lastIndexOf('catch'));
  assert.match(afterCatch, /return pixelResponse\(\)/);
});

test('the response is never cached, or the second open is invisible', () => {
  const m = SRC.match(/const pixelResponse = \(\) =>[\s\S]*?\}\);/);
  assert.ok(m);
  assert.match(m[0], /"content-type": "image\/gif"/);
  assert.match(m[0], /no-store/);
  assert.match(m[0], /max-age=0/);
});

test('the recipient token goes in, the email address never does', () => {
  const fn = pixelFn();
  // Only three query params are read, and none of them is an address.
  const params = [...fn.matchAll(/q\.get\("([a-z]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(new Set(params), new Set(['ev', 't', 'c', 'd']));
  assert.doesNotMatch(fn, /q\.get\("(email|e|addr|to)"\)/);
});

/* ── wiring ─────────────────────────────────────────────────────────────── */

test('the route is registered for GET and rides the existing /api/ev* pattern', () => {
  assert.match(SRC, /p === "\/api\/ev\.gif" && req\.method === "GET"/);
  const wr = readFileSync(fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)), 'utf8');
  assert.match(wr, /itsnum\.com\/api\/ev\*/,
    'the /api/ev* route is what makes /api/ev.gif reachable without a new route');
});

test('both email events are allowed through the events allowlist', () => {
  const m = SRC.match(/const EVENTS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m);
  assert.match(m[1], /"email_open"/);
  assert.match(m[1], /"email_click"/);
});

/* ── the thing that was actually missing from every email ever sent ─────── */

test('the legal line carries a postal address', () => {
  const m = SRC.match(/const LEGAL_LINE =\s*\n?\s*"([^"]+)"/);
  assert.ok(m, 'LEGAL_LINE not found');
  const line = m[1];
  // CAN-SPAM 7704(a)(5) wants a valid physical postal address in every
  // commercial message. A street number, a state and a ZIP is the shape of one.
  assert.match(line, /\d+ [A-Za-z]/, 'no street address');
  assert.match(line, /\b[A-Z]{2}\b \d{5}\b/, 'no state and ZIP');
  assert.match(line, /5arz Inc/);
});
