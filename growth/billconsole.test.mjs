/**
 * The console half of bill pay: lines, a price list, and the funnel.
 *
 * ── WHY THESE ARE SOURCE ASSERTIONS ──────────────────────────────────────
 *
 * The venue console is served from one enormous Worker file and reaching a
 * page needs a staff session, a cookie and a role. Standing that up buys
 * coverage of the plumbing and not of the thing that actually breaks here,
 * which is wiring: a handler written and never routed, a loader written and
 * never called, a permission checked on the wrong verb.
 *
 * That is not hypothetical in this codebase. The ten POS adapter tests were
 * written, passed review and never ran once, because `growth/*.test.mjs` does
 * not match a subdirectory. Something built and never connected looks exactly
 * like something that works, right up until a venue opens the page.
 *
 * So each assertion below names the failure it exists to prevent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

/* ── routes ──────────────────────────────────────────────────────────────── */

test('every new console endpoint is actually routed', () => {
  // A handler nobody routes is a 404 with tests passing over it.
  for (const [path, method, fn] of [
    ['/api/venue/products', 'GET', 'qrProducts'],
    ['/api/venue/products', 'POST', 'qrProductWrite'],
    ['/api/venue/funnel', 'GET', 'qrFunnel'],
    ['/api/venue/bill/trail', 'GET', 'qrBillTrail'],
  ]) {
    const line = new RegExp(`p === "${path.replace(/\//g, '\\/')}" && req\\.method === "${method}"\\) return ${fn}\\(`);
    assert.match(src, line, `${method} ${path} is not routed to ${fn}`);
    assert.match(src, new RegExp(`async function ${fn}\\(`), `${fn} is routed but does not exist`);
  }
});

/* ── permissions ─────────────────────────────────────────────────────────── */

test('a waiter may bill a table; only an owner may set what things cost', () => {
  // The role table already says a waiter puts an amount on a table. It does
  // not say a waiter decides what a Singha costs, and the difference is the
  // venue's own prices.
  const write = src.slice(src.indexOf('async function qrProductWrite('), src.indexOf('/** The currency the venue'));
  assert.match(write, /QR\.can\(who\.role, "settle"\)/, 'the price list must be owner-gated');
  assert.ok(!/QR\.can\(who\.role, "bill"\)/.test(write), 'the bill permission is too weak for a price list');

  const read = src.slice(src.indexOf('async function qrProducts('), src.indexOf('async function qrProductWrite('));
  assert.match(read, /QR\.can\(who\.role, "bill"\)/, 'staff building a bill must be able to read the list');
});

test('the funnel and the trail are readable by anyone who may view', () => {
  const funnel = src.slice(src.indexOf('async function qrFunnel('), src.indexOf('async function qrBillTrail('));
  assert.match(funnel, /QR\.can\(who\.role, "view"\)/);
  assert.match(funnel, /unauthorised/, 'no session, no numbers');
});

test('the trail is scoped to the venue\'s own codes', () => {
  // Without this a session for one venue reads the payment history of
  // another venue's bill.
  const trail = src.slice(src.indexOf('async function qrBillTrail('), src.indexOf('/** The currency the venue'));
  assert.match(trail, /FROM num_paylinks WHERE token = \?1 AND business_id = \?2/);
  assert.match(trail, /not one of your codes/);
});

/* ── the rule that keeps a bill honest ───────────────────────────────────── */

test('when there are lines, the Amount box stops being typeable', () => {
  // Two editable figures for one bill is how they end up disagreeing, and a
  // bill whose items say 2,400 and whose charge says 2,600 is what a guest
  // disputes at the door.
  assert.match(src, /amt\.readOnly=LINES\.length>0/);
  assert.match(src, /if\(LINES\.length\)amt\.value=money\(total\)/);
});

