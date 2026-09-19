// THE INVITE LINK AND THE CLAIM PAGE HAVE TO AGREE ON PARAMETER NAMES.
//
// From 29 Aug to 19 Sep 2026 they did not. handleClaimClick sent `ref`, `b`
// and `lead`; /claim/ reads `t`/`ref`/`token`, `d`/`dest` and `p`. `lead` is
// read by nothing, so dest and placeId were empty, the listing picker returned
// at `if (!dest || q.length < 3)` without ever calling lookup, no place could
// be bound, and /api/claims/start refused every claim for want of a place_id.
//
// A claim could not be started from an invite by anybody for three weeks. 74
// people reached the page in that window. claim_place_picked has never fired
// once, and all four rows in num_claims were made by hand from the admin side.
//
// Nothing was broken in isolation, which is why it survived: the lookup works,
// /send and /verify work, the page renders. Only the join between them was
// wrong, and no test held the two sides to the same names. This one does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleClaimClick } from '../accounts/invites.js';

/** The params /claim/ actually reads, taken from public/claim/index.html:
 *    var token   = qp("t") || qp("ref") || qp("token");
 *    var dest    = (qp("d") || qp("dest"))…;
 *    var placeId = qp("p")…;
 */
const PAGE_READS = { token: ['t', 'ref', 'token'], dest: ['d', 'dest'], place: ['p'] };

/** Minimal env: one invite row, and an UPDATE that does nothing. */
function envWith(row) {
  return {
    DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          async run() { return { meta: { changes: 1 } }; },
          async first() { return /^SELECT/i.test(sql.trim()) ? row : null; },
        };
      },
    },
  };
}

const browser = { headers: { get: (h) => (h === 'user-agent' ? 'Mozilla/5.0 (Macintosh) Chrome/140.0 Safari/537.36' : null) } };

const ROW = {
  lead_id: '76a726970d302b2306c0',
  business_name: "Hugo's Restaurant",
  dest: 'los-angeles',
};

async function locationFor(row) {
  const url = new URL('https://itsnum.com/api/accounts/claim?t=tok-123');
  const res = await handleClaimClick(envWith(row), url, browser);
  assert.equal(res.status, 302);
  return new URL(res.headers.get('Location'));
}

test('the redirect carries every parameter the claim page reads', async () => {
  const loc = await locationFor(ROW);
  const q = loc.searchParams;

  const got = (names) => names.map((n) => q.get(n)).find((v) => v);

  assert.equal(got(PAGE_READS.token), 'tok-123', 'page would see no invite token');
  assert.equal(got(PAGE_READS.dest), 'los-angeles', 'page would see no destination — picker never calls lookup');
  assert.equal(got(PAGE_READS.place), ROW.lead_id, 'page would see no place — start refuses with place_id required');
});

test('the destination is what the picker needs before it will search at all', async () => {
  // public/claim/index.html: if (!dest || q.length < 3) return hideList();
  // An empty dest is the whole bug, so assert it specifically and loudly.
  const loc = await locationFor(ROW);
  const dest = loc.searchParams.get('d') || loc.searchParams.get('dest') || '';
  assert.ok(dest.length > 0, 'empty dest makes the listing picker a dead end');
});

test('a lead_id is passed as a place id, because that is what it is', async () => {
  // All 3,538 sent invites have a lead_id that matches a row in `places`.
  const loc = await locationFor(ROW);
  assert.equal(loc.searchParams.get('p'), ROW.lead_id);
  assert.equal(loc.searchParams.get('lead'), null, '`lead` is read by nothing; sending it is how this was missed');
});

test('a row missing dest or lead still redirects rather than throwing', async () => {
  const loc = await locationFor({ business_name: 'Somewhere', lead_id: null, dest: null });
  assert.equal(loc.pathname, '/claim/');
  assert.equal(loc.searchParams.get('b'), 'Somewhere');
});

test('no token at all still lands on the plain claim page', async () => {
  const url = new URL('https://itsnum.com/api/accounts/claim');
  const res = await handleClaimClick(envWith(ROW), url, browser);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://itsnum.com/claim/');
});

test('a database failure never blocks the claim — it falls through to the page', async () => {
  const broken = { DB: { prepare() { throw new Error('D1 down'); } } };
  const url = new URL('https://itsnum.com/api/accounts/claim?t=tok-123');
  const res = await handleClaimClick(broken, url, browser);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://itsnum.com/claim/');
});
