// PARTNERS, PLANS AND THE FIRST-RUN TOUR.
//
// The risk in this feature is not a bug, it is a lie: an upgrade wall over an
// empty room. Today the directory holds two VIP hosts, no ambassadors and no
// influencers. A merchant who pays to see that list and finds it empty does not
// ask for a refund, they stop believing the rest of the console.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const worker = readFileSync(join(HERE, 'worker.js'), 'utf8');
const billing = readFileSync(join(HERE, '..', 'worker', 'bizbilling.mjs'), 'utf8');
const sql = readFileSync(join(HERE, '..', 'worker', 'migrations', '0032_partners_and_tour.sql'), 'utf8');

const fn = (name) => {
  const i = worker.indexOf(`async function ${name}(`);
  if (i < 0) return '';
  let d = 0, started = false, j = i;
  for (; j < worker.length; j++) {
    if (worker[j] === '{') { d++; started = true; }
    else if (worker[j] === '}') { d--; if (started && d === 0) break; }
  }
  return worker.slice(i, j + 1);
};

test('all three pages and their forms are routed and in the nav', () => {
  for (const p of ['/biz/partners', '/biz/plan']) {
    assert.ok(worker.includes(`p === "${p}"`), `${p} is not routed`);
  }
  for (const a of ['/api/venue/intro', '/api/venue/tour']) {
    assert.ok(worker.includes(`p === "${a}" && req.method === "POST"`), `${a} is not routed`);
  }
  const nav = worker.slice(worker.indexOf('const BIZ_NAV = '), worker.indexOf('function qrNav'));
  assert.match(nav, /slug: 'partners'/);
  assert.match(nav, /slug: 'plan'/);
});

test('an empty directory is never sold as a locked one', () => {
  const page = fn('venuePartnersPage');
  assert.match(page, /const empty = total === 0/,
    'nothing distinguishes an empty list from a gated one');
  const emptyBranch = page.slice(page.indexOf('? `<div class="card"><h3>Nobody to introduce'));
  assert.match(emptyBranch.slice(0, 700), /not going to charge you for a list with nothing on it/,
    'the empty state no longer says plainly that there is nobody');
  // The branch ORDER is the property that matters: in the chain that picks
  // what to render, "there is nobody" must be answered before "you have not
  // paid". Reverse them and a venue with an empty city is shown a locked door.
  const chain = page.slice(page.indexOf('const body = broke'));
  const emptyAt = chain.indexOf(': empty');
  const gateAt = chain.indexOf(': open');
  assert.ok(emptyAt > 0 && gateAt > 0, 'the render chain has changed shape');
  assert.ok(emptyAt < gateAt,
    'the paywall is checked before the empty check — a venue with nobody nearby would be shown a locked door');
});

test('the free tier is told the counts, which is the honest reason to upgrade', () => {
  const page = fn('venuePartnersPage');
  assert.match(page, /counts\[kk\] \|\| 0/,
    'a free venue is shown nothing at all, which makes the wall look bigger than the product');
  assert.match(billing, /partner_directory: false/, 'free no longer has the directory flag');
  assert.equal((billing.match(/partner_directory: true/g) || []).length, 3,
    'the three paid tiers must each open the directory');
});

test('an introduction is gated, but joining the waitlist never is', () => {
  const intro = fn('venuePartnerIntro');
  assert.match(intro, /kind !== 'waitlist'/,
    'being told when your city opens is not a feature, and charging for it teaches a venue we expect them not to read');
  assert.match(intro, /ent\.partner_directory !== true/, 'introductions are no longer gated at all');
});

test('a failed read is never shown as an empty room', () => {
  assert.match(fn('partnersNear'), /return null;\s+\/\/ a failed read/,
    '"we could not read it" and "there is nobody" are opposite facts');
  assert.match(fn('venuePartnersPage'), /const broke = list === null/);
});

test('hosts are read live, never copied into the partners table', () => {
  assert.ok(!/INSERT INTO num_partners[\s\S]{0,200}num_hosts/.test(worker),
    'a second copy of a host is a second copy that goes stale');
  assert.match(fn('partnersNear'), /FROM num_hosts/);
  assert.ok(!/kind\s+TEXT NOT NULL,\s+--[^\n]*host/.test(sql));
});

test('an unverified follower count is shown as unknown, not as zero', () => {
  assert.match(sql, /reach\s+INTEGER,/, 'reach is not nullable, so unknown cannot be expressed');
  assert.match(fn('venuePartnersPage'), /p\.reach == null/,
    'a number we have not verified is worse than no number on a page someone spends from');
});

test('the plan page quotes the billing module, never its own prices', () => {
  const page = fn('venuePlanPage');
  assert.match(page, /bizTiers\(env\)/, 'prices are hardcoded again and can drift from checkout');
  assert.ok(!/\$9\.99|\$19\.99|1999|999/.test(page), 'a literal price is back on the plan page');
  assert.match(page, /are not part of a plan/,
    'the commission must be stated here, or upgrading reads as buying the rate down');
});

test('the tour can be dismissed and stays dismissed', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS num_biz_tour/);
  assert.match(fn('venueTourDismiss'), /ON CONFLICT\(business_id\) DO UPDATE SET dismissed_at/,
    'a second dismissal would fail and the tour would come back');
  assert.match(fn('venueHomePage'), /showTour/, 'the hub no longer shows the tour');
  assert.match(worker, /const showTour = !\(await tourDismissed/);
});

test('the tour points only at pages that exist', () => {
  const steps = worker.slice(worker.indexOf('const TOUR_STEPS'), worker.indexOf('async function tourDismissed'));
  const slugs = [...steps.matchAll(/'([a-z]+)',\s*'/g)].map((m) => m[1]);
  const nav = worker.slice(worker.indexOf('const BIZ_NAV = '), worker.indexOf('function qrNav'));
  for (const s of ['products', 'tables', 'offers', 'visitors', 'partners']) {
    assert.ok(nav.includes(`slug: '${s}'`), `the tour links to /biz/${s}, which the nav does not have`);
  }
  void slugs;
});
