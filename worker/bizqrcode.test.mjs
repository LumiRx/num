/**
 * THE BUSINESS QR — WIRED, NOT PROMISED.
 *
 * 12 Sep 2026. Dre: "we need to check the business bkackend. theres issues
 * with the qr code and adding businesses."
 *
 * What was there: a "Taking payment" page that said "Pay code active — print
 * it for the counter" and rendered no code, no image and no link. Nothing to
 * print. And the query behind it read
 *
 *     SELECT id, label, created_at FROM num_paylinks
 *      WHERE place_id = ?1 OR business_id = ?2
 *
 * against a table whose key is `token` and which has no `place_id` at all. It
 * threw `no such column` on every call; the catch turned that into the
 * negative answer, so a business with a pay code would still have been told it
 * had none. Nobody noticed because the table is empty in production, so the
 * negative answer was also the true one.
 *
 * These tests exist so the page cannot go back to promising an artifact it
 * does not render. Each one follows the chain the way the wire-before-you-ship
 * rule requires: control → data → route → output.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { __testables } from './bizconsole.mjs';
import { PAGES, pageFor } from './bizpages.mjs';
import { qrSvg } from './qr.mjs';
import { linkFor } from './identity.mjs';

const { codePage } = __testables;
const CONSOLE_SRC = readFileSync(new URL('./bizconsole.mjs', import.meta.url), 'utf8');
const DASH_SRC = readFileSync(new URL('./bizdash.mjs', import.meta.url), 'utf8');
const READY_SRC = readFileSync(new URL('./bizreadiness.mjs', import.meta.url), 'utf8');

const CODE = 'ABCD2345';
const LINK = linkFor(CODE);

describe('the page a business can actually reach', () => {
  test('"Your QR code" is in the nav', () => {
    const p = PAGES.find((x) => x.id === 'code');
    assert.ok(p, 'a page nobody can navigate to is not a feature');
    assert.equal(p.nav, true);
    assert.equal(p.needs, null, 'a venue must not have to buy a plan to print its own code');
  });

  test('the id resolves through the same lookup the router uses', () => {
    assert.equal(pageFor('code').id, 'code');
  });

  test('the router renders it with codePage, not a placeholder', () => {
    assert.match(CONSOLE_SRC, /case 'code':\s+body = codePage\(/);
  });

  test('the dashboard is handed the code, the link and the scans', () => {
    assert.match(CONSOLE_SRC, /identityCode, identityLink, identityConnections,/,
      'the page can only draw what loadDashboard passes it');
    assert.match(CONSOLE_SRC, /codeFor\(env, \{ ownerType: 'business', ownerId: businessId \}\)/);
  });
});

describe('what the page actually puts on the screen', () => {
  const html = codePage(CODE, LINK, []);

  test('there is a real QR in it, not a sentence about one', () => {
    assert.ok(html.includes('<svg'), 'the whole bug was a page that described a QR');
    assert.ok(html.includes('<path d="M'), 'the modules have to be drawn');
  });

  test('the QR encodes the link, byte for byte', () => {
    assert.ok(html.includes(qrSvg(LINK, { size: 240, margin: 2, dark: '#111111', light: '#ffffff' })),
      'a QR that encodes anything other than the link is a code that goes somewhere else');
  });

  test('the link is shown in text too — for a bio, a message, a phone call', () => {
    assert.ok(html.includes(LINK));
    assert.ok(html.includes(CODE));
  });

  test('it points at the host that serves /c/', () => {
    assert.ok(LINK.startsWith('https://app.itsnum.com/c/'),
      'itsnum.com/c/ is a 404 — see connectlink.test.mjs');
  });

  test('an empty scan list says so rather than showing an empty table', () => {
    assert.ok(/Nobody has scanned it yet/.test(html));
    assert.ok(!html.includes('<table'), 'no headers over nothing');
  });

  test('scans are listed with who, how many times and when', () => {
    const withScans = codePage(CODE, LINK, [
      { to_type: 'member', to_id: 'mem_1', name: 'Dre', times: 3, last_met_at: '2026-09-11T10:00:00Z' },
    ]);
    assert.ok(withScans.includes('<table'));
    assert.ok(withScans.includes('Dre'));
    assert.ok(withScans.includes('2026-09-11'));
  });

  test('a name with markup in it cannot break out', () => {
    const nasty = codePage(CODE, LINK, [{ to_type: 'member', name: '<script>x</script>', times: 1 }]);
    assert.ok(!nasty.includes('<script>x</script>'));
    assert.ok(nasty.includes('&lt;script&gt;'));
  });

  test('no code yet says what happens next instead of drawing a broken square', () => {
    const none = codePage(null, null, []);
    assert.ok(!none.includes('<svg'));
    assert.match(none, /being minted/);
  });
});

/**
 * The comments in bizdash.mjs quote the broken statement on purpose, so these
 * assertions read the CODE with the comment lines taken out. Testing the
 * source of a file that documents its own history has to know the difference.
 */
const stripComments = (src) => src
  .split('\n')
  .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
  .join('\n');

describe('the query that silently threw', () => {
  const DASH = stripComments(DASH_SRC);
  const READY = stripComments(READY_SRC);

  test('payQr no longer names columns num_paylinks does not have', () => {
    assert.ok(!/FROM num_paylinks[\s\S]{0,120}place_id/.test(DASH),
      'num_paylinks has no place_id column');
    assert.ok(!/SELECT id, label, created_at FROM num_paylinks/.test(DASH),
      'num_paylinks has no id column — its key is token');
  });

  test('it reads the real key and skips revoked codes', () => {
    assert.match(DASH_SRC, /SELECT token, label, created_at FROM num_paylinks/);
    assert.match(DASH_SRC, /state = 'active' AND revoked_at IS NULL/);
  });

  test('the readiness checklist asks the same question the same way', () => {
    assert.ok(!/num_paylinks WHERE place_id/.test(READY));
    assert.match(READY, /SELECT token FROM num_paylinks WHERE business_id = \?1/);
  });
});

describe('payQr still refuses to promise a surface that cannot take money', () => {
  test('no database, no claim', async () => {
    const { payQr } = await import('./bizdash.mjs');
    assert.deepEqual(await payQr({}, { businessId: 'b1' }), { ready: false, reason: 'No listing.' });
  });

  test('no business, no claim', async () => {
    const { payQr } = await import('./bizdash.mjs');
    const out = await payQr({ DB: {} }, {});
    assert.equal(out.ready, false);
  });
});
