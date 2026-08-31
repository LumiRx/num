import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, isServiceSid, inspectAccount } from './twiliodiag.mjs';

const MG = 'MG64fac2280000000000000000000000aa';

test('it names the mistake that was actually made', () => {
  // The live value on 26-30 Aug started "Mqmc" — no Twilio prefix at all.
  const d = diagnose('Mqmc-something-pasted-from-elsewhere');
  assert.equal(d.ok, false);
  assert.equal(d.kind, 'not_a_sid');
  assert.equal(d.starts, 'Mqmc');
  assert.match(d.note, /not a Twilio SID/i);
});

test('each plausible mis-paste is identified by name, not just rejected', () => {
  // Every one of these sits on a console page next to the right value.
  assert.equal(diagnose('AC' + 'a'.repeat(32)).kind, 'wrong_sid_ac');
  assert.equal(diagnose('BN' + 'a'.repeat(32)).kind, 'wrong_sid_bn');
  assert.equal(diagnose('CM' + 'a'.repeat(32)).kind, 'wrong_sid_cm');
  assert.match(diagnose('AC' + 'a'.repeat(32)).note, /Account SID/);
});

test('a correct SID is recognised, and a near-miss is not', () => {
  assert.equal(diagnose(MG).ok, true);
  assert.equal(isServiceSid(MG), true);
  assert.equal(isServiceSid(`  ${MG}\n`), true, 'a trailing newline from a paste should not fail');
  assert.equal(isServiceSid('MG' + 'a'.repeat(31)), false, 'too short was accepted');
  assert.equal(isServiceSid('MG' + 'z'.repeat(32)), false, 'non-hex was accepted');
  assert.equal(diagnose('').kind, 'missing');
});

test('the recommendation needs BOTH an approved campaign and our number', () => {
  // A campaign-approved service that does not contain the number we send
  // from is still the wrong answer — that distinction is the whole job.
  const env = {
    TWILIO_SID: 'AC' + '1'.repeat(32),
    TWILIO_TOKEN: 'tok',
    TWILIO_FROM: '+14243460888',
  };
  const responses = {
    '/Services?PageSize=50': { services: [
      { sid: 'MG' + 'a'.repeat(32), friendly_name: 'Old / unused' },
      { sid: 'MG' + 'b'.repeat(32), friendly_name: 'Approved, wrong pool' },
      { sid: 'MG' + 'c'.repeat(32), friendly_name: 'The real one' },
    ] },
    [`/Services/MG${'a'.repeat(32)}/PhoneNumbers?PageSize=50`]: { phone_numbers: [] },
    [`/Services/MG${'a'.repeat(32)}/Compliance/Usa2p`]: { _error: 'HTTP 404' },
    [`/Services/MG${'b'.repeat(32)}/PhoneNumbers?PageSize=50`]: { phone_numbers: [{ phone_number: '+15550001111' }] },
    [`/Services/MG${'b'.repeat(32)}/Compliance/Usa2p`]: { campaign_status: 'APPROVED' },
    [`/Services/MG${'c'.repeat(32)}/PhoneNumbers?PageSize=50`]: { phone_numbers: [{ phone_number: '+14243460888' }] },
    [`/Services/MG${'c'.repeat(32)}/Compliance/Usa2p`]: { campaign_status: 'APPROVED' },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const path = String(u).replace('https://messaging.twilio.com/v1', '');
    return { ok: true, async json() { return responses[path] ?? {}; } };
  };
  return inspectAccount(env).then((out) => {
    globalThis.fetch = realFetch;
    assert.equal(out.ok, true);
    assert.equal(out.recommended.sid, 'MG' + 'c'.repeat(32),
      'picked a service that does not carry the number we send from');
    assert.equal(out.recommended.carries_our_number, true);
    // The near-miss must still be visible, not filtered away.
    assert.ok(out.services.some((s) => s.friendly_name === 'Approved, wrong pool'));
  });
});

test('it reads the secret names this repo actually uses', async () => {
  // TWILIO_SID/TWILIO_TOKEN are this codebase's names; the Twilio docs use
  // TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN. Reading only the doc names would
  // make this endpoint report "no credentials" on a Worker that has them.
  const realFetch = globalThis.fetch;
  let sawAuth = null;
  globalThis.fetch = async (_u, init) => {
    sawAuth = init?.headers?.Authorization ?? null;
    return { ok: true, async json() { return { services: [] }; } };
  };
  const out = await inspectAccount({ TWILIO_SID: 'AC' + '9'.repeat(32), TWILIO_TOKEN: 'tok' });
  globalThis.fetch = realFetch;
  assert.equal(out.ok, true, 'the repo\'s own secret names were not recognised');
  assert.ok(sawAuth?.startsWith('Basic '), 'no basic auth header was sent');
});

test('missing credentials are reported, never thrown', async () => {
  const out = await inspectAccount({});
  assert.equal(out.ok, false);
  assert.match(out.error, /TWILIO_SID/);
});
