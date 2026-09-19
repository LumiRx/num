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
  // Asserts the CALL inside the boot block, not the exact neighbouring lines. An
  // assertion pinned to "loadBook then loadFleet" breaks the moment a third
  // loader is added between them, which is a test failing for a change that is
  // entirely correct.
  const boot = CONSOLE.slice(CONSOLE.indexOf('function boot(quiet)'));
  assert.match(boot, /paintSummary\(sum\);/);
  assert.match(boot, /\n\s*loadFleet\(\);/);
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
  // Sliced to the end of the BLOCK, not to a character count — a window
  // measured in characters shrinks whenever somebody adds a comment, and a test
  // that fails for a comment gets deleted rather than fixed.
  const start = SMS.indexOf('if (media) {');
  const tail = SMS.slice(start, SMS.indexOf('return xmlOk();', start) + 20);
  assert.match(tail, /askWhichAsset\(media, \{ member \}\)/);
  assert.match(tail, /return xmlReply\(reply\)/);
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
  /* The slice ends at the NEXT action rather than at a character count. It was
   * `block.slice(0, 900)`, which was a guess about how long the handler would
   * stay — and on 18 Sep 2026 a second gate was added above the photo check
   * and pushed the refusal out of the window. The test failed while the
   * behaviour it describes was correct, which is the kind of failure that
   * teaches people to edit tests until they go green. */
  const from = ASSETS.indexOf("if (action === 'listable')");
  const block = ASSETS.slice(from, ASSETS.indexOf("if (action === '", from + 20));

  assert.match(block, /no_approved_photo/);
  assert.match(block, /says:/, 'a refusal with no sentence reads as a broken button');
  // And approving a photo — the thing it asks for — is a real action here.
  assert.match(ASSETS, /if \(action === 'moderate'\)/);
  assert.match(CONSOLE, /data-pok=/, 'the console must offer the approve control the refusal asks for');
});

