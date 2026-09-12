// The wiring test. Not "does the function work" — does the CHAIN exist.
//
// Every failure this feature could have is a missing link that looks fine next
// to its neighbours: a button calling a function that calls a path no route
// serves, a route pointing at a handler that writes to a table with a different
// name, a bucket read by a worker it was never bound on. Each of those ships
// green and fails in a supplier's hands.
//
// So this walks the links in SOURCE: control to client function to path to
// route to handler to binding. It is deliberately brittle about names — if
// somebody renames a path on one side only, this is what says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const CONSOLE = read('../public/host/index.html');
const WORKER = read('../growth/worker.js');
const ASSETS = read('../growth/hostassets.mjs');
const SMS = read('./sms.mjs');
const MEDIA = read('./inboundmedia.mjs');
const WR_APP = read('../wrangler.app.jsonc');
const WR_GROWTH = read('../growth/wrangler.jsonc');
const MIG = read('./migrations/0021_luxury_assets.sql');

/* ─────────────── link 1: the controls call real functions ─────────────── */

test('every fleet control in the console calls a function that exists', () => {
  for (const fn of ['loadFleet', 'paintFleet', 'paintQueue', 'paintHolds', 'flPhotos', 'flModerate', 'flEdit']) {
    assert.match(CONSOLE, new RegExp('function ' + fn + '\\s*\\('), `${fn} is called but never defined`);
  }
});

test('loadFleet is actually called at boot — a painter nobody calls is a blank card', () => {
  assert.match(CONSOLE, /paintSummary\(sum\);\s*\n\s*loadBook\(\);\s*\n\s*loadFleet\(\);/);
});

test('the fleet card the JS paints into exists in the HTML', () => {
  for (const id of ['fleetCard', 'flRows', 'flQueue', 'flHolds', 'flErr', 'flForm', 'flHoldForm', 'hd_asset']) {
    assert.ok(CONSOLE.includes(`id="${id}"`), `#${id} is written to by the JS but is not in the HTML`);
  }
});

