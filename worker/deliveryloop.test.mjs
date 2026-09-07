/**
 * The delivery loop, end to end, as wiring: the brain can only offer a partner
 * index.mjs put in front of it, an order is created server-side only for a
 * partner that was offered, and the partner's console can move it along.
 * Reads the source the way connections.test.mjs does, because the promise is
 * about which file does what.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REPLY_SCHEMA, normalizeReply } from './prompt.mjs';
import { ORDER_NEXT } from './delivery.mjs';
import { deliveryPage, buttonsFor } from './bizdelivery.mjs';

const src = (f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');

test('the model knows request_delivery only through the DELIVERY PARTNERS block', () => {
  const prompt = src('prompt.mjs');
  assert.ok(REPLY_SCHEMA.properties.actions.items.properties.type.enum.includes('request_delivery'));
  assert.match(prompt, /For request_delivery \(ONLY when a DELIVERY PARTNERS block is present/);
  assert.match(prompt, /- request_delivery: some guests are near a Num partner that DELIVERS/);
});

test('an unconfirmed or id-less request_delivery is dropped by the normalizer', () => {
  const mk = (payload) => normalizeReply({ reply: 'ok', actions: [{ type: 'request_delivery', payload: JSON.stringify(payload) }] });
  assert.equal(mk({ business_id: 'b1', items: [{ item_id: 'i1', qty: 2 }], address: '1 Main St', confirmed: false }).actions.length, 0, 'not confirmed');
  assert.equal(mk({ business_id: 'b1', items: [], address: '1 Main St', confirmed: true }).actions.length, 0, 'no items');
  assert.equal(mk({ items: [{ item_id: 'i1' }], address: '1 Main St', confirmed: true }).actions.length, 0, 'no business');
  const ok = mk({ business_id: 'b1', items: [{ item_id: 'i1', qty: 99 }, { item_id: 'i2' }], address: '1 Main St', note: 'ring twice', confirmed: true });
  assert.equal(ok.actions.length, 1);
  assert.deepEqual(ok.actions[0].order, {
    business_id: 'b1', items: [{ item_id: 'i1', qty: 20 }, { item_id: 'i2', qty: 1 }], address: '1 Main St', note: 'ring twice', confirmed: true,
  });
});

test('index.mjs offers partners only to a member, never a hosted one, and creates the order server-side for an offered partner only', () => {
  const idx = src('index.mjs');
  assert.match(idx, /import \{[^}]*partnersNear[^}]*\} from '\.\/delivery\.mjs'/);
  const near = idx.slice(idx.indexOf('partnersNear(env'), idx.indexOf('partnersNear(env') + 700);
  assert.match(near, /hasHost: !!memberHost/, 'a guest with a host is sent to their host, not a partner');
  assert.match(near, /identity_verified/, 'the age gate reads the member row');
  const block = idx.slice(idx.indexOf('const deliveryNote'), idx.indexOf('const deliveryNote') + 220);
  assert.match(block, /deliveryBlock\(deliveryPartners\)/);
  assert.match(block, /extraSystem = \[deliveryNote, extraSystem\]/, 'rides on every call, retries included');
  const exec = idx.slice(idx.indexOf("a?.type !== 'request_delivery'"), idx.indexOf("a?.type !== 'request_delivery'") + 600);
  assert.match(exec, /offered\.has\(a\.order\.business_id\)/, 'an invented business_id creates nothing');
  assert.match(exec, /createOrder\(env, \{ businessId: a\.order\.business_id, memberId/);
  assert.match(idx, /url\.pathname\.startsWith\('\/api\/delivery\/'\)/);
});

test('the console lists Delivery on every plan and handles its two actions', () => {
  const pages = src('bizpages.mjs');
  const block = pages.slice(pages.indexOf("id: 'delivery'"), pages.indexOf("id: 'delivery'") + 300);
  assert.match(block, /needs: null/, 'delivery went behind a paywall');
  const con = src('bizconsole.mjs');
  assert.match(con, /case 'delivery':\s+body = deliveryPage\(/);
  assert.match(con, /action === 'delivery_save'/);
  assert.match(con, /action === 'order_move'/);
  const dl = con.slice(con.indexOf("import('./delivery.mjs')"), con.indexOf("import('./delivery.mjs')") + 500);
  assert.match(dl, /catch/, 'a broken delivery read would take the whole console down');
});

test('the console offers exactly the legal next moves', () => {
  assert.deepEqual(buttonsFor('pending_business', ORDER_NEXT), ['accepted', 'declined', 'cancelled']);
  assert.deepEqual(buttonsFor('accepted', ORDER_NEXT), ['preparing', 'out_for_delivery', 'cancelled']);
  assert.deepEqual(buttonsFor('out_for_delivery', ORDER_NEXT), ['delivered', 'cancelled']);
  assert.deepEqual(buttonsFor('delivered', ORDER_NEXT), []);
  assert.deepEqual(buttonsFor('declined', ORDER_NEXT), []);
});

test('the delivery page says the licence rule out loud and never mentions text messages', () => {
  const off = deliveryPage({ settings: { on: false, fee_cs: 500, radius_m: 5000, licence: '', age_min: 0, hours: '' }, orders: [], priced: 0, next: ORDER_NEXT, token: 't' });
  assert.match(off, /Delivery is <b>off<\/b>/);
  assert.match(off, /required before delivery can be on/);
  assert.match(off, /unpriced item cannot be ordered/);
  assert.doesNotMatch(off, /\bSMS\b|text message/i);
  const on = deliveryPage({
    settings: { on: true, fee_cs: 700, radius_m: 8000, licence: 'C9-000123', age_min: 21, hours: 'Daily 10–21' },
    orders: [{ id: 'o1', short_code: 'K204', status: 'pending_business', items: '2 × Sample', address: '1 Main St', total_cs: 2700, delivery_fee_cs: 700, created_at: 1_800_000_000 }],
    priced: 3, next: ORDER_NEXT, token: 't',
  });
  assert.match(on, /Delivery is <b>on<\/b>/);
  assert.match(on, /21\+ only/);
  assert.match(on, /verified/);
  assert.match(on, /value="accepted"/);
  assert.match(on, /value="declined"/);
  assert.doesNotMatch(on, /value="delivered"/, 'cannot skip to delivered from pending');
  assert.match(on, /\(1 waiting\)/);
});

// ── the owner, in the app ────────────────────────────────────────────────
//
// Dre, 7 Sep: "when they sign into the app with their phone number they get
// the requests for their business in their app." Alfredo will be driving, not
// sitting at the laptop the web console was built for.
test('the app can read and move a business’s own orders, and only its own', () => {
  const src = readFileSync(new URL('./delivery.mjs', import.meta.url), 'utf8');

  assert.match(src, /path === '\/business' && request\.method === 'GET'/,
    'no way for an owner to see their orders from the app');
  assert.match(src, /path === '\/business\/order' && request\.method === 'POST'/,
    'an owner can see an order and not act on it — that is a worse screen than none');

  // Both routes resolve ownership from the database. A business_id in a
  // request is a wish, not a permission.
  const read = src.slice(src.indexOf("path === '/business' &&"), src.indexOf("path === '/business/order'"));
  assert.match(read, /businessesForMember/);
  assert.ok(!/req\w*\.business_id\s*\|\|/.test(read), 'the requested business is trusted without a check');

  const write = src.slice(src.indexOf("path === '/business/order'"), src.indexOf("path === '/near'"));
  assert.match(write, /ownsBusiness/);
  assert.match(write, /403/, 'a wrong business must be refused, not silently ignored');

  // The app is told what each order may become, from the same state machine
  // the server enforces — so it cannot render a button the server refuses.
  assert.match(read, /ORDER_NEXT/);
});

test('the greater-LA gap is written down as a decision, not left as a surprise', () => {
  // 7 Sep: a coordinate fallback was tried so a guest in Long Beach could be
  // served, and backed out — delivery.test.mjs pins "no destination, no offer",
  // and that default was chosen for this product on purpose. Widening a
  // cannabis gate is not a side effect. The gap is documented instead.
  const src = readFileSync(new URL('./delivery.mjs', import.meta.url), 'utf8');
  assert.match(src, /Long Beach/, 'the gap is not named anywhere a reader would find it');
  assert.match(src, /SLUG ONLY, DELIBERATELY/);
  assert.match(src, /greater_area/, 'the area Dre asked for is not recorded');
  // And the numbers must still be inside California, whoever switches them on.
  assert.match(src, /south: 33\.60, west: -118\.95, north: 34\.40, east: -117\.50/);
});
