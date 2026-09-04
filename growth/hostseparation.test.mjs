// ENDING THE RELATIONSHIP — from either side, on the record, both sides told.
//
// 0014 gave only the host a way out, silently, by setting a status. These
// tests pin the two things that fixes: the person with the least power in the
// arrangement can leave, and no ending happens without the other side being
// told. An ending nobody is told about is not an ending — the other party goes
// on believing the relationship exists, and the £5 booking fee keeps landing
// on whoever the stale row says it should.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkHostData, integrityReport } from '../worker/hostintegrity.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const worker = read('growth/worker.js');
const m15 = read('worker/migrations/0015_host_separation.sql');
const consolePage = read('public/host/index.html');
const memberPage = read('public/my-host/index.html');

const codes = (findings) => findings.map((f) => f.code);

/* ── 1. THE MEMBER CAN ACTUALLY LEAVE ────────────────────────────────── */

test('every client gets their own way out, not just introduced ones', () => {
  assert.match(m15, /ALTER TABLE num_host_clients ADD COLUMN member_token TEXT/,
    'clients have no token, so no page can let them leave');
  // Both insert paths mint one. A client added by hand who cannot leave is the
  // same trap as an introduced one who cannot.
  const book = worker.slice(worker.indexOf('async function hostClients'), worker.indexOf('async function hostProducts'));
  assert.match(book, /member_token/, 'a host-added client is created with no way out');
  const intro = worker.slice(worker.indexOf('async function hostIntro('), worker.indexOf('async function hostIntros'));
  assert.match(intro, /member_token|token\(20\)/, 'an introduced client is created with no way out');
});

test('the member page is not behind a NUM login', () => {
  // A member introduced to a host may have no account at all. An exit that
  // requires one is an exit most people never reach, which would make the
  // consent given at the introduction worth less than it looked.
  const link = worker.slice(worker.indexOf('async function memberLink'), worker.indexOf('async function hostClose'));
  assert.ok(link.length > 500, 'memberLink is missing');
  assert.ok(!/hostAuth|console_key|member_id_required/.test(link), 'the member page requires a host key or an account');
  assert.match(link, /sameSecret\(row\.member_token, t\)/, 'the member token is not compared in constant time');
  assert.match(worker, /p === "\/api\/host\/link"/, '/api/host/link is not routed');
});

test('the member page tells them what leaving costs before they do it', () => {
  const link = worker.slice(worker.indexOf('async function memberLink'), worker.indexOf('async function hostClose'));
  assert.match(link, /what_they_see/, 'the member is not told what their host can see');
  assert.match(link, /booking fee moves from them to you/i, 'the member is not told the fee moves to them');
  assert.match(memberPage, /id="sees"/, 'the page does not render what the host can see');
  assert.match(memberPage, /You do not have to give a reason/i, 'the page asks the member to justify leaving');
});

test('the member page never hands out the host’s contact details', () => {
  // This page exists so a member can leave, not so it can be used to reach
  // around us to the host.
  const link = worker.slice(worker.indexOf('async function memberLink'), worker.indexOf('async function hostClose'));
  const payload = link.slice(link.indexOf('const read = ()'), link.indexOf('if (req.method === "GET")'));
  assert.ok(!/host_email|notify_phone/.test(payload), 'the member page returns the host’s email or phone');
});

/* ── 2. NOTHING ENDS QUIETLY ─────────────────────────────────────────── */

