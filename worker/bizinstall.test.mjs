// "Put NUM on your phone" — the business side.
//
// The member app has had a good version of this since August. A business had
// none, and a business is the party for whom it actually decides whether an
// order is seen: web push does not work from a browser tab on iOS, so an owner
// reading their dashboard in Safari learns about a request when they next
// happen to look.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  STEPS, appState, dismiss, ensure, installCard, markInstalled, platformOf, shouldShow,
} from './bizinstall.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      const st = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: st.all(...args), success: true };
      st.run(...args); return { results: [], success: true };
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes ?? 0) } }),
  });
  return {
    prepare(sql) { const b = (a) => ({ bind: (...m) => b([...a, ...m]), ...shape(sql, a) }); return b([]); },
    batch: async (s) => Promise.all(s.map((x) => x.run())),
  };
}

const db = new DatabaseSync(':memory:');
const env = { DB: d1(db) };

before(async () => { await ensure(env); });
beforeEach(() => { db.exec('DELETE FROM num_business_app'); });

describe('what we have been told', () => {
  test('nobody having said anything is not the same as "they have not"', async () => {
    // bizreadiness.mjs's rule, applied here: a missing evidence row yields
    // unknown, never false. Reporting "has not installed the app" about a
    // business we never asked is a number that will end up in a dashboard.
    const st = await appState(env, 'biz_1');
    assert.equal(st.known, false);
    assert.equal(st.installed, null, 'absence of evidence was reported as evidence');
  });

  test('they say it is on their phone, and we believe them', async () => {
    await markInstalled(env, 'biz_1');
    const st = await appState(env, 'biz_1');
    assert.equal(st.known, true);
    assert.equal(st.installed, true);
    assert.equal(shouldShow(st), false, 'they would still be nagged after doing it');
  });

  test('"not now" is remembered against the business, not the browser', async () => {
    // The owner who dismisses this on a laptop opens the console on a tablet
    // tomorrow. A cookie would ask again there, which is how a prompt becomes
    // noise.
    await dismiss(env, 'biz_1');
    const st = await appState(env, 'biz_1');
    assert.equal(st.dismissed, true);
    assert.equal(st.installed, false);
    assert.equal(shouldShow(st), false);
  });

  test('installing after dismissing clears the dismissal', async () => {
    await dismiss(env, 'biz_1');
    await markInstalled(env, 'biz_1');
    const st = await appState(env, 'biz_1');
    assert.equal(st.installed, true);
    assert.equal(st.dismissed, false);
  });

  test('one business saying yes does not answer for another', async () => {
    await markInstalled(env, 'biz_1');
    assert.equal((await appState(env, 'biz_2')).installed, null);
  });

  test('no database is unknown, never a false', async () => {
    assert.equal((await appState({}, 'biz_1')).installed, null);
    assert.equal((await markInstalled({}, 'biz_1')).ok, false);
  });
});

describe('the card', () => {
  test('the payoff comes before the instructions', () => {
    const html = installCard();
    const reason = html.indexOf('cannot ring');
    const firstStep = html.indexOf('<ol');
    assert.ok(reason > -1, 'the card never says why bothering is worth it');
    assert.ok(reason < firstStep,
      '"Add to Home Screen" with no reason given is a step people skip');
  });

  test('it says what actually arrives, not that "notifications" arrive', () => {
    const html = installCard();
    assert.match(html, /guest, the address and the total/,
      'a business turning on notifications deserves to know what one contains');
  });

  test('it points at the phone, not at whatever is rendering this page', () => {
    // The console is usually open on a laptop while the phone that needs the
    // app is in a pocket. Detecting the laptop answers the wrong question.
    assert.match(installCard().replace(/<[^>]+>/g, ''), /phone you actually carry/i);
  });

  test('iOS instructions name Safari, because Add to Home Screen is not in Chrome there', () => {
    // An owner who tries it in Chrome on iOS concludes the product is broken.
    assert.match(STEPS.ios.join(' '), /Safari/);
    assert.match(STEPS.ios.join(' '), /it has to be Safari/);
  });

  test('every platform gets three steps and none of them mention an app store', () => {
    for (const [name, steps] of Object.entries(STEPS)) {
      assert.equal(steps.length, 3, `${name} has a different number of steps`);
      assert.ok(!/app store|play store/i.test(steps.join(' ')),
        `${name} sends them somewhere NUM is not`);
    }
    assert.match(installCard(), /nothing to download from an app store/i);
  });

  test('it says which number to sign in with', () => {
    // Signing in with any other number reaches a member account with no
    // orders in it, which reads as "the app is broken".
    assert.match(installCard(), /number that claimed this listing/);
  });

  test('the session token is escaped into the form, not concatenated raw', () => {
    assert.match(installCard({ token: 'a"b<c' }), /value="a&quot;b&lt;c"/);
  });

  test('both buttons post, so the page works without JavaScript', () => {
    const html = installCard();
    assert.match(html, /<form method="post"/);
    assert.match(html, /name="action" value="app_installed"/);
    assert.match(html, /name="later" value="1"/);
  });
});

describe('platformOf', () => {
  test('reads the obvious ones and refuses to guess the rest', () => {
    assert.equal(platformOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), 'ios');
    assert.equal(platformOf('Mozilla/5.0 (iPad; CPU OS 17_0)'), 'ios');
    assert.equal(platformOf('Mozilla/5.0 (Linux; Android 14)'), 'android');
    assert.equal(platformOf('Mozilla/5.0 (Macintosh)'), 'other');
    assert.equal(platformOf(null), 'other');
  });
});

describe('the console shows it', () => {
  const src = readFileSync(join(HERE, 'bizconsole.mjs'), 'utf8');

  test('the overview renders the card', () => {
    assert.match(src, /bizinstall\.mjs/, 'the console never asks a business to install anything');
    assert.match(src, /extra\.appCard/);
  });

  test('both buttons are handled', () => {
    assert.match(src, /action === 'app_installed'/);
    const block = src.slice(src.indexOf("action === 'app_installed'"), src.indexOf("action === 'confirm'"));
    assert.match(block, /markInstalled/);
    assert.match(block, /dismiss/);
  });

  test('a listing nobody has claimed is not asked to install an app', () => {
    // There would be no account to sign into, and no orders to receive.
    const block = src.slice(src.indexOf('let appCard'), src.indexOf('return dashboard('));
    assert.match(block, /businessId &&/);
  });
});
