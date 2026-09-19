// The chooser on /p/<token> — every approved way to pay, decided by where the
// table is, wired to the thing that starts it. Driven through the Worker as
// real requests against a real SQLite database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import WORKER from './worker.js';

function world({ country = 'US', connected = true, kind = 'url', target = 'https://pay.barnine.com', rails_off = '[]', withRailsTable = true, migrated = false } = {}) {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, status TEXT, console_key TEXT, category TEXT);
    CREATE TABLE num_business_profiles (business_id TEXT PRIMARY KEY, country TEXT);
    CREATE TABLE num_pay_events (token TEXT, business_id TEXT, kind TEXT, billable INTEGER, visitor_id TEXT, ip_hash TEXT, day TEXT, created_at TEXT);
    CREATE TABLE num_paylinks (token TEXT PRIMARY KEY, business_id TEXT, label TEXT, kind TEXT, target TEXT,
      promptpay_kind TEXT, amount_mode TEXT, amount TEXT, currency TEXT, state TEXT, created_at TEXT, booking_id TEXT,
      settled_at TEXT, one_time INTEGER DEFAULT 0, resource_id TEXT, zone_type TEXT, crypto_asset TEXT,
      crypto_base_units TEXT, crypto_quote TEXT);
    INSERT INTO businesses VALUES ('b1','Bar Nine','active','k_console_key_for_bar_nine_0001','bar');
    INSERT INTO num_business_profiles VALUES ('b1','${country}');
    INSERT INTO num_paylinks (token,business_id,label,kind,target,promptpay_kind,amount_mode,currency,state,created_at,one_time)
      VALUES ('STICK1','b1','Table 4','${kind}','${target}',${kind === 'promptpay' ? "'msisdn'" : 'NULL'},'open','${country === 'TH' ? 'THB' : country === 'GB' ? 'GBP' : 'USD'}','active','2026-09-17',0);
    INSERT INTO num_paylinks (token,business_id,label,kind,target,promptpay_kind,amount_mode,amount,currency,state,created_at,one_time,booking_id)
      VALUES ('BILL01','b1','Bill','${kind}','${target}',${kind === 'promptpay' ? "'msisdn'" : 'NULL'},'fixed','84.50','${country === 'TH' ? 'THB' : country === 'GB' ? 'GBP' : 'USD'}','active','2026-09-17',1,NULL);
  `);
  // Migrations 0045 and 0047. Left OFF by default on purpose: every test above
  // then runs against a database that has the code and not the columns, which
  // is the state a deploy passes through and the one that must not 500 a pay
  // page. Turn it on to exercise the lines and the split page.
  if (migrated) {
    d.exec(`
      ALTER TABLE num_paylinks ADD COLUMN split_parent TEXT;
      ALTER TABLE num_paylinks ADD COLUMN split_at TEXT;
      ALTER TABLE num_paylinks ADD COLUMN split_for_member TEXT;
      ALTER TABLE num_paylinks ADD COLUMN paid_by_member TEXT;
      CREATE TABLE num_bill_items (id TEXT PRIMARY KEY, token TEXT, pos INTEGER, name TEXT,
        qty INTEGER, unit_minor INTEGER, line_minor INTEGER, created_at TEXT);
    `);
  }
  if (withRailsTable) {
    d.exec(`CREATE TABLE num_business_rails (business_id TEXT PRIMARY KEY, stripe_account_id TEXT, stripe_charges_enabled INTEGER, rails_off TEXT);`);
    if (connected) d.prepare(`INSERT INTO num_business_rails VALUES ('b1','acct_venue',1,?)`).run(rails_off);
  }
  const DB = {
    prepare(sql) {
      const bound = [];
      const api = {
        bind(...a) { bound.push(...a); return api; },
        async first() { return d.prepare(sql).get(...bound) ?? null; },
        async all() { return { results: d.prepare(sql).all(...bound) }; },
        async run() { const r = d.prepare(sql).run(...bound); return { meta: { changes: Number(r.changes ?? 0) } }; },
      };
      return api;
    },
  };
  return { d, env: { DB, SITE: 'https://itsnum.com', APP_ORIGIN: 'https://app.itsnum.com' } };
}

const get = (env, path, headers = {}) => WORKER.fetch(new Request('https://itsnum.com' + path, {
  headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', 'accept-language': 'en-US,en;q=0.9', ...headers },
}), env, { waitUntil() {} });

test('a US bill at a connected venue shows the chooser, in payrails order, every card wired', async () => {
  const { env } = world();
  const r = await get(env, '/p/BILL01');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /How would you like to pay\?/);
  assert.match(html, /USD 84\.50/);
  const hrefs = [...html.matchAll(/class="rail[^"]*" href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(hrefs[0], 'https://app.itsnum.com/api/bill/BILL01/checkout?rail=apple_pay', 'iPhone → Apple Pay first');
  assert.ok(hrefs.includes('https://app.itsnum.com/api/bill/BILL01/checkout?rail=cashapp'));
  assert.ok(hrefs.includes('https://itsnum.com/p/BILL01/go'), 'the venue\'s own payment page stays a way to pay');
  assert.equal(hrefs.at(-1), 'https://app.itsnum.com/pay/BILL01', 'the app door is last');
  assert.ok(!hrefs.some((h) => /rail=(paypal|pay_by_bank|google_pay)/.test(h)), 'nothing a US venue on an iPhone cannot take');
  assert.match(html, /never holds it/);
});

test('an open sticker never shows Stripe rails — there is no figure to charge — so the single venue rail renders as before', async () => {
  const { env } = world();
  const r = await get(env, '/p/STICK1');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(!/How would you like to pay/.test(html));
  assert.match(html, /You will be taken to/);
  assert.match(html, /pay\.barnine\.com/);
});

test('an unconnected venue with one sticker sees exactly what it saw yesterday', async () => {
  const { env } = world({ country: 'TH', connected: false, kind: 'promptpay', target: '0812345678' });
  const html = await (await get(env, '/p/BILL01')).text();
  assert.match(html, /Pay by PromptPay/);
  assert.ok(!/How would you like to pay/.test(html));
  assert.match(html, /0812345678/);
});

test('before migration 0035 the pay page still works — no table means no connected venue, not a 503', async () => {
  const { env } = world({ withRailsTable: false });
  const r = await get(env, '/p/BILL01');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /You will be taken to/);
});

test('crypto is held in Thailand: a Thai USDC sticker cannot be paid and says why; the same sticker in the UK pays', async () => {
  const th = world({ country: 'TH', connected: false, kind: 'crypto', target: '0x8335' + 'a'.repeat(36) });
  const r = await get(th.env, '/p/BILL01');
  assert.equal(r.status, 409);
  const html = await r.text();
  assert.match(html, /on hold at venues in Thailand/);
  assert.match(html, /Nothing was charged/);
  const gb = world({ country: 'GB', connected: false, kind: 'crypto', target: '0x8335' + 'a'.repeat(36) });
  const r2 = await get(gb.env, '/p/BILL01');
  assert.equal(r2.status, 200);
  assert.match(await r2.text(), /Pay in USDC/);
});

test('sub-views: /promptpay and /crypto render the single rail with a way back; a rail the venue lacks is refused', async () => {
  const { d, env } = world({ country: 'GB', kind: 'url' });
  d.prepare(`INSERT INTO num_paylinks (token,business_id,label,kind,target,amount_mode,currency,state,created_at,one_time)
    VALUES ('CRY','b1','Wallet','crypto','0x${'b'.repeat(40)}','open','GBP','active','2026-09-17',0)`).run();
  let html = await (await get(env, '/p/BILL01/crypto')).text();
  assert.match(html, /Pay in USDC/);
  assert.match(html, /Other ways to pay/);
  const r = await get(env, '/p/BILL01/promptpay');
  assert.equal(r.status, 409, 'a UK venue has no PromptPay');
});

test('the venue can switch a rail off and the chooser obeys', async () => {
  const { env } = world({ country: 'GB', rails_off: '["paypal","revolut_pay"]' });
  const html = await (await get(env, '/p/BILL01', { 'accept-language': 'en-GB' })).text();
  const hrefs = [...html.matchAll(/class="rail[^"]*" href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(hrefs[0], 'https://app.itsnum.com/api/bill/BILL01/checkout?rail=pay_by_bank', 'UK: Pay by Bank leads');
  assert.ok(!hrefs.some((h) => /rail=(paypal|revolut_pay)/.test(h)));
});

test('coming back from Stripe with ?paid=1 shows a confirming screen that refreshes itself; ?why= shows the reason', async () => {
  const { env } = world();
  let html = await (await get(env, '/p/BILL01?paid=1')).text();
  assert.match(html, /Payment received/);
  assert.match(html, /http-equiv="refresh"/);
  html = await (await get(env, '/p/BILL01?why=' + encodeURIComponent('Cash App Pay is not switched on'))).text();
  assert.match(html, /Cash App Pay is not switched on/);
});


/* ── what was on the bill, and a bill that was split ────────────────────── */

test('an itemised bill shows its lines, and they add up to the figure above them', async () => {
  const { d, env } = world({ migrated: true });
  d.exec(`
    INSERT INTO num_bill_items VALUES ('i1','BILL01',0,'Pad Thai',2,1800,3600,'2026-09-19');
    INSERT INTO num_bill_items VALUES ('i2','BILL01',1,'Singha',3,1150,3450,'2026-09-19');
    INSERT INTO num_bill_items VALUES ('i3','BILL01',2,'Service',1,1400,1400,'2026-09-19');
  `);
  const html = await (await get(env, '/p/BILL01')).text();
  assert.match(html, /USD 84\.50/);
  assert.match(html, /Pad Thai/);
  assert.match(html, /Singha/);
  // 36.00 + 34.50 + 14.00 = 84.50. The guest can check the total themselves,
  // which is the entire reason for showing the lines.
  const cells = [...html.matchAll(/<td class="r">([\d.]+)<\/td>/g)].map((m) => Number(m[1]));
  assert.deepEqual(cells, [36, 34.5, 14]);
  assert.equal(cells.reduce((a, b) => a + b, 0), 84.5);
});

test('a bill with no lines renders exactly as it did before, with no empty table', async () => {
  const { env } = world({ migrated: true });
  const html = await (await get(env, '/p/BILL01')).text();
  assert.match(html, /How would you like to pay\?/);
  assert.ok(!/class="lines"/.test(html), 'most bills are a total, and they must not grow an empty box');
});

test('the page still renders when 0045 has not run', async () => {
  // The deploy passes through this state. A pay page that 500s between the
  // code shipping and the migration running is the failure the migration
  // hygiene rules exist to describe.
  const { env } = world();
  const r = await get(env, '/p/BILL01');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /How would you like to pay\?/);
});

test('a split bill says so and offers NO way to pay the table twice', async () => {
  const { d, env } = world({ migrated: true });
  d.prepare("UPDATE num_paylinks SET split_at='2026-09-19' WHERE token='BILL01'").run();
  const r = await get(env, '/p/BILL01');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /This bill was split/);
  assert.match(html, /each share was sent to their NUM/);
  assert.ok(!/How would you like to pay\?/.test(html));
  assert.ok(!/class="rail/.test(html), 'not one rail card: paying this again pays for the table twice');
  assert.match(html, /BILL01/, 'the reference stays, so staff can be asked about it');
});

test('a split bill still shows what was on it', async () => {
  const { d, env } = world({ migrated: true });
  d.exec("INSERT INTO num_bill_items VALUES ('i1','BILL01',0,'Pad Thai',2,1800,3600,'2026-09-19');");
  d.prepare("UPDATE num_paylinks SET split_at='2026-09-19' WHERE token='BILL01'").run();
  const html = await (await get(env, '/p/BILL01')).text();
  assert.match(html, /This bill was split/);
  assert.match(html, /Pad Thai/);
});

test('a share of a split is an ordinary payable bill', async () => {
  // The shares ARE the bills now. Nothing about being a share may make one
  // harder to pay than any other code.
  const { d, env } = world({ migrated: true });
  d.prepare(`INSERT INTO num_paylinks (token,business_id,label,kind,target,amount_mode,amount,currency,state,created_at,one_time,split_parent)
             VALUES ('SHARE1','b1','Bill · Dre','url','https://pay.barnine.com','fixed','21.13','USD','active','2026-09-19',1,'BILL01')`).run();
  const html = await (await get(env, '/p/SHARE1')).text();
  assert.match(html, /How would you like to pay\?/);
  assert.match(html, /USD 21\.13/);
  assert.ok(/class="rail/.test(html));
});
