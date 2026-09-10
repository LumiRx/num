/**
 * EVERY BUTTON MUST REACH SOMETHING REAL.
 *
 * Dre, 10 Sep 2026: "why do you give me a button that doesnt work... never
 * give me a button that doesnt work again."
 *
 * The delete-account control looked wired at every individual layer — the
 * button called a helper, the helper POSTed a URL, the worker had a route,
 * the route had a handler, the handler had SQL. Every layer reviewed in
 * isolation looked finished. The chain still dead-ended, because a guard in
 * the middle could never be satisfied.
 *
 * So this file follows the WHOLE CHAIN for the controls that do something
 * irreversible: the component calls a named function, that function posts to a
 * path, and a route exists in the worker that serves that path. A layer that
 * only looks right next to its neighbours is how an unwired button ships.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const SOCIAL = read('./social.ts');
const DANGER = read('../components/app/DangerZone.tsx');
const INDEX = read('../../worker/index.mjs');
const ACCOUNT = read('../../worker/account.mjs');

describe('delete my account is wired from the tap to the database', () => {
  test('the button calls the helper', () => {
    assert.match(DANGER, /import \{ deleteAccount \} from '\.\.\/\.\.\/lib\/social'/);
    assert.match(DANGER, /await deleteAccount\(true\)/, 'the confirm step must actually call it');
    assert.match(DANGER, /await deleteAccount\(false\)/, 'the inspect step must actually call it');
  });

  test('the helper posts to a path the worker serves', () => {
    const m = /apiUrl\('(\/api\/account\/[a-z]+)'\)/.exec(SOCIAL);
    assert.ok(m, 'deleteAccount must post to an /api/account path');
    const [, path] = m;
    // The worker routes by prefix and hands the remainder to handleAccount.
    assert.match(INDEX, /url\.pathname\.startsWith\('\/api\/account'\)/);
    const rest = path.slice('/api/account'.length);
    assert.ok(
      ACCOUNT.includes(`path === '${rest}'`),
      `${path} has no handler — handleAccount does not answer '${rest}'`,
    );
  });

  test('the handler deletes the member row, not just related rows', () => {
    assert.match(ACCOUNT, /DELETE FROM num_members WHERE id=\?1/);
  });

  test('success tells the app to start over', () => {
    assert.match(ACCOUNT, /restart: true/);
    assert.match(SOCIAL, /out\?\.ok && out\?\.deleted/);
    assert.match(SOCIAL, /window\.location\.replace\('\/'\)/);
  });

  test('the device is emptied, not just localStorage', () => {
    // A reload that restores the old session from sessionStorage, a cache or
    // the service worker makes a completed deletion look like a failure.
    for (const bit of ['localStorage.clear()', 'sessionStorage.clear()', 'unregister()', 'store.set({ me: null })']) {
      assert.ok(SOCIAL.includes(bit), `${bit} is missing from the sign-out path`);
    }
  });

  test('a refusal reaches the user in words', () => {
    // The 409 carries `blockers` and no `note`, so a UI that only reads `note`
    // shows a shrug and the guard reads as a broken button.
    assert.match(DANGER, /out\.blockers\?\.length/);
  });
});

describe('nothing in the account flow can be satisfied only by us', () => {
  test('Stars are a forfeit, never a blocker', () => {
    // The regression that started all of this. If a Stars balance ever goes
    // back into `blockers`, every member holding Stars is trapped again.
    const i = ACCOUNT.indexOf('const blockers = [];');
    const j = ACCOUNT.indexOf('// Step one: show them the inventory');
    const guard = ACCOUNT.slice(i, j);
    assert.ok(!/blockers\.push\(`You still hold/.test(guard), 'Stars must not block deletion');
    assert.match(guard, /forfeits\.push\(`Your ★/);
  });
});
