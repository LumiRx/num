import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './esimtestdb.mjs';
import { handleEsimText, isEsimKeyword } from './esimtext.mjs';
import { refreshCatalogue } from './esimstore.mjs';
import * as O from './esimorders.mjs';

const SCHEMA = ['worker/migrations/0064_esim.sql'];
const FROM = '+14155550100';
const mk = (code, c, mb, days, cost) => ({ provider: 'esimaccess', code, name: code, costUnits: cost * 100, costCs: cost, retailCs: null, dataMb: mb, unlimited: false, daily: false, days, activateWithinDays: 180, countries: c, scope: c.length <= 1 ? 'local' : 'regional', topup: false, networks: [] });
const CATALOGUE = [
  mk('TH3', ['TH'], 3072, 7, 150), mk('TH10', ['TH'], 10240, 30, 400), mk('TH20', ['TH'], 20480, 30, 700),
  mk('EU10', ['FR', 'DE', 'IT', 'ES', 'NL', 'BE', 'PT'], 10240, 30, 800),
  ...Array.from({ length: 20 }, (_, i) => mk(`JP${i}`, ['JP'], 1024 * (i + 1), 30, 100 + i * 10)),
];

async function setup() {
  const db = d1(SCHEMA);
  await refreshCatalogue(db, [{ id: 'esimaccess', ready: () => true, packages: async () => ({ ok: true, plans: CATALOGUE }) }]);
  const consents = [];
  const deps = { origin: 'https://app.itsnum.com', recordConsent: async (p, s) => consents.push([p, s]) };
  return { db, deps, consents };
}
const say = (db, deps, body, channel) => handleEsimText({}, db, { from: FROM, body, channel }, deps);

test('keyword detection', () => {
  for (const t of ['ESIM', 'esim thailand', 'e-sim bkk', 'E SIM', 'eSIMs']) assert.equal(isEsimKeyword(t), true, t);
  for (const t of ['hello', 'my esim is not working', '', 'sim']) assert.equal(isEsimKeyword(t), false, t);
});

test('ESIM BKK -> menu -> 2 -> pay link for the plan they picked, at the listed price', async () => {
  const { db, deps, consents } = await setup();
  const a = await say(db, deps, 'ESIM BKK');
  assert.equal(a.handled, true);
  assert.match(a.reply, /^Num: Thailand eSIM, data only/);
  assert.match(a.reply, /1\) 3GB, 7 days/);
  assert.deepEqual(consents, [[FROM, 'inbound:ESIM:sms']]);

  const b = await say(db, deps, '2');
  assert.equal(b.handled, true);
  assert.match(b.reply, /Pay here \(Apple Pay works\): https:\/\/app\.itsnum\.com\/esim\/pay\/[A-Za-z0-9_-]{24}/);
  const o = await O.getById(db, b.orderId);
  assert.equal(o.plan_code, 'TH10');
  assert.equal(o.airport, 'BKK');
  assert.equal(o.country, 'TH');
  assert.equal(o.channel, 'sms');
  assert.equal(o.phone, FROM);
  assert.match(b.reply, new RegExp(`\\$${(o.price_cs / 100).toFixed(2)}`));
  assert.equal(await O.getMenu(db, FROM), null, 'menu cleared after a pick');
});

test('ESIM with no destination asks, and the next message answers it', async () => {
  const { db, deps } = await setup();
  const a = await say(db, deps, 'ESIM');
  assert.match(a.reply, /where are you headed/);
  const b = await say(db, deps, 'Japan');
  assert.match(b.reply, /^Num: Japan eSIM/);
});

test('an unrelated reply while a question is open goes to the concierge', async () => {
  const { db, deps } = await setup();
  await say(db, deps, 'ESIM');
  const b = await say(db, deps, 'actually can you book me dinner');
  assert.equal(b.handled, false);
});

test('text that is not about an eSIM is never swallowed', async () => {
  const { db, deps } = await setup();
  assert.equal((await say(db, deps, 'what is good to eat near me')).handled, false);
  assert.equal((await say(db, deps, '2')).handled, false, 'a digit with no open menu is the concierge\'s');
});

test('regions get multi-country plans', async () => {
  const { db, deps } = await setup();
  const a = await say(db, deps, 'esim europe');
  assert.match(a.reply, /^Num: Europe eSIM/);
});

test('no plan for a place: honest answer, concierge offer', async () => {
  const { db, deps } = await setup();
  const a = await say(db, deps, 'esim nauru');
  assert.match(a.reply, /don't have an eSIM for Nauru yet/);
});

test('out-of-range pick is corrected, not guessed', async () => {
  const { db, deps } = await setup();
  await say(db, deps, 'esim thailand');
  const b = await say(db, deps, '7');
  assert.match(b.reply, /reply a number from 1 to 3/);
});

test('sales paused (e.g. supplier balance empty) says so and takes no order', async () => {
  const { db, deps } = await setup();
  const r = await handleEsimText({}, db, { from: FROM, body: 'esim thailand' }, { ...deps, salesOpen: async () => false });
  assert.match(r.reply, /paused/);
});

test('a number that already bought three today is paused', async () => {
  const { db, deps } = await setup();
  for (let i = 0; i < 3; i++) {
    await say(db, deps, 'esim thailand');
    const r = await say(db, deps, '1');
    await O.markPaid(db, r.orderId, { paidCs: 1 });
  }
  await say(db, deps, 'esim thailand');
  const r = await say(db, deps, '1');
  assert.match(r.reply, /paused new orders on this number/);
});

test('WhatsApp works the same way', async () => {
  const { db, deps, consents } = await setup();
  await handleEsimText({}, db, { from: FROM, body: 'esim japan', channel: 'whatsapp' }, deps);
  const r = await handleEsimText({}, db, { from: FROM, body: '1', channel: 'whatsapp' }, deps);
  assert.equal((await O.getById(db, r.orderId)).channel, 'whatsapp');
  assert.deepEqual(consents[0], [FROM, 'inbound:ESIM:whatsapp']);
});

test('ignores senders that are not phone numbers', async () => {
  const { db, deps } = await setup();
  assert.equal((await handleEsimText({}, db, { from: 'whatsapp:bad', body: 'esim' }, deps)).handled, false);
});
