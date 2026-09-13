// The Official Rules page.
//
// A HANDLER IS NOT A ROUTE. On 12 Sep 2026 this page was written, wired into
// the worker, tested and deployed — and still returned 404, because nothing in
// growth/wrangler.jsonc sent that path to the growth worker. The same omission
// had already shipped /api/pay/* and /p/* broken for weeks each, both recorded
// in comments in that file. Three times is a pattern, so it is a test now.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RULES, rulesHtml } from './fridayrules.mjs';

const WRANGLER = readFileSync(new URL('./wrangler.jsonc', import.meta.url), 'utf8');
const WORKER = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

describe('the page can actually be reached', () => {
  test('a route pattern sends /friday-rules to this worker', () => {
    assert.match(WRANGLER, /"pattern":\s*"itsnum\.com\/friday-rules\*"/,
      'the handler exists but nothing routes to it — the page will 404 in production');
  });

  test('the worker answers that path', () => {
    assert.match(WORKER, /p === "\/friday-rules"/);
    assert.match(WORKER, /fridayRules\(\)/);
  });
});

describe('what the page must say to be lawful', () => {
  const html = rulesHtml();

  test('no purchase necessary, stated plainly', () => {
    assert.match(html, /No purchase necessary/i);
    assert.match(html, /will improve your chance of winning/i);
  });

  test('who may enter, and the hard age gate', () => {
    assert.match(html, /United States/);
    assert.match(html, /United Kingdom/);
    assert.match(html, /18 or over/);
    assert.match(html, /Void where prohibited/i);
  });

  test('Thailand is excluded, with the reason', () => {
    // Thai law requires a licence for prize draws INCLUDING free-entry ones.
    // Saying so here is what stops a Thai member discovering it at claim.
    assert.match(html, /not currently eligible/i);
    assert.match(html, /licence/i);
  });

  test('the entry code is published, and matches the code the service accepts', () => {
    assert.match(html, new RegExp(RULES.entryCode));
    const packdraw = readFileSync(new URL('../worker/packdraw.mjs', import.meta.url), 'utf8');
    assert.match(packdraw, new RegExp(`ENTRY_CODE = '${RULES.entryCode}'`),
      'the page names one code and the service accepts another');
  });

  test('the trademark disclaimer is present and unambiguous', () => {
    assert.match(html, /not sponsored, endorsed/i);
    assert.match(html, /Nintendo/);
    assert.match(html, /The Pok[eé]mon Company/);
  });

  test('how winners are chosen, and that it can be checked', () => {
    assert.match(html, /at random/i);
    assert.match(html, /seed/i, 'clause 7 promises the draw is reproducible');
    assert.match(html, /No person selects the winners/i);
  });

  test('the sponsor is named and reachable', () => {
    assert.match(html, new RegExp(RULES.sponsor.replace('.', '\\.')));
    assert.match(html, new RegExp(RULES.contact));
  });

  test('ten winners, one pack each', () => {
    assert.equal(RULES.winnersPerWeek, 10);
    assert.equal(RULES.packsPerWinner, 1);
    assert.match(html, /10 winners per entry period/);
  });

  test('it renders as a real page, not a fragment', () => {
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /<\/html>$/);
  });
});
