/**
 * The luxury asset layer, checked.
 *
 * Three things are tested, and they are different in kind:
 *
 *  1. THE MIGRATION. Every CHECK in 0021 is asserted from the outside, by
 *     trying to write the row it should refuse. A constraint nobody tries to
 *     break is a constraint that quietly stopped working.
 *
 *  2. THE OVERLAP RULE. Its own section, because getting it wrong in either
 *     direction is expensive: too loose and two clients share a hull, too
 *     tight and every normal Saturday turnaround reads as a clash and the
 *     real ones get buried.
 *
 *  3. THE CHECKER. Every finding gets a fixture that triggers it and, where
 *     the distinction matters, one that must not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { checkAssetData, assetReport, overlaps, OCCUPYING } from './assetintegrity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(HERE, 'migrations', '0021_luxury_assets.sql'), 'utf8');

const NOW = '2026-09-12T12:00:00.000Z';
const agoDays = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString();

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE num_jobs (id TEXT PRIMARY KEY, status TEXT);');
  d.exec('CREATE TABLE num_suppliers (id TEXT PRIMARY KEY);');
  for (const s of SQL.split(';').map((x) => x.trim()).filter(Boolean)) d.exec(s + ';');
  return d;
}
const codes = (f) => f.map((x) => x.code);
const has = (f, c) => codes(f).includes(c);

let assetN = 0;
const insAsset = (d, extra) => {
  const row = {
    id: 'as' + (++assetN), owner_kind: 'supplier', owner_id: 'sup1',
    kind: 'yacht', name: 'M/Y Serenity', currency: 'EUR',
    rate_unit: 'quote', rate_minor: 0, created_at: NOW, ...(extra || {}),
  };
  const cols = Object.keys(row);
  d.prepare('insert into num_assets (' + cols.join(',') + ') values ('
    + cols.map(() => '?').join(',') + ')').run(...cols.map((c) => row[c]));
  return row.id;
};

/* ── 1. THE MIGRATION ─────────────────────────────────────────────────── */

test('migration: no semicolon hides inside a comment', () => {
  const bad = SQL.split('\n').map((l, i) => [i + 1, l])
    .filter(([, l]) => l.indexOf('--') >= 0 && l.slice(l.indexOf('--')).includes(';'));
  assert.deepEqual(bad, []);
});

test('migration: applies cleanly and creates every table', () => {
  const names = db().prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
  for (const t of ['num_assets', 'num_asset_photos', 'num_asset_holds', 'num_inbound_media']) {
    assert.ok(names.includes(t), 'missing ' + t);
  }
});

test('migration: a member-owned asset cannot be offered without verification', () => {
  // The gate on the marketplace door. Listing a Ferrari somebody does not own,
  // to a member who then pays for it, is the failure that makes this a
  // different and much worse company.
  const d = db();
  assert.throws(() => insAsset(d, { owner_kind: 'member', owner_id: 'm1', listable: 1, host_id: 'h1' }));
  insAsset(d, { owner_kind: 'member', owner_id: 'm1', listable: 1, host_id: 'h1', verified_at: NOW });
});

test('migration: a member-owned asset may exist unlisted and unverified', () => {
  // Somebody texting photos in on a Tuesday has to be able to land somewhere.
  const d = db();
  insAsset(d, { owner_kind: 'member', owner_id: 'm1', listable: 0 });
  assert.equal(d.prepare('select count(*) c from num_assets').get().c, 1);
});

test('migration: offerable inventory needs a host who can place it', () => {
  const d = db();
  assert.throws(() => insAsset(d, { listable: 1 }));
  insAsset(d, { listable: 1, host_id: 'h1' });
});

test('migration: a priced asset carries a number, a quote asset does not pretend to', () => {
  const d = db();
  assert.throws(() => insAsset(d, { rate_unit: 'week', rate_minor: 0 }));
  insAsset(d, { rate_unit: 'week', rate_minor: 18000000 });
  insAsset(d, { rate_unit: 'quote', rate_minor: 0 });
});

test('migration: a hold cannot end before it starts', () => {
  const d = db();
  const ins = (s, e) => d.prepare('insert into num_asset_holds (id,asset_id,kind,starts_at,ends_at,created_at)'
    + " values (?,?,'booked',?,?,?)").run('h' + s + e, 'as1', s, e, NOW);
  assert.throws(() => ins('2026-07-10', '2026-07-03'));
  ins('2026-07-03', '2026-07-10');
});

