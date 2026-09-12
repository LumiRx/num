/**
 * /c/ — THE PATH EVERY NUM CODE OPENS ON, WHICH HAD NO HANDLER.
 *
 * 11 Sep 2026. `connectLink()` has minted `/c/<memberId>` since August; it is
 * what QrCard renders and what ShareSheet shares. The app reads a connect code
 * from the QUERY (`?c=`), and nothing rewrote the path into the query. With
 * `not_found_handling: single-page-application`, `/c/anything` served
 * index.html and the code was dropped. Every "scan to connect with me" QR in
 * the wild opened the app and did nothing at all.
 *
 * Found by following the chain rather than by anyone reporting it — a QR that
 * opens the right app looks like it worked.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WORKER = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
const SOCIAL = readFileSync(new URL('../src/lib/social.ts', import.meta.url), 'utf8');
const LINKS = readFileSync(new URL('../src/lib/links.ts', import.meta.url), 'utf8');
const IDENTITY = readFileSync(new URL('./identity.mjs', import.meta.url), 'utf8');

describe('the path is handled at all', () => {
  test('the worker answers /c/', () => {
    assert.match(WORKER, /url\.pathname\.startsWith\('\/c\/'\)/,
      'without this every connect QR in the wild is inert');
  });

  test('it rewrites into the query shape the client already reads', () => {
    const i = WORKER.indexOf("url.pathname.startsWith('/c/')");
    const block = WORKER.slice(i, i + 1400);
    assert.match(block, /new URLSearchParams\(\{ c: token \}\)/);
    assert.match(SOCIAL, /q\.get\('c'\)/, 'the client must still read ?c=');
  });

  test('302, not 301 — a permanent redirect would be cached everywhere', () => {
    const i = WORKER.indexOf("url.pathname.startsWith('/c/')");
    const block = WORKER.slice(i, i + 1400);
    assert.match(block, /302/);
    assert.ok(!/\b301\b/.test(block));
  });

  test('a referral on the link survives the redirect', () => {
    const i = WORKER.indexOf("url.pathname.startsWith('/c/')");
    const block = WORKER.slice(i, i + 1400);
    assert.match(block, /searchParams\.get\('ref'\)/, 'the same link is both a connect and a referral');
  });

  test('junk goes to the front door, not into a query parameter', () => {
    const i = WORKER.indexOf("url.pathname.startsWith('/c/')");
    const block = WORKER.slice(i, i + 1400);
    assert.match(block, /token\.length > 64/);
    assert.match(block, /\[A-Za-z0-9_-\]/);
  });
});

describe('both kinds of code ride the same path', () => {
  test('the link shape the two minters produce is identical', () => {
    assert.match(LINKS, /\/c\/\$\{encodeURIComponent\(memberId\)\}/);
    assert.match(IDENTITY, /\/c\/\$\{encodeURIComponent\(String\(code\)\)\}/);
  });

  test('the client tells them apart by shape, and they cannot collide', () => {
    assert.match(SOCIAL, /isIdentityCode\(connectTo\)/);
    assert.match(SOCIAL, /\^\[A-HJKMNP-Z2-9\]\{8\}\$/, 'the identity-code shape');
    // A member id is always prefixed, so it can never match the identity
    // shape — that is what lets one path carry both.
    const re = /^[A-HJKMNP-Z2-9]{8}$/;
    assert.equal(re.test('mem_cbdec3f7ac674ab9aba6'), false);
    assert.equal(re.test('ABCD2345'), true);
    // And the ambiguous characters the minter excludes stay excluded.
    for (const bad of ['ABCD234O', 'ABCD2340', 'ABCD234I', 'ABCD234L']) {
      assert.equal(re.test(bad), false, `${bad} should not read as an identity code`);
    }
  });

  test('an identity code is recorded as a scan, a member id as a friend', () => {
    assert.match(SOCIAL, /if \(isIdentityCode\(connectTo\)\) void recordIdentityScan\(connectTo\);/);
    assert.match(SOCIAL, /else void connectByCode\(connectTo\);/);
  });

  test('the scan helper posts to a route the worker serves', () => {
    assert.match(SOCIAL, /apiUrl\('\/api\/identity\/scan'\)/);
    assert.match(WORKER, /rest === '\/scan'/);
  });

  test('the read helpers post to routes the worker serves', () => {
    assert.match(SOCIAL, /\/api\/identity\/mine\?me=/);
    assert.match(SOCIAL, /\/api\/identity\/connections\?/);
    assert.match(WORKER, /rest === '\/mine'/);
    assert.match(WORKER, /rest === '\/connections'/);
  });
});


describe('the client regex and the server alphabet cannot drift apart', () => {
  test('every character the minter can emit is accepted, and nothing else is', () => {
    // The first version of the client regex was `[A-HJ-NP-Z2-9]`, which reads
    // as "no I, no O" but quietly allows L — a character the minter never
    // produces. Harmless today, but a client that accepts codes the server
    // cannot mint is a bug waiting for a support ticket.
    const alphabet = /const ALPHABET = '([^']+)'/.exec(IDENTITY)[1];
    const shape = /export const isIdentityCode = \(s: string\): boolean => \/\^\[([^\]]+)\]\{8\}\$\//.exec(SOCIAL);
    assert.ok(shape, 'isIdentityCode must be a single anchored character class');
    const re = new RegExp(`^[${shape[1]}]$`);
    for (const ch of alphabet) {
      assert.ok(re.test(ch), `the minter emits ${ch} but the client rejects it`);
    }
    for (const ch of '01OIL') {
      assert.ok(!alphabet.includes(ch), `${ch} must not be in the alphabet`);
      assert.ok(!re.test(ch), `the client accepts ${ch}, which the minter never emits`);
    }
  });
});

/**
 * THE HOST THE CODE POINTS AT.
 *
 * 12 Sep 2026. `linkFor()` defaulted to `https://itsnum.com`, and `/c/` is a
 * route on the APP Worker, not the marketing site. Checked against production
 * the same day: `itsnum.com/c/ABCD2345` returns 404 while
 * `app.itsnum.com/c/ABCD2345` returns a 302 to `/?c=ABCD2345`.
 *
 * Nothing had shipped yet, so nobody had a dead code in their hand — but every
 * business QR we were about to print would have carried one, which is the
 * "never give me a button that doesn't work" failure with a print run attached.
 */
describe('the code points at the host that serves it', () => {
  test('identity.mjs mints links on the app host', async () => {
    const { linkFor, APP_ORIGIN } = await import('./identity.mjs');
    assert.equal(APP_ORIGIN, 'https://app.itsnum.com');
    assert.equal(linkFor('ABCD2345'), 'https://app.itsnum.com/c/ABCD2345');
  });

  test('it is the same origin the app itself shares from', async () => {
    const { APP_ORIGIN } = await import('./identity.mjs');
    // src/lib/links.ts is TypeScript, so read the constant rather than import it.
    const m = /export const APP_ORIGIN = '([^']+)'/.exec(LINKS);
    assert.ok(m, 'links.ts must declare APP_ORIGIN');
    assert.equal(m[1], APP_ORIGIN,
      'a member code and a venue code have to be the same code');
  });

  test('no Num code is minted on the marketing host', () => {
    assert.ok(!/linkFor\s*=\s*\(code, base = 'https:\/\/itsnum\.com'/.test(IDENTITY),
      'itsnum.com/c/ is a 404 — the app Worker owns /c/');
  });
});
