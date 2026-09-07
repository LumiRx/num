// Delivery from a NUM partner, in the app, with every gate pinned: licence on
// file, inside the radius, priced items only, age-restricted partners only to
// verified members, never to a hosted member, never advertised, ordered only
// after a yes, accepted only by a human, commission on the goods on delivery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  deliverySettings, saveDelivery, orderable, partnersNear, allowedFor, deliveryBlock,
  createOrder, ordersFor, decideOrder, memberOrders, handleDelivery, ORDER_NEXT, jurisdictionOf,
} from './delivery.mjs';

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
    batch: async (stmts) => { for (const s of stmts) await s.run(); return []; },
  };
}
const DTLA = { lat: 34.0443, lng: -118.2507, dest: 'los-angeles' };
function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, category TEXT, status TEXT DEFAULT 'active')`);
  db.exec(`CREATE TABLE num_business_settings (business_id TEXT PRIMARY KEY, f_delivery INTEGER DEFAULT 0, delivery_fee_cs INTEGER DEFAULT 500, delivery_radius_m INTEGER DEFAULT 5000, commission_bp INTEGER DEFAULT 1000, updated_at INTEGER, updated_by TEXT)`);
  db.exec(`CREATE TABLE num_business_profiles (business_id TEXT PRIMARY KEY, custom_fields TEXT DEFAULT '{}', city TEXT, area TEXT, lat REAL, lng REAL, timezone TEXT, updated_at INTEGER)`);
  db.exec(`CREATE TABLE num_place_owners (place_id TEXT PRIMARY KEY, business_id TEXT, revoked_at TEXT)`);
  db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, lat REAL, lng REAL, dest TEXT)`);
  db.exec(`CREATE TABLE num_business_offerings (id TEXT PRIMARY KEY, business_id TEXT, place_id TEXT, section TEXT, name TEXT, description TEXT, price_minor INTEGER, price_note TEXT, currency TEXT, unit TEXT DEFAULT 'item', available TEXT, position INTEGER DEFAULT 0, active INTEGER DEFAULT 1)`);
  db.exec(`CREATE TABLE num_members (id TEXT PRIMARY KEY, identity_verified INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE num_orders (id TEXT PRIMARY KEY, short_code TEXT UNIQUE, business_id TEXT, member_ref TEXT, subtotal_cs INTEGER, delivery_fee_cs INTEGER, platform_fee_cs INTEGER, total_cs INTEGER, commission_cs INTEGER, fulfilment TEXT, delivery_addr_enc TEXT, delivery_area TEXT, status TEXT, channel TEXT, created_at INTEGER, accepted_at INTEGER, delivered_at INTEGER, CHECK (total_cs = subtotal_cs + delivery_fee_cs + platform_fee_cs))`);
  db.exec(`CREATE TABLE num_order_items (id TEXT PRIMARY KEY, order_id TEXT, item_id TEXT, name TEXT, qty INTEGER, unit TEXT, unit_price_cs INTEGER, line_total_cs INTEGER, created_at INTEGER)`);
  db.exec(`CREATE TABLE num_order_events (id TEXT PRIMARY KEY, order_id TEXT, from_status TEXT, to_status TEXT, actor TEXT, reason TEXT, metadata TEXT, created_at INTEGER)`);
  db.exec(`CREATE TABLE num_notifications (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, url TEXT, tag TEXT, created_at TEXT DEFAULT (datetime('now')), delivered_at TEXT, read_at TEXT)`);
  db.exec(`CREATE TABLE num_push_subs (member_id TEXT, endpoint TEXT, fails INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE num_business_notify (business_id TEXT PRIMARY KEY, email TEXT, on_booking INTEGER, on_weekly INTEGER, last_weekly TEXT)`);
  db.exec(`CREATE TABLE num_business_users (business_id TEXT, email TEXT, status TEXT, created_at INTEGER)`);
  // LA Cannabis Club: licensed, 21+, downtown, delivers 8 km.
  db.exec(`INSERT INTO businesses VALUES ('biz_lacc','LA Cannabis Club','Cannabis Delivery','active')`);
  db.exec(`INSERT INTO num_business_settings (business_id,f_delivery,delivery_fee_cs,delivery_radius_m,commission_bp) VALUES ('biz_lacc',1,700,8000,1000)`);
  db.exec(`INSERT INTO num_business_profiles (business_id,custom_fields) VALUES ('biz_lacc','{"licence":"C9-0000123-LIC","age_min":21,"delivery_hours":"10:00-21:00"}')`);
  db.exec(`INSERT INTO num_place_owners VALUES ('p_lacc','biz_lacc',NULL)`);
  db.exec(`INSERT INTO places VALUES ('p_lacc','LA Cannabis Club',34.0443,-118.2507,'los-angeles')`);
  db.exec(`INSERT INTO num_business_offerings (id,business_id,place_id,section,name,description,price_minor,currency,unit,position) VALUES
    ('of_1','biz_lacc','p_lacc','Flower','Eighth — Blue Dream','3.5 g',4500,'USD','item',1),
    ('of_2','biz_lacc','p_lacc','Edibles','Gummies 10-pack','100 mg total',2200,'USD','item',2),
    ('of_3','biz_lacc','p_lacc','Flower','Market-price ounce','ask',NULL,'USD','item',3)`);
  // A flower shop with no licence on file, and a bakery too far away.
  db.exec(`INSERT INTO businesses VALUES ('biz_flo','Downtown Flowers','Florist','active'),('biz_far','Far Bakery','Bakery','active')`);
  db.exec(`INSERT INTO num_business_settings (business_id,f_delivery,delivery_fee_cs,delivery_radius_m) VALUES ('biz_flo',1,300,5000),('biz_far',1,300,3000)`);
  db.exec(`INSERT INTO num_business_profiles (business_id,custom_fields,lat,lng) VALUES ('biz_flo','{}',34.045,-118.25),('biz_far','{"licence":"n/a"}',34.20,-118.60)`);
  db.exec(`INSERT INTO num_business_offerings (id,business_id,place_id,name,price_minor,currency) VALUES ('of_f','biz_flo','p_flo','Roses',6500,'USD'),('of_b','biz_far','p_far','Sourdough',900,'USD')`);
  db.exec(`INSERT INTO num_members VALUES ('mem_v',1),('mem_u',0)`);
  return { DB: d1(db), _db: db };
}

