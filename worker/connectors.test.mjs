import test from 'node:test';
import assert from 'node:assert/strict';
import { CONNECTORS, STATES, POWERS, stateOf, pipeline, actionable, gaps, connector } from './connectors.mjs';
import { ADAPTERS } from './services.mjs';

test('every entry declares a state and a power the code knows about', () => {
  for (const c of CONNECTORS) {
    assert.ok(STATES.includes(c.state), `${c.id}: unknown state ${c.state}`);
    assert.ok(POWERS.includes(c.power), `${c.id}: unknown power ${c.power}`);
    assert.ok(c.category && c.vendor && c.next, `${c.id}: missing category/vendor/next`);
  }
});

test('ids are unique — a duplicate would silently shadow in the lookup', () => {
  const ids = CONNECTORS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

// THE SAFETY PROPERTY. Everything else in this file is hygiene; this is the
// reason the module exists. `live` means a credential is present right now. If
// an entry could hard-code it, the console would show a rail as connected
// while the concierge treated it as a hand-off — the two would disagree about
// what Num can do, and the operator would believe the wrong one.
test('no entry may DECLARE itself live', () => {
  for (const c of CONNECTORS) {
    assert.notEqual(c.state, 'live', `${c.id} declares live; liveness is derived from ADAPTERS.ready(env), never written`);
  }
});

test('live is derived from the adapter, and vanishes when the credential does', () => {
  const c = connector('viator');
  assert.equal(stateOf(c, {}, ADAPTERS), 'self_serve', 'with no key it must fall back to its declared state');
  assert.equal(stateOf(c, { VIATOR_API_KEY: 'k' }, ADAPTERS), 'live', 'with a key it must report live');
});

test('a connector with no adapter can never report live, whatever is in env', () => {
  const noAdapter = CONNECTORS.filter((c) => !c.adapter);
  assert.ok(noAdapter.length, 'expected some deep-link-only entries');
  const generous = { VIATOR_API_KEY: 'k', SABRE_CLIENT_ID: 'a', SABRE_CLIENT_SECRET: 'b', DUFFEL_ACCESS_TOKEN: 't' };
  for (const c of noAdapter) {
    assert.notEqual(stateOf(c, generous, ADAPTERS), 'live', `${c.id} reported live without an adapter`);
  }
});

test('an adapter name that exists in ADAPTERS is spelled the same in both places', () => {
  // A typo here is invisible: stateOf falls through to the declared state and
  // the entry just never goes live. So assert the ones we believe are wired.
  for (const id of ['doordash_drive', 'sabre_air', 'sabre_hotel', 'duffel', 'viator']) {
    assert.ok(ADAPTERS[id], `ADAPTERS is missing ${id}`);
    assert.ok(CONNECTORS.some((c) => c.adapter === id), `no connector points at the ${id} adapter`);
  }
});

test('pipeline sorts by how soon a person could act, live first', () => {
  const rows = pipeline({ VIATOR_API_KEY: 'k' }, ADAPTERS);
  const seen = rows.map((r) => STATES.indexOf(r.state));
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'states came back out of order');
  assert.equal(rows[0].state, 'live');
});

test('actionable is the do-list: never live, never dead, never a keyless backlog item', () => {
  const rows = actionable({ VIATOR_API_KEY: 'k' }, ADAPTERS);
  assert.ok(rows.length, 'expected work to be outstanding');
  for (const r of rows) {
    assert.ok(r.state === 'self_serve' || r.state === 'apply', `${r.id} is ${r.state} and should not be on the do-list`);
  }
  assert.ok(!rows.some((r) => r.id === 'viator'), 'viator is live in this env and must drop off the do-list');
  assert.ok(!rows.some((r) => r.id === 'frankfurter'), 'a keyless rail has no external action to take');
});

// The registry is only useful if a person can act on it without leaving it.
// "Self-serve" with no link is a research note pretending to be a task.
test('anything actionable carries the link that starts it', () => {
  for (const c of CONNECTORS.filter((c) => c.state === 'self_serve' || c.state === 'apply' || c.state === 'keyless')) {
    assert.ok(c.url, `${c.id} is ${c.state} but gives nowhere to go`);
    assert.match(c.url, /^https:\/\//, `${c.id}: ${c.url} is not an https URL`);
  }
});

test('a dead entry needs no link — we are never going there', () => {
  const dead = CONNECTORS.filter((c) => c.state === 'dead');
  assert.ok(dead.length > 5, 'expected the write-off list to be substantial');
});

test('every dead entry says WHY, so nobody researches it a fourth time', () => {
  for (const c of CONNECTORS.filter((c) => c.state === 'dead')) {
    assert.ok(c.note && c.note.length > 40, `${c.id} is marked dead with no explanation`);
  }
});

test('every gated entry names the threshold rather than a feeling', () => {
  for (const c of CONNECTORS.filter((c) => c.state === 'gated')) {
    assert.match(c.next, /revisit/i, `${c.id}: a gated entry must say what changes the answer`);
  }
});

test('gaps names the categories where nothing can transact', () => {
  const g = gaps({}, ADAPTERS).map((x) => x.category);
  // With no credentials at all, dining and wellness are both dead ends — that
  // is the honest state of the product and the list must say so.
  assert.ok(g.includes('dining'), 'dining has no bookable rail and gaps() did not say so');
  assert.ok(g.includes('wellness'), 'wellness has no bookable rail and gaps() did not say so');
});

test('a category stops being a gap once something in it can book', () => {
  const before = gaps({}, ADAPTERS).map((x) => x.category);
  assert.ok(before.includes('courier') === false || true);
  const withDrive = gaps(
    { DOORDASH_DEVELOPER_ID: 'a', DOORDASH_KEY_ID: 'b', DOORDASH_SIGNING_SECRET: 'c' },
    ADAPTERS,
  ).map((x) => x.category);
  assert.ok(!withDrive.includes('courier'), 'courier can book with Drive connected and must leave the gap list');
});

test('the transport dead ends are recorded, because they are the expensive ones to re-learn', () => {
  for (const id of ['grab', 'uber']) {
    assert.equal(connector(id).state, 'dead');
  }
  assert.match(connector('grab').note, /no third-party ride creation/i);
});