test('migration: a provisional hold must say when it expires', () => {
  // Otherwise the season fills with options somebody took and forgot.
  const d = db();
  const ins = (kind, exp) => d.prepare('insert into num_asset_holds'
    + ' (id,asset_id,kind,starts_at,ends_at,expires_at,created_at) values (?,?,?,?,?,?,?)')
    .run('hp' + kind + String(exp), 'as1', kind, '2026-07-03', '2026-07-10', exp, NOW);
  assert.throws(() => ins('provisional', null));
  ins('provisional', '2026-06-20');
  ins('booked', null);
});

test('migration: the same photo cannot be attached to one asset twice', () => {
  // A supplier who texts the same picture three times gets one row.
  const d = db();
  const ins = (sha) => d.prepare('insert into num_asset_photos'
    + ' (id,asset_id,r2_key,content_type,sha256,created_at) values (?,?,?,?,?,?)')
    .run('p' + Math.random(), 'as1', 'k/' + Math.random(), 'image/jpeg', sha, NOW);
  ins('abc123');
  assert.throws(() => ins('abc123'));
});

test('migration: a rejected photo must say why, and any decision must say when', () => {
  const d = db();
  const ins = (o) => {
    const row = { id: 'pz' + Math.random(), asset_id: 'as1', r2_key: 'k' + Math.random(),
      content_type: 'image/jpeg', created_at: NOW, ...o };
    const c = Object.keys(row);
    d.prepare('insert into num_asset_photos (' + c.join(',') + ') values ('
      + c.map(() => '?').join(',') + ')').run(...c.map((k) => row[k]));
  };
  assert.throws(() => ins({ moderation: 'rejected', decided_at: NOW }));
  assert.throws(() => ins({ moderation: 'ok' }));
  ins({ moderation: 'rejected', reject_note: 'a number plate is readable', decided_at: NOW });
  ins({ moderation: 'ok', decided_at: NOW, decided_by: 'dre' });
});

test('migration: attached media must say what it was attached to', () => {
  const d = db();
  const ins = (o) => {
    const row = { id: 'im' + Math.random(), from_hash: 'x', r2_key: 'k' + Math.random(),
      content_type: 'image/jpeg', created_at: NOW, ...o };
    const c = Object.keys(row);
    d.prepare('insert into num_inbound_media (' + c.join(',') + ') values ('
      + c.map(() => '?').join(',') + ')').run(...c.map((k) => row[k]));
  };
  assert.throws(() => ins({ status: 'attached' }));
  ins({ status: 'attached', asset_id: 'as1' });
  ins({ status: 'new' });
});

test('migration: num_inbound_media keeps a hash, not a phone number', () => {
  // A moderation screen will one day render these rows. It must not be able to
  // render somebody's mobile number.
  const cols = db().prepare('pragma table_info(num_inbound_media)').all().map((c) => c.name);
  assert.ok(cols.includes('from_hash'));
  assert.ok(!cols.includes('from_phone'), 'a raw phone number column has appeared');
  assert.ok(!cols.includes('phone'), 'a raw phone number column has appeared');
});

/* ── 2. THE OVERLAP RULE ──────────────────────────────────────────────── */

test('overlap: a normal Saturday turnaround is NOT a clash', () => {
  // One charter ends the morning the next begins. This is the industry's
  // normal week. Calling it a clash would bury every real one.
  assert.equal(overlaps('2026-07-04', '2026-07-11', '2026-07-11', '2026-07-18'), false);
});

test('overlap: a genuine double booking IS a clash, in both orders', () => {
  assert.equal(overlaps('2026-07-04', '2026-07-11', '2026-07-08', '2026-07-15'), true);
  assert.equal(overlaps('2026-07-08', '2026-07-15', '2026-07-04', '2026-07-11'), true);
});

test('overlap: one charter wholly inside another is a clash', () => {
  assert.equal(overlaps('2026-07-01', '2026-07-31', '2026-07-10', '2026-07-12'), true);
});

test('overlap: only booked and provisional holds occupy the asset', () => {
  assert.ok(OCCUPYING.has('booked'));
  assert.ok(OCCUPYING.has('provisional'));
  assert.ok(!OCCUPYING.has('blocked'), 'a yard period should not read as a booking');
  assert.ok(!OCCUPYING.has('maintenance'));
});

/* ── 3. THE CHECKER ───────────────────────────────────────────────────── */

const asset = (o) => ({ id: 'a1', owner_kind: 'supplier', owner_id: 'sup1', host_id: 'h1',
  kind: 'yacht', name: 'M/Y Serenity', status: 'active', listable: 1,
  lat: 43.58, lon: 7.12, rate_unit: 'quote', rate_minor: 0,
  settle_mode: 'host_direct', verified_at: NOW, created_at: agoDays(30), ...o });
