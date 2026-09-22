// The files that make a Num link open the Num app. See worker/applinks.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleAppLinks, appleAppSiteAssociation, assetLinks, IOS_APP_ID } from './applinks.mjs';

const pbx = readFileSync(new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
const ent = readFileSync(new URL('../ios/App/App/App.entitlements', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.app.jsonc', import.meta.url), 'utf8');

test('the iOS app id matches the team that signs the app', () => {
  const team = /DEVELOPMENT_TEAM = (\w+);/.exec(pbx)?.[1];
  assert.equal(IOS_APP_ID, `${team}.com.itsnum.app`);
});

test('only the share paths are claimed, never the whole site', () => {
  const paths = appleAppSiteAssociation().applinks.details[0].components.map((c) => c['/']);
  assert.deepEqual(paths.sort(), ['/c/*', '/i/*', '/r/*']);
});

test('served as JSON at both addresses Apple checks', async () => {
  for (const p of ['/.well-known/apple-app-site-association', '/apple-app-site-association']) {
    const res = handleAppLinks(new URL(`https://app.itsnum.com${p}`), {});
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'application/json');
    assert.equal((await res.json()).applinks.details[0].appIDs[0], IOS_APP_ID);
  }
  assert.equal(handleAppLinks(new URL('https://app.itsnum.com/c/mem_x'), {}), null);
});

test('Android trusts no guessed key', () => {
  assert.deepEqual(assetLinks({}), []);
  assert.deepEqual(assetLinks({ ANDROID_CERT_SHA256: 'nope' }), []);
  const fp = Array(32).fill('AB').join(':');
  assert.equal(assetLinks({ ANDROID_CERT_SHA256: fp })[0].target.sha256_cert_fingerprints[0], fp);
});

test('the app declares the domain and the Worker gets the request first', () => {
  assert.match(ent, /applinks:app\.itsnum\.com/);
  assert.match(wrangler, /"\/\.well-known\/\*"/, 'static assets would answer with the SPA page instead');
});

test('a carry-across code outlives an App Store download', () => {
  const src = readFileSync(new URL('./social.mjs', import.meta.url), 'utf8');
  assert.match(src, /const PAIR_TTL_MIN = 7 \* 24 \* 60;/);
});
