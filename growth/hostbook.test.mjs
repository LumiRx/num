// The VIP host's book — clients, introductions, the shelf, and the network.
//
// These tests exist because every one of them pins a PROMISE, not a function.
// The host model changed on 3 Sep 2026 from "host is a referrer who earns 3% of
// NUM's commission" to "host is our customer, the client is theirs, and the
// host pays a monthly plan". Almost every failure mode in this system is the
// old model leaking back in: NUM billing a host's client, NUM contacting a
// host's client, NUM confirming on a host's behalf, or a host being opted into
// something they never switched on. Each test below is one of those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const worker = read('growth/worker.js');
const migration = read('worker/migrations/0014_host_clients.sql');
const hostsPage = read('public/hosts/index.html');
const consolePage = read('public/host/index.html');

/* ── 1. THE CONTRADICTION THAT BLOCKED THE FILM ───────────────────────────
 * /hosts/ told a host their clients stayed theirs, and the checkbox on the
 * same page assigned those clients to NUM's commission structure for 12
 * months. The thing a host legally agreed to was the opposite of the thing
 * they had just read, at the exact moment they decided to trust us. */
test('the signup checkbox agrees to the plan model, not the 3% model', () => {
  const box = hostsPage.slice(
    hostsPage.indexOf('class="hostterms"'),
    hostsPage.indexOf('</label>', hostsPage.indexOf('class="hostterms"')),
  );
  assert.ok(box.length > 100, 'the consent checkbox is missing from /hosts/');
  assert.ok(
    !/3%/.test(box),
    'the consent checkbox still assigns the host 3% of NUM commission — the page promises the opposite',
  );
  assert.ok(
    !/12 months/.test(box),
    'the consent checkbox still ties the host’s clients to NUM for 12 months',
  );
  assert.match(box, /monthly plan/i, 'the checkbox does not mention the plan the host is actually agreeing to');
  assert.match(box, /clients stay mine|stay mine/i, 'the checkbox no longer says the clients stay the host’s');
  // One charge now, and the checkbox must rule out the others — "monthly plan"
  // alone leaves a concierge wondering whether we take a cut of their work.
  assert.match(box, /no per-booking fee/i, 'the checkbox does not rule out a per-booking fee');
  assert.match(box, /no commission on\s+my work/i, 'the checkbox does not rule out a commission');
  assert.match(box, /does not limit how many\s+clients/i, 'the checkbox does not say the plan is not a client cap');
  assert.ok(!/free while I have 3/i.test(box), 'the checkbox still describes a client cap');
});

test('the welcome email describes the same deal the page does', () => {
  const mail = worker.slice(worker.indexOf('subject: "Your NUM host account'), worker.indexOf('Reply to this email and a person answers'));
  assert.ok(mail.length > 200, 'the host welcome email is missing');
  assert.ok(!/3% of what/.test(mail), 'the welcome email still promises 3% of NUM’s commission');
  assert.ok(!/yours for 12 months/.test(mail), 'the welcome email still claims NUM owns the client for 12 months');
  assert.match(mail, /does not take a commission/i, 'the welcome email does not say NUM takes no commission from the client');
  assert.match(mail, /no fee per booking/i, 'the welcome email does not rule out a per-booking fee');
  assert.ok(!/£5 for\s+each booking/i.test(mail), 'the welcome email still promises a £5 booking fee');
  assert.match(mail, /does not limit how\s+many clients/i, 'the welcome email still implies a client cap');
});

test('the terms version was bumped, and the old one is not reused', () => {
  // What a host agreed to is a fact about a day. Reusing the string would make
  // rows signed under the old wording indistinguishable from rows signed under
  // the new one, which is how you lose a dispute you should win.
  assert.match(worker, /TERMS_VERSION = "host-plan-2026-09-03"/, 'TERMS_VERSION was not bumped for the new agreement');
  assert.ok(!/TERMS_VERSION = "host-2026-07-31"/.test(worker), 'the old terms version is still live');
});

/* ── 2. NUM NEVER BILLS A HOST'S CLIENT, AND NEVER CHARGES PER CLIENT ────
 * Four revenue lines, and two of them touch people who are not our customers.
 * These tests keep them apart. */