const photo = (o) => ({ id: 'p1', asset_id: 'a1', moderation: 'ok', created_at: agoDays(10), ...o });
const hold = (o) => ({ id: 'h1', asset_id: 'a1', job_id: 'j1', kind: 'booked',
  starts_at: '2026-07-04', ends_at: '2026-07-11', created_at: agoDays(20), ...o });
const base = (o) => ({ assets: [asset()], photos: [photo()], holds: [hold()],
  jobs: [{ id: 'j1', asset_id: 'a1', status: 'accepted' }], ...o });

test('checker: a clean world reports nothing', () => {
  const r = assetReport(base(), NOW);
  assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
});

test('BREACH: one hull, two clients, same week', () => {
  const f = checkAssetData(base({
    holds: [hold(), hold({ id: 'h2', job_id: 'j2', starts_at: '2026-07-08', ends_at: '2026-07-15' })],
    jobs: [{ id: 'j1', asset_id: 'a1', status: 'accepted' }, { id: 'j2', asset_id: 'a1', status: 'accepted' }],
  }), NOW);
  assert.ok(has(f, 'asset_double_booked'));
  // And it must be the loudest thing in the report.
  const r = assetReport(base({
    holds: [hold(), hold({ id: 'h2', job_id: 'j2', starts_at: '2026-07-08', ends_at: '2026-07-15' })],
    jobs: [{ id: 'j1', asset_id: 'a1', status: 'accepted' }, { id: 'j2', asset_id: 'a1', status: 'accepted' }],
  }), NOW);
  assert.match(r.verdict, /DOUBLE-BOOKED/);
});

test('no breach: back-to-back charters on one hull are fine', () => {
  const f = checkAssetData(base({
    holds: [hold(), hold({ id: 'h2', job_id: 'j2', starts_at: '2026-07-11', ends_at: '2026-07-18' })],
    jobs: [{ id: 'j1', asset_id: 'a1', status: 'accepted' }, { id: 'j2', asset_id: 'a1', status: 'accepted' }],
  }), NOW);
  assert.ok(!has(f, 'asset_double_booked'), JSON.stringify(codes(f)));
});

test('no breach: a released hold blocks nothing', () => {
  const f = checkAssetData(base({
    holds: [hold(), hold({ id: 'h2', job_id: 'j2', starts_at: '2026-07-08',
      ends_at: '2026-07-15', released_at: agoDays(1), release_reason: 'client changed plans' })],
    jobs: [{ id: 'j1', asset_id: 'a1', status: 'accepted' }, { id: 'j2', asset_id: 'a1', status: 'cancelled' }],
  }), NOW);
  assert.ok(!has(f, 'asset_double_booked'));
});

test('BREACH: a member asset offered with no ownership check', () => {
  const f = checkAssetData(base({
    assets: [asset({ owner_kind: 'member', owner_id: 'm1', verified_at: null })],
  }), NOW);
  assert.ok(has(f, 'member_asset_listable_unverified'));
});

test('BREACH: NUM settling a charter to an owner nobody verified', () => {
  const f = checkAssetData(base({
    assets: [asset({ settle_mode: 'num_collects', verified_at: null, owner_kind: 'supplier' })],
  }), NOW);
  assert.ok(has(f, 'num_settles_to_unverified_owner'));
});

test('no breach: NUM settling to a verified owner is the intended setup', () => {
  const f = checkAssetData(base({
    assets: [asset({ settle_mode: 'num_collects', verified_at: agoDays(5), verified_by: 'dre' })],
  }), NOW);
  assert.ok(!has(f, 'num_settles_to_unverified_owner'));
});

test('BREACH: a tail number in the text a client reads', () => {
  const f = checkAssetData(base({
    assets: [asset({ registration: 'N512JM', notes: 'Based at Nice. Aircraft N512-JM, crew of two.' })],
  }), NOW);
  assert.ok(has(f, 'registration_in_client_copy'));
});

test('no breach: a registration held privately and not repeated is fine', () => {
  const f = checkAssetData(base({
    assets: [asset({ registration: 'N512JM', notes: 'Based at Nice, crew of two.' })],
  }), NOW);
  assert.ok(!has(f, 'registration_in_client_copy'));
});

test('BREACH: a confirmed hold with nothing behind it', () => {
  const f = checkAssetData(base({ holds: [hold({ job_id: null })] }), NOW);
  assert.ok(has(f, 'booked_hold_without_job'));
});

