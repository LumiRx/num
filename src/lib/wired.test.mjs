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
const PROFILE = read('../components/app/ProfileView.tsx');
const TYPES = read('./types.ts');
const DATA = read('./data.ts');
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


describe('one tap on the profile row produces the question', () => {
  test('the row opens the panel, it does not merely scroll', () => {
    // The bug: it scrolled to a control that stayed shut, so the page moved
    // and nothing else happened. Scrolling without opening is not an action.
    const i = PROFILE.indexOf('aria-label="Delete my account"');
    assert.ok(i > 0, 'the profile row is missing');
    const el = PROFILE.slice(Math.max(0, i - 900), i);
    assert.match(el, /store\.set\(\{ deleteOpen: true \}\)/, 'the row must open the flow');
    assert.match(el, /scrollIntoView/, 'and then bring it into view');
  });

  test('the flag exists in the store and starts closed', () => {
    assert.match(TYPES, /deleteOpen: boolean;/);
    assert.match(DATA, /deleteOpen: false,/);
  });

  test('DangerZone acts on the flag and clears it', () => {
    assert.match(DANGER, /useApp\(\(s\) => s\.deleteOpen\)/);
    assert.match(DANGER, /store\.set\(\{ deleteOpen: false \}\)/, 'a one-shot request, not a mode');
    assert.match(DANGER, /void inspect\(\)/);
  });

  test('inspect is defined before the effect that calls it', () => {
    // Both must also sit above `if (!me) return null` — a render with no
    // member would otherwise register an effect closing over an unassigned
    // const and throw out of the temporal dead zone.
    const ins = DANGER.indexOf('const inspect = async');
    const eff = DANGER.indexOf('const asked = useApp');
    const ret = DANGER.indexOf('if (!me) return null;');
    assert.ok(ins > 0 && eff > ins, 'inspect must be declared before the effect');
    assert.ok(ret > eff, 'both must sit above the early return');
  });

  test('inspecting asks before it destroys', () => {
    // "are you sure" then confirm, never a one-tap delete.
    assert.match(DANGER, /deleteAccount\(false\)/);
    assert.match(DANGER, /typed\.trim\(\)\.toUpperCase\(\) !== 'DELETE'\) return;/);
  });
});

describe('identity routes exist for every identity call the app will make', () => {
  const IDENTITY = readFileSync(new URL('../../worker/identity.mjs', import.meta.url), 'utf8');
  const WORKER = readFileSync(new URL('../../worker/index.mjs', import.meta.url), 'utf8');

  test('the worker routes /api/identity', () => {
    assert.match(WORKER, /url\.pathname\.startsWith\('\/api\/identity'\)/);
  });

  test('every sub-route the app needs is answered', () => {
    // Written before the UI, on purpose. A screen may only be built against a
    // route that already answers — that is the whole point of the
    // wire-before-you-ship rule.
    for (const rest of ["'/mine'", "'/scan'", "'/connections'", "'/claim-host'", "'/claim-business'"]) {
      assert.ok(WORKER.includes(`rest === ${rest}`), `/api/identity${rest} is not routed`);
    }
  });

  test('every route reaches a real exported function', () => {
    for (const fn of ['identityPayload', 'recordScan', 'connectionsFor', 'claimHost', 'claimBusinessByPhone', 'identitiesFor']) {
      assert.ok(WORKER.includes(`m.${fn}(`), `${fn} is imported but never called`);
      assert.ok(IDENTITY.includes(`export async function ${fn}(`), `${fn} is called but not exported`);
    }
  });

  test('a member cannot read another identity’s connections', () => {
    assert.match(WORKER, /not one of your identities/);
  });
});
