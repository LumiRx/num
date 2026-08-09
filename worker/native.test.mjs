// The app-store build must never sell what Apple taxes, never beg for an
// install it already has, and never lose a push token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const native = readFileSync(join(HERE, '..', 'src', 'lib', 'native.ts'), 'utf8');

test('iOS never offers subscriptions — the Netflix model is code, not policy', () => {
  // Apple's 3.1.1 taxes digital subscriptions sold in-app on every
  // storefront outside the US. An app that offers none is compliant
  // everywhere with no regional forks. One function decides; UI obeys it.
  assert.match(native, /canOfferSubscription/, 'the gate function is gone');
  assert.match(native, /!== 'ios'/, "iOS no longer excluded — review will find the subscribe button and 3.1.1 the app");
});

test('the native app never asks to install itself', () => {
  const prompt = readFileSync(join(HERE, '..', 'src', 'components', 'app', 'InstallPrompt.tsx'), 'utf8');
  assert.match(prompt, /canOfferInstall\(\)/, 'InstallPrompt renders inside the app-store build — asking the installed to install');
  const stage = readFileSync(join(HERE, '..', 'src', 'components', 'canvas', 'LaunchStage.tsx'), 'utf8');
  assert.match(stage, /isNativeApp\(\)/, 'the native build shows the marketing landing to someone who already installed');
});

test('the app identity is ours on both platforms', () => {
  const cfg = readFileSync(join(HERE, '..', 'capacitor.config.ts'), 'utf8');
  assert.match(cfg, /appId: 'com\.itsnum\.app'/, 'the appId changed — it is permanent store identity and must never drift');
  assert.match(cfg, /webDir: 'dist'/, 'the app no longer bundles dist — a remote shell is a 4.2 rejection waiting');
  const gradle = readFileSync(join(HERE, '..', 'android', 'app', 'build.gradle'), 'utf8');
  assert.match(gradle, /applicationId "com\.itsnum\.app"/, 'Android still ships as com.getcapacitor.app');
});

test('push tokens have somewhere to go', () => {
  assert.match(native, /\/api\/push\/native/, 'native push registers but the token is posted nowhere — devices silently lost');
  assert.match(native, /requestPermissions/, 'push registers without asking permission first');
});
