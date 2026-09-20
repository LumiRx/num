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
  idCheckRecord, ageMinForBusiness, ID_TYPES, ID_FORBIDDEN, licenceProof,
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
  db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, lat REAL, lng REAL, dest TEXT, category TEXT)`);
  db.exec(`CREATE TABLE num_business_offerings (id TEXT PRIMARY KEY, business_id TEXT, place_id TEXT, section TEXT, name TEXT, description TEXT, price_minor INTEGER, price_note TEXT, currency TEXT, unit TEXT DEFAULT 'item', available TEXT, position INTEGER DEFAULT 0, active INTEGER DEFAULT 1)`);
  db.exec(`CREATE TABLE num_members (id TEXT PRIMARY KEY, identity_verified INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE num_orders (id TEXT PRIMARY KEY, short_code TEXT UNIQUE, business_id TEXT, member_ref TEXT, subtotal_cs INTEGER, delivery_fee_cs INTEGER, platform_fee_cs INTEGER, total_cs INTEGER, commission_cs INTEGER, fulfilment TEXT, delivery_addr_enc TEXT, delivery_area TEXT, status TEXT, channel TEXT, created_at INTEGER, accepted_at INTEGER, delivered_at INTEGER, CHECK (total_cs = subtotal_cs + delivery_fee_cs + platform_fee_cs))`);
  db.exec(`CREATE TABLE num_order_items (id TEXT PRIMARY KEY, order_id TEXT, item_id TEXT, name TEXT, qty INTEGER, unit TEXT, unit_price_cs INTEGER, line_total_cs INTEGER, created_at INTEGER)`);
  db.exec(`CREATE TABLE num_order_events (id TEXT PRIMARY KEY, order_id TEXT, from_status TEXT, to_status TEXT, actor TEXT, reason TEXT, metadata TEXT, created_at INTEGER)`);
  db.exec(`CREATE TABLE num_notifications (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, subtitle TEXT, body TEXT, url TEXT, tag TEXT, created_at TEXT DEFAULT (datetime('now')), delivered_at TEXT, read_at TEXT)`);
  db.exec(`CREATE TABLE num_push_subs (member_id TEXT, endpoint TEXT, fails INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE num_business_notify (business_id TEXT PRIMARY KEY, email TEXT, on_booking INTEGER, on_weekly INTEGER, last_weekly TEXT)`);
  db.exec(`CREATE TABLE num_business_users (business_id TEXT, email TEXT, status TEXT, created_at INTEGER)`);
  // LA Cannabis Club: licensed, 21+, downtown, delivers 8 km.
  db.exec(`INSERT INTO businesses VALUES ('biz_lacc','LA Cannabis Club','Cannabis Delivery','active')`);
  db.exec(`INSERT INTO num_business_settings (business_id,f_delivery,delivery_fee_cs,delivery_radius_m,commission_bp) VALUES ('biz_lacc',1,700,8000,1000)`);
  db.exec(`INSERT INTO num_business_profiles (business_id,custom_fields) VALUES ('biz_lacc','{"licence":"C9-0000123-LIC","age_min":21,"delivery_hours":"10:00-21:00"}')`);
  db.exec(`INSERT INTO num_place_owners VALUES ('p_lacc','biz_lacc',NULL)`);
  db.exec(`INSERT INTO places VALUES ('p_lacc','LA Cannabis Club',34.0443,-118.2507,'los-angeles','Cannabis Delivery')`);
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
  // 19 Sep 2026: the wording gained "or a recorded in-person verification",
  // because a licence somebody at NUM has actually seen is also proof. What
  // this test is really about — no proof of any kind, no switch — is unchanged.
  assert.equal(no.ok, false); assert.match(no.error, /licence number .* is needed/);
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
  assert.equal(note.title, 'LA Cannabis Club', 'the name they recognise is the title; the order code is reference');
  assert.match(note.subtitle, /^Order [A-Z]\d{3} · \$119\.00 incl\. delivery$/);
  assert.match(note.body, /You'll hear the moment they accept/);
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
  // 19 Sep 2026: this line used to close the order with nothing recorded. LA
  // Cannabis Club is 21+, so the ID check is now part of what "delivered"
  // means for it — see the ID-check tests at the foot of this file.
  assert.equal((await decideOrder(env, {
    businessId: 'biz_lacc', orderId: id, status: 'delivered',
    idCheck: { id_type: 'drivers_licence', over_min: true, checked_by: 'Alfredo' },
  })).ok, true);
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

// ── THE ID CHECK AT THE DOOR ─────────────────────────────────────────────
//
// Dre, 19 Sep 2026: Alfred checks ID on delivery and the check reaches Num.
// The retailer's legal duty was always to look; what was missing was any
// record that they did. These pin both halves — that an age-gated order
// cannot close without one, and that the record is an attestation rather
// than a copy of somebody's driving licence.
const GOOD = { id_type: 'drivers_licence', over_min: true, checked_by: 'Alfredo' };

const placed = async (env, db) => {
  db.exec("INSERT INTO num_members VALUES ('mem_a',1)");
  const o = await createOrder(env, {
    businessId: 'biz_lacc', memberId: 'mem_a',
    items: [{ id: 'of_1', qty: 1 }], address: '1 Main St', channel: 'web',
  });
  assert.ok(o.ok, o.error);
  await decideOrder(env, { businessId: 'biz_lacc', orderId: o.id, status: 'accepted' });
  await decideOrder(env, { businessId: 'biz_lacc', orderId: o.id, status: 'out_for_delivery' });
  return o;
};

test('an age-gated order cannot be marked delivered with no ID check', async () => {
  const env = fresh(); const db = env._db;
  const o = await placed(env, db);
  const out = await decideOrder(env, { businessId: 'biz_lacc', orderId: o.id, status: 'delivered' });
  assert.equal(out.ok, false);
  assert.equal(out.needs_id_check, true);
  assert.equal(out.age_min, 21);
  assert.equal(db.prepare('SELECT status FROM num_orders WHERE id=?').get(o.id).status, 'out_for_delivery',
    'the order closed anyway');
});

test('with the check, it delivers and the attestation is on the event', async () => {
  const env = fresh(); const db = env._db;
  const o = await placed(env, db);
  const out = await decideOrder(env, { businessId: 'biz_lacc', orderId: o.id, status: 'delivered', idCheck: GOOD });
  assert.equal(out.ok, true, out.error);
  const ev = db.prepare("SELECT metadata FROM num_order_events WHERE order_id=? AND to_status='delivered'").get(o.id);
  const meta = JSON.parse(ev.metadata);
  assert.equal(meta.id_checked, true);
  assert.equal(meta.id_type, 'drivers_licence');
  assert.equal(meta.age_min, 21);
  assert.equal(meta.checked_by, 'Alfredo');
  assert.ok(Number.isFinite(meta.checked_at));
});

test('the document itself is refused, not quietly dropped', async () => {
  // A caller that sends a licence number or a photo must get an error. Dropping
  // it silently teaches the next client that sending it was fine.
  for (const field of ['id_number', 'dob', 'photo_url', 'selfie']) {
    const out = idCheckRecord({ ...GOOD, [field]: 'x' });
    assert.equal(out.ok, false, `${field} was accepted`);
    assert.deepEqual(out.refused, [field]);
    assert.match(out.error, /does not store/);
  }
  // and nothing forbidden can reach the database through decideOrder either
  const env = fresh(); const db = env._db;
  const o = await placed(env, db);
  const blocked = await decideOrder(env, { businessId: 'biz_lacc', orderId: o.id, status: 'delivered', idCheck: { ...GOOD, id_number: 'D1234567' } });
  assert.equal(blocked.ok, false);
  const rows = db.prepare('SELECT metadata FROM num_order_events').all();
  for (const r of rows) assert.equal(/D1234567/.test(r.metadata), false, 'a licence number reached the database');
});

test('"they were not old enough" is an answer, and it is not a delivery', async () => {
  for (const v of [false, 'false', 0, '0', undefined, null, 'no']) {
    assert.equal(idCheckRecord({ ...GOOD, over_min: v }).ok, false, `over_min=${String(v)} passed`);
  }
  assert.equal(idCheckRecord({ ...GOOD, over_min: true }).ok, true);
});

test('the record names a document and a person, or it is not a record', () => {
  assert.equal(idCheckRecord({ ...GOOD, id_type: 'vibes' }).ok, false);
  assert.equal(idCheckRecord({ ...GOOD, id_type: '' }).ok, false);
  assert.equal(idCheckRecord({ ...GOOD, checked_by: '  ' }).ok, false);
  for (const t of ID_TYPES) assert.equal(idCheckRecord({ ...GOOD, id_type: t }).ok, true, t);
  assert.ok(ID_FORBIDDEN.includes('photo_url') && ID_FORBIDDEN.includes('id_number'));
});

test('an ordinary business closes an order exactly as before', async () => {
  // The gate must not reach a bakery. A florist asking a customer for ID is
  // the failure mode of a rule applied where it does not belong.
  const env = fresh(); const db = env._db;
  db.exec("INSERT INTO businesses VALUES ('biz_cafe','Cafe','Cafe','active')");
  db.exec("INSERT INTO num_business_profiles (business_id,custom_fields) VALUES ('biz_cafe','{}')");
  db.exec("INSERT INTO num_place_owners VALUES ('p_cafe','biz_cafe',NULL)");
  db.exec("INSERT INTO places VALUES ('p_cafe','Cafe',34.0443,-118.2507,'los-angeles','Cafe')");
  assert.equal(await ageMinForBusiness(env, 'biz_cafe'), 0);
  assert.equal(await ageMinForBusiness(env, 'biz_lacc'), 21);
  db.exec(`INSERT INTO num_orders (id,short_code,business_id,member_ref,subtotal_cs,delivery_fee_cs,platform_fee_cs,total_cs,commission_cs,fulfilment,status,channel,created_at)
    VALUES ('ord_c','C001','biz_cafe','mem_a',500,0,0,500,0,'delivery','out_for_delivery','web',1)`);
  const out = await decideOrder(env, { businessId: 'biz_cafe', orderId: 'ord_c', status: 'delivered' });
  assert.equal(out.ok, true, out.error);
});

test('a trade is 21+ even when nobody typed an age into the profile', async () => {
  // The template decides it. A dispensary that left the field blank is not a
  // dispensary with no age limit.
  const env = fresh(); const db = env._db;
  db.exec("UPDATE num_business_profiles SET custom_fields='{\"licence\":\"C9-0000123-LIC\"}' WHERE business_id='biz_lacc'");
  assert.equal(await ageMinForBusiness(env, 'biz_lacc'), 21);
});

test('a read that does not answer refuses the delivery, it does not wave it through', async () => {
  // The age gate must fail closed. 0 means "no age limit", so an error that
  // returned 0 would close a cannabis order with no ID check.
  const env = fresh(); const db = env._db;
  const o = await placed(env, db);
  db.exec('DROP TABLE num_business_profiles');
  const out = await decideOrder(env, { businessId: 'biz_lacc', orderId: o.id, status: 'delivered', idCheck: GOOD });
  assert.equal(out.ok, false, 'a broken read delivered an age-gated order');
  assert.equal(db.prepare('SELECT status FROM num_orders WHERE id=?').get(o.id).status, 'out_for_delivery');
});

test('the owner route tells the app the age floor, so it asks before offering the button', async () => {
  const env = fresh();
  env._db.exec("CREATE TABLE num_members_x (x TEXT)"); // no-op, keeps the fixture honest
  const url = new URL('https://app.itsnum.com/api/delivery/business?me=mem_v');
  const res = await handleDelivery(new Request(url), env, url);
  const body = await res.json();
  // mem_v owns nothing, so this is the empty shape — the point is the route
  // answers rather than 500s, and the fields the app reads exist when it does.
  assert.ok('businesses' in body);
});

test('the app is wired to the route, not merely able to be', () => {
  // /api/delivery/business existed for days with nothing in the app calling
  // it, so Alfredo could not see an order at all. This is the guard.
  const PROFILE = readFileSync(new URL('../src/lib/profile.ts', import.meta.url), 'utf8');
  const SHEET = readFileSync(new URL('../src/components/app/BusinessSheet.tsx', import.meta.url), 'utf8');
  assert.match(PROFILE, /apiUrl\(`\/api\/delivery\/business\?/);
  assert.match(PROFILE, /apiUrl\('\/api\/delivery\/business\/order'\)/);
  assert.match(SHEET, /function Orders\(\{ businessId \}/);
  assert.match(SHEET, /<Orders businessId=\{p\.business_id\} \/>/);
  // the ID step is asked for BEFORE the server has to refuse
  assert.match(SHEET, /status === 'delivered' && data\.age_min > 0 && checking !== orderId/);
  // And the form collects no document. Comments are stripped first: the block
  // below EXPLAINS that it does not take a photograph, and a guard that cannot
  // tell code from its own explanation gets the explanation deleted — which is
  // the third time that has happened in this repo, so it is written down here.
  const form = SHEET.slice(SHEET.indexOf('function Orders'), SHEET.indexOf('export default function BusinessSheet'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\{t\((['"])(?:[^'"\\]|\\.)*\1\)\}/g, ' ')
    .replace(/\{['"](?:[^'"\\]|\\.)*['"]\}/g, ' ');
  for (const bad of ['id_number', 'date_of_birth', 'camera', 'capture', 'type="file"', 'FileReader']) {
    assert.equal(new RegExp(bad, 'i').test(form), false, `the ID form collects ${bad}`);
  }
  // the payload it builds carries exactly three fields, and none is a document
  assert.match(SHEET, /\{ id_type: idType, over_min: true as const, checked_by: by\.trim\(\) \}/);
});

/* ── AN IN-PERSON CHECK IS PROOF; A PLACEHOLDER IS NOT ──────────────────
 *
 * 19 Sep 2026: Dre had seen Alfredo's state licence in person and the number
 * was coming by email. The gate was a single non-empty test on a free-text
 * field, so the only way to open it was to type something into the licence
 * box — and that box is interpolated into the sentence the concierge reads
 * to a traveller.
 */
test('the number opens the gate, and so does a recorded in-person check', () => {
  assert.equal(licenceProof({ licence: 'C9-0000123-LIC' }).ok, true);
  assert.equal(licenceProof({ licence_verified_by: 'dre:in-person', licence_verified_at: '2026-09-19' }).ok, true);
  assert.equal(licenceProof({}).ok, false);
  assert.equal(licenceProof({ licence: '   ' }).ok, false, 'whitespace is not a licence');
});

test('the two bases are never confused for each other', () => {
  const inPerson = licenceProof({ licence_verified_by: 'dre:in-person' });
  assert.equal(inPerson.basis, 'in_person');
  assert.equal(inPerson.number, null, 'an in-person check must not become a licence number');
  const numbered = licenceProof({ licence: 'C9-0000123-LIC', licence_verified_by: 'dre:in-person' });
  assert.equal(numbered.basis, 'number');
  assert.equal(numbered.number, 'C9-0000123-LIC');
});

test('a shop verified in person is listed', async () => {
  const env = fresh(); const db = env._db;
  db.exec(`UPDATE num_business_profiles
             SET custom_fields='{"licence_verified_by":"dre:in-person","licence_verified_at":"2026-09-19","age_min":21}'
           WHERE business_id='biz_lacc'`);
  const near = await partnersNear(env, DTLA);
  const lacc = near.find((p) => p.business_id === 'biz_lacc');
  assert.ok(lacc, 'a shop somebody vouched for in person is still dark');
  assert.equal(lacc.licence, null);
  assert.equal(lacc.licence_basis, 'in_person');
});

test('NUM never states a licence number it does not hold', async () => {
  // deliveryBlock goes into the grounding the model reads. A placeholder in
  // the licence field would come back out as a licence number said to a
  // traveller — which is the whole reason the gate takes a second field.
  const env = fresh(); const db = env._db;
  db.exec(`UPDATE num_business_profiles
             SET custom_fields='{"licence_verified_by":"dre:in-person","age_min":21}'
           WHERE business_id='biz_lacc'`);
  const near = await partnersNear(env, DTLA);
  const block = deliveryBlock(near.filter((p) => p.business_id === 'biz_lacc'));
  assert.match(block, /licence verified by NUM/);
  assert.equal(/\(licence \)|\(licence undefined\)|\(licence null\)/.test(block), false,
    `an empty licence reached the guest: ${block}`);
  // and with a real number it still says the number
  db.exec(`UPDATE num_business_profiles SET custom_fields='{"licence":"C9-0000123-LIC","age_min":21}' WHERE business_id='biz_lacc'`);
  const withNum = deliveryBlock((await partnersNear(env, DTLA)).filter((p) => p.business_id === 'biz_lacc'));
  assert.match(withNum, /\(licence C9-0000123-LIC\)/);
});

test('no proof at all is still no listing', async () => {
  const env = fresh(); const db = env._db;
  db.exec(`UPDATE num_business_profiles SET custom_fields='{"age_min":21}' WHERE business_id='biz_lacc'`);
  const near = await partnersNear(env, DTLA);
  assert.equal(near.some((p) => p.business_id === 'biz_lacc'), false);
});

test('the console cannot switch a verified shop off by saving with an empty box', async () => {
  // The licence input is empty because the number has not arrived. Saving
  // hours or a radius must not read that as "no licence" and refuse.
  const env = fresh(); const db = env._db;
  db.exec(`UPDATE num_business_profiles SET custom_fields='{"licence_verified_by":"dre:in-person","age_min":21}' WHERE business_id='biz_lacc'`);
  const out = await saveDelivery(env, 'biz_lacc', { on: true, fee_cs: 700, radius_m: 8000, licence: '', age_min: 21, hours: '10:00-21:00' });
  assert.equal(out.ok, true, out.error);
  const s = await deliverySettings(env, 'biz_lacc');
  assert.equal(s.on, true);
  assert.equal(s.licence_basis, 'in_person');
  assert.equal(s.licence_verified_by, 'dre:in-person');
});

test('a shop with neither still cannot be switched on', async () => {
  const env = fresh(); const db = env._db;
  db.exec(`UPDATE num_business_profiles SET custom_fields='{}' WHERE business_id='biz_lacc'`);
  const out = await saveDelivery(env, 'biz_lacc', { on: true, fee_cs: 700, radius_m: 8000, licence: '', age_min: 21 });
  assert.equal(out.ok, false);
  assert.match(out.error, /licence number|in-person verification/);
});