test('the module refuses Ghost for this: the reason is written where the next person will read it', () => {
  const src = readFileSync(new URL('./delivery.mjs', import.meta.url), 'utf8');
  assert.match(src, /carriers prohibit cannabis-related/i);
  assert.match(src, /REJECTS "cannabis and derivatives/);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), /twilio|sendText|smsPartner/i, 'no text message in the loop, ever');
});

test('delivery cannot be switched on without a licence number; settings round-trip', async () => {
  const env = fresh();
  env._db.exec(`INSERT INTO businesses VALUES ('biz_new','New Shop','Shop','active')`);
  env._db.exec(`INSERT INTO num_business_settings (business_id) VALUES ('biz_new')`);
  env._db.exec(`INSERT INTO num_business_profiles (business_id) VALUES ('biz_new')`);
  const no = await saveDelivery(env, 'biz_new', { on: true, fee_cs: 500, radius_m: 4000, licence: '', age_min: 0 });
  assert.equal(no.ok, false); assert.match(no.error, /licence number is needed/);
  assert.equal((await saveDelivery(env, 'biz_new', { on: true, fee_cs: 650, radius_m: 4000, licence: 'ABC-1', age_min: 21, hours: '9-5' })).ok, true);
  const s = await deliverySettings(env, 'biz_new');
  assert.equal(s.on, true); assert.equal(s.fee_cs, 650); assert.equal(s.radius_m, 4000); assert.equal(s.licence, 'ABC-1'); assert.equal(s.age_min, 21); assert.equal(s.hours, '9-5');
  assert.equal((await saveDelivery(env, 'biz_new', { on: false, fee_cs: 0, radius_m: 100, licence: '', age_min: 99 })).ok, true, 'switching off never needs a licence');
  const off = await deliverySettings(env, 'biz_new');
  assert.equal(off.on, false); assert.equal(off.radius_m, 500, 'radius floor'); assert.equal(off.age_min, 0, 'a nonsense age is not an age gate');
});

test('only priced, active offerings are orderable — "market price" is read out, never sold', async () => {
  const env = fresh();
  const items = await orderable(env, 'biz_lacc');
  assert.deepEqual(items.map((i) => i.name), ['Eighth — Blue Dream', 'Gummies 10-pack']);
  assert.equal(items[0].price_cs, 4500); assert.equal(items[0].category, 'Flower');
});

test('partners near a point: inside the radius, licensed, with something priced — nothing else', async () => {
  const env = fresh();
  const near = await partnersNear(env, DTLA);
  assert.deepEqual(near.map((p) => p.name), ['LA Cannabis Club'], 'the florist has no licence on file; the bakery is out of range');
  assert.equal(near[0].age_min, 21); assert.equal(near[0].fee_cs, 700); assert.ok(near[0].km < 0.1); assert.equal(near[0].items.length, 2);
  assert.deepEqual(await partnersNear(env, { lat: 34.30, lng: -118.70, dest: 'los-angeles' }), [], 'ten kilometres out of every radius');
  assert.deepEqual(await partnersNear(env, { lat: NaN, lng: 1, dest: 'los-angeles' }), [], 'no coordinate, no partners — never a city-wide guess');
  // 6 Sep 2026: the jurisdiction gate. A licence is good where it is good.
  assert.deepEqual(await partnersNear(env, { ...DTLA, dest: 'miami' }), [], 'a California licence must never reach Florida');
  assert.deepEqual(await partnersNear(env, { ...DTLA, dest: 'bangkok' }), [], 'nor Thailand');
  assert.deepEqual(await partnersNear(env, { lat: DTLA.lat, lng: DTLA.lng }), [], 'no destination, no offer');
});

// 7 Sep 2026. Dre: "their business address is different from operations. they
// operating in los angeles and kansas."
//
// That is why "608 S Main Street" geocoded to Winfield, Kansas and looked
// wrong — the address was real, it just named two places. LA Cannabis Club
// genuinely trades in both.
//
// It changes nothing about what Num may offer, and this test is here so that
// stays true when somebody later adds a Kansas destination for the ordinary,
// correct reason that Num should cover more of America. Kansas has no legal
// adult-use or medical cannabis market, and a California DCC licence is good
// in California. Whatever LA Cannabis Club does in Kansas, Num carries none of
// it as cannabis delivery.
test('a partner operating in two states is only offered in the one that licensed them', async () => {
  const env = fresh();
  const kansas = { lat: 37.2390, lng: -96.9997, dest: 'wichita' };

  assert.deepEqual(await partnersNear(env, kansas), [],
    'a Kansas guest was offered cannabis delivery on a California licence');

  // And not by standing in the shop either: the gate is where the GUEST is.
  assert.deepEqual(await partnersNear(env, { ...DTLA, dest: 'wichita' }), [],
    'the destination is the guest, not the partner');

  assert.equal(jurisdictionOf('wichita'), null,
    'a Kansas slug has acquired a cannabis jurisdiction — it must not have one');
  assert.equal(jurisdictionOf('kansas-city'), null);

  // The California entry must not quietly grow non-California slugs.
  const ca = jurisdictionOf('los-angeles');
  assert.equal(ca.code, 'US-CA');
  assert.ok(ca.slugs.every((slug) => !/kansas|wichita|topeka/.test(slug)),
    'a non-California destination is listed under the California licence');
});

test('the member gate: verified only for 21+, never a hosted member', () => {
  const partners = [{ name: 'LA Cannabis Club', age_min: 21 }, { name: 'Bakery', age_min: 0 }];
  assert.deepEqual(allowedFor(partners, { member: { identity_verified: 1 }, hasHost: false }).map((p) => p.name), ['LA Cannabis Club', 'Bakery']);
  assert.deepEqual(allowedFor(partners, { member: { identity_verified: 0 }, hasHost: false }).map((p) => p.name), ['Bakery']);
  assert.deepEqual(allowedFor(partners, { member: null, hasHost: false }).map((p) => p.name), ['Bakery'], 'no member id: nothing age-restricted');
  assert.deepEqual(allowedFor(partners, { member: { identity_verified: 1 }, hasHost: true }), [], 'a hosted member\'s host handles it');
});

test('the prompt block lists items with exact prices, says 21+ and ID at the door, and forbids volunteering it', async () => {
  const env = fresh();
  const block = deliveryBlock(await partnersNear(env, DTLA));
  assert.match(block, /^DELIVERY PARTNERS/);
  assert.match(block, /offer ONLY when the guest asks/);
  assert.match(block, /LA Cannabis Club \[business_id biz_lacc\]/);
  assert.match(block, /delivery fee \$7\.00/);
  // Reworded 6 Sep 2026 so the licence number rides with the age gate, and the
  // brain is told in the same breath that it may not move goods between places.
  assert.match(block, /21\+ only, ID checked at the door by the licensed retailer \(licence C9-0000123-LIC\)/);
  assert.match(block, /licensed where this guest is/);
  assert.match(block, /never discuss carrying anything between cities or states/);
  assert.match(block, /\[item_id of_1\] Eighth — Blue Dream — \$45\.00 per item/);
  assert.match(block, /request_delivery action with confirmed:true/);
  assert.match(block, /Never say it is on its way/);
  assert.equal(deliveryBlock([]), '');
});

test('an order snapshots catalogue prices (never the model\'s), adds the fee, and lands pending_business', async () => {
  const env = fresh();
  const out = await createOrder(env, { businessId: 'biz_lacc', memberId: 'mem_v', items: [{ item_id: 'of_1', qty: 2 }, { item_id: 'of_2', qty: 1 }, { item_id: 'of_3', qty: 1 }, { item_id: 'nope', qty: 1 }], address: '700 W 7th St, Los Angeles, CA 90017', note: 'ring the buzzer' });
  assert.equal(out.ok, true);
  assert.equal(out.subtotal_cs, 2 * 4500 + 2200); assert.equal(out.fee_cs, 700); assert.equal(out.total_cs, 11200 + 700);
  assert.deepEqual(out.items, [{ name: 'Eighth — Blue Dream', qty: 2 }, { name: 'Gummies 10-pack', qty: 1 }], 'the unpriced item and the unknown id are dropped, not guessed');
  const o = env._db.prepare('SELECT * FROM num_orders').get();
  assert.equal(o.status, 'pending_business'); assert.equal(o.member_ref, 'mem_v'); assert.equal(o.platform_fee_cs, 0); assert.equal(o.commission_cs, 0, 'nothing is owed until it is delivered');
  assert.match(o.delivery_area, /Los Angeles/);
  assert.equal(env._db.prepare('SELECT COUNT(*) n FROM num_order_items').get().n, 2);
  assert.equal(env._db.prepare("SELECT reason FROM num_order_events").get().reason, 'ring the buzzer');
  const note = env._db.prepare("SELECT * FROM num_notifications WHERE member_id='mem_v'").get();
  assert.match(note.title, /Order [A-Z]\d{3} sent to LA Cannabis Club/); assert.match(note.body, /You'll hear the moment they accept/);
});

test('an unverified member cannot order from a 21+ partner; an address is required; a paused partner refuses', async () => {
  const env = fresh();
  let out = await createOrder(env, { businessId: 'biz_lacc', memberId: 'mem_u', items: [{ item_id: 'of_1', qty: 1 }], address: 'x' });
  assert.equal(out.ok, false); assert.match(out.error, /21\+ only/);
  out = await createOrder(env, { businessId: 'biz_lacc', memberId: 'mem_v', items: [{ item_id: 'of_1', qty: 1 }], address: '' });
  assert.equal(out.ok, false); assert.match(out.error, /address/);
  env._db.prepare('UPDATE num_business_settings SET f_delivery=0 WHERE business_id=?').run('biz_lacc');
  out = await createOrder(env, { businessId: 'biz_lacc', memberId: 'mem_v', items: [{ item_id: 'of_1', qty: 1 }], address: 'x' });
  assert.equal(out.ok, false); assert.match(out.error, /not taking delivery orders/);
  assert.equal(env._db.prepare('SELECT COUNT(*) n FROM num_orders').get().n, 0);
});

test('the partner moves the order along; illegal moves are refused; the member hears each step; commission lands on delivery, on the goods only', async () => {
  const env = fresh();
  const { id } = await createOrder(env, { businessId: 'biz_lacc', memberId: 'mem_v', items: [{ item_id: 'of_1', qty: 1 }], address: '700 W 7th St' });
  assert.equal((await decideOrder(env, { businessId: 'biz_other', orderId: id, status: 'accepted' })).ok, false, 'not your order');
  assert.equal((await decideOrder(env, { businessId: 'biz_lacc', orderId: id, status: 'delivered' })).ok, false, 'pending cannot jump to delivered');
  assert.equal((await decideOrder(env, { businessId: 'biz_lacc', orderId: id, status: 'accepted' })).ok, true);
  assert.equal((await decideOrder(env, { businessId: 'biz_lacc', orderId: id, status: 'out_for_delivery' })).ok, true);
  assert.equal((await decideOrder(env, { businessId: 'biz_lacc', orderId: id, status: 'delivered' })).ok, true);
  const o = env._db.prepare('SELECT * FROM num_orders WHERE id=?').get(id);
  assert.equal(o.status, 'delivered'); assert.ok(o.accepted_at); assert.ok(o.delivered_at);
  assert.equal(o.commission_cs, 450, '10% of the $45 eighth — not of the delivery fee');
  const notes = env._db.prepare("SELECT body FROM num_notifications WHERE member_id='mem_v' ORDER BY rowid").all().map((n) => n.body);
  assert.equal(notes.length, 4);
  assert.match(notes[1], /accepted order/); assert.match(notes[2], /on its way.*ID ready/); assert.match(notes[3], /was delivered/);
  assert.equal(env._db.prepare('SELECT COUNT(*) n FROM num_order_events').get().n, 4);
  assert.deepEqual(ORDER_NEXT.delivered, ['refunded']);
  const list = await ordersFor(env, 'biz_lacc');
  assert.equal(list.length, 1); assert.match(list[0].items, /1 × Eighth — Blue Dream/);
  const mine = await memberOrders(env, 'mem_v');
  assert.equal(mine[0].partner, 'LA Cannabis Club'); assert.equal(mine[0].status, 'delivered');
});

test('HTTP: /near is coarse and hides an age-restricted partner\'s items; /request and /mine work', async () => {
  const env = fresh();
  const near = await handleDelivery(new Request(`https://app.itsnum.com/api/delivery/near?lat=${DTLA.lat}&lng=${DTLA.lng}&dest=los-angeles`), env, new URL(`https://app.itsnum.com/api/delivery/near?lat=${DTLA.lat}&lng=${DTLA.lng}&dest=los-angeles`));
  const j = await near.json();
  assert.equal(j.partners[0].name, 'LA Cannabis Club'); assert.equal(j.partners[0].items, undefined, 'no menu to an unverified caller');
  const req = new Request('https://app.itsnum.com/api/delivery/request', { method: 'POST', body: JSON.stringify({ me: 'mem_v', business_id: 'biz_lacc', items: [{ item_id: 'of_2', qty: 3 }], address: '700 W 7th St, LA' }) });
  const r = await handleDelivery(req, env, new URL(req.url));
  assert.equal(r.status, 200); const body = await r.json(); assert.equal(body.total_cs, 6600 + 700);
  const mine = await (await handleDelivery(new Request('https://app.itsnum.com/api/delivery/mine?me=mem_v'), env, new URL('https://app.itsnum.com/api/delivery/mine?me=mem_v'))).json();
  assert.equal(mine.orders.length, 1);
});