test('there is exactly one writer for an ending', () => {
  // Three entry points — host removes, member leaves, host closes — and one
  // function. Two writers is how one of them forgets to send the email.
  assert.match(worker, /async function endClient/, 'the shared ending path is gone');
  const calls = worker.match(/await endClient\(/g) || [];
  assert.ok(calls.length >= 3, `only ${calls.length} paths use endClient — one of them is ending things its own way`);
  // And no path sets 'removed' behind its back.
  const strays = (worker.match(/status = 'removed'/g) || []).length;
  assert.ok(strays <= 2, `status is set to 'removed' in ${strays} places — an ending is bypassing endClient`);
});

test('removing is not pausing, and does not share its code path', () => {
  const book = worker.slice(worker.indexOf('async function hostClients'), worker.indexOf('async function hostProducts'));
  assert.match(book, /if \(action === "remove"\)/, 'remove no longer has its own branch');
  // Pause must not be able to reach 'removed', and resume must not be able to
  // undo one — coming back is a new consent, and it is the member's to give.
  const pause = book.slice(book.indexOf('if (action === "pause" || action === "resume")'));
  assert.ok(!/removed'/.test(pause.slice(0, pause.indexOf('return list();'))) ||
            /status <> 'removed'/.test(pause), 'resume can silently undo a removal');
  assert.match(pause, /status <> 'removed'/, 'a removed client can be resumed without their say-so');
});

test('the member’s own decision does not bar them from choosing again', () => {
  // Asymmetric on purpose: the host said no once, so we never ask them again;
  // the member said no once, which is not a permanent bar on their options.
  assert.match(worker, /OFFER_ON_END = \{ host: "keep", member: "release"/,
    'the offer rule changed — this asymmetry is about consent, read the comment first');
  assert.match(worker, /DELETE FROM num_host_offers WHERE client_id = \? AND host_id = \?/,
    'a member who leaves can never be introduced to that host again');
});

test('the separation record says who ended it', () => {
  // 'removed' alone cannot tell a host removing a client from a client walking
  // away, and those are different facts with different consequences.
  assert.match(m15, /ended_by TEXT\s*\n?\s*CHECK \(ended_by IS NULL OR ended_by IN \('host','member','host_closed','num'\)\)/,
    'ended_by is missing or its vocabulary changed');
  assert.match(m15, /CREATE TABLE IF NOT EXISTS num_host_separations/, 'there is no append-only record of endings');
  assert.match(worker, /INSERT INTO num_host_separations/, 'endings are not recorded');
});

test('the other side is the one who gets told', () => {
  const end = worker.slice(worker.indexOf('async function endClient'), worker.indexOf('/* ------------------------------------------------- /api/host/link'));
  assert.match(end, /endedBy === "member" && host\.email/, 'a host is not told when their client leaves');
  assert.match(end, /endedBy !== "member" && row\.email/, 'a member is not told when their host ends it');
  // And the member's notice has to carry the thing that changes for them.
  assert.match(end, /billed to them\.\s*\n?From now on it is billed to you/, 'the member is not told the fee moves to them');
  assert.match(end, /notified_at = \?/, 'nothing records that the notice was actually sent');
});

/* ── 3. THE HOST LEAVING ─────────────────────────────────────────────── */

test('closing an account cannot happen on one tap', () => {
  const close = worker.slice(worker.indexOf('async function hostClose'));
  assert.match(close, /confirm_required/, 'closing has no confirmation step');
  assert.match(close, /String\(b\.confirm \|\| ""\)\.trim\(\)\.toLowerCase\(\) !== String\(host\.name/,
    'the confirmation is not the host typing their own name back');
  assert.match(consolePage, /Not a checkbox/i, 'the console does not explain why it is not a checkbox');
});

test('closing leaves nothing pointing at a host who is gone', () => {
  const close = worker.slice(worker.indexOf('async function hostClose'));
  assert.match(close, /await endClient/, 'clients are not released through the shared ending path');
  assert.match(close, /DELETE FROM num_host_areas/, 'a closed host is still ranked for introductions');
  assert.match(close, /UPDATE num_host_links SET status = 'ended'/, 'work can still be handed to a closed host');
  assert.match(close, /UPDATE num_host_offers SET host_said = 'no'/, 'members are left waiting on a host who left');
  assert.match(close, /accepts_intros = 0, in_network = 0/, 'a closed host stays visible');
  assert.match(close, /plan_status = 'cancelled'/, 'a closed host keeps being billed');
});

/* ── 4. THE CHECKER, TESTED AGAINST REAL STATES ──────────────────────── */

const HOST = { id: 'h1', status: 'active', tier: 'pro', accepts_intros: 0, in_network: 0 };

test('a healthy system reports nothing', () => {
  const r = integrityReport({
    hosts: [HOST],
    clients: [{ id: 'c1', host_id: 'h1', status: 'active', member_token: 'tok', member_id: 'm1' }],
    separations: [], offers: [], links: [], areas: [], requests: [],
  });
  assert.deepEqual(r.findings, [], 'a clean system reported problems: ' + codes(r.findings).join(', '));
  assert.equal(r.ok, true);
  assert.match(r.verdict, /Everything agrees/);
});

test('it catches an ending nobody recorded or was told about', () => {
  const f = checkHostData({
    hosts: [HOST],
    clients: [{ id: 'c1', host_id: 'h1', status: 'removed', ended_at: 'x', email: 'a@b.co', member_token: 't' }],
    separations: [],
  });
  assert.ok(codes(f).includes('ended_without_record'), 'an unrecorded ending passed');
  assert.ok(codes(f).includes('ended_without_notice'), 'an ending nobody was told about passed');
  assert.ok(f.every((x) => x.ids.includes('c1')), 'findings do not name the row');
});

test('it catches the same person being held by two hosts', () => {
  // Both hosts would be billed the £5 and servicefee.mjs would answer with
  // whichever row it read first.
  const f = checkHostData({
    hosts: [HOST, { ...HOST, id: 'h2' }],
    clients: [
      { id: 'c1', host_id: 'h1', status: 'active', member_id: 'm1', member_token: 't1' },
      { id: 'c2', host_id: 'h2', status: 'active', member_id: 'm1', member_token: 't2' },
    ],
  });
  const hit = f.find((x) => x.code === 'member_has_two_hosts');
  assert.ok(hit, 'a member with two active hosts passed');
  assert.equal(hit.severity, 'breach');
});

test('it catches a client with no way to leave', () => {
  const f = checkHostData({
    hosts: [HOST],
    clients: [{ id: 'c1', host_id: 'h1', status: 'active', member_token: null }],
  });
  const hit = f.find((x) => x.code === 'client_cannot_leave');
  assert.ok(hit, 'a client who cannot remove themselves passed');
  assert.equal(hit.severity, 'breach', 'a one-directional consent is not a breach');
});

test('it catches work confirmed with no fee attached', () => {
  const f = checkHostData({
    hosts: [HOST],
    requests: [{ id: 'r1', host_id: 'h1', status: 'confirmed', booking_fee_minor: 0 }],
  });
  assert.ok(codes(f).includes('confirmed_without_fee'), 'under-charging passed silently');
});

test('it catches everything left pointing at a closed host', () => {
  const closed = { ...HOST, id: 'h1', status: 'ended' };
  const f = checkHostData({
    hosts: [closed, { ...HOST, id: 'h2' }],
    clients: [{ id: 'c1', host_id: 'h1', status: 'active', member_token: 't' }],
    areas: [{ id: 'a1', host_id: 'h1', city: 'Edinburgh' }],
    links: [{ id: 'l1', host_a: 'h1', host_b: 'h2', status: 'accepted' }],
  });
  for (const c of ['client_of_closed_host', 'area_of_closed_host', 'network_link_to_closed_host']) {
    assert.ok(codes(f).includes(c), `${c} was not caught`);
  }
});

test('it catches work handed to a host who never agreed to it', () => {
  const f = checkHostData({
    hosts: [HOST, { ...HOST, id: 'h2' }],
    links: [{ id: 'l1', host_a: 'h1', host_b: 'h2', status: 'pending' }],
    requests: [{ id: 'r1', host_id: 'h1', network_host_id: 'h2', status: 'confirmed', booking_fee_minor: 500 }],
  });
  assert.ok(codes(f).includes('handoff_without_link'), 'a handoff to an unconnected host passed');
});

test('it catches a switch that cannot do what it says', () => {
  const f = checkHostData({
    hosts: [{ ...HOST, tier: 'free', accepts_intros: 1, in_network: 1, sms_opt_in: 1, notify_phone: null }],
    areas: [],
  });
  for (const c of ['intros_on_below_pro', 'network_on_below_pro', 'sms_on_without_number']) {
    assert.ok(codes(f).includes(c), `${c} was not caught`);
  }
  // Silent invisibility: switched on, on the right plan, with no city saved.
  const g = checkHostData({ hosts: [{ ...HOST, accepts_intros: 1 }], areas: [] });
  assert.ok(codes(g).includes('intros_on_without_coverage'), 'a host nobody can ever match passed');
});

test('the report leads with consequence, not with count', () => {
  const r = integrityReport({
    hosts: [{ ...HOST, tier: 'free', in_network: 1 }],
    clients: [{ id: 'c1', host_id: 'h1', status: 'active', member_token: null }],
  });
  assert.equal(r.findings[0].severity, 'breach', 'a drift finding sorted above a breach');
  assert.equal(r.clean, false);
  assert.match(r.verdict, /fix today/);
});

test('the checker runs on partial data without inventing findings', () => {
  // A caller checking one slice must not be told everything else is broken.
  assert.deepEqual(checkHostData({}), []);
  assert.deepEqual(checkHostData({ hosts: [HOST] }), []);
});

test('the integrity endpoint is admin-only and read-only', () => {
  const ep = worker.slice(worker.indexOf('async function hostIntegrity'), worker.indexOf('/* ------------------------------------------------- /api/host/link'));
  assert.match(ep, /env\.ADMIN_KEY, key/, 'the integrity report is not behind ADMIN_KEY');
  assert.ok(!/UPDATE |DELETE |INSERT /.test(ep), 'the integrity check writes to the database');
  assert.match(worker, /p === "\/api\/host\/integrity" && req\.method === "GET"/, 'the endpoint is not routed GET-only');
});

/* ── 5. THE CONSOLE ──────────────────────────────────────────────────── */

test('the console distinguishes removing from pausing, in words', () => {
  assert.match(consolePage, /id="rmCard"/, 'there is no remove confirmation card');
  assert.match(consolePage, /This is not the same as pausing/i, 'the console does not distinguish remove from pause');
  assert.match(consolePage, /pause them instead/i, 'the console does not offer the reversible option');
  assert.match(consolePage, /is told by NUM that you have removed/i, 'the host is not told that the client is told');
});

test('the console hands the host their client’s own way out', () => {
  assert.match(consolePage, /Their link:/, 'the host cannot see or pass on the client’s own link');
  assert.match(worker, /member_link: r\.member_token \? site \+ "\/my-host\/\?t=" \+ r\.member_token : null/,
    'the client list no longer carries the member link');
});

test('the member token never sits in the address bar', () => {
  assert.match(memberPage, /history\.replaceState\(null, '', '\/my-host\/'\)/,
    'the member token stays in the URL — history, screenshots and Referer');
  assert.match(memberPage, /noindex/, 'the member page is indexable');
});

/* ── 6. IS IT ACTUALLY CONNECTED? ────────────────────────────────────────
 * Six tables, written by a dozen endpoints across four days. The cheapest way
 * for this to break is a column renamed in a migration and still named in a
 * query — which does not fail at deploy, does not fail at lint, and does not
 * fail until a host clicks the one button that runs it.
 *
 * So: build the schema the migrations actually produce, then PREPARE every
 * SQL statement the worker holds against it. Preparing validates every table
 * and every column without executing anything, so no fixture data is needed
 * and no constraint can mask a real error. */
test('every host SQL statement the worker holds is valid against the migrations', async () => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return; }

  const db = new DatabaseSync(':memory:');
  // The pre-0013 shape of num_hosts, which lives in production and has no
  // CREATE TABLE anywhere in this repo. If that ever changes, this is the
  // line to reconcile rather than the migrations.
  db.exec(`CREATE TABLE num_hosts (id TEXT PRIMARY KEY, name TEXT, company TEXT, email TEXT,
    phone TEXT, country TEXT, code TEXT, host_bps INTEGER, term_months INTEGER, status TEXT,
    terms_version TEXT, agreed_at TEXT, agreed_ip TEXT, console_key TEXT, created_at TEXT, updated_at TEXT)`);

  for (const f of ['worker/migrations/0013_host_profile.sql',
                   'worker/migrations/0014_host_clients.sql',
                   'worker/migrations/0015_host_separation.sql']) {
    const sql = read(f);
    for (const line of sql.split('\n')) {
      const c = line.indexOf('--');
      assert.ok(!(c !== -1 && line.slice(c).includes(';')),
        `${f}: a semicolon inside a comment splits a statement in half in a naive runner`);
    }
    const stmts = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
      .split(';').map((s) => s.trim()).filter(Boolean);
    for (const s of stmts) db.exec(s);
  }

  const HOST_TABLES = ['num_host_clients', 'num_host_requests', 'num_host_products',
    'num_host_areas', 'num_host_offers', 'num_host_links', 'num_host_separations', 'num_hosts'];
  // Tables that are live in production but have no CREATE TABLE in this repo,
  // so their queries cannot be checked here. That gap is itself worth knowing.
  const LEGACY = ['num_host_uploads', 'num_host_contacts', 'num_host_earnings',
    'num_web_events', 'num_referral_codes', 'num_suppressions', 'num_members'];

  const found = [];
  for (const m of worker.matchAll(/`([^`]*?)`/gs)) {
    if (/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(m[1])) found.push(m[1].trim());
  }
  for (const m of worker.matchAll(/"((?:SELECT|INSERT|UPDATE|DELETE)[^"]*)"/gs)) found.push(m[1].trim());

  let checked = 0;
  const broken = [];
  for (const q of found) {
    if (!HOST_TABLES.some((t) => q.includes(t))) continue;
    if (LEGACY.some((t) => q.includes(t))) continue;
    try { db.prepare(q); checked++; }
    catch (e) { broken.push(`${e.message} :: ${q.replace(/\s+/g, ' ').slice(0, 120)}`); }
  }

  assert.deepEqual(broken, [], 'host SQL no longer matches the schema:\n' + broken.join('\n'));
  // A guard against this test quietly checking nothing after a refactor moves
  // the queries somewhere it does not look.
  assert.ok(checked >= 50, `only ${checked} host statements were checked — this test has stopped finding them`);
});
