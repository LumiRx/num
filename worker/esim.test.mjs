// The eSIM doors end to end, against a real SQLite, with Stripe, Twilio and
// Resend answered by a fake fetch. Follows every link a traveller follows:
// page -> quote -> pay link -> Stripe -> webhook -> supplier -> install page
// -> text. See wire-before-you-ship: a control is not done until the last
// link is proved to fire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './esimtestdb.mjs';
import * as E from './esim.mjs';
import * as O from './esimorders.mjs';
import { refreshCatalogue } from './esimstore.mjs';

const SCHEMA = ['worker/migrations/0064_esim.sql'];
const mk = (code, c, mb, days, cost) => ({ provider: 'esimaccess', code, name: code, costUnits: cost * 100, costCs: cost, retailCs: null, dataMb: mb, unlimited: false, daily: false, days, activateWithinDays: 180, countries: c, scope: c.length <= 1 ? 'local' : 'regional', topup: false, networks: ['AIS 5G'] });
const CATALOGUE = [mk('TH3', ['TH'], 3072, 7, 150), mk('TH10', ['TH'], 10240, 30, 400), mk('TH20', ['TH'], 20480, 30, 700),
  ...Array.from({ length: 20 }, (_, i) => mk(`JP${i}`, ['JP'], 1024 * (i + 1), 30, 100 + i * 10))];

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, init });
  if (u === 'https://api.stripe.com/v1/checkout/sessions') return new Response(JSON.stringify({ id: `cs_test_${calls.length}`, url: `https://checkout.stripe.com/c/pay/cs_test_${calls.length}` }), { status: 200 });
  if (u === 'https://api.stripe.com/v1/refunds') return new Response(JSON.stringify({ id: 're_1', status: 'succeeded' }), { status: 200 });
  if (u.includes('api.twilio.com')) return new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 });
  if (u.includes('api.resend.com')) return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
  return new Response('{}', { status: 404 });
};

function driver(over = {}) {
  const log = { orders: [], cancels: [] };
  return {
    log,
    d: {
      id: 'esimaccess', ready: () => true,
      balance: async () => ({ ok: true, balanceCs: 50000 }),
      packages: async () => ({ ok: true, plans: CATALOGUE }),
      order: async (a) => { log.orders.push(a); return { ok: true, orderNo: 'B1' }; },
      query: async () => ({ ok: true, profiles: [{ iccid: '8985', esimTranNo: 'T1', lpa: 'LPA:1$rsp.redtea.io$ABC-123', qrUrl: 'https://p.qrsim.net/x.png' }] }),
      cancel: async (a) => { log.cancels.push(a); return { ok: true }; },
      ...over,
    },
  };
}

async function world(over = {}) {
  const db = d1(SCHEMA);
  const { d, log } = driver(over.driver);
  const alerts = [];
  const env = {
    DB: db, ESIM_TEST_DRIVERS: [d], ESIM_TEST_ALERT: async (t) => alerts.push(t),
    STRIPE_SECRET_KEY: 'sk_test_x', TWILIO_SID: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', TWILIO_TOKEN: 't', TWILIO_FROM: '+14243460888',
    RESEND_KEY: 're_x', ADMIN_KEY: 'admin-secret', ESIMACCESS_WEBHOOK_SECRET: 'bell_0123456789abcdef', ...over.env,
  };
  if (over.seed !== false) await refreshCatalogue(db, [d], env);
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const settle = async () => { while (waits.length) await waits.shift(); };
  return { db, env, log, alerts, ctx, settle };
}

const get = (env, ctx, path, headers = {}) => E.handleEsimPage(new Request(`https://app.itsnum.com${path}`, { headers }), env, ctx);
const api = (env, ctx, path, init) => E.handleEsimApi(new Request(`https://app.itsnum.com${path}`, init), env, ctx);

test('before the migration, every door answers in its own voice and sells nothing', async () => {
  const env = { DB: d1([]) };
  const page = await get(env, {}, '/esim');
  assert.equal(page.status, 503);
  assert.match(await page.text(), /being set up/);
  assert.equal((await api(env, {}, '/api/esim/quote', { method: 'POST' })).status, 503);
  assert.equal(await E.salesOpen(env), false);
  assert.deepEqual(await E.esimText(env, { from: '+14155550100', body: 'ESIM' }), { handled: false });
});