test('every form field the submit handler reads is in the form', () => {
  // Pulled from the submit handler itself rather than listed by hand, so adding
  // a field to the payload without adding it to the form fails here.
  const body = CONSOLE.slice(CONSOLE.indexOf("$('flForm').onsubmit"));
  const ids = [...body.slice(0, 2000).matchAll(/\$\('(fl_[a-z_]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 12, 'expected the save handler to read a dozen fields');
  for (const id of new Set(ids)) {
    assert.ok(CONSOLE.includes(`id="${id}"`), `the save handler reads #${id} but no such input exists`);
  }
});

/* ──────────────── link 2: client paths match server routes ────────────── */

test('every path the console posts to is a route the worker serves', () => {
  // api('x') resolves to /api/host/x — that is what the helper does.
  const calls = new Set([...CONSOLE.matchAll(/\bapi\('([a-z-]+)'/g)].map((m) => m[1]));
  for (const name of ['assets', 'asset-photo', 'asset-holds']) {
    assert.ok(calls.has(name), `the console never calls api('${name}')`);
    assert.ok(
      WORKER.includes(`p === "/api/host/${name}"`),
      `the console calls api('${name}') but no route matches /api/host/${name}`,
    );
  }
});

test('the image URL the console builds is a route the worker serves', () => {
  assert.match(CONSOLE, /\/api\/host\/asset-image\?id=/);
  assert.ok(WORKER.includes('p === "/api/host/asset-image"'));
});

test('the image URL carries the host key — a pending photo cannot render without it', () => {
  const img = CONSOLE.slice(CONSOLE.indexOf('/api/host/asset-image?id='));
  assert.match(img.slice(0, 200), /k=' \+ encodeURIComponent\(K\)/);
});

/* ─────────────── link 3: routes point at handlers that exist ──────────── */

test('each asset route calls a handler this module exports', () => {
  const pairs = [
    ['/api/host/assets', 'hostAssets'],
    ['/api/host/asset-photo', 'hostAssetPhoto'],
    ['/api/host/asset-holds', 'hostAssetHolds'],
    ['/api/host/asset-image', 'assetImage'],
    ['/api/host/offerable', 'offerableAssets'],
  ];
  for (const [path, fn] of pairs) {
    const line = WORKER.split('\n').find((l) => l.includes(`"${path}"`) && l.includes(fn))
      || WORKER.split('\n').find((l, i, arr) => arr[i].includes(`"${path}"`) && (arr[i] + arr[i + 1]).includes(fn));
    assert.ok(line, `route ${path} does not call ${fn}`);
    assert.match(ASSETS, new RegExp('export async function ' + fn + '\\b'), `${fn} is routed but not exported`);
  }
});

test('the asset handlers are imported into the worker', () => {
  assert.match(WORKER, /import \{[\s\S]{0,200}hostAssets[\s\S]{0,200}\} from '\.\/hostassets\.mjs'/);
});

test('the handlers get hostAuth — one door, one lock', () => {
  assert.match(WORKER, /const ASSET_DEPS = \{ J, clean, readJSON, badOrigin, hostAuth \}/);
  // And every handler that changes data actually uses it.
  for (const fn of ['hostAssets', 'hostAssetPhoto', 'hostAssetHolds']) {
    const body = ASSETS.slice(ASSETS.indexOf(`export async function ${fn}`));
    assert.match(body.slice(0, 400), /await hostAuth\(env, url\)/, `${fn} does not authenticate`);
  }
});

test('the public photo route is registered BEFORE the generic /p/ pay route', () => {
  const mine = WORKER.indexOf('p.startsWith("/p/asset/")');
  const pay = WORKER.indexOf('p.startsWith("/p/")');
  assert.ok(mine > -1 && pay > -1, 'both /p/ routes should exist');
  assert.ok(mine < pay, 'the pay handler would swallow every photo URL');
});

test('the public photo route is publicOnly — approved photos only', () => {
  const line = WORKER.split('\n').findIndex((l) => l.includes('p.startsWith("/p/asset/")'));
  const after = WORKER.split('\n').slice(line, line + 3).join(' ');
  assert.match(after, /publicOnly: true/);
});

/* ──────────── link 4: handlers write to tables that exist ─────────────── */

test('every table the handlers touch is created by the migration', () => {
  // Only names in a TABLE POSITION. A bare /num_\w+/ sweep also catches
  // 'num_collects', which is a settle_mode enum value and not a table — and a
  // test that cries wolf about that gets switched off, which is worse than not
  // having it.
  const used = new Set(
    [...(ASSETS + MEDIA).matchAll(/\b(?:FROM|INTO|JOIN|UPDATE)\s+(num_[a-z_]+)/gi)].map((m) => m[1]),
  );
  const declared = new Set([
    ...[...MIG.matchAll(/CREATE TABLE IF NOT EXISTS\s+(num_[a-z_]+)/g)].map((m) => m[1]),
    // Pre-existing tables the handlers legitimately read.
    'num_members', 'num_suppliers', 'num_supplier_links', 'num_hosts', 'num_jobs', 'num_inbox',
  ]);
  for (const t of used) {
    assert.ok(declared.has(t), `${t} is queried but no migration creates it`);
  }
});

test('every column the asset INSERT names exists in the migration', () => {
  const ins = ASSETS.slice(ASSETS.indexOf('INSERT INTO num_assets'));
  const cols = ins.slice(0, 700).match(/\(([^)]*)\)/)[1]
    .split(',').map((c) => c.trim()).filter((c) => /^[a-z_]+$/.test(c));
  const table = MIG.slice(MIG.indexOf('CREATE TABLE IF NOT EXISTS num_assets'));
  const declared = table.slice(0, table.indexOf('\n);')).match(/^\s{2}([a-z_]+)\s+(TEXT|INTEGER|REAL)/gm)
    .map((l) => l.trim().split(/\s+/)[0]);
  assert.ok(cols.length > 15, 'expected the insert to name the full column list');
  for (const c of cols) {
    assert.ok(declared.includes(c), `num_assets INSERT names ${c}, which the table does not have`);
  }
});

test('retiring an asset sets retired_at — the CHECK refuses it otherwise', () => {
  // Sliced to the end of the retire BLOCK rather than a fixed character count —
  // a window measured in characters shrinks every time somebody adds a comment,
  // and a test that fails for a comment gets deleted rather than fixed.
  const start = ASSETS.indexOf("if (action === 'retire')");
  const r = ASSETS.slice(start, ASSETS.indexOf('return list();', start));
  assert.match(r, /status='retired'/);
  assert.match(r, /retired_at=/);
  assert.match(MIG, /CHECK \(status <> 'retired' OR retired_at IS NOT NULL\)/);
});

/* ──────── link 5: the texted-in photo reaches the storage it needs ────── */

test('the inbound SMS handler no longer drops a photo with no caption', () => {
  // The exact old guard. If it comes back, every photo-only text is silently
  // lost again — which is what it did for the whole life of that line.
  assert.ok(!SMS.includes('if (!from || !text) return xmlOk();'),
    'the old guard is back: a photo with no caption is being dropped');
  assert.match(SMS, /const numMedia = Number\(params\.get\('NumMedia'\)/);
  assert.match(SMS, /if \(!text && !numMedia\) return xmlOk\(\);/);
});

test('the inbound handler reads NumMedia before it decides to give up', () => {
  const guard = SMS.indexOf("if (!text && !numMedia)");
  const reads = SMS.indexOf("params.get('NumMedia')");
  assert.ok(reads > -1 && reads < guard, 'NumMedia must be read before the empty-body guard');
});

test('the inbound handler actually calls the ingest and passes the bucket', () => {
  assert.match(SMS, /import \{ ingestMedia, askWhichAsset \} from '\.\/inboundmedia\.mjs'/);
  assert.match(SMS, /ingestMedia\(env, \{ params, from, bucket: env\.PHOTOS \}\)/);
});

test('a supplier who texts a photo always gets an answer', () => {
  const tail = SMS.slice(SMS.indexOf('if (media) {'));
  assert.match(tail.slice(0, 300), /askWhichAsset\(media\)/);
  assert.match(tail.slice(0, 300), /return xmlReply\(reply\)/);
});

test('PHOTOS is bound on BOTH workers — one half is a broken feature', () => {
  for (const [name, cfg] of [['num-app', WR_APP], ['num-growth', WR_GROWTH]]) {
    assert.match(cfg, /"binding": "PHOTOS"/, `PHOTOS is not bound on ${name}`);
    assert.match(cfg, /"bucket_name": "num-asset-photos"/, `${name} points at the wrong bucket`);
  }
});

test('the binding name does not collide with the static asset binding', () => {
  // wrangler.app.jsonc already has an "ASSETS" binding for static files. Two
  // bindings with one name is a runtime surprise, not a deploy error.
  assert.ok(!/"binding": "ASSETS",[\s\S]{0,120}bucket_name/.test(WR_APP));
  assert.match(WR_APP, /"binding": "ASSETS"/);
  assert.match(WR_APP, /"binding": "PHOTOS"/);
});

/* ──────────────── link 6: the guards can be satisfied ────────────────── */

test('the go-live refusal tells the host what to do, and the thing it asks for is possible', () => {
  const block = ASSETS.slice(ASSETS.indexOf("if (action === 'listable')"));
  assert.match(block.slice(0, 900), /no_approved_photo/);
  assert.match(block.slice(0, 900), /says:/, 'a refusal with no sentence reads as a broken button');
  // And approving a photo — the thing it asks for — is a real action here.
  assert.match(ASSETS, /if \(action === 'moderate'\)/);
  assert.match(CONSOLE, /data-pok=/, 'the console must offer the approve control the refusal asks for');
});

test('the console shows the refusal rather than swallowing it', () => {
  const live = CONSOLE.slice(CONSOLE.indexOf("data-live]'), function (b)"));
  assert.match(live.slice(0, 700), /note\(\$\('flErr'\), r\.says/);
});

test('a rate in a priced unit is refused with a sentence, not a constraint error', () => {
  assert.match(ASSETS, /rate_unit !== 'quote' && rate_minor <= 0/);
  assert.match(ASSETS, /error: 'no_rate'/);
  assert.match(MIG, /CHECK \(rate_unit = 'quote' OR rate_minor > 0\)/);
});

/* ───────────── link 7: nothing leaks that must not leak ──────────────── */

test('the client-facing shape cannot carry a registration number', () => {
  const cv = ASSETS.slice(ASSETS.indexOf('export function clientView'), ASSETS.indexOf('function safeJson'));
  assert.ok(!/registration/.test(cv), 'clientView names registration — that is the breach the auditor looks for');
  assert.ok(!/\bnotes\b/.test(cv), 'clientView carries the host private notes');
  assert.ok(!/verify_note|owner_id|host_id|settle_mode/.test(cv), 'clientView leaks internal fields');
});

test('the offerable list demands listable, active AND an approved photo', () => {
  const o = ASSETS.slice(ASSETS.indexOf('export async function offerableAssets'));
  assert.match(o, /a\.listable = 1/);
  assert.match(o, /a\.status = 'active'/);
  assert.match(o, /moderation = 'ok'/);
});

test('the photo queue only ever shows this host their own suppliers', () => {
  const q = ASSETS.slice(ASSETS.indexOf('FROM num_inbound_media m'));
  assert.match(q.slice(0, 800), /num_supplier_links/);
  assert.match(q.slice(0, 800), /status = 'accepted'/);
  assert.match(q.slice(0, 800), /ended_at IS NULL/);
});

test('photo ownership is checked on every mutating photo action', () => {
  for (const action of ['attach', 'moderate', 'order', 'list', 'listable']) {
    const i = ASSETS.indexOf(`if (action === '${action}')`);
    assert.ok(i > -1, `action ${action} missing`);
    const body = ASSETS.slice(i, i + 1200);
    assert.ok(/ownsAsset\(|not_your_photo/.test(body), `${action} does not check ownership`);
  }
});

test('the served image is never sniffable and never cached while pending', () => {
  const img = ASSETS.slice(ASSETS.indexOf('export async function assetImage'));
  assert.match(img, /'x-content-type-options': 'nosniff'/);
  assert.match(img, /private, no-store/);
});
