import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathsFrom } from './console-api-agree.mjs';

test('it finds the endpoints the console calls', () => {
  const paths = pathsFrom(`
    api('assets').then(x)
    api('asset-photo', { a: 1 })
    api('book')
    fetch('/api/host/summary?k=' + k)
  `);
  assert.ok(paths.includes('/api/host/assets'));
  assert.ok(paths.includes('/api/host/asset-photo'));
  assert.ok(paths.includes('/api/host/book'));
  assert.ok(paths.includes('/api/host/summary'));
});

test('it does not invent endpoints from prose', () => {
  const paths = pathsFrom('we call the api() helper to reach the host api');
  assert.deepEqual(paths, []);
});

test('it finds the real consoles fleet endpoints, so this check is not decorative', () => {
  const html = readFileSync(new URL('../public/host/index.html', import.meta.url), 'utf8');
  const paths = pathsFrom(html);
  for (const p of ['/api/host/assets', '/api/host/asset-photo', '/api/host/asset-holds', '/api/host/asset-image']) {
    assert.ok(paths.includes(p), `${p} should be discovered in the real console`);
  }
  assert.ok(paths.length >= 8, `expected the console to call many endpoints, found ${paths.length}`);
});
