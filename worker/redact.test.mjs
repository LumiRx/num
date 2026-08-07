// What a model is allowed to see.
//
// A vendor's no-training policy is a promise about data they already have.
// This is the layer that decides what they get, and it is the only protection
// that survives a change of provider. These tests exist because the failure is
// silent: a guest's phone number reaching a model looks exactly like a working
// product from the outside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactProfile, redactState, isIdentifying } from './redact.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('identifiers never reach the prompt, whatever the key is called', () => {
  const { profile, removed } = redactProfile({
    name: 'Andre Smith',
    guestPhone: '+66 81 234 5678',
    contact_no: '0812345678',
    email: 'a@b.com',
    hotel_room: '412',
    party_size: 4,
    likes: 'seafood, quiet places',
  });
  for (const leaked of ['name', 'guestPhone', 'contact_no', 'email', 'hotel_room']) {
    assert.ok(!(leaked in profile), `${leaked} was sent to the model`);
  }
  assert.equal(profile.party_size, 4, 'party size was dropped — it makes the answer better and identifies nobody');
  assert.equal(profile.likes, 'seafood, quiet places', 'preferences were dropped; the concierge is now worse for no gain');
  assert.equal(removed, 5);
});

test('a phone number is caught even under an innocent key name', () => {
  // The denylist cannot know every field a client will invent. Matching the
  // SHAPE of an identifier is what makes this hold as the app changes.
  const { profile } = redactProfile({ note: 'call me on +66 81 234 5678', ref: 'ok' });
  assert.ok(!('note' in profile), 'a phone number rode through inside a free-text field');
  assert.equal(profile.ref, 'ok');
});

test('nested state is cleaned at every depth', () => {
  // The whole state object is stringified into the prompt, so a number three
  // levels down inside a booking is exactly as exposed as one at the top.
  const { state, removed } = redactState({
    party: 4,
    bookings: [{ id: 'b1', guest: { full_name: 'Andre', phone: '+66812345678' }, table: 'window' }],
  });
  const b = state.bookings[0];
  assert.equal(b.guest.full_name, '[redacted]', 'a name nested in a booking reached the model');
  assert.equal(b.guest.phone, '[redacted]', 'a phone nested in a booking reached the model');
  assert.equal(b.table, 'window', 'useful booking detail was destroyed');
  assert.equal(state.party, 4);
  assert.equal(removed, 2);
});

test('redacted values are marked, not deleted', () => {
  // A model that sees a missing key asks the guest for it — which is precisely
  // what KNOWN FACTS exists to prevent. The key stays; the value goes.
  const { state } = redactState({ guest: { phone: '+66812345678' } });
  assert.equal(state.guest.phone, '[redacted]');
});

test('redaction does not mutate the caller’s object', () => {
  const original = { name: 'Andre', party: 2 };
  redactProfile(original);
  assert.equal(original.name, 'Andre', 'the source object was mutated — state elsewhere is now silently altered');
});

test('every brain is downstream of the filter', () => {
  // The point of doing this in askNum rather than per-provider: a new brain
  // added next month is protected without anyone remembering to protect it.
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  assert.match(index, /profile: safeProfile\.profile/,
    'the raw profile is being printed as KNOWN FACTS again');
  assert.match(index, /JSON\.stringify\(safeState\.state\)/,
    'the raw state is being stringified into the prompt again');
  assert.ok(!/JSON\.stringify\(state\)/.test(index),
    'an unredacted state stringify is back — identifiers would reach every model');
});

test('the redaction log records the count and not the contents', () => {
  // Logging which fields were dropped would move them from the prompt into the
  // log, which is not an improvement.
  const src = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  const line = src.slice(src.indexOf('redacted ${'), src.indexOf('redacted ${') + 200);
  assert.ok(!/safeProfile\.profile\b.*\$\{/.test(line), 'the log interpolates the redacted values');
  assert.match(line, /removed/, 'the log no longer reports how much was redacted');
});

test('a preference that merely mentions a person is kept', () => {
  // Over-redaction has a cost too: strip everything and the concierge forgets
  // the guest between turns.
  assert.equal(isIdentifying('likes', 'quiet places, no loud music'), false);
  assert.equal(isIdentifying('party_size', 4), false);
  assert.equal(isIdentifying('budget', 'mid'), false);
});
