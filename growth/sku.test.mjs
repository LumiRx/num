// SKU numbers and their barcodes (growth/sku.mjs), and the retirement of the
// Ghost Message code they replace (22 Sep 2026).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanSku, nextSku, code128c, barcodeSvg } from './sku.mjs';

describe('a SKU', () => {
  test('is 4 to 12 digits, with typed spaces and dashes dropped', () => {
    assert.equal(cleanSku(' 69-43 '), '6943');
    assert.equal(cleanSku('000123456789'), '000123456789');
    assert.equal(cleanSku('123'), null);
    assert.equal(cleanSku('1234567890123'), null);
    assert.equal(cleanSku(''), null);
    assert.equal(cleanSku(null), null);
    assert.equal(cleanSku('roses'), null);
  });
  test('the next free one follows the highest in use, starting at 1001', () => {
    assert.equal(nextSku([]), '1001');
    assert.equal(nextSku(['1005', '1002', 'junk']), '1006');
    assert.equal(nextSku(['50']), '1001');
  });
});

describe('the barcode', () => {
  test('Code 128 checksum, even length', () => {
    assert.deepEqual(code128c('1234'), [105, 12, 34, 82, 106]);
  });
  test('an odd length ends in subset B, so the bars read the exact number', () => {
    assert.deepEqual(code128c('12345'), [105, 12, 34, 100, 21, 54, 106]);
  });
  test('is an SVG that prints the number and carries nothing else', () => {
    const svg = barcodeSvg('6943');
    assert.match(svg, /^<svg /);
    assert.match(svg, />6943<\/text>/);
    assert.doesNotMatch(svg, /<script|on\w+=/i);
  });
  test('an invalid SKU draws nothing', () => {
    assert.equal(barcodeSvg('12'), '');
    assert.equal(barcodeSvg('<img src=x>'), '');
  });
});

describe('Ghost Message is retired', () => {
  const worker = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  const host = readFileSync(new URL('../public/host/index.html', import.meta.url), 'utf8');
  test('a host can no longer create a ghost line', () => {
    assert.match(worker, /const HOST_PRODUCT_KINDS = \["own", "num"\];/);
  });
  test('the host console offers no Ghost option and names no Ghost Message', () => {
    assert.doesNotMatch(host, /value="ghost"/);
    assert.doesNotMatch(host, /Ghost Message/);
  });
  test('every product line carries a SKU, assigned when left blank', () => {
    assert.match(worker, /sku: cleanSku\(raw\.sku\)/);
    assert.match(worker, /p\.sku = nextSku\(/);
  });
  test('a venue menu item gets a SKU on add and can have it set by the owner', () => {
    assert.match(worker, /if \(!sku\) sku = nextSku\(await venueSkus\(env, who\.business\.id\)\);/);
    assert.match(worker, /if \(act === 'sku'\) \{/);
  });
});
