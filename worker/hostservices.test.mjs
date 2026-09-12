/**
 * ONE LIST OF SERVICES, IN THREE PLACES.
 *
 * What a host can say they do is written down three times:
 *
 *   growth/worker.js        HOST_SERVICES — what the API accepts
 *   worker/hostaware.mjs    HOST_SERVICES — what the concierge reasons over
 *   public/host/index.html  LABEL         — what the host actually reads
 *
 * Nothing checked they agreed. The two ways that breaks are both quiet: a key
 * in the API and not the labels renders to a host as `provisioning` instead of
 * a sentence, and a label with no key is an option the console offers and the
 * API refuses on save — with the host looking at the tick they just made.
 *
 * This is the same failure that already happened twice in this codebase: two
 * price sources that disagreed, and a fee the console advertised after it was
 * removed. Both were found by a person, late. This one is found here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_SERVICES } from './hostaware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, '..', p), 'utf8');

/** The array literal out of a source file, by its variable name. */
function listFrom(src, name) {
  const i = src.indexOf(name);
  assert.ok(i > 0, name + ' is gone');
  const open = src.indexOf('[', i);
  const close = src.indexOf(']', open);
  return src.slice(open + 1, close).split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

const growth = listFrom(read('growth/worker.js'), 'const HOST_SERVICES');
const console_ = (() => {
  const src = read('public/host/index.html');
  const i = src.indexOf('var LABEL = {');
  const body = src.slice(i, src.indexOf('};', i));
  return [...body.matchAll(/([a-z_]+)\s*:\s*'/g)].map((m) => m[1]);
})();

test('the API and the concierge agree on what a host can offer', () => {
  assert.deepEqual([...growth].sort(), [...HOST_SERVICES].sort());
});

test('every service a host can tick has a sentence a host can read', () => {
  const missing = HOST_SERVICES.filter((k) => !console_.includes(k));
  assert.deepEqual(missing, [],
    'these would render to a host as a raw key: ' + missing.join(', '));
});

test('every label in the console maps to a service the API will accept', () => {
  const orphan = console_.filter((k) => !HOST_SERVICES.includes(k));
  assert.deepEqual(orphan, [],
    'the console offers these and the API refuses them on save: ' + orphan.join(', '));
});

test('the luxury services are present in all three', () => {
  // Added 12 Sep. If somebody removes one, they have to remove it everywhere,
  // and this test is what makes that true.
  for (const k of ['yacht', 'jet', 'provisioning']) {
    assert.ok(HOST_SERVICES.includes(k), k + ' is gone from hostaware');
    assert.ok(growth.includes(k), k + ' is gone from the API');
    assert.ok(console_.includes(k), k + ' has no label');
  }
});

test('the original six are still there', () => {
  // Adding to this list must never quietly drop from it.
  for (const k of ['car', 'reservation', 'stay', 'activity', 'appointment', 'delivery']) {
    assert.ok(HOST_SERVICES.includes(k), k + ' was dropped');
  }
});

test('no duplicates crept into any copy', () => {
  for (const [name, list] of [['hostaware', HOST_SERVICES], ['growth', growth], ['console', console_]]) {
    assert.equal(new Set(list).size, list.length, name + ' has a duplicate key');
  }
});