test('BREACH: live work against a retired hull', () => {
  const f = checkAssetData(base({
    assets: [asset({ status: 'retired', retired_at: agoDays(2), listable: 0, host_id: 'h1' })],
  }), NOW);
  assert.ok(has(f, 'live_job_on_inactive_asset'));
});

test('ORPHAN: a provisional hold past its expiry still blocking the season', () => {
  const f = checkAssetData(base({
    holds: [hold({ kind: 'provisional', expires_at: agoDays(4), job_id: null })],
  }), NOW);
  assert.ok(has(f, 'provisional_hold_expired'));
});

test('ORPHAN: dates still held for a job that was cancelled', () => {
  const f = checkAssetData(base({
    jobs: [{ id: 'j1', asset_id: 'a1', status: 'cancelled' }],
  }), NOW);
  assert.ok(has(f, 'hold_for_dead_job'));
});

test('ORPHAN: a photo texted in days ago that nobody filed', () => {
  // The sender has assumed it worked. It did not.
  const f = checkAssetData(base({
    media: [{ id: 'im1', status: 'new', created_at: agoDays(5) }],
  }), NOW);
  assert.ok(has(f, 'inbound_media_unresolved'));
});

test('no orphan: a photo that arrived this morning is not late yet', () => {
  const f = checkAssetData(base({
    media: [{ id: 'im1', status: 'new', created_at: agoDays(0.2) }],
  }), NOW);
  assert.ok(!has(f, 'inbound_media_unresolved'));
});

test('ORPHAN: photos from a number matching no supplier', () => {
  const f = checkAssetData(base({
    media: [{ id: 'im2', status: 'unknown_sender', created_at: agoDays(1) }],
  }), NOW);
  assert.ok(has(f, 'media_from_unknown_sender'));
});

test('ORPHAN: an asset whose supplier has left the host', () => {
  const f = checkAssetData(base({
    links: [{ id: 'l1', supplier_id: 'sup1', host_id: 'h1', status: 'ended' }],
  }), NOW);
  assert.ok(has(f, 'asset_of_ended_supplier_link'));
});

test('DRIFT: offered to clients with nothing to look at', () => {
  const f = checkAssetData(base({ photos: [] }), NOW);
  assert.ok(has(f, 'listable_without_an_approved_photo'));
});

test('DRIFT: a photo still awaiting moderation does not count as a photo', () => {
  const f = checkAssetData(base({ photos: [photo({ moderation: 'new', decided_at: null })] }), NOW);
  assert.ok(has(f, 'listable_without_an_approved_photo'));
});

test('DRIFT: offerable and unfindable', () => {
  const f = checkAssetData(base({ assets: [asset({ lat: null, lon: null })] }), NOW);
  assert.ok(has(f, 'listable_without_coordinates'));
});

test('DRIFT: a moderation queue nobody is working', () => {
  const f = checkAssetData(base({
    photos: [photo(), photo({ id: 'p2', moderation: 'new', created_at: agoDays(6) })],
  }), NOW);
  assert.ok(has(f, 'photos_awaiting_moderation_over_3d'));
});

test('DRIFT: a week rate with nothing said about what lands on top', () => {
  // Charter norms put fuel, food, berths and tax on top of the base. A base
  // presented as the price is how a client is surprised by half again.
  const f = checkAssetData(base({
    assets: [asset({ rate_unit: 'week', rate_minor: 18000000, extras_note: null })],
  }), NOW);
  assert.ok(has(f, 'week_rate_without_extras_note'));
});

test('no drift: a week rate that says what else is payable', () => {
  const f = checkAssetData(base({
    assets: [asset({ rate_unit: 'week', rate_minor: 18000000,
      extras_note: 'Plus APA at 30% for fuel, provisioning, berths. VAT per itinerary.' })],
  }), NOW);
  assert.ok(!has(f, 'week_rate_without_extras_note'));
});

test('report: breaches rank above everything and are named plainly', () => {
  const r = assetReport(base({
    assets: [asset({ settle_mode: 'num_collects', verified_at: null })],
    photos: [],
  }), NOW);
  assert.equal(r.findings[0].severity, 'breach');
  assert.equal(r.clean, false);
});

test('report: a world with only tidying to do does not cry breach', () => {
  const r = assetReport(base({ assets: [asset({ lat: null, lon: null })] }), NOW);
  assert.equal(r.clean, true);
  assert.match(r.verdict, /No breaches/);
});