test('web: listing -> country -> quote -> pay link -> Stripe -> webhook -> supplier -> install page -> text + email', async () => {
  const w = await world();
  const home = await get(w.env, w.ctx, '/esim');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /href="\/esim\/th">Thailand/);

  const th = await (await get(w.env, w.ctx, '/esim/th')).text();
  assert.match(th, /value="esimaccess:TH10"/);

  const q = await api(w.env, w.ctx, '/api/esim/quote', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.9' },
    body: 'plan=esimaccess%3ATH10&country=TH&airport=&phone=%2B1+415+555+0100&sms_ok=1',
  });
  assert.equal(q.status, 303);
  const payPath = new URL(q.headers.get('Location')).pathname;
  assert.match(payPath, /^\/esim\/pay\/[A-Za-z0-9_-]{24}$/);
  const token = payPath.split('/').pop();
  let order = await O.getByToken(w.db, token);
  assert.equal(order.state, 'quoted');
  assert.equal(order.phone, '+14155550100');
  assert.equal(order.sms_ok, 1);

  const pay = await get(w.env, w.ctx, payPath);
  assert.equal(pay.status, 303);
  assert.match(pay.headers.get('Location'), /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
  const stripeCall = calls.filter((c) => c.url === 'https://api.stripe.com/v1/checkout/sessions').at(-1);
  assert.match(stripeCall.init.body, new RegExp(`unit_amount%5D=${order.price_cs}`));
  assert.match(stripeCall.init.body, /metadata%5Bkind%5D=esim/);
  order = await O.getByToken(w.db, token);
  assert.equal(order.state, 'checkout');

  const before = calls.length;
  const again = await get(w.env, w.ctx, payPath);
  assert.equal(again.headers.get('Location'), pay.headers.get('Location'), 'an open Checkout page is reused');
  assert.equal(calls.length, before, 'and Stripe is not asked twice');

  const r = await E.onCheckoutCompleted(w.env, { id: order.stripe_session, metadata: { num_esim: order.id, kind: 'esim' }, payment_status: 'paid', currency: 'usd', amount_total: order.price_cs, payment_intent: 'pi_1', customer_details: { email: 'T@Example.com' } }, w.ctx);
  assert.equal(r.state, 'paid');
  await w.settle();
  order = await O.getByToken(w.db, token);
  assert.equal(order.state, 'ready');
  assert.deepEqual(w.log.orders, [{ planCode: 'TH10', txnId: order.id, costUnits: 40000 }]);

  const sms = calls.filter((c) => c.url.includes('api.twilio.com')).at(-1);
  const smsBody = new URLSearchParams(sms.init.body);
  assert.equal(smsBody.get('To'), '+14155550100');
  assert.match(smsBody.get('Body'), new RegExp(`/esim/o/${token}`));
  const mail = calls.filter((c) => c.url.includes('api.resend.com')).at(-1);
  assert.deepEqual(JSON.parse(mail.init.body).to, ['t@example.com']);
  assert.equal(JSON.parse(mail.init.body).bcc, undefined, 'install codes are never blind-copied');

  const page = await (await get(w.env, w.ctx, `/esim/o/${token}`)).text();
  assert.match(page, /Install on this iPhone/);
  assert.match(page, /esimsetup\.apple\.com\/esim_qrcode_provisioning\?carddata=LPA:1\$rsp\.redtea\.io\$ABC-123/);
});

test('a repeated webhook changes nothing; a second payment is refunded', async () => {
  const w = await world();
  const { order } = await O.createQuote(w.db, { plan: { provider: 'esimaccess', code: 'TH3', costUnits: 15000, costCs: 150, priceCs: 249, dataMb: 3072, days: 7 }, dest: { label: 'Thailand', country: 'TH' } });
  const s = { id: 'cs_a', metadata: { num_esim: order.id, kind: 'esim' }, payment_status: 'paid', currency: 'usd', amount_total: 249, payment_intent: 'pi_a' };
  await E.onCheckoutCompleted(w.env, s, w.ctx);
  await w.settle();
  assert.equal((await E.onCheckoutCompleted(w.env, s, w.ctx)).repeat, true);
  const dup = await E.onCheckoutCompleted(w.env, { ...s, id: 'cs_b', payment_intent: 'pi_b' }, w.ctx);
  assert.equal(dup.state, 'duplicate_refunded');
  const refund = calls.filter((c) => c.url === 'https://api.stripe.com/v1/refunds').at(-1);
  assert.match(refund.init.body, /payment_intent=pi_b/);
  assert.equal(refund.init.headers['Idempotency-Key'], 'esim_dup_pi_b');
  assert.equal(w.log.orders.length, 1, 'still exactly one eSIM bought');
});