test('no tier caps clients — a host is never charged for the size of their book', () => {
  assert.match(worker, /const HOST_TIER_CLIENTS = -1;/,
    'a client cap has been reintroduced — read the comment above it before changing this test');
  assert.ok(!/HOST_TIER_LIMITS/.test(worker), 'the per-client cap table is back');
  // And nothing refuses a client on plan grounds, anywhere.
  assert.ok(!/plan_full/.test(worker), 'some path still refuses a host a client because of what they pay');
  assert.ok(!/host_at_capacity/.test(worker), 'a member can still be refused an introduction on plan grounds');
  assert.match(worker, /full: false,/, 'plan.full is no longer a constant false');
  assert.match(migration, /THERE IS NO CLIENT CAP ON ANY TIER/,
    'the schema no longer records why there is no cap');
});

test('the tiers gate capability, and never the work itself', () => {
  assert.match(worker, /FEATURE_MIN_TIER = \{[\s\S]{0,240}products: "full"/,
    'the feature gates are gone — the tiers would be decoration and nobody upgrades');
  const gates = worker.slice(worker.indexOf('const FEATURE_MIN_TIER'), worker.indexOf('const FEATURE_LABEL'));
  // The work a host does for their own clients must never sit behind a paywall.
  for (const never of ['clients', 'requests', 'pricing', 'services']) {
    assert.ok(!new RegExp(`\\b${never}:`).test(gates), `${never} is behind a paywall — a host whose clients are stuck is a host who leaves`);
  }
  assert.match(worker, /return needsTier\("products"\)/, 'the products shelf is not gated');
  assert.match(worker, /return needsTier\("network"\)/, 'the host network is not gated');
  assert.match(worker, /return needsTier\("intros"\)/, 'introductions are not gated');
});

test('a refusal tells the host what unlocks it and what it costs', () => {
  const nt = worker.slice(worker.indexOf('function needsTier'), worker.indexOf('/* ---------------- '));
  assert.match(nt, /needs_tier: need/, 'the refusal does not say which plan is needed');
  assert.match(nt, /price: HOST_TIER_PRICE\[need\]/, 'the refusal does not say what it costs');
  assert.match(nt, /nothing you already have is taken away/, 'the refusal does not reassure the host');
});

test('a downgraded host disappears from the public directory too', () => {
  // Otherwise members keep being offered someone who can no longer accept them.
  const nearby = worker.slice(worker.indexOf('async function hostNearby'), worker.indexOf('async function hostIntro('));
  assert.equal((nearby.match(/h\.tier IN \('pro','full'\)/g) || []).length, 2,
    'the nearby query does not gate on tier in both branches');
  const intro = worker.slice(worker.indexOf('async function hostIntro('), worker.indexOf('async function hostIntros'));
  assert.match(intro, /hostCan\(host\.tier, "intros"\)/,
    'a host who downgraded between being listed and being tapped can still be sent a member');
});

test('confirming costs the host nothing', () => {
  // Was: "the booking fee lands on the host, on confirm, once". Removed on
  // 7 Sep 2026 — a per-booking charge is a tax on using the product, and it
  // taught hosts to confirm elsewhere. Revenue is the plan.
  assert.match(worker, /import \{ BOOKING_FEE_MINOR \} from '\.\.\/worker\/servicefee\.mjs'/,
    'the fee is no longer read from the one place that defines it');
  const reqs = worker.slice(worker.indexOf('async function hostRequests'), worker.indexOf('async function hostNetwork'));
  assert.match(reqs, /booking_fee_minor = CASE WHEN \? = 'confirmed'/, 'the fee column write vanished — history will not survive');
  assert.ok(!/BOOKING_FEE_MINOR\s*=\s*[1-9]/.test(worker), 'a non-zero fee is back in the growth worker');
});

test('the fee constant is zero under both of its names', async () => {
  const fee = await import('../worker/servicefee.mjs');
  assert.equal(fee.BOOKING_FEE_MINOR, 0, 'the per-booking fee is back');
  assert.equal(fee.MEMBER_SERVICE_FEE_MINOR, 0, 'the member-side fee is back');
  assert.match(read('worker/servicefee.mjs'), /revenue is now ONE line/i,
    'the file no longer says what replaced the fee');
});

test('nobody is billed for a booking — hosted or not', async () => {
  const { bookingFeeFor } = await import('../worker/servicefee.mjs');
  const db = (row) => ({ DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) } });

  const hosted = await bookingFeeFor(db({ host_id: 'h_1' }), 'm_1');
  assert.equal(hosted.member_pays_minor, 0, 'a hosted member is charged');
  assert.equal(hosted.fee_minor, 0, 'a fee is charged on a hosted booking');
  assert.equal(hosted.host_id, 'h_1', 'the host is no longer identified — the app needs this');

  const alone = await bookingFeeFor(db(null), 'm_2');
  assert.equal(alone.member_pays_minor, 0, 'a member with no host is charged a booking fee');
});

