/**
 * End-to-end test of the venue system: the REAL handlers, run against a REAL
 * SQLite database (node:sqlite) shaped like num-db. Only the environment is
 * substituted — network, email transport, and Cloudflare request metadata.
 *
 * The flow under test is the whole life of a venue:
 *   claim verified → key minted & emailed → floor created from template →
 *   codes extended → guest scans & booking completes → visitor book fills →
 *   code retired → key rotated → attacks show up in the security sweep.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};

/* ── a D1-shaped adapter over node:sqlite ─────────────────────────────────── */
const raw = new DatabaseSync(':memory:');
class Stmt {
  constructor(sql) { this.sql = sql; this.args = []; }
  bind(...a) { this.args = a.map(v => v === undefined ? null : v); return this; }
  async first() { return raw.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: raw.prepare(this.sql).all(...this.args) }; }
  async run() { raw.prepare(this.sql).run(...this.args); return { success: true }; }
}
const DB = {
  prepare: (sql) => new Stmt(sql),
  batch: async (stmts) => { for (const s of stmts) await s.run(); },
};

raw.exec(`
CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, kind TEXT, category TEXT,
  territory TEXT, status TEXT DEFAULT 'active', console_key TEXT, created_at TEXT);
CREATE TABLE num_claims (id TEXT PRIMARY KEY, place_id TEXT, business_id TEXT,
  claimant_email TEXT, channel TEXT, state TEXT, decided_at TEXT);
CREATE TABLE num_venue_codes (token TEXT PRIMARY KEY, business_id TEXT, label TEXT,
  perk_text TEXT, zone_type TEXT, state TEXT DEFAULT 'active', issued_for TEXT,
  created_at TEXT, revoked_at TEXT, revoked_by TEXT);
CREATE TABLE num_venue_scans (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT,
  business_id TEXT, booking_id TEXT, outcome TEXT, member_ref TEXT, country TEXT,
  device TEXT, ip_hash TEXT, detail TEXT, created_at TEXT);
CREATE TABLE num_key_events (id INTEGER PRIMARY KEY AUTOINCREMENT, business_id TEXT,
  outcome TEXT, ip_hash TEXT, country TEXT, detail TEXT, created_at TEXT);
CREATE TABLE num_security_findings (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT,
  kind TEXT, subject TEXT, severity TEXT, evidence TEXT, notified INTEGER DEFAULT 0,
  created_at TEXT, UNIQUE(day, kind, subject));
CREATE TABLE num_bookings (id TEXT PRIMARY KEY, short_code TEXT, business_id TEXT,
  member_ref TEXT, party_size INTEGER, starts_at INTEGER, ends_at INTEGER,
  status TEXT, value_cs INTEGER DEFAULT 0, commission_cs INTEGER DEFAULT 0,
  completed_at INTEGER, created_at INTEGER);
CREATE TABLE num_web_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id TEXT, event TEXT, page TEXT, ref_code TEXT, invite_token TEXT, utm_source TEXT,
  utm_medium TEXT, utm_campaign TEXT, referrer TEXT, country TEXT, device TEXT, detail TEXT, created_at TEXT);
CREATE TABLE num_offers (id TEXT PRIMARY KEY, business_id TEXT, title TEXT, details TEXT,
  kind TEXT DEFAULT 'perk', starts_at TEXT, ends_at TEXT, capacity_hint TEXT,
  state TEXT DEFAULT 'live', created_at TEXT, ended_at TEXT);
CREATE TABLE num_booking_events (id TEXT PRIMARY KEY, booking_id TEXT, from_status TEXT,
  to_status TEXT, actor TEXT, reason TEXT, metadata TEXT, created_at INTEGER);
`);

