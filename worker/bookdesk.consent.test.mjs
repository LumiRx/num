/**
 * The partner-SMS consent gate (A2P blocker B1).
 *
 * `venue_phone` arrives in the request body of POST /api/book/request. Before
 * this gate existed, any caller could post any number and the worker would
 * text it — and used exactly as designed it was no better, because the numbers
 * come from OpenStreetMap and Google Places scrapes. Nobody on that list ever
 * agreed to hear from NUM.
 *
 * That is a blocker for the A2P 10DLC filing specifically, not a general
 * tidiness point: the campaign declares to a carrier that recipients are
 * venues with a NUM relationship who supplied their number. Filing that while
 * this code texts a map is a false statement to a carrier, and it is the kind
 * an audit finds by pulling one sample and asking where the number came from.
 *
 * These tests run smsPartner against fakes rather than reading the source,
 * so they assert what the function DOES: who it will text, who it refuses,
 * what it puts in the body, and what it fails to when the register is broken.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ENV = { TWILIO_SID: 'ACtest', TWILIO_TOKEN: 'tok', TWILIO_FROM: '+15550001111' };

/** A D1 stand-in whose only table is the consent register. */
const dbWith = (rows, { throws = false } = {}) => ({
  prepare: () => ({
    bind: (phone) => ({
      first: async () => {
        if (throws) throw new Error('no such table: num_sms_consent');
        return rows[phone] ?? null;
      },
    }),
  }),
});

/** Capture the Twilio call without making one. */
function withFetch(fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: new URLSearchParams(init.body) });
    return { ok: true };
  };
  return fn(calls).finally(() => { globalThis.fetch = real; });
}

const load = () => import('./bookdesk.mjs');

// smsPartner is module-private, so exercise it through the exported surface it
// guards. If bookdesk stops exporting a way to reach it, this import fails
// loudly rather than passing vacuously.
const { __testables } = await load().then((m) => ({ __testables: m.__testables ?? null }));

test('bookdesk exposes its SMS gate for testing', () => {
  assert.ok(__testables?.smsPartner, 'worker/bookdesk.mjs must export __testables.smsPartner');
  assert.ok(__testables?.partnerMayBeTexted, 'worker/bookdesk.mjs must export __testables.partnerMayBeTexted');
});

test('a number with no consent row is never texted', async () => {
  await withFetch(async (calls) => {
    const sent = await __testables.smsPartner(
      { ...ENV, DB: dbWith({}) }, '+66812345678', 'table for two',
    );
    assert.equal(sent, false, 'a scraped number was texted');
    assert.equal(calls.length, 0, 'Twilio was called for a number with no consent on file');
  });
});

test('a revoked consent is a refusal, not a stale yes', async () => {
  await withFetch(async (calls) => {
    const sent = await __testables.smsPartner(
      { ...ENV, DB: dbWith({ '+66812345678': { revoked_at: 1_780_000_000 } }) },
      '+66812345678', 'table for two',
    );
    assert.equal(sent, false, 'STOP was ignored');
    assert.equal(calls.length, 0);
  });
});

test('an unreadable consent register fails CLOSED', async () => {
  // The register lives with the opt-in page and may be missing in a fresh
  // environment. Guessing "yes" when we cannot read permission is precisely
  // the failure this gate exists to prevent.
  await withFetch(async (calls) => {
    const sent = await __testables.smsPartner(
      { ...ENV, DB: dbWith({}, { throws: true }) }, '+66812345678', 'table for two',
    );
    assert.equal(sent, false, 'a broken consent lookup was treated as permission');
    assert.equal(calls.length, 0);
  });
});

test('a consented number is texted, with the brand and the way out in the body', async () => {
  await withFetch(async (calls) => {
    const sent = await __testables.smsPartner(
      { ...ENV, DB: dbWith({ '+66812345678': { revoked_at: null } }) },
      '+66812345678', 'Num booking request: table for 2',
    );
    assert.equal(sent, true);
    assert.equal(calls.length, 1);
    const body = calls[0].body;
    assert.match(body.get('Body'), /Num booking request: table for 2/, 'the message itself was lost');
    assert.match(body.get('Body'), /\bSTOP\b/, 'no opt-out language — a carrier requirement');
    assert.match(body.get('Body'), /\bHELP\b/, 'no HELP keyword — a carrier requirement');
    assert.match(body.get('Body'), /NUM/, 'the message does not say who it is from');
  });
});

test('every partner message asks for a delivery receipt', async () => {
  // Twilio returns 201 the moment it queues. Without StatusCallback, "texted"
  // means "we asked", and the guest is told the venue has their table on the
  // strength of it.
  await withFetch(async (calls) => {
    await __testables.smsPartner(
      { ...ENV, DB: dbWith({ '+66812345678': { revoked_at: null } }) },
      '+66812345678', 'table for two',
    );
    assert.match(
      calls[0].body.get('StatusCallback') ?? '',
      /\/api\/sms\/status$/,
      'no StatusCallback — there is no way to tell a delivered message from a filtered one',
    );
  });
});

test('missing Twilio credentials never reach the consent register', async () => {
  await withFetch(async (calls) => {
    const sent = await __testables.smsPartner({ DB: dbWith({}) }, '+66812345678', 'x');
    assert.equal(sent, false);
    assert.equal(calls.length, 0);
  });
});