test('only an ACTIVE client counts as hosted', () => {
  assert.match(read('worker/servicefee.mjs'), /status = 'active'/,
    'a paused or removed client still counts as hosted');
});

/* ── 3. NUM NEVER CONTACTS A HOST'S CLIENT FIRST ─────────────────────────── */
test('a client cannot be added without a real consent attestation', () => {
  assert.match(worker, /CLIENT_CONSENT_MIN = 40/, 'the consent minimum is gone');
  assert.match(worker,
    /consent\.length < CLIENT_CONSENT_MIN\)[\s\S]{0,120}consent_required/,
    'adding a client no longer requires the attestation');
  // The exact words, not a version string. In a complaint the question is what
  // THIS host agreed to on THIS day; a pointer to a document we have since
  // edited does not answer it.
  assert.match(worker, /consent\.slice\(0, 1200\)/, 'the attestation text is no longer stored verbatim');
});

test('the suppression list beats a host’s assertion', () => {
  const book = worker.slice(worker.indexOf('async function hostClients'), worker.indexOf('async function hostProducts'));
  assert.match(book, /num_suppressions/, 'a host can add someone who asked NUM never to contact them');
});

/* ── 4. INTRODUCTIONS ARE OFFERED, NEVER ASSIGNED ────────────────────────── */
test('both switches that put a stranger near a host’s book default to off', () => {
  assert.match(migration, /accepts_intros INTEGER NOT NULL DEFAULT 0/, 'accepts_intros does not default to off');
  assert.match(migration, /in_network INTEGER NOT NULL DEFAULT 0/, 'in_network does not default to off');
  // And in code, so a truthy string or a missing field cannot switch them on.
  assert.match(worker, /b\.accepts_intros === true \|\| b\.accepts_intros === 1/, 'accepts_intros can be set by a loose value');
  assert.match(worker, /b\.in_network === true \|\| b\.in_network === 1/, 'in_network can be set by a loose value');
});

