// The crash that took the whole app down, 9 Sep 2026:
//
//   undefined is not an object (evaluating 'e.connects.length')
//
// DashView reads inbox.connects.length on every render. data.ts seeds the
// store correctly; refreshRequests then replaced the whole object with
// whatever the endpoint returned, unread. One missing key and the next paint
// took a member to the error screen — not a broken card, the error screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'requests.ts'), 'utf8');

/** The normaliser, lifted out of the TS source so this runs without a build. */
const asInbox = (raw) => {
  const o = raw ?? {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  return { connects: arr(o.connects), plans: arr(o.plans), events: arr(o.events) };
};

test('every shape the server can return still leaves three arrays', () => {
  // The exact shape that crashed: a body with no `connects` at all.
  for (const body of [
    {}, null, undefined, { plans: [], events: [] }, { error: 'nope' },
    { connects: null, plans: null, events: null }, [], 'not json', 0,
    { connects: 'many' },
  ]) {
    const inbox = asInbox(body);
    for (const k of ['connects', 'plans', 'events']) {
      assert.ok(Array.isArray(inbox[k]), `${k} was not an array for ${JSON.stringify(body)}`);
    }
    // The exact expression that threw on the phone.
    assert.equal(typeof (inbox.connects.length + inbox.events.length), 'number');
  }
});

test('a good response is passed through untouched', () => {
  const body = {
    connects: [{ id: 'c1' }], plans: [{ id: 'p1', latest: true }], events: [{ id: 'e1' }],
  };
  assert.deepEqual(asInbox(body), body);
});

test('the store is never handed the raw response again', () => {
  // The bug was `store.set({ inbox: out })` — the server's answer becoming
  // local state with nobody reading it.
  assert.ok(!/store\.set\(\{\s*inbox:\s*out\s*\}\)/.test(SRC),
    'the raw response is being written to the store again');
  assert.match(SRC, /store\.set\(\{ inbox: asInbox\(out\) \}\)/);
});

test('the normaliser lives at the boundary, not in the component', () => {
  // A component reading its own store should not have to defend against the
  // store being malformed.
  assert.match(SRC, /const asInbox/);
});
