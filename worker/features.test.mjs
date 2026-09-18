// A feature registry is only worth having if it cannot lie. These are the
// three ways it could.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, statusOf, isOff, handleFeatures } from './features.mjs';

test('every feature declares the things that make it operable', () => {
  const ids = new Set();
  for (const f of FEATURES) {
    assert.ok(f.id && !ids.has(f.id), `${f.id}: ids must exist and be unique`);
    ids.add(f.id);
    assert.equal(typeof f.ready, 'function', `${f.id}: ready is derived from env, never declared`);
    for (const k of ['on', 'check', 'broken']) {
      assert.ok(f.sop?.[k]?.length > 10, `${f.id}: the SOP needs a real "${k}" line`);
    }
    assert.ok(f.code?.length, `${f.id}: name the files, so the next person starts in the right one`);
  }
});

test('a missing key reads as needs_setup and names the key, never its value', () => {
  const s = statusOf({}, FEATURES.find((f) => f.id === 'flightwatch'));
  assert.equal(s.state, 'needs_setup');
  assert.deepEqual(s.missing, ['AERODATABOX_KEY']);
  const on = statusOf({ AERODATABOX_KEY: 'sk-secret-value' }, FEATURES.find((f) => f.id === 'flightwatch'));
  assert.equal(on.state, 'on');
  assert.deepEqual(on.missing, []);
  assert.doesNotMatch(JSON.stringify(on), /sk-secret-value/, 'a key value must never leave features.mjs');
});

test('the off switch is an env var, so nobody has to ship a build at 2am', () => {
  const env = { AERODATABOX_KEY: 'k', NUM_OFF: 'flightwatch, tonight' };
  assert.equal(isOff(env, 'flightwatch'), true);
  assert.equal(isOff(env, 'tonight'), true, 'whitespace in the list is forgiven');
  assert.equal(isOff(env, 'concierge'), false);
  const s = statusOf(env, FEATURES.find((f) => f.id === 'flightwatch'));
  assert.equal(s.state, 'off', 'off beats ready — the switch is the last word');
  assert.match(s.switch, /remove "flightwatch"/, 'and it says how to undo itself');
});

test('the endpoint answers the operator question in one read', async () => {
  const body = await handleFeatures({ TICKETMASTER_API_KEY: 'k', NUM_OFF: 'runner' }).json();
  assert.ok(body.on >= 1);
  assert.ok(body.off.includes('runner'));
  assert.ok(body.needs_setup.includes('flightwatch'));
  assert.ok(body.features.every((f) => f.sop && f.state));
});
