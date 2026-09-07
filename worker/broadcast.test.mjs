import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  tzFor, withinHours, checkMessage, select, broadcast, QUIET, SEGMENT,
} from './broadcast.mjs';
import {
  record, reachable, audience, validPhone, inboundConsentText, SOURCE, CONSENT_VERSION,
} from './smsconsent.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, 'broadcast.mjs'), 'utf8');
const SMS = readFileSync(join(here, 'sms.mjs'), 'utf8');

const GOOD = 'NUM here — your concierge. Ask me for anything in Phuket tonight. Reply STOP to opt out.';

/** D1 stand-in holding a consent register. */
function db(consent = [], optouts = []) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        bind: (...a) => ({
          first: async () => {
            if (/FROM num_sms_consent WHERE phone/.test(sql)) return consent.find((c) => c.phone === a[0]) ?? null;
            if (/FROM num_(text_)?optouts/.test(sql)) return optouts.includes(a[0]) ? { x: 1 } : null;
            return null;
          },
          // Deliberately does NOT filter opt-outs: reachable() is the check
          // under test, and a stub that pre-filters would prove nothing.
          all: async () => ({ results: consent.filter((c) => !c.revoked_at) }),
          run: async () => { writes.push({ sql, a }); return { meta: { changes: 1 } }; },
        }),
        first: async () => {
          if (/SUM\(CASE WHEN revoked_at IS NULL/.test(sql)) {
            return {
              total: consent.length,
              live: consent.filter((c) => !c.revoked_at).length,
              revoked: consent.filter((c) => c.revoked_at).length,
            };
          }
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 1 } }),
      };
    },
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   THE LIST IS NOT THE LIST

   Num holds 1,830,191 scraped business numbers and 87,210 more on leads.
   `num_sms_consent` held zero rows. A single unconsented text to a US mobile
   is $500–$1,500 in TCPA statutory damages, and the A2P campaign would reject
   the send anyway.
   ───────────────────────────────────────────────────────────────────────── */

test('the scraped tables are not reachable from the send path at all', () => {
  assert.ok(!/FROM places/i.test(SRC), 'places.phone must not be selectable here');
  assert.ok(!/FROM leads/i.test(SRC), 'leads.phone must not be selectable here');
  assert.match(SRC, /FROM num_sms_consent c/, 'the only source of an audience is the consent register');
});

test('an empty audience refuses, and says why a bigger list is the wrong answer', async () => {
  const r = await broadcast({ DB: db([]) }, { body: GOOD, live: true, sendOne: async () => ({ ok: true }) });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'audience');
  assert.equal(r.consented, 0);
  assert.match(r.why, /scraped, not offered/);
  assert.match(r.why, /TCPA claim per message/);
  assert.match(r.why, /grows the moment people start texting/, 'a refusal with no way forward is a dead end');
});

test('a dry run is the default — sending is something you have to type', async () => {
  const DB = db([{ phone: '+66812345678', revoked_at: null }]);
  let calls = 0;
  const r = await broadcast({ DB }, {
    body: GOOD, sendOne: async () => { calls += 1; return { ok: true }; }, now: new Date('2026-09-01T05:00:00Z'),
  });
  assert.equal(r.ok, true);
  assert.equal(r.live, false);
  assert.equal(calls, 0, 'a preview must not send');
  assert.equal(r.sent, 1, 'but it must still report who would have been reached');
});

/* ── CONSENT IS CHECKED PER RECIPIENT, AT SEND TIME ─────────────────────
   Somebody who texts STOP while a broadcast is running must not receive the
   rest of it. */

test('a revoked number is skipped even though it is in the register', async () => {
  const DB = db([
    { phone: '+66812345678', revoked_at: null },
    { phone: '+66899999999', revoked_at: 1787000000 },
  ]);
  const r = await broadcast({ DB }, { body: GOOD, live: true, sendOne: async () => ({ ok: true }), now: new Date('2026-09-01T05:00:00Z') });
  assert.equal(r.sent, 1);
  assert.ok(!r.detail.sent.some((s) => s.phone === '+66899999999'));
});

