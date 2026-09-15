// Restoring from localStorage cannot take the app down.
//
// 15 Sep 2026, on an iPhone, while adding somebody:
//
//   undefined is not an object (evaluating 'e.connects.length')
//
// requests.ts had normalised the inbox as it arrives from the server since
// 9 Sep. The crash kept happening because there were TWO boundaries and only
// one was guarded: initialState spreads the saved blob straight over the
// defaults, so a malformed inbox written BEFORE that fix is restored on every
// launch, for as long as the app stays installed.
//
// The fix shipped, the crash continued, and the only escape for somebody
// already holding a bad value was deleting the app.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DATA = readFileSync(new URL('./data.ts', import.meta.url), 'utf8');
const TYPES = readFileSync(new URL('./types.ts', import.meta.url), 'utf8');
const DASH = readFileSync(new URL('../components/app/DashView.tsx', import.meta.url), 'utf8');

/** The list data.ts actually repairs, read out of the source. */
const REPAIRED = (() => {
  const block = /export const REPAIRED_ARRAYS = \[(.*?)\]/s.exec(DATA)[1];
  return [...block.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
})();

/** Every array field in AppState that survives persistable(). */
function persistedArrayFields() {
  const arrays = [...TYPES.matchAll(/^\s{2}([a-zA-Z]+)\??:\s*([A-Za-z<>\[\]{}| ]+?);$/gm)]
    .filter((m) => /\[\]|Array</.test(m[2])).map((m) => m[1]);
  const pers = DATA.slice(DATA.indexOf('export function persistable'), DATA.indexOf('} = s;'));
  const inner = pers.slice(pers.indexOf('const {') + 7);
  const excluded = new Set(inner.split(/[,\n]/)
    .map((t) => t.replace(/\/\/.*/, '').trim())
    .filter((t) => /^[a-zA-Z]+$/.test(t)));
  return arrays.filter((a) => !excluded.has(a));
}

/** The repair, lifted out of data.ts so the logic itself is exercised. */
function repairShapes(saved) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const out = { ...saved };
  const inbox = (out.inbox ?? {});
  out.inbox = { connects: arr(inbox.connects), plans: arr(inbox.plans), events: arr(inbox.events) };
  for (const k of REPAIRED) {
    if (k in out) out[k] = arr(out[k]);
  }
  return out;
}

describe('the exact value that crashed the app', () => {
  const crashes = (state) => {
    // What DashView does on every render.
    try { return typeof state.inbox.connects.length !== 'number'; } catch { return true; }
  };

  test('an inbox missing connects would crash, unrepaired', () => {
    assert.equal(crashes({ inbox: { plans: [], events: [] } }), true);
  });

  test('and does not, repaired', () => {
    assert.equal(crashes(repairShapes({ inbox: { plans: [], events: [] } })), false);
  });

  test('every shape a bad blob can take survives', () => {
    for (const bad of [
      undefined, null, {}, { inbox: undefined }, { inbox: null }, { inbox: {} },
      { inbox: [] }, { inbox: 'nope' }, { inbox: { connects: null } },
      { inbox: { connects: 'x', plans: 3, events: {} } },
      { inbox: { connects: [], plans: [] } },
    ]) {
      const fixed = repairShapes(bad ?? {});
      assert.equal(crashes(fixed), false, JSON.stringify(bad));
      assert.ok(Array.isArray(fixed.inbox.connects));
      assert.ok(Array.isArray(fixed.inbox.plans));
      assert.ok(Array.isArray(fixed.inbox.events));
    }
  });

  test('a good inbox is left exactly as it was', () => {
    const good = { inbox: { connects: [{ id: 'a' }], plans: [{ id: 'b' }], events: [] } };
    const out = repairShapes(good);
    assert.deepEqual(out.inbox.connects, [{ id: 'a' }]);
    assert.deepEqual(out.inbox.plans, [{ id: 'b' }]);
  });

  test('the repair does not invent fields the blob never had', () => {
    const out = repairShapes({ inbox: { connects: [] } });
    assert.equal('errands' in out, false);
    assert.equal('bookRequests' in out, false);
  });

  test('other iterated fields are repaired too, one screen further in', () => {
    const out = repairShapes({ msgs: null, errands: 'x', flightOffers: {}, bookRequests: 7 });
    for (const k of ['msgs', 'errands', 'flightOffers', 'bookRequests']) {
      assert.ok(Array.isArray(out[k]), k);
    }
  });
});

describe('the list cannot rot', () => {
  test('every saved array field is repaired', () => {
    // The first version of repairShapes listed six, chosen by looking at the
    // one crash that prompted it. This sweep found sixteen more — picks,
    // plans, bookings, friends, txns, memories and the rest — each one the
    // identical bug: a non-array in localStorage and an app that crashes on
    // every launch until it is deleted.
    //
    // Regenerated from types.ts and persistable() rather than typed out, so a
    // new array field added to the store cannot quietly reintroduce it.
    const missing = persistedArrayFields().filter((f) => !REPAIRED.includes(f));
    assert.deepEqual(missing, [], `saved arrays with no repair: ${missing.join(', ')}`);
  });

  test('the sweep itself still finds fields, so a broken regex cannot pass it', () => {
    // A parser that silently matches nothing would make the test above always
    // pass and protect nothing at all.
    assert.ok(persistedArrayFields().length >= 10);
  });

  test('a field no longer saved is still repaired, and is a real field', () => {
    // The extras are deliberate. A field persistable() now excludes was saved
    // by older builds and is still in localStorage on every phone that ran
    // them — which is exactly how the inbox crash survived being "fixed".
    //
    // What this checks is that each extra is a REAL AppState field rather than
    // a typo nobody would ever notice, since a misspelled name repairs nothing
    // and looks like it does.
    const saved = new Set(persistedArrayFields());
    const legacy = REPAIRED.filter((f) => !saved.has(f));
    assert.ok(legacy.length, 'the legacy group vanished — check persistable()');
    for (const f of legacy) {
      assert.match(TYPES, new RegExp(`^\\s{2}${f}\\??:`, 'm'), `${f} is not a field in AppState`);
    }
  });

  test('and the reason they stay is written down', () => {
    assert.match(DATA, /Removing a name from this list\s+\* only becomes safe once no installed build/);
  });
});

describe('the boundary is wired', () => {
  test('the repair runs on the saved blob before it is spread', () => {
    // Order matters: repairing after the spread would mean the bad value had
    // already reached the state object.
    assert.match(DATA, /\.\.\.repairShapes\(saved\), msgs, \.\.\.identity/);
  });

  test('the inbox is no longer persisted at all', () => {
    // It is server truth, re-read on open by refreshRequests — the same
    // reasoning already written for bookRequests, travelReferrals and dmInbox.
    const block = DATA.slice(DATA.indexOf('export function persistable'), DATA.indexOf('MAX_PERSISTED_MSGS)'));
    assert.match(block, /\n\s*inbox, \.\.\.keep \} = s;/);
  });

  test('and the reason is written down where the next person will look', () => {
    assert.match(DATA, /TWO boundaries and only one was guarded/);
    assert.match(DATA, /old blobs on old devices outlive the code that wrote them/);
  });

  test('DashView still reads the guarantee plainly, because it is now true', () => {
    // Not scattering optional chaining through the component: the store owes
    // it a shape, and now it actually keeps that promise on both paths.
    assert.match(DASH, /inbox\.connects\.length/);
  });
});