test('a payment that does not match the order is refunded, never filled', async () => {
  const w = await world();
  const { order } = await O.createQuote(w.db, { plan: { provider: 'esimaccess', code: 'TH3', costUnits: 15000, costCs: 150, priceCs: 249, dataMb: 3072, days: 7 }, dest: { label: 'Thailand', country: 'TH' } });
  const r = await E.onCheckoutCompleted(w.env, { id: 'cs_x', metadata: { num_esim: order.id, kind: 'esim' }, payment_status: 'paid', currency: 'usd', amount_total: 1, payment_intent: 'pi_x' }, w.ctx);
  assert.equal(r.state, 'attention');
  assert.equal(w.log.orders.length, 0);
  assert.ok(w.alerts.some((a) => /refunded automatically/.test(a)));
});

test('the pay link refuses to take money while sales are paused', async () => {
  const w = await world({ env: { ESIM_SALES: 'off' } });
  const { order } = await O.createQuote(w.db, { plan: { provider: 'esimaccess', code: 'TH3', costUnits: 15000, costCs: 150, priceCs: 249, dataMb: 3072, days: 7 }, dest: { label: 'Thailand', country: 'TH' } });
  const res = await get(w.env, w.ctx, `/esim/pay/${order.token}`);
  assert.equal(res.status, 503);
  assert.match(await res.text(), /Nothing was charged/);
});

test('sales pause when the prepaid supplier balance cannot cover a sale', async () => {
  const w = await world({ driver: { balance: async () => ({ ok: true, balanceCs: 200 }) } });
  assert.equal(await E.salesOpen(w.env), false);
});