test('an opted-out number is skipped even with consent on file', async () => {
  const DB = db([{ phone: '+66812345678', revoked_at: null }], ['+66812345678']);
  const r = await broadcast({ DB }, { body: GOOD, live: true, sendOne: async () => ({ ok: true }), now: new Date('2026-09-01T05:00:00Z') });
  assert.equal(r.sent, 0);
  assert.match(r.detail.skipped[0].why, /opt-out list/);
});

// An error reading the consent register must never be read as permission.
test('a broken consent check fails closed, never open', async () => {
  const r = await reachable({ DB: { prepare() { throw new Error('D1 gone'); } } }, '+66812345678');
  assert.equal(r.ok, false);
  assert.match(r.why, /consent check failed/);
});

test('no consent row at all is not reachable', async () => {
  assert.equal((await reachable({ DB: db([]) }, '+66812345678')).ok, false);
  assert.equal((await reachable({}, '+66812345678')).ok, false);
});

/* ── QUIET HOURS, IN THEIR TIMEZONE ─────────────────────────────────────
   The TCPA rule is 8am–9pm local to the CALLED party. Texting Phuket at a
   civilised Edinburgh hour is both an offence and a fast way to be reported. */

test('the hour is judged where they are, not where we are', () => {
  const at = new Date('2026-09-01T03:00:00Z'); // 10am Bangkok, 4am London
  assert.equal(withinHours('+66812345678', at).ok, true, '10am in Bangkok is fine');
  assert.equal(withinHours('+447700900123', at).ok, false, '4am in London is not');
});

test('the quiet window is the statutory one', () => {
  assert.equal(QUIET.to, 8);
  assert.equal(QUIET.from, 21);
  // 11:00Z is 07:00 in New York in September — one hour BEFORE the statutory
  // window opens. The first draft of this test asserted it was fine, which is
  // exactly the hour a real blast would have gone out on.
  assert.equal(withinHours('+12125550100', new Date('2026-09-01T11:00:00Z')).ok, false, '7am ET is too early');
  assert.equal(withinHours('+12125550100', new Date('2026-09-01T14:00:00Z')).ok, true, '10am ET is fine');
  assert.equal(withinHours('+12125550100', new Date('2026-09-01T05:00:00Z')).ok, false, '1am ET is not');
});

test('an unknown country is refused rather than guessed at', () => {
  const r = withinHours('+99912345678');
  assert.equal(r.ok, false);
  assert.match(r.why, /refusing rather than guessing/);
});

test('the longest dialling prefix wins, so +1 does not swallow others', () => {
  assert.equal(tzFor('+12125550100'), 'America/New_York');
  assert.equal(tzFor('+971501234567'), 'Asia/Dubai');
  assert.equal(tzFor('+66812345678'), 'Asia/Bangkok');
  assert.equal(tzFor('+441315582300'), 'Europe/London');
});

test('quiet hours skip without sending', async () => {
  const DB = db([{ phone: '+447700900123', revoked_at: null }]);
  let calls = 0;
  const r = await broadcast({ DB }, {
    body: GOOD, live: true, now: new Date('2026-09-01T03:00:00Z'),
    sendOne: async () => { calls += 1; return { ok: true }; },
  });
  assert.equal(calls, 0);
  assert.match(r.detail.skipped[0].why, /quiet hours/);
});

/* ── THE MESSAGE ITSELF ─────────────────────────────────────────────── */

test('a broadcast must name NUM and say how to stop', () => {
  assert.equal(checkMessage(GOOD).ok, true);
  assert.match(checkMessage('Ask me for anything tonight. Reply STOP to opt out.').problems.join(' '), /must name NUM/);
  assert.match(checkMessage('NUM here — ask me anything tonight.').problems.join(' '), /how to STOP/);
});

test('spam wording is refused, because carriers drop it and Num does not talk like that', () => {
  const r = checkMessage('NUM: FREE upgrade, click here now! Guaranteed. Reply STOP to opt out.');
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /carrier spam filters/);
});

test('an over-long message is caught before it costs three segments each', () => {
  const long = `NUM ${'x'.repeat(SEGMENT * 3)} STOP`;
  assert.match(checkMessage(long).problems.join(' '), /more than three segments/);
  assert.equal(checkMessage('').ok, false);
});