/* ── worker-environment substitutes ──────────────────────────────────────── */
const EMAILS = [];
const helpers = `
const J = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj),
  { status, headers: { "content-type": "application/json", ...extra } });
const TEXT = (s, status = 200) => new Response(s, { status });
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
function clean(s, max = 200) {
  return String(s == null ? "" : s).replace(/[\\u0000-\\u001f]/g, "").trim().slice(0, max);
}
function token(bytes = 16) {
  const b = new Uint8Array(bytes); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}
function sameSecret(a, b) {
  const x = String(a || ""), y = String(b || "");
  if (x.length !== y.length) return false;
  let d = 0; for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}
function badOrigin() { return false; }
function overLimit() { return false; }
function country(req) { return (req && req.headers.get("cf-test-country")) || "TH"; }
function device() { return "mobile"; }
async function readJSON(req, limit = 65536) {
  const raw = await req.text(); if (raw.length > limit) throw new Error("too big");
  return JSON.parse(raw || "{}");
}
async function visitorId() { return 'v-test'; }
async function sendBatch(env, messages) {
  globalThis.__EMAILS.push(...messages); return { ok: true, sent: messages.length, ids: [] };
}
`;
globalThis.__EMAILS = EMAILS;

const src = helpers +
  fs.readFileSync('qr_inline.js', 'utf8') +
  fs.readFileSync('venue_page.js', 'utf8') +
  fs.readFileSync('venue_scan.js', 'utf8') +
  fs.readFileSync('venue_admin.js', 'utf8') +
  fs.readFileSync('venue_backend2.js', 'utf8') +
  fs.readFileSync('venue_ui2.js', 'utf8') +
  fs.readFileSync('venue_offers.js', 'utf8') + `
export { venueIssueKey, venueKeyRotate, venueCodesBulk, venueCodesCreate,
         venueCodesState, venueCodesList, venueVisitors, venueQr, venueLanding,
         venueArrive, venueCodesPageV2, venueVisitorsPage, securitySweep,
         venueOffersCreate, venueOffersEnd, offersLive, tonightPage, venueOffersPage };
`;
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

