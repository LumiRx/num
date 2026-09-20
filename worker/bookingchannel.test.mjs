// BOOKING IN THE REST OF THE WORLD.
//
// 20 Sep 2026. Measured against production that afternoon:
//
//   places in the directory          2,715,565
//   rows in num_booking_channels             3
//   num_sms_consent                          7
//   bookings ever made                       6
//
// The fallback for a venue with no channel row was `{ via: 'sms', sms_to:
// null }`, which deliverable() correctly reports as "no number on file" —
// about 1,869,622 venues whose phone number is sitting one table away, and
// 1,387,864 whose website is. 2,012,009 have one or the other.
//
// So the fallback is now derived from the listing: hand the guest the venue's
// own page, or their number to dial. NUM still sends nothing and still says
// so. What changes is that the guest gets a route that works in seconds
// instead of a request that joins a queue four rows long.
//
// The rule underneath every test here: a derived phone goes in `call_to` and
// NEVER in `sms_to`. `sms_to` feeds the path gated on num_sms_consent, and
// that gate is what keeps the A2P registration truthful and the TCPA exposure
// at zero. A scraped number is for the GUEST to dial, never for NUM to text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { channelFor, deliverable, setChannel, __resetReady } from './bookingchannel.mjs';

function d1(db) {
  return {
    prepare(sql) {
      const st = { sql, args: [] };
      st.bind = (...a) => { st.args = a; return st; };
      const order = () => {
        const idx = [...st.sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
        return idx.length ? idx.map((i) => st.args[i - 1] ?? null) : st.args;
      };
      const plain = () => st.sql.replace(/\?(\d+)/g, '?');
      st.run = async () => ({ meta: { changes: db.prepare(plain()).run(...order()).changes } });
      st.first = async () => db.prepare(plain()).get(...order()) ?? null;
      st.all = async () => ({ results: db.prepare(plain()).all(...order()) });
      return st;
    },
    // ensure() creates its table through batch(); the shim runs the statements
    // in order, which is all the real binding guarantees us here.
    async batch(stmts) {
      const out = [];
      for (const st of stmts) out.push(await st.run());
      return out;
    },
  };
}

function fresh() {
  __resetReady();
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE places (
    id TEXT PRIMARY KEY, name TEXT, phone TEXT, website TEXT,
    booking_platform TEXT, booking_ref TEXT)`);
  return { DB: d1(db), db };
}

const place = (env, row) => env.db.prepare(
  'INSERT INTO places (id,name,phone,website,booking_platform) VALUES (?,?,?,?,?)',
).run(row.id, row.name ?? 'A Venue', row.phone ?? null, row.website ?? null, row.platform ?? null);

/* ── the derived route ─────────────────────────────────────────────────── */

test('a venue with a website is handed over, not queued', async () => {
  const env = fresh();
  place(env, { id: 'p1', website: 'nahm.example' });
  const ch = await channelFor(env, { placeId: 'p1' });
  assert.equal(ch.via, 'own');
  assert.equal(ch.booking_url, 'https://nahm.example/');
  assert.equal(ch.derived, true);
  const r = deliverable(ch);
  assert.equal(r.send, false, 'NUM must not claim to have sent anything');
  assert.equal(r.via, 'handoff');
  assert.equal(r.to, 'https://nahm.example/');
});

test('a venue with only a phone is handed the number', async () => {
  const env = fresh();
  place(env, { id: 'p2', phone: '+66 76 123 456' });
  const ch = await channelFor(env, { placeId: 'p2' });
  assert.equal(ch.via, 'own');
  assert.equal(ch.call_to, '+66 76 123 456');
  const r = deliverable(ch);
  assert.equal(r.via, 'call');
  assert.equal(r.call, '+66 76 123 456');
  assert.equal(r.send, false);
});

test('a known booking system rides along so the handoff can be prefilled', async () => {
  // 1,170 OpenTable, 788 SevenRooms, 338 Toast, 192 Resy in the directory.
  // ressystem.mjs can carry party size, date and time into a system it knows;
  // without the key the guest lands on a home page and starts again.
  const env = fresh();
  place(env, { id: 'p3', website: 'x.example', platform: 'opentable' });
  const ch = await channelFor(env, { placeId: 'p3' });
  assert.equal(ch.system_key, 'opentable');
  assert.equal(ch.integration, 'handoff');
});

test('a venue we hold nothing for still reads as the desk, never as a refusal', async () => {
  const env = fresh();
  place(env, { id: 'p4' });
  const ch = await channelFor(env, { placeId: 'p4' });
  assert.equal(ch.via, 'sms', 'an unknown venue became `none`, which means they REFUSED');
  assert.equal(ch.booking_url, null);
  assert.equal(ch.call_to, null);
  assert.equal(deliverable(ch).send, false);
});

test('a place that is not in the directory at all does not throw', async () => {
  const env = fresh();
  const ch = await channelFor(env, { placeId: 'nope' });
  assert.ok(ch, 'a missing listing must not take the booking screen down with it');
  assert.equal(ch.via, 'sms');
  assert.equal(ch.asked, false);
});

/* ── the rule that must not break ──────────────────────────────────────── */

test('a derived phone NEVER lands in sms_to', async () => {
  // sms_to feeds the path gated on num_sms_consent. A number we scraped is a
  // number for the guest to dial. If this assertion ever fails, NUM is one
  // deploy away from texting two million venues that never opted in.
  const env = fresh();
  place(env, { id: 'p5', phone: '+1 213 555 0100', website: 'y.example' });
  const ch = await channelFor(env, { placeId: 'p5' });
  assert.equal(ch.sms_to, null, 'a scraped number reached the SMS path');
  assert.equal(ch.call_to, '+1 213 555 0100');
  assert.notEqual(deliverable(ch).via, 'sms');
});

test('a derived route is never reported as something the venue chose', async () => {
  const env = fresh();
  place(env, { id: 'p6', phone: '+1 213 555 0100' });
  const ch = await channelFor(env, { placeId: 'p6' });
  assert.equal(ch.asked, false, '"nobody has asked" became "they told us"');
  assert.match(deliverable(ch).reason, /no channel recorded/);
});

/* ── a real answer still outranks a derived one ────────────────────────── */

test('what a venue actually said wins over anything we could derive', async () => {
  const env = fresh();
  place(env, { id: 'p7', phone: '+1 213 555 0100', website: 'z.example' });
  const saved = await setChannel(env, 'p7', { via: 'none' }, { by: 'venue' });
  assert.equal(saved.ok, true);
  const ch = await channelFor(env, { placeId: 'p7' });
  assert.equal(ch.via, 'none', 'a venue that refused was handed over anyway');
  assert.equal(ch.asked, true);
  assert.equal(deliverable(ch).reason, 'venue asked not to be sent bookings');
});

test('an emailed venue keeps its email even with a website on the listing', async () => {
  const env = fresh();
  place(env, { id: 'p8', website: 'hugos.example' });
  await setChannel(env, 'p8', { via: 'email', email_to: 'book@hugos.example' }, { by: 'venue' });
  const r = deliverable(await channelFor(env, { placeId: 'p8' }));
  assert.equal(r.send, true);
  assert.equal(r.via, 'email');
});