test('a bad message never reaches the audience query', async () => {
  const DB = db([{ phone: '+66812345678', revoked_at: null }]);
  const r = await broadcast({ DB }, { body: 'hello', live: true, sendOne: async () => ({ ok: true }) });
  assert.equal(r.stage, 'message');
});

/* ── THE CONSENT RECORD ─────────────────────────────────────────────── */

test('consent needs evidence, not a boolean', async () => {
  const DB = db();
  assert.match((await record({ DB }, { phone: '+66812345678', source: SOURCE.INBOUND_SMS })).error, /not evidence/);
  assert.match((await record({ DB }, { phone: '0812345678', source: SOURCE.INBOUND_SMS, consentText: 'x' })).error, /E\.164/);
  assert.match((await record({ DB }, { phone: '+66812345678', source: 'vibes', consentText: 'x' })).error, /unknown consent source/);
});

test('the record quotes what they actually sent', () => {
  const t = inboundConsentText('table for two tonight near the beach');
  assert.match(t, /initiating contact/);
  assert.match(t, /"table for two tonight near the beach"/);
});

// The FIRST consent is the one that matters if it is ever challenged.
test('a repeat opt-in clears the revocation without destroying the original evidence', async () => {
  const DB = db();
  await record({ DB }, { phone: '+66812345678', source: SOURCE.INBOUND_SMS, consentText: 'first message' });
  const sql = DB.writes[0].sql;
  assert.match(sql, /ON CONFLICT\(phone\) DO UPDATE SET revoked_at = NULL/);
  assert.ok(!/DO UPDATE SET consent_text/.test(sql), 'overwriting the original text destroys the evidence trail');
});

test('the source is stamped into the stored text, so provenance survives', async () => {
  const DB = db();
  await record({ DB }, { phone: '+66812345678', source: SOURCE.WEB_FORM, consentText: 'ticked the box' });
  assert.match(DB.writes[0].a[3], /^\[web_form\] ticked the box/);
  assert.equal(DB.writes[0].a[4], CONSENT_VERSION);
});

test('the audience count is the number of people who said yes', async () => {
  const a = await audience({ DB: db([{ phone: '+1', revoked_at: null }, { phone: '+2', revoked_at: 1 }]) });
  assert.equal(a.consented, 1);
  assert.equal(a.revoked, 1);
  assert.equal(validPhone('+66812345678'), true);
  assert.equal(validPhone('812345678'), false);
});

/* ─────────────────────────────────────────────────────────────────────────
   WHERE THE AUDIENCE COMES FROM

   The opt-in branch used to be an UPDATE and nothing else, so a person
   texting START with no existing row changed nothing: zero rows matched, no
   consent recorded, still unreachable. That was the one path that could have
   built a lawful list, and it silently did nothing.
   ───────────────────────────────────────────────────────────────────────── */

test('texting START now creates a consent row rather than updating nothing', () => {
  assert.match(SMS, /source: SOURCE\.KEYWORD/);
  assert.match(SMS, /async function applyOptOut\(env, phone, word, body = ''\)/,
    'the message body is the evidence and must be passed in');
  assert.match(SMS, /await applyOptOut\(env, from, single, text\)/);
});

test('any ordinary inbound message is consent, not only the keyword', () => {
  assert.match(SMS, /EVERY ORDINARY INBOUND MESSAGE IS CONSENT/);
  assert.match(SMS, /source: c\.SOURCE\.INBOUND_SMS/);
});

test('the consent write happens after the STOP branch, never before', () => {
  assert.ok(
    SMS.indexOf('await applyOptOut(env, from, single, text)') < SMS.indexOf('EVERY ORDINARY INBOUND MESSAGE IS CONSENT'),
    'a revocation must never be recorded as an opt-in',
  );
});

test('a failed consent write never costs somebody their answer', () => {
  const i = SMS.indexOf('EVERY ORDINARY INBOUND MESSAGE IS CONSENT');
  assert.match(SMS.slice(i, i + 1200), /consent record failed/);
  assert.match(SMS.slice(i, i + 1200), /\.catch\(/, 'the consent write must swallow its own failure');
});