test('a draft is refused go-live, and confirming it is a real thing the console can do', () => {
  /* The second gate. Intake attaches a host's own uploads already approved, so
   * the photo check above is satisfied the moment an upload finishes — without
   * this, "Go live" would publish a name and a description a model wrote and
   * nobody read. Same standard as every other refusal here: it must say what
   * to do, and that thing must exist. */
  const from = ASSETS.indexOf("if (action === 'listable')");
  const block = ASSETS.slice(from, ASSETS.indexOf("if (action === '", from + 20));

  assert.match(block, /still_a_draft/);
  assert.match(block, /SELECT draft FROM num_assets/);
  assert.match(block, /says:/);
  // Confirming is the thing it asks for. It exists on the server...
  const intake = readFileSync(new URL('../growth/fleetintake.mjs', import.meta.url), 'utf8');
  assert.match(intake, /action === 'confirm'/);
  // ...and the console has the button.
  assert.match(CONSOLE, /data-ok="/, 'the console must offer the confirm control the refusal asks for');
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

/* ───────── link 8: WhatsApp, the door that works outside North America ──── */

test('the WhatsApp webhook also accepts a photo with no caption', () => {
  const WA = read('./whatsapp.mjs');
  assert.ok(!WA.includes("if (!text) return xmlOk();"),
    'the old guard is back: a WhatsApp photo with no caption is being dropped');
  assert.match(WA, /const numMedia = Number\(params\.get\('NumMedia'\)/);
  assert.match(WA, /if \(!text && !numMedia\) return xmlOk\(\);/);
});

test('WhatsApp uses the same ingest as SMS, and records itself as whatsapp', () => {
  const WA = read('./whatsapp.mjs');
  assert.match(WA, /import \{ ingestMedia, askWhichAsset \} from '\.\/inboundmedia\.mjs'/);
  assert.match(WA, /provider: 'whatsapp'/);
  // And the schema permits that value, which is the half that fails silently.
  assert.match(MIG, /CHECK \(provider IN \('twilio','whatsapp','upload'\)\)/);
});

test('WhatsApp passes the bucket, so a photo is not dropped for want of a binding', () => {
  assert.match(read('./whatsapp.mjs'), /bucket: env\.PHOTOS/);
});

test('a known member who is not a supplier is never told we do not know them', () => {
  // The reply function must return null for that case, so the message falls
  // through to the concierge instead of getting a fleet answer.
  assert.match(MEDIA, /if \(member\) return null;/);
  const sms = SMS.slice(SMS.indexOf('const reply = askWhichAsset'));
  assert.match(sms.slice(0, 120), /\{ member \}/, 'sms.mjs must pass the member into the decision');
  assert.match(read('./whatsapp.mjs'), /askWhichAsset\(media, \{ member \}\)/);
});

/* ── link 9: the card refuses to exist when its endpoints do not ────────── */

test('the fleet card hides itself when the API is not deployed', () => {
  // The failure this guards against happened for real: the console and the API
  // ship from two different workers, num-console went out alone, and the card
  // was live on itsnum.com with every button hitting a 404.
  assert.match(CONSOLE, /function fleetUnavailable\(/);
  assert.match(CONSOLE, /card\.classList\.add\('hide'\)/);
  const load = CONSOLE.slice(CONSOLE.indexOf('function loadFleet()'));
  const body = load.slice(0, load.indexOf('\n  }') + 4);
  assert.match(body, /r\.status === 404/, 'a 404 must take the card down');
  assert.match(body, /r\.status === 503/, 'an unbound bucket must take the card down too');
  // fetch() resolves on a 404 rather than rejecting, so the catch alone is not
  // enough — both the status check and the catch must lead to fleetUnavailable.
  assert.ok((body.match(/fleetUnavailable\(/g) || []).length >= 3,
    'every way this can fail must hide the card');
});

test('a failing fleet does not take the rest of the console with it', () => {
  const load = CONSOLE.slice(CONSOLE.indexOf('function loadFleet()'));
  const body = load.slice(0, load.indexOf('\n  }') + 4);
  assert.ok(!/location\.reload|showGate/.test(body),
    'one broken panel must never blank the page a host works in');
});

/* ── link 10: suppliers, the half 0019 shipped without ─────────────────── */

const SUPPLIERS = read('../growth/hostsuppliers.mjs');

test('the supplier endpoints are imported, routed and authenticated', () => {
  assert.match(WORKER, /import \{ hostSuppliers, supplierAssets \} from '\.\/hostsuppliers\.mjs'/);
  assert.ok(WORKER.includes('p === "/api/host/suppliers"'));
  assert.ok(WORKER.includes('p === "/api/host/supplier-assets"'));
  for (const fn of ['hostSuppliers', 'supplierAssets']) {
    assert.match(SUPPLIERS, new RegExp('export async function ' + fn + '\\b'));
    const body = SUPPLIERS.slice(SUPPLIERS.indexOf(`export async function ${fn}`));
    assert.match(body.slice(0, 400), /await hostAuth\(env, url\)/, `${fn} does not authenticate`);
  }
});

test('the supplier endpoints can send mail, because telling them IS the consent step', () => {
  assert.match(WORKER, /const SUPPLIER_DEPS = \{ J, clean, readJSON, badOrigin, hostAuth, sendBatch \}/);
  assert.match(SUPPLIERS, /D\.sendBatch/);
});

test('the console calls the supplier endpoint and hides the card when it is absent', () => {
  const calls = new Set([...CONSOLE.matchAll(/\bapi\('([a-z0-9-]+)'/g)].map((m) => m[1]));
  assert.ok(calls.has('suppliers'));
  assert.match(CONSOLE, /function supUnavailable\(/);
  const load = CONSOLE.slice(CONSOLE.indexOf('function loadSuppliers()'));
  const body = load.slice(0, load.indexOf('\n  }') + 4);
  assert.match(body, /r\.status === 404/);
  assert.ok((body.match(/supUnavailable\(/g) || []).length >= 3);
});

test('loadSuppliers runs at boot, before the fleet that depends on it', () => {
  // The fleet's owner picker is filled from SUPPLIERS, so suppliers must load
  // first or the picker is empty on the first paint.
  const boot = CONSOLE.slice(CONSOLE.indexOf('paintSummary(sum);'));
  const sup = boot.indexOf('loadSuppliers();');
  const fleet = boot.indexOf('loadFleet();');
  assert.ok(sup > -1 && fleet > -1, 'both loaders must run at boot');
  assert.ok(sup < fleet, 'suppliers must load before the fleet, or the owner picker starts empty');
});

test('every supplier kind the form offers is one the server keeps', () => {
  const start = CONSOLE.indexOf('id="sp_kind"');
  const form = CONSOLE.slice(start, CONSOLE.indexOf('</select>', start));
  const offered = [...form.matchAll(/value="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(offered.length >= 5);
  for (const k of offered) {
    assert.ok(SUPPLIERS.includes(`'${k}'`),
      `the form offers "${k}" but SUPPLIER_KINDS does not list it, so the server turns it into "other"`);
  }
});

test('the owner picker exists and is sent, so an asset can belong to a supplier', () => {
  assert.ok(CONSOLE.includes('id="fl_owner"'), 'without the picker every asset belongs to the host forever');
  assert.match(CONSOLE, /function fillOwnerPicker\(/);
  const save = CONSOLE.slice(CONSOLE.indexOf("$('flForm').onsubmit"));
  assert.match(save.slice(0, 1800), /owner_id: \$\('fl_owner'\)\.value \|\| null/);
});

test('a named owner is VERIFIED against a live link, not taken on trust', () => {
  // owner_id arrives in the request body. Without this check a host could name a
  // competitor's supplier, who would then see a boat they have never heard of
  // with that host's rate on it — and a photo they texted in could auto-file
  // against it.
  const body = ASSETS.slice(ASSETS.indexOf('if (row.owner_id !== host.id)'));
  assert.ok(body.length > 0, 'owner_id is being stored without an ownership check');
  assert.match(body.slice(0, 900), /num_supplier_links/);
  assert.match(body.slice(0, 900), /status = 'accepted'/);
  assert.match(body.slice(0, 900), /ended_at IS NULL/);
  assert.match(body.slice(0, 900), /not_your_supplier/);
});

test('a supplier is found by their own phone, not only by being a NUM member', () => {
  // 0022 exists because a marina manager in Phuket is not a NUM member and never
  // will be. Before it, every photo he sent queued as an unknown sender forever.
  assert.match(MEDIA, /s\.phone = \?1/);
  const MIG22 = read('./migrations/0022_supplier_contact.sql');
  assert.match(MIG22, /ALTER TABLE num_suppliers ADD COLUMN phone TEXT;/);
  // And it must be registered, or it reaches nothing.
  assert.match(read('../scripts/apply-host-migrations.mjs'), /0022_supplier_contact\.sql/);
});

test('ended_by carries a role, not an id — the CHECK only allows three values', () => {
  assert.match(SUPPLIERS, /ended_by='host'/);
  assert.ok(!/ended_by=\?\d*.*host:\$\{/.test(SUPPLIERS), 'an identifier in ended_by fails the CHECK outright');
  assert.match(read('./migrations/0019_suppliers.sql'), /CHECK \(ended_by IN \('host','supplier','num'\)\)/);
});
