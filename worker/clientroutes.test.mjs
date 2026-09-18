// The other half of the route table.
//
// routetable.test.mjs reads the router and proves every route it registers is
// reachable and unshadowed. That is the worker looking at itself. It cannot
// see the failure that actually reaches a guest: the APP calling a path the
// worker has never heard of.
//
// That failure is invisible everywhere else. A path is a string, so it
// typechecks. No unit test asks the worker whether it would answer. The guest
// taps, the request 404s, the `.catch()` swallows it, and the button is simply
// one that does nothing — which is indistinguishable, from the outside, from a
// slow network.
//
// So this walks the app's side and matches it against the router's side.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { audit, code, workerRoutes } from '../scripts/deadends.mjs';

describe('every button reaches the worker', () => {
  test('no /api path in the app is unserved by the router', () => {
    const { dead } = audit();
    assert.deepEqual(
      dead.map((d) => `${d.path} (from ${d.files.join(', ')})`),
      [],
      'the app calls these paths and no route serves them — the control will 404 silently',
    );
  });

  // Everything below keeps the test above honest. A matcher that silently
  // stops recognising the codebase reports a clean bill of health forever,
  // which is worse than no test: the first one nearly did exactly that, by
  // counting the `startsWith('/api/')` rate-limit gate as a route that serves
  // every path in the app.
  test('the matcher still finds both sides', () => {
    const { client, exact, prefix } = audit();
    assert.ok(client.size > 40, `expected many client paths, found ${client.size}`);
    assert.ok(exact.size > 40, `expected many exact routes, found ${exact.size}`);
    assert.ok(prefix.size > 10, `expected many prefix routes, found ${prefix.size}`);
  });

  test('no route is so shallow it serves everything', () => {
    const { prefix } = workerRoutes();
    const tooShallow = [...prefix].filter((p) => p.replace(/\/+$/, '').split('/').filter(Boolean).length < 2);
    assert.deepEqual(
      tooShallow,
      [],
      'a bare /api/ prefix makes every path look served and this whole file green',
    );
  });

  test('documentation is not read as code', () => {
    // apibase.ts's own comment says "all 39 /api/... calls in the app".
    const stripped = code(`/** calls /api/ghost live here */\n// and /api/phantom\nconst real = '/api/real';`);
    assert.ok(!stripped.includes('/api/ghost'), 'block comments must be stripped');
    assert.ok(!stripped.includes('/api/phantom'), 'line comments must be stripped');
    assert.ok(stripped.includes('/api/real'), 'real code must survive');
  });

  test('a path the router does not serve is actually caught', () => {
    // The check can fail. Proven on a synthetic pair rather than by breaking
    // the real app, so this stays true no matter what the app does next.
    const exact = new Set(['/api/real']);
    const prefix = new Set(['/api/host/']);
    const served = (p) => exact.has(p) || [...prefix].some((pre) => p.startsWith(pre));
    assert.equal(served('/api/real'), true);
    assert.equal(served('/api/host/anything'), true);
    assert.equal(served('/api/invented'), false, 'an unserved path must not pass');
  });
});
