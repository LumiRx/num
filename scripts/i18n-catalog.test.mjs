import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collect, current } from './i18n-catalog.mjs';

test('src/i18n/catalog.json matches every t() in src — run node scripts/i18n-catalog.mjs', () => {
  const fresh = collect();
  const have = current();
  assert.ok(have, 'catalog missing');
  assert.equal(have.hash, fresh.hash, `stale: ${have.strings.length} saved, ${fresh.strings.length} in source`);
});
