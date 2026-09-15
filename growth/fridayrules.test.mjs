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

  test('the page publishes BOTH entry routes the service actually accepts', () => {
    // 15 Sep 2026: people were texting PACKS and being entered, while this page
    // said entry required the app and that nothing else counted. A promotion whose
    // advertising and whose Official Rules describe different entry methods is the
    // exact exposure this page exists to prevent, so the two routes are pinned.
    assert.match(html, /In the app/i, 'the app route must be named');
    assert.match(html, /By text/i, 'the text route must be named — the SMS keyword enters people');
    assert.match(html, /count exactly the same/i);
  });

  test('soliciting a text carries the disclosures a carrier looks for', () => {
    assert.match(html, /message and data rates may apply/i);
    assert.match(html, /message frequency varies/i);
    assert.match(html, /HELP/);
    assert.match(html, /STOP/);
  });

  test('consent to messages is never a condition of entering or winning', () => {
    // Both a sweepstakes-consideration point and a TCPA one. If entering required
    // agreeing to messages, the free-entry defence and the consent posture both fail.
    assert.match(html, /not a\s*\n?\s*condition of entering or of winning/i);
  });

  test('an entry stands even when the confirmation text cannot be delivered', () => {
    // US A2P registration has been rejected and outbound has failed 30034 for most
    // of this product's life. Somebody who texts in and hears nothing must not be
    // told, or left to assume, that their entry failed.
    assert.match(html, /your entry still stands/i);
  });

  test('one entry per person holds across both routes', () => {
    assert.match(html, /whichever way you send it/i);
    assert.match(html, /app and by text from your own number is still one entry/i);
  });

  test('a winner who entered by phone can be told by phone', () => {
    // Clause 8 said "in the app" only. A texter with no account could never have
    // been reached, which is a prize that cannot be delivered.
    assert.match(html, /by text where\s*\n?\s*the entry came from a phone number/i);
  });
});
