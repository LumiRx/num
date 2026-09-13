// The business console is ONE console, not seven pages that happen to share a
// URL prefix.
//
// ── WHAT WAS TRUE ON 13 SEP 2026 ─────────────────────────────────────────
//
// `/biz` answered 404. Five of the seven pages linked to nothing at all — only
// tables and statement knew about each other — so a venue emailed a link to
// /biz/visitors could see the guests we sent them and had no way to reach their
// statement, their codes or their settings.
//
// And underneath that, the reason linking them would not have helped: the
// console had TWO AUTH SYSTEMS that never consulted each other. /biz/tables and
// /biz/statement use `qrWho`, the email magic-link session. The other five use
// `bizAuth`, a permanent console key in the query string. So a venue that signed
// in by email could reach two pages out of seven, and the other five answered
// "sign in" to somebody who already had.
//
// These read the shipped source rather than a copy of it, because the failure
// was never in the logic — every one of those pages worked. It was in what was
// wired to what.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'worker.js'), 'utf8');
const wrangler = readFileSync(join(HERE, 'wrangler.jsonc'), 'utf8');

/** Comments stripped: this file documents the bug it no longer has. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const PAGES = ['tables', 'pay', 'statement', 'visitors', 'offers', 'settings'];

describe('the front door exists', () => {
  test('/biz and /biz/ both reach the hub', () => {
    assert.match(code, /p === "\/biz" \|\| p === "\/biz\/"/,
      'a person trimming the URL back to /biz must not get a 404');
    assert.match(code, /venueHomePage/, 'there is no hub handler');
  });

  test('A HANDLER IS NOT A ROUTE — the pattern must carry a bare /biz', () => {
    // "itsnum.com/biz/*" does NOT match "/biz". This exact omission shipped
    // /api/pay/*, /p/* and /friday-rules broken, three separate times.
    assert.match(wrangler, /"itsnum\.com\/biz\*"/,
      'the route pattern still requires a slash, so /biz reaches no worker at all');
  });

  test('the hub is behind the same sign-in as everything else', () => {
    const fn = code.slice(code.indexOf('async function venueHomePage'));
    assert.match(fn.slice(0, 400), /qrWho\(/, 'the hub must authenticate');
    assert.match(fn.slice(0, 400), /qrSignIn\(\)/, 'an unauthenticated venue needs a way in');
  });
});

describe('no page is an island', () => {
  test('every console page renders the shared nav', () => {
    for (const slug of PAGES) {
      assert.ok(code.includes(`qrNav('${slug}'`), `/biz/${slug} has no nav — it is an island`);
    }
    assert.ok(code.includes("qrNav(''"), 'the hub does not mark itself in the nav');
  });

  test('the nav lists every page, and the hub', () => {
    const nav = code.slice(code.indexOf('const BIZ_NAV = Object.freeze('), code.indexOf('function qrNav'));
    for (const slug of PAGES) {
      assert.ok(nav.includes(`slug: '${slug}'`), `${slug} is missing from the nav`);
    }
    assert.match(nav, /slug: ''/, 'no way back to the hub');
  });

  test('the nav hides what a role may not open', () => {
    // A staff member shown "Settings" and refused on arrival reads it as a bug,
    // and it invites them to ask the owner for access they should not have.
    const nav = code.slice(code.indexOf('const BIZ_NAV = Object.freeze('), code.indexOf('const BIZ_NAV_CSS'));
    assert.match(nav, /slug: 'settings', label: 'Settings', need: 'settings'/);
    assert.match(nav, /QR\.can\(role, it\.need\)/, 'the nav does not filter by role at all');
  });

  test('the nav brings its own CSS for the pages that predate the shared shell', () => {
    assert.match(code, /standalone/, 'five pages have their own stylesheet and would render a bare list');
  });
});

describe('one sign-in, not two', () => {
  test('an owner’s email session is accepted by the key-based guard', () => {
    const fn = code.slice(code.indexOf('async function bizAuth'), code.indexOf('async function venueCodesList'));
    assert.match(fn, /QR\.sessionUser/, 'bizAuth ignores the email session, so five pages stay unreachable');
    assert.match(fn, /sess\.role !== "owner"/,
      'any role would inherit console-key authority — a bartender must not get the owner’s');
  });

  test('a non-owner session is refused, so the key is not widened', () => {
    const fn = code.slice(code.indexOf('async function bizAuth'), code.indexOf('async function venueCodesList'));
    const gate = fn.indexOf('sess.role !== "owner"');
    const ret = fn.indexOf('SELECT id,name,category,console_key,status FROM businesses WHERE id = ?');
    assert.ok(gate > 0 && ret > gate, 'the business is loaded before the role is checked');
  });

  test('session access is logged like key access', () => {
    const fn = code.slice(code.indexOf('async function bizAuth'), code.indexOf('async function venueCodesList'));
    assert.match(fn, /via=owner_session/,
      'the security sweep reads this log; unlogged access is invisible to it');
  });

  test('the key path still works and still logs both outcomes', () => {
    const fn = code.slice(code.indexOf('async function bizAuth'), code.indexOf('async function venueCodesList'));
    assert.match(fn, /sameSecret\(biz\.console_key, k\)/, 'the key check has gone');
    assert.match(fn, /ok \? "ok" : "denied"/, 'failed key attempts are no longer logged');
  });
});

describe('the hub tells the truth about money', () => {
  const fn = src.slice(src.indexOf('async function venueHomePage'), src.indexOf('async function qrTablesPage'));

  test('the rate is read off this venue’s ledger, never typed', () => {
    assert.match(fn, /FROM num_business_settings WHERE business_id = \?1/,
      'a hub quoting a flat rate repeats the drift the statement page was rewritten to stop');
    assert.doesNotMatch(fn.replace(/\/\*[\s\S]*?\*\//g, ''), /10% of the bill/,
      'the rate is hardcoded again');
  });

  test('the walk-in fee carries its currency', () => {
    // The same stored 7000 is ฿70 in Phuket and reads as dollars without a symbol.
    assert.match(fn, /THB: "฿"/);
  });

  test('a failed ledger read is never shown as a zero', () => {
    assert.match(fn, /this is not a zero/,
      '"you owe nothing" and "we could not read it" are opposite facts');
  });
});