test('three separate yeses exist before one person’s details reach another', () => {
  // host switched it on, member asked, host accepted this person.
  assert.match(worker, /accepts_intros = 1 AND status = 'active'/, 'an intro can be created for a host who never opted in');
  assert.match(worker, /member_said/, 'the member’s own yes is not recorded');
  assert.match(migration, /host_said\s+TEXT NOT NULL DEFAULT 'pending'/, 'the host’s yes does not default to pending');
  assert.match(worker, /if \(b\.share_ok !== true\) return J\(\{ ok: false, error: "consent_required" \}/,
    'a member can be introduced without agreeing to share anything');
});

test('the public host directory carries nothing that could contact anyone', () => {
  const nearby = worker.slice(worker.indexOf('async function hostNearby'), worker.indexOf('async function hostIntro('));
  assert.ok(nearby.length > 500, 'hostNearby is missing');
  assert.ok(!/\bh\.email\b/.test(nearby), 'the public directory exposes a host email');
  assert.ok(!/notify_phone|h\.phone/.test(nearby), 'the public directory exposes a host phone number');
});

test('there is no "full host" to refuse a member — the plan does not cap clients', () => {
  // This test used to assert the opposite. It was correct under a per-client
  // plan and is wrong under a flat one: a host who does not want more people
  // switches accepts_intros off, which is a decision they make rather than one
  // their invoice makes for them.
  const intro = worker.slice(worker.indexOf('async function hostIntro('), worker.indexOf('async function hostIntros'));
  assert.ok(!/host_at_capacity/.test(intro), 'an introduction can still be refused on plan grounds');
  assert.match(intro, /No capacity check/, 'the reason there is no capacity check is no longer written down');
});

test('declining an introduction deletes the person’s details', () => {
  const intros = worker.slice(worker.indexOf('async function hostIntros'));
  assert.match(intros, /DELETE FROM num_host_clients WHERE id = \? AND host_id = \?/,
    'a declined introduction leaves the member’s details sitting in a host’s book');
});

test('nearest-host matching queries an indexed table, not a JSON scan', () => {
  // areas_json was read but never written until 3 Sep 2026, so matching had
  // nothing to match on. A LIKE scan over JSON is the version of the fix that
  // quietly stops working at a few hundred hosts and is never noticed.
  assert.match(worker, /async function syncHostAreas/, 'the areas shadow table is never written');
  assert.match(worker, /await syncHostAreas\(env, host\.id, areas\)/, 'saving a profile does not sync the areas table');
  assert.match(worker, /FROM num_host_areas a JOIN num_hosts h/, 'matching does not use the indexed areas table');
  assert.match(migration, /idx_host_areas_geo/, 'there is no geo index to match against');
  assert.match(consolePage, /id="areas"/, 'the console has no way to enter a city, so coverage stays empty');
});

/* ── 5. NUM NEVER CONFIRMS ON A HOST'S BEHALF ────────────────────────────── */
test('confirmed is reachable only by an explicit confirm action', () => {
  const reqs = worker.slice(worker.indexOf('async function hostRequests'), worker.indexOf('async function hostNetwork'));
  assert.ok(reqs.length > 500, 'hostRequests is missing');
  const confirms = reqs.match(/'confirmed'/g) || [];
  // Every occurrence must be inside the one action branch. If this count grows,
  // something else in the file learned how to confirm.
  assert.ok(confirms.length <= 4, `status 'confirmed' is set in ${confirms.length} places — auto-confirm has crept in`);
  assert.match(reqs, /action === "confirm"/, 'there is no explicit confirm action');
  assert.ok(!/auto_confirm|autoConfirm/i.test(worker), 'an auto-confirm path exists');
  // Checked against the CHECK clause itself, not the whole file — 0014's own
  // comment names the state it refuses to have, and that comment is the point.
  const statusCheck = migration.slice(
    migration.indexOf("CHECK (status IN ('new','drafted'"),
    migration.indexOf('draft_text'),
  );
  assert.ok(statusCheck.length > 20, 'the request status vocabulary is missing from 0014');
  assert.ok(!/auto_confirmed/.test(statusCheck), 'the schema allows an auto-confirmed state');
});

/* ── 6. THE SHELF ────────────────────────────────────────────────────────── */
test('a Ghost line that cannot resolve cannot go live', () => {
  // The Resolution Rule from num-GHOST-MESSAGE-SPEC.md. A code that resolves to
  // nothing is the single failure that makes the primitive untrustworthy: the
  // buyer texted it off a card and got silence.
  assert.match(worker,
    /if \(!out\.sku \|\| !out\.keyword \|\| !out\.photo_url \|\| out\.price_minor <= 0\) out\.active = 0/,
    'an incomplete Ghost line can be saved as live');
  assert.match(migration,
    /CHECK \(kind <> 'ghost' OR active = 0/,
    'the schema does not enforce the Resolution Rule');
});

test('a host cannot set the price of a NUM product', () => {
  // A host quoting a NUM price we later change is the one who looks wrong to
  // their client.
  assert.match(worker, /out\.price_minor = 0;\s+\/\/ our price, not theirs/,
    'a host can set their own price for one of our products');
});

test('the three product kinds all exist and are closed', () => {
  assert.match(worker, /HOST_PRODUCT_KINDS = \["own", "num", "ghost"\]/, 'the product kinds changed');
  assert.match(migration, /kind\s+TEXT NOT NULL CHECK \(kind IN \('own','num','ghost'\)\)/, 'the schema does not close the kind vocabulary');
});

/* ── 7. THE NETWORK ──────────────────────────────────────────────────────── */
test('NUM takes a flat network fee and never the client’s money', () => {
  assert.match(worker, /NETWORK_FEE_MINOR = 500/, 'the network fee changed — change this test on purpose');
  // Anchored to the block that now follows hostNetwork. Widen this slice and
  // it swallows the separation emails, which legitimately use the word
  // "charged" — and the test then fails for a reason that is not a defect.
  const net = worker.slice(worker.indexOf('async function hostNetwork'), worker.indexOf('ENDING IT — from either side'));
  assert.match(net, /invoice you/i, 'the console is not told how the money actually works');
  assert.ok(!/stripe|payment_intent|charge/i.test(net), 'the network path has grown a payment rail — Host B invoices Host A');
});

test('a host cannot hand work to someone they are not connected to', () => {
  const reqs = worker.slice(worker.indexOf('async function hostRequests'), worker.indexOf('async function hostNetwork'));
  assert.match(reqs, /if \(!link\) return J\(\{ ok: false, error: "not_connected" \}/,
    'work can be handed to a host who never agreed to receive it');
});

test('a host cannot accept their own connection request', () => {
  const net = worker.slice(worker.indexOf('async function hostNetwork'));
  assert.match(net, /asked_by <> \?/, 'a host can ask and then accept on the other host’s behalf');
});

/* ── 8. ROUTING AND THE CONSOLE ──────────────────────────────────────────── */
test('every new endpoint is routed', () => {
  for (const p of ['clients', 'products', 'requests', 'network', 'intros', 'nearby', 'intro']) {
    assert.match(worker, new RegExp(`p === "/api/host/${p}"`), `/api/host/${p} is not routed`);
  }
});

test('the console can reach all of them', () => {
  for (const p of ['clients', 'products', 'requests', 'network', 'intros']) {
    assert.match(consolePage, new RegExp(`'${p}'`), `the console never calls /api/host/${p}`);
  }
  assert.match(consolePage, /api\/host\/' \+ path/, 'the console lost its shared API helper');
});

test('the console no longer tells a host their clients are ours for 12 months', () => {
  assert.ok(
    !/is yours for ' \+ d\.term_months \+ ' months/.test(consolePage),
    'the console lede still describes the referral model the page abandoned',
  );
  assert.match(consolePage, /Your clients are yours\. NUM is the back office/,
    'the console does not state the model it now runs on');
});

test('the console says out loud who pays what', () => {
  assert.match(consolePage, /never charged by NUM, for anything, on any plan/i,
    'nothing on the console tells a host their client pays us nothing — it is the whole pitch');
  assert.match(consolePage, /no plan\s+limits how many\s+clients/i,
    'the console does not say the plan is not a client cap');
  assert.match(consolePage, /Confirming costs you nothing/i,
    'the console does not tell a host that confirming is free');
  assert.match(consolePage, /no per-booking fee and no commission on your work/i,
    'the console does not rule out a fee and a commission');
});

test('the member page says a host is free to them, and a gate to nothing', () => {
  const page = read('public/find-a-host/index.html');
  // A host used to be sold as the thing that absorbed the member's £5. Now
  // there is no member £5 at all, so the promise is the flat one — and it has
  // to stay flat, because the moment a page implies a traveller pays NUM for
  // arranging travel we are back inside California §17550.
  assert.match(page, /never charges a traveller a\s+booking fee/i,
    'the member page no longer says plainly that NUM does not charge travellers');
  assert.match(page, /You do not need one/i, 'the page no longer says a host is optional');
});

/* ── 9. THE MIGRATION ACTUALLY APPLIES ───────────────────────────────────
 * 0013 shipped as a file nobody could run without reading a paragraph of
 * instructions first, and 0004 was written and never applied at all. A
 * migration that has never been executed is a design document. This test
 * runs 0014 against a real SQLite and proves the two rules bite in the
 * database, not only in the worker. */
test('0014 applies cleanly and its constraints bite', async () => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { return; }                       // older Node: the other tests still ran

  const sql = read('worker/migrations/0014_host_clients.sql');
  // A semicolon inside a comment splits a statement in half in every naive
  // migration runner there is. Keep them out of the comments.
  for (const line of sql.split('\n')) {
    const c = line.indexOf('--');
    if (c !== -1) assert.ok(!line.slice(c).includes(';'), `semicolon inside a comment will split a statement: ${line.trim().slice(0, 60)}`);
  }

  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE num_hosts (id TEXT PRIMARY KEY, tier TEXT, status TEXT, name TEXT, company TEXT, email TEXT, currency TEXT, services_json TEXT, created_at TEXT, updated_at TEXT)');
  const stmts = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
    .split(';').map((s) => s.trim()).filter(Boolean);
  for (const s of stmts) db.exec(s);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  for (const t of ['num_host_areas', 'num_host_clients', 'num_host_links', 'num_host_offers', 'num_host_products', 'num_host_requests']) {
    assert.ok(tables.includes(t), `0014 did not create ${t}`);
  }

  // The Resolution Rule, at the database.
  db.exec("INSERT INTO num_host_products (id,host_id,kind,name,created_at,active) VALUES ('p1','h1','ghost','Roses','now',0)");
  assert.throws(() => db.exec("UPDATE num_host_products SET active=1 WHERE id='p1'"),
    'an incomplete Ghost line went live — the Resolution Rule is not enforced in the schema');
  db.exec("UPDATE num_host_products SET sku='6943',keyword='roses',photo_url='https://x/y.jpg',price_minor=6500 WHERE id='p1'");
  db.exec("UPDATE num_host_products SET active=1 WHERE id='p1'");

  // An introduction starts as nobody having said yes.
  db.exec("INSERT INTO num_host_offers (id,member_id,host_id,created_at) VALUES ('o1','m1','h1','now')");
  const o = db.prepare("SELECT member_said, host_said FROM num_host_offers WHERE id='o1'").get();
  assert.equal(o.member_said, 'pending', 'an offer starts with the member already having agreed');
  assert.equal(o.host_said, 'pending', 'an offer starts with the host already having agreed');

  // And a host is not opted into anything by the migration itself.
  db.exec("INSERT INTO num_hosts (id,tier) VALUES ('h9','free')");
  const h = db.prepare("SELECT accepts_intros, in_network FROM num_hosts WHERE id='h9'").get();
  assert.equal(h.accepts_intros, 0, 'a new host accepts introductions by default');
  assert.equal(h.in_network, 0, 'a new host is listed in the network by default');
});

/* ── 10. THE MEMBER'S HALF ───────────────────────────────────────────────
 * The host side of an introduction is useless without a surface where a
 * member can actually ask. This is that surface, and these tests pin the one
 * thing it must never become: a gate. */
test('the member-facing page exists and reaches both public endpoints', () => {
  const page = read('public/find-a-host/index.html');
  assert.ok(page.length > 3000, 'public/find-a-host/index.html is missing or a stub');
  assert.match(page, /\/api\/host\/nearby\?city=/, 'the page never looks up nearby hosts');
  assert.match(page, /\/api\/host\/intro/, 'the page cannot actually ask for an introduction');
});

test('the member page says, in words, that a host is optional', () => {
  const page = read('public/find-a-host/index.html');
  assert.match(page, /You do not need one/i, 'the page does not say a host is optional');
  assert.match(page, /either way/i, 'the page does not say NUM books their travel regardless');
  assert.match(page, /cost you nothing|they pay us/i, 'the page does not say the member is never charged for a host');
});

test('nothing is shared before the member ticks the box', () => {
  const page = read('public/find-a-host/index.html');
  assert.match(page, /id="a_share"[\s\S]{0,200}Share my name and email/,
    'the sharing consent checkbox is gone from the member page');
  assert.match(page, /share_ok: true/, 'the page does not send the member’s own consent');
  assert.match(page, /Nothing of yours was shared/, 'a failed ask does not reassure the member');
});

/* ── 11. THE PAGE WE SEND TO HOSTS ───────────────────────────────────────
 * /hosts/ is the page a concierge reads before deciding whether to trust us.
 * Until 3 Sep 2026 it did not state a price anywhere, so every host had to
 * email to find out — and the ones who did not email simply left. */
test('the hosts page states what it costs, without being asked', () => {
  assert.match(hostsPage, /id="pricing"/, 'the pricing section is gone from /hosts/');
  for (const price of ['£0', '£9.99', '£19.99', '£50']) {
    assert.ok(hostsPage.includes(price.replace('£', '&pound;')) || hostsPage.includes(price),
      `the ${price} plan is not shown on /hosts/`);
  }
  assert.match(hostsPage, /no fee per booking, no commission on your work/i,
    '/hosts/ does not state that the plan is the only charge');
  assert.ok(!/&pound;5 for each booking/i.test(hostsPage), '/hosts/ still advertises a per-booking fee');
});

test('the hosts page makes the two promises that decide the sale', () => {
  assert.match(hostsPage, /never charged by NUM, for anything, on\s*\n?\s*any plan/i,
    '/hosts/ does not promise the client is never charged');
  assert.match(hostsPage, /No plan limits how many clients you can have/i,
    '/hosts/ does not say there is no client cap');
});

test('nothing anywhere public still sells the 3% referral model', () => {
  // The flyer was print artwork nobody thought to update, and it is the thing
  // a host is physically handed.
  const flyer = read('public/flyers/hosts/index.html');
  assert.ok(!/3%/.test(flyer), 'the host flyer still promises 3% of NUM commission');
  assert.ok(!/Recurring commission|Passive income/i.test(flyer), 'the host flyer still sells the referral model');
  assert.match(flyer, /never charged by NUM/i, 'the flyer does not carry the promise the page makes');
  assert.ok(!/earnings ledger/i.test(hostsPage), '/hosts/ still describes the old earnings ledger as what is live');
});