test('the server re-adds the lines and mints for THAT figure', () => {
  // The browser is not trusted with the total. normaliseItems runs again on
  // the way in and its sum becomes the amount.
  const create = src.slice(src.indexOf('async function qrBillCreate('), src.indexOf('/* ── the venue\'s own list'));
  assert.match(create, /BILLITEMS\.normaliseItems\(b\.items\)/);
  assert.match(create, /amount = read\.total/);
  assert.match(create, /await QR\.billForTable\(env, \{[\s\S]*?amount,/);
});

test('the lines are saved AFTER the code exists, so a failure costs the lines and not the bill', () => {
  const create = src.slice(src.indexOf('async function qrBillCreate('), src.indexOf('/* ── the venue\'s own list'));
  const mint = create.indexOf('QR.billForTable');
  const save = create.indexOf('BILLITEMS.saveItems');
  assert.ok(mint > 0 && save > mint, 'saving the lines before the bill exists risks the bill for a nicety');
  assert.match(create, /if \(!out\.ok\) return J\(out, 400\);[\s\S]{0,400}BILLITEMS\.saveItems/);
});

test('typing a total still works, and nothing forces a venue to itemise', () => {
  // A paper-bill restaurant in Bangkok types a figure and sends. The moment
  // itemising is the only way, the feature stops being for them.
  const create = src.slice(src.indexOf('async function qrBillCreate('), src.indexOf('/* ── the venue\'s own list'));
  assert.match(create, /let amount = b\.amount;/);
  assert.match(create, /if \(Array\.isArray\(b\.items\) && b\.items\.length\)/,
    'items must be optional, not assumed');
});

/* ── the tile is drawn, and something actually loads it ──────────────────── */

test('the funnel tile is on the page AND in the loader list', () => {
  // The second half is the one that rots: a drawFunnel nobody calls leaves a
  // tile reading "Loading…" for ever, which looks like an outage.
  assert.match(src, /<div id="funnel"/);
  assert.match(src, /function drawFunnel\(j\)/);
  assert.match(src, /loader\('\/api\/venue\/funnel',drawFunnel,'funnel'\)/,
    'drawFunnel is defined but nothing fetches for it');
});

test('the itemised builder is on the page and wired to its own handlers', () => {
  for (const id of ['itoggle', 'itembox', 'prodchips', 'iname', 'iqty', 'iprice', 'iadd', 'ilines', 'itotal']) {
    assert.match(src, new RegExp(`id="${id}"`), `the builder is missing #${id}`);
  }
  assert.match(src, /document\.getElementById\('iadd'\)\.onclick/);
  assert.match(src, /document\.getElementById\('itoggle'\)\.onclick/);
});

test('the price list is owner-only in the markup too, not just on the server', () => {
  // Showing a waiter a form the server will refuse is a worse experience than
  // not showing it, and it invites a support call about a permission.
  const tile = src.slice(src.indexOf('<h2>Your price list</h2>') - 400, src.indexOf('<h2>Your price list</h2>'));
  assert.match(tile, /\$\{isOwner \? `/, 'the price list tile must be inside the isOwner branch');
});

test('a split bill reads as one open bill in the console, with its progress', () => {
  // Five rows for one table is how a waiter counting at the end of a shift
  // believes the room owes five times what it does.
  assert.match(src, /r\.split_at&&r\.shares/);
  assert.match(src, /split '\+r\.shares\+' ways, '\+\(r\.shares_paid\|\|0\)\+' paid/);
});

/* ── what the funnel refuses to say ──────────────────────────────────────── */

test('the tile promises counts and explicitly not a rate', () => {
  const tile = src.slice(src.indexOf('<h2>What happened to your bills</h2>'), src.indexOf('<div id="funnel"'));
  assert.match(tile, /Counts, not a conversion rate/);
  // And the reason, in the venue's own terms rather than ours.
  assert.match(tile, /scan on Monday and\s*\n?\s*pay on Tuesday/);
});

test('a funnel that cannot be read says so instead of drawing zeros', () => {
  // An empty funnel and an unreadable one look identical on a screen, and a
  // venue reads the first as "nobody paid".
  assert.match(src, /if\(!j\.ready\)return void\(o\.textContent=j\.why/);
  assert.match(src, /ready: false, why: "Bill tracking starts once the next update is applied\."/);
});

test('a check left open after payment is the one row the tile colours', () => {
  assert.match(src, /if\(st\[0\]==='till_failed'&&n\)tr\.style\.color/);
});