const env = { DB, ADMIN_KEY: 'test-admin-key', SITE: 'https://itsnum.com' };
const ctx = { waitUntil: (p) => p };
const post = (path, body, headers = {}) => new Request('https://itsnum.com' + path,
  { method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': headers.ip || '1.2.3.4', ...headers } });
const get = (path, headers = {}) => new Request('https://itsnum.com' + path,
  { headers: { 'cf-connecting-ip': headers.ip || '1.2.3.4', ...headers } });
const U = (path) => new URL('https://itsnum.com' + path);
const jj = async (r) => ({ status: r.status, body: JSON.parse(await r.text()) });

/* ══ 1 · prove control → mint key → email manager URL ══ */
console.log('\n1 · claim → key → email');
raw.prepare(`INSERT INTO businesses (id,name,kind,category,territory) VALUES
  ('biz1','The Longtail Bar','merchant','Bar','Phuket'),
  ('biz2','No Claim Cafe','merchant','Cafe','Phuket')`).run();
raw.prepare(`INSERT INTO num_claims (id,place_id,business_id,claimant_email,channel,state,decided_at)
  VALUES ('cl1','pl1','biz1','owner@longtailbar.com','email_domain','verified','2026-08-11')`).run();

let r = await jj(await M.venueIssueKey(post('/api/admin/venue/issue', { business_id: 'biz1' },
  { 'x-admin-key': 'test-admin-key' }), env, ctx));
t('issue succeeds for verified claim', r.status === 200 && r.body.ok && r.body.minted, r.body);
t('recipient is the claim-verified address, masked', r.body.emailed_to === 'o***@longtailbar.com', r.body.emailed_to);
t('email captured with manager URL', EMAILS.length === 1 && /\/biz\/codes\?k=/.test(EMAILS[0].text));
const KEY = raw.prepare("SELECT console_key FROM businesses WHERE id='biz1'").get().console_key;
t('key stored and >= 30 chars', KEY && KEY.length >= 30, KEY);

r = await jj(await M.venueIssueKey(post('/api/admin/venue/issue', { business_id: 'biz2' },
  { 'x-admin-key': 'test-admin-key' }), env, ctx));
t('refused where control was never proven', r.status === 409 && r.body.error === 'no_verified_contact', r.body);
r = await jj(await M.venueIssueKey(post('/api/admin/venue/issue', { business_id: 'biz1' },
  { 'x-admin-key': 'wrong' }), env, ctx));
t('wrong admin key → 401', r.status === 401);

/* ══ 2 · floor from template ══ */
console.log('\n2 · floor template (bar)');
r = await jj(await M.venueCodesBulk(post('/api/venue/codes/bulk', { template: 'bar' }), env,
  U('/api/venue/codes/bulk?k=' + KEY)));
t('template creates the bar floor', r.body.ok && r.body.created === 23, r.body);
const seats = raw.prepare(`SELECT label FROM num_venue_codes
  WHERE business_id='biz1' AND zone_type='bar_seat' ORDER BY label`).all();
t('12 bar seats, one per chair', seats.length === 12);
t('named the way staff talk', seats.some(s => s.label === 'Bar seat 3'));
t('single-instance zone gets a bare name',
  !!raw.prepare("SELECT 1 FROM num_venue_codes WHERE business_id='biz1' AND label='Door'").get());

r = await jj(await M.venueCodesBulk(post('/api/venue/codes/bulk', { template: 'bar' }), env,
  U('/api/venue/codes/bulk?k=' + KEY)));
t('re-applying the template is a no-op, not doubles', r.body.created === 0 && r.body.skipped.length === 23, r.body);

/* ══ 3 · extend a zone — numbering continues ══ */
console.log('\n3 · add 4 more bar seats');
r = await jj(await M.venueCodesBulk(post('/api/venue/codes/bulk', { zone_type: 'bar_seat', count: 4 }),
  env, U('/api/venue/codes/bulk?k=' + KEY)));
t('4 created', r.body.created === 4, r.body);
t('numbering continues at 13', r.body.codes.map(c => c.label).join(',') ===
  'Bar seat 13,Bar seat 14,Bar seat 15,Bar seat 16', r.body.codes.map(c => c.label));

/* ══ 4 · a guest arrives — scan completes the booking ══ */
console.log('\n4 · scan → booking completes');
const seatTok = raw.prepare(`SELECT token FROM num_venue_codes
  WHERE business_id='biz1' AND label='Bar seat 3'`).get().token;
const NOW = Math.floor(Date.now() / 1000);
raw.prepare(`INSERT INTO num_bookings (id,short_code,business_id,member_ref,party_size,
  starts_at,ends_at,status,value_cs,created_at) VALUES
  ('bk1','T882','biz1','member-abc-1234',2,${NOW - 600},${NOW + 3600},'confirmed',250000,${NOW - 7200})`).run();

r = await jj(await M.venueArrive(post('/api/venue/arrive', { token: seatTok, code: 'T882' }), env));
t('scan completes the booking', r.body.ok && r.body.completed === true, r.body);
const bk = raw.prepare("SELECT status, commission_cs FROM num_bookings WHERE id='bk1'").get();
t('status = completed', bk.status === 'completed');
t('commission = 10% of value, floored', bk.commission_cs === 25000, bk.commission_cs);
r = await jj(await M.venueArrive(post('/api/venue/arrive', { token: seatTok, code: 'T882' }), env));
t('second scan is idempotent — never bills twice', r.body.already === true, r.body);
r = await jj(await M.venueArrive(post('/api/venue/arrive', { token: seatTok, code: 'ZZZZ' }), env));
t('walk-in: no booking, no bill, invited in', r.body.ok && r.body.matched === false, r.body);

/* ══ 5 · the visitor book ══ */
console.log('\n5 · visitors');
r = await jj(await M.venueVisitors(get('/api/venue/visitors?k=' + KEY), env,
  U('/api/venue/visitors?k=' + KEY)));
t('guest appears, pseudonymous', r.body.visitors.length === 1 && r.body.visitors[0].guest === 'guest-1234', r.body.visitors);
t('usual spot is the seat they scanned', r.body.visitors[0].usual_spot === 'Bar seat 3');
t('dashboard preset matches the category (bar)',
  JSON.stringify(r.body.dash_preset) === JSON.stringify(['check_ins_today','seats_active','tabs_open_hint','repeat_guests','busiest_hour']), r.body.dash_preset);

/* ══ 6 · retire → guest sees the calm answer ══ */
console.log('\n6 · retire and reinstate');
r = await jj(await M.venueCodesState(post('/api/venue/codes/state', { token: seatTok, state: 'revoked' }),
  env, U('/api/venue/codes/state?k=' + KEY)));
t('retired', r.body.ok && r.body.state === 'revoked');
let page = await M.venueLanding(get('/v/' + seatTok), env, seatTok);
t('retired card answers 410 with the retirement page', page.status === 410 &&
  /has been retired/.test(await page.text()));
r = await jj(await M.venueCodesState(post('/api/venue/codes/state', { token: seatTok, state: 'active' }),
  env, U('/api/venue/codes/state?k=' + KEY)));
t('reinstated', r.body.ok && r.body.state === 'active');

/* ══ 7 · QR endpoint ══ */
console.log('\n7 · QR artwork');
let qr = await M.venueQr(get('/api/venue/qr/' + seatTok + '.svg'), env, seatTok + '.svg');
t('existing token → SVG', qr.status === 200 && /^<svg/.test(await qr.text()));
qr = await M.venueQr(get('/api/venue/qr/NOPE99.svg'), env, 'NOPE99.svg');
t('nonexistent token → 404, never a QR to nowhere', qr.status === 404);

/* ══ 8 · pages ══ */
console.log('\n8 · manager pages');
page = await M.venueCodesPageV2(get('/biz/codes?k=' + KEY), env, U('/biz/codes?k=' + KEY));
const html = await page.text();
t('codes page renders with zone sections', page.status === 200 && /Bar seats/.test(html) && /Booths/.test(html));
t('rotate control present', /New private link/.test(html));
page = await M.venueVisitorsPage(get('/biz/visitors?k=' + KEY), env, U('/biz/visitors?k=' + KEY));
t('visitors page renders with tiles', page.status === 200 && /guest-1234/.test(await page.text()));
page = await M.venueCodesPageV2(get('/biz/codes?k=wrong-key-wrong-key-wrong'), env,
  U('/biz/codes?k=wrong-key-wrong-key-wrong'));
t('bad key → 401', page.status === 401);

/* ══ 9 · rotate — old key dies, new key works ══ */
console.log('\n9 · key rotation');
r = await jj(await M.venueKeyRotate(get('/api/venue/key/rotate?k=' + KEY), env));
t('rotation returns the new link once', r.body.ok && /\/biz\/codes\?k=/.test(r.body.manager_url), r.body);
const KEY2 = r.body.manager_url.split('k=')[1];
r = await jj(await M.venueCodesList(get('/api/venue/codes?k=' + KEY), env, U('/api/venue/codes?k=' + KEY)));
t('old key is dead', r.status === 401);
r = await jj(await M.venueCodesList(get('/api/venue/codes?k=' + KEY2), env, U('/api/venue/codes?k=' + KEY2)));
t('new key works', r.status === 200 && r.body.ok);

/* ══ 10 · the security sweep sees the attacks ══ */
console.log('\n10 · security sweep');
// a leaked key: one business's key used from 8 networks
for (let i = 0; i < 8; i++) raw.prepare(`INSERT INTO num_key_events
  (business_id,outcome,ip_hash,country,created_at) VALUES ('biz1','ok','net${i}','TH',datetime('now'))`).run();
// key guessing: 25 denials from one network
for (let i = 0; i < 25; i++) raw.prepare(`INSERT INTO num_key_events
  (business_id,outcome,ip_hash,country,created_at) VALUES (NULL,'denied','evil1','RU',datetime('now'))`).run();
// token enumeration: 35 unknown-token scans from one network
for (let i = 0; i < 35; i++) raw.prepare(`INSERT INTO num_venue_scans
  (token,business_id,outcome,ip_hash,created_at) VALUES ('FAKE${i}','','unknown_token','evil2',datetime('now'))`).run();
// booking-code brute force: one network tries 9 codes at one venue
for (let i = 0; i < 9; i++) raw.prepare(`INSERT INTO num_venue_scans
  (token,business_id,outcome,ip_hash,detail,created_at)
  VALUES ('${seatTok}','biz1','no_booking','evil3','GUES${i}',datetime('now'))`).run();

EMAILS.length = 0;
let sweep = await M.securitySweep(env);
t('all four attack shapes found', sweep.found >= 4 && sweep.new >= 4, sweep);
const kinds = raw.prepare("SELECT DISTINCT kind FROM num_security_findings").all().map(x => x.kind).sort();
t('kinds: ' + kinds.join(', '),
  ['code_bruteforce','key_bruteforce','key_shared','token_scanning'].every(k => kinds.includes(k)));
t('one alert email sent', EMAILS.length === 1 && /security/.test(EMAILS[0].subject));
sweep = await M.securitySweep(env);
t('second sweep is quiet — findings dedupe per day', sweep.new === 0 && EMAILS.length === 1, sweep);

/* ══ 11 · isolation — one venue can never touch another ══ */
console.log('\n11 · tenant isolation');
raw.prepare(`UPDATE businesses SET console_key='attacker-key-attacker-key-xx' WHERE id='biz2'`).run();
raw.prepare(`INSERT INTO num_claims (id,place_id,business_id,claimant_email,channel,state,decided_at)
  VALUES ('cl2','pl2','biz2','x@nocafe.com','email_domain','verified','2026-08-11')`).run();
r = await jj(await M.venueCodesState(post('/api/venue/codes/state', { token: seatTok, state: 'revoked' }),
  env, U('/api/venue/codes/state?k=attacker-key-attacker-key-xx')));
t("another venue's valid key cannot touch biz1's codes", r.status === 404, r.body);
t("biz1's code untouched", raw.prepare(
  `SELECT state FROM num_venue_codes WHERE token='${seatTok}'`).get().state === 'active');

/* ══ 12 · offers — the demand lever ══ */
console.log('\n12 · offers');
r = await jj(await M.venueOffersCreate(post('/api/venue/offers',
  { title: 'First drink on us tonight', kind: 'quiet_night', hours: 6 }),
  env, U('/api/venue/offers?k=' + KEY2)));
t('offer posted', r.body.ok && r.body.id, r.body);
const OF1 = r.body.id;
r = await jj(await M.venueOffersCreate(post('/api/venue/offers', { title: 'short' }),
  env, U('/api/venue/offers?k=' + KEY2)));
t('vague offer refused — say what the guest gets', r.body.error === 'title_too_short', r.body);

r = await jj(await M.offersLive(get('/api/venue/offers/live'), env));
t('offer live in the public feed with business + territory',
  r.body.count === 1 && r.body.offers[0].business === 'The Longtail Bar'
  && r.body.offers[0].territory === 'Phuket', r.body.offers);

let tonight = await M.tonightPage(get('/tonight/'), env, U('/tonight/'));
let th = await tonight.text();
t('/tonight/ shows the offer verbatim', tonight.status === 200 && /First drink on us tonight/.test(th));
t('/tonight/ view logged server-side into num_web_events',
  raw.prepare("SELECT COUNT(*) n FROM num_web_events WHERE event='tonight_view'").get().n === 1);
t('no volume promise anywhere on /tonight/', !/guarantee|thousands of/i.test(th));

for (let i = 0; i < 2; i++)
  await M.venueOffersCreate(post('/api/venue/offers', { title: 'Another offer number ' + i, hours: 3 }),
    env, U('/api/venue/offers?k=' + KEY2));
r = await jj(await M.venueOffersCreate(post('/api/venue/offers', { title: 'A fourth offer here' }),
  env, U('/api/venue/offers?k=' + KEY2)));
t('cap at 3 live — spam cannot drown the page', r.body.error === 'too_many_live', r.body);

r = await jj(await M.venueOffersEnd(post('/api/venue/offers/end', { id: OF1 }),
  env, U('/api/venue/offers/end?k=' + KEY2)));
t('offer ended early', r.body.ok && r.body.state === 'ended');
r = await jj(await M.offersLive(get('/api/venue/offers/live'), env));
t('ended offer gone from the feed', !r.body.offers.some(o => o.id === OF1));

raw.prepare("UPDATE num_offers SET ends_at = datetime('now','-1 hour') WHERE state='live'").run();
r = await jj(await M.offersLive(get('/api/venue/offers/live'), env));
t('expired offers vanish by clock, no cleanup job needed', r.body.count === 0, r.body.count);

tonight = await M.tonightPage(get('/tonight/'), env, U('/tonight/'));
t('empty /tonight/ is honest, not dressed up', /Nothing posted right now/.test(await tonight.text()));

let opage = await M.venueOffersPage(get('/biz/offers?k=' + KEY2), env, U('/biz/offers?k=' + KEY2));
t('business offers page renders with presets', opage.status === 200 &&
  /Happy hour/.test(await opage.text()));

console.log(`\n════ ${pass} passed, ${fail} failed ════`);
process.exit(fail ? 1 : 0);
