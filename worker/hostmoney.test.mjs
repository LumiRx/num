// Host money under the 3 Sep model: the host pays a plan and £5 a booking;
// the hosted member pays nothing; num_host_earnings stays dormant. These pin
// the grant/renew/lapse cycle, the fee sweep's dry-by-default rule, the
// member's "mine" view and the client's calendar feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  hostByKey, grantHostTier, recordHostRenewal, lapseHostBySub, feeSweep, mine, clientCalendar, handleHost, HOST_PLANS, HOST_CURRENCY,
} from './hostmoney.mjs';

function reorder(sql, args) {
  const idx = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  if (!idx.length) return args;
  return idx.map((i) => (args[i - 1] === undefined ? null : args[i - 1]));
}
function d1(db) {
  return {
    prepare(sql) {
      const st = { sql, args: [] };
      st.bind = (...a) => { st.args = a; return st; };
      const run = (fn) => fn(db.prepare(st.sql.replace(/\?(\d+)/g, '?')), reorder(st.sql, st.args));
      st.run = async () => ({ meta: { changes: run((s, a) => s.run(...a)).changes } });
      st.first = async () => run((s, a) => s.get(...a)) ?? null;
      st.all = async () => ({ results: run((s, a) => s.all(...a)) });
      return st;
    },
  };
}
const KEY = 'k_' + 'x'.repeat(30);
function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_hosts (id TEXT PRIMARY KEY, name TEXT, email TEXT, code TEXT, console_key TEXT, host_bps INTEGER, term_months INTEGER, status TEXT, tier TEXT DEFAULT 'free', plan_status TEXT DEFAULT 'none', plan_sub_id TEXT, plan_renews_at TEXT, currency TEXT DEFAULT 'GBP', services_json TEXT DEFAULT '[]', updated_at TEXT)`);
  // portal_trips and num_client_events arrived with 0038. It goes LAST,
  // where an ALTER TABLE puts it in production, because the inserts below bind
  // positionally — a column added in the middle here would pass the tests and
  // describe a table that does not exist.
  //
  // A harness whose
  // tables are thinner than production is a harness that passes on code the
  // live database rejects — which is the whole failure this file exists to
  // catch, so the columns go in rather than the query being softened.
  db.exec(`CREATE TABLE num_host_clients (id TEXT PRIMARY KEY, host_id TEXT, name TEXT, phone TEXT, member_id TEXT, member_token TEXT, status TEXT, created_at TEXT, updated_at TEXT, portal_trips INTEGER NOT NULL DEFAULT 1)`);
  db.exec(`CREATE TABLE num_client_events (id TEXT PRIMARY KEY, host_id TEXT, client_id TEXT, source TEXT, uid TEXT, title TEXT, detail TEXT, location TEXT, starts_at TEXT, ends_at TEXT, all_day INTEGER DEFAULT 0, tz TEXT, repeats INTEGER DEFAULT 0, request_id TEXT, import_id TEXT, created_at TEXT, updated_at TEXT)`);
  db.exec(`CREATE TABLE num_host_requests (id TEXT PRIMARY KEY, host_id TEXT, client_id TEXT, service_key TEXT, title TEXT, detail TEXT, city TEXT, starts_at TEXT, ends_at TEXT, party_size INTEGER, status TEXT, booking_fee_minor INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)`);
  db.exec(`CREATE TABLE num_members (id TEXT PRIMARY KEY, phone TEXT, phone_verified INTEGER DEFAULT 0)`);
  db.exec(`INSERT INTO num_hosts (id,name,email,code,console_key,host_bps,term_months,status,services_json) VALUES ('h_1','Priya','priya@example.com','PRIYA1','${KEY}',300,12,'active','["car","reservation"]')`);
  db.exec(`INSERT INTO num_hosts (id,name,email,code,console_key,host_bps,term_months,status) VALUES ('h_gone','Old','old@example.com','OLD1','k_${'y'.repeat(30)}',300,12,'ended')`);
  // Columns named, not positional: the next migration to add one should not
  // break this line, which is exactly what it did the first time.
  db.exec(`INSERT INTO num_host_clients
    (id,host_id,name,phone,member_id,member_token,status,created_at,updated_at)
    VALUES ('hc_1','h_1','Dre','+13105550100','mem_1','tok_${'c'.repeat(20)}','active','2026-09-01 10:00:00',NULL)`);
  db.exec(`INSERT INTO num_members VALUES ('mem_1','+13105550100',1)`);
  return { DB: d1(db), _db: db, SITE: 'https://itsnum.com', STRIPE_SECRET_KEY: 'sk_test_x' };
}
// Plans are priced in the visitor's currency since 17 Sep (worker/planprice.mjs),
// so a request without a country is no longer implicitly British — it is
// implicitly American, because DEFAULT_CURRENCY is USD. These helpers state
// the country instead of leaving it to a default, which is what the currency
// assertions below are actually about.
const get = (env, path, country = 'GB') => handleHost(new Request('https://app.itsnum.com' + path, { headers: { 'CF-IPCountry': country } }), env, new URL('https://app.itsnum.com' + path));
const post = (env, path, body, country = 'GB') => handleHost(new Request('https://app.itsnum.com' + path, { method: 'POST', body: JSON.stringify(body ?? {}), headers: { 'CF-IPCountry': country } }), env, new URL('https://app.itsnum.com' + path));

test('the old model is not in this file: no host share of a commission is ever filed', () => {
  const src = readFileSync(new URL('./hostmoney.mjs', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /INSERT[^;]*num_host_earnings/, 'the 3 Sep model: hosts pay; they do not earn a share of NUM\'s commission');
  assert.doesNotMatch(src, /host_share_minor/, 'no share arithmetic');
});

test('a console key identifies an active host, in constant time, and never an ended one', async () => {
  const env = fresh();
  assert.equal((await hostByKey(env, KEY))?.id, 'h_1');
  assert.equal(await hostByKey(env, 'k_' + 'y'.repeat(30)), null, 'ended host');
  assert.equal(await hostByKey(env, 'short'), null);
  assert.equal(await hostByKey(env, KEY.slice(0, -1) + 'z'), null);
});

test('grant → renew → lapse, keyed on the Stripe subscription, storing the customer for fee invoices', async () => {
  const env = fresh();
  assert.equal((await grantHostTier(env, 'h_1', 'pro', { ref: 'pay_1', sub: 'sub_1', customer: 'cus_1' })).ok, true);
  let h = env._db.prepare('SELECT * FROM num_hosts WHERE id=?').get('h_1');
  assert.equal(h.tier, 'pro'); assert.equal(h.plan_status, 'active'); assert.equal(h.plan_sub_id, 'sub_1'); assert.equal(h.stripe_customer, 'cus_1');
  assert.ok(h.plan_renews_at > '2026-09');
  const r = await recordHostRenewal(env, 'sub_1', Math.floor(Date.UTC(2026, 10, 4) / 1000));
  assert.equal(r.ok, true); assert.match(r.renews_at, /^2026-11-07/, 'period end plus three days of grace');
  assert.equal((await recordHostRenewal(env, 'sub_nope', 0)).ok, false, 'an unknown subscription matches nothing — pay.mjs then says so');
  assert.equal((await lapseHostBySub(env, 'sub_1')).ok, true);
  h = env._db.prepare('SELECT * FROM num_hosts WHERE id=?').get('h_1');
  assert.equal(h.tier, 'free'); assert.equal(h.plan_status, 'cancelled'); assert.equal(h.plan_sub_id, null);
  assert.equal((await grantHostTier(env, 'h_gone', 'pro', {})).ok, false, 'an ended host cannot hold a plan');
  assert.equal((await grantHostTier(env, 'h_1', 'platinum', {})).ok, false, 'not a plan');
});

test('the fee sweep is DRY unless HOST_FEE_INVOICING=on — it reports, it does not charge', async () => {
  const env = fresh();
  await grantHostTier(env, 'h_1', 'small', { sub: 'sub_1', customer: 'cus_1' });
  env._db.exec(`INSERT INTO num_host_requests (id,host_id,client_id,service_key,title,status,booking_fee_minor,created_at) VALUES ('hr1','h_1','hc_1','car','Car','confirmed',500,'2026-09-01'),('hr2','h_1','hc_1','car','Car','done',500,'2026-09-02'),('hr3','h_1','hc_1','car','Car','declined',0,'2026-09-03')`);
  const calls = [];
  const stripeCall = async (_e, path, body, idem) => { calls.push({ path, body, idem }); return { id: path === '/invoices' ? 'in_1' : 'ii_1' }; };
  let out = await feeSweep(env, { stripeCall });
  assert.deepEqual(out, { hosts: 1, invoiced: 0, pence: 1000, dry: true });
  assert.equal(calls.length, 0, 'nothing reached Stripe');
  assert.equal(env._db.prepare("SELECT COUNT(*) n FROM num_host_requests WHERE fee_invoiced_at IS NOT NULL").get().n, 0);

  env.HOST_FEE_INVOICING = 'on';
  out = await feeSweep(env, { stripeCall });
  assert.deepEqual(out, { hosts: 1, invoiced: 1, pence: 1000, dry: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, '/invoiceitems'); assert.equal(calls[0].body.amount, 1000); assert.equal(calls[0].body.currency, 'gbp'); assert.equal(calls[0].body.customer, 'cus_1');
  assert.equal(calls[1].path, '/invoices'); assert.match(calls[0].idem, /^hostfees:h_1:\d{4}-\d{2}:item$/, 'one invoice per host per month, by idempotency key');
  assert.equal(env._db.prepare("SELECT COUNT(*) n FROM num_host_requests WHERE fee_invoiced_at IS NOT NULL").get().n, 2, 'both confirmed fees stamped; the declined one untouched');
  // Second run: nothing left to invoice.
  assert.deepEqual(await feeSweep(env, { stripeCall }), { hosts: 0, invoiced: 0, pence: 0, dry: false });
  assert.equal(calls.length, 2);
});

test('a host whose plan was never paid has no Stripe customer and is not invoiced — a warning, not a charge to nobody', async () => {
  const env = fresh(); env.HOST_FEE_INVOICING = 'on';
  env._db.exec(`INSERT INTO num_host_requests (id,host_id,client_id,service_key,title,status,booking_fee_minor,created_at) VALUES ('hr1','h_1','hc_1','car','Car','confirmed',500,'2026-09-01')`);
  const calls = [];
  const out = await feeSweep(env, { stripeCall: async (...a) => { calls.push(a); return {}; } });
  assert.equal(out.invoiced, 0); assert.equal(calls.length, 0);
});

test('mine: the member sees their host, their page and the calendar feed; without a host, where to find one', async () => {
  const env = fresh();
  const m = await mine(env, 'mem_1', { site: 'https://itsnum.com' });
  assert.equal(m.host.name, 'Priya'); assert.deepEqual(m.host.services, ['car', 'reservation']);
  assert.match(m.page, /\/my-host\/\?t=tok_c+$/);
  assert.match(m.calendar, /\/api\/host\/client-calendar\.ics\?t=tok_c+$/);
  assert.equal(m.find, null);
  const none = await mine(env, 'mem_nobody', { site: 'https://itsnum.com' });
  assert.equal(none.host, null); assert.equal(none.find, 'https://itsnum.com/find-a-host/');
});

test('the client calendar feed lists confirmed and done work only, by the client\'s own token', async () => {
  const env = fresh();
  env._db.exec(`INSERT INTO num_host_requests (id,host_id,client_id,service_key,title,detail,city,starts_at,ends_at,status,created_at) VALUES
    ('hr1','h_1','hc_1','car','Car to LHR','Friday early','London','2026-09-11 06:00',NULL,'confirmed','2026-09-04'),
    ('hr2','h_1','hc_1','reservation','Dinner at Gymkhana',NULL,'London','2026-09-12 20:00','2026-09-12 22:30','done','2026-09-04'),
    ('hr3','h_1','hc_1','stay','Not yet',NULL,NULL,'2026-09-13 15:00',NULL,'new','2026-09-04'),
    ('hr4','h_1','hc_1','stay','No date',NULL,NULL,NULL,NULL,'confirmed','2026-09-04')`);
  const ics = await clientCalendar(env, 'tok_' + 'c'.repeat(20));
  assert.match(ics, /X-WR-CALNAME:Priya — for Dre/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 2);
  assert.match(ics, /SUMMARY:Car to LHR/); assert.match(ics, /DTSTART:20260911T060000/); assert.match(ics, /DTEND:20260912T223000/);
  assert.match(ics, /Arranged by Priya through NUM/);
  assert.doesNotMatch(ics, /Not yet/); assert.doesNotMatch(ics, /No date/);
  assert.equal(await clientCalendar(env, 'tok_' + 'd'.repeat(20)), null);
  assert.equal(await clientCalendar(env, 'short'), null);
});

test('what the host added travels to their calendar — what the client sent never travels back', async () => {
  /* The one-way rule, and the reason for it.
   *
   * An entry the host typed is something the client does not have, which is
   * the whole point of publishing a feed. An entry that came from an .ics THE
   * CLIENT SENT is already in the calendar subscribing to this feed, so
   * sending it back shows every flight twice in their own app — and the host
   * gets blamed for it. */
  const env = fresh();
  env._db.exec(`INSERT INTO num_client_events (id,host_id,client_id,source,title,location,starts_at,all_day,created_at) VALUES
    ('cev1','h_1','hc_1','host','Anniversary dinner','Rome','2026-11-02 20:00:00',0,'2026-09-18'),
    ('cev2','h_1','hc_1','import','BA009 LHR-BKK','Heathrow T5','2026-12-01 12:00:00',0,'2026-09-18')`);
  const ics = await clientCalendar(env, 'tok_' + 'c'.repeat(20));
  assert.match(ics, /SUMMARY:Anniversary dinner/);
  assert.match(ics, /Added by Priya through NUM/);
  assert.doesNotMatch(ics, /BA009/, 'an import must never be republished at the calendar it came from');
});

test('ONE SWITCH GOVERNS BOTH SURFACES — trips off empties the feed too', async () => {
  // Before 18 Sep 2026 portal_trips governed only /my-host/, so a host who
  // switched it off was still publishing every booking into a calendar the
  // client had already subscribed to. Empty, not 404: a feed that starts
  // erroring shows the client a broken subscription.
  const env = fresh();
  env._db.exec(`INSERT INTO num_host_requests (id,host_id,client_id,service_key,title,city,starts_at,status,created_at)
    VALUES ('hr1','h_1','hc_1','car','Car to LHR','London','2026-09-11 06:00','confirmed','2026-09-04')`);
  assert.match(await clientCalendar(env, 'tok_' + 'c'.repeat(20)), /Car to LHR/);

  env._db.exec(`UPDATE num_host_clients SET portal_trips = 0 WHERE id = 'hc_1'`);
  const off = await clientCalendar(env, 'tok_' + 'c'.repeat(20));
  assert.ok(off, 'still a calendar, not an error');
  assert.match(off, /X-WR-CALNAME:Priya — for Dre/);
  assert.doesNotMatch(off, /Car to LHR/);
  assert.equal((off.match(/BEGIN:VEVENT/g) ?? []).length, 0);
});

test('HTTP: /mine, the feed with bearer-safe headers, and the plan routes behind the console key', async () => {
  const env = fresh();
  assert.equal((await get(env, '/api/host/mine')).status, 400);
  const m = await (await get(env, '/api/host/mine?me=mem_1')).json();
  assert.equal(m.host.name, 'Priya');
  const feed = await get(env, '/api/host/client-calendar.ics?t=tok_' + 'c'.repeat(20));
  assert.equal(feed.status, 200); assert.match(feed.headers.get('content-type'), /text\/calendar/);
  assert.equal(feed.headers.get('x-robots-tag'), 'noindex'); assert.equal(feed.headers.get('cache-control'), 'private, no-store');
  assert.equal((await get(env, '/api/host/plan')).status, 401);
  const plan = await (await get(env, `/api/host/plan?k=${KEY}`)).json();
  assert.equal(plan.tier, 'free'); assert.equal(plan.plans.pro.pence, 1999); assert.equal(plan.plans.pro.currency, 'gbp'); assert.equal(plan.billing_on, true);
  const bad = await post(env, `/api/host/plan/subscribe?k=${KEY}`, { tier: 'gold' });
  assert.equal(bad.status, 400); assert.match((await bad.json()).error, /small, pro, full/);
  const cancel = await (await post(env, `/api/host/plan/cancel?k=${KEY}`)).json();
  assert.equal(cancel.ok, true); assert.match(cancel.note, /free plan/);
  assert.equal(HOST_PLANS.full.pence, 5000); assert.equal(HOST_CURRENCY, 'gbp');

  // A Phuket host is quoted in baht, not pounds — the point of the change.
  // ฿699 is a chosen price, not 1999 pence converted, so it must come back
  // as the table's own number.
  const th = await (await get(env, `/api/host/plan?k=${KEY}`, 'TH')).json();
  assert.equal(th.plans.pro.currency, 'thb');
  assert.equal(th.plans.pro.pence, 69900);
  assert.equal(th.plans.pro.display, '฿699');
  // An unpriced country falls to USD rather than to no price at all.
  const jp = await (await get(env, `/api/host/plan?k=${KEY}`, 'JP')).json();
  assert.equal(jp.plans.pro.currency, 'usd');
  assert.equal(jp.plans.pro.pence, 1999);
});
