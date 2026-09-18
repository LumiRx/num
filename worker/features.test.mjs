// A feature registry is only worth having if it cannot lie. These are the
// ways it could.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FEATURES, statusOf, isOff, handleFeatures, auditFeatures } from './features.mjs';
import { tiers, UNGATED } from './membership.mjs';

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

// ── WHAT A GUEST GETS FOR WHAT THEY PAY ────────────────────────────────

test('every feature says which plan it belongs to, and the plan is a real one', () => {
  const real = Object.keys(tiers({}));
  for (const f of FEATURES) {
    assert.ok(real.includes(f.plan), `${f.id}: plan "${f.plan}" is not one of ${real.join(', ')}`);
  }
  assert.deepEqual(auditFeatures(real), [], 'the registry audits itself clean');
});

test('travel is free on every plan, and the registry cannot say otherwise', () => {
  // B&P §17550.27 — see the header of membership.mjs. This is the test that
  // stops a future edit quietly moving a travel feature behind a price.
  for (const f of FEATURES.filter((x) => x.ungated)) {
    assert.equal(f.plan, 'free', `${f.id} is a travel benefit and must be free on every plan`);
  }
  // And the other direction: anything naming an UNGATED entitlement must be
  // marked ungated, or the marker rots away one careless copy-paste at a time.
  for (const f of FEATURES.filter((x) => UNGATED.includes(x.entitlement))) {
    assert.equal(f.ungated, true, `${f.id} meters ${f.entitlement}, which is ungateable — mark it`);
  }
});

test('an entitlement a feature names must exist in the tier table', () => {
  const known = new Set(Object.values(tiers({})).flatMap((t) => Object.keys(t.entitlements ?? {})));
  for (const f of FEATURES.filter((x) => x.entitlement)) {
    assert.ok(known.has(f.entitlement), `${f.id}: "${f.entitlement}" is in no tier — the gate would never fire`);
  }
});

test('the registry never claims a limit is enforced when it is not', () => {
  // 18 Sep 2026, morning: may() had zero callers in the whole product, so
  // every paid limit was decorative and this test asserted an empty list.
  // 18 Sep 2026, later: two real gates went in, so the list is exactly those
  // two. It is still a list nobody may lengthen by accident — adding an id
  // here without a may() call in the named file is the lie this guards.
  const body = FEATURES.map((f) => statusOf({}, f));
  assert.deepEqual(body.filter((f) => f.enforced).map((f) => f.id).sort(), ['plans', 'research'],
    'if you enforced a limit, add it to ENFORCED in features.mjs and name the call site here');
  // And an enforced feature must be metered by something, or there is nothing
  // for the call site to have asked about.
  for (const f of body.filter((x) => x.enforced)) {
    assert.ok(f.entitlement, `${f.id} is enforced but names no entitlement`);
  }
  assert.ok(body.filter((f) => f.entitlement).length >= 5, 'and the metered list is not empty');
});

test('the two enforced gates have a real may() call where they claim to', () => {
  // The registry says where each gate lives. If the file stops calling may(),
  // the claim on /api/features becomes false and the pricing page becomes a
  // lie — so the claim is checked against the source, not taken on trust.
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(read('./social.mjs'), /may\(env, meId, 'plans_max'/, 'plans_max gate is in social.mjs');
  assert.match(read('./research.mjs'), /may\(env, me, 'deep_research_monthly'\)/, 'research gate is in research.mjs');
});

test('every surface a guest can meet is named, so nothing ships invisible', async () => {
  const body = await handleFeatures({}).json();
  assert.deepEqual(body.audit, [], 'the live endpoint reports its own problems');
  assert.ok(body.plans.ungated.includes('flights'), 'flight search is ungated, publicly');
  assert.ok(body.features.length >= 30, 'the registry is the whole product, not a sample');
});