test('quote validation: wrong country, bad phone, texts without a number', async () => {
  const w = await world();
  const post = (body) => api(w.env, w.ctx, '/api/esim/quote', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  assert.equal((await post('plan=esimaccess%3ATH10&country=JP')).status, 400);
  assert.equal((await post('plan=esimaccess%3ANOPE&country=TH')).status, 404);
  assert.equal((await post('plan=esimaccess%3ATH10&country=TH&phone=0812345678')).status, 400);
  assert.equal((await post('plan=esimaccess%3ATH10&country=TH&sms_ok=1')).status, 400);
  const ok = await api(w.env, w.ctx, '/api/esim/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: 'esimaccess:TH3', airport: 'BKK', channel: 'app' }) });
  const j = await ok.json();
  assert.equal(ok.status, 200);
  assert.match(j.pay_url, /\/esim\/pay\//);
});

test('text: ESIM BKK -> menu -> 1 -> pay link, consent recorded', async () => {
  const w = await world();
  await w.db.exec(`CREATE TABLE IF NOT EXISTS num_sms_consent (id TEXT PRIMARY KEY, phone TEXT UNIQUE, first_name TEXT, consent_text TEXT, consent_version TEXT, page TEXT, ip TEXT, user_agent TEXT, country TEXT, created_at INTEGER, revoked_at INTEGER)`);
  const a = await E.esimText(w.env, { from: '+447700900123', body: 'ESIM BKK' });
  assert.equal(a.handled, true);
  assert.match(a.reply, /Thailand eSIM, data only/);
  const b = await E.esimText(w.env, { from: '+447700900123', body: '1' });
  assert.match(b.reply, /Pay here \(Apple Pay works\): https:\/\/app\.itsnum\.com\/esim\/pay\//);
  const row = await w.db.prepare('SELECT consent_text FROM num_sms_consent WHERE phone = ?').bind('+447700900123').first();
  assert.match(row.consent_text, /ESIM BKK/);
});

test('the supplier doorbell: wrong secret is a 404, the right one is heard', async () => {
  const w = await world();
  assert.equal((await api(w.env, w.ctx, '/api/esim/doorbell/wrong_wrong_wrong_wrong', { method: 'POST', body: '{}' })).status, 404);
  const ok = await api(w.env, w.ctx, '/api/esim/doorbell/bell_0123456789abcdef', { method: 'POST', body: JSON.stringify({ notifyType: 'CHECK_HEALTH', notifyId: 'n0' }) });
  assert.equal(ok.status, 200);
  const off = await api({ ...w.env, ESIMACCESS_WEBHOOK_SECRET: '' }, w.ctx, '/api/esim/doorbell/bell_0123456789abcdef', { method: 'POST', body: '{}' });
  assert.equal(off.status, 404, 'no secret configured means no doorbell');
});

test('the admin door is shut without the key and tells the whole story with it', async () => {
  const w = await world();
  const no = await E.handleEsimAdmin(new Request('https://app.itsnum.com/api/admin/esim'), w.env, w.ctx);
  assert.equal(no.status, 401);
  const yes = await E.handleEsimAdmin(new Request('https://app.itsnum.com/api/admin/esim', { headers: { 'X-Admin-Key': 'admin-secret' } }), w.env, w.ctx);
  const j = await yes.json();
  assert.equal(yes.status, 200);
  assert.deepEqual(j.suppliers, [{ id: 'esimaccess', configured: true }]);
  assert.equal(j.catalogue.plans, CATALOGUE.length);
  assert.equal(j.sales_open, true);
});

test('admin refund of an installed-looking order asks for force; an unused one is cancelled and refunded', async () => {
  const w = await world({ driver: { cancel: async () => ({ ok: false, error: 'profile in use' }) } });
  const { order } = await O.createQuote(w.db, { plan: { provider: 'esimaccess', code: 'TH3', costUnits: 15000, costCs: 150, priceCs: 249, dataMb: 3072, days: 7 }, dest: { label: 'Thailand', country: 'TH' } });
  await E.onCheckoutCompleted(w.env, { id: 'cs_r', metadata: { num_esim: order.id, kind: 'esim' }, payment_status: 'paid', currency: 'usd', amount_total: 249, payment_intent: 'pi_r' }, w.ctx);
  await w.settle();
  const post = (body) => E.handleEsimAdmin(new Request('https://app.itsnum.com/api/admin/esim', { method: 'POST', headers: { 'X-Admin-Key': 'admin-secret' }, body: JSON.stringify(body) }), w.env, w.ctx);
  assert.equal((await post({ action: 'refund', id: order.id })).status, 409);
  const forced = await (await post({ action: 'refund', token: order.token, force: true })).json();
  assert.equal(forced.state, 'refunded');
  const status = await (await E.handleEsimAdmin(new Request('https://app.itsnum.com/api/admin/esim', { headers: { 'X-Admin-Key': 'admin-secret' } }), w.env, w.ctx)).json();
  assert.equal(status.recent[0].id, order.id);
});

test('the cron sweeps, refreshes a stale listing, and warns on a low balance once', async () => {
  const w = await world({ seed: false, driver: { balance: async () => ({ ok: true, balanceCs: 1500 }) } });
  const first = await E.esimCron(w.env);
  assert.equal(first.refresh.ok, true);
  assert.equal(first.balanceCs, 1500);
  assert.equal(w.alerts.filter((a) => /supplier balance/.test(a)).length, 1);
  await E.esimCron(w.env);
  assert.equal(w.alerts.filter((a) => /supplier balance/.test(a)).length, 1, 'not every five minutes');
});

test('concierge by text: only eSIM buyers, only when switched on, capped', async () => {
  const w = await world({ env: { SMS_CONCIERGE: 'on', SMS_CONCIERGE_DAILY_CAP: '2' } });
  const ask = async () => '**Sure.** The *Airport Rail Link* runs every 10 minutes.';
  assert.equal(await E.conciergeByText(w.env, w.ctx, { from: '+14155550199', text: 'how do I get downtown' }, { ask }), false, 'not a buyer');
  const { order } = await O.createQuote(w.db, { plan: { provider: 'esimaccess', code: 'TH3', costUnits: 15000, costCs: 150, priceCs: 249, dataMb: 3072, days: 7 }, dest: { label: 'Thailand', country: 'TH' }, phone: '+14155550199' });
  await O.markPaid(w.db, order.id, { paidCs: 249 });
  assert.equal(await E.conciergeByText(w.env, w.ctx, { from: '+14155550199', text: 'how do I get downtown' }, { ask }), true);
  await w.settle();
  const sent = calls.filter((c) => c.url.includes('api.twilio.com')).at(-1);
  assert.equal(new URLSearchParams(sent.init.body).get('Body'), 'Sure. The *Airport Rail Link* runs every 10 minutes.');
  assert.equal(await E.conciergeByText(w.env, w.ctx, { from: '+14155550199', text: 'b' }, { ask }), true);
  assert.equal(await E.conciergeByText(w.env, w.ctx, { from: '+14155550199', text: 'c' }, { ask }), false, 'daily cap');
  assert.equal(await E.conciergeByText({ ...w.env, SMS_CONCIERGE: '' }, w.ctx, { from: '+14155550199', text: 'd' }, { ask }), false, 'off by default');
});

test('forText keeps answers SMS-sized and plain', () => {
  assert.equal(E.forText('## Hi\n- **one**\n- [map](https://x.co/a)'), 'Hi\n- one\n- map https://x.co/a');
  const long = 'Sentence one is here. '.repeat(60);
  const t = E.forText(long);
  assert.ok(t.length <= 600);
  assert.match(t, /More in the app/);
});

test('e164', () => {
  assert.equal(E.e164('+1 (415) 555-0100'), '+14155550100');
  assert.equal(E.e164('0044 7700 900123'), '+447700900123');
  assert.equal(E.e164(''), null);
  assert.equal(E.e164('07700 900123'), false);
});

test('pages for places we do not know are honest 404s', async () => {
  const w = await world();
  assert.equal((await get(w.env, w.ctx, '/esim/zz')).status, 404);
  assert.equal((await get(w.env, w.ctx, '/esim/airport/zzz')).status, 404);
  assert.equal((await get(w.env, w.ctx, '/esim/o/nottheresomethingtoken')).status, 404);
  const find = await get(w.env, w.ctx, '/esim/find?q=bangkok');
  assert.equal(find.status, 302);
  assert.equal(find.headers.get('Location'), '/esim/th', 'a city people name as a destination goes to its country');
  assert.equal((await get(w.env, w.ctx, '/esim/find?q=BKK')).headers.get('Location'), '/esim/airport/bkk');
  assert.equal((await get(w.env, w.ctx, '/esim/find?q=europe')).headers.get('Location'), '/esim/region/eu');
  assert.equal((await get(w.env, w.ctx, '/esim/find?q=qqqq')).status, 404);
  const sitemap = await (await get(w.env, w.ctx, '/esim/sitemap.xml')).text();
  assert.match(sitemap, /\/esim\/th</);
  assert.match(sitemap, /\/esim\/airport\/bkk</);
});

test('the concierge hears about eSIMs only when a supplier is configured', async () => {
  const { esimBlock } = await import('./services.mjs');
  assert.equal(esimBlock({ country_code: 'TH' }, {}), '');
  assert.match(esimBlock({ country_code: 'TH' }, { ESIMACCESS_ACCESS_CODE: 'x', TWILIO_FROM: '+14243460888' }), /app\.itsnum\.com\/esim\/th/);
  assert.match(esimBlock({ country_code: 'TH' }, { ESIMACCESS_ACCESS_CODE: 'x', TWILIO_FROM: '+14243460888' }), /text ESIM/);
  assert.equal(esimBlock({}, { ESIMACCESS_ACCESS_CODE: 'x', ESIM_SALES: 'off' }), '');
  assert.doesNotMatch(esimBlock({ country_code: 'TH' }, { ESIMACCESS_ACCESS_CODE: 'x' }), /cheapest(?! and)/i);
});

// ---- found by the adversarial review, 21 Sep ----------------------------------------

const TH3 = { provider: 'esimaccess', code: 'TH3', costUnits: 15000, costCs: 150, priceCs: 249, dataMb: 3072, days: 7 };
const paidSession = (order, pi, extra = {}) => ({ id: `cs_${pi}`, metadata: { num_esim: order.id, kind: 'esim' }, payment_status: 'paid', currency: 'usd', amount_total: order.price_cs, payment_intent: pi, ...extra });

test('a payment that lands after the quote expired is honoured: the traveller gets the eSIM', async () => {
  const w = await world();
  const { order } = await O.createQuote(w.db, { plan: TH3, dest: { label: 'Thailand', country: 'TH' }, email: 'late@example.com' });
  assert.equal(await O.expireOne(w.db, order.id), true);
  const r = await E.onCheckoutCompleted(w.env, paidSession(order, 'pi_late'), w.ctx);
  assert.equal(r.state, 'paid');
  await w.settle();
  const now = await O.getById(w.db, order.id);
  assert.equal(now.state, 'ready');
  assert.equal(now.stripe_pi, 'pi_late');
  assert.equal(w.log.orders.length, 1);
});

test('a payment an order can no longer use is refunded under its own key, judged on a fresh read', async () => {
  const w = await world();
  const { order } = await O.createQuote(w.db, { plan: TH3, dest: { label: 'Thailand', country: 'TH' } });
  await E.onCheckoutCompleted(w.env, paidSession(order, 'pi_bad', { amount_total: 1 }), w.ctx);
  assert.equal((await O.getById(w.db, order.id)).state, 'attention');
  const r = await E.onCheckoutCompleted(w.env, paidSession(order, 'pi_c'), w.ctx);
  assert.equal(r.state, 'unapplied_refunded');
  const refund = calls.filter((c) => c.url === 'https://api.stripe.com/v1/refunds').at(-1);
  assert.match(refund.init.body, /payment_intent=pi_c/);
  assert.equal(refund.init.headers['Idempotency-Key'], 'esim_unapplied_pi_c');
  assert.equal(w.log.orders.length, 0, 'nothing bought from the supplier');
});

test('the Stripe webhook answers 500 when an eSIM payment was not processed, so Stripe retries; 200 when it was', async () => {
  const { handlePay } = await import('./pay.mjs');
  const signed = async (secret, event) => {
    const payload = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const enc = (x) => new TextEncoder().encode(x);
    const key = await crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const hex = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc(`${t}.${payload}`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    return new Request('https://app.itsnum.com/api/pay/webhook', { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${hex}` }, body: payload });
  };
  const event = (order, pi) => ({ type: 'checkout.session.completed', data: { object: paidSession(order, pi) } });

  const bare = { DB: d1([]), STRIPE_WEBHOOK_SECRET: 'whsec_test' };
  const lost = await handlePay(await signed('whsec_test', event({ id: 'eso_missing', price_cs: 249 }, 'pi_z')), bare, '/webhook', { waitUntil() {} });
  assert.equal(lost.status, 500, 'no tables: Stripe must retry, not be told it worked');

  const w = await world({ env: { STRIPE_WEBHOOK_SECRET: 'whsec_test' } });
  const { order } = await O.createQuote(w.db, { plan: TH3, dest: { label: 'Thailand', country: 'TH' } });
  const ok = await handlePay(await signed('whsec_test', event(order, 'pi_ok')), w.env, '/webhook', w.ctx);
  assert.equal(ok.status, 200);
  await w.settle();
  assert.equal((await O.getById(w.db, order.id)).state, 'ready');
  const again = await handlePay(await signed('whsec_test', event(order, 'pi_ok')), w.env, '/webhook', w.ctx);
  assert.equal(again.status, 200, 'a retry of a handled event is a quiet 200');
  assert.equal(w.log.orders.length, 1);
});

test('admin refunds: no profile number or still ordering needs force; a refund already under way is refused', async () => {
  const w = await world({ driver: { query: async () => ({ ok: true, profiles: [{ iccid: '8985', esimTranNo: null, lpa: 'LPA:1$rsp.redtea.io$ABC-123' }] }) } });
  const post = (body) => E.handleEsimAdmin(new Request('https://app.itsnum.com/api/admin/esim', { method: 'POST', headers: { 'X-Admin-Key': 'admin-secret' }, body: JSON.stringify(body) }), w.env, w.ctx);

  const { order } = await O.createQuote(w.db, { plan: TH3, dest: { label: 'Thailand', country: 'TH' } });
  await E.onCheckoutCompleted(w.env, paidSession(order, 'pi_nt'), w.ctx);
  await w.settle();
  assert.equal((await O.getById(w.db, order.id)).state, 'ready');
  const refused = await post({ action: 'refund', id: order.id });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /no supplier profile number/);
  assert.equal((await (await post({ action: 'refund', id: order.id, force: true })).json()).state, 'refunded');

  const { order: o2 } = await O.createQuote(w.db, { plan: TH3, dest: { label: 'Thailand', country: 'TH' } });
  await O.markPaid(w.db, o2.id, { sessionId: 'cs_o2', paymentIntent: 'pi_o2', paidCs: 249 });
  await O.claimForOrdering(w.db, o2.id);
  assert.equal((await post({ action: 'refund', id: o2.id })).status, 409, 'ordering needs force');
  const f = await (await post({ action: 'refund', id: o2.id, force: true })).json();
  assert.equal(f.state, 'refunded');
  assert.match(f.note, /supplier console/);

  const { order: o3 } = await O.createQuote(w.db, { plan: TH3, dest: { label: 'Thailand', country: 'TH' } });
  await O.markPaid(w.db, o3.id, { sessionId: 'cs_o3', paymentIntent: 'pi_o3', paidCs: 249 });
  await O.claimRefund(w.db, o3.id, 'paid', 'test');
  const busy = await post({ action: 'refund', id: o3.id });
  assert.equal(busy.status, 409);
  assert.match((await busy.json()).error, /already under way/);
});

test('consent: WhatsApp never joins the SMS list; the web marketing box counts only once paid, and never over an opt-out', async () => {
  const w = await world();
  await w.db.exec(`CREATE TABLE IF NOT EXISTS num_sms_consent (id TEXT PRIMARY KEY, phone TEXT UNIQUE, first_name TEXT, consent_text TEXT, consent_version TEXT, page TEXT, ip TEXT, user_agent TEXT, country TEXT, created_at INTEGER, revoked_at INTEGER)`);
  const consentRow = (phone) => w.db.prepare('SELECT consent_text, ip, revoked_at FROM num_sms_consent WHERE phone = ?').bind(phone).first();

  await E.esimText(w.env, { from: '+447700900555', body: 'ESIM BKK', channel: 'whatsapp' });
  assert.equal(await consentRow('+447700900555'), null, 'a WhatsApp message is not an SMS opt-in');

  const quote = (phone) => api(w.env, w.ctx, '/api/esim/quote', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.7', 'User-Agent': 'TestUA' },
    body: `plan=esimaccess%3ATH10&country=TH&phone=${encodeURIComponent(phone)}&marketing_ok=1`,
  });
  const q = await quote('+14155550177');
  const token = new URL(q.headers.get('Location')).pathname.split('/').pop();
  assert.equal(await consentRow('+14155550177'), null, 'nothing recorded before payment');
  const order = await O.getByToken(w.db, token);
  assert.equal(order.consent_ip, '203.0.113.7');
  await E.onCheckoutCompleted(w.env, paidSession(order, 'pi_mk'), w.ctx);
  await w.settle();
  const row = await consentRow('+14155550177');
  assert.match(row.consent_text, /travel tips and offers/);
  assert.equal(row.ip, '203.0.113.7');
  assert.equal((await O.getById(w.db, order.id)).consent_ip, null, 'the evidence moved to the register and left the order');

  await w.db.prepare("INSERT INTO num_sms_consent (id, phone, consent_text, consent_version, created_at, revoked_at) VALUES ('sc_x', '+14155550188', '[web_form] old', 'v1', 1, 2)").run();
  const q2 = await quote('+14155550188');
  const o2 = await O.getByToken(w.db, new URL(q2.headers.get('Location')).pathname.split('/').pop());
  await E.onCheckoutCompleted(w.env, paidSession(o2, 'pi_mk2'), w.ctx);
  await w.settle();
  assert.equal((await consentRow('+14155550188')).revoked_at, 2, 'an opt-out stays an opt-out');
});

test('two sessions for one order completing at the same moment: one eSIM, and the other payment goes back', async () => {
  const w = await world();
  const { order } = await O.createQuote(w.db, { plan: TH3, dest: { label: 'Thailand', country: 'TH' } });
  const before = calls.filter((c) => c.url === 'https://api.stripe.com/v1/refunds').length;
  const [a, b] = await Promise.all([
    E.onCheckoutCompleted(w.env, paidSession(order, 'pi_x1'), w.ctx),
    E.onCheckoutCompleted(w.env, paidSession(order, 'pi_x2'), w.ctx),
  ]);
  await w.settle();
  const states = [a.state, b.state].sort();
  assert.deepEqual(states, ['duplicate_refunded', 'paid']);
  const refunds = calls.filter((c) => c.url === 'https://api.stripe.com/v1/refunds').slice(before);
  assert.equal(refunds.length, 1);
  const kept = (await O.getById(w.db, order.id)).stripe_pi;
  assert.match(refunds[0].init.body, new RegExp(`payment_intent=${kept === 'pi_x1' ? 'pi_x2' : 'pi_x1'}`));
  assert.equal(w.log.orders.length, 1);
});

test('an order being refunded: the pay link opens no new checkout, and the page never shows install codes', async () => {
  const w = await world();
  const { order } = await O.createQuote(w.db, { plan: TH3, dest: { label: 'Thailand', country: 'TH' } });
  await E.onCheckoutCompleted(w.env, paidSession(order, 'pi_rf'), w.ctx);
  await w.settle();
  await O.claimRefund(w.db, order.id, 'ready', 'test');
  const before = calls.filter((c) => c.url === 'https://api.stripe.com/v1/checkout/sessions').length;
  const pay = await get(w.env, w.ctx, `/esim/pay/${order.token}`);
  assert.equal(pay.status, 303);
  assert.equal(pay.headers.get('Location'), `/esim/o/${order.token}`);
  assert.equal(calls.filter((c) => c.url === 'https://api.stripe.com/v1/checkout/sessions').length, before, 'no second checkout');
  const page = await (await get(w.env, w.ctx, `/esim/o/${order.token}`)).text();
  assert.match(page, /Your refund is on its way/);
  assert.doesNotMatch(page, /Install on this iPhone|Activation code/);
});

test('the success page of a late payment says "payment received", not "nothing was charged"', async () => {
  const w = await world();
  const { order } = await O.createQuote(w.db, { plan: TH3, dest: { label: 'Thailand', country: 'TH' } });
  await O.expireOne(w.db, order.id);
  const page = await (await get(w.env, w.ctx, `/esim/o/${order.token}?paid=1`)).text();
  assert.match(page, /Payment received/);
  assert.doesNotMatch(page, /Nothing was charged/);
});

test('every eSIM page reaches the Worker: Cloudflare run_worker_first and the service worker both hand it over', async () => {
  const { readFileSync } = await import('node:fs');
  // Cloudflare's asset layer answers any path NOT listed here with the app
  // shell before the Worker runs. Shipped once without /esim: every eSIM page,
  // the pay link and the install link came back as the React app.
  const cfg = readFileSync(new URL('../wrangler.app.jsonc', import.meta.url), 'utf8');
  const list = JSON.parse(`[${/"run_worker_first":\s*\[([^\]]*)\]/.exec(cfg)[1]}]`);
  const workerFirst = (path) => list.some((p) => (p.endsWith('/*') ? path.startsWith(p.slice(0, -1)) : path === p));
  // The installed app's service worker must not answer these navigations
  // either: the pay link is a 303, and a redirected response handed back for a
  // navigation is a network error in the browser.
  const sw = readFileSync(new URL('../app-public/sw.js', import.meta.url), 'utf8');
  const m = /const WORKER_PATHS = \/(.+)\/;/.exec(sw);
  assert.ok(m, 'WORKER_PATHS is where the service worker says it is');
  const WORKER_PATHS = new RegExp(m[1]);
  for (const path of ['/esim', '/esim/th', '/esim/airport/bkk', '/esim/region/eu', '/esim/find', '/esim/sitemap.xml', '/esim/pay/tok_abcdefghijklmnop', '/esim/o/tok_abcdefghijklmnop']) {
    assert.ok(workerFirst(path), `${path} is not in run_worker_first: the asset layer would serve the app shell`);
    assert.ok(WORKER_PATHS.test(path), `${path} is not in the service worker's WORKER_PATHS: installed users would get the shell or a network error`);
  }
  assert.equal(workerFirst('/esimx'), false);
});
